// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
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

/// @dev Optional admin-extension on {IConcreteAdapter}. ConcreteAdapterV1
///      implements all three; legacy mock adapters may not. See
///      {FyusdYieldVault} for the same interface — kept duplicated to
///      avoid cross-contract imports. Only consumed by admin-gated
///      entry-points, so a mock that lacks one simply reverts that call.
interface IConcreteAdapterAdmin {
    function sweepConcreteShares(address to) external returns (uint256 amount);
    /// @notice FYP-41: ledger-independent close-out (residual shares AND
    ///         residual assets) for clean adapter rotation.
    function recoverAll(address to) external returns (uint256 assetsOut);
    /// @notice FYP-75: admin-gated arbitrary-ERC20 rescue. Reverts on the
    ///         tracked Concrete vault share token.
    function rescueToken(address token, address to, uint256 amount) external;
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
    /// @notice FYP-41 (residual): vault still has vRUSD shares outstanding.
    error VaultNotEmpty(uint256 supply);
    /// @notice FYP-41 (residual): old adapter still holds a non-zero asset
    ///         position; close it out via {closeAdapterPosition} first.
    error AdapterStillHoldsAssets(uint256 assets);
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();
    error AdminMismatch(address admin_);
    /// @notice FYP-43: ready cooldown must be unstaked first.
    error ExistingCooldownReady();

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

    /// @dev <b>FYP-57</b>. See {FyusdYieldVault.totalAssets} — direct
    ///      transfers of the underlying to this vault are NOT
    ///      reflected in totalAssets and will be stuck.
    function totalAssets() public view override returns (uint256) {
        return adapter.totalAssets();
    }

    /// @dev FYP-55 patch. See {FyusdYieldVault._deposit} for the
    ///      allowance-reset rationale.
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
        rusd.forceApprove(address(adapter), 0);
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

    /// @dev FYP-34 patch. See {FyusdYieldVault.maxWithdraw}.
    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }
    function previewWithdraw(uint256) public pure override returns (uint256) { return 0; }
    function previewRedeem(uint256) public pure override returns (uint256) { return 0; }

    /// @notice FYP-34: advertise deposit/mint capacity consistently with the
    ///         {whenNotPaused} guard on {deposit} / {mint}. Returns 0 while
    ///         the vault is paused. (vRUSD has no receiver-restriction gate,
    ///         so pause is the only deposit-side constraint.)
    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }
    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
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
    /// @dev FYP-34 patch. See {FyusdYieldVault.cooldownAssets}.
    function cooldownAssets(uint256 assets) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = _convertToShares(assets, Math.Rounding.Ceil);
        _exitToCooldown(msg.sender, assets, shares);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        _exitToCooldown(msg.sender, assets, shares);
    }

    /// @dev FYP-41 patch. See {FyusdYieldVault._exitToCooldown} for
    ///      the cross-vault rationale on switching to asset-based
    ///      adapter withdraw.
    function _exitToCooldown(address user, uint256 assets, uint256 shares) internal {
        _burn(user, shares);
        // FYP-74: trust the vault's own measured balance delta over the
        // adapter's self-reported return value, so a short/misbehaving adapter
        // cannot over-report what it actually delivered to the vault.
        IERC20 underlying = IERC20(asset());
        uint256 balBefore = underlying.balanceOf(address(this));
        adapter.withdraw(assets);
        uint256 received = underlying.balanceOf(address(this)) - balBefore;
        if (received < assets) revert AdapterReturnedShort(assets, received);

        underlying.safeTransfer(address(silo), received);
        _accrueCooldown(user, received);
    }

    function _accrueCooldown(address user, uint256 assets) internal {
        UserCooldown storage cd = cooldowns[user];
        // FYP-43 patch. See {StakedRUSD._accrueCooldown}.
        if (cd.underlyingAmount > 0 && block.timestamp >= cd.cooldownEnd) {
            revert ExistingCooldownReady();
        }

        uint256 cooldownDuration = settingManagement.getPoolConfigs(COOLDOWN_CONFIG_KEY);
        if (cooldownDuration == 0) cooldownDuration = DEFAULT_COOLDOWN;

        uint256 newEnd = block.timestamp + cooldownDuration;

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
    /**
     * @dev FYP-09 patch + FYP-41 residual patch. See
     *      {FyusdYieldVault.setAdapter} for the full cross-vault
     *      rationale. Rotation is keyed off the vault's own ERC-4626
     *      supply (`totalSupply() == 0`) and an ASSET-denominated residual
     *      check — never the adapter's internal share ledger, which rounds
     *      differently and can drift (CertiK FYP-41 cases 1 & 2). Any
     *      rounding-dust position in the old adapter is cleared first via
     *      {closeAdapterPosition}.
     */
    function setAdapter(IConcreteAdapter newAdapter) external onlyAdmin {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        if (newAdapter.asset() != asset()) {
            revert AdapterAssetMismatch(asset(), newAdapter.asset());
        }
        if (totalSupply() != 0) revert VaultNotEmpty(totalSupply());
        uint256 residual = adapter.totalAssets();
        if (residual != 0) revert AdapterStillHoldsAssets(residual);
        emit AdapterUpdated(address(adapter), address(newAdapter));
        adapter = newAdapter;
    }

    /// @notice FYP-41 (residual) — close out the current adapter's entire
    ///         accounted position once the vault is wound down
    ///         (`totalSupply() == 0`), delivering residual underlying to
    ///         {to}. Asset-based and ledger-independent: clears both
    ///         residual adapter-shares and residual assets so {setAdapter}
    ///         can rotate cleanly. See {FyusdYieldVault.closeAdapterPosition}.
    function closeAdapterPosition(address to) external onlyAdmin returns (uint256 recovered) {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() != 0) revert VaultNotEmpty(totalSupply());
        return IConcreteAdapterAdmin(address(adapter)).recoverAll(to);
    }

    /// @notice Admin recovery hatch for Concrete shares parked on the
    ///         adapter outside of the deposit path. See
    ///         {FyusdYieldVault.sweepAdapterConcreteShares} for design.
    function sweepAdapterConcreteShares(address to) external onlyAdmin returns (uint256 swept) {
        if (to == address(0)) revert ZeroAddress();
        return IConcreteAdapterAdmin(address(adapter)).sweepConcreteShares(to);
    }

    /// @notice FYP-75 — admin recovery of arbitrary ERC-20 tokens
    ///         accidentally sent to the bound adapter. The adapter reverts
    ///         on the tracked Concrete vault share token. See
    ///         {FyusdYieldVault.rescueAdapterToken}.
    function rescueAdapterToken(address token, address to, uint256 amount) external onlyAdmin {
        IConcreteAdapterAdmin(address(adapter)).rescueToken(token, to, amount);
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        // FYP-25: reject zero pauser.
        if (newPauser == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newPauser == pauserRole) return;
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
    /// @dev FYP-41: dashboard-only. The vault's ERC-4626 supply is the sole
    ///      source of share accounting; the adapter's internal ledger can
    ///      drift from it by rounding dust and is NOT used for any exit or
    ///      rotation decision (see {setAdapter} / {closeAdapterPosition}).
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
