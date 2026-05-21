// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../interfaces/ISettingManagement.sol";

interface IFYUSDBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title FyusdEpochRedemption
 * @notice Phase 2 Redeem-FYUSD flow per ADR-011 — symmetric mirror of
 *         {FyusdEpochSettlement}. Burns FYUSD against an off-chain
 *         Bitgo-Prime collateral wire.
 *
 *           T+0  ──── OPEN ────  T+lockOffset ──── LOCKED ────  T+duration
 *                 │ requestRedeem │ Bitgo Prime wire     │
 *                 │ accepted      │ in flight            │
 *                                                        ▼
 *                                                   SETTLED
 *                                                        │
 *                                  user-claim or batch   │
 *                                  distribute            ▼
 *                                                   DISTRIBUTED
 *
 *         During OPEN, users (or anyone with a backend-signed quote on
 *         their behalf) call {requestRedeem(quote, sig)} which:
 *           - pulls {fyusdAmount} FYUSD from the user via
 *             {transferFrom} (must approve this contract first)
 *           - holds the FYUSD in escrow on the contract
 *           - records the per-(epoch, user) request + targetAsset hint
 *
 *         When {block.timestamp >= epoch.lockAt}, anyone can call
 *         {lockEpoch(epochId)} to transition OPEN -> LOCKED. The
 *         backend then wires the equivalent collateral out of Bitgo
 *         Prime to the executor EOA.
 *
 *         Once Bitgo confirms, the executor calls
 *         {settleEpoch(epochId, totalCollateralAvailable, collateralAsset)}.
 *         This:
 *           - asserts state == LOCKED
 *           - pulls {totalCollateralAvailable} of {collateralAsset}
 *             from the executor (executor must approve this contract
 *             for the same amount before calling)
 *           - burns the entire {totalFyusdRequested} balance held by
 *             this contract (FYUSD inherits {ERC20BurnableUpgradeable})
 *           - records {totalCollateralPaid} + {collateralAsset}
 *             against the epoch
 *
 *         Users (or anyone, on their behalf — collateral always lands
 *         at the original requester) call {claim(epochId, user)} to
 *         receive their pro-rata collateral share. Pro-rata math:
 *           payout = userFyusdRequested * totalCollateralPaid
 *                    / totalFyusdRequested
 *
 *         If Bitgo SLA breaches (no settlement in lifecycle window),
 *         admin can {cancelEpoch(epochId, reasonHash)} which moves
 *         to CANCELLED. {claim} thereafter detects CANCELLED and
 *         refunds the user's original FYUSD escrow instead of
 *         collateral.
 *
 *         <b>Asset semantics</b>: per-user requests carry a
 *         {targetAsset} hint (which USDT/USDC the user prefers).
 *         Phase 2 simplification: the admin settles the entire epoch
 *         in a single asset chosen at settle time. Users who requested
 *         the other asset receive their pro-rata payout in the chosen
 *         asset (effectively a forced 1:1 swap at par). Phase 3 may
 *         split per-target settlement — out of scope for this ADR.
 *
 *         <b>Pause posture</b> (mirrors ADR-008):
 *           - {requestPaused[asset]}      → blocks new redemption requests
 *           - {settlementPaused}          → blocks {settleEpoch}
 *
 * @dev Upgradeable (TransparentProxy). Tracked decisions: ADR-011
 *      (this redemption design), ADR-005 (Bitgo Prime interface),
 *      ADR-008 (per-asset/phase pause). Stays a sibling of
 *      {FyusdEpochSettlement} rather than inheriting from it because
 *      the storage layouts diverge enough (no `fyusdMinted`, no
 *      per-user collateral on deposit) that a shared base would be
 *      more confusing than two parallel contracts the auditor can
 *      diff.
 */
