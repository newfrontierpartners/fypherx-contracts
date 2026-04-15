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
import "./RUSDSilo.sol";

/**
 * @title StakedRUSD (sRUSD)
 * @notice Primary retail staking vault for RUSD using ERC-4626.
 *         APR-based reward distribution with linear 8-hour vesting.
 *         Cooldown mechanism: assets held in RUSDSilo during cooldown period.
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0x2c048e01ebf957f7Ab66C3a09E85Ae31db7803D6
 *      Implementation: 0xd9c9f728dc7d5e81e2df406b82fe2540f2d484f3
 */
contract StakedRUSD is
    Initializable,
    ERC4626Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    ReentrancyGuardUpgradeable,
    IStakedRUSDCooldown
{
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 public constant VESTING_PERIOD = 8 hours;
    uint256 private constant MIN_SHARES = 1;

    // ── Storage ──
    ISettingManagement public settingManagement;
    RUSDSilo public silo;

    uint256 public currentAPRRate;      // basis points
    uint256 public remainingRewards;
    uint256 public vestingAmount;
    uint256 private _lastDistributionTimestamp;

    mapping(address => UserCooldown) public cooldowns;
    mapping(address => uint256) public userStakedAmount;
    mapping(address => uint256) public unstakeRequests;

    // ── Events ──
    event RewardsReceived(uint256 amount);
    event CooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    event EarlyUnstaked(address indexed user, address indexed receiver, uint256 assets, uint256 fee);
    event APRUpdated(uint256 newAPR);
    event SettingManagerUpdated(address indexed newManager);

    // ── Errors ──
    error NotAdmin();
    error NotRewarder();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error RestrictedStaker(address account);
    error InsufficientCooldown();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 _rusd,
        ISettingManagement _settingManagement,
        address admin_
    ) external initializer {
        __ERC4626_init(_rusd);
        __ERC20_init("Staked RUSD", "sRUSD");
        __ERC20Pausable_init();
        __ERC20Permit_init("Staked RUSD");
        __ReentrancyGuard_init();

        settingManagement = _settingManagement;
        silo = new RUSDSilo(address(this), _rusd);
        _lastDistributionTimestamp = block.timestamp;
    }

    // ── Modifiers ──
    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyRewarder() {
        if (!settingManagement.hasRole(keccak256("REWARDER_ROLE"), msg.sender)) revert NotRewarder();
        _;
    }

    modifier notRestricted(address account) {
        if (settingManagement.hasRole(keccak256("FULL_RESTRICTED_STAKER_ROLE"), account))
            revert RestrictedStaker(account);
        if (settingManagement.hasRole(keccak256("SOFT_RESTRICTED_STAKER_ROLE"), account))
            revert RestrictedStaker(account);
        _;
    }

    // ── ERC4626 overrides ──
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + _unvestedAmount();
    }

    function _unvestedAmount() internal view returns (uint256) {
        if (vestingAmount == 0) return 0;
        return PoolMath.calculateVestedAmount(
            vestingAmount,
            _lastDistributionTimestamp,
            VESTING_PERIOD
        );
    }

    // ── Deposit / Withdraw ──
    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        notRestricted(receiver)
        returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = super.deposit(assets, receiver);
        userStakedAmount[receiver] += assets;
        return shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    // ── Cooldown ──
    function cooldownAssets(uint256 assets) external override nonReentrant {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _withdraw(msg.sender, address(silo), msg.sender, assets, shares);

        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
        cooldowns[msg.sender] = UserCooldown({
            cooldownEnd: uint104(block.timestamp + cooldownDuration),
            underlyingAmount: uint152(assets)
        });

        emit CooldownStarted(msg.sender, assets, block.timestamp + cooldownDuration);
    }

    function cooldownShares(uint256 shares) external override nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _withdraw(msg.sender, address(silo), msg.sender, assets, shares);

        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
        cooldowns[msg.sender] = UserCooldown({
            cooldownEnd: uint104(block.timestamp + cooldownDuration),
            underlyingAmount: uint152(assets)
        });

        emit CooldownStarted(msg.sender, assets, block.timestamp + cooldownDuration);
    }

    function unstake(address receiver) external override nonReentrant {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        if (block.timestamp < cd.cooldownEnd) revert CooldownNotFinished();

        uint256 assets = cd.underlyingAmount;
        delete cooldowns[msg.sender];
        silo.withdraw(receiver, assets);

        emit Unstaked(msg.sender, receiver, assets);
    }

    function earlyUnstake(address receiver) external nonReentrant {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();

        uint256 assets = cd.underlyingAmount;
        uint256 fee = PoolMath.calculateFee(assets, settingManagement.getFees("earlyUnstakeFee"));
        uint256 netAssets = assets - fee;
        delete cooldowns[msg.sender];

        silo.withdraw(receiver, netAssets);
        if (fee > 0) {
            silo.withdraw(settingManagement.getFeeReceiver(), fee);
        }

        emit EarlyUnstaked(msg.sender, receiver, netAssets, fee);
    }

    // ── Rewards ──
    function transferInRewards(uint256 amount) external onlyRewarder nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        vestingAmount += amount;
        _lastDistributionTimestamp = block.timestamp;
        remainingRewards += amount;
        emit RewardsReceived(amount);
    }

    function setCurrentAPY(uint256 newAPR) external onlyAdmin {
        currentAPRRate = newAPR;
        emit APRUpdated(newAPR);
    }

    function setRemainingRewards(uint256 amount) external onlyAdmin {
        remainingRewards = amount;
    }

    // ── Admin ──
    function redistributeLockedAmount(address from, address to) external onlyAdmin {
        require(settingManagement.hasRole(keccak256("FULL_RESTRICTED_STAKER_ROLE"), from), "Not restricted");
        uint256 bal = balanceOf(from);
        if (bal > 0) {
            _transfer(from, to, bal);
        }
    }

    function releaseToken(address token, address to, uint256 amount) external {
        require(
            settingManagement.hasRole(keccak256("RELEASE_TOKEN_ROLE"), msg.sender),
            "Not release role"
        );
        IERC20(token).safeTransfer(to, amount);
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyAdmin {
        require(token != asset(), "Cannot rescue staked asset");
        IERC20(token).safeTransfer(to, amount);
    }

    function setSettingManager(address newManager) external onlyAdmin {
        settingManagement = ISettingManagement(newManager);
        emit SettingManagerUpdated(newManager);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
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
}
