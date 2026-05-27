// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISettingManagement.sol";

/**
 * @title FypherStakingHub
 * @notice Phase 1 unified staking vault with sub-pools (PHASE1_SPEC §3.3,
 *         ADR-003). Replaces the per-token vaults StakedRUSD + stAUSD.
 *
 *         Pool layout (set up at deploy time via {addPool}):
 *           pools[0] = RUSD,  weightBps = 10_000  (1x)
 *           pools[1] = FYUSD, weightBps = 20_000  (2x)
 *
 *         Reward emissions accrue per block, weighted by pool:
 *
 *           rewardPerBlock_pool = fpyPerBlock × pool.weightBps / totalAllocBps
 *           accFpyPerShare_pool += rewardPerBlock_pool × 1e18 / pool.totalStaked
 *           pendingFpy(user, pool) = stake.amount × accFpyPerShare / 1e18 - stake.fpyDebt
 *
 *         The "FYP_per_block × pool_weight × user_share" formula in the
 *         spec collapses to MasterChef-style accumulator math.
 *
 *         Per-pool pause is pauser-or-admin (ADR-008); unpause is admin-only.
 *
 *         No cooldown in v1 — spec marks cooldown "별도 결정". A future
 *         withdrawal-queue contract can wrap this if needed.
 *
 * @dev Upgradeable (TransparentProxy). Tracked decisions: ADR-003,
 *      ADR-007 (pauser carve-out), ADR-008 (per-pool pause).
 *
 * @dev <b>FYP-49 — FPY / FYP naming decision</b>. CertiK noted that
 *      the hub uses {fpy}, {fpyPerBlock}, {pendingFpy},
 *      {accFpyPerShare}, {fpyDebt}, {InsufficientFpy}, etc., while
 *      the protocol's governance token is named "FYP" (not "FPY").
 *      The mismatch is historical: an early draft of the spec used
 *      FPY before the token was renamed FYP. The internal identifiers
 *      are intentionally retained because:
 *      (a) the storage slots are live in the deployed proxy; renaming
 *          the SLOTS is unsafe across an upgrade,
 *      (b) the function selectors are baked into backend Web3j
 *          bindings (fypherx-risk-service.staking.* calls) and
 *          renaming the SELECTORS would require a coordinated cutover.
 *      The on-chain token address resolves to FYP regardless — the
 *      {fpy} field accepts whatever IERC20 the initializer was given.
 *      Frontend / docs should use "FYP" consistently; the hub's
 *      internal names are a closed implementation detail.
 */
