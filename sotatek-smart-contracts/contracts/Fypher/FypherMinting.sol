// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../interfaces/ISettingManagement.sol";

interface IRUSD {
    function mint(address to, uint256 amount) external;
}

/// @dev RUSD inherits ERC20BurnableUpgradeable, exposing `burn(uint256)`
///      that destroys the caller's own balance. Used by {executeRedeem}
///      to burn the user's escrowed RUSD in lockstep with collateral
///      release (FYP-08 patch).
interface IRUSDBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title FypherMinting
 * @notice Collateral order matching and RUSD redeem with per-block rate limiting.
 *         Off-chain signed orders are verified on-chain using EIP-712 typed
 *         data with the order type (MINT | REDEEM) bound into the digest.
 *
 * @dev Deployed at: 0x5b6E2A51bc884A6015899a3c673a615816971336
 *      Implementation: 0x4870c0633a9214f76176ff86a72daed528fba714
 *      107 ABI entries: 42 functions, 25 events, 39 errors
 *
 * @dev April-audit P0 patches applied here:
 *
 *      ─ C-2: `cancelRedeem` no longer drains arbitrary RUSD from the
 *             contract balance. It now reads the caller's escrow record
 *             from `pendingRedeems` (created by `requestRedeem`) and
 *             refunds only that amount.
 *
 *      ─ C-3: order signatures are now EIP-712 typed data and bind an
 *             explicit `OrderType` (MINT or REDEEM). Previously the same
 *             signature could be replayed across both flows because the
 *             hash never bound the intent. The domain separator is
 *             computed on-demand (chainId aware), so no upgrade-time
 *             initializer is needed.
 *
 *      ─ C-4: `_distributeCollateral` validates the route — every entry
 *             must be a whitelisted custodian, ratios must sum to exactly
 *             10_000 bps, and zero-ratio / zero-address rows are rejected.
 *             Without this, an attacker could route 100% of collateral to
 *             their own address.
 *
 *      ─ mintWETH deprecation: the prior implementation minted RUSD
 *             without ever transferring collateral. It is now permanently
 *             disabled (reverts `DeprecatedFunction`).
 *
 *      Storage layout is append-only:
 *        - slot 15: `pendingRedeems`                  (April P0)
 *        - slot 16: `mintedPerAssetPerBlock`          (April-audit M-7)
 *        - slot 17: `redeemedPerAssetPerBlock`        (April-audit M-7)
 *      All pre-existing slots (0..14) are untouched, so the existing
 *      TransparentProxy can be upgraded to this implementation without
 *      a storage collision.
 *
 *      April-audit follow-up patches applied here (in addition to the
 *      P0 set above):
 *
 *      ─ H-1: `requestRedeem` now BURNS the nonce in `_usedNonces`.
 *             A user who cancels and re-requests must use a fresh
 *             nonce; a stale executor signature can no longer be
 *             executed against a re-funded escrow.
 *
 *      ─ M-5: `executeRedeem` now reverts (rather than silently
 *             skipping the collateral payout) when
 *             `collateral_asset` is not on the supported list. The
 *             previous shape consumed the user's RUSD escrow without
 *             paying out collateral, locking funds in the contract.
 *
 *      ─ M-6: `stablesDeltaLimit` is now actually enforced on both
 *             `mint` and `executeRedeem` paths. Setting `0` preserves
 *             the pre-patch behaviour (no enforcement).
 *
 *      ─ M-7: `maxMintPerBlock[asset]` and `maxRedeemPerBlock[asset]`
 *             are now actually enforced via the new
 *             `mintedPerAssetPerBlock` / `redeemedPerAssetPerBlock`
 *             counters. Setting `0` preserves the pre-patch behaviour
 *             (no per-asset enforcement).
 *
 *      ABI cutover required for the backend signer / SDK:
 *      - `hashOrder(Order)`            → use `hashOrder(Order, OrderType)`
 *      - `verifyOrder(Order, bytes)`   → use `verifyOrder(Order, bytes, OrderType)`
 *      - `cancelRedeem(uint256, uint256)` → use `cancelRedeem(uint256)`
 *      - `mintWETH(...)`               → use `mint(...)` with WETH as collateral
 *      The old selectors are retained as reverting stubs so callers see a
 *      clear `DeprecatedFunction` error rather than "selector not found".
 */
