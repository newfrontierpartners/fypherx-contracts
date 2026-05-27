// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../interfaces/ISettingManagement.sol";

interface IFYUSDMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title FyusdEpochSettlement
 * @notice Phase 1 Get-FYUSD flow per PHASE1_SPEC §3.2 + ADR-005:
 *
 *           T+0  ──── OPEN ────  T+10h ──── LOCKED ────  T+12h
 *                 │ deposit       │ Bitgo Prime call    │
 *                 │ accepted      │ in flight           │
 *                                                       ▼
 *                                                   SETTLED
 *                                                       │
 *                                  user-claim or batch  │
 *                                  distribute           ▼
 *                                                  DISTRIBUTED
 *
 *         A new epoch is opened by the admin (or anyone after the
 *         previous epoch's lockAt has passed and a fresh window is
 *         needed) via {openEpoch(durationSeconds, lockOffsetSeconds)}.
 *
 *         During OPEN, users (or anyone with a backend-signed quote
 *         on their behalf) call {deposit(quote, sig)} which:
 *           - pulls the collateral asset from the depositor
 *           - records the per-(epoch, user) FYUSD claim entitlement
 *           - emits {Deposited} so the indexer can populate
 *             `epoch_deposit` rows in the audit ledger
 *
 *         When `block.timestamp >= epoch.lockAt`, anyone can call
 *         {lockEpoch(epochId)} to transition OPEN -> LOCKED. The
 *         backend then calls Bitgo Prime off-chain.
 *
 *         When Bitgo confirms, the executor calls
 *         {settleEpoch(epochId, fyusdMinted)}. This:
 *           - asserts state == LOCKED
 *           - mints fyusdMinted FYUSD to this contract via the
 *             FYUSD `_minter` slot (which is set to this contract,
 *             see ADR-005 §2)
 *           - records `fyusdMinted` against the epoch
 *           - emits {Settled}
 *
 *         Users (or anyone, on their behalf — the FYUSD always goes
 *         to the original depositor) call {claim(epochId)} to receive
 *         their pro-rata FYUSD share. Per-epoch supply is allocated
 *         in proportion to each user's recorded `fyusdEntitled`.
 *
 *         If Bitgo SLA breaches (no settlement before next-epoch
 *         deadline), admin can {cancelEpoch(epochId)} which moves
 *         to CANCELLED and refunds all depositors via the standard
 *         claim() path (which detects CANCELLED and refunds collateral
 *         instead of FYUSD).
 *
 *         Tickets are DB-only UUIDs per ADR-002 — the on-chain
 *         identifier is the (epochId, user) pair.
 *
 *         Per-asset & per-phase pause (ADR-008):
 *           - `depositPaused[asset]`   → blocks new deposits
 *           - `settlementPaused`       → blocks Bitgo settlement entry
 *
 * @dev Upgradeable (TransparentProxy). Tracked decisions: ADR-005
 *      (Bitgo interface-first + emergencyMint retained), ADR-008
 *      (per-asset/phase pause), ADR-002 (DB-only ticket).
 */
