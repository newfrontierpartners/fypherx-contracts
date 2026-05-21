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
 *         FPY rewards accrue per block, weighted by pool:
 *
 *           rewardPerBlock_pool = fpyPerBlock × pool.weightBps / totalAllocBps
 *           accFpyPerShare_pool += rewardPerBlock_pool × 1e18 / pool.totalStaked
 *           pendingFpy(user, pool) = stake.amount × accFpyPerShare / 1e18 - stake.fpyDebt
 *
 *         The "FPY_per_block × pool_weight × user_share" formula in the
 *         spec collapses to MasterChef-style accumulator math.
 *
 *         Per-pool pause is pauser-or-admin (ADR-008); unpause is admin-only.
 *
 *         No cooldown in v1 — spec marks cooldown "별도 결정". A future
 *         withdrawal-queue contract can wrap this if needed.
 *
 * @dev Upgradeable (TransparentProxy). Tracked decisions: ADR-003,
 *      ADR-007 (pauser carve-out), ADR-008 (per-pool pause).
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
        // Reject duplicate underlying — operator error guard.
        for (uint256 i = 0; i < _pools.length; ++i) {
            if (address(_pools[i].underlying) == address(underlying)) revert PoolAlreadyExists(address(underlying));
        }
        // Settle every existing pool under the old totalAllocBps
        // before we change it. Without this, every still-unsettled
        // pool would later have its accrued window repriced at the
        // new denominator (FYP-05 PoC).
        uint256 n = _pools.length;
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
        uint256 n = _pools.length;
        for (uint256 i = 0; i < n; ++i) _updatePool(i);
        Pool storage p = _pools[poolId];
        uint64 old = p.weightBps;
        totalAllocBps = totalAllocBps - old + newWeightBps;
        p.weightBps = newWeightBps;
        emit PoolWeightUpdated(poolId, old, newWeightBps);
    }

    function setFpyPerBlock(uint256 newRate) external onlyAdmin {
        // Settle every pool under the OLD rate so users get the rewards
        // accrued at the previous emission level.
        uint256 n = _pools.length;
        for (uint256 i = 0; i < n; ++i) _updatePool(i);
        emit FpyPerBlockUpdated(fpyPerBlock, newRate);
        fpyPerBlock = newRate;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
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
     */
    function migrate(
        uint256 poolId,
        address[] calldata users,
        uint256[] calldata amounts
    ) external onlyAdmin nonReentrant validPool(poolId) {
        if (users.length != amounts.length) revert LengthMismatch();
        _updatePool(poolId);

        Pool storage p = _pools[poolId];
        uint256 total;
        for (uint256 i = 0; i < amounts.length; ++i) {
            total += amounts[i];
        }
        if (total == 0) revert ZeroAmount();
        p.underlying.safeTransferFrom(msg.sender, address(this), total);

        for (uint256 i = 0; i < users.length; ++i) {
            address u = users[i];
            uint256 amt = amounts[i];
            if (u == address(0)) revert ZeroAddress();
            if (amt == 0) continue;

            UserStake storage s = _stakes[poolId][u];
            // Settle any prior position before adding (idempotent migration).
            uint256 pending = _pendingNoUpdate(p, s);
            if (pending > 0) {
                _payFpy(u, pending);
                emit RewardsClaimed(poolId, u, pending);
            }
            s.amount += amt;
            s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
            emit Migrated(poolId, u, amt);
        }
        p.totalStaked += total;
    }

    // ── User actions ──

    function stake(uint256 poolId, uint256 amount)
        external
        nonReentrant
        validPool(poolId)
    {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _pools[poolId];
        if (p.paused) revert PoolPausedErr(poolId);

        _updatePool(poolId);
        UserStake storage s = _stakes[poolId][msg.sender];

        // Settle any pending rewards before changing the principal.
        uint256 pending = _pendingNoUpdate(p, s);
        if (pending > 0) {
            _payFpy(msg.sender, pending);
            emit RewardsClaimed(poolId, msg.sender, pending);
        }

        p.underlying.safeTransferFrom(msg.sender, address(this), amount);
        s.amount += amount;
        p.totalStaked += amount;
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;

        emit Staked(poolId, msg.sender, amount);
    }

    function unstake(uint256 poolId, uint256 amount)
        external
        nonReentrant
        validPool(poolId)
    {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _pools[poolId];
        // NOTE: pause does not block unstake — we don't trap user funds.

        _updatePool(poolId);
        UserStake storage s = _stakes[poolId][msg.sender];
        if (s.amount < amount) revert InsufficientStake(s.amount, amount);

        uint256 pending = _pendingNoUpdate(p, s);
        if (pending > 0) {
            _payFpy(msg.sender, pending);
            emit RewardsClaimed(poolId, msg.sender, pending);
        }

        s.amount -= amount;
        p.totalStaked -= amount;
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
        p.underlying.safeTransfer(msg.sender, amount);

        emit Unstaked(poolId, msg.sender, amount);
    }

    function claim(uint256 poolId)
        external
        nonReentrant
        validPool(poolId)
        returns (uint256 paid)
    {
        Pool storage p = _pools[poolId];
        _updatePool(poolId);
        UserStake storage s = _stakes[poolId][msg.sender];
        paid = _pendingNoUpdate(p, s);
        if (paid == 0) return 0;
        s.fpyDebt = (s.amount * p.accFpyPerShare) / ACC_PRECISION;
        _payFpy(msg.sender, paid);
        emit RewardsClaimed(poolId, msg.sender, paid);
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

    /// @notice Current pending FPY for a user (no state change).
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

    function _payFpy(address to, uint256 amount) internal {
        uint256 bal = fpy.balanceOf(address(this));
        if (bal < amount) revert InsufficientFpy(bal, amount);
        fpy.safeTransfer(to, amount);
    }
}
