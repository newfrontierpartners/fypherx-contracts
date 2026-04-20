// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
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

    address public owner;
    IERC20Minimal public immutable collateralToken;
    IFypherOracleRouter public immutable oracleRouter;

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
    event PositionLiquidated(address indexed account, bytes32 indexed marketId, uint256 markPriceE18, int256 realizedPnlE18);

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

    constructor(address collateralToken_, address oracleRouter_) {
        require(collateralToken_ != address(0), "invalid collateral");
        require(oracleRouter_ != address(0), "invalid oracle router");
        owner = msg.sender;
        collateralToken = IERC20Minimal(collateralToken_);
        oracleRouter = IFypherOracleRouter(oracleRouter_);
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

    function deposit(uint256 amountE18) external {
        require(amountE18 > 0, "invalid deposit");
        require(collateralToken.transferFrom(msg.sender, address(this), amountE18), "transfer failed");
        collateralBalanceE18[msg.sender] += int256(amountE18);
        emit CollateralDeposited(msg.sender, amountE18);
    }

    function withdraw(uint256 amountE18) external {
        require(amountE18 > 0, "invalid withdraw");
        require(collateralBalanceE18[msg.sender] >= int256(amountE18), "insufficient collateral");

        collateralBalanceE18[msg.sender] -= int256(amountE18);
        _assertInitialMarginHealthy(msg.sender);

        require(collateralToken.transfer(msg.sender, amountE18), "transfer failed");
        emit CollateralWithdrawn(msg.sender, amountE18);
    }

    function executeMatchedTrade(
        address account,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 requestedLeverageE18
    ) external onlyRelayer {
        require(account != address(0), "invalid account");
        require(sizeDeltaE18 > 0, "invalid size");
        require(executionPriceE18 > 0, "invalid execution price");

        MarketConfig memory config = markets[marketId];
        require(config.active, "market inactive");
        require(requestedLeverageE18 >= 1e18 && requestedLeverageE18 <= config.maxLeverageE18, "invalid leverage");

        uint256 oraclePriceE18 = oracleRouter.getPriceE18(marketId);
        _assertPriceWithinDeviation(executionPriceE18, oraclePriceE18, config.maxTradeDeviationBps);

        Position memory existing = positions[account][marketId];

        if (existing.sizeE18 == 0) {
            _openPosition(account, marketId, config, isLong, sizeDeltaE18, executionPriceE18, requestedLeverageE18);
        } else if (existing.isLong == isLong) {
            _addToPosition(account, marketId, config, existing, sizeDeltaE18, executionPriceE18, requestedLeverageE18);
        } else if (sizeDeltaE18 < existing.sizeE18) {
            _reducePosition(account, marketId, existing, sizeDeltaE18, executionPriceE18);
        } else if (sizeDeltaE18 == existing.sizeE18) {
            _closePosition(account, marketId, existing, executionPriceE18);
        } else {
            _flipPosition(account, marketId, config, existing, isLong, sizeDeltaE18, executionPriceE18, requestedLeverageE18);
        }

        _assertInitialMarginHealthy(account);
        emit TradeApplied(account, marketId, isLong, sizeDeltaE18, executionPriceE18, requestedLeverageE18);
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
    function liquidate(address account, bytes32 marketId) external onlyLiquidator {
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
            require(insuranceFund.balance() >= deficit, "insurance underfunded");
            insuranceFund.withdraw(address(this), deficit, marketId);
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
}