contract FyusdEpochSettlement is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Constants ──
    /// @notice Default 12-hour epoch length per spec §3.2.
    uint64 public constant DEFAULT_EPOCH_DURATION = 12 hours;
    /// @notice Default 10-hour deposit window inside the epoch (lockAt
    ///         relative to openAt).
    uint64 public constant DEFAULT_LOCK_OFFSET = 10 hours;

    // ── EIP-712 (FYP-07 patch) ──
    /// @notice EIP-712 type-hash for a DepositQuote. Binding it into
    ///         the digest gives the signature an action discriminator
    ///         so a deposit-signed quote cannot be replayed against
    ///         FypherBurnQueue / FyusdEpochRedemption.
    bytes32 public constant DEPOSIT_TYPEHASH = keccak256(
        "DepositQuote(address user,uint256 epochId,address collateralAsset,uint256 collateralAmount,uint256 fyusdAmount,uint256 nonce,uint256 expiry)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("FyusdEpochSettlement"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // ── Types ──

    enum EpochState { NONE, OPEN, LOCKED, SETTLED, DISTRIBUTED, CANCELLED }

    struct Epoch {
        uint64  openAt;
        uint64  lockAt;        // deposits close at >= lockAt
        uint64  endAt;         // settlement window expires at >= endAt
        EpochState state;
        // Aggregate accounting (per-asset deposits, total FYUSD entitled).
        uint256 totalFyusdEntitled;
        uint256 fyusdMinted;       // set on settle()
        uint256 fyusdDistributed;  // running total claimed
    }

    /// @notice Backend-signed deposit quote. Mirrors the FypherBurnQueue
    ///         envelope pattern: depositor binds price + epoch at deposit
    ///         time; backend takes the asset risk between deposit and
    ///         Bitgo settlement.
    struct DepositQuote {
        address user;
        uint256 epochId;
        address collateralAsset;
        uint256 collateralAmount;
        uint256 fyusdAmount;       // amount of FYUSD this deposit entitles
        uint256 nonce;
        uint256 expiry;
    }

    // ── Storage ──

    ISettingManagement public settingManagement;
    IFYUSDMintable     public fyusd;
    address            public backendSigner;
    address            public backendExecutor;
    address            public pauserRole;

    /// @notice 1-indexed sequence of epochs. epoch 0 is sentinel "none".
    uint256 public nextEpochId;

    mapping(uint256 => Epoch) public epochs;

    /// @notice Per-(epoch, user) FYUSD claim entitlement (set during deposit).
    mapping(uint256 => mapping(address => uint256)) public fyusdEntitled;

    /// @notice Per-(epoch, user) collateral commitment (asset + amount).
    ///         Stored so a CANCELLED epoch can refund the original asset.
    mapping(uint256 => mapping(address => address)) public depositedAsset;
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;

    /// @notice Per-(epoch, user) claim flag.
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Replay protection (per-user, like FypherMinting / FypherBurnQueue).
    mapping(address => mapping(uint256 => bool)) private _usedNonces;

    /// @notice Supported collateral assets for FYUSD deposits.
    mapping(address => bool) public supportedAssets;

    /// @notice ADR-008 per-asset deposit pause.
    mapping(address => bool) public depositPaused;

    /// @notice ADR-008 settlement-side pause: blocks {settleEpoch}. Lets
    ///         ops freeze settlements (e.g. on a Bitgo incident) while
    ///         leaving open epochs that have already settled claimable.
    bool public settlementPaused;

    // ── Events ──

    event EpochOpened(uint256 indexed epochId, uint64 openAt, uint64 lockAt, uint64 endAt);
    event EpochLocked(uint256 indexed epochId, uint64 lockedAt);
    event EpochSettled(uint256 indexed epochId, uint256 fyusdMinted, uint256 totalEntitled);
    event EpochCancelled(uint256 indexed epochId, bytes32 reasonHash);
    event CollateralSwept(
        uint256 indexed epochId,
        address indexed asset,
        address indexed to,
        uint256 amount
    );
    event Deposited(
        uint256 indexed epochId,
        address indexed user,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 fyusdAmount
    );
    event Claimed(uint256 indexed epochId, address indexed user, uint256 fyusdAmount);
    event Refunded(uint256 indexed epochId, address indexed user, address asset, uint256 amount);
    event SupportedAssetSet(address indexed asset, bool supported);
    event DepositPausedSet(address indexed asset, bool paused);
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
    error DepositPausedForAsset();
    error SettlementPausedErr();
    error ExpiredQuote();
    error EpochMismatch();
    error UserBlacklisted();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error AlreadyClaimed();
    error NothingToClaim();
    error InvalidLockOffset();
    /// @notice FYP-30: settleEpoch must not over-mint relative to the
    ///         aggregate entitlement that {deposit} booked.
    error ExcessSettlement(uint256 fyusdMinted, uint256 totalEntitled);
    /// @notice FYP-30: settleEpoch must complete before the epoch's
    ///         {endAt} expiry. Late settlements should be the
    ///         {cancelEpoch} path instead so the contract refunds
    ///         depositors.
    error SettlementWindowExpired(uint64 endAt);
    /// @notice FYP-30: openEpoch refuses to create a new epoch while
    ///         another is still OPEN (admins should let the previous
    ///         epoch lock first, or cancel it explicitly).
    error AnotherEpochOpen(uint256 openEpochId);

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IFYUSDMintable _fyusd,
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

    /**
     * @notice Open a new epoch. Admin-only; the next-epoch cadence is set
     *         off-chain (typically a scheduler kicks this every 12h).
     *
     * @param durationSeconds  Total epoch length (e.g. 12 * 3600).
     * @param lockOffsetSeconds  Deposits close at (openAt + lockOffset).
     *                           Must be < durationSeconds.
     */
    function openEpoch(uint64 durationSeconds, uint64 lockOffsetSeconds)
        external
        onlyAdmin
        returns (uint256 epochId)
    {
        if (lockOffsetSeconds == 0 || lockOffsetSeconds >= durationSeconds) revert InvalidLockOffset();
        // FYP-30: refuse to open a new epoch while the previous one
        // is still OPEN. With multiple live OPEN epochs users can
        // accidentally pin their deposit to the wrong one, and the
        // off-chain scheduler that calls {openEpoch} every 12h has no
        // safety against double-firing. The admin can {cancelEpoch}
        // the prior epoch first if a re-open is intentional.
        if (nextEpochId != 0 && epochs[nextEpochId].state == EpochState.OPEN) {
            revert AnotherEpochOpen(nextEpochId);
        }
        unchecked { epochId = ++nextEpochId; }
        uint64 openAt = uint64(block.timestamp);
        epochs[epochId] = Epoch({
            openAt: openAt,
            lockAt: openAt + lockOffsetSeconds,
            endAt:  openAt + durationSeconds,
            state: EpochState.OPEN,
            totalFyusdEntitled: 0,
            fyusdMinted: 0,
            fyusdDistributed: 0
        });
        emit EpochOpened(epochId, openAt, openAt + lockOffsetSeconds, openAt + durationSeconds);
    }

    /**
     * @notice Transition OPEN -> LOCKED once `block.timestamp >= lockAt`.
     *         Permissionless: anyone can call to advance the state machine.
     *         Idempotent guard via state check.
     */
    function lockEpoch(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.OPEN) revert InvalidState(EpochState.OPEN, e.state);
        if (block.timestamp < e.lockAt) revert EpochStillOpen(e.lockAt);
        e.state = EpochState.LOCKED;
        emit EpochLocked(epochId, uint64(block.timestamp));
    }

    /**
     * @notice Settle a LOCKED epoch with the FYUSD amount Bitgo confirmed.
     *         Backend executor only. Mints FYUSD into this contract for
     *         later per-user claim. `fyusdMinted` is recorded so
     *         under-settlement (Bitgo paid less than entitled) leaves a
     *         reconcilable shortfall in the audit ledger.
     */
    /**
     * @notice Settle a LOCKED epoch with the FYUSD amount Bitgo confirmed.
     *
     * @dev FYP-30 patch. Three input validations added:
     *      (a) `fyusdMinted > 0` — a zero-value settle would advance
     *          the state machine to SETTLED with no on-chain payout
     *          and no recovery path (claim() would set claimed=true
     *          but pay 0, and {cancelEpoch} no longer accepts SETTLED).
     *          Bitgo failures should go through {cancelEpoch} instead.
     *      (b) `fyusdMinted <= totalFyusdEntitled` — over-minting
     *          would create FYUSD beyond the aggregate user
     *          entitlement, breaking the "RUSD totalSupply <= backing"
     *          analogue invariant for FYUSD. Under-settle is allowed
     *          (per-claim pro-rata math handles the shortfall) but
     *          over-settle is rejected.
     *      (c) `block.timestamp <= endAt` — late settlements must be
     *          {cancelEpoch}'d instead so depositors can recover their
     *          collateral.
     */
    function settleEpoch(uint256 epochId, uint256 fyusdMinted)
        external
        onlyExecutor
        nonReentrant
    {
        if (settlementPaused) revert SettlementPausedErr();
        if (fyusdMinted == 0) revert ZeroAmount();
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.LOCKED) revert InvalidState(EpochState.LOCKED, e.state);
        if (block.timestamp > e.endAt) revert SettlementWindowExpired(e.endAt);
        if (fyusdMinted > e.totalFyusdEntitled) {
            revert ExcessSettlement(fyusdMinted, e.totalFyusdEntitled);
        }

        e.state = EpochState.SETTLED;
        e.fyusdMinted = fyusdMinted;

        fyusd.mint(address(this), fyusdMinted);
        emit EpochSettled(epochId, fyusdMinted, e.totalFyusdEntitled);
    }

    /**
     * @notice Move an OPEN or LOCKED epoch to CANCELLED. Admin only.
     *         {claim} thereafter detects CANCELLED and refunds the
     *         depositor's original collateral instead of FYUSD.
     *
     *         `reasonHash` commits to a written off-chain justification
     *         (audit ledger).
     */
    function cancelEpoch(uint256 epochId, bytes32 reasonHash) external onlyAdmin {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.OPEN && e.state != EpochState.LOCKED) {
            revert InvalidState(EpochState.LOCKED, e.state);
        }
        e.state = EpochState.CANCELLED;
        emit EpochCancelled(epochId, reasonHash);
    }

    /**
     * @notice Sweep `amount` of `asset` out of the contract into `to`.
     *         Admin-only and restricted to SETTLED or DISTRIBUTED epochs
     *         so the path cannot interfere with a CANCELLED epoch's
     *         collateral refund flow (which {claim} pays from the same
     *         balances).
     *
     * @dev FYP-23 patch. Before this entry-point, every collateral
     *      asset deposited during an epoch's OPEN window stayed in the
     *      contract permanently after settlement: {settleEpoch} only
     *      minted FYUSD to the contract for later {claim} distribution,
     *      and {cancelEpoch} rejected SETTLED epochs. There was no
     *      on-chain path to forward the collateral to the treasury /
     *      Bitgo wallet / executor that funds {FyusdEpochRedemption}.
     *
     *      The sweep is intentionally manual + per-(asset, amount):
     *      multi-asset epochs are supported (each user pins a single
     *      asset per deposit, but different users in the same epoch
     *      can pin different assets), so a one-shot auto-sweep at
     *      settle time would need to iterate every depositor to know
     *      which assets to drain. Manual per-call sweep keeps the
     *      logic linear in operator cost and makes the destination
     *      explicit in the audit ledger (see {CollateralSwept}).
     *
     *      Restricted to SETTLED / DISTRIBUTED:
     *        - OPEN  : users still depositing, balances are not yet
     *                  fully booked.
     *        - LOCKED: Bitgo settlement in flight, no on-chain decision
     *                  yet.
     *        - CANCELLED: {claim} refunds the user's original
     *                  {depositedAmount} of {depositedAsset} from this
     *                  balance — a sweep here would short-pay refunds.
     */
    function sweepCollateral(
        uint256 epochId,
        address asset,
        address to,
        uint256 amount
    ) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (e.state != EpochState.SETTLED && e.state != EpochState.DISTRIBUTED) {
            revert InvalidState(EpochState.SETTLED, e.state);
        }
        IERC20(asset).safeTransfer(to, amount);
        emit CollateralSwept(epochId, asset, to, amount);
    }

    // ── Deposit ──

    /**
     * @notice Lock collateral against the OPEN epoch and record an FYUSD
     *         claim entitlement. RUSD is NOT involved — the source asset
     *         is whatever the user deposits (USDT/USDC/ETH-as-WETH).
     *
     *         The backend signs a {DepositQuote} that locks the asset's
     *         exchange-rate-to-FYUSD at deposit time. Bitgo will mint
     *         FYUSD against the aggregate of all such deposits when the
     *         epoch settles.
     *
     *         Anyone can submit on behalf of the user (provided they have
     *         the signed quote and the user has approved this contract
     *         for the collateral). The collateral is always pulled from
     *         `quote.user`.
     */
    function deposit(DepositQuote calldata quote, bytes calldata signature)
        external
        nonReentrant
    {
        if (quote.user == address(0)) revert ZeroAddress();
        if (quote.collateralAmount == 0 || quote.fyusdAmount == 0) revert ZeroAmount();
        if (!supportedAssets[quote.collateralAsset]) revert UnsupportedAsset();
        if (depositPaused[quote.collateralAsset]) revert DepositPausedForAsset();
        if (block.timestamp > quote.expiry) revert ExpiredQuote();
        if (settingManagement.isBlacklisted(quote.user)) revert UserBlacklisted();
        if (_usedNonces[quote.user][quote.nonce]) revert NonceAlreadyUsed();

        Epoch storage e = epochs[quote.epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(quote.epochId);
        if (e.state != EpochState.OPEN) revert InvalidState(EpochState.OPEN, e.state);
        if (block.timestamp >= e.lockAt) revert EpochAlreadyLocked();

        _verifyQuote(quote, signature);
        _usedNonces[quote.user][quote.nonce] = true;

        IERC20(quote.collateralAsset).safeTransferFrom(quote.user, address(this), quote.collateralAmount);

        // Multi-deposit per (epoch, user) is allowed; sum entitlement and
        // collateral. depositedAsset is ASSUMED to be the same on multiple
        // deposits — caller (backend) must enforce single-asset per user.
        // If a user wants to deposit multiple assets they should use
        // separate epoch entries.
        if (depositedAsset[quote.epochId][quote.user] == address(0)) {
            depositedAsset[quote.epochId][quote.user] = quote.collateralAsset;
        } else if (depositedAsset[quote.epochId][quote.user] != quote.collateralAsset) {
            revert UnsupportedAsset();
        }

        depositedAmount[quote.epochId][quote.user] += quote.collateralAmount;
        fyusdEntitled[quote.epochId][quote.user] += quote.fyusdAmount;
        e.totalFyusdEntitled += quote.fyusdAmount;

        emit Deposited(
            quote.epochId,
            quote.user,
            quote.collateralAsset,
            quote.collateralAmount,
            quote.fyusdAmount
        );
    }

    // ── Claim / Refund ──

    /**
     * @notice Pay out the user's share of the epoch.
     *           - SETTLED  -> pro-rata FYUSD by entitlement
     *           - CANCELLED-> refund original collateral
     *           - other    -> revert
     *
     *         Permissionless: pays the original depositor.
     *
     *         Pro-rata math: if Bitgo settled `fyusdMinted` FYUSD against
     *         a pool of `totalFyusdEntitled` user claims, each user's
     *         payout is `entitled * fyusdMinted / totalFyusdEntitled`.
     *         Under perfect settlement (fyusdMinted == totalFyusdEntitled)
     *         this collapses to `entitled`.
     */
    function claim(uint256 epochId, address user) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.state == EpochState.NONE) revert EpochNotFound(epochId);
        if (claimed[epochId][user]) revert AlreadyClaimed();

        if (e.state == EpochState.SETTLED || e.state == EpochState.DISTRIBUTED) {
            uint256 entitled = fyusdEntitled[epochId][user];
            if (entitled == 0) revert NothingToClaim();
            claimed[epochId][user] = true;
            uint256 payout = e.totalFyusdEntitled == 0
                ? 0
                : (entitled * e.fyusdMinted) / e.totalFyusdEntitled;
            e.fyusdDistributed += payout;
            if (e.fyusdDistributed == e.fyusdMinted && e.state == EpochState.SETTLED) {
                e.state = EpochState.DISTRIBUTED;
            }
            if (payout > 0) {
                IERC20(address(fyusd)).safeTransfer(user, payout);
            }
            emit Claimed(epochId, user, payout);
        } else if (e.state == EpochState.CANCELLED) {
            uint256 amount = depositedAmount[epochId][user];
            if (amount == 0) revert NothingToClaim();
            address asset = depositedAsset[epochId][user];
            claimed[epochId][user] = true;
            IERC20(asset).safeTransfer(user, amount);
            emit Refunded(epochId, user, asset, amount);
        } else {
            revert InvalidState(EpochState.SETTLED, e.state);
        }
    }

    // ── Admin ──

    // FYP-39: all setters below skip the SSTORE + event when unchanged.
    function setSupportedAsset(address asset, bool supported) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        if (supportedAssets[asset] == supported) return;
        supportedAssets[asset] = supported;
        emit SupportedAssetSet(asset, supported);
    }

    function setDepositPaused(address asset, bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        if (depositPaused[asset] == paused) return;
        depositPaused[asset] = paused;
        emit DepositPausedSet(asset, paused);
    }

    function setSettlementPaused(bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        if (settlementPaused == paused) return;
        settlementPaused = paused;
        emit SettlementPausedSet(paused);
    }

    function setBackendSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        if (newSigner == backendSigner) return;
        emit BackendSignerUpdated(backendSigner, newSigner);
        backendSigner = newSigner;
    }

    function setBackendExecutor(address newExecutor) external onlyAdmin {
        if (newExecutor == address(0)) revert ZeroAddress();
        if (newExecutor == backendExecutor) return;
        emit BackendExecutorUpdated(backendExecutor, newExecutor);
        backendExecutor = newExecutor;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        // FYP-25: reject zero pauser.
        if (newPauser == address(0)) revert ZeroAddress();
        if (newPauser == pauserRole) return;
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
     * @notice EIP-712 struct hash for a DepositQuote.
     * @dev FYP-07 patch. See {FypherBurnQueue.hashQuote} for the
     *      cross-chain / cross-contract replay rationale this closes.
     */
    function hashQuote(DepositQuote calldata quote) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DEPOSIT_TYPEHASH,
                quote.user,
                quote.epochId,
                quote.collateralAsset,
                quote.collateralAmount,
                quote.fyusdAmount,
                quote.nonce,
                quote.expiry
            )
        );
    }

    /// @notice Full EIP-712 digest for backend signing. See
    ///         {FypherBurnQueue.digest} for the rollout note.
    function digest(DepositQuote calldata quote) external view returns (bytes32) {
        return _digestFromStruct(hashQuote(quote));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── Internal ──

    function _verifyQuote(DepositQuote calldata quote, bytes calldata signature) internal view {
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
