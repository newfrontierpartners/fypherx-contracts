// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title EarnLockRegistry
 * @notice On-chain lock-up registry for FypherX Earn (vFYUSD) positions.
 *
 *         When a user deposits into Earn they pick a lock-up tenure
 *         (30 / 60 / 90 days). The backend gas-relayer — an authorized
 *         {locker} — records that position's unlock timestamp here at deposit
 *         time. The Earn redeem keeper calls {isUnlocked} before processing a
 *         redemption, so the user's chosen lock-up is enforced ON-CHAIN, not
 *         just by the off-chain redeem gate.
 *
 * @dev Intentionally minimal + non-upgradeable: it holds no funds, only the
 *      unlock schedule keyed by a position reference (bytes32, e.g.
 *      keccak256 of the Earn position id). Locks are write-once and can never
 *      be shortened, which protects the user from a relayer that tries to cut
 *      a lock-up early. Owner can rotate the relayer/locker set; the lock data
 *      itself is immutable once written.
 */
contract EarnLockRegistry {
    /// @notice Contract admin (rotates lockers; cannot alter existing locks).
    address public owner;

    /// @notice Addresses allowed to record locks (the backend relayer).
    mapping(address => bool) public lockers;

    /// @notice positionRef => unix timestamp the lock-up elapses.
    mapping(bytes32 => uint64) public unlockAt;

    /// @notice positionRef => the user the lock belongs to (audit/reference).
    mapping(bytes32 => address) public lockUserOf;

    event LockSet(bytes32 indexed ref, address indexed user, uint64 unlockAt);
    event LockerSet(address indexed locker, bool allowed);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error NotLocker();
    error AlreadySet();
    error ZeroUnlock();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        lockers[msg.sender] = true;
        emit OwnerSet(msg.sender);
        emit LockerSet(msg.sender, true);
    }

    /// @notice Transfer admin. Existing locks are unaffected.
    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    /// @notice Grant/revoke a relayer's ability to record locks.
    function setLocker(address locker, bool allowed) external onlyOwner {
        if (locker == address(0)) revert ZeroAddress();
        lockers[locker] = allowed;
        emit LockerSet(locker, allowed);
    }

    /**
     * @notice Record a lock-up for an Earn position. Write-once: a ref can be
     *         set exactly once, and the lock can never be shortened afterwards.
     * @param ref     position reference (e.g. keccak256 of the position id)
     * @param user    the position owner (for audit; not used for gating)
     * @param unlock  unix timestamp the lock-up elapses (deposit + tenure)
     */
    function setLock(bytes32 ref, address user, uint64 unlock) external {
        if (!lockers[msg.sender]) revert NotLocker();
        if (unlock == 0) revert ZeroUnlock();
        if (unlockAt[ref] != 0) revert AlreadySet();
        unlockAt[ref] = unlock;
        lockUserOf[ref] = user;
        emit LockSet(ref, user, unlock);
    }

    /// @notice True once the lock-up has elapsed (or no lock was ever set).
    function isUnlocked(bytes32 ref) external view returns (bool) {
        uint64 u = unlockAt[ref];
        return u == 0 || block.timestamp >= u;
    }

    /// @notice Seconds remaining on the lock-up (0 if unlocked / unset).
    function remaining(bytes32 ref) external view returns (uint64) {
        uint64 u = unlockAt[ref];
        if (u == 0 || block.timestamp >= u) return 0;
        return u - uint64(block.timestamp);
    }
}
