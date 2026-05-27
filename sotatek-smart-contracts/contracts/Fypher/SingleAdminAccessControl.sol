// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title SingleAdminAccessControl
 * @notice Access control with a single admin who can delegate roles.
 *         The admin can transfer admin rights via a two-step process.
 */
abstract contract SingleAdminAccessControl is Initializable {
    // ── Roles ──
    // April-audit I-1 patch. Dropped six role constants
    // (`WHITELISTED_STAKER_ROLE`, `RETAIL_ROLE`, `MINTER_ROLE`,
    // `BURNER_ROLE`, `TRANSFER_FEE_ROLE`, `ADMIN_ROLE`) that were
    // defined here but never checked anywhere in the protocol — they
    // were dead governance surface that confused reviewers, and
    // FYUSD/InstitutionalRUSD.mint enforces a single-`_minter` slot
    // rather than `MINTER_ROLE`. The constants are pure compile-time
    // values, so removing them does not shift any storage slot under
    // TransparentProxy. External callers that previously read e.g.
    // `MINTER_ROLE()` from this ABI must now compute the hash off-chain
    // (`keccak256("MINTER_ROLE")`); since nothing on-chain consumes
    // that role this is purely cosmetic.
    bytes32 public constant REWARDER_ROLE = keccak256("REWARDER_ROLE");
    bytes32 public constant SOFT_RESTRICTED_STAKER_ROLE = keccak256("SOFT_RESTRICTED_STAKER_ROLE");
    bytes32 public constant FULL_RESTRICTED_STAKER_ROLE = keccak256("FULL_RESTRICTED_STAKER_ROLE");
    bytes32 public constant INSTITUTIONAL_ROLE = keccak256("INSTITUTIONAL_ROLE");
    bytes32 public constant RELEASE_TOKEN_ROLE = keccak256("RELEASE_TOKEN_ROLE");

    // ── Storage ──
    address private _admin;
    address private _pendingAdmin;
    mapping(bytes32 => mapping(address => bool)) private _roles;
    /**
     * @dev Reserved-but-unused. The original layout anticipated a
     *      per-role admin hierarchy à la OpenZeppelin AccessControl,
     *      but the implementation below routes every grant/revoke
     *      through the single `_admin` slot via the `onlyAdmin`
     *      modifier. This mapping is never written. We RETAIN the
     *      slot for TransparentProxy storage-layout safety; the
     *      external {getRoleAdmin} accessor (and the {onlyRole}
     *      modifier) were dropped in the FYP-51 patch since no
     *      production caller relied on either.
     */
    mapping(bytes32 => bytes32) private _roleAdmin;

    // ── Events ──
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event AdminTransferRequested(address indexed currentAdmin, address indexed newAdmin);
    event AdminTransferCancelled(address indexed currentAdmin, address indexed cancelledPendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ──
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != _admin) revert NotAdmin();
        _;
    }

    // FYP-51 patch: removed the {onlyRole} modifier — no in-scope
    // call site referenced it, so it was dead surface that
    // confused reviewers about whether this contract has a
    // role-graph or just a single-admin model.

    function __SingleAdminAccessControl_init(address admin_) internal onlyInitializing {
        if (admin_ == address(0)) revert ZeroAddress();
        _admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    // ── View ──
    /// @notice The current admin (alias of {admin()}; retained for
    ///         Ownable-shaped tooling that expects {owner()}).
    function owner() public view returns (address) {
        return _admin;
    }

    /// @notice The current admin. Prefer {admin()} over {owner()} for
    ///         new integrations; the two return the same address.
    /// @dev FYP-53 patch. Added an explicit getter that matches the
    ///      single-admin model the contract actually implements,
    ///      so off-chain tooling does not have to guess from the
    ///      Ownable-shaped {owner()} alias.
    function admin() external view returns (address) {
        return _admin;
    }

    /// @notice The address staged for the two-step admin handoff.
    ///         Returns address(0) when no handoff is in flight.
    /// @dev FYP-52 patch. The slot existed but had no public getter,
    ///      so multisig dashboards / monitoring couldn't see who was
    ///      expected to {acceptAdmin}.
    function pendingAdmin() external view returns (address) {
        return _pendingAdmin;
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        if (role == bytes32(0)) return account == _admin;
        return _roles[role][account];
    }

    // ── Write ──
    function grantRole(bytes32 role, address account) external onlyAdmin {
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    /**
     * @notice Renounce a role held by the caller.
     * @dev April-audit C-3 patch. Critical operational roles
     *      (REWARDER_ROLE, RELEASE_TOKEN_ROLE) and the default admin
     *      role (bytes32(0)) cannot be renounced — they must be
     *      revoked through the admin path, ensuring there is always a
     *      counterparty (the admin) acknowledging the loss of the
     *      role. A holder who simultaneously renounced REWARDER_ROLE
     *      could otherwise brick `transferInRewards` until the admin
     *      noticed and re-granted the role; for the default admin
     *      slot, a renounce would silently de-sync `hasRole` from
     *      `_admin` (since hasRole(bytes32(0)) reads `_admin`, not
     *      `_roles`).
     *
     * @dev FYP-04 patch. SOFT/FULL_RESTRICTED_STAKER_ROLE represent
     *      admin-imposed compliance state (sanctions / KYC failure /
     *      etc.), not user-held privileges. Allowing a restricted
     *      account to self-revoke would let them bypass deposit/
     *      staking gates immediately after being flagged. These roles
     *      must only be revocable by admin via {revokeRole} or
     *      {revokeUserRole}.
     */
    function renounceRole(bytes32 role, address account) external {
        require(account == msg.sender, "Can only renounce own role");
        require(role != bytes32(0), "Cannot renounce admin role");
        require(role != REWARDER_ROLE, "Cannot renounce REWARDER_ROLE");
        require(role != RELEASE_TOKEN_ROLE, "Cannot renounce RELEASE_TOKEN_ROLE");
        require(role != SOFT_RESTRICTED_STAKER_ROLE, "Cannot renounce SOFT_RESTRICTED_STAKER_ROLE");
        require(role != FULL_RESTRICTED_STAKER_ROLE, "Cannot renounce FULL_RESTRICTED_STAKER_ROLE");
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    /**
     * @notice Convenience sweep that revokes every role this protocol
     *         currently checks on-chain from `account`.
     *
     * @dev April-audit I-1 patch. Sweep narrowed to the roles still
     *      referenced by other contracts (REWARDER, SOFT/FULL
     *      RESTRICTED STAKER, INSTITUTIONAL, RELEASE_TOKEN). Any
     *      legacy MINTER/BURNER/etc. role mapping entries written by
     *      pre-patch admins remain in storage but are unreachable —
     *      they were already inert because no contract reads them.
     *      Operators wanting to re-clear them must call
     *      {revokeRole} with the explicit hash.
     */
    function revokeUserRole(address account) external onlyAdmin {
        _roles[REWARDER_ROLE][account] = false;
        _roles[SOFT_RESTRICTED_STAKER_ROLE][account] = false;
        _roles[FULL_RESTRICTED_STAKER_ROLE][account] = false;
        _roles[INSTITUTIONAL_ROLE][account] = false;
        _roles[RELEASE_TOKEN_ROLE][account] = false;
    }

    // ── Admin transfer (two-step) ──
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        _pendingAdmin = newAdmin;
        emit AdminTransferRequested(_admin, newAdmin);
    }

    /**
     * @notice Cancel an in-flight admin transfer by clearing
     *         `_pendingAdmin`. Admin-only — the recipient cannot
     *         "decline" by calling this; they simply refrain from
     *         calling {acceptAdmin}.
     * @dev FYP-52 patch. Pre-patch the only way to cancel a
     *      mis-targeted transfer was to call {transferAdmin}
     *      again with a different address — that worked but was
     *      surprising to operators and left no explicit
     *      cancellation event in the ledger.
     */
    function cancelAdminTransfer() external onlyAdmin {
        if (_pendingAdmin == address(0)) revert NotPendingAdmin();
        emit AdminTransferCancelled(_admin, _pendingAdmin);
        _pendingAdmin = address(0);
    }

    function acceptAdmin() external {
        if (msg.sender != _pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(_admin, msg.sender);
        _admin = msg.sender;
        _pendingAdmin = address(0);
    }
}
