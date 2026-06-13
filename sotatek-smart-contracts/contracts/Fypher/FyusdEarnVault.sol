// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IStakedRUSDCooldown.sol"; // UserCooldown struct
import "../interfaces/ISettingManagement.sol";
import "./IConcreteAdapter.sol";
import "./RUSDSilo.sol";

/// @dev Optional sweep extension on {IConcreteAdapter} — implemented by
///      ConcreteStableAdapter / ConcreteAdapterV1. Proxied admin-gated.
interface IConcreteAdapterSweepable {
    function sweepConcreteShares(address to) external returns (uint256 amount);
}

/**
 * @title FyusdEarnVault (blended vFYUSD)
 * @notice The 70:30 Earn vault from PRODUCT-FLOWS §2.1 (Option C) / C-4.
 *         A **thin, ratio-agnostic, keeper-orchestrated** ERC-4626-style
 *         vault: users' USDC enters the 70:30 Earn flow, and a single
 *         fungible **vFYUSD** receipt represents the blended position:
 *
 *           - **on-chain leg (~30%)**: USDC deposited into Concrete via
 *             {ConcreteStableAdapter} — real, trustless collateral whose
 *             value is {adapter.totalAssets()} and grows with Concrete yield.
 *           - **off-chain leg (~70%)**: USDC converted to FYUSD held in
 *             BitGo Prime custody (BVI/LLC). Its USDC-equivalent value is
 *             tracked here as {offChainBackedAssets}, reported by the
 *             backend keeper. This leg is **custodial, not trustless** —
 *             consistent with the whole BitGo-direct model (§6-3).
 *
 *         <pre>
 *           NAV (totalAssets) = adapter.totalAssets()  +  offChainBackedAssets
 *                               └── on-chain (Concrete) ┘   └── off-chain (BitGo) ┘
 *         </pre>
 *
 * <p><b>Ratio-agnostic (§2.4)</b>: the vault does NOT know the 70:30 split.
 * The backend keeper computes each deposit's leg amounts from the
 * `allocationFyusdBps` runtime setting and passes them to
 * {depositBlended} as `concreteLegAssets` (on-chain) and `offChainLegAssets`
 * (off-chain). The ratio lives in the backend single-source; changing it
 * is a config edit, never a redeploy. Per-position ratio snapshots live in
 * the backend ledger (EarnPositionEntity) — on-chain redemption is
 * **pool-proportional** because vFYUSD is fungible (see {requestRedeem}).
 *
 * <p><b>Keeper-orchestrated</b>: only {keeper} (the backend hot wallet,
 * funded out of BitGo custody with the on-chain leg's USDC) may
 * {depositBlended}. The 70% never touches the chain. The standard ERC-4626
 * {deposit}/{mint} entry points are disabled so no one can mint vFYUSD
 * without the off-chain leg being accounted. owner/admin =
 * {settingManagement} admin (the Gnosis Safe, §2.5).
 *
 * <p><b>2-tranche redemption (§9.2)</b>: {requestRedeem} splits the burned
 * shares proportionally across the two legs:
 *   - on-chain leg → withdrawn from Concrete now and held in the {silo}
 *     under a 14-day cooldown ({unstake} releases it). Default 14 days,
 *     tunable via the `vFyusdEarnCooldown` pool config.
 *   - off-chain leg → recorded as {offChainOwed} and emitted; the backend
 *     wires the USDC out of BitGo custody (~2h) and calls
 *     {settleOffChainClaim} to clear the on-chain record. Funds are NEVER
 *     held by this contract for the off-chain leg.
 *
 * @dev Upgradeable (TransparentProxy). Mirrors {FyusdYieldVault}'s admin /
 *      timelock / pauser / silo patterns so ops + audit reviewers see one
 *      shape across both vaults. AUDIT-CRITICAL (PRODUCT-FLOWS C-4).
 */