contract FyusdEpochRedemption is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Constants ──
    /// @notice Default 12-hour epoch length. Symmetric with the
    ///         settlement side; admin can override at openEpoch time.
    uint64 public constant DEFAULT_EPOCH_DURATION = 12 hours;
    /// @notice Default 10-hour request window inside the epoch.
    uint64 public constant DEFAULT_LOCK_OFFSET = 10 hours;

    // ── EIP-712 (FYP-07 patch) ──
    /// @notice EIP-712 type-hash for a RedeemQuote. Action discriminator
    ///         that closes the cross-contract replay path against
    ///         FypherBurnQueue / FyusdEpochSettlement.
    bytes32 public constant REDEEM_TYPEHASH = keccak256(
        "RedeemQuote(address user,uint256 epochId,uint256 fyusdAmount,address targetAsset,uint256 nonce,uint256 expiry)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("FyusdEpochRedemption"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // ── Types ──

    enum EpochState { NONE, OPEN, LOCKED, SETTLED, DISTRIBUTED, CANCELLED }

    struct Epoch {
        uint64  openAt;
        uint64  lockAt;            // requests close at >= lockAt
        uint64  endAt;             // settlement window expires at >= endAt
        EpochState state;
        // Aggregate accounting.
        uint256 totalFyusdRequested;
        uint256 totalCollateralPaid;     // set on settle()
        address collateralAsset;         // set on settle()
        uint256 collateralDistributed;   // running total claimed
    }

    /// @notice Backend-signed redemption quote. Mirrors the deposit
    ///         envelope: requester binds price + epoch at request
    ///         time; backend takes the asset risk between request and
    ///         Bitgo-side wire.
    struct RedeemQuote {
        address user;
        uint256 epochId;
        uint256 fyusdAmount;       // FYUSD the user is escrowing for redemption
        address targetAsset;       // user's preferred USDT/USDC; hint only (see contract docs)
        uint256 nonce;
        uint256 expiry;
    }

    // ── Storage ──

    ISettingManagement public settingManagement;
    IFYUSDBurnable     public fyusd;
    address            public backendSigner;
    address            public backendExecutor;
    address            public pauserRole;

    /// @notice 1-indexed sequence of epochs. epoch 0 is sentinel "none".
    uint256 public nextEpochId;

    mapping(uint256 => Epoch) public epochs;

    /// @notice Per-(epoch, user) FYUSD escrow + target-asset hint.
    mapping(uint256 => mapping(address => uint256)) public fyusdRequested;
    mapping(uint256 => mapping(address => address)) public targetAsset;

    /// @notice Per-(epoch, user) claim flag.
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Replay protection (per-user, like FyusdEpochSettlement).
    mapping(address => mapping(uint256 => bool)) private _usedNonces;

    /// @notice Supported target assets for redemption (USDT/USDC).
    mapping(address => bool) public supportedAssets;

    /// @notice ADR-008 per-asset request pause. Keys on `targetAsset`.
    mapping(address => bool) public requestPaused;

    /// @notice ADR-008 settlement-side pause: blocks {settleEpoch}.
    bool public settlementPaused;

    // ── Events ──

    event EpochOpened(uint256 indexed epochId, uint64 openAt, uint64 lockAt, uint64 endAt);
    event EpochLocked(uint256 indexed epochId, uint64 lockedAt);
    event EpochSettled(
        uint256 indexed epochId,
        address indexed collateralAsset,
        uint256 totalCollateralPaid,
        uint256 totalFyusdBurned
    );
    event EpochCancelled(uint256 indexed epochId, bytes32 reasonHash);
    event RedeemRequested(
        uint256 indexed epochId,
        address indexed user,
        uint256 fyusdAmount,
        address targetAsset
    );
    event Claimed(
        uint256 indexed epochId,
        address indexed user,
        address indexed collateralAsset,
        uint256 collateralAmount
    );
    event Refunded(uint256 indexed epochId, address indexed user, uint256 fyusdAmount);
    event SupportedAssetSet(address indexed asset, bool supported);
    event RequestPausedSet(address indexed asset, bool paused);
    event SettlementPausedSet(bool paused);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event BackendSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event BackendExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);

    // ── Errors ──

    error NotAdmin();
    error NotExecutor();
    error NotPauserOrAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidState(EpochState expected, EpochState actual);
    error EpochNotFound(uint256 epochId);
    error EpochStillOpen(uint64 lockAt);
    error EpochAlreadyLocked();
    error UnsupportedAsset();
    error RequestPausedForAsset();
    error SettlementPausedErr();
    error ExpiredQuote();
    error UserBlacklisted();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error AlreadyClaimed();
    error NothingToClaim();
    error InvalidLockOffset();

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IFYUSDBurnable _fyusd,
        address _backendSigner,
        address _backendExecutor
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (_backendSigner == address(0)) revert ZeroAddress();
        if (_backendExecutor == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        settingManagement = _settingManagement;
        fyusd = _fyusd;
        backendSigner = _backendSigner;
        backendExecutor = _backendExecutor;
    }

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != backendExecutor) revert NotExecutor();
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (msg.sender != pauserRole && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotPauserOrAdmin();
        }
        _;
    }

    // ── Epoch lifecycle ──

    function openEpoch(uint64 durationSeconds, uint64 lockOffsetSeconds)
        external
        onlyAdmin
        returns (uint256 epochId)
    {
        if (lockOffsetSeconds == 0 || lockOffsetSeconds >= durationSeconds) revert InvalidLockOffset();
        unchecked { epochId = ++nextEpochId; }
        uint64 openAt = uint64(block.timestamp);
        epochs[epochId] = Epoch({
            openAt: openAt,
            lockAt: openAt + lockOffsetSeconds,
            endAt:  openAt + durationSeconds,
            state: EpochState.OPEN,
            totalFyusdRequested: 0,
            totalCollateralPaid: 0,
            collateralAsset: address(0),
            collateralDistributed: 0
        });
        emit EpochOpened(epochId, openAt, openAt + lockOffsetSeconds, openAt + durationSeconds);
    }

    function lockEpoch(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.OPEN) revert InvalidState(EpochState.OPEN, e.state);
        if (block.timestamp < e.lockAt) revert EpochStillOpen(e.lockAt);
        e.state = EpochState.LOCKED;
        emit EpochLocked(epochId, uint64(block.timestamp));
    }

    /**
     * @notice Settle a LOCKED epoch by pulling collateral from the executor
     *         and burning the escrowed FYUSD. Backend executor only.
     *
     *         The executor MUST approve this contract for at least
     *         {totalCollateralPaid} of {collateralAsset_} before calling;
     *         a revert here just rolls back the state flip, no funds move.
     *
     *         {totalCollateralPaid} should equal what Bitgo Prime confirmed
     *         it minted/wired off-chain, denominated in the chosen
     *         {collateralAsset_}. Under-settlement (Bitgo paid less than
     *         the total FYUSD entitlement implies at par) leaves a
     *         reconcilable shortfall in the audit ledger; users still get
     *         pro-rata payouts.
     */
    function settleEpoch(
        uint256 epochId,
        uint256 totalCollateralPaid_,
        address collateralAsset_
    )
        external
        onlyExecutor
        nonReentrant
    {
        if (settlementPaused) revert SettlementPausedErr();
        if (collateralAsset_ == address(0)) revert ZeroAddress();
        if (!supportedAssets[collateralAsset_]) revert UnsupportedAsset();
        if (totalCollateralPaid_ == 0) revert ZeroAmount();

        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.LOCKED) revert InvalidState(EpochState.LOCKED, e.state);

        e.state = EpochState.SETTLED;
        e.collateralAsset = collateralAsset_;
        e.totalCollateralPaid = totalCollateralPaid_;

        // Pull collateral first; if the executor under-approved or
        // didn't fund the EOA, the whole settlement reverts.
        IERC20(collateralAsset_).safeTransferFrom(msg.sender, address(this), totalCollateralPaid_);

        // Burn the escrowed FYUSD. Per ADR-011, redemption extinguishes
        // FYUSD against the same backing the mint side created — burn
        // is the on-chain accounting half of that.
        uint256 toBurn = e.totalFyusdRequested;
        if (toBurn > 0) {
            fyusd.burn(toBurn);
        }
        emit EpochSettled(epochId, collateralAsset_, totalCollateralPaid_, toBurn);
    }

    function cancelEpoch(uint256 epochId, bytes32 reasonHash) external onlyAdmin {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.OPEN && e.state != EpochState.LOCKED) {
            revert InvalidState(EpochState.LOCKED, e.state);
        }
        e.state = EpochState.CANCELLED;
        emit EpochCancelled(epochId, reasonHash);
    }

    // ── Request ──

    /**
     * @notice Lock {fyusdAmount} FYUSD against the OPEN epoch and record
     *         a redemption claim. Anyone can submit on behalf of the
     *         requester (provided they have the signed quote and the user
     *         has approved this contract for the FYUSD). The escrowed
     *         FYUSD is always pulled from {quote.user}.
     */
    function requestRedeem(RedeemQuote calldata quote, bytes calldata signature)
        external
        nonReentrant
    {
        if (quote.user == address(0)) revert ZeroAddress();
        if (quote.fyusdAmount == 0) revert ZeroAmount();
        if (!supportedAssets[quote.targetAsset]) revert UnsupportedAsset();
        if (requestPaused[quote.targetAsset]) revert RequestPausedForAsset();
        if (block.timestamp > quote.expiry) revert ExpiredQuote();
        if (settingManagement.isBlacklisted(quote.user)) revert UserBlacklisted();
        if (_usedNonces[quote.user][quote.nonce]) revert NonceAlreadyUsed();

        Epoch storage e = epochs[quote.epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(quote.epochId);
        if (e.state != EpochState.OPEN) revert InvalidState(EpochState.OPEN, e.state);
        if (block.timestamp >= e.lockAt) revert EpochAlreadyLocked();

        _verifyQuote(quote, signature);
        _usedNonces[quote.user][quote.nonce] = true;

        // Escrow the FYUSD (later burned at settle, refunded on cancel).
        IERC20(address(fyusd)).safeTransferFrom(quote.user, address(this), quote.fyusdAmount);

        // Multi-request per (epoch, user) is allowed; sum the requested
        // amount. targetAsset is recorded only on the first request to
        // keep the user's hint stable; subsequent requests in the same
        // epoch reuse it (the contract pays everyone in the admin-chosen
        // settlement asset anyway, so the hint is informational).
        if (targetAsset[quote.epochId][quote.user] == address(0)) {
            targetAsset[quote.epochId][quote.user] = quote.targetAsset;
        }
        fyusdRequested[quote.epochId][quote.user] += quote.fyusdAmount;
        e.totalFyusdRequested += quote.fyusdAmount;

        emit RedeemRequested(quote.epochId, quote.user, quote.fyusdAmount, quote.targetAsset);
    }

    // ── Claim / Refund ──

    /**
     * @notice Pay out the user's share of the epoch.
     *           - SETTLED  -> pro-rata collateral by request
     *           - CANCELLED-> refund original FYUSD escrow
     *           - other    -> revert
     *
     *         Permissionless: pays the original requester.
     *
     *         Pro-rata math: if Bitgo wired {totalCollateralPaid} against
     *         a pool of {totalFyusdRequested} user requests, each user's
     *         payout is {requested * totalCollateralPaid / totalFyusdRequested}.
     *         Under perfect settlement at par this collapses to "what the
     *         user redeemed for".
     */
    function claim(uint256 epochId, address user) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (claimed[epochId][user]) revert AlreadyClaimed();

        if (e.state == EpochState.SETTLED || e.state == EpochState.DISTRIBUTED) {
            uint256 requested = fyusdRequested[epochId][user];
            if (requested == 0) revert NothingToClaim();
            claimed[epochId][user] = true;
            uint256 payout = e.totalFyusdRequested == 0
                ? 0
                : (requested * e.totalCollateralPaid) / e.totalFyusdRequested;
            e.collateralDistributed += payout;
            if (
                e.state == EpochState.SETTLED &&
                e.collateralDistributed == e.totalCollateralPaid
            ) {
                e.state = EpochState.DISTRIBUTED;
            }
            if (payout > 0) {
                IERC20(e.collateralAsset).safeTransfer(user, payout);
            }
            emit Claimed(epochId, user, e.collateralAsset, payout);
        } else if (e.state == EpochState.CANCELLED) {
            uint256 amount = fyusdRequested[epochId][user];
            if (amount == 0) revert NothingToClaim();
            claimed[epochId][user] = true;
            IERC20(address(fyusd)).safeTransfer(user, amount);
            emit Refunded(epochId, user, amount);
        } else {
            revert InvalidState(EpochState.SETTLED, e.state);
        }
    }

    // ── Admin ──

    function setSupportedAsset(address asset, bool supported) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        supportedAssets[asset] = supported;
        emit SupportedAssetSet(asset, supported);
    }

    function setRequestPaused(address asset, bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        requestPaused[asset] = paused;
        emit RequestPausedSet(asset, paused);
    }

    function setSettlementPaused(bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        settlementPaused = paused;
        emit SettlementPausedSet(paused);
    }

    function setBackendSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        emit BackendSignerUpdated(backendSigner, newSigner);
        backendSigner = newSigner;
    }

    function setBackendExecutor(address newExecutor) external onlyAdmin {
        if (newExecutor == address(0)) revert ZeroAddress();
        emit BackendExecutorUpdated(backendExecutor, newExecutor);
        backendExecutor = newExecutor;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }

    // ── View ──

    function epochState(uint256 epochId) external view returns (EpochState) {
        return epochs[epochId].state;
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _usedNonces[user][nonce];
    }

    /**
     * @notice EIP-712 struct hash for a RedeemQuote.
     * @dev FYP-07 patch. See {FypherBurnQueue.hashQuote} for the
     *      cross-chain / cross-contract replay rationale this closes.
     */
    function hashQuote(RedeemQuote calldata quote) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REDEEM_TYPEHASH,
                quote.user,
                quote.epochId,
                quote.fyusdAmount,
                quote.targetAsset,
                quote.nonce,
                quote.expiry
            )
        );
    }

    /// @notice Full EIP-712 digest for backend signing. See
    ///         {FypherBurnQueue.digest} for the rollout note.
    function digest(RedeemQuote calldata quote) external view returns (bytes32) {
        return _digestFromStruct(hashQuote(quote));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── Internal ──

    function _verifyQuote(RedeemQuote calldata quote, bytes calldata signature) internal view {
        bytes32 d = _digestFromStruct(hashQuote(quote));
        address recovered = d.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function _digestFromStruct(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"19_01", _domainSeparatorV4(), structHash)
        );
    }
}
