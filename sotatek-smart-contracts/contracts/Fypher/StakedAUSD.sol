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
 * @title StakedAUSD (stAUSD / sFYUSD)
 * @notice ERC4626 vault for FYUSD staking. Underlying asset = FYUSD.
 *         Uses RUSDSilo pattern (2-param withdraw) for cooldown escrow.
 *
 * @dev Deployed at: 0x57B74722224e8cA49586E14dFEea37EddcF4Ffda
 *      Has TWO silos:
 *        - stAUSDSilo (0xc65F...) for FYUSD cooldown
 *        - iRUSDSilo  (0x7f51...) for iRUSD cooldown
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

    ISettingManagement public settingManagement;
    address public silo;

    uint256 public currentAPRRate;
    uint256 public remainingRewards;
    uint256 public vestingAmount;
    uint256 private _lastDistributionTimestamp;

    mapping(address => UserCooldown) public cooldowns;
    mapping(address => uint256) public userStakedAmount;

    event RewardsReceived(uint256 amount);
    event CooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);

    error NotAdmin();
    error NotRewarder();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 _fyusd,
        ISettingManagement _settingManagement,
        address _silo
    ) external initializer {
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

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function deposit(uint256 assets, address receiver)
        public override nonReentrant whenNotPaused returns (uint256)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = super.deposit(assets, receiver);
        userStakedAmount[receiver] += assets;
        return shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public override nonReentrant whenNotPaused returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public override nonReentrant whenNotPaused returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    // ── Cooldown ──
    function cooldownAssets(uint256 assets) external override nonReentrant {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);

        uint256 cd = settingManagement.getPoolConfigs("cooldownDuration");
        cooldowns[msg.sender] = UserCooldown({
            cooldownEnd: uint104(block.timestamp + cd),
            underlyingAmount: uint152(assets)
        });
        emit CooldownStarted(msg.sender, assets, block.timestamp + cd);
    }

    function cooldownShares(uint256 shares) external override nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _withdraw(msg.sender, silo, msg.sender, assets, shares);

        uint256 cd = settingManagement.getPoolConfigs("cooldownDuration");
        cooldowns[msg.sender] = UserCooldown({
            cooldownEnd: uint104(block.timestamp + cd),
            underlyingAmount: uint152(assets)
        });
        emit CooldownStarted(msg.sender, assets, block.timestamp + cd);
    }

    function unstake(address receiver) external override nonReentrant {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        if (block.timestamp < cd.cooldownEnd) revert CooldownNotFinished();

        uint256 assets = cd.underlyingAmount;
        delete cooldowns[msg.sender];

        (bool success,) = silo.call(
            abi.encodeWithSignature("withdraw(address,uint256)", receiver, assets)
        );
        require(success, "Silo withdraw failed");

        emit Unstaked(msg.sender, receiver, assets);
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
    }

    function setRemainingRewards(uint256 amount) external onlyAdmin {
        remainingRewards = amount;
    }

    // ── Admin ──
    function setSettingManager(address newManager) external onlyAdmin {
        settingManagement = ISettingManagement(newManager);
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
