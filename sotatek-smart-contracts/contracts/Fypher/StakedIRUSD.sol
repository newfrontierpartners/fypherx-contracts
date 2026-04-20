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
import "../libraries/PoolMath.sol";

/**
 * @title StakedIRUSD (siRUSD)
 * @notice ERC4626 vault for institutional iRUSD staking.
 *         Uses SIRUSDSilo for cooldown escrow (3-param withdraw: token, to, amount).
 *
 * @dev Deployed at: 0x854c2AB7AeEcF92E5f9Ee5da46d38FE48253B707
 */
contract StakedIRUSD is
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

    ISettingManagement public settingManagement;
    address public silo; // SIRUSDSilo — uses withdraw(token, to, amount)

    uint256 public currentAPRRate;
    uint256 public remainingRewards;
    uint256 public vestingAmount;
    uint256 private _lastDistributionTimestamp;

    mapping(address => UserCooldown) public cooldowns;
    mapping(address => uint256) public userStakedAmount;
    /**
     * @dev Reserved-but-unused. April-audit L-3. The cooldown flow uses
     *      `cooldowns` (UserCooldown struct) exclusively; no code path
     *      reads or writes this mapping. Kept for TransparentProxy
     *      storage-layout safety.
     */
    mapping(address => uint256) public unstakeRequests;

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

    error NotAdmin();
    error NotRewarder();
    error NotInstitutional();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error ZeroAddress();
    error RestrictedStaker(address account);
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();

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
        IERC20 _irusd,
        ISettingManagement _settingManagement,
        address _silo
    ) external initializer {
        if (address(_irusd) == address(0)) revert ZeroAddress();
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (_silo == address(0)) revert ZeroAddress();

        __ERC4626_init(_irusd);
        __ERC20_init("Staked iRUSD", "siRUSD");
        __ERC20Pausable_init();
        __ERC20Permit_init("Staked iRUSD");
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

    modifier onlyInstitutional(address account) {
        if (!settingManagement.hasRole(keccak256("INSTITUTIONAL_ROLE"), account)) revert NotInstitutional();
        _;
    }

    // ── ERC4626 ──
    /**
     * @notice Total assets backing the vault for share-pricing purposes.
     *         Returns `balance(asset) - _unvestedAmount()` so the still-
     *         locked portion of a recently-distributed reward is excluded
     *         from the share price during its 8-hour linear vesting.
     *
     * @dev April-audit C-2 patch. See StakedRUSD for full rationale.
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
        public
        override
        nonReentrant
        whenNotPaused
        onlyInstitutional(receiver)
        returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = super.deposit(assets, receiver);
        userStakedAmount[receiver] += assets;
        return shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public override nonReentrant whenNotPaused returns (uint256)
    {
        uint256 ret = super.withdraw(assets, receiver, owner_);
        _debitUserStaked(owner_, assets);
        return ret;
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public override nonReentrant whenNotPaused returns (uint256)
    {
        uint256 assets = super.redeem(shares, receiver, owner_);
        _debitUserStaked(owner_, assets);
        return assets;
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
     *         April-audit M-1/M-2 patches applied.
     */
    function cooldownAssets(uint256 assets) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);
        _accrueCooldown(msg.sender, assets);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);
        _accrueCooldown(msg.sender, assets);
    }

    function _accrueCooldown(address user, uint256 assets) internal {
        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
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

        // SIRUSDSilo.withdraw(token, to, amount)
        (bool success,) = silo.call(
            abi.encodeWithSignature("withdraw(address,address,uint256)", asset(), receiver, assets)
        );
        require(success, "Silo withdraw failed");

        emit Unstaked(msg.sender, receiver, assets);
    }

    function earlyUnstake(address receiver) external nonReentrant whenNotPaused {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();

        uint256 assets = cd.underlyingAmount;
        uint256 fee = PoolMath.calculateFee(assets, settingManagement.getFees("earlyUnstakeFee"));
        uint256 netAssets = assets - fee;
        delete cooldowns[msg.sender];

        (bool s1,) = silo.call(
            abi.encodeWithSignature("withdraw(address,address,uint256)", asset(), receiver, netAssets)
        );
        require(s1, "Silo withdraw failed");

        if (fee > 0) {
            (bool s2,) = silo.call(
                abi.encodeWithSignature("withdraw(address,address,uint256)", asset(), settingManagement.getFeeReceiver(), fee)
            );
            require(s2, "Silo fee withdraw failed");
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
        currentAPRRate = newAPR;
    }

    function setRemainingRewards(uint256 amount) external onlyAdmin {
        remainingRewards = amount;
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

    function _update(address from, address to, uint256 value)
        internal override(ERC20Upgradeable, ERC20PausableUpgradeable)
    {
        super._update(from, to, value);
    }

    function decimals() public view override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }
}