contract FyusdEarnVault is
    Initializable,
    ERC4626Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 public constant SETTING_MANAGER_TIMELOCK = 2 days;
    /// @notice §6-4: blended Earn cooldown is 14 days.
    uint256 public constant DEFAULT_COOLDOWN = 14 days;
    /// @notice SettingManagement pool-config key for this vault's on-chain
    ///         leg cooldown. Distinct from FyusdYieldVault's `vFyusdCooldown`
    ///         so the two vaults are tuned independently.
    string public constant COOLDOWN_CONFIG_KEY = "vFyusdEarnCooldown";

    // ── Storage ──
    ISettingManagement public settingManagement;
    /// @notice The 30%-leg adapter (ConcreteStableAdapter, underlying = USDC).
    IConcreteAdapter public adapter;
    /// @notice Escrow holding USDC during the on-chain leg's cooldown.
    RUSDSilo public silo;
    address public pauserRole;
    /// @notice Backend hot wallet authorised to inject leg amounts and
    ///         report off-chain NAV. Owner (Safe) sets/rotates it.
    address public keeper;

    /// @notice USDC-equivalent value of the off-chain (BitGo FYUSD) leg.
    ///         Principal added on {depositBlended}, reduced on
    ///         {requestRedeem}, grown by {accrueOffChainYield}. Half of the
    ///         blended NAV. Keeper-reported (custodial trust, §6-3).
    uint256 public offChainBackedAssets;

    /// @notice On-chain (Concrete) leg cooldown buckets, keyed by user.
    ///         Same shape as the cooldown vaults; auto-getter matches
    ///         IStakedRUSDCooldown.cooldowns.
    mapping(address => UserCooldown) public cooldowns;

    /// @notice Off-chain leg amount (USDC) owed to a user after
    ///         {requestRedeem}, awaiting the BitGo wire. Cleared by
    ///         {settleOffChainClaim}. On-chain transparency record only —
    ///         the contract never custodies these funds.
    mapping(address => uint256) public offChainOwed;
    /// @notice Sum of all {offChainOwed} entries (ops/audit reconciliation).
    uint256 public totalOffChainOwed;

    /// @notice Pending replacement for {settingManagement}, awaiting timelock.
    ISettingManagement public pendingSettingManagement;
    uint256 public pendingSettingManagerEta;

    // ── Events ──
    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    /// @notice A blended deposit. `concreteLegAssets` went on-chain to
    ///         Concrete, `offChainLegAssets` is now backed in BitGo custody.
    event BlendedDeposit(
        address indexed caller,
        address indexed receiver,
        uint256 concreteLegAssets,
        uint256 offChainLegAssets,
        uint256 sharesMinted
    );
    /// @notice Backend reported accrued yield on the off-chain (T-bill) leg.
    event OffChainYieldAccrued(uint256 amount, uint256 newOffChainBackedAssets);
    /// @notice Admin (Safe) correction to the off-chain NAV (loss event,
    ///         reconciliation). `delta` is signed; `reasonHash` is an
    ///         audit pointer.
    event OffChainAssetsAdjusted(int256 delta, uint256 newOffChainBackedAssets, bytes32 reasonHash);
    /// @notice A 2-tranche redemption request. `onChainAssets` entered the
    ///         silo cooldown; `offChainAssets` is owed via BitGo wire.
    event RedeemRequested(
        address indexed user,
        uint256 sharesBurned,
        uint256 onChainAssets,
        uint256 offChainAssets,
        uint256 onChainCooldownEnd
    );
    event OnChainCooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    /// @notice Backend confirmed the BitGo USDC wire for the off-chain leg.
    event OffChainClaimSettled(address indexed user, uint256 amount, bytes32 txRef);
    event SettingManagerUpdated(address indexed newManager);
    event SettingManagerProposed(address indexed newManager, uint256 eta);
    event SettingManagerProposalCancelled(address indexed cancelledManager);

    // ── Errors ──
    error NotAdmin();
    error NotKeeper();
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
    error ExistingCooldownReady();
    error UseDepositBlended();
    error UseRequestRedeem();
    error InsufficientShares(uint256 requested, uint256 available);
    error OffChainClaimOverflow(uint256 requested, uint256 owed);
    error OffChainAssetsUnderflow(uint256 requested, uint256 available);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param _settingManagement central registry (admin = Safe).
     * @param _usdc the underlying stablecoin (USDC, 6 decimals).
     * @param _adapter the ConcreteStableAdapter (asset MUST == _usdc).
     * @param admin_ must already be the SettingManagement admin (Safe).
     */
    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _usdc,
        IConcreteAdapter _adapter,
        address admin_
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_adapter) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (_adapter.asset() != address(_usdc)) {
            revert AdapterAssetMismatch(address(_usdc), _adapter.asset());
        }
        if (!_settingManagement.hasRole(bytes32(0), admin_)) revert AdminMismatch(admin_);

        __ERC20_init("Earn FYUSD", "vFYUSD");
        __ERC4626_init(_usdc);
        __ERC20Pausable_init();
        __ERC20Permit_init("Earn FYUSD");
        __ReentrancyGuard_init();

        settingManagement = _settingManagement;
        adapter = _adapter;
        silo = new RUSDSilo(address(this), _usdc);
    }

    // ── Modifiers ──
    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (msg.sender != pauserRole && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotPauserOrAdmin();
        }
        _;
    }

    // ── NAV ──

    /// @notice Blended NAV = on-chain Concrete leg + off-chain BitGo leg.
    ///         The on-chain leg is trustless ({adapter.totalAssets()}); the
    ///         off-chain leg is keeper-reported ({offChainBackedAssets}).
    ///         USDC parked in the {silo} for cooldown is excluded — it has
    ///         already left the adapter and is earmarked for a redeemer.
    function totalAssets() public view override returns (uint256) {
        return adapter.totalAssets() + offChainBackedAssets;
    }

    /// @notice On-chain (Concrete) component of NAV.
    function onChainBackedAssets() external view returns (uint256) {
        return adapter.totalAssets();
    }

    // ── Deposit (keeper-orchestrated, ratio-agnostic) ──

    /**
     * @notice Mint blended vFYUSD for a deposit the backend has already
     *         split. Only the {keeper} may call.
     *
     *         The keeper:
     *           1. computed `concreteLegAssets` (30%) + `offChainLegAssets`
     *              (70%) from the `allocationFyusdBps` setting,
     *           2. holds `concreteLegAssets` USDC on-chain (swept from BitGo
     *              custody) and has approved this vault for it,
     *           3. has the off-chain leg's USDC already converted to FYUSD
     *              and held in BitGo custody.
     *
     *         This call pulls the on-chain USDC, deposits it into Concrete,
     *         books the off-chain leg into NAV, and mints vFYUSD for the
     *         total at the current (pre-deposit) share price.
     *
     * @dev Shares are computed BEFORE mutating either leg so existing
     *      holders are neither diluted nor inflated. Either leg may be 0
     *      (ratio-agnostic), but the total must be positive.
     *
     * @return shares vFYUSD minted to `receiver`.
     */
    function depositBlended(
        address receiver,
        uint256 concreteLegAssets,
        uint256 offChainLegAssets
    ) external onlyKeeper nonReentrant whenNotPaused returns (uint256 shares) {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 total = concreteLegAssets + offChainLegAssets;
        if (total == 0) revert ZeroAmount();

        // Price the mint at the pre-deposit NAV (Floor → no over-mint).
        shares = _convertToShares(total, Math.Rounding.Floor);

        // On-chain leg → Concrete. FYP-55: reset allowance to 0 after.
        if (concreteLegAssets > 0) {
            IERC20 usdc = IERC20(asset());
            usdc.safeTransferFrom(msg.sender, address(this), concreteLegAssets);
            usdc.forceApprove(address(adapter), concreteLegAssets);
            adapter.deposit(concreteLegAssets);
            usdc.forceApprove(address(adapter), 0);
        }

        // Off-chain leg → booked into NAV (USDC is in BitGo custody).
        if (offChainLegAssets > 0) {
            offChainBackedAssets += offChainLegAssets;
        }

        _mint(receiver, shares);
        emit BlendedDeposit(msg.sender, receiver, concreteLegAssets, offChainLegAssets, shares);
        return shares;
    }

    // ── Standard ERC-4626 entry points are disabled ──
    // Deposits MUST go through {depositBlended} (two legs); exits through
    // {requestRedeem} (2-tranche cooldown). The synchronous ERC-4626 paths
    // would bypass the off-chain leg accounting, so they revert.

    function deposit(uint256, address) public pure override returns (uint256) {
        revert UseDepositBlended();
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert UseDepositBlended();
    }

    function _withdraw(address, address, address, uint256, uint256) internal pure override {
        revert UseRequestRedeem();
    }

    function maxDeposit(address) public pure override returns (uint256) {
        return 0;
    }
    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }
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

    // ── Off-chain leg NAV reporting ──

    /**
     * @notice Keeper reports yield accrued on the off-chain (BitGo T-bill)
     *         leg, raising the blended NAV for all vFYUSD holders.
     *         Positive-only; corrections/losses go through
     *         {adminAdjustOffChainAssets} so a routine keeper key cannot
     *         silently mark assets DOWN.
     */
    function accrueOffChainYield(uint256 amount) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        offChainBackedAssets += amount;
        emit OffChainYieldAccrued(amount, offChainBackedAssets);
    }

    /**
     * @notice Admin (Safe) correction to the off-chain NAV — reconciliation
     *         drift or a custody loss event. Signed `delta`; `reasonHash`
     *         is an off-chain audit pointer. Admin-gated (not the routine
     *         keeper key) because it can move NAV in either direction.
     */
    function adminAdjustOffChainAssets(int256 delta, bytes32 reasonHash) external onlyAdmin {
        if (delta == 0) revert ZeroAmount();
        if (delta > 0) {
            offChainBackedAssets += uint256(delta);
        } else {
            uint256 dec = uint256(-delta);
            if (dec > offChainBackedAssets) revert OffChainAssetsUnderflow(dec, offChainBackedAssets);
            offChainBackedAssets -= dec;
        }
        emit OffChainAssetsAdjusted(delta, offChainBackedAssets, reasonHash);
    }

    // ── Redemption (2-tranche) ──

    /**
     * @notice Burn `shares` vFYUSD and start a 2-tranche redemption.
     *         The two legs are split **pool-proportionally** at the current
     *         NAV (vFYUSD is fungible, so a redeemer's split follows the
     *         pool's on-chain/off-chain ratio, not their original deposit
     *         ratio — that snapshot lives in the backend ledger):
     *
     *           onChainAssets  = shares * adapter.totalAssets()    / supply
     *           offChainAssets = shares * offChainBackedAssets      / supply
     *
     *         The on-chain leg is withdrawn from Concrete now and held in
     *         the silo under the 14-day cooldown ({unstake} releases it).
     *         The off-chain leg is recorded in {offChainOwed} and emitted;
     *         the backend wires it from BitGo custody (~2h) and calls
     *         {settleOffChainClaim}.
     *
     * @return onChainAssets USDC entering the cooldown silo.
     * @return offChainAssets USDC owed via the BitGo wire.
     */
    function requestRedeem(uint256 shares)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 onChainAssets, uint256 offChainAssets)
    {
        if (shares == 0) revert ZeroAmount();
        uint256 bal = balanceOf(msg.sender);
        if (shares > bal) revert InsufficientShares(shares, bal);

        uint256 supply = totalSupply();
        uint256 onChainTotal = adapter.totalAssets();
        uint256 offChainTotal = offChainBackedAssets;

        // Proportional split (Floor → never over-pay; dust stays in pool).
        onChainAssets = supply == 0 ? 0 : Math.mulDiv(shares, onChainTotal, supply);
        offChainAssets = supply == 0 ? 0 : Math.mulDiv(shares, offChainTotal, supply);

        // Burn first (checks-effects-interactions).
        _burn(msg.sender, shares);

        // ── On-chain leg → silo cooldown ──
        if (onChainAssets > 0) {
            IERC20 usdc = IERC20(asset());
            uint256 balBefore = usdc.balanceOf(address(this));
            adapter.withdraw(onChainAssets);
            // FYP-74: trust the measured delta over the adapter's return.
            uint256 received = usdc.balanceOf(address(this)) - balBefore;
            if (received < onChainAssets) revert AdapterReturnedShort(onChainAssets, received);
            usdc.safeTransfer(address(silo), received);
            _accrueCooldown(msg.sender, received);
            onChainAssets = received;
        }

        // ── Off-chain leg → owed, wired by BitGo ──
        if (offChainAssets > 0) {
            offChainBackedAssets -= offChainAssets;
            offChainOwed[msg.sender] += offChainAssets;
            totalOffChainOwed += offChainAssets;
        }

        emit RedeemRequested(
            msg.sender,
            shares,
            onChainAssets,
            offChainAssets,
            cooldowns[msg.sender].cooldownEnd
        );
        return (onChainAssets, offChainAssets);
    }

    /// @dev Reuses the FYP-43 guard: reject a new cooldown stacked on a
    ///      ready-to-claim balance so funds aren't accidentally re-locked.
    function _accrueCooldown(address user, uint256 assets) internal {
        UserCooldown storage cd = cooldowns[user];
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
        emit OnChainCooldownStarted(user, newAmount, cd.cooldownEnd);
    }

    /// @notice Release the matured on-chain (Concrete) leg from the silo.
    function unstake(address receiver) external nonReentrant whenNotPaused {
        if (receiver == address(0)) revert ZeroAddress();
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        if (block.timestamp < cd.cooldownEnd) revert CooldownNotFinished();

        uint256 assets = cd.underlyingAmount;
        delete cooldowns[msg.sender];
        silo.withdraw(receiver, assets);
        emit Unstaked(msg.sender, receiver, assets);
    }

    /**
     * @notice Keeper clears a user's off-chain owed amount once the BitGo
     *         USDC wire is confirmed. `txRef` is the off-chain settlement
     *         reference (BitGo order id / tx hash) for the audit trail.
     *         Pure bookkeeping — no funds move on-chain.
     */
    function settleOffChainClaim(address user, uint256 amount, bytes32 txRef) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        uint256 owed = offChainOwed[user];
        if (amount > owed) revert OffChainClaimOverflow(amount, owed);
        offChainOwed[user] = owed - amount;
        totalOffChainOwed -= amount;
        emit OffChainClaimSettled(user, amount, txRef);
    }

    // ── Admin ──

    /// @dev Same invariant as FyusdYieldVault.setAdapter (FYP-09): the old
    ///      adapter must be fully drained before rebinding.
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

    function setKeeper(address newKeeper) external onlyAdmin {
        if (newKeeper == address(0)) revert ZeroAddress();
        if (newKeeper == keeper) return;
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function sweepAdapterConcreteShares(address to) external onlyAdmin returns (uint256 swept) {
        if (to == address(0)) revert ZeroAddress();
        return IConcreteAdapterSweepable(address(adapter)).sweepConcreteShares(to);
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        if (newPauser == address(0)) revert ZeroAddress();
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

    // ── Views ──

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
