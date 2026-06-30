// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title sFYUSD — Staked FYUSD Earn receipt (model A; renamed from vFYUSD)
 * @notice The single user-facing Earn receipt for the model-A (hybrid) money
 *         path. Mint/burn-controlled: only the backend keeper (MINTER_ROLE)
 *         issues it on an Earn deposit, and only the keeper (BURNER_ROLE) burns
 *         it on redeem. 6-dec to match FYUSD. This is a plain controlled ERC-20
 *         receipt — it does NOT custody assets and is NOT an ERC-4626 vault; the
 *         Concrete position is held by the Safe-governed custody, and per-user
 *         yield is tracked in the backend ledger (paid in FYUSD at redeem).
 *
 *         Adds, vs the prior {VFyusd}:
 *           1. LOCK-GATED TRANSFERS — while a holder's lock-up is active the
 *              token is non-transferable between users; it becomes transferable
 *              once the lock elapses. Keeper mint (deposit) and burn (redeem)
 *              are always allowed, so the lock never blocks issuance/redemption.
 *              Locks are per-ADDRESS (the holder's longest active lock) and
 *              MONOTONIC — they can only be extended, never shortened, so a
 *              relayer can never cut a user's lock-up early.
 *           2. MANAGEMENT — pause/unpause (PAUSER_ROLE) and rescueTokens
 *              (DEFAULT_ADMIN_ROLE) for ops/safety.
 *
 *         DEFAULT_ADMIN_ROLE (deployer → transferred to the Operator Safe)
 *         curates the MINTER/BURNER/PAUSER/LOCKER roles.
 */
contract StakedFYUSD is ERC20, ERC20Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Records/extends lock-ups (the backend gas-relayer at deposit time).
    bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE");

    uint8 private immutable _decimalsValue;

    /// @notice Per-address unlock timestamp. While `block.timestamp < userUnlockAt[a]`
    ///         the holder `a` cannot transfer (mint by the keeper and burn on
    ///         redeem are exempt). 0 = never locked. Monotonic — only extended.
    mapping(address => uint64) public userUnlockAt;

    event LockSet(address indexed user, uint64 unlockAt);

    error TransferLocked(address from, uint64 unlockAt);
    error LengthMismatch();

    /**
     * @param name_     e.g. "Staked FYUSD"
     * @param symbol_   e.g. "sFYUSD"
     * @param decimals_ 6 (match FYUSD)
     * @param admin     DEFAULT_ADMIN_ROLE holder (deployer; transfer to Safe later)
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin)
        ERC20(name_, symbol_)
    {
        require(admin != address(0), "admin=0");
        _decimalsValue = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimalsValue;
    }

    // ── keeper mint / burn ──────────────────────────────────────────────

    /// @notice Keeper issues sFYUSD on an Earn deposit.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Keeper burns sFYUSD on redeem (no allowance needed). Allowed even
    ///         while the holder is locked — redemption is gated by the backend,
    ///         not by the transfer lock.
    function burnByKeeper(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    // ── lock-up ─────────────────────────────────────────────────────────

    /// @notice Record/extend a holder's lock-up (monotonic: never shortens).
    ///         Called by the backend at deposit time with `depositTime + tenure`.
    function setLock(address user, uint64 unlock) external onlyRole(LOCKER_ROLE) {
        _setLock(user, unlock);
    }

    /// @notice Batch variant — used by the migration to seed existing holders'
    ///         original unlock times in one pass.
    function setLockBatch(address[] calldata users, uint64[] calldata unlocks)
        external
        onlyRole(LOCKER_ROLE)
    {
        if (users.length != unlocks.length) revert LengthMismatch();
        for (uint256 i; i < users.length; ++i) {
            _setLock(users[i], unlocks[i]);
        }
    }

    function _setLock(address user, uint64 unlock) internal {
        if (unlock > userUnlockAt[user]) {
            userUnlockAt[user] = unlock;
            emit LockSet(user, unlock);
        }
    }

    /// @notice True if `user` can transfer right now (lock elapsed or unset).
    function isTransferable(address user) external view returns (bool) {
        uint64 u = userUnlockAt[user];
        return u == 0 || block.timestamp >= u;
    }

    // ── management ──────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Rescue ERC-20s accidentally sent to this contract. This is a
    ///         receipt token and never holds assets, so there is nothing to
    ///         exclude.
    function rescueTokens(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        IERC20(token).safeTransfer(to, amount);
    }

    // ── transfer gate (OZ v5 _update hook) ──────────────────────────────

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        // Lock-gate user→user transfers. Mint (from == 0) and burn (to == 0) —
        // the keeper's deposit/redeem ops — are exempt, so the lock can never
        // block issuance or redemption.
        if (from != address(0) && to != address(0)) {
            uint64 u = userUnlockAt[from];
            if (u != 0 && block.timestamp < u) revert TransferLocked(from, u);
        }
        super._update(from, to, value);
    }
}
