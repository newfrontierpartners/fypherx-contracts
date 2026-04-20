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
    uint256 public constant SETTING_MANAGER_TIMELOCK = 2 days;
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
    /**
     * @dev Reserved-but-unused. April-audit L-3. The cooldown flow uses
     *      `cooldowns` (UserCooldown struct) exclusively; no code path
     *      reads or writes this mapping. Kept for TransparentProxy
     *      storage-layout safety and so the slot is not accidentally
     *      reused in a future upgrade.
     */
    mapping(address => uint256) public unstakeRequests;

    // ── Storage (April-audit H-3 patch — APPEND-ONLY for proxy safety) ──
    /// @notice Pending replacement for `settingManagement`, awaiting timelock.
    ISettingManagement public pendingSettingManagement;
    /// @notice UNIX timestamp at which the pending replacement may be accepted.
    uint256 public pendingSettingManagerEta;

    // ── Events ──
    event RewardsReceived(uint256 amount);
    event CooldownStarted(address indexed user, uint256 assets, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    event EarlyUnstaked(address indexed user, address indexed receiver, uint256 assets, uint256 fee);
    event APRUpdated(uint256 newAPR);
    event SettingManagerUpdated(address indexed newManager);
    event SettingManagerProposed(address indexed newManager, uint256 eta);
    event SettingManagerProposalCancelled(address indexed cancelledManager);

    // ── Errors ──
    error NotAdmin();
    error NotRewarder();
    error CooldownNotFinished();
    error NoCooldownStarted();
    error ZeroAmount();
    error ZeroAddress();
    error RestrictedStaker(address account);
    error InsufficientCooldown();
    error TimelockNotElapsed(uint256 eta);
    error NoPendingManager();
    error AdminMismatch(address admin_);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the upgradeable vault.
     *
     * @dev April-audit H-2 / M-8 patch:
     *      - Reject zero addresses for `_rusd` and `_settingManagement`
     *        (silent zero-init would brick every modifier/transfer).
     *      - The `admin_` parameter exists for backward compatibility with
     *        the original deployment script. Rather than silently ignoring
     *        it (the previous behaviour, which generated a compile-time
     *        unused-parameter warning and gave a misleading impression of
     *        per-vault admin storage), we now sanity-check that
     *        `admin_` is registered as the default-admin role-holder
     *        inside `_settingManagement`. Failing this check at
     *        initialization catches the most common deploy-script bug
     *        — passing the wrong address — before users can deposit.
     *        We intentionally do **not** persist `admin_` anywhere; the
     *        canonical admin lookup remains
     *        `settingManagement.hasRole(bytes32(0), x)`.
     */
    function initialize(
        IERC20 _rusd,
        ISettingManagement _settingManagement,
        address admin_
    ) external initializer {
        if (address(_rusd) == address(0)) revert ZeroAddress();
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (!_settingManagement.hasRole(bytes32(0), admin_)) revert AdminMismatch(admin_);

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
    /**
     * @notice Total assets backing the vault for share-pricing purposes.
     *         Returns `balance(asset) - _unvestedAmount()` so the still-
     *         locked portion of a recently-distributed reward is excluded
     *         from the share price during its 8-hour linear vesting.
     *
     * @dev April-audit C-1 patch. The previous shape was
     *      `balance + calculateVestedAmount(...)` which (a) double-counted
     *      the just-transferred reward (it is already in `balance`) and
     *      (b) inverted the math direction. The Ethena sUSDe pattern is
     *      `balance - locked-portion`. The pre-patch version monotonically
     *      over-stated totalAssets by the cumulative `vestingAmount`,
     *      eventually breaking redeem solvency once the vault was asked
     *      to pay out more than it physically held.
     *
     *      The `unvested >= bal` guard is defensive: legacy on-chain state
     *      from the pre-patch implementation may carry an oversized
     *      `vestingAmount`. We saturate at 0 instead of underflowing a
     *      public view; the value heals naturally as `block.timestamp`
     *      moves past `_lastDistributionTimestamp + VESTING_PERIOD`.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        uint256 unvested = _unvestedAmount();
        if (unvested >= bal) return 0;
        return bal - unvested;
    }

    /**
     * @notice The portion of the latest reward cohort that is still locked
     *         (i.e. has not yet linearly vested). Returns 0 once the
     *         8-hour vesting period since the last `transferInRewards`
     *         has fully elapsed.
     *
     * @dev The function name now matches the body: it returns *unvested*
     *      (still-locked) rewards, not vested ones. The previous
     *      implementation delegated to `PoolMath.calculateVestedAmount`,
     *      whose return value is the *vested* (released) portion — the
     *      sign-flip was the C-1 root cause. We compute the locked
     *      remainder inline so the helper is self-explanatory and so the
     *      `PoolMath` library does not need a paired `calculateUnvested`
     *      twin.
     */
    function _unvestedAmount() internal view returns (uint256) {
        if (vestingAmount == 0) return 0;
        uint256 endsAt = _lastDistributionTimestamp + VESTING_PERIOD;
        if (block.timestamp >= endsAt) return 0;
        uint256 remaining = endsAt - block.timestamp;
        return (vestingAmount * remaining) / VESTING_PERIOD;
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
        uint256 ret = super.withdraw(assets, receiver, owner_);
        _debitUserStaked(owner_, assets);
        return ret;
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        uint256 assets = super.redeem(shares, receiver, owner_);
        _debitUserStaked(owner_, assets);
        return assets;
    }

    /**
     * @notice Reduce {userStakedAmount} by `assets`, clamping at 0.
     *
     * @dev April-audit M-4 patch. Previously {userStakedAmount} was
     *      strictly monotonically increasing — every deposit added but
     *      no withdraw subtracted. Off-chain dashboards that read it
     *      as "currently staked principal" therefore over-stated
     *      stake by the cumulative withdrawn amount. We clamp at 0
     *      because reward accrual means a withdrawal can return more
     *      assets than the user originally deposited; underflowing the
     *      principal counter for the difference is wrong, so the
     *      principal floor is 0.
     */
    function _debitUserStaked(address user, uint256 assets) internal {
        uint256 staked = userStakedAmount[user];
        userStakedAmount[user] = assets >= staked ? 0 : staked - assets;
    }

    // ── Cooldown ──
    /**
     * @notice Move `assets` worth of the caller's stake into the silo to
     *         start the cooldown clock. Multiple calls accumulate into a
     *         single cooldown bucket and EXTEND the cooldown end to the
     *         later of (existing end, now + cooldownDuration).
     *
     * @dev April-audit M-1 patch. The previous shape OVERWROTE
     *      `cooldowns[user]` on every call: a second {cooldownAssets}
     *      replaced `underlyingAmount` with the new amount only, so the
     *      previously-escrowed assets sat in the silo unrecoverable by
     *      the user (they'd been removed from `balanceOf` already by
     *      the first `_withdraw` and the cooldown record no longer
     *      claimed them).
     *
     * @dev April-audit M-2 patch. Now respects {whenNotPaused} so the
     *      admin can freeze cooldown intake during incident response,
     *      consistent with {deposit}/{withdraw}/{redeem}.
     */
    function cooldownAssets(uint256 assets) external override nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        _withdraw(msg.sender, address(silo), msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);

        _accrueCooldown(msg.sender, assets);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        _withdraw(msg.sender, address(silo), msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);

        _accrueCooldown(msg.sender, assets);
    }

    /**
     * @notice Internal accumulator for {cooldownAssets} / {cooldownShares}.
     *         Adds `assets` to the user's outstanding cooldown bucket and
     *         extends the cooldown end-timestamp to the later of (current
     *         end, `now + cooldownDuration`).
     */
    function _accrueCooldown(address user, uint256 assets) internal {
        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
        uint256 newEnd = block.timestamp + cooldownDuration;

        UserCooldown storage cd = cooldowns[user];
        uint256 newAmount = uint256(cd.underlyingAmount) + assets;
        // uint152 holds ~5.7e45 — comfortably above any realistic 18-decimal
        // stake balance. Defensive cast bound for L-4.
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

    function earlyUnstake(address receiver) external nonReentrant whenNotPaused {
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
    /**
     * @notice Transfer a new reward cohort into the vault. The caller
     *         must hold REWARDER_ROLE in SettingManagement.
     *
     * @dev April-audit C-1 patch. The previous shape did `vestingAmount +=
     *      amount` which (combined with the inverted `totalAssets` math)
     *      caused the share price to over-state by the running total of
     *      every distribution. Now we roll the still-unvested portion of
     *      the previous cohort into the new one and re-anchor the vesting
     *      start, so:
     *
     *        - locked rewards are never lost across distributions, and
     *        - `vestingAmount` always equals "the lock balance currently
     *           being unlocked from `_lastDistributionTimestamp`."
     *
     *      Combined with the new `totalAssets = balance - _unvestedAmount`
     *      shape, this makes share-price progression strictly monotone in
     *      the absence of withdrawals.
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

    /**
     * @notice Release a non-asset token that was sent to this vault by
     *         mistake (airdrops, wrong-token transfers, etc.) to an
     *         arbitrary recipient. Gated by RELEASE_TOKEN_ROLE.
     *
     * @dev Mirrors the `token != asset()` guard that {rescueTokens}
     *      already enforces. Without this check, any RELEASE_TOKEN_ROLE
     *      holder could call `releaseToken(asset, attacker, balance)`
     *      and drain every staker's underlying RUSD — a fund-loss path
     *      identified by the April audit (C-5).
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

    function rescueTokens(address token, address to, uint256 amount) external onlyAdmin {
        require(token != asset(), "Cannot rescue staked asset");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Stage a replacement {ISettingManagement}. The new manager
     *         only takes effect after `SETTING_MANAGER_TIMELOCK` has
     *         elapsed and {acceptSettingManager} is called.
     *
     * @dev April-audit H-3 patch. The previous one-shot
     *      `setSettingManager(addr)` allowed a compromised admin (or a
     *      single fat-fingered tx) to instantly swap the entire role
     *      authority of the vault — including the role authority that
     *      governs which addresses may stake, which may receive
     *      rewards, and even which is "the admin" itself. The new
     *      two-step shape gives off-chain monitors and a multisig
     *      review window time to react before the change is final.
     *      Calling this with the same `newManager` argument is a no-op
     *      restart of the timelock; calling it with `address(0)`
     *      cancels any pending proposal.
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

    /**
     * @notice Promote the pending {ISettingManagement} to live, once
     *         {SETTING_MANAGER_TIMELOCK} has elapsed since the proposal.
     */
    function acceptSettingManager() external onlyAdmin {
        if (address(pendingSettingManagement) == address(0)) revert NoPendingManager();
        if (block.timestamp < pendingSettingManagerEta) revert TimelockNotElapsed(pendingSettingManagerEta);
        settingManagement = pendingSettingManagement;
        delete pendingSettingManagement;
        delete pendingSettingManagerEta;
        emit SettingManagerUpdated(address(settingManagement));
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
