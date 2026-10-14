// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title vFYUSD — non-transferable ("soulbound") FYUSD Earn receipt (model A)
 * @notice The single user-facing Earn receipt for the model-A (hybrid) money
 *         path. Deployed with name/symbol "vFYUSD". Mint/burn-controlled: only
 *         the backend keeper (MINTER_ROLE) issues it on an Earn deposit, and only
 *         the keeper (BURNER_ROLE) burns it on redeem. 6-dec to match FYUSD. This
 *         is a plain controlled ERC-20 receipt — it does NOT custody assets and is
 *         NOT an ERC-4626 vault; the Concrete position is held by the Safe-governed
 *         custody, and per-user yield is tracked in the backend ledger.
 *
 *         Semantics (2026-07 revision — reverted from the transferable "sFYUSD"
 *         design back to a non-transferable vFYUSD):
 *           1. SOULBOUND — the receipt can NEVER be transferred between users, and
 *              users can never deposit it into another contract. The ONLY movements
 *              are the keeper's mint (from == 0, on deposit) and burn (to == 0, on
 *              redeem). This holds even after the lock-up elapses — there is no
 *              "becomes transferable" state anymore.
 *           2. LOCK-UP retained as REDEEM MATURITY — {userUnlockAt} still records
 *              the holder's 60/90/120-day unlock and is monotonic (only extended,
 *              never shortened). It is NOT used to gate transfers (those are always
 *              blocked); it is read off-chain by the backend to gate REDEMPTION —
 *              a holder can only redeem once their maturity has elapsed.
 *           3. MANAGEMENT — pause/unpause (PAUSER_ROLE) and rescueTokens
 *              (DEFAULT_ADMIN_ROLE) for ops/safety.
 *
 *         DEFAULT_ADMIN_ROLE (deployer → transferred to the Operator Safe)
 *         curates the MINTER/BURNER/PAUSER/LOCKER roles.
 *
 *         (Solidity contract name kept as {StakedFYUSD} to avoid churn in the
 *          deploy/migrate scripts + Web3j bindings; the on-chain symbol is vFYUSD.)
 */
contract StakedFYUSD is ERC20, ERC20Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Records/extends lock-ups (the backend gas-relayer at deposit time).
    bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE");

    uint8 private immutable _decimalsValue;

    /// @notice Per-address REDEEM-maturity timestamp. The holder can only redeem
    ///         once `block.timestamp >= userUnlockAt[a]` (enforced off-chain by the
    ///         backend). 0 = no maturity set. Monotonic — only extended. NOTE: this
    ///         does NOT control transfers — the receipt is soulbound, so transfers
    ///         are always blocked regardless of this value.
    mapping(address => uint64) public userUnlockAt;

    event LockSet(address indexed user, uint64 unlockAt);

    /// @notice The receipt is soulbound — user→user transfers are never allowed.
    error NonTransferable();
    error LengthMismatch();

    /**
     * @param name_     e.g. "Vault FYUSD"
     * @param symbol_   e.g. "vFYUSD"
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

    /// @notice Keeper issues vFYUSD on an Earn deposit.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Keeper burns vFYUSD on redeem (no allowance needed). The soulbound
    ///         transfer block does not apply to burns (to == 0), so the keeper can
    ///         always redeem; redemption timing is gated off-chain by the backend
    ///         against {userUnlockAt} (the redeem maturity).
    function burnByKeeper(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    // ── lock-up ─────────────────────────────────────────────────────────

    /// @notice Record/extend a holder's redeem maturity (monotonic: never shortens).
    ///         Called by the backend at deposit time with `depositTime + tenure`
    ///         (60/90/120 days). Gates redemption off-chain — not transfers.
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

    /// @notice Soulbound receipt — holders can never transfer, so this is always
    ///         false. Kept for ABI/back-compat with earlier readers. Use
    ///         {userUnlockAt} to check a holder's REDEEM maturity instead.
    function isTransferable(address) external pure returns (bool) {
        return false;
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
        // Soulbound: block ALL user→user movement, permanently and regardless of
        // the lock-up. Only the keeper's mint (from == 0, deposit) and burn
        // (to == 0, redeem) are allowed — a holder can never transfer the receipt
        // or deposit it into another contract, even after the lock-up elapses.
        if (from != address(0) && to != address(0)) {
            revert NonTransferable();
        }
        super._update(from, to, value);
    }
}
