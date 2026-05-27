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

interface IFYUSDPermit {
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

/// @dev Optional extension on {IConcreteAdapter}. ConcreteAdapterV1
///      implements this; legacy mock adapters may not. Only consumed by
///      {sweepAdapterConcreteShares} which is admin-gated, so a mock
///      that lacks the entry-point simply leaves the sweep call
///      reverting — acceptable for test scaffolds.
interface IConcreteAdapterSweepable {
    function sweepConcreteShares(address to) external returns (uint256 amount);
}

/**
 * @title FyusdYieldVault (vFYUSD)
 * @notice ERC4626 receipt-token vault for the Concrete-backed FYUSD yield
 *         strategy. Users deposit FYUSD, receive `vFYUSD` shares whose
 *         per-share NAV grows as the adapter accrues yield from the
 *         underlying Concrete protocol.
 *
 *         Withdrawal flow uses the same cooldown pattern as the cooldown
 *         staking vaults (StakedRUSD/StakedAUSD/StakedFYP):
 *
 *           1. {cooldownAssets} or {cooldownShares} burns vault shares,
 *              calls `adapter.withdraw` to pull FYUSD back into the vault,
 *              forwards FYUSD to the silo, and starts the cooldown timer.
 *           2. After the configurable cooldown window has elapsed, the
 *              user calls {unstake} to receive the held FYUSD from the
 *              silo.
 *
 *         Cooldown duration is read from {settingManagement} under the
 *         key `"vFyusdCooldown"` so ops can tune it (default 7 days)
 *         without redeploying.
 *
 *         The vault holds NO active FYUSD between calls — every share is
 *         backed by a 1:1 adapter share. Cooldown FYUSD lives in the
 *         silo, not in this contract.
 *
 * @dev Upgradeable (TransparentProxy). Storage layout differs from the
 *      pre-launch implementation; the proxy must be redeployed at alpha
 *      launch (the previous BSC-Testnet proxy is dormant).
 */
contract FyusdYieldVault is
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
    uint256 public constant DEFAULT_COOLDOWN = 7 days;
    /// @notice SettingManagement pool-config key for this vault's cooldown.
    string  public constant COOLDOWN_CONFIG_KEY = "vFyusdCooldown";

    // ── Storage ──
    ISettingManagement public settingManagement;
    IConcreteAdapter   public adapter;
    RUSDSilo           public silo;
    address            public pauserRole;

    mapping(address => UserCooldown) public cooldowns;

