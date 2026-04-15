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
 *         Off-chain signed orders are verified on-chain using ECDSA.
 *
 * @dev Deployed at: 0x5b6E2A51bc884A6015899a3c673a615816971336
 *      Implementation: 0x4870c0633a9214f76176ff86a72daed528fba714
 *      107 ABI entries: 42 functions, 25 events, 39 errors
 */
contract FypherMinting is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Types ──
    struct Order {
        address benefactor;      // who provides collateral
        address beneficiary;     // who receives RUSD
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

    // ── Storage ──
    ISettingManagement public settingManagement;
    IERC20 public rusd;

    address public backendSigner;
    address public backendExecutor;

    mapping(address => bool) public supportedAssets;
    mapping(address => bool) public custodianAddresses;
    mapping(address => mapping(uint256 => bool)) private _usedNonces;

    uint256 public globalMaxMintPerBlock;
    uint256 public globalMaxRedeemPerBlock;
    mapping(address => uint256) public maxMintPerBlock;
    mapping(address => uint256) public maxRedeemPerBlock;

    mapping(uint256 => uint256) public mintedPerBlock;   // blockNumber => amount
    mapping(uint256 => uint256) public redeemedPerBlock;  // blockNumber => amount

    uint256 public stablesDeltaLimit;  // basis points
    bool public mintRedeemDisabled;

    // ── Events ──
    event Mint(address indexed benefactor, address indexed beneficiary, address collateral, uint256 collateralAmount, uint256 rusdAmount);
    event Redeem(address indexed benefactor, address indexed beneficiary, address collateral, uint256 collateralAmount, uint256 rusdAmount);
    event RedeemRequested(address indexed user, uint256 rusdAmount, uint256 nonce);
    event RedeemExecuted(address indexed user, address indexed beneficiary, uint256 collateralAmount);
    event RedeemCancelled(address indexed user, uint256 nonce);
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
        settingManagement = _settingManagement;
        rusd = _rusd;
        backendSigner = _signer;
        backendExecutor = _executor;
        globalMaxMintPerBlock = type(uint256).max;
        globalMaxRedeemPerBlock = type(uint256).max;
    }

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
        _verifyOrder(order, signature);
        if (!supportedAssets[order.collateral_asset]) revert UnsupportedAsset();
        _checkMintLimit(order.rusd_amount);

        // Transfer collateral from benefactor to custodian addresses via route
        IERC20 collateral = IERC20(order.collateral_asset);
        for (uint256 i = 0; i < route.addresses.length; i++) {
            uint256 amount = (order.collateral_amount * route.ratios[i]) / 10000;
            collateral.safeTransferFrom(order.benefactor, route.addresses[i], amount);
        }

        // Mint RUSD to beneficiary
        IRUSD(address(rusd)).mint(order.beneficiary, order.rusd_amount);

        mintedPerBlock[block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        emit Mint(order.benefactor, order.beneficiary, order.collateral_asset, order.collateral_amount, order.rusd_amount);
    }

    // ── Core: Mint with WETH (native) ──
    function mintWETH(
        Order calldata order,
        Route calldata route,
        bytes calldata signature
    ) external payable nonReentrant whenMintRedeemEnabled {
        _verifyOrder(order, signature);
        _checkMintLimit(order.rusd_amount);

        // Mint RUSD to beneficiary
        IRUSD(address(rusd)).mint(order.beneficiary, order.rusd_amount);

        mintedPerBlock[block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        emit Mint(order.benefactor, order.beneficiary, order.collateral_asset, order.collateral_amount, order.rusd_amount);
    }

    // ── Core: Redeem ──
    function requestRedeem(uint256 rusdAmount, uint256 nonce) external nonReentrant whenMintRedeemEnabled {
        if (rusdAmount == 0) revert InvalidAmount();
        rusd.safeTransferFrom(msg.sender, address(this), rusdAmount);
        emit RedeemRequested(msg.sender, rusdAmount, nonce);
    }

    function executeRedeem(
        Order calldata order,
        bytes calldata signature
    ) external onlyExecutor nonReentrant whenMintRedeemEnabled {
        _verifyOrder(order, signature);
        _checkRedeemLimit(order.rusd_amount);

        redeemedPerBlock[block.number] += order.rusd_amount;
        _usedNonces[order.benefactor][order.nonce] = true;

        // Transfer collateral to beneficiary
        if (supportedAssets[order.collateral_asset]) {
            IERC20(order.collateral_asset).safeTransfer(order.beneficiary, order.collateral_amount);
        }

        emit RedeemExecuted(order.benefactor, order.beneficiary, order.collateral_amount);
    }

    function cancelRedeem(uint256 rusdAmount, uint256 nonce) external nonReentrant {
        rusd.safeTransfer(msg.sender, rusdAmount);
        emit RedeemCancelled(msg.sender, nonce);
    }

    // ── Verification ──
    function _verifyOrder(Order calldata order, bytes calldata signature) internal view {
        if (block.timestamp > order.expiry) revert ExpiredOrder();
        if (_usedNonces[order.benefactor][order.nonce]) revert InvalidNonce();

        bytes32 orderHash = hashOrder(order);
        bytes32 ethSignedHash = orderHash.toEthSignedMessageHash();
        address recovered = ethSignedHash.recover(signature);
        if (recovered != backendSigner) revert InvalidSignature();
    }

    function _checkMintLimit(uint256 amount) internal view {
        if (mintedPerBlock[block.number] + amount > globalMaxMintPerBlock) revert MaxMintExceeded();
    }

    function _checkRedeemLimit(uint256 amount) internal view {
        if (redeemedPerBlock[block.number] + amount > globalMaxRedeemPerBlock) revert MaxRedeemExceeded();
    }

    // ── View helpers ──
    function hashOrder(Order calldata order) public pure returns (bytes32) {
        return keccak256(abi.encode(
            order.benefactor,
            order.beneficiary,
            order.collateral_asset,
            order.collateral_amount,
            order.rusd_amount,
            order.nonce,
            order.expiry
        ));
    }

    function encodeOrder(Order calldata order) public pure returns (bytes memory) {
        return abi.encode(order);
    }

    function verifyOrder(Order calldata order, bytes calldata signature) external view returns (bool) {
        bytes32 ethSignedHash = hashOrder(order).toEthSignedMessageHash();
        return ethSignedHash.recover(signature) == backendSigner;
    }

    function verifyNonce(address account, uint256 nonce) external view returns (bool) {
        return !_usedNonces[account][nonce];
    }

    function verifyRoute(Route calldata route) external pure returns (bool) {
        uint256 total = 0;
        for (uint256 i = 0; i < route.ratios.length; i++) {
            total += route.ratios[i];
        }
        return total == 10000;
    }

    function verifyStablesLimit(uint256 amount) external view returns (bool) {
        return mintedPerBlock[block.number] + amount <= globalMaxMintPerBlock;
    }

    // ── Admin ──
    function addSupportedAsset(address asset) external onlyAdmin {
        supportedAssets[asset] = true;
        emit AssetAdded(asset);
    }

    function removeSupportedAsset(address asset) external onlyAdmin {
        supportedAssets[asset] = false;
        emit AssetRemoved(asset);
    }

    function addCustodianAddress(address custodian) external onlyAdmin {
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
