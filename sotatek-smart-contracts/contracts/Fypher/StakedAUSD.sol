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
///      high-level call (matching {StakedRUSD}). A high-level call reverts if
///      `silo` is ever mis-set to an EOA (Solidity inserts an extcodesize
///      check), unlike the prior low-level `silo.call(...)` which would
///      silently report success against an account with no code.
interface IFypherCooldownSilo {
    function withdraw(address to, uint256 amount) external;
}

/**
 * @title StakedAUSD (stAUSD / sFYUSD)
 * @notice ERC4626 vault for FYUSD staking. Underlying asset = FYUSD.
 *         Uses RUSDSilo pattern (2-param withdraw) for cooldown escrow.
 *         The contract name "StakedAUSD" is a legacy artifact retained
 *         because the BSC-Testnet proxy is already deployed at this
 *         implementation; the underlying asset is and always has been
 *         FYUSD (see {initialize} below).
 *
 * @dev Deployed at: 0x57B74722224e8cA49586E14dFEea37EddcF4Ffda
 *      Single silo: stAUSDSilo (0xc65F...) for FYUSD cooldown.
 *      The institutional fork (iRUSDSilo / SIRUSDSilo) was retired
 *      from the alpha audit scope — see backup/irusd/.
 *
 * @dev <b>FYP-21 — reward terminology</b>. Rewards funded via
 *      {transferInRewards} STREAM to current stAUSD holders during
 *      the 8-hour release window (Ethena sUSDe pattern). The
 *      "vesting" identifiers are retained for ABI / proxy layout
 *      stability. See {StakedRUSD} for the full decision rationale.
 */
contract StakedAUSD is
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
    error CooldownRequired();
    /// @notice FYP-30 / FYP-43. Cooldown ready or not started.
    error ExistingCooldownReady();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the upgradeable vault.
     *
     * @dev April-audit M-8 patch. See StakedFYP.initialize for rationale.
     */
    function initialize(
        IERC20 _fyusd,
        ISettingManagement _settingManagement,
        address _silo
    ) external initializer {
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (_silo == address(0)) revert ZeroAddress();

        __ERC4626_init(_fyusd);
        __ERC20_init("Staked AUSD", "stAUSD");
        __ERC20Pausable_init();
        __ERC20Permit_init("Staked AUSD");
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
     * @dev April-audit M-3 patch. Mirrors {StakedRUSD.notRestricted}.
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
     *      STREAMED to current stAUSD holders during the release
     *      window, not vested to a fixed cohort. See
     *      {StakedRUSD.totalAssets}.
     *
     * @dev April-audit C-2 patch. See StakedFYP for full rationale.
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
     * @dev FYP-06 patch. See {StakedRUSD.withdraw}.
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
     *         April-audit M-1/M-2 patches applied.
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
     *         `earlyUnstakeFee`. Mirrors {StakedRUSD.earlyUnstake}.
     * @dev FYP-20 patch. See {StakedFYP.earlyUnstake} for the
     *      rationale on bringing the early-exit path in line across
     *      all three cooldown vaults.
     */
    function earlyUnstake(address receiver) external nonReentrant whenNotPaused {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        // FYP-30: cooldown already over → call {unstake} instead.
        if (block.timestamp >= cd.cooldownEnd) revert ExistingCooldownReady();

        // FYP-33: vault cannot be its own fee receiver.
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
     *      for the full rationale.
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
     * @dev FYP-03 patch + FYP-03 lingering patch.
     *      See {StakedRUSD._update} for the full rationale.
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
}