contract FypherStakingHub is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 private constant ACC_PRECISION = 1e18;

    // ── Types ──

    struct Pool {
        IERC20  underlying;
        uint256 totalStaked;
        uint64  weightBps;          // 10_000 = 1x
        uint64  lastAccrualBlock;
        uint256 accFpyPerShare;     // scaled by ACC_PRECISION
        bool    paused;
    }

    struct UserStake {
        uint256 amount;
        uint256 fpyDebt;            // user.amount × accFpyPerShare / ACC_PRECISION at last touch
    }

    // ── Storage ──

    ISettingManagement public settingManagement;
    IERC20             public fpy;
    address            public pauserRole;

    /// @notice Per-block FPY released across all pools, allocated by weight.
    uint256 public fpyPerBlock;

    /// @notice Sum of all pools' weightBps. Recomputed on add/setPoolWeight.
    uint256 public totalAllocBps;

    Pool[] private _pools;
    mapping(uint256 => mapping(address => UserStake)) private _stakes;

    // ── Storage append (FYP-58 patch — APPEND-ONLY for proxy safety) ──
    /**
     * @notice Accrued-but-unpaid FYP rewards per user, across every
     *         pool. {stake} / {unstake} / {migrate} accrue into this
     *         pot without attempting a transfer; the live transfer
     *         happens only in {claim} / {claimRewards}, which
     *         tolerate an under-funded hub.
     *
     * @dev FYP-58 patch. The previous shape settled rewards inline
     *      via {_payFpy} on every principal-changing call, so a
     *      hub balance dip below the user's pending amount reverted
     *      {unstake} — trapping principal until ops re-funded.
     *      Decoupling the settlement from the transfer makes
     *      principal moves balance-independent; rewards just wait
     *      in {pendingFpyRewards} until the hub is funded.
     */
    mapping(address => uint256) public pendingFpyRewards;

    // ── Events ──

    event PoolAdded(uint256 indexed poolId, address indexed underlying, uint64 weightBps);
    event PoolWeightUpdated(uint256 indexed poolId, uint64 oldWeightBps, uint64 newWeightBps);
    event PoolPausedSet(uint256 indexed poolId, bool paused);
    event FpyPerBlockUpdated(uint256 oldRate, uint256 newRate);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event Staked(uint256 indexed poolId, address indexed user, uint256 amount);
    event Unstaked(uint256 indexed poolId, address indexed user, uint256 amount);
    event RewardsClaimed(uint256 indexed poolId, address indexed user, uint256 amount);
    event Migrated(uint256 indexed poolId, address indexed user, uint256 amount);
    event FpyFunded(address indexed from, uint256 amount);
    /// @notice FYP-58 patch. Emitted whenever {_settlePending} moves
    ///         pending FYP from a pool's accumulator into the
    ///         user-level {pendingFpyRewards} pot (without paying).
    event RewardsAccrued(uint256 indexed poolId, address indexed user, uint256 amount);

    // ── Errors ──

    error NotAdmin();
    error NotPauserOrAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error PoolNotFound(uint256 poolId);
    error PoolAlreadyExists(address underlying);
    error PoolPausedErr(uint256 poolId);
    error InsufficientStake(uint256 have, uint256 want);
    error LengthMismatch();
    error InsufficientFpy(uint256 have, uint256 want);
    /// @notice FYP-30: addPool refuses an underlying that equals the
    ///         reward token — the hub would conflate user principal
    ///         with reward inventory in the same ERC-20 balance, and
    ///         reward payments could chew into staked principal.
    error UnderlyingIsRewardToken();

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _fpy,
        uint256 _fpyPerBlock
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_fpy) == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        settingManagement = _settingManagement;
        fpy = _fpy;
        fpyPerBlock = _fpyPerBlock;
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

    modifier validPool(uint256 poolId) {
        if (poolId >= _pools.length) revert PoolNotFound(poolId);
        _;
    }

    // ── Admin: pool setup ──

    /**
     * @dev FYP-05 patch. Settle EVERY existing pool under the current
     *      `totalAllocBps` before mutating it. The previous shape
     *      only initialised the new pool's `lastAccrualBlock` to the
     *      current block; existing pools kept their stale snapshot
     *      and, on the next accrual, repriced their entire elapsed
     *      window under the new (higher) `totalAllocBps`,
     *      under-paying them. Mass-update matches the pattern already
     *      used by {setFpyPerBlock}.
     */
    function addPool(IERC20 underlying, uint64 weightBps) external onlyAdmin returns (uint256 poolId) {
        if (address(underlying) == address(0)) revert ZeroAddress();
        // FYP-30: refuse to bind the pool's principal to the reward
        // token. The hub holds reward inventory in `fpy.balanceOf
        // (address(this))`; if user-staked principal accumulates in
        // the same balance, {_payFpy} could pay out principal as
        // rewards and {unstake} could fail because the reward sink
        // already drained the principal.
        if (address(underlying) == address(fpy)) revert UnderlyingIsRewardToken();
        // FYP-38: cache .length so the duplicate check and the settle
        // sweep share a single SLOAD.
        uint256 n = _pools.length;
        // Reject duplicate underlying — operator error guard.
        for (uint256 i = 0; i < n; ++i) {
            if (address(_pools[i].underlying) == address(underlying)) revert PoolAlreadyExists(address(underlying));
        }
        // Settle every existing pool under the old totalAllocBps
        // before we change it. Without this, every still-unsettled
        // pool would later have its accrued window repriced at the
        // new denominator (FYP-05 PoC).
        for (uint256 i = 0; i < n; ++i) _updatePool(i);

        _pools.push(Pool({
            underlying: underlying,
            totalStaked: 0,
            weightBps: weightBps,
            lastAccrualBlock: uint64(block.number),
            accFpyPerShare: 0,
            paused: false
        }));
        totalAllocBps += weightBps;
        poolId = _pools.length - 1;
        emit PoolAdded(poolId, address(underlying), weightBps);
    }

    /**
     * @dev FYP-05 patch. Settle EVERY pool — not just the edited one —
     *      under the current `totalAllocBps` before mutating either
     *      the pool's weight or the global denominator. The
     *      previous shape only called {_updatePool(poolId)}, so other
     *      pools' next accrual call would reprice their stale window
     *      under the new totalAllocBps, breaking emission
     *      conservation (FYP-05 PoC reproduces both over- and
     *      under-payment cases).
     */
    function setPoolWeight(uint256 poolId, uint64 newWeightBps)
        external
        onlyAdmin
        validPool(poolId)
    {
        Pool storage p = _pools[poolId];
        uint64 old = p.weightBps;
        // FYP-39: no-op early-return BEFORE settling every pool, so a
        // dashboard "set weight to same value" tx pays neither the
        // mass-update gas nor the SSTORE.
        if (newWeightBps == old) return;
        uint256 n = _pools.length;
        for (uint256 i = 0; i < n; ++i) _updatePool(i);
        totalAllocBps = totalAllocBps - old + newWeightBps;
        p.weightBps = newWeightBps;
        emit PoolWeightUpdated(poolId, old, newWeightBps);
    }

    function setFpyPerBlock(uint256 newRate) external onlyAdmin {
        // FYP-39: no-op early-return BEFORE the mass-update.
        if (newRate == fpyPerBlock) return;
        // Settle every pool under the OLD rate so users get the rewards
        // accrued at the previous emission level.
        uint256 n = _pools.length;
        for (uint256 i = 0; i < n; ++i) _updatePool(i);
        emit FpyPerBlockUpdated(fpyPerBlock, newRate);
        fpyPerBlock = newRate;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        // FYP-25: reject zero pauser (silent footgun — zero is the
        // default empty slot, re-setting to zero is almost always a
        // typo).
        if (newPauser == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newPauser == pauserRole) return;
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }

    function setPoolPaused(uint256 poolId, bool paused)
        external
        onlyPauserOrAdmin
        validPool(poolId)
    {
        if (!paused) {
            // Unpause = admin only (ADR-007).
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        _pools[poolId].paused = paused;
        emit PoolPausedSet(poolId, paused);
    }

    // ── Admin: migration (ADR-003 §"Migration mechanics", B-4-A) ──

    /**
     * @notice One-shot migration from the legacy StakedRUSD / stAUSD vaults.
     *         Caller (admin / multisig) MUST have already pulled the
     *         underlying from the old vault and approved this hub for the
     *         sum of `amounts`. The hub `safeTransferFrom`s the total in
     *         and credits each user's stake position.
     *
     *         The accrual snapshot is taken before crediting so that
     *         migrated users do not retroactively earn rewards for blocks
     *         that elapsed before they joined.
     *
     * @dev FYP-58 patch. Any pending FYP from a prior position is now
     *      accrued into {pendingFpyRewards} instead of paid inline,
     *      so an under-funded hub does not revert the whole migration
     *      batch. Users claim later through {claim} or {claimRewards}.
     */
    function migrate(
        uint256 poolId,
        address[] calldata users,
        uint256[] calldata amounts
    ) external onlyAdmin nonReentrant validPool(poolId) {
        if (users.length != amounts.length) revert LengthMismatch();
        _updatePool(poolId);

        Pool storage p = _pools[poolId];
        // FYP-38: cache .length — calldata read once.
        uint256 batchLen = users.length;
        uint256 total;
        for (uint256 i = 0; i < batchLen; ++i) {
            total += amounts[i];
        }
        if (total == 0) revert ZeroAmount();
        p.underlying.safeTransferFrom(msg.sender, address(this), total);

        for (uint256 i = 0; i < batchLen; ++i) {
            address u = users[i];
            uint256 amt = amounts[i];
            if (u == address(0)) revert ZeroAddress();
            if (amt == 0) continue;

            UserStake storage s = _stakes[poolId][u];
            // Settle any prior position before adding (idempotent
            // migration). FYP-58: accrue into the pull-claim pot
            // instead of paying inline.
            uint256 pending = _pendingNoUpdate(p, s);
            if (pending > 0) {
                pendingFpyRewards[u] += pending;
                emit RewardsAccrued(poolId, u, pending);
            }
            s.amount += amt;
            s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
            emit Migrated(poolId, u, amt);
        }
        p.totalStaked += total;
    }

    // ── User actions ──

    /**
     * @dev FYP-58 patch. Any pending FYP rewards from prior accrual
     *      are routed into the user-level {pendingFpyRewards} pot
     *      via {_settlePending}, NOT into an inline {_payFpy} call.
     *      stake() therefore proceeds regardless of the hub's
     *      current FYP balance.
     */
    function stake(uint256 poolId, uint256 amount)
        external
        nonReentrant
        validPool(poolId)
    {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _pools[poolId];
        if (p.paused) revert PoolPausedErr(poolId);

        _settlePending(poolId, msg.sender);

        UserStake storage s = _stakes[poolId][msg.sender];
        p.underlying.safeTransferFrom(msg.sender, address(this), amount);
        s.amount += amount;
        p.totalStaked += amount;
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;

        emit Staked(poolId, msg.sender, amount);
    }

    /**
     * @dev FYP-58 patch. unstake() now always returns principal even
     *      when the hub is under-funded for the user's accrued
     *      rewards — the pending reward stays in {pendingFpyRewards}
     *      until the next funding event. Pre-patch behaviour reverted
     *      with {InsufficientFpy}, trapping principal.
     */
    function unstake(uint256 poolId, uint256 amount)
        external
        nonReentrant
        validPool(poolId)
    {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _pools[poolId];
        // NOTE: pause does not block unstake — we don't trap user funds.

        _settlePending(poolId, msg.sender);

        UserStake storage s = _stakes[poolId][msg.sender];
        if (s.amount < amount) revert InsufficientStake(s.amount, amount);

        s.amount -= amount;
        p.totalStaked -= amount;
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
        p.underlying.safeTransfer(msg.sender, amount);

        emit Unstaked(poolId, msg.sender, amount);
    }

    /**
     * @notice Settle any unpaid emissions from `poolId` for the caller
     *         and then attempt to drain {pendingFpyRewards[caller]}
     *         out to the caller. Tolerates an under-funded hub by
     *         paying out what's available and leaving the rest
     *         booked for a later claim (FYP-58).
     */
    function claim(uint256 poolId)
        external
        nonReentrant
        validPool(poolId)
        returns (uint256 paid)
    {
        _settlePending(poolId, msg.sender);
        paid = _payOutPending(msg.sender);
        if (paid > 0) emit RewardsClaimed(poolId, msg.sender, paid);
    }

    /**
     * @notice Settle every pool the caller has a position in and pay
     *         out the accumulated {pendingFpyRewards} balance.
     *         Convenience entry-point so users with positions across
     *         multiple pools do not have to call {claim} per-pool.
     *
     * @dev FYP-58 patch. New addition; pairs with {claim} as a
     *      single-call drain across all pools.
     */
    function claimRewards() external nonReentrant returns (uint256 paid) {
        uint256 nPools = _pools.length;
        for (uint256 i = 0; i < nPools; ++i) {
            _settlePending(i, msg.sender);
        }
        paid = _payOutPending(msg.sender);
        // Use poolId == type(uint256).max as the "cross-pool" sentinel
        // so the indexer can distinguish from per-pool claims.
        if (paid > 0) emit RewardsClaimed(type(uint256).max, msg.sender, paid);
    }

    /**
     * @notice Permissionless top-up of FPY treasury inside the hub. Used
     *         by ops to keep claim() from reverting when the hub's FPY
     *         balance dips below pending claims.
     */
    function fundFpy(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        fpy.safeTransferFrom(msg.sender, address(this), amount);
        emit FpyFunded(msg.sender, amount);
    }

    // ── View ──

    function poolsLength() external view returns (uint256) {
        return _pools.length;
    }

    function poolInfo(uint256 poolId)
        external
        view
        validPool(poolId)
        returns (
            address underlying,
            uint256 totalStaked,
            uint64  weightBps,
            uint64  lastAccrualBlock,
            uint256 accFpyPerShare,
            bool    paused
        )
    {
        Pool storage p = _pools[poolId];
        return (
            address(p.underlying),
            p.totalStaked,
            p.weightBps,
            p.lastAccrualBlock,
            p.accFpyPerShare,
            p.paused
        );
    }

    function userStake(uint256 poolId, address user)
        external
        view
        validPool(poolId)
        returns (uint256 amount, uint256 fpyDebt)
    {
        UserStake storage s = _stakes[poolId][user];
        return (s.amount, s.fpyDebt);
    }

    /// @notice Current pending FPY for a user in a specific pool (no
    ///         state change). Excludes the user-level
    ///         {pendingFpyRewards} pot — use {claimableRewards} for
    ///         a total-across-everything figure.
    function pendingFpy(uint256 poolId, address user)
        external
        view
        validPool(poolId)
        returns (uint256)
    {
        Pool storage p = _pools[poolId];
        UserStake storage s = _stakes[poolId][user];
        if (s.amount == 0) return 0;

        uint256 acc = p.accFpyPerShare;
        if (block.number > p.lastAccrualBlock && p.totalStaked > 0 && totalAllocBps > 0) {
            uint256 elapsed = block.number - p.lastAccrualBlock;
            uint256 reward = (elapsed * fpyPerBlock * p.weightBps) / totalAllocBps;
            acc += (reward * ACC_PRECISION) / p.totalStaked;
        }
        return (s.amount * acc) / ACC_PRECISION - s.fpyDebt;
    }

    /**
     * @notice Total FYP the user could claim right now: the
     *         {pendingFpyRewards} pot (already-settled rewards
     *         waiting for transfer) plus the per-pool projections
     *         from {pendingFpy} (rewards that would settle the next
     *         time the user touches each pool).
     *
     * @dev FYP-58 patch. New view for the pull-claim model — the
     *      backend / frontend should display this as the "claimable
     *      rewards" figure.
     */
    function claimableRewards(address user) external view returns (uint256 total) {
        total = pendingFpyRewards[user];
        uint256 nPools = _pools.length;
        for (uint256 i = 0; i < nPools; ++i) {
            Pool storage p = _pools[i];
            UserStake storage s = _stakes[i][user];
            if (s.amount == 0) continue;
            uint256 acc = p.accFpyPerShare;
            if (block.number > p.lastAccrualBlock && p.totalStaked > 0 && totalAllocBps > 0) {
                uint256 elapsed = block.number - p.lastAccrualBlock;
                uint256 reward = (elapsed * fpyPerBlock * p.weightBps) / totalAllocBps;
                acc += (reward * ACC_PRECISION) / p.totalStaked;
            }
            total += (s.amount * acc) / ACC_PRECISION - s.fpyDebt;
        }
    }

    // ── Internal ──

    /// @dev Brings pool.accFpyPerShare up to the current block.
    function _updatePool(uint256 poolId) internal {
        Pool storage p = _pools[poolId];
        if (block.number <= p.lastAccrualBlock) return;
        if (p.totalStaked == 0 || totalAllocBps == 0) {
            p.lastAccrualBlock = uint64(block.number);
            return;
        }
        uint256 elapsed = block.number - p.lastAccrualBlock;
        uint256 reward = (elapsed * fpyPerBlock * p.weightBps) / totalAllocBps;
        p.accFpyPerShare += (reward * ACC_PRECISION) / p.totalStaked;
        p.lastAccrualBlock = uint64(block.number);
    }

    function _pendingNoUpdate(Pool storage p, UserStake storage s) internal view returns (uint256) {
        if (s.amount == 0) return 0;
        return (s.amount * p.accFpyPerShare) / ACC_PRECISION - s.fpyDebt;
    }

    /**
     * @dev FYP-58 patch. Move any pool-level pending FYP for `user`
     *      into the user-level {pendingFpyRewards} pot. Does NOT
     *      transfer — the live transfer happens in {_payOutPending}
     *      which the public {claim} / {claimRewards} entry-points
     *      call. Stamping the fpyDebt here is mandatory so the next
     *      {_pendingNoUpdate} for this user/pool starts from zero.
     */
    function _settlePending(uint256 poolId, address user) internal {
        _updatePool(poolId);
        Pool storage p = _pools[poolId];
        UserStake storage s = _stakes[poolId][user];
        uint256 pending = _pendingNoUpdate(p, s);
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
        if (pending > 0) {
            pendingFpyRewards[user] += pending;
            emit RewardsAccrued(poolId, user, pending);
        }
    }

    /**
     * @dev FYP-58 patch. Pull-claim helper. Pays out as much of
     *      {pendingFpyRewards[user]} as the hub can afford, leaves
     *      the rest booked. Never reverts on under-funding — the
     *      whole point of the pull-claim refactor is that principal
     *      moves do not depend on the hub being fully funded.
     */
    function _payOutPending(address user) internal returns (uint256 paid) {
        uint256 pending = pendingFpyRewards[user];
        if (pending == 0) return 0;
        uint256 bal = fpy.balanceOf(address(this));
        if (bal == 0) return 0;
        paid = bal >= pending ? pending : bal;
        pendingFpyRewards[user] = pending - paid;
        fpy.safeTransfer(user, paid);
    }
}
