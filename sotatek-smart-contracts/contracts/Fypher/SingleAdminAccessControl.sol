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
    bytes32 public constant REWARDER_ROLE = keccak256("REWARDER_ROLE");
    bytes32 public constant SOFT_RESTRICTED_STAKER_ROLE = keccak256("SOFT_RESTRICTED_STAKER_ROLE");
    bytes32 public constant FULL_RESTRICTED_STAKER_ROLE = keccak256("FULL_RESTRICTED_STAKER_ROLE");
    bytes32 public constant WHITELISTED_STAKER_ROLE = keccak256("WHITELISTED_STAKER_ROLE");
    bytes32 public constant INSTITUTIONAL_ROLE = keccak256("INSTITUTIONAL_ROLE");
    bytes32 public constant RETAIL_ROLE = keccak256("RETAIL_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant TRANSFER_FEE_ROLE = keccak256("TRANSFER_FEE_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
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
     *      modifier. This mapping is never written and
     *      {getRoleAdmin} always returns `bytes32(0)`. Kept in place
     *      to preserve storage layout under TransparentProxy. April-
     *      audit H-3 documentation patch.
     */
    mapping(bytes32 => bytes32) private _roleAdmin;

    // ── Events ──
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event AdminTransferRequested(address indexed currentAdmin, address indexed newAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ──
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != _admin) revert NotAdmin();
        _;
    }

    modifier onlyRole(bytes32 role) {
        require(_roles[role][msg.sender], "AccessControl: missing role");
        _;
    }

    function __SingleAdminAccessControl_init(address admin_) internal onlyInitializing {
        if (admin_ == address(0)) revert ZeroAddress();
        _admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    // ── View ──
    function owner() public view returns (address) {
        return _admin;
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        if (role == bytes32(0)) return account == _admin;
        return _roles[role][account];
    }

    function getRoleAdmin(bytes32 role) public view returns (bytes32) {
        return _roleAdmin[role];
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
     * @dev April-audit H-3 patch. Critical operational roles
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
     */
    function renounceRole(bytes32 role, address account) external {
        require(account == msg.sender, "Can only renounce own role");
        require(role != bytes32(0), "Cannot renounce admin role");
        require(role != REWARDER_ROLE, "Cannot renounce REWARDER_ROLE");
        require(role != RELEASE_TOKEN_ROLE, "Cannot renounce RELEASE_TOKEN_ROLE");
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function revokeUserRole(address account) external onlyAdmin {
        // Revoke all known roles
        _roles[REWARDER_ROLE][account] = false;
        _roles[SOFT_RESTRICTED_STAKER_ROLE][account] = false;
        _roles[FULL_RESTRICTED_STAKER_ROLE][account] = false;
        _roles[WHITELISTED_STAKER_ROLE][account] = false;
        _roles[INSTITUTIONAL_ROLE][account] = false;
        _roles[RETAIL_ROLE][account] = false;
        _roles[MINTER_ROLE][account] = false;
        _roles[BURNER_ROLE][account] = false;
        _roles[TRANSFER_FEE_ROLE][account] = false;
        _roles[ADMIN_ROLE][account] = false;
        _roles[RELEASE_TOKEN_ROLE][account] = false;
    }

    // ── Admin transfer (two-step) ──
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        _pendingAdmin = newAdmin;
        emit AdminTransferRequested(_admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != _pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(_admin, msg.sender);
        _admin = msg.sender;
        _pendingAdmin = address(0);
    }
}
