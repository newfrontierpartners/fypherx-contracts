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
import "./RUSDSilo.sol";

/**
 * @title StakedRUSD (sRUSD)
 * @notice Primary retail staking vault for RUSD using ERC-4626.
 *         APR-based reward distribution with an 8-hour linear release
 *         window (see FYP-21 note below). Cooldown mechanism: assets
 *         held in RUSDSilo during the cooldown period.
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0x2c048e01ebf957f7Ab66C3a09E85Ae31db7803D6
 *      Implementation: 0xd9c9f728dc7d5e81e2df406b82fe2540f2d484f3
 *
 * @dev <b>FYP-21 — reward terminology decision</b>. CertiK flagged
 *      that the "vesting" terminology used by {vestingAmount},
 *      {_unvestedAmount}, and {VESTING_PERIOD} misrepresents how
 *      rewards are distributed. The intended model is the Ethena
 *      sUSDe pattern — rewards STREAM to whichever addresses hold
 *      sRUSD shares during the 8-hour release window, including
 *      depositors who joined after {transferInRewards} was called.
 *      They are NOT "vested" to a fixed cohort of pre-existing
 *      stakers.
 *
 *      The identifiers are intentionally retained (rather than
 *      renamed to {unreleasedRewards} / {_unreleasedAmount} /
 *      {REWARD_RELEASE_PERIOD}) for two reasons:
 *      (a) TransparentProxy storage layout safety — the contract
 *          is live on a testnet proxy and a slot-name change risks
 *          accidental layout reordering on the next compile;
 *      (b) backend Web3j bindings + indexers key off the current
 *          names. Renaming would require a coordinated cutover with
 *          fypherx-gateway / fypherx-risk-service.
 *
 *      The semantic clarification lives in this docstring and in
 *      the per-function NatSpec on {totalAssets} and
 *      {transferInRewards} below. Integrators must read those notes
 *      to understand the streaming semantics — the names alone are
 *      legacy.
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
    /// @notice Floor for the cooldown duration when SettingManagement
    ///         returns 0 for `"cooldownDuration"`. Without this floor
    ///         (FYP-37 patch), an unset config silently turned the
    ///         vault into a no-cooldown vault — staking became
    ///         instantly exit-able the moment a user called
    ///         {cooldownAssets}. 7 days matches the README's stated
    ///         retail-staking cooldown.
    uint256 public constant DEFAULT_COOLDOWN = 7 days;
    // April-audit L-2 patch. The legacy `MIN_SHARES = 1` constant was
    // declared here but never read by any function. The intended
    // first-depositor inflation guard belongs in OZ ERC4626's
    // `_decimalsOffset()` override (which we deliberately do NOT
    // change in this contract — see the comment on {_decimalsOffset}
    // below), so the dead constant has been removed.

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
    /// @notice FYP-60 patch.
    event RemainingRewardsUpdated(uint256 amount);

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
    /// @notice FYP-06: the immediate-exit ERC-4626 path is disabled.
    ///         Users must exit via {cooldownAssets} / {cooldownShares}
    ///         and {unstake} (or {earlyUnstake} with a fee).
    error CooldownRequired();
    /// @notice FYP-30 / FYP-43. The user's cooldown is either ready to
    ///         unstake (call {unstake} instead of paying the early-
    ///         exit fee) or has not been started.
    error ExistingCooldownReady();

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
     *         from the share price during its 8-hour linear release.
     *
     * @dev <b>Reward semantics</b> (FYP-21 clarification). Rewards
     *      funded via {transferInRewards} are STREAMED to whichever
     *      addresses hold sRUSD shares during the release window —
     *      they are NOT vested to a fixed set of pre-existing
     *      stakers. New depositors during the window legitimately
     *      participate in the unreleased portion as it linearly
     *      decays. The "vestingAmount" / "_unvestedAmount" /
     *      "VESTING_PERIOD" identifiers are retained for backend
     *      Web3j-binding stability, but their semantics are
     *      "unreleased rewards being streamed", not "vested cohort
     *      attribution".
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

    /**
     * @notice ERC-4626 mint() override. Mirrors {deposit} guards.
     * @dev FYP-02 patch. The previous implementation inherited
     *      ERC4626.mint unchanged, which let callers enter the vault
     *      while bypassing {nonReentrant}, {whenNotPaused},
     *      {notRestricted(receiver)}, and {userStakedAmount}
     *      accounting. The fix is a thin pass-through that applies
     *      the same modifier set as deposit() and posts the asset-
     *      equivalent of the minted shares into the principal
     *      counter.
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
     * @dev FYP-06 patch. The previous shape simply forwarded to
     *      `super.withdraw`, which let users skip the cooldown
     *      entirely. The cooldown flow uses the *internal*
     *      `_withdraw` (see {cooldownAssets}) so this override does
     *      not affect it.
     */
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert CooldownRequired();
    }

    /// @notice Mirror of {withdraw} for the redeem entry-point. See above.
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert CooldownRequired();
    }

    /// @notice ERC-4626 advertisement that no immediate withdraw is
    ///         available; integrators that respect maxWithdraw should
    ///         skip this vault for synchronous exits and route through
    ///         the cooldown flow instead.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice ERC-4626 advertisement that no immediate redeem is
    ///         available. See {maxWithdraw}.
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice ERC-4626 advertisement that no synchronous withdraw is
    ///         available. Mirrors {maxWithdraw} so integrators that
    ///         consult the preview surface do not receive a misleading
    ///         non-zero conversion. The cooldown flow uses the internal
    ///         {_convertToShares} directly so this override does not
    ///         affect it.
    /// @dev FYP-06 lingering. CertiK noted the original FYP-06 patch
    ///      left {previewWithdraw}/{previewRedeem} returning real
    ///      conversion numbers (because {cooldownAssets}/{cooldownShares}
    ///      and the legacy {_update} transfer hook re-used them). The
    ///      internal callers have been migrated to {_convertToShares}/
    ///      {_convertToAssets}, so the public preview surface can now
    ///      return 0 in lockstep with {maxWithdraw}/{maxRedeem}.
    function previewWithdraw(uint256) public pure override returns (uint256) {
        return 0;
    }

    /// @notice See {previewWithdraw}.
    function previewRedeem(uint256) public pure override returns (uint256) {
        return 0;
    }

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
        // FYP-06 lingering. Bypass {previewWithdraw} (now returns 0)
        // and use the OZ internal conversion directly. Math.Rounding.Ceil
        // matches the original {previewWithdraw} semantics: round shares
        // burned UP so the vault never short-withdraws against the asset
        // amount it just owes the user.
        uint256 shares = _convertToShares(assets, Math.Rounding.Ceil);
        _withdraw(msg.sender, address(silo), msg.sender, assets, shares);
        _debitUserStaked(msg.sender, assets);

        _accrueCooldown(msg.sender, assets);
    }

    function cooldownShares(uint256 shares) external override nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        // FYP-06 lingering. See {cooldownAssets}. Math.Rounding.Floor
        // matches the original {previewRedeem} semantics: round assets
        // returned DOWN so the vault never over-pays out per share.
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
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
        UserCooldown storage cd = cooldowns[user];
        // FYP-43 patch. If the user has an already-claimable cooldown
        // sitting in the silo, refuse to merge a new amount on top —
        // doing so would push the existing balance's release date out
        // to the new cooldownEnd, re-locking principal the user could
        // already withdraw via {unstake}. The user must claim the
        // ready cooldown first, then start a fresh one.
        if (cd.underlyingAmount > 0 && block.timestamp >= cd.cooldownEnd) {
            revert ExistingCooldownReady();
        }

        uint256 cooldownDuration = settingManagement.getPoolConfigs("cooldownDuration");
        if (cooldownDuration == 0) cooldownDuration = DEFAULT_COOLDOWN;  // FYP-37
        uint256 newEnd = block.timestamp + cooldownDuration;

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

    /**
     * @notice Pay the configured early-unstake fee to skip the
     *         remaining cooldown wait. Reverts if the cooldown has
     *         already elapsed (the user should call {unstake} instead
     *         and keep their full balance — FYP-30 patch).
     *
     * @dev FYP-33 patch. The fee receiver must NOT be this vault. If
     *      it were, the fee would land on `address(this)` and
     *      immediately appear in {totalAssets} (which reads
     *      `balanceOf(asset) - _unvestedAmount`), bypassing the
     *      8-hour streaming release. Operators are expected to
     *      configure feeReceiver to a treasury / reserve address
     *      instead.
     */
    function earlyUnstake(address receiver) external nonReentrant whenNotPaused {
        UserCooldown storage cd = cooldowns[msg.sender];
        if (cd.underlyingAmount == 0) revert NoCooldownStarted();
        if (block.timestamp >= cd.cooldownEnd) revert ExistingCooldownReady();

        address feeReceiver = settingManagement.getFeeReceiver();
        require(feeReceiver != address(this), "Vault cannot be its own fee receiver");

        uint256 assets = cd.underlyingAmount;
        uint256 fee = PoolMath.calculateFee(assets, settingManagement.getFees("earlyUnstakeFee"));
        uint256 netAssets = assets - fee;
        delete cooldowns[msg.sender];

        silo.withdraw(receiver, netAssets);
        if (fee > 0) {
            silo.withdraw(feeReceiver, fee);
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
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newAPR == currentAPRRate) return;
        currentAPRRate = newAPR;
        emit APRUpdated(newAPR);
    }

    function setRemainingRewards(uint256 amount) external onlyAdmin {
        if (amount == remainingRewards) return;
        remainingRewards = amount;
        emit RemainingRewardsUpdated(amount);  // FYP-60
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
    /**
     * @dev FYP-03 patch + FYP-03 lingering patch (May 2026).
     *
     *      <p>Original FYP-03 problem: the previous body was a plain
     *      pass-through to the parent ERC20/Pausable _update. An
     *      unrestricted holder could route freshly-deposited sRUSD
     *      shares to a restricted address by plain ERC-20 transfer,
     *      and `userStakedAmount` stayed attached to the original
     *      depositor — off-chain dashboards reported the stake on the
     *      wrong account. The first patch added the `notRestricted(to)`
     *      gate and moved a NAV-equivalent `previewRedeem(value)`
     *      worth of principal from sender to recipient.
     *
     *      <p>Why this second revision (FYP-03 lingering, CertiK May
     *      2026): NAV-equivalent move included accrued rewards as
     *      "principal" on the recipient side, most visibly when a
     *      user transferred to themselves and watched their
     *      `userStakedAmount` jump from `deposit principal` to
     *      `deposit principal + accrued rewards`. The new shape uses
     *      share-fraction math:
     *
     *        principalMoved = userStakedAmount[from] × value
     *                         / balanceOf(from)
     *
     *      computed against the PRE-transfer balance (super._update
     *      runs after our hook). Properties:
     *
     *      - Self-transfer of `balanceOf(from)` leaves
     *        userStakedAmount[from] unchanged (proportionate split
     *        of all principal returns to the same account).
     *      - Partial transfer splits principal proportionally with
     *        the shares moved.
     *      - principalMoved is bounded by userStakedAmount[from]
     *        because value ≤ balanceOf(from); no over-debit.
     *      - Reward accrual is reflected purely via share-price
     *        growth (totalAssets), never via the principal counter.
     *
     *      Mint and burn bypass both branches — mint accounting is
     *      done in {deposit}/{mint}, burn accounting is done in
     *      {cooldownAssets}/{cooldownShares} / {_debitUserStaked}.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
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
     * @notice ERC-4626 virtual-share offset, intentionally left at the
     *         OZ default of `0`.
     *
     * @dev April-audit L-2 patch (deferred). The first-depositor
     *      inflation surface that an offset of e.g. `6` would close is
     *      a *known* low-severity issue; flipping it after the vault
     *      already has a non-zero `totalSupply` would dilute every
     *      existing share by the offset factor (`10**offset`) on the
     *      next conversion, which is operationally unsafe on a live
     *      vault. The fix is to deploy a fresh implementation with
     *      `_decimalsOffset() = 6` BEHIND a new proxy in the next
     *      deployment cycle, then migrate stake out of this proxy via
     *      cooldown/unstake. Keeping the override here as a documented
     *      no-op so future contributors do not silently re-introduce
     *      the change.
     */
    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 0;
    }
}