    /// @notice Pending replacement for {settingManagement}, awaiting timelock.
    ISettingManagement public pendingSettingManagement;
    /// @notice UNIX timestamp at which the pending replacement may be accepted.
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
    error AdapterStillHoldsShares(uint256 shares);
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();
    error AdminMismatch(address admin_);
    /// @notice FYP-43: user has a ready-to-claim cooldown sitting in
    ///         the silo. Call {unstake} first, then start a fresh
    ///         cooldown — otherwise the existing balance would be
    ///         re-locked under the new cooldownEnd.
    error ExistingCooldownReady();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _fyusd,
        IConcreteAdapter _adapter,
        address admin_
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (address(_adapter) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (_adapter.asset() != address(_fyusd)) {
            revert AdapterAssetMismatch(address(_fyusd), _adapter.asset());
        }
        if (!_settingManagement.hasRole(bytes32(0), admin_)) revert AdminMismatch(admin_);

        __ERC20_init("Vault FYUSD", "vFYUSD");
        __ERC4626_init(_fyusd);
        __ERC20Pausable_init();
        __ERC20Permit_init("Vault FYUSD");
        __ReentrancyGuard_init();

        settingManagement = _settingManagement;
        adapter = _adapter;
        silo = new RUSDSilo(address(this), _fyusd);
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

    /// @notice Total FYUSD backing the vault — always equal to whatever the
    ///         adapter currently controls on our behalf. The vault itself
    ///         does NOT hold active FYUSD; cooldown balances are escrowed
    ///         in the silo and excluded by construction.
    function totalAssets() public view override returns (uint256) {
        return adapter.totalAssets();
    }

    /**
     * @dev On deposit, forward the pulled assets straight to the adapter.
     *      The adapter mints its own shares to this vault 1:1 with the
     *      vToken supply (because both vault.totalSupply and
     *      adapter.shareOf(vault) start from 0 and grow in lockstep with
     *      the same NAV expansion).
     */
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        IERC20 fyusd = IERC20(asset());
        fyusd.safeTransferFrom(caller, address(this), assets);
        fyusd.forceApprove(address(adapter), assets);
        adapter.deposit(assets);
        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);
    }

    /**
     * @dev Direct {withdraw}/{redeem} (instant exit) is intentionally
     *      disabled — every exit path must go through the cooldown
     *      mechanism so the protocol gets the rate-limit benefit. We
     *      block both by routing the OZ ERC4626 entry points through
     *      our overrides, which always revert.
     */
    function _withdraw(
        address /* caller */,
        address /* receiver */,
        address /* owner */,
        uint256 /* assets */,
        uint256 /* shares */
    ) internal pure override {
        revert("vFYUSD: use cooldown flow");
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

    /**
     * @notice Permit-flavoured deposit: lets the user provide an
     *         off-chain ERC-2612 signature so they don't need a separate
     *         {approve} transaction before depositing.
     */
    function depositWithPermit(
        uint256 assets,
        address receiver,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        try IFYUSDPermit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return super.deposit(assets, receiver);
    }

    // ── Cooldown ──
    function cooldownAssets(uint256 assets)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _exitToCooldown(msg.sender, assets, shares);
    }

    function cooldownShares(uint256 shares)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _exitToCooldown(msg.sender, assets, shares);
    }

    /**
     * @dev Burn `shares` from `user`, withdraw the requested FYUSD
     *      amount from the adapter, transfer it to the silo, and add
     *      it to the user's outstanding cooldown bucket.
     *
     * @dev FYP-41 patch. We now call `adapter.withdraw(assets)`
     *      instead of `adapter.withdraw(shares)`. The previous shape
     *      assumed vault-shares and adapter-shares stayed 1:1, but
     *      the OZ ERC4626 inflation-protection math (`+1` / `+offset`
     *      correction) does not guarantee this; the two share
     *      counters could drift by rounding, and passing the vault-
     *      share count to an adapter that interprets it as adapter-
     *      shares burned the wrong number of Concrete shares,
     *      enabling the share-pricing-drain class of bug CertiK's
     *      FYP-41 PoC reproduced. The adapter is now asset-based
     *      (it computes the share burn count internally,
     *      ceil-rounded) so the vault stays the single source of
     *      share accounting.
     *
     *      The adapter MUST return at least `assets` FYUSD. We
     *      verify defensively; a short return signals an adapter
     *      accounting bug or NAV race.
     */
    function _exitToCooldown(address user, uint256 assets, uint256 shares) internal {
        _burn(user, shares);
        uint256 received = adapter.withdraw(assets);
        if (received < assets) revert AdapterReturnedShort(assets, received);

        IERC20(asset()).safeTransfer(address(silo), received);
        _accrueCooldown(user, received);
    }

    function _accrueCooldown(address user, uint256 assets) internal {
        UserCooldown storage cd = cooldowns[user];
        // FYP-43 patch. See {StakedRUSD._accrueCooldown} — reject a
        // new cooldown on top of an already-claimable balance so the
        // user does not accidentally re-lock funds that were ready
        // for {unstake}.
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
     * @dev FYP-09 patch. The previous shape blindly rebound the
     *      adapter, orphaning every asset still parked in the old
     *      adapter (since totalAssets() reads from the new, empty one
     *      and adapter.withdraw on the new adapter has no record of
     *      our shares). The NatSpec referenced an emergencyMigrate
     *      step that never existed.
     *
     *      We now require `oldAdapter.shareOf(this) == 0` before any
     *      rebind — operators must first drain the existing adapter
     *      (e.g. via the standard cooldown flow, an admin-staged
     *      `withdrawAll` helper, or a future emergencyMigrate hook
     *      added in tandem) so the share-state invariant
     *      `totalSupply == adapter.shareOf(vault)` is never broken
     *      across the rebind.
     */
    function setAdapter(IConcreteAdapter newAdapter) external onlyAdmin {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        if (newAdapter.asset() != asset()) {
            revert AdapterAssetMismatch(asset(), newAdapter.asset());
        }
        if (adapter.shareOf(address(this)) != 0) {
            revert AdapterStillHoldsShares(adapter.shareOf(address(this)));
        }
        emit AdapterUpdated(address(adapter), address(newAdapter));
        adapter = newAdapter;
    }

    /**
     * @notice Admin recovery hatch for Concrete shares that landed on
     *         the adapter outside of the deposit path. Forwards the
     *         excess to {to}. Admin-only — we proxy the call through
     *         the vault because ConcreteAdapterV1 binds its
     *         {sweepConcreteShares} entry-point to msg.sender == this
     *         vault.
     */
    function sweepAdapterConcreteShares(address to) external onlyAdmin returns (uint256 swept) {
        if (to == address(0)) revert ZeroAddress();
        return IConcreteAdapterSweepable(address(adapter)).sweepConcreteShares(to);
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

    /// @notice Adapter-recorded share balance held by THIS vault. Should
    ///         track {totalSupply} in lockstep; mismatch indicates a
    ///         migration in flight or an adapter bug.
    function adapterShares() external view returns (uint256) {
        return adapter.shareOf(address(this));
    }

    /// @notice Convenience pass-through; lets ops dashboards render a
    ///         "7d realized APY" without a separate ABI call.
    function realizedYield7dBps() external view returns (uint256) {
        return adapter.realizedYield7d();
    }

    /// @notice The cooldown duration currently applied to new cooldown
    ///         entries (read live from SettingManagement so admin tweaks
    ///         take effect on the next cooldownAssets call).
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