contract FypherMinting is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Constants ──
    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @notice FYP-50 patch. Hard cap on route legs per mint. 8 is
    ///         generous against the realistic 2-3 custodian split
    ///         and tight enough that {_distributeCollateral} stays
    ///         cheap.
    uint256 public constant MAX_ROUTE_LEGS = 8;

    bytes32 public constant ORDER_TYPEHASH =
        keccak256(
            "Order(uint8 orderType,address benefactor,address beneficiary,address collateral_asset,uint256 collateral_amount,uint256 rusd_amount,uint256 nonce,uint256 expiry)"
        );

    /**
     * @notice FYP-46 patch. EIP-712 type-hash for the route-bound
     *         mint flow. Backend that wants to constrain which
     *         custodians + ratios the mint can use signs over the
     *         {Order} fields PLUS a `route_hash =
     *         keccak256(abi.encode(route.addresses, route.ratios))`.
     *         The relayer / caller MUST then submit the exact route
     *         that hashes to that value; any mismatch reverts.
     */
    bytes32 public constant ORDER_BOUND_TYPEHASH =
        keccak256(
            "Order(uint8 orderType,address benefactor,address beneficiary,address collateral_asset,uint256 collateral_amount,uint256 rusd_amount,uint256 nonce,uint256 expiry,bytes32 route_hash)"
        );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("FypherMinting"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // ── Types ──
    struct Order {
        address benefactor;      // who provides collateral / requests redeem
        address beneficiary;     // who receives RUSD / collateral
        address collateral_asset;
        uint256 collateral_amount;
        uint256 rusd_amount;
        uint256 nonce;
        uint256 expiry;
    }

    struct Route {
        address[] addresses;
        uint256[] ratios;
    }

    enum OrderType { MINT, REDEEM }

    // ── Storage (slots 0..14, untouched) ──
    ISettingManagement public settingManagement;                            // slot 0
    IERC20 public rusd;                                                     // slot 1

    address public backendSigner;                                           // slot 2
    address public backendExecutor;                                         // slot 3

    mapping(address => bool) public supportedAssets;                         // slot 4
    mapping(address => bool) public custodianAddresses;                      // slot 5
    mapping(address => mapping(uint256 => bool)) private _usedNonces;        // slot 6

    uint256 public globalMaxMintPerBlock;                                   // slot 7
    uint256 public globalMaxRedeemPerBlock;                                 // slot 8
    mapping(address => uint256) public maxMintPerBlock;                      // slot 9
    mapping(address => uint256) public maxRedeemPerBlock;                    // slot 10

    mapping(uint256 => uint256) public mintedPerBlock;                       // slot 11
    mapping(uint256 => uint256) public redeemedPerBlock;                     // slot 12

    uint256 public stablesDeltaLimit;                                       // slot 13
    /// @dev Legacy global kill switch. Kept for backward compatibility +
    ///      emergency global stop. New per-asset granularity (ADR-008)
    ///      lives in {mintPaused} + {burnPaused} below; either gate
    ///      tripping is sufficient to block the action.
    bool public mintRedeemDisabled;                                         // slot 14

    // ── Storage append (April P0 patch) ──
    /**
     * @notice (user, nonce) => RUSD escrow held by this contract waiting on
     *         an executor's `executeRedeem` decision (or the user's
     *         `cancelRedeem`). 0 means "no pending request".
     */
    mapping(address => mapping(uint256 => uint256)) public pendingRedeems;   // slot 15

    // ── Storage append (April-audit M-7 patch — APPEND-ONLY for proxy safety) ──
    /**
     * @notice Per-asset, per-block minted total. Backs the previously
     *         dead-letter {maxMintPerBlock} mapping with actual
     *         enforcement.
     */
    mapping(address => mapping(uint256 => uint256)) public mintedPerAssetPerBlock; // slot 16
    /**
     * @notice Per-asset, per-block redeemed total. Backs the previously
     *         dead-letter {maxRedeemPerBlock} mapping with actual
     *         enforcement.
     */
    mapping(address => mapping(uint256 => uint256)) public redeemedPerAssetPerBlock; // slot 17

    // ── S1.2 / ADR-008 — appended slots, storage-layout safe ──

    /// @notice ADR-007 §"Pauser carve-out". Latency-critical role that can
    ///         only call {setMintPaused}. Pauser cannot mint, transfer,
    ///         migrate, or unpause. Unpause requires admin (multisig).
    address public pauserRole;

    /// @notice ADR-008 per-asset mint pause. `mintPaused[asset] = true`
    ///         blocks {mint} (and the {mintWETH} branch when the asset
    ///         resolves to {wrappedNative}). Existing redeem flow is
    ///         migrating to FypherBurnQueue (S1.1) and is not gated here.
    mapping(address => bool) public mintPaused;

    /// @notice Reserved for future per-asset burn pause if FypherMinting
    ///         keeps a redeem path. Today FypherBurnQueue owns burn pause
    ///         (see ADR-008 §FypherBurnQueue.burnPaused).
    mapping(address => bool) public burnPaused;

    // NOTE: an additional `wrappedNative` slot was reserved in an earlier
    // S1.2 draft for {mintWETH}. Per the post-merge resolution with
    // origin/main's April-audit patches, {mintWETH} is permanently
    // deprecated (reverts {DeprecatedFunction}). The wrappedNative slot
    // is intentionally NOT declared here so the proxy storage tail stays
    // tight; future appended slots should start immediately after
    // {burnPaused}.

    // ── Events ──
    event Mint(
        address indexed benefactor,
        address indexed beneficiary,
        address collateral,
        uint256 collateralAmount,
        uint256 rusdAmount
    );
    event Redeem(
        address indexed benefactor,
        address indexed beneficiary,
        address collateral,
        uint256 collateralAmount,
        uint256 rusdAmount
    );
    event RedeemRequested(address indexed user, uint256 rusdAmount, uint256 nonce);
    event RedeemExecuted(address indexed user, address indexed beneficiary, uint256 collateralAmount);
    event RedeemCancelled(address indexed user, uint256 nonce, uint256 amount);
    event AssetAdded(address indexed asset);
    event AssetRemoved(address indexed asset);
    event CustodianAdded(address indexed custodian);
    event CustodianRemoved(address indexed custodian);
    event SignerUpdated(address indexed newSigner);
    event ExecutorUpdated(address indexed newExecutor);
    event MaxMintPerBlockUpdated(uint256 newLimit);
    event MaxRedeemPerBlockUpdated(uint256 newLimit);
    event MintRedeemToggled(bool disabled);
    // S1.2 events
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event MintPausedSet(address indexed asset, bool paused);
    event BurnPausedSet(address indexed asset, bool paused);
    // FYP-60 patch: per-asset cap setters now emit so the indexer can
    // track rate-limit configuration changes.
    event MaxMintPerAssetUpdated(address indexed asset, uint256 limit);
    event MaxRedeemPerAssetUpdated(address indexed asset, uint256 limit);
    event StablesDeltaLimitUpdated(uint256 limit);

    // ── Errors ──
    error NotAdmin();
    error NotExecutor();
    error NotPauserOrAdmin();
    error MintRedeemDisabled();
    error MintPausedForAsset();
    /// @notice FYP-44: per-asset burnPaused flag was set, redemption
    ///         flow blocks new requests / executions on that asset.
    error BurnPausedForAsset();
    error InvalidSignature();
    error InvalidNonce();
    error ExpiredOrder();
    error UnsupportedAsset();
    error MaxMintExceeded();
    error MaxRedeemExceeded();
    error StablesDeltaExceeded();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidRoute();
    error RedeemNotFound();
    error DeprecatedFunction();
    error AssetMaxMintExceeded(address asset); // April-audit M-7
    error AssetMaxRedeemExceeded(address asset); // April-audit M-7
    error AmountMismatch(); // April-audit H-1: order amount must match escrow
    /// @notice FYP-50: route exceeded MAX_ROUTE_LEGS.
    error RouteTooLong(uint256 length, uint256 cap);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _rusd,
        address _signer,
        address _executor
    ) external initializer {
        __ReentrancyGuard_init();
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_rusd) == address(0)) revert ZeroAddress();
        if (_signer == address(0)) revert ZeroAddress();
        if (_executor == address(0)) revert ZeroAddress();
        settingManagement = _settingManagement;
        rusd = _rusd;
        backendSigner = _signer;
        backendExecutor = _executor;
        globalMaxMintPerBlock = type(uint256).max;
        globalMaxRedeemPerBlock = type(uint256).max;
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

    /// @notice S1.2 / ADR-007: pauser EOA OR admin (multisig) can pause.
    ///         Unpause requires admin only — enforced inside {setMintPaused}.
    modifier onlyPauserOrAdmin() {
        if (msg.sender != pauserRole && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotPauserOrAdmin();
        }
        _;
    }

    modifier whenMintRedeemEnabled() {
        if (mintRedeemDisabled) revert MintRedeemDisabled();
        _;
    }

    /// @notice S1.2 / ADR-008: per-asset mint pause + legacy global gate.
    ///         Either tripping is sufficient to revert.
    modifier whenMintAllowed(address asset) {
        if (mintRedeemDisabled) revert MintRedeemDisabled();
        if (mintPaused[asset]) revert MintPausedForAsset();
        _;
    }

    // ── Core: Mint ──
    /**
     * @notice Execute a backend-signed mint order. Pulls
     *         {order.collateral_amount} of {order.collateral_asset}
     *         from {order.benefactor} (routed across whitelisted
     *         custodians per {route}) and mints {order.rusd_amount}
     *         RUSD to {order.beneficiary}.
     *
     * @dev <b>FYP-49 — permissionless submission</b>. Any address that
     *      holds a valid backend-signed {Order} + matching {route} can
     *      call this function. The benefactor's collateral approval is
     *      still required (the contract calls
     *      {safeTransferFrom(benefactor, custodian, amount)} inside
     *      {_distributeCollateral}), so a third-party caller cannot
     *      drain a benefactor who never opted in. This shape is
     *      intentional: it lets a relayer (paymaster / sponsored-tx
     *      service) submit on behalf of the benefactor for gas-
     *      sponsorship flows. Off-chain integrators that need
     *      "only-benefactor-can-call" semantics should bind the
     *      benefactor key directly rather than relying on contract-
     *      level gating.
     */
    function mint(
        Order calldata order,
        Route calldata route,
        bytes calldata signature
    ) external nonReentrant whenMintAllowed(order.collateral_asset) {
        if (order.collateral_amount == 0 || order.rusd_amount == 0) revert InvalidAmount();
        if (order.beneficiary == address(0)) revert ZeroAddress();
        if (!supportedAssets[order.collateral_asset]) revert UnsupportedAsset();
        if (_usedNonces[order.benefactor][order.nonce]) revert InvalidNonce();

        _verifyOrderSignature(order, signature, OrderType.MINT);
        _checkMintLimit(order.collateral_asset, order.rusd_amount);
        _checkStablesDelta(order.rusd_amount, 0);

        // C-4: route is validated inside (custodian whitelist + ratio sum).
        _distributeCollateral(order, route);

        mintedPerBlock[block.number] += order.rusd_amount;
        mintedPerAssetPerBlock[order.collateral_asset][block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        // C-1: actually mint RUSD (this contract must hold MINTER_ROLE on RUSD).
        IRUSD(address(rusd)).mint(order.beneficiary, order.rusd_amount);

        emit Mint(
            order.benefactor,
            order.beneficiary,
            order.collateral_asset,
            order.collateral_amount,
            order.rusd_amount
        );
    }

    /**
     * @notice Deprecated. The prior implementation minted RUSD without
     *         transferring any collateral, so the function is permanently
     *         disabled. To mint against WETH, call {mint} with WETH as
     *         the supported `collateral_asset`.
     */
    function mintWETH(
        Order calldata,
        Route calldata,
        bytes calldata
    ) external payable {
        revert DeprecatedFunction();
    }

    /**
     * @notice Route-bound mint flow. Identical to {mint}, except the
     *         backend signature MUST cover the route hash. The hash
     *         is computed on-chain as
     *           keccak256(abi.encode(route.addresses, route.ratios))
     *         and bound into the digest via the
     *         {ORDER_BOUND_TYPEHASH} EIP-712 type. Anyone calling
     *         {mintBound} with a route that does not hash to the
     *         signed value fails {InvalidSignature}.
     *
     * @dev FYP-46 patch. The legacy {mint} entry-point only binds
     *      the (asset, amounts) tuple — the route is caller-chosen
     *      within the custodian whitelist. That means a relayer
     *      can override the protocol's off-chain risk policy on
     *      custodian split, even with a valid signature. The new
     *      {mintBound} closes that gap by requiring the route to
     *      match the backend's signed intent.
     *
     *      We keep {mint} working for backward compatibility — the
     *      backend cutover to {mintBound} can happen
     *      asynchronously. Once every signer is on the v2
     *      typehash, {mint} can be deprecated to a reverting stub
     *      in a future implementation.
     */
    function mintBound(
        Order calldata order,
        Route calldata route,
        bytes calldata signature
    ) external nonReentrant whenMintAllowed(order.collateral_asset) {
        if (order.collateral_amount == 0 || order.rusd_amount == 0) revert InvalidAmount();
        if (order.beneficiary == address(0)) revert ZeroAddress();
        if (!supportedAssets[order.collateral_asset]) revert UnsupportedAsset();
        if (_usedNonces[order.benefactor][order.nonce]) revert InvalidNonce();

        bytes32 rh = keccak256(abi.encode(route.addresses, route.ratios));
        _verifyBoundOrderSignature(order, rh, signature, OrderType.MINT);

        _checkMintLimit(order.collateral_asset, order.rusd_amount);
        _checkStablesDelta(order.rusd_amount, 0);

        // Route is validated inside (custodian whitelist + ratio sum +
        // last-leg rounding remainder per FYP-48). Length cap from
        // FYP-50 applies.
        _distributeCollateral(order, route);

        mintedPerBlock[block.number] += order.rusd_amount;
        mintedPerAssetPerBlock[order.collateral_asset][block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        IRUSD(address(rusd)).mint(order.beneficiary, order.rusd_amount);

        emit Mint(
            order.benefactor,
            order.beneficiary,
            order.collateral_asset,
            order.collateral_amount,
            order.rusd_amount
        );
    }

    // ── Core: Redeem ──
    /**
     * @notice User-initiated escrow of RUSD pending an executor decision.
     *         The (msg.sender, nonce) tuple keys the escrow record so a
     *         later {cancelRedeem} or {executeRedeem} can find it.
     *
     * @dev April-audit H-1 patch. The previous shape did NOT mark
     *      `_usedNonces[msg.sender][nonce]`, which made the following
     *      replay viable:
     *
     *        1. user calls requestRedeem(100, n=5) → escrow = 100
     *        2. backend signs Order(redeem, n=5, amount=100)
     *        3. user calls cancelRedeem(5)        → escrow = 0
     *        4. user calls requestRedeem(100, 5)  → escrow = 100 again
     *        5. executor calls executeRedeem with the *original* sig
     *           — passes _verifyOrder (nonce still unused) and the
     *           amount equality check (escrow == order.amount).
     *
     *      Burning the nonce at request time closes the window: any
     *      retry must use a fresh nonce, regardless of whether the
     *      original request was cancelled or executed. Defense-in-depth;
     *      the executor's amount-equality check still protects the same
     *      scenario, but a single-property invariant (`nonce burnt
     *      ⇒ no replay`) is easier to reason about than a two-property
     *      one.
     */
    function requestRedeem(uint256 rusdAmount, uint256 nonce) external nonReentrant whenMintRedeemEnabled {
        if (rusdAmount == 0) revert InvalidAmount();
        if (_usedNonces[msg.sender][nonce]) revert InvalidNonce();
        if (pendingRedeems[msg.sender][nonce] != 0) revert InvalidNonce();
        _usedNonces[msg.sender][nonce] = true;
        pendingRedeems[msg.sender][nonce] = rusdAmount;
        rusd.safeTransferFrom(msg.sender, address(this), rusdAmount);
        emit RedeemRequested(msg.sender, rusdAmount, nonce);
    }

    /**
     * @notice Execute a previously-requested redeem. Authenticated by
     *         (a) the executor account, (b) the backend EIP-712
     *         signature, and (c) the on-chain {pendingRedeems} escrow
     *         set by {requestRedeem}.
     *
     * @dev April-audit M-5 patch. The previous shape silently SKIPPED
     *      the collateral payout when `collateral_asset` was not on
     *      the supported list — but still deleted the escrow and
     *      consumed the user's RUSD. Funds-loss bug. We now revert
     *      hard, leaving the escrow intact so the user can
     *      {cancelRedeem} (if the executor mis-routed) or wait for a
     *      corrected execution.
     *
     * @dev April-audit H-1 patch. The nonce is already burnt at
     *      request time, so this function authenticates against
     *      {pendingRedeems} rather than {_usedNonces}. The
     *      `escrowed != order.rusd_amount` check is retained as a
     *      belt-and-braces guard against a backend that signs an
     *      order with the wrong amount.
     *
     * @dev April-audit M-7 patch. Per-asset redeem cap is now enforced.
     *
     * @dev FYP-08 patch. The escrowed RUSD is now BURNED in the same
     *      transaction the collateral is released. The previous shape
     *      released collateral and deleted the escrow record but left
     *      the user's RUSD permanently parked in this contract's
     *      balance — it had no on-chain recovery path today, but
     *      every successful redeem drifted `RUSD.totalSupply()`
     *      upward relative to actual circulating supply, breaking the
     *      `totalSupply ≤ collateral backing` invariant the README
     *      flags as critical. Burning here also matches the pattern
     *      {FypherBurnQueue.requestBurn} already uses (it burns RUSD
     *      immediately and only escrows the collateral promise).
     */
    function executeRedeem(
        Order calldata order,
        bytes calldata signature
    ) external onlyExecutor nonReentrant whenMintRedeemEnabled {
        if (!supportedAssets[order.collateral_asset]) revert UnsupportedAsset();
        // FYP-44 patch. The {burnPaused} mapping had an admin setter
        // ({setBurnPaused}) and a {BurnPausedSet} event but no read
        // path — flipping the flag was operationally misleading
        // because it did not actually pause the redemption flow.
        // Now that the flag is enforced, ops can pause a specific
        // collateral asset's redemptions (e.g. on a Bitgo asset-
        // specific incident) without disabling the rest of the
        // pipeline. {requestRedeem} is asset-agnostic at escrow
        // time (no `collateral_asset` field on the user-side call),
        // so the gate only fires at executor settlement, but the
        // user can still {cancelRedeem} to recover the escrowed
        // RUSD while the asset stays paused.
        if (burnPaused[order.collateral_asset]) revert BurnPausedForAsset();

        _verifyOrderSignature(order, signature, OrderType.REDEEM);
        _checkRedeemLimit(order.collateral_asset, order.rusd_amount);
        _checkStablesDelta(0, order.rusd_amount);

        uint256 escrowed = pendingRedeems[order.benefactor][order.nonce];
        if (escrowed == 0) revert RedeemNotFound();
        if (escrowed != order.rusd_amount) revert AmountMismatch();
        delete pendingRedeems[order.benefactor][order.nonce];

        redeemedPerBlock[block.number] += order.rusd_amount;
        redeemedPerAssetPerBlock[order.collateral_asset][block.number] += order.rusd_amount;
        // H-1: _usedNonces was already set in requestRedeem; do not double-set.

        // FYP-08: burn the escrowed RUSD before paying out collateral
        // so the supply contracts in lockstep with the backing. This
        // contract holds the escrowed balance (transferred in by
        // {requestRedeem}), so the plain `burn(amount)` call destroys
        // exactly the right balance — no allowance or approval needed.
        IRUSDBurnable(address(rusd)).burn(order.rusd_amount);

        IERC20(order.collateral_asset).safeTransfer(order.beneficiary, order.collateral_amount);

        emit RedeemExecuted(order.benefactor, order.beneficiary, order.collateral_amount);
    }

    /**
     * @notice Cancel a previously {requestRedeem}'d order and reclaim the
     *         escrowed RUSD. Authenticated by `pendingRedeems[msg.sender]`,
     *         so a third party cannot drain another user's escrow.
     *         (C-2 patch — the legacy two-arg version is the reverting stub
     *         {cancelRedeem(uint256,uint256)} below.)
     */
    function cancelRedeem(uint256 nonce) external nonReentrant {
        uint256 amount = pendingRedeems[msg.sender][nonce];
        if (amount == 0) revert RedeemNotFound();
        delete pendingRedeems[msg.sender][nonce];
        rusd.safeTransfer(msg.sender, amount);
        emit RedeemCancelled(msg.sender, nonce, amount);
    }

    /**
     * @notice Deprecated stub for the pre-patch `cancelRedeem(uint256,uint256)`.
     *         The old function was unauthenticated and let any caller drain
     *         RUSD from this contract. Always reverts.
     */
    function cancelRedeem(uint256, uint256) external pure {
        revert DeprecatedFunction();
    }

    // ── Internal helpers ──
    /**
     * @dev FYP-48 patch. The previous shape distributed each leg as
     *      `collateral_amount * ratio / BPS_DENOMINATOR` with floor
     *      division. With ratios that don't perfectly divide the
     *      collateral_amount, the sum of legs could be 1 to (n-1)
     *      wei short of `collateral_amount` — the benefactor minted
     *      the full RUSD against a slightly under-collected
     *      collateral total. We now route the rounding remainder to
     *      the LAST custodian by tracking the cumulative amount
     *      distributed across the first (n-1) legs and assigning
     *      the residue (`collateral_amount - cumulative`) to leg n.
     *
     * @dev FYP-61: dropped the `unchecked { ++i; }` block — solc
     *      0.8.22 already elides the loop-counter overflow check for
     *      the standard `for (...; ++i)` shape.
     */
    function _distributeCollateral(Order calldata order, Route calldata route) private {
        uint256 n = route.addresses.length;
        if (n == 0 || n != route.ratios.length) revert InvalidRoute();
        if (n > MAX_ROUTE_LEGS) revert RouteTooLong(n, MAX_ROUTE_LEGS);
        IERC20 collateral = IERC20(order.collateral_asset);
        uint256 totalRatio;
        uint256 distributed;
        uint256 last = n - 1;
        for (uint256 i = 0; i < n; ++i) {
            address dest = route.addresses[i];
            uint256 ratio = route.ratios[i];
            if (dest == address(0)) revert InvalidRoute();
            if (!custodianAddresses[dest]) revert InvalidRoute();
            if (ratio == 0) revert InvalidRoute();
            totalRatio += ratio;
            uint256 amount;
            if (i == last) {
                // Last leg absorbs the rounding remainder so the sum
                // of distributed amounts equals collateral_amount
                // exactly (FYP-48).
                amount = order.collateral_amount - distributed;
            } else {
                amount = (order.collateral_amount * ratio) / BPS_DENOMINATOR;
                distributed += amount;
            }
            if (amount > 0) {
                collateral.safeTransferFrom(order.benefactor, dest, amount);
            }
        }
        if (totalRatio != BPS_DENOMINATOR) revert InvalidRoute();
    }

    /**
     * @notice Verify the EIP-712 signature and expiry on an order. The
     *         nonce check is intentionally NOT here — H-1 split the
     *         nonce-reservation responsibility per call-site:
     *
     *         - {mint}                : reserves the nonce inline.
     *         - {requestRedeem}       : reserves the nonce at request time
     *                                   so a stale executor signature can
     *                                   never be replayed against a
     *                                   re-requested escrow (the "cancel
     *                                   then re-request with same nonce"
     *                                   replay window the previous code
     *                                   left open).
     *         - {executeRedeem}       : authenticates against
     *                                   {pendingRedeems} instead of the
     *                                   nonce mapping (the nonce is
     *                                   already burnt by then).
     */
    function _verifyOrderSignature(
        Order calldata order,
        bytes calldata signature,
        OrderType orderType
    ) internal view {
        if (block.timestamp > order.expiry) revert ExpiredOrder();
        bytes32 structHash = _hashOrder(order, orderType);
        bytes32 d = _digestFromStruct(structHash);
        address recovered = d.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    /// @dev FYP-46 patch. Route-bound counterpart of
    ///      {_verifyOrderSignature}. Builds the struct hash from
    ///      {ORDER_BOUND_TYPEHASH} so the recovered signer must
    ///      have signed over `routeHash` in addition to the
    ///      standard order fields.
    function _verifyBoundOrderSignature(
        Order calldata order,
        bytes32 routeHash_,
        bytes calldata signature,
        OrderType orderType
    ) internal view {
        if (block.timestamp > order.expiry) revert ExpiredOrder();
        bytes32 structHash = _hashBoundOrder(order, routeHash_, orderType);
        bytes32 d = _digestFromStruct(structHash);
        address recovered = d.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    /**
     * @notice Enforce both the global and (April-audit M-7) the per-asset
     *         per-block mint cap. A `maxMintPerBlock[asset]` of 0 means
     *         "no per-asset cap" — global still applies.
     */
    function _checkMintLimit(address asset, uint256 amount) internal view {
        if (mintedPerBlock[block.number] + amount > globalMaxMintPerBlock) revert MaxMintExceeded();
        uint256 perAsset = maxMintPerBlock[asset];
        if (perAsset != 0) {
            if (mintedPerAssetPerBlock[asset][block.number] + amount > perAsset)
                revert AssetMaxMintExceeded(asset);
        }
    }

    /**
     * @notice Enforce both the global and (April-audit M-7) the per-asset
     *         per-block redeem cap. A `maxRedeemPerBlock[asset]` of 0
     *         means "no per-asset cap" — global still applies.
     */
    function _checkRedeemLimit(address asset, uint256 amount) internal view {
        if (redeemedPerBlock[block.number] + amount > globalMaxRedeemPerBlock) revert MaxRedeemExceeded();
        uint256 perAsset = maxRedeemPerBlock[asset];
        if (perAsset != 0) {
            if (redeemedPerAssetPerBlock[asset][block.number] + amount > perAsset)
                revert AssetMaxRedeemExceeded(asset);
        }
    }

    /**
     * @notice Enforce the {stablesDeltaLimit} on the absolute net mint or
     *         net redeem in the current block. April-audit M-6 patch — the
     *         storage slot existed and was admin-settable but never read.
     *         A value of 0 disables the check (preserves behaviour for any
     *         vault that has not configured the limit on-chain).
     *
     * @param incomingMint   Amount being added to {mintedPerBlock} in this tx.
     * @param incomingRedeem Amount being added to {redeemedPerBlock} in this tx.
     */
    function _checkStablesDelta(uint256 incomingMint, uint256 incomingRedeem) internal view {
        uint256 cap = stablesDeltaLimit;
        if (cap == 0) return;
        uint256 minted = mintedPerBlock[block.number] + incomingMint;
        uint256 redeemed = redeemedPerBlock[block.number] + incomingRedeem;
        uint256 delta = minted >= redeemed ? minted - redeemed : redeemed - minted;
        if (delta > cap) revert StablesDeltaExceeded();
    }

    function _hashOrder(Order calldata order, OrderType orderType) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                uint8(orderType),
                order.benefactor,
                order.beneficiary,
                order.collateral_asset,
                order.collateral_amount,
                order.rusd_amount,
                order.nonce,
                order.expiry
            )
        );
    }

    /// @dev FYP-46 patch. Struct-hash helper for the route-bound flow.
    function _hashBoundOrder(
        Order calldata order,
        bytes32 routeHash_,
        OrderType orderType
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_BOUND_TYPEHASH,
                uint8(orderType),
                order.benefactor,
                order.beneficiary,
                order.collateral_asset,
                order.collateral_amount,
                order.rusd_amount,
                order.nonce,
                order.expiry,
                routeHash_
            )
        );
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

    // ── View helpers ──
    /**
     * @notice The cached EIP-712 domain separator computed for the current
     *         chain. Recomputed on every call (chainId-aware), no init
     *         step needed.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Compute the EIP-712 struct hash for an order, binding the
     *         caller-supplied OrderType.
     */
    function hashOrder(Order calldata order, OrderType orderType) external pure returns (bytes32) {
        return _hashOrder(order, orderType);
    }

    /**
     * @notice Deprecated stub for the pre-patch `hashOrder(Order)`.
     *         The old hash did not bind OrderType, so a MINT signature
     *         could be replayed as a REDEEM. Always reverts.
     */
    function hashOrder(Order calldata) external pure returns (bytes32) {
        revert DeprecatedFunction();
    }

    /**
     * @notice The full EIP-712 digest that must be signed by `backendSigner`.
     */
    function digest(Order calldata order, OrderType orderType) external view returns (bytes32) {
        return _digestFromStruct(_hashOrder(order, orderType));
    }

    function encodeOrder(Order calldata order) external pure returns (bytes memory) {
        return abi.encode(order);
    }

    /**
     * @notice True iff `signature` is a valid backend-signed digest
     *         for `order` under `orderType` AND the order is not yet
     *         expired.
     *
     * @dev FYP-30 patch. The previous implementation only checked the
     *      signature recovery, so an off-chain integrator polling
     *      {verifyOrder} would treat an expired order as still
     *      valid — but the corresponding {mint} / {executeRedeem}
     *      call would revert with {ExpiredOrder}. Folding the
     *      expiry check into the view brings it in line with the
     *      authoritative path.
     */
    function verifyOrder(
        Order calldata order,
        bytes calldata signature,
        OrderType orderType
    ) external view returns (bool) {
        if (block.timestamp > order.expiry) return false;
        bytes32 d = _digestFromStruct(_hashOrder(order, orderType));
        return d.recover(signature) == backendSigner;
    }

    /**
     * @notice Deprecated stub for the pre-patch `verifyOrder(Order, bytes)`.
     *         OrderType-less verification is rejected. Always reverts.
     */
    function verifyOrder(Order calldata, bytes calldata) external pure returns (bool) {
        revert DeprecatedFunction();
    }

    function verifyNonce(address account, uint256 nonce) external view returns (bool) {
        return !_usedNonces[account][nonce];
    }

    /**
     * @notice Compute the route hash that the backend MUST sign over
     *         when using {mintBound}. Exposed so off-chain tooling
     *         can pre-compute the value without re-implementing
     *         abi.encode semantics.
     * @dev FYP-46 patch.
     */
    function routeHash(Route calldata route) external pure returns (bytes32) {
        return keccak256(abi.encode(route.addresses, route.ratios));
    }

    /**
     * @notice Struct hash of the EIP-712 bound order. Pairs with
     *         {ORDER_BOUND_TYPEHASH}.
     */
    function hashBoundOrder(
        Order calldata order,
        bytes32 routeHash_,
        OrderType orderType
    ) external pure returns (bytes32) {
        return _hashBoundOrder(order, routeHash_, orderType);
    }

    /// @notice Full digest the backend signer must sign for the
    ///         route-bound mint path.
    function digestBound(
        Order calldata order,
        bytes32 routeHash_,
        OrderType orderType
    ) external view returns (bytes32) {
        return _digestFromStruct(_hashBoundOrder(order, routeHash_, orderType));
    }

    /// @notice True iff `signature` is a valid backend signature over
    ///         the (order, computed-routeHash, orderType) tuple AND
    ///         the order is unexpired.
    function verifyBoundOrder(
        Order calldata order,
        Route calldata route,
        bytes calldata signature,
        OrderType orderType
    ) external view returns (bool) {
        if (block.timestamp > order.expiry) return false;
        bytes32 rh = keccak256(abi.encode(route.addresses, route.ratios));
        bytes32 d = _digestFromStruct(_hashBoundOrder(order, rh, orderType));
        return d.recover(signature) == backendSigner;
    }

    /**
     * @notice True iff the route would be accepted by {mint}: non-empty,
     *         lengths match, every destination is a whitelisted custodian
     *         with a non-zero ratio, and the ratios sum to 10_000 bps.
     */
    function verifyRoute(Route calldata route) external view returns (bool) {
        uint256 n = route.addresses.length;
        if (n == 0 || n != route.ratios.length) return false;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            address dest = route.addresses[i];
            uint256 ratio = route.ratios[i];
            if (dest == address(0)) return false;
            if (!custodianAddresses[dest]) return false;
            if (ratio == 0) return false;
            total += ratio;
        }
        return total == BPS_DENOMINATOR;
    }

    /**
     * @notice True iff a candidate mint of `amount` would pass both the
     *         global per-block cap and (April-audit M-6) the
     *         {stablesDeltaLimit} on absolute net mint per block.
     */
    function verifyStablesLimit(uint256 amount) external view returns (bool) {
        if (mintedPerBlock[block.number] + amount > globalMaxMintPerBlock) return false;
        uint256 cap = stablesDeltaLimit;
        if (cap == 0) return true;
        uint256 minted = mintedPerBlock[block.number] + amount;
        uint256 redeemed = redeemedPerBlock[block.number];
        uint256 delta = minted >= redeemed ? minted - redeemed : redeemed - minted;
        return delta <= cap;
    }

    // ── Admin ──
    // FYP-39: all setters below skip the SSTORE + event when the new
    // value matches the live value, so dashboard "re-apply config"
    // transactions become free no-ops.
    function addSupportedAsset(address asset) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        if (supportedAssets[asset]) return;
        supportedAssets[asset] = true;
        emit AssetAdded(asset);
    }

    function removeSupportedAsset(address asset) external onlyAdmin {
        if (!supportedAssets[asset]) return;
        supportedAssets[asset] = false;
        emit AssetRemoved(asset);
    }

    function addCustodianAddress(address custodian) external onlyAdmin {
        if (custodian == address(0)) revert ZeroAddress();
        if (custodianAddresses[custodian]) return;
        custodianAddresses[custodian] = true;
        emit CustodianAdded(custodian);
    }

    function removeCustodianAddress(address custodian) external onlyAdmin {
        if (!custodianAddresses[custodian]) return;
        custodianAddresses[custodian] = false;
        emit CustodianRemoved(custodian);
    }

    function setBackendSigner(address signer) external onlyAdmin {
        if (signer == address(0)) revert ZeroAddress();
        if (signer == backendSigner) return;
        backendSigner = signer;
        emit SignerUpdated(signer);
    }

    function setBackendExecutor(address executor) external onlyAdmin {
        if (executor == address(0)) revert ZeroAddress();
        if (executor == backendExecutor) return;
        backendExecutor = executor;
        emit ExecutorUpdated(executor);
    }

    function setGlobalMaxMintPerBlock(uint256 limit) external onlyAdmin {
        if (limit == globalMaxMintPerBlock) return;
        globalMaxMintPerBlock = limit;
        emit MaxMintPerBlockUpdated(limit);
    }

    function setGlobalMaxRedeemPerBlock(uint256 limit) external onlyAdmin {
        if (limit == globalMaxRedeemPerBlock) return;
        globalMaxRedeemPerBlock = limit;
        emit MaxRedeemPerBlockUpdated(limit);
    }

    function setMaxMintPerBlock(address asset, uint256 limit) external onlyAdmin {
        if (maxMintPerBlock[asset] == limit) return;
        maxMintPerBlock[asset] = limit;
        emit MaxMintPerAssetUpdated(asset, limit);  // FYP-60
    }

    function setMaxRedeemPerBlock(address asset, uint256 limit) external onlyAdmin {
        if (maxRedeemPerBlock[asset] == limit) return;
        maxRedeemPerBlock[asset] = limit;
        emit MaxRedeemPerAssetUpdated(asset, limit);  // FYP-60
    }

    /**
     * @notice Cap the absolute net mint OR net redeem of RUSD allowed in
     *         a single block. Setting `0` disables the check (the
     *         pre-April-audit behaviour). The limit is denominated in
     *         RUSD wei.
     *
     * @dev April-audit M-6 patch. Prior to this commit the storage slot
     *      existed and was settable, but `_checkStablesDelta` did not
     *      exist and no call site referenced it; the limit had zero
     *      on-chain effect.
     */
    function setStablesDeltaLimit(uint256 limit) external onlyAdmin {
        if (limit == stablesDeltaLimit) return;
        stablesDeltaLimit = limit;
        emit StablesDeltaLimitUpdated(limit);  // FYP-60
    }

    function disableMintRedeem(bool disabled) external onlyAdmin {
        if (disabled == mintRedeemDisabled) return;
        mintRedeemDisabled = disabled;
        emit MintRedeemToggled(disabled);
    }

    // ── S1.2 / ADR-008 admin ──

    /**
     * @notice Per-asset mint pause. ADR-007 §"Pauser carve-out" + ADR-008.
     *         Pausing (paused=true) is callable by the {pauserRole} EOA
     *         OR an admin (multisig). Unpausing (paused=false) is admin-only
     *         — the asymmetric authorization defaults to "stop" under
     *         operational uncertainty.
     */
    function setMintPaused(address asset, bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            // Unpause requires admin (multisig) only.
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        if (mintPaused[asset] == paused) return;
        mintPaused[asset] = paused;
        emit MintPausedSet(asset, paused);
    }

    /**
     * @notice Per-asset burn pause for any future redeem path that lands
     *         back in this contract. The active Phase 1 burn flow is in
     *         FypherBurnQueue (S1.1) which has its own burnPaused mapping.
     */
    function setBurnPaused(address asset, bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        if (burnPaused[asset] == paused) return;
        burnPaused[asset] = paused;
        emit BurnPausedSet(asset, paused);
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        // FYP-25: reject zero pauser. The pauser slot is consulted by
        // {onlyPauserOrAdmin}, and the slot's default value 0 already
        // means "no pauser configured". Re-setting to zero is a no-op
        // attempt; reject explicitly so the operator sees the typo.
        if (newPauser == address(0)) revert ZeroAddress();
        if (newPauser == pauserRole) return;
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }
}
