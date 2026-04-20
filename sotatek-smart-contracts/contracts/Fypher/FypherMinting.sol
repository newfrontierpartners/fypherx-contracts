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
 *      Storage layout is append-only: a single new mapping
 *      `pendingRedeems` is added at the end. All pre-existing slots
 *      (0..14) are untouched, so the existing TransparentProxy can be
 *      upgraded to this implementation without a storage collision.
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

    bytes32 public constant ORDER_TYPEHASH =
        keccak256(
            "Order(uint8 orderType,address benefactor,address beneficiary,address collateral_asset,uint256 collateral_amount,uint256 rusd_amount,uint256 nonce,uint256 expiry)"
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
    bool public mintRedeemDisabled;                                         // slot 14

    // ── Storage append (April P0 patch) ──
    /**
     * @notice (user, nonce) => RUSD escrow held by this contract waiting on
     *         an executor's `executeRedeem` decision (or the user's
     *         `cancelRedeem`). 0 means "no pending request".
     */
    mapping(address => mapping(uint256 => uint256)) public pendingRedeems;   // slot 15

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

    // ── Errors ──
    error NotAdmin();
    error NotExecutor();
    error MintRedeemDisabled();
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

    modifier whenMintRedeemEnabled() {
        if (mintRedeemDisabled) revert MintRedeemDisabled();
        _;
    }

    // ── Core: Mint ──
    function mint(
        Order calldata order,
        Route calldata route,
        bytes calldata signature
    ) external nonReentrant whenMintRedeemEnabled {
        if (order.collateral_amount == 0 || order.rusd_amount == 0) revert InvalidAmount();
        if (order.beneficiary == address(0)) revert ZeroAddress();
        if (!supportedAssets[order.collateral_asset]) revert UnsupportedAsset();

        _verifyOrder(order, signature, OrderType.MINT);
        _checkMintLimit(order.rusd_amount);

        // C-4: route is validated inside (custodian whitelist + ratio sum).
        _distributeCollateral(order, route);

        mintedPerBlock[block.number] += order.rusd_amount;
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

    // ── Core: Redeem ──
    /**
     * @notice User-initiated escrow of RUSD pending an executor decision.
     *         The (msg.sender, nonce) tuple keys the escrow record so a
     *         later {cancelRedeem} or {executeRedeem} can find it.
     */
    function requestRedeem(uint256 rusdAmount, uint256 nonce) external nonReentrant whenMintRedeemEnabled {
        if (rusdAmount == 0) revert InvalidAmount();
        if (_usedNonces[msg.sender][nonce]) revert InvalidNonce();
        if (pendingRedeems[msg.sender][nonce] != 0) revert InvalidNonce();
        pendingRedeems[msg.sender][nonce] = rusdAmount;
        rusd.safeTransferFrom(msg.sender, address(this), rusdAmount);
        emit RedeemRequested(msg.sender, rusdAmount, nonce);
    }

    function executeRedeem(
        Order calldata order,
        bytes calldata signature
    ) external onlyExecutor nonReentrant whenMintRedeemEnabled {
        _verifyOrder(order, signature, OrderType.REDEEM);
        _checkRedeemLimit(order.rusd_amount);

        // The executor cannot execute a redeem the user did not first
        // request, and the order's rusd_amount must match the escrow.
        uint256 escrowed = pendingRedeems[order.benefactor][order.nonce];
        if (escrowed == 0 || escrowed != order.rusd_amount) revert RedeemNotFound();
        delete pendingRedeems[order.benefactor][order.nonce];

        redeemedPerBlock[block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        if (supportedAssets[order.collateral_asset]) {
            IERC20(order.collateral_asset).safeTransfer(order.beneficiary, order.collateral_amount);
        }

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
    function _distributeCollateral(Order calldata order, Route calldata route) private {
        uint256 n = route.addresses.length;
        if (n == 0 || n != route.ratios.length) revert InvalidRoute();
        IERC20 collateral = IERC20(order.collateral_asset);
        uint256 totalRatio;
        for (uint256 i = 0; i < n; ) {
            address dest = route.addresses[i];
            uint256 ratio = route.ratios[i];
            if (dest == address(0)) revert InvalidRoute();
            if (!custodianAddresses[dest]) revert InvalidRoute();
            if (ratio == 0) revert InvalidRoute();
            totalRatio += ratio;
            uint256 amount = (order.collateral_amount * ratio) / BPS_DENOMINATOR;
            if (amount > 0) {
                collateral.safeTransferFrom(order.benefactor, dest, amount);
            }
            unchecked { ++i; }
        }
        if (totalRatio != BPS_DENOMINATOR) revert InvalidRoute();
    }

    function _verifyOrder(
        Order calldata order,
        bytes calldata signature,
        OrderType orderType
    ) internal view {
        if (block.timestamp > order.expiry) revert ExpiredOrder();
        if (_usedNonces[order.benefactor][order.nonce]) revert InvalidNonce();

        bytes32 structHash = _hashOrder(order, orderType);
        bytes32 d = _digestFromStruct(structHash);
        address recovered = d.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    function _checkMintLimit(uint256 amount) internal view {
        if (mintedPerBlock[block.number] + amount > globalMaxMintPerBlock) revert MaxMintExceeded();
    }

    function _checkRedeemLimit(uint256 amount) internal view {
        if (redeemedPerBlock[block.number] + amount > globalMaxRedeemPerBlock) revert MaxRedeemExceeded();
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

    function verifyOrder(
        Order calldata order,
        bytes calldata signature,
        OrderType orderType
    ) external view returns (bool) {
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

    function verifyStablesLimit(uint256 amount) external view returns (bool) {
        return mintedPerBlock[block.number] + amount <= globalMaxMintPerBlock;
    }

    // ── Admin ──
    function addSupportedAsset(address asset) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        supportedAssets[asset] = true;
        emit AssetAdded(asset);
    }

    function removeSupportedAsset(address asset) external onlyAdmin {
        supportedAssets[asset] = false;
        emit AssetRemoved(asset);
    }

    function addCustodianAddress(address custodian) external onlyAdmin {
        if (custodian == address(0)) revert ZeroAddress();
        custodianAddresses[custodian] = true;
        emit CustodianAdded(custodian);
    }

    function removeCustodianAddress(address custodian) external onlyAdmin {
        custodianAddresses[custodian] = false;
        emit CustodianRemoved(custodian);
    }

    function setBackendSigner(address signer) external onlyAdmin {
        if (signer == address(0)) revert ZeroAddress();
        backendSigner = signer;
        emit SignerUpdated(signer);
    }

    function setBackendExecutor(address executor) external onlyAdmin {
        if (executor == address(0)) revert ZeroAddress();
        backendExecutor = executor;
        emit ExecutorUpdated(executor);
    }

    function setGlobalMaxMintPerBlock(uint256 limit) external onlyAdmin {
        globalMaxMintPerBlock = limit;
        emit MaxMintPerBlockUpdated(limit);
    }

    function setGlobalMaxRedeemPerBlock(uint256 limit) external onlyAdmin {
        globalMaxRedeemPerBlock = limit;
        emit MaxRedeemPerBlockUpdated(limit);
    }

    function setMaxMintPerBlock(address asset, uint256 limit) external onlyAdmin {
        maxMintPerBlock[asset] = limit;
    }

    function setMaxRedeemPerBlock(address asset, uint256 limit) external onlyAdmin {
        maxRedeemPerBlock[asset] = limit;
    }

    function setStablesDeltaLimit(uint256 limit) external onlyAdmin {
        stablesDeltaLimit = limit;
    }

    function disableMintRedeem(bool disabled) external onlyAdmin {
        mintRedeemDisabled = disabled;
        emit MintRedeemToggled(disabled);
    }
}
