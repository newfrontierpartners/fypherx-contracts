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
import "../libraries/PoolMath.sol";

/// @dev FYP-73 — minimal typed view of the cooldown silo so withdrawals use a
///      high-level call (matching {StakedRUSD}/{StakedAUSD}). A high-level call
///      reverts if `silo` is ever mis-set to an EOA (Solidity inserts an
///      extcodesize check), unlike the prior low-level `silo.call(...)` which
///      would silently report success against an account with no code.
interface IFypherCooldownSilo {
    function withdraw(address to, uint256 amount) external;
}

/**
 * @title StakedFYP (sFYP)
 * @notice ERC4626 vault for FYP governance token staking.
 *         Same cooldown pattern as StakedRUSD.
 *
 * @dev Deployed at: 0xc9B0148A796b783284E254b395150a4b712Db223
 *
 * @dev <b>FYP-21 — reward terminology</b>. Rewards funded via
 *      {transferInRewards} STREAM to current sFYP holders during
 *      the 8-hour release window (Ethena sUSDe pattern). The
 *      "vesting" identifiers are retained for ABI / proxy layout
 *      stability. See {StakedRUSD} for the full decision rationale.
 */
contract StakedFYP is
    Initializable,
    ERC4626Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    ReentrancyGuardUpgradeable,
    IStakedRUSDCooldown
{
    using SafeERC20 for IERC20;

    uint256 public constant VESTING_PERIOD = 8 hours;
    uint256 public constant SETTING_MANAGER_TIMELOCK = 2 days;
    /// @notice FYP-37 patch. See {StakedRUSD.DEFAULT_COOLDOWN}.
    uint256 public constant DEFAULT_COOLDOWN = 7 days;

    ISettingManagement public settingManagement;
    address public silo;

    uint256 public currentAPRRate;
    uint256 public remainingRewards;
    uint256 public vestingAmount;
    uint256 private _lastDistributionTimestamp;

    mapping(address => UserCooldown) public cooldowns;
    mapping(address => uint256) public userStakedAmount;

    // ── Storage (April-audit H-3 patch — APPEND-ONLY for proxy safety) ──
    /// @notice Pending replacement for `settingManagement`, awaiting timelock.
    ISettingManagement public pendingSettingManagement;
    /// @notice UNIX timestamp at which the pending replacement may be accepted.
    uint256 public pendingSettingManagerEta;

    event RewardsReceived(uint256 amount);
    event CooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    event EarlyUnstaked(address indexed user, address indexed receiver, uint256 assets, uint256 fee);
    event SettingManagerUpdated(address indexed newManager);
    event SettingManagerProposed(address indexed newManager, uint256 eta);
    event SettingManagerProposalCancelled(address indexed cancelledManager);
    // FYP-60 patch.
    event APRUpdated(uint256 newAPR);
    event RemainingRewardsUpdated(uint256 amount);

    error NotAdmin();
    error NotRewarder();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error ZeroAddress();
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();
    error RestrictedStaker(address account);
    /// @notice FYP-06: the immediate-exit ERC-4626 path is disabled.
    ///         Users must exit via {cooldownAssets} / {cooldownShares}
    ///         and {unstake} (or {earlyUnstake} with a fee).
    error CooldownRequired();
    /// @notice FYP-30 / FYP-43. The user's cooldown is either ready to
    ///         unstake (call {unstake}) or has not been started.
    error ExistingCooldownReady();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the upgradeable vault.
     *
     * @dev April-audit M-8 patch. Reject zero addresses for the asset,
     *      role authority, and silo escrow up-front — silently
     *      zero-initialising any of these would brick every modifier
     *      and silo call afterwards, with no recovery path on a
     *      one-shot initializer.
     */
    function initialize(
        IERC20 _fyp,
        ISettingManagement _settingManagement,
        address _silo
    ) external initializer {
        if (address(_fyp) == address(0)) revert ZeroAddress();
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (_silo == address(0)) revert ZeroAddress();

        __ERC4626_init(_fyp);
        __ERC20_init("Staked FYP", "sFYP");
        __ERC20Pausable_init();
        __ERC20Permit_init("Staked FYP");
        __ReentrancyGuard_init();

        settingManagement = _settingManagement;
        silo = _silo;
        _lastDistributionTimestamp = block.timestamp;
    }

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyRewarder() {
        if (!settingManagement.hasRole(keccak256("REWARDER_ROLE"), msg.sender)) revert NotRewarder();
        _;
    }

    /**
     * @notice Reject deposits to addresses flagged as restricted in
     *         {settingManagement} (sanctions / compliance gating).
     * @dev April-audit M-3 patch. The previous deposit path was
     *      unrestricted; FYP shares could be minted to a sanctioned
     *      address even though `StakedRUSD` already enforced the same
     *      gate. Mirrors {StakedRUSD.notRestricted}.
     */
    modifier notRestricted(address account) {
        if (settingManagement.hasRole(keccak256("FULL_RESTRICTED_STAKER_ROLE"), account))
            revert RestrictedStaker(account);
        if (settingManagement.hasRole(keccak256("SOFT_RESTRICTED_STAKER_ROLE"), account))
            revert RestrictedStaker(account);
        _;
    }

    /**
     * @notice Total assets backing the vault for share-pricing purposes.
     *         Returns `balance(asset) - _unvestedAmount()` so the still-
     *         locked portion of a recently-distributed reward is excluded
     *         from the share price during its 8-hour linear release.
     *
     * @dev <b>Reward semantics</b> (FYP-21 clarification). Rewards are
     *      STREAMED to current sFYP holders during the release
     *      window, not vested to a fixed cohort. See
     *      {StakedRUSD.totalAssets} for the full note. Identifier
     *      names retained for ABI / backend-binding stability.
     *
     * @dev April-audit C-2 patch. The previous body returned `balance`
     *      directly, which meant that `transferInRewards(amount)`
     *      instantaneously bumped the share price by the full reward.
     *      Anyone watching the rewarder's mempool tx could deposit
     *      immediately before, then cooldown immediately after, and
     *      capture the entire reward proportionally despite not having
     *      been staked when the protocol earned it. The new shape
     *      mirrors StakedRUSD post-C-1 and forces a linear release.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        uint256 unvested = _unvestedAmount();
        if (unvested >= bal) return 0;
        return bal - unvested;
    }

    /**
     * @notice The portion of the latest reward cohort that is still
     *         locked (linear ramp from `vestingAmount` → 0 over 8h).
     */
    function _unvestedAmount() internal view returns (uint256) {
        if (vestingAmount == 0) return 0;
        uint256 endsAt = _lastDistributionTimestamp + VESTING_PERIOD;
        if (block.timestamp >= endsAt) return 0;
        uint256 remaining = endsAt - block.timestamp;
        return (vestingAmount * remaining) / VESTING_PERIOD;
    }

    function deposit(uint256 assets, address receiver)
        public override nonReentrant whenNotPaused notRestricted(receiver) returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = super.deposit(assets, receiver);
        userStakedAmount[receiver] += assets;
        return shares;
    }

    /**
     * @notice ERC-4626 mint() override. Mirrors {deposit} guards.
     * @dev FYP-02 patch. See {StakedRUSD.mint} for the full rationale.
     */
    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        notRestricted(receiver)
        returns (uint256)
    {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = super.mint(shares, receiver);
        userStakedAmount[receiver] += assets;
        return assets;
    }

    /**
     * @notice The immediate ERC-4626 exit is permanently disabled — all
     *         exits must go through the cooldown silo.
     *
     * @dev FYP-06 patch. See {StakedRUSD.withdraw} for the full
     *      rationale. The cooldown flow uses the internal `_withdraw`
     *      so this override does not affect it.
     */
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert CooldownRequired();
    }

    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert CooldownRequired();
    }

    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }

    /// @notice See {StakedRUSD.previewWithdraw}. FYP-06 lingering.
    function previewWithdraw(uint256) public pure override returns (uint256) { return 0; }
    function previewRedeem(uint256) public pure override returns (uint256) { return 0; }

    /// @notice FYP-34: advertise deposit/mint capacity consistently with the
    ///         {whenNotPaused} + {notRestricted(receiver)} guards on
    ///         {deposit} / {mint}. Returns 0 when the vault is paused or the
    ///         receiver is a restricted staker, so ERC-4626 integrators that
    ///         consult {maxDeposit} / {maxMint} do not attempt an entry that
    ///         would revert.
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused() || _isDepositRestricted(receiver)) return 0;
        return super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused() || _isDepositRestricted(receiver)) return 0;
        return super.maxMint(receiver);
    }

    /// @dev FYP-34 helper: view mirror of {notRestricted}'s role checks so
    ///      {maxDeposit} / {maxMint} can reflect receiver restrictions.
    function _isDepositRestricted(address account) internal view returns (bool) {
        return settingManagement.hasRole(keccak256("FULL_RESTRICTED_STAKER_ROLE"), account)
            || settingManagement.hasRole(keccak256("SOFT_RESTRICTED_STAKER_ROLE"), account);
    }

    /**
     * @notice Reduce {userStakedAmount} by `assets`, clamping at 0.
     * @dev April-audit M-4 patch. See StakedRUSD._debitUserStaked.
     */
    function _debitUserStaked(address user, uint256 assets) internal {
        uint256 staked = userStakedAmount[user];
        userStakedAmount[user] = assets >= staked ? 0 : staked - assets;
    }

    // ── Cooldown ──
    /**
     * @notice See {StakedRUSD.cooldownAssets} for full rationale.
     *         April-audit M-1 patch (accumulating bucket) and M-2 patch
     *         ({whenNotPaused}) applied.
     */
    function cooldownAssets(uint256 assets) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        // FYP-06 lingering. See {StakedRUSD.cooldownAssets}.
        uint256 shares = _convertToShares(assets, Math.Rounding.Ceil);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);
        _accrueCooldown(msg.sender, assets);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);
        _accrueCooldown(msg.sender, assets);
    }

    function _accrueCooldown(address user, uint256 assets) internal {
        UserCooldown storage cd = cooldowns[user];
        // FYP-43 patch. See {StakedRUSD._accrueCooldown}.
        if (cd.underlyingAmount > 0 && block.timestamp >= cd.cooldownEnd) {
            revert ExistingCooldownReady();
        }

        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
        if (cooldownDuration == 0) cooldownDuration = DEFAULT_COOLDOWN;  // FYP-37
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

        // FYP-73: high-level typed silo call (reverts if silo has no code).
        IFypherCooldownSilo(silo).withdraw(receiver, assets);

        emit Unstaked(msg.sender, receiver, assets);
    }

    /**
     * @notice Skip the cooldown wait by paying the configured
     *         `earlyUnstakeFee` to the fee receiver. The net amount is
     *         delivered to {receiver} from the silo. Mirrors
     *         {StakedRUSD.earlyUnstake}.
     *
     * @dev FYP-20 patch. The previous codebase only exposed an early-
     *      unstake escape hatch on {StakedRUSD}; users staking FYP had
     *      to wait the full cooldown even though the supporting
     *      `earlyUnstakeFee` config slot already existed in
     *      SettingManagement. Adding the symmetric entry-point closes
     *      that asymmetry. FYP-73: silo withdrawals now use a high-level
     *      typed {IFypherCooldownSilo} call (matching {unstake} and
     *      {StakedRUSD}/{StakedAUSD}) so a mis-configured EOA silo reverts
     *      instead of silently reporting success.
     */
    function earlyUnstake(address receiver) external nonReentrant whenNotPaused {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        // FYP-30 patch. If cooldown is already over, call {unstake} —
        // do not pay the fee.
        if (block.timestamp >= cd.cooldownEnd) revert ExistingCooldownReady();

        // FYP-33 patch. See {StakedRUSD.earlyUnstake} for the rationale
        // on why the vault cannot be its own fee receiver.
        address feeReceiver = settingManagement.getFeeReceiver();
        require(feeReceiver != address(this), "Vault cannot be its own fee receiver");

        uint256 assets = cd.underlyingAmount;
        uint256 fee = PoolMath.calculateFee(assets, settingManagement.getFees("earlyUnstakeFee"));
        uint256 netAssets = assets - fee;
        delete cooldowns[msg.sender];

        // FYP-73: high-level typed silo calls (revert if silo has no code).
        IFypherCooldownSilo(silo).withdraw(receiver, netAssets);
        if (fee > 0) {
            IFypherCooldownSilo(silo).withdraw(feeReceiver, fee);
        }

        emit EarlyUnstaked(msg.sender, receiver, netAssets, fee);
    }

    // ── Rewards ──
    /**
     * @notice Transfer a new reward cohort into the vault. Carries any
     *         still-unvested portion of the previous cohort into the new
     *         one and re-anchors the vesting start.
     *
     * @dev April-audit C-2 patch. See StakedRUSD.transferInRewards for
     *      the full rationale.
     */
    function transferInRewards(uint256 amount) external onlyRewarder nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        vestingAmount = _unvestedAmount() + amount;
        _lastDistributionTimestamp = block.timestamp;

        remainingRewards += amount;
        emit RewardsReceived(amount);
    }

    function setCurrentAPY(uint256 newAPR) external onlyAdmin {
        // FYP-39: skip the SSTORE when the value is unchanged.
        if (newAPR == currentAPRRate) return;
        currentAPRRate = newAPR;
        emit APRUpdated(newAPR);  // FYP-60
    }

    function setRemainingRewards(uint256 amount) external onlyAdmin {
        if (amount == remainingRewards) return;
        remainingRewards = amount;
        emit RemainingRewardsUpdated(amount);  // FYP-60
    }

    // ── Admin ──
    /**
     * @notice Stage a replacement {ISettingManagement}. The new manager
     *         only takes effect after `SETTING_MANAGER_TIMELOCK` has
     *         elapsed and {acceptSettingManager} is called.
     *
     * @dev April-audit H-3 patch. See StakedRUSD.proposeSettingManager
     *      for the full rationale (single-tx role-authority swap risk).
     */
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

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    /**
     * @notice FYP-77: aligned with {StakedRUSD}. Release a non-asset token
     *         that was sent to this vault by mistake to an arbitrary
     *         recipient, gated by RELEASE_TOKEN_ROLE. The `token != asset()`
     *         guard prevents draining staker principal.
     */
    function releaseToken(address token, address to, uint256 amount) external {
        require(
            settingManagement.hasRole(keccak256("RELEASE_TOKEN_ROLE"), msg.sender),
            "Not release role"
        );
        require(token != asset(), "Cannot release staked asset");
        require(to != address(0), "Zero recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice FYP-77: aligned with {StakedRUSD}. Admin recovery of a
     *         non-asset token sent to this vault by mistake. The
     *         `token != asset()` guard prevents draining staker principal.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyAdmin {
        require(token != asset(), "Cannot rescue staked asset");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @dev FYP-03 patch + FYP-03 lingering patch.
     *      See {StakedRUSD._update} for the full rationale (NAV-based
     *      principal-move inflated recipient principal by accrued
     *      rewards on self-transfer; share-fraction math fixes it).
     */
    function _update(address from, address to, uint256 value)
        internal override(ERC20Upgradeable, ERC20PausableUpgradeable)
    {
        if (from != address(0) && to != address(0)) {
            if (settingManagement.hasRole(keccak256("FULL_RESTRICTED_STAKER_ROLE"), to))
                revert RestrictedStaker(to);
            if (settingManagement.hasRole(keccak256("SOFT_RESTRICTED_STAKER_ROLE"), to))
                revert RestrictedStaker(to);

            uint256 fromBalance = balanceOf(from);
            uint256 principalMoved;
            if (fromBalance > 0) {
                principalMoved = (userStakedAmount[from] * value) / fromBalance;
            }
            _debitUserStaked(from, principalMoved);
            userStakedAmount[to] += principalMoved;
        }
        super._update(from, to, value);
    }

    function decimals() public view override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }

    /**
     * @notice FYP-77: explicit ERC-4626 virtual-share offset override,
     *         aligned with {StakedRUSD}. Intentionally left at the OZ
     *         default of `0`; see {StakedRUSD._decimalsOffset} for the
     *         first-depositor-inflation rationale and the pre-mainnet
     *         redeploy plan. Declared explicitly so all three staked
     *         vaults expose an identical surface and a future contributor
     *         cannot silently re-introduce the change on one vault only.
     */
    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 0;
    }
}
