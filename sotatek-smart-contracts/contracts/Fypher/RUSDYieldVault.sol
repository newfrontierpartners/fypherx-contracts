// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStakedRUSDCooldown.sol";
import "../interfaces/ISettingManagement.sol";
import "./IConcreteAdapter.sol";
import "./RUSDSilo.sol";

interface IRUSDPermit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title RUSDYieldVault (vRUSD)
 * @notice ERC4626 receipt-token vault for the Concrete-backed RUSD yield
 *         strategy. Mirror of {FyusdYieldVault} for the RUSD asset; same
 *         share-NAV mechanics, same cooldown pattern, same adapter
 *         interface — only the underlying token and the cooldown config
 *         key differ.
 *
 *         Cooldown duration is read live from {settingManagement} under
 *         the key `"vRusdCooldown"` so ops can tune it (default 14 days)
 *         without redeploying.
 *
 * @dev See {FyusdYieldVault} for the full design rationale. The two
 *      contracts are kept as separate codebases (rather than a generic
 *      base) because the audit firm prefers a flat, copy-paste-explicit
 *      file per asset over inheritance graphs.
 */
contract RUSDYieldVault is
    Initializable,
    ERC4626Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    ReentrancyGuardUpgradeable,
    IStakedRUSDCooldown
{
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 public constant SETTING_MANAGER_TIMELOCK = 2 days;
    uint256 public constant DEFAULT_COOLDOWN = 14 days;
    /// @notice SettingManagement pool-config key for this vault's cooldown.
    string  public constant COOLDOWN_CONFIG_KEY = "vRusdCooldown";

    // ── Storage ──
    ISettingManagement public settingManagement;
    IConcreteAdapter   public adapter;
    RUSDSilo           public silo;
    address            public pauserRole;

    mapping(address => UserCooldown) public cooldowns;

    ISettingManagement public pendingSettingManagement;
    uint256            public pendingSettingManagerEta;

    // ── Events ──
    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event CooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    event SettingManagerUpdated(address indexed newManager);
    event SettingManagerProposed(address indexed newManager, uint256 eta);
    event SettingManagerProposalCancelled(address indexed cancelledManager);

    // ── Errors ──
    error NotAdmin();
    error NotPauserOrAdmin();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error ZeroAddress();
    error AdapterAssetMismatch(address vault, address adapter);
    error AdapterReturnedShort(uint256 expected, uint256 received);
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();
    error AdminMismatch(address admin_);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _rusd,
        IConcreteAdapter _adapter,
        address admin_
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_rusd) == address(0)) revert ZeroAddress();
        if (address(_adapter) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (_adapter.asset() != address(_rusd)) {
            revert AdapterAssetMismatch(address(_rusd), _adapter.asset());
        }
        if (!_settingManagement.hasRole(bytes32(0), admin_)) revert AdminMismatch(admin_);

        __ERC20_init("Vault RUSD", "vRUSD");
        __ERC4626_init(_rusd);
        __ERC20Pausable_init();
        __ERC20Permit_init("Vault RUSD");
        __ReentrancyGuard_init();

        settingManagement = _settingManagement;
        adapter = _adapter;
        silo = new RUSDSilo(address(this), _rusd);
    }

    // ── Modifiers ──
    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (msg.sender != pauserRole && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotPauserOrAdmin();
        }
        _;
    }

    // ── ERC4626 overrides ──

    function totalAssets() public view override returns (uint256) {
        return adapter.totalAssets();
    }

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        IERC20 rusd = IERC20(asset());
        rusd.safeTransferFrom(caller, address(this), assets);
        rusd.forceApprove(address(adapter), assets);
        adapter.deposit(assets);
        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address /* caller */,
        address /* receiver */,
        address /* owner */,
        uint256 /* assets */,
        uint256 /* shares */
    ) internal pure override {
        revert("vRUSD: use cooldown flow");
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (shares == 0) revert ZeroAmount();
        return super.mint(shares, receiver);
    }

    function depositWithPermit(
        uint256 assets,
        address receiver,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        try IRUSDPermit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return super.deposit(assets, receiver);
    }

    // ── Cooldown ──
    function cooldownAssets(uint256 assets) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _exitToCooldown(msg.sender, assets, shares);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _exitToCooldown(msg.sender, assets, shares);
    }

    function _exitToCooldown(address user, uint256 assets, uint256 shares) internal {
        _burn(user, shares);
        uint256 received = adapter.withdraw(shares);
        if (received < assets) revert AdapterReturnedShort(assets, received);

        IERC20(asset()).safeTransfer(address(silo), received);
        _accrueCooldown(user, received);
    }

    function _accrueCooldown(address user, uint256 assets) internal {
        uint256 cooldownDuration = settingManagement.getPoolConfigs(COOLDOWN_CONFIG_KEY);
        if (cooldownDuration == 0) cooldownDuration = DEFAULT_COOLDOWN;

        uint256 newEnd = block.timestamp + cooldownDuration;

        UserCooldown storage cd = cooldowns[user];
        uint256 newAmount = uint256(cd.underlyingAmount) + assets;
        require(newAmount <= type(uint152).max, "Cooldown overflow");
        cd.underlyingAmount = uint152(newAmount);
        if (newEnd > cd.cooldownEnd) {
            require(newEnd <= type(uint104).max, "Cooldown end overflow");
            cd.cooldownEnd = uint104(newEnd);
        }
        emit CooldownStarted(user, newAmount, cd.cooldownEnd);
    }

    function unstake(address receiver) external override nonReentrant whenNotPaused {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        if (block.timestamp < cd.cooldownEnd) revert CooldownNotFinished();

        uint256 assets = cd.underlyingAmount;
        delete cooldowns[msg.sender];
        silo.withdraw(receiver, assets);

        emit Unstaked(msg.sender, receiver, assets);
    }

    // ── Admin ──
    function setAdapter(IConcreteAdapter newAdapter) external onlyAdmin {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        if (newAdapter.asset() != asset()) {
            revert AdapterAssetMismatch(asset(), newAdapter.asset());
        }
        emit AdapterUpdated(address(adapter), address(newAdapter));
        adapter = newAdapter;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }

    function pause() external onlyPauserOrAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    function rescueTokens(address token, address to, uint256 amount) external onlyAdmin {
        require(token != asset(), "Cannot rescue staked asset");
        IERC20(token).safeTransfer(to, amount);
    }

    function proposeSettingManager(address newManager) external onlyAdmin {
        if (newManager == address(0)) {
            address cancelled = address(pendingSettingManagement);
            delete pendingSettingManagement;
            delete pendingSettingManagerEta;
            emit SettingManagerProposalCancelled(cancelled);
            return;
        }
        pendingSettingManagement = ISettingManagement(newManager);
        pendingSettingManagerEta = block.timestamp + SETTING_MANAGER_TIMELOCK;
        emit SettingManagerProposed(newManager, pendingSettingManagerEta);
    }

    function acceptSettingManager() external onlyAdmin {
        if (address(pendingSettingManagement) == address(0)) revert NoPendingManager();
        if (block.timestamp < pendingSettingManagerEta) revert TimelockNotElapsed(pendingSettingManagerEta);
        settingManagement = pendingSettingManagement;
        delete pendingSettingManagement;
        delete pendingSettingManagerEta;
        emit SettingManagerUpdated(address(settingManagement));
    }

    // ── View ──
    function adapterShares() external view returns (uint256) {
        return adapter.shareOf(address(this));
    }

    function realizedYield7dBps() external view returns (uint256) {
        return adapter.realizedYield7d();
    }

    function currentCooldownDuration() external view returns (uint256) {
        uint256 d = settingManagement.getPoolConfigs(COOLDOWN_CONFIG_KEY);
        return d == 0 ? DEFAULT_COOLDOWN : d;
    }

    // ── Internal overrides ──
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }

    function decimals() public view override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }

    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 0;
    }
}
