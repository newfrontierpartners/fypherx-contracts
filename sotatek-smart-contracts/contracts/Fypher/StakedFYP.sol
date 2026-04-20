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
 * @title StakedFYP (sFYP)
 * @notice ERC4626 vault for FYP governance token staking.
 *         Same cooldown pattern as StakedRUSD.
 *
 * @dev Deployed at: 0xc9B0148A796b783284E254b395150a4b712Db223
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
    event SettingManagerUpdated(address indexed newManager);
    event SettingManagerProposed(address indexed newManager, uint256 eta);
    event SettingManagerProposalCancelled(address indexed cancelledManager);

    error NotAdmin();
    error NotRewarder();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error ZeroAddress();
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();

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
     * @notice Total assets backing the vault for share-pricing purposes.
     *         Returns `balance(asset) - _unvestedAmount()` so the still-
     *         locked portion of a recently-distributed reward is excluded
     *         from the share price during its 8-hour linear vesting.
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
     *
     * @dev April-audit L-1 patch. Same naming/semantics as the
     *      post-patch StakedRUSD helper.
     */
    function _unvestedAmount() internal view returns (uint256) {
        if (vestingAmount == 0) return 0;
        uint256 endsAt = _lastDistributionTimestamp + VESTING_PERIOD;
        if (block.timestamp >= endsAt) return 0;
        uint256 remaining = endsAt - block.timestamp;
        return (vestingAmount * remaining) / VESTING_PERIOD;
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

        // RUSDSilo pattern: withdraw(to, amount)
        (bool success,) = silo.call(
            abi.encodeWithSignature("withdraw(address,uint256)", receiver, assets)
        );
        require(success, "Silo withdraw failed");

        emit Unstaked(msg.sender, receiver, assets);
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
     * @dev April-audit C-3 patch. See StakedRUSD.proposeSettingManager
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

    function _update(address from, address to, uint256 value)
        internal override(ERC20Upgradeable, ERC20PausableUpgradeable)
    {
        super._update(from, to, value);
    }

    function decimals() public view override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }
}
