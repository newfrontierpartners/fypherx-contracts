// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IFypherOracleRouter {
    function getPriceE18(bytes32 marketId) external view returns (uint256);
}

/**
 * @dev April-audit H-4 patch. Minimal interface to the insurance fund
 *      vault so the clearinghouse can absorb liquidation deficits and
 *      contribute surpluses on behalf of liquidated accounts.
 */
interface IFypherInsuranceFund {
    function deposit(uint256 amount, bytes32 referenceId) external;
    function withdraw(address to, uint256 amount, bytes32 referenceId) external;
    function balance() external view returns (uint256);
}

contract FypherPerpsClearinghouse {
    struct MarketConfig {
        bool active;
        uint32 initialMarginBps;
        uint32 maintenanceMarginBps;
        uint32 maxTradeDeviationBps;
        uint256 maxLeverageE18;
        uint256 maxPositionSizeE18;
    }

    struct Position {
        bool isLong;
        uint256 sizeE18;
        uint256 entryPriceE18;
        uint256 marginE18;
    }

    /**
     * @notice PH-1. The account-signed authorisation for a (possibly partially
     *         filled) trade. The relayer can only move an account's collateral
     *         into a position the account itself signed for, bounded by
     *         `maxBaseSizeE18` (cumulative across partial fills), `limitPriceE18`
     *         (worst acceptable execution price) and `leverageE18`. `nonce` is an
     *         account-chosen identifier that can be invalidated via
     *         {cancelOrderNonce}; `deadline` bounds the order's lifetime.
     */
    struct TradeOrder {
        address account;
        bytes32 marketId;
        bool isLong;
        uint256 maxBaseSizeE18;
        uint256 limitPriceE18; // 0 = market order (no user price cap; oracle band still applies)
        uint256 leverageE18;
        uint256 nonce;
        uint256 deadline;
    }

    address public owner;
    IERC20Minimal public immutable collateralToken;
    IFypherOracleRouter public immutable oracleRouter;

    /// @notice PH-2: 1e18 / 10**decimals — bridges the E18 internal ledger and
    ///         the collateral token's native units (1e12 for 6-dec USDC/USDT;
    ///         1 for an 18-dec token, so 18-dec behaviour is unchanged).
    uint256 public immutable collateralScale;

    mapping(address => bool) public relayers;
    mapping(address => bool) public liquidators;
    mapping(bytes32 => MarketConfig) public markets;
    mapping(address => int256) public collateralBalanceE18;
    mapping(address => mapping(bytes32 => Position)) public positions;

    bytes32[] private configuredMarkets;
    mapping(bytes32 => bool) private knownMarkets;
    mapping(address => bytes32[]) private accountMarkets;
    mapping(address => mapping(bytes32 => bool)) private accountMarketSeen;

    /// @notice April-audit H-4. The insurance fund is consulted on
    ///         liquidation to absorb deficits (bad debt). When unset,
    ///         a deficit-producing liquidation reverts rather than
    ///         silently accruing negative collateral.
    IFypherInsuranceFund public insuranceFund;

    /// @notice PH-5: independent clearinghouse kill-switches. Unlike the oracle
    ///         router's pause (which froze new trades AND liquidations at once),
    ///         these are separate so the book can be wound down: trading can be
    ///         halted while liquidations continue.
    bool public tradingPaused;
    bool public liquidationPaused;

    /// @dev PH-7: minimal non-reentrancy guard (1 = unlocked, 2 = entered).
    uint256 private _reentrancy = 1;

    // ─────────────────────────────────────────────────────────────────────
    // PH-1: account authorisation (EIP-712) for relayer-submitted trades.
    //
    // Before PH-1, `executeMatchedTrade` was `onlyRelayer` with NO account
    // signature: any allow-listed relayer could move ANY depositor's collateral
    // into a losing position (the only on-chain check was the oracle deviation
    // band). PH-1 requires every fill to carry the account's EIP-712 signature
    // over a {TradeOrder}, so a compromised relayer can no longer trade an
    // account's collateral without that account's authorisation.
    // ─────────────────────────────────────────────────────────────────────
    string private constant _EIP712_NAME = "FypherPerpsClearinghouse";
    string private constant _EIP712_VERSION = "1";
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _TRADE_ORDER_TYPEHASH = keccak256(
        "TradeOrder(address account,bytes32 marketId,bool isLong,uint256 maxBaseSizeE18,uint256 limitPriceE18,uint256 leverageE18,uint256 nonce,uint256 deadline)"
    );
    /// @dev secp256k1 half-order; signatures with s above this are malleable and rejected (EIP-2).
    uint256 private constant _SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// @notice Cumulative base size filled against a signed order, keyed by its
    ///         EIP-712 digest. Bounds partial fills to `TradeOrder.maxBaseSizeE18`
    ///         and prevents a single signature from being over-filled.
    mapping(bytes32 => uint256) public orderFilledE18;

    /// @notice Accounts can invalidate an order nonce before/while it is live.
    mapping(address => mapping(uint256 => bool)) public cancelledOrderNonce;

    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event LiquidatorUpdated(address indexed liquidator, bool allowed);
    event InsuranceFundUpdated(address indexed previousFund, address indexed nextFund);
    event InsuranceFundDrawn(address indexed account, bytes32 indexed marketId, uint256 amountE18);
    event MarketConfigured(
        bytes32 indexed marketId,
        uint32 initialMarginBps,
        uint32 maintenanceMarginBps,
        uint32 maxTradeDeviationBps,
        uint256 maxLeverageE18,
        uint256 maxPositionSizeE18,
        bool active
    );
    event CollateralDeposited(address indexed account, uint256 amountE18);
    event CollateralWithdrawn(address indexed account, uint256 amountE18);
    event TradeApplied(
        address indexed account,
        bytes32 indexed marketId,
        bool isLong,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    );
    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed account,
        uint256 fillSizeE18,
        uint256 cumulativeFilledE18
    );
    event OrderNonceCancelled(address indexed account, uint256 indexed nonce);
    event PositionLiquidated(address indexed account, bytes32 indexed marketId, uint256 markPriceE18, int256 realizedPnlE18);
    event TradingPausedSet(bool paused);
    event LiquidationPausedSet(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "not relayer");
        _;
    }

    modifier onlyLiquidator() {
        require(liquidators[msg.sender] || relayers[msg.sender], "not liquidator");
        _;
    }

    /// @dev PH-7: non-reentrancy guard on every collateral-moving entrypoint.
    modifier nonReentrant() {
        require(_reentrancy != 2, "reentrant");
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    constructor(address collateralToken_, address oracleRouter_) {
        require(collateralToken_ != address(0), "invalid collateral");
        require(oracleRouter_ != address(0), "invalid oracle router");
        owner = msg.sender;
        collateralToken = IERC20Minimal(collateralToken_);
        uint8 dec = IERC20Minimal(collateralToken_).decimals();
        require(dec <= 18, "collateral decimals > 18");
        collateralScale = 10 ** (18 - uint256(dec));
        oracleRouter = IFypherOracleRouter(oracleRouter_);
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit OwnerUpdated(address(0), msg.sender);
    }

    function setOwner(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "invalid owner");
        emit OwnerUpdated(owner, nextOwner);
        owner = nextOwner;
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setLiquidator(address liquidator, bool allowed) external onlyOwner {
        liquidators[liquidator] = allowed;
        emit LiquidatorUpdated(liquidator, allowed);
    }

    /// @notice PH-5: pause new trades (existing positions can still be liquidated).
    function setTradingPaused(bool paused) external onlyOwner {
        tradingPaused = paused;
        emit TradingPausedSet(paused);
    }

    /// @notice PH-5: pause liquidations independently of trading.
    function setLiquidationPaused(bool paused) external onlyOwner {
        liquidationPaused = paused;
        emit LiquidationPausedSet(paused);
    }

    /**
     * @notice Set (or clear, by passing `address(0)`) the insurance
     *         fund vault that absorbs liquidation deficits. The vault
     *         must have this clearinghouse pre-authorised as an
     *         operator (so {liquidate} can call its `withdraw`).
     *
     * @dev April-audit H-4 patch.
     */
    function setInsuranceFund(address nextFund) external onlyOwner {
        emit InsuranceFundUpdated(address(insuranceFund), nextFund);
        insuranceFund = IFypherInsuranceFund(nextFund);
    }

    function configureMarket(
        bytes32 marketId,
        uint32 initialMarginBps,
        uint32 maintenanceMarginBps,
        uint32 maxTradeDeviationBps,
        uint256 maxLeverageE18,
        uint256 maxPositionSizeE18,
        bool active
    ) external onlyOwner {
        require(initialMarginBps > 0 && initialMarginBps <= 10_000, "invalid im");
        require(maintenanceMarginBps > 0 && maintenanceMarginBps <= initialMarginBps, "invalid mm");
        require(maxTradeDeviationBps <= 10_000, "invalid deviation");
        require(maxLeverageE18 >= 1e18, "invalid leverage");
        require(maxPositionSizeE18 > 0, "invalid max position");

        markets[marketId] = MarketConfig({
            active: active,
            initialMarginBps: initialMarginBps,
            maintenanceMarginBps: maintenanceMarginBps,
            maxTradeDeviationBps: maxTradeDeviationBps,
            maxLeverageE18: maxLeverageE18,
            maxPositionSizeE18: maxPositionSizeE18
        });

        if (!knownMarkets[marketId]) {
            knownMarkets[marketId] = true;
            configuredMarkets.push(marketId);
        }

        emit MarketConfigured(
            marketId,
            initialMarginBps,
            maintenanceMarginBps,
            maxTradeDeviationBps,
            maxLeverageE18,
            maxPositionSizeE18,
            active
        );
    }

    function deposit(uint256 amountE18) external nonReentrant {
        require(amountE18 > 0, "invalid deposit");
        // PH-2: amount is E18 (ledger units); the on-chain transfer is in the
        // token's native units. Require E18-to-token alignment so no value is
        // silently truncated (for an 18-dec token collateralScale==1, a no-op).
        require(amountE18 % collateralScale == 0, "amount not token-aligned");
        _safeTransferFrom(msg.sender, address(this), amountE18 / collateralScale); // PH-7
        collateralBalanceE18[msg.sender] += int256(amountE18);
        emit CollateralDeposited(msg.sender, amountE18);
    }

    function withdraw(uint256 amountE18) external nonReentrant {
        require(amountE18 > 0, "invalid withdraw");
        require(amountE18 % collateralScale == 0, "amount not token-aligned"); // PH-2
        require(collateralBalanceE18[msg.sender] >= int256(amountE18), "insufficient collateral");

        collateralBalanceE18[msg.sender] -= int256(amountE18);
        _assertInitialMarginHealthy(msg.sender);

        _safeTransfer(msg.sender, amountE18 / collateralScale); // PH-7
        emit CollateralWithdrawn(msg.sender, amountE18);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PH-1: EIP-712 helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice EIP-712 domain separator (recomputed on a fork so a replayed
    ///         signature from the old chain id is rejected).
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        }
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(_EIP712_NAME)),
                keccak256(bytes(_EIP712_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 digest an account signs to authorise a {TradeOrder}.
    function hashOrder(TradeOrder calldata order) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _TRADE_ORDER_TYPEHASH,
                order.account,
                order.marketId,
                order.isLong,
                order.maxBaseSizeE18,
                order.limitPriceE18,
                order.leverageE18,
                order.nonce,
                order.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Invalidate one of the caller's order nonces; any order carrying
    ///         this nonce can no longer be executed (cancel / replace flow).
    function cancelOrderNonce(uint256 nonce) external {
        cancelledOrderNonce[msg.sender][nonce] = true;
        emit OrderNonceCancelled(msg.sender, nonce);
    }

    /**
     * @notice Apply a relayer-submitted matched fill against an account-signed
     *         {TradeOrder}. PH-1: the trade is authorised by `order.account`'s
     *         EIP-712 signature, bounded by `maxBaseSizeE18` (cumulative across
     *         partial fills), `limitPriceE18`, `leverageE18`, `nonce` and
     *         `deadline`. The relayer chooses only the actual `sizeDeltaE18`
     *         (≤ remaining authorised size) and `executionPriceE18` (within both
     *         the user's limit and the oracle deviation band).
     */
    function executeMatchedTrade(
        TradeOrder calldata order,
        bytes calldata signature,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18
    ) external onlyRelayer nonReentrant {
        require(!tradingPaused, "trading paused"); // PH-5
        bytes32 orderHash = _verifyOrder(order, signature, sizeDeltaE18, executionPriceE18);
        _applyFill(order, sizeDeltaE18, executionPriceE18);
        _assertInitialMarginHealthy(order.account);
        emit TradeApplied(order.account, order.marketId, order.isLong, sizeDeltaE18, executionPriceE18, order.leverageE18);
        emit OrderFilled(orderHash, order.account, sizeDeltaE18, orderFilledE18[orderHash]);
    }

    /**
     * @dev PH-1 authorisation. Validates the account's EIP-712 signature, the
     *      partial-fill budget (`maxBaseSizeE18`), `deadline`/`nonce`, and the
     *      user's `limitPriceE18`. Records the cumulative fill and returns the
     *      order digest. Split out of {executeMatchedTrade} so each frame stays
     *      within the EVM stack limit (the audit build compiles without via-IR).
     */
    function _verifyOrder(
        TradeOrder calldata order,
        bytes calldata signature,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18
    ) internal returns (bytes32 orderHash) {
        require(order.account != address(0), "invalid account");
        require(sizeDeltaE18 > 0, "invalid size");
        require(executionPriceE18 > 0, "invalid execution price");
        require(block.timestamp <= order.deadline, "order expired");
        require(!cancelledOrderNonce[order.account][order.nonce], "order cancelled");

        // PH-1: the account itself must have authorised this order.
        orderHash = hashOrder(order);
        require(_recover(orderHash, signature) == order.account, "bad order signature");

        // Accumulate partial fills against the signed maximum size.
        uint256 filled = orderFilledE18[orderHash] + sizeDeltaE18;
        require(filled <= order.maxBaseSizeE18, "order overfilled");
        orderFilledE18[orderHash] = filled;

        // Honour the user's worst-acceptable price (0 = market: rely on oracle band).
        if (order.limitPriceE18 != 0) {
            if (order.isLong) {
                require(executionPriceE18 <= order.limitPriceE18, "price above limit");
            } else {
                require(executionPriceE18 >= order.limitPriceE18, "price below limit");
            }
        }
    }

    /// @dev Validate market/leverage/oracle band, then route the fill to the
    ///      open/add/reduce/close/flip path.
    function _applyFill(
        TradeOrder calldata order,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18
    ) internal {
        MarketConfig memory config = markets[order.marketId];
        require(config.active, "market inactive");
        require(order.leverageE18 >= 1e18 && order.leverageE18 <= config.maxLeverageE18, "invalid leverage");

        uint256 oraclePriceE18 = oracleRouter.getPriceE18(order.marketId);
        _assertPriceWithinDeviation(executionPriceE18, oraclePriceE18, config.maxTradeDeviationBps);

        Position memory existing = positions[order.account][order.marketId];

        if (existing.sizeE18 == 0) {
            _openPosition(order.account, order.marketId, config, order.isLong, sizeDeltaE18, executionPriceE18, order.leverageE18);
        } else if (existing.isLong == order.isLong) {
            _addToPosition(order.account, order.marketId, config, existing, sizeDeltaE18, executionPriceE18, order.leverageE18);
        } else if (sizeDeltaE18 < existing.sizeE18) {
            _reducePosition(order.account, order.marketId, existing, sizeDeltaE18, executionPriceE18);
        } else if (sizeDeltaE18 == existing.sizeE18) {
            _closePosition(order.account, order.marketId, existing, executionPriceE18);
        } else {
            _flipPosition(order.account, order.marketId, config, existing, order.isLong, sizeDeltaE18, executionPriceE18, order.leverageE18);
        }
    }

    /**
     * @dev Strict ECDSA recovery: fixed 65-byte signature, EIP-2 low-s, v ∈ {27,28},
     *      rejects the zero address. Mirrors {FypherXSettlement} so both contracts
     *      share the same signature-malleability guarantees.
     */
    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= _SECP256K1_HALF_N, "bad sig s");
        require(v == 27 || v == 28, "bad sig v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad sig");
        return signer;
    }

    /**
     * @notice Liquidate a single market position for an unhealthy account.
     *         Realised PnL is applied to {collateralBalanceE18}; if the
     *         result is negative (bad debt), the deficit is drawn from
     *         the insurance fund and the account ledger is zeroed.
     *
     * @dev April-audit H-4 patch. Previously the function deleted the
     *      position and credited PnL but left the account with negative
     *      collateral on a deficit liquidation. That negative balance
     *      polluted future {equity} / {isLiquidatable} calculations and
     *      was effectively a free option for the user (continue trading
     *      until equity climbed back to non-negative). Now:
     *
     *        - if `insuranceFund` is set and there is enough balance,
     *          the deficit is pulled and the ledger is zeroed; or
     *        - if no fund is set, or the fund is under-funded, the
     *          liquidation REVERTS so the operator can route to a
     *          backstop process rather than booking dead value.
     */
    function liquidate(address account, bytes32 marketId) external onlyLiquidator nonReentrant {
        require(!liquidationPaused, "liquidation paused"); // PH-5
        require(isLiquidatable(account), "account healthy");

        Position memory position = positions[account][marketId];
        require(position.sizeE18 > 0, "position missing");

        uint256 markPriceE18 = oracleRouter.getPriceE18(marketId);
        int256 realizedPnlE18 = _calculateRealizedPnl(position, markPriceE18, position.sizeE18);
        collateralBalanceE18[account] += realizedPnlE18;
        delete positions[account][marketId];

        int256 finalBalance = collateralBalanceE18[account];
        if (finalBalance < 0) {
            uint256 deficit = uint256(-finalBalance);
            address fund = address(insuranceFund);
            require(fund != address(0), "no insurance fund");
            // PH-2: the vault holds the collateral token in native units. Draw
            // ceil(deficit / scale) token units so the E18 deficit is fully
            // covered (any sub-token remainder stays as protocol surplus).
            uint256 deficitTokens = (deficit + collateralScale - 1) / collateralScale;
            require(insuranceFund.balance() >= deficitTokens, "insurance underfunded");
            insuranceFund.withdraw(address(this), deficitTokens, marketId);
            collateralBalanceE18[account] = 0;
            emit InsuranceFundDrawn(account, marketId, deficit);
        }

        emit PositionLiquidated(account, marketId, markPriceE18, realizedPnlE18);
    }

    function getConfiguredMarkets() external view returns (bytes32[] memory) {
        return configuredMarkets;
    }

    function getAccountMarkets(address account) external view returns (bytes32[] memory) {
        return accountMarkets[account];
    }

    function getAccountSnapshot(address account)
        external
        view
        returns (
            int256 collateralE18,
            int256 unrealizedPnlE18,
            int256 equityE18,
            uint256 initialMarginUsedE18,
            uint256 maintenanceMarginE18,
            bool liquidatable
        )
    {
        collateralE18 = collateralBalanceE18[account];
        unrealizedPnlE18 = totalUnrealizedPnl(account);
        equityE18 = equity(account);
        initialMarginUsedE18 = totalInitialMarginUsed(account);
        maintenanceMarginE18 = totalMaintenanceMarginRequired(account);
        liquidatable = equityE18 < int256(maintenanceMarginE18);
    }

    function totalInitialMarginUsed(address account) public view returns (uint256 total) {
        bytes32[] memory marketList = accountMarkets[account];
        for (uint256 i = 0; i < marketList.length; i++) {
            total += positions[account][marketList[i]].marginE18;
        }
    }

    function totalMaintenanceMarginRequired(address account) public view returns (uint256 total) {
        bytes32[] memory marketList = accountMarkets[account];
        for (uint256 i = 0; i < marketList.length; i++) {
            Position memory position = positions[account][marketList[i]];
            if (position.sizeE18 == 0) {
                continue;
            }
            MarketConfig memory config = markets[marketList[i]];
            uint256 markPriceE18 = oracleRouter.getPriceE18(marketList[i]);
            uint256 notionalE18 = _calculateNotional(position.sizeE18, markPriceE18);
            total += (notionalE18 * config.maintenanceMarginBps) / 10_000;
        }
    }

    function totalUnrealizedPnl(address account) public view returns (int256 total) {
        bytes32[] memory marketList = accountMarkets[account];
        for (uint256 i = 0; i < marketList.length; i++) {
            Position memory position = positions[account][marketList[i]];
            if (position.sizeE18 == 0) {
                continue;
            }
            uint256 markPriceE18 = oracleRouter.getPriceE18(marketList[i]);
            total += _calculateRealizedPnl(position, markPriceE18, position.sizeE18);
        }
    }

    function equity(address account) public view returns (int256) {
        return collateralBalanceE18[account] + totalUnrealizedPnl(account);
    }

    function isLiquidatable(address account) public view returns (bool) {
        return equity(account) < int256(totalMaintenanceMarginRequired(account));
    }

    function _openPosition(
        address account,
        bytes32 marketId,
        MarketConfig memory config,
        bool isLong,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    ) internal {
        require(sizeDeltaE18 <= config.maxPositionSizeE18, "position too large");
        positions[account][marketId] = Position({
            isLong: isLong,
            sizeE18: sizeDeltaE18,
            entryPriceE18: executionPriceE18,
            marginE18: _requiredMargin(config, sizeDeltaE18, executionPriceE18, requestedLeverageE18)
        });
        _trackAccountMarket(account, marketId);
    }

    /**
     * @dev April-audit L-7 patch. Integer division in the naive
     *      weighted-average truncates toward zero, which is *always*
     *      in the trader's favor on a long add-in (lower entry →
     *      larger unrealized PnL when price ≥ new entry) and against
     *      the trader on a short add-in (lower entry → more negative
     *      short PnL). Neither direction is exploitable — the bias is
     *      bounded by one wei per unit size, ~0.01 % per trade at BTC
     *      scale — but it is asymmetric, so we round in the direction
     *      that is conservative for the protocol on each side:
     *
     *        long  → round UP (increase effective entry)
     *        short → round DOWN (decrease effective entry)
     *
     *      Both choices shrink the trader's unrealized PnL by at most
     *      one wei of price per unit of size.
     */
    function _addToPosition(
        address account,
        bytes32 marketId,
        MarketConfig memory config,
        Position memory existing,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    ) internal {
        uint256 newSizeE18 = existing.sizeE18 + sizeDeltaE18;
        require(newSizeE18 <= config.maxPositionSizeE18, "position too large");

        uint256 numeratorE18 = (existing.sizeE18 * existing.entryPriceE18)
            + (sizeDeltaE18 * executionPriceE18);
        uint256 newEntryPriceE18 = existing.isLong
            ? (numeratorE18 + newSizeE18 - 1) / newSizeE18
            : numeratorE18 / newSizeE18;
        uint256 additionalMarginE18 = _requiredMargin(config, sizeDeltaE18, executionPriceE18, requestedLeverageE18);

        positions[account][marketId] = Position({
            isLong: existing.isLong,
            sizeE18: newSizeE18,
            entryPriceE18: newEntryPriceE18,
            marginE18: existing.marginE18 + additionalMarginE18
        });
    }

    function _reducePosition(
        address account,
        bytes32 marketId,
        Position memory existing,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18
    ) internal {
        uint256 marginReleaseE18 = (existing.marginE18 * sizeDeltaE18) / existing.sizeE18;
        int256 realizedPnlE18 = _calculateRealizedPnl(existing, executionPriceE18, sizeDeltaE18);

        collateralBalanceE18[account] += realizedPnlE18;
        positions[account][marketId] = Position({
            isLong: existing.isLong,
            sizeE18: existing.sizeE18 - sizeDeltaE18,
            entryPriceE18: existing.entryPriceE18,
            marginE18: existing.marginE18 - marginReleaseE18
        });
    }

    function _closePosition(
        address account,
        bytes32 marketId,
        Position memory existing,
        uint256 executionPriceE18
    ) internal {
        int256 realizedPnlE18 = _calculateRealizedPnl(existing, executionPriceE18, existing.sizeE18);
        collateralBalanceE18[account] += realizedPnlE18;
        delete positions[account][marketId];
    }

    function _flipPosition(
        address account,
        bytes32 marketId,
        MarketConfig memory config,
        Position memory existing,
        bool isLong,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    ) internal {
        _closePosition(account, marketId, existing, executionPriceE18);
        uint256 excessSizeE18 = sizeDeltaE18 - existing.sizeE18;
        _openPosition(account, marketId, config, isLong, excessSizeE18, executionPriceE18, requestedLeverageE18);
    }

    function _requiredMargin(
        MarketConfig memory config,
        uint256 sizeE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    ) internal pure returns (uint256) {
        uint256 notionalE18 = _calculateNotional(sizeE18, executionPriceE18);
        uint256 protocolMarginE18 = (notionalE18 * config.initialMarginBps) / 10_000;
        uint256 leverageMarginE18 = (notionalE18 * 1e18) / requestedLeverageE18;
        return protocolMarginE18 > leverageMarginE18 ? protocolMarginE18 : leverageMarginE18;
    }

    function _calculateNotional(uint256 sizeE18, uint256 priceE18) internal pure returns (uint256) {
        return (sizeE18 * priceE18) / 1e18;
    }

    function _calculateRealizedPnl(
        Position memory position,
        uint256 executionPriceE18,
        uint256 sizeToCloseE18
    ) internal pure returns (int256) {
        uint256 priceDeltaE18;
        if (position.isLong) {
            if (executionPriceE18 >= position.entryPriceE18) {
                priceDeltaE18 = executionPriceE18 - position.entryPriceE18;
                return int256((priceDeltaE18 * sizeToCloseE18) / 1e18);
            }
            priceDeltaE18 = position.entryPriceE18 - executionPriceE18;
            return -int256((priceDeltaE18 * sizeToCloseE18) / 1e18);
        }

        if (position.entryPriceE18 >= executionPriceE18) {
            priceDeltaE18 = position.entryPriceE18 - executionPriceE18;
            return int256((priceDeltaE18 * sizeToCloseE18) / 1e18);
        }

        priceDeltaE18 = executionPriceE18 - position.entryPriceE18;
        return -int256((priceDeltaE18 * sizeToCloseE18) / 1e18);
    }

    function _assertInitialMarginHealthy(address account) internal view {
        int256 accountEquityE18 = equity(account);
        require(accountEquityE18 >= 0, "negative equity");
        require(accountEquityE18 >= int256(totalInitialMarginUsed(account)), "initial margin breach");
    }

    function _assertPriceWithinDeviation(
        uint256 executionPriceE18,
        uint256 oraclePriceE18,
        uint32 maxTradeDeviationBps
    ) internal pure {
        if (maxTradeDeviationBps == 0) {
            return;
        }

        uint256 upperBound = oraclePriceE18 + ((oraclePriceE18 * maxTradeDeviationBps) / 10_000);
        uint256 lowerBound = oraclePriceE18 - ((oraclePriceE18 * maxTradeDeviationBps) / 10_000);

        require(executionPriceE18 <= upperBound && executionPriceE18 >= lowerBound, "trade deviation too high");
    }

    function _trackAccountMarket(address account, bytes32 marketId) internal {
        if (accountMarketSeen[account][marketId]) {
            return;
        }
        accountMarketSeen[account][marketId] = true;
        accountMarkets[account].push(marketId);
    }

    /// @dev PH-7: ERC-20 transfer/transferFrom that tolerates non-standard
    ///      tokens which return no value (e.g. USDT). Reverts unless the call
    ///      succeeded AND (returned nothing OR returned true).
    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(collateralToken).call(
            abi.encodeWithSelector(collateralToken.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(collateralToken).call(
            abi.encodeWithSelector(collateralToken.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }
}
