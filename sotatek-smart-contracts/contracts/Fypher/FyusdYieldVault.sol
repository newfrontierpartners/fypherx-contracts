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

/// @dev Optional admin-extension on {IConcreteAdapter}. ConcreteAdapterV1
///      implements all three; legacy mock adapters may not. Only consumed
///      by admin-gated entry-points, so a mock that lacks an entry-point
///      simply leaves that call reverting — acceptable for test scaffolds.
interface IConcreteAdapterAdmin {
    function sweepConcreteShares(address to) external returns (uint256 amount);
    /// @notice FYP-41: ledger-independent close-out of the whole accounted
    ///         position (residual shares AND residual assets) for clean
    ///         adapter rotation once the vault is wound down.
    function recoverAll(address to) external returns (uint256 assetsOut);
    /// @notice FYP-75: admin-gated arbitrary-ERC20 rescue. Reverts on the
    ///         tracked Concrete vault share token.
    function rescueToken(address token, address to, uint256 amount) external;
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
    /// @notice FYP-41 (residual): the vault still has vFYUSD shares
    ///         outstanding, so the adapter cannot be closed out or rotated.
    error VaultNotEmpty(uint256 supply);
    /// @notice FYP-41 (residual): the old adapter still reports a non-zero
    ///         asset position; close it out via {closeAdapterPosition}
    ///         before rotating.
    error AdapterStillHoldsAssets(uint256 assets);
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
    ///
    /// @dev <b>FYP-57</b>. Any FYUSD transferred DIRECTLY to this
    ///      contract (by mistake or by a third party) is NOT
    ///      reflected in {totalAssets} — by design. Deposits must
    ///      go through {deposit} / {mint} so the adapter is funded
    ///      and the per-share NAV stays consistent. Direct transfers
    ///      become stuck (the vault's {rescueTokens} explicitly
    ///      rejects rescuing the underlying asset). Frontend /
    ///      integrators MUST route every FYUSD inflow through the
    ///      ERC-4626 entry points.
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
    /**
     * @dev FYP-55 patch. Resets the adapter allowance back to 0 after
     *      the deposit call so any unconsumed remainder cannot be
     *      pulled by the adapter later. With the current
     *      ConcreteAdapterV1 this is belt-and-braces — that adapter
     *      consumes the full approved amount synchronously — but the
     *      reset insulates the vault from future adapter swaps that
     *      may not.
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
        fyusd.forceApprove(address(adapter), 0);
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

    /// @notice ERC-4626 advertisement that synchronous exits are
    ///         disabled — the cooldown flow is the only exit path.
    /// @dev FYP-34 patch. Without these overrides, ERC-4626
    ///      integrators that consult {maxWithdraw} / {maxRedeem}
    ///      get a non-zero value (computed from
    ///      `_convertToAssets(balanceOf(owner))`) and assume
    ///      a synchronous exit is available; the actual
    ///      {_withdraw} call then reverts with
    ///      "vFYUSD: use cooldown flow". Returning 0 here matches
    ///      the staked-vault pattern and removes the
    ///      misleading-signal surface.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }
    function previewWithdraw(uint256) public pure override returns (uint256) {
        return 0;
    }
    function previewRedeem(uint256) public pure override returns (uint256) {
        return 0;
    }

    /// @notice FYP-34: advertise deposit/mint capacity consistently with the
    ///         {whenNotPaused} guard on {deposit} / {mint}. Returns 0 while
    ///         the vault is paused so ERC-4626 integrators that consult
    ///         {maxDeposit} / {maxMint} do not attempt an entry that would
    ///         revert. (vFYUSD has no receiver-restriction gate, unlike the
    ///         staked vaults, so pause is the only deposit-side constraint.)
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
    /// @dev FYP-34 patch. Internal conversion via OZ's
    ///      {_convertToShares} / {_convertToAssets} so that the
    ///      public {previewWithdraw} / {previewRedeem} can return 0
    ///      (matching {maxWithdraw} / {maxRedeem}) without breaking
    ///      the cooldown math. Rounding modes mirror the OZ
    ///      defaults the previous {previewWithdraw} / {previewRedeem}
    ///      path used (Ceil for shares burned, Floor for assets
    ///      delivered).
    function cooldownAssets(uint256 assets)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = _convertToShares(assets, Math.Rounding.Ceil);
        _exitToCooldown(msg.sender, assets, shares);
    }

    function cooldownShares(uint256 shares)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
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
     * @dev FYP-09 patch + FYP-41 residual patch.
     *
     *      <p>FYP-09: the original shape blindly rebound the adapter,
     *      orphaning every asset still parked in the old adapter (since
     *      totalAssets() reads from the new, empty one). The NatSpec
     *      referenced an emergencyMigrate step that never existed.
     *
     *      <p>FYP-41 residual (CertiK): the follow-up guard
     *      `oldAdapter.shareOf(this) == 0` keyed rotation off the
     *      adapter's INTERNAL share ledger. That ledger rounds
     *      differently from the vault's OZ ERC-4626 virtual-offset math,
     *      so the two can drift: a wound-down vault could be left with
     *      residual adapter-shares that wrongly BLOCK rotation (case 1),
     *      or with the adapter-share count rounded to zero while residual
     *      ASSETS remain in Concrete that the guard could not see at all
     *      (case 2).
     *
     *      <p>The fix keys rotation off the single source of truth — the
     *      vault's own ERC-4626 supply — and an ASSET-denominated residual
     *      check. Rotation is permitted only once every vFYUSD share has
     *      been redeemed (`totalSupply() == 0`) AND the old adapter reports
     *      no residual assets. Any rounding-dust position still parked in
     *      the old adapter is cleared first via {closeAdapterPosition},
     *      which is ledger-independent and covers both residual shares and
     *      residual assets.
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

    /**
     * @notice FYP-41 (residual) — close out the current adapter's entire
     *         accounted position once the vault is wound down, delivering
     *         the residual underlying to {to}. This is the asset-based,
     *         ledger-independent migration helper CertiK asked for: it
     *         clears BOTH residual adapter-shares (case 1) and residual
     *         assets (case 2), after which {setAdapter} can rotate cleanly.
     *
     * @dev Gated on `totalSupply() == 0` so it can never strip backing
     *      from a live shareholder. Admin-only — proxied through the vault
     *      because the adapter binds {recoverAll} to msg.sender == vault.
     */
    function closeAdapterPosition(address to) external onlyAdmin returns (uint256 recovered) {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() != 0) revert VaultNotEmpty(totalSupply());
        return IConcreteAdapterAdmin(address(adapter)).recoverAll(to);
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
        return IConcreteAdapterAdmin(address(adapter)).sweepConcreteShares(to);
    }

    /**
     * @notice FYP-75 — admin recovery of arbitrary ERC-20 tokens
     *         accidentally sent to the bound adapter. Proxied through the
     *         vault because the adapter binds its {rescueToken} entry-point
     *         to msg.sender == this vault; the adapter itself reverts on
     *         the tracked Concrete vault share token.
     */
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

    /// @notice Adapter-recorded share balance held by THIS vault.
    /// @dev FYP-41: dashboard-only. The vault's ERC-4626 supply is the
    ///      sole source of share accounting; the adapter's internal ledger
    ///      can drift from it by rounding dust and is NOT used for any
    ///      exit or rotation decision (see {setAdapter} /
    ///      {closeAdapterPosition}). Reads {totalAssets} for backing.
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
