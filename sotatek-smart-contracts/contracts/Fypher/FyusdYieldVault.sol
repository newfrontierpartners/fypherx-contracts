// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISettingManagement.sol";
import "./IConcreteAdapter.sol";

/**
 * @title FyusdYieldVault
 * @notice Phase 1 user entry to the Concrete-backed FYUSD yield vault
 *         (PHASE1_SPEC §3.4 + ADR-006). FYUSD-only deposits; principal
 *         and accrued yield are tracked per-user via the underlying
 *         adapter's share accounting.
 *
 *         User flow:
 *
 *           U[User FYUSD] --|deposit|--> V[Vault] --|forward|--> A[Concrete adapter]
 *           U <--|withdraw|-- V <--|withdraw|-- A
 *
 *         The vault layer exists (rather than letting users hit the
 *         adapter directly) for three reasons:
 *           1. Per-user shares are isolated from the protocol's adapter
 *              shares, so the adapter can be migrated to a v2 contract
 *              without users having to track a new share token.
 *           2. {vaultPaused} (ADR-008) gives ops a single switch to
 *              freeze deposits/withdraws independent of Concrete's own
 *              pause state.
 *           3. Lets the admin swap mock <-> real adapter at deploy time
 *              per network without changing the user-visible contract
 *              address.
 *
 *         User shares are 1:1 with adapter shares: the vault wraps,
 *         it does not introduce new accounting. Pro-rata yield is the
 *         adapter's responsibility.
 */
interface IFYUSDPermit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract FyusdYieldVault is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ── Storage ──

    ISettingManagement public settingManagement;
    IERC20             public fyusd;
    IConcreteAdapter   public adapter;
    address            public pauserRole;

    /// @notice Per-user shares (1:1 with adapter shares).
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    /// @notice ADR-008 single-vault pause (Concrete is one entry point
    ///         per network so per-asset granularity is unnecessary here).
    bool public vaultPaused;

    // ── Events ──

    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);
    event PauserRoleUpdated(address indexed oldPauser, address indexed newPauser);
    event VaultPausedSet(bool paused);
    event Deposit(address indexed user, uint256 fyusdAmount, uint256 shares);
    event Withdraw(address indexed user, uint256 shares, uint256 fyusdAmount);

    // ── Errors ──

    error NotAdmin();
    error NotPauserOrAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error VaultPausedErr();
    error InsufficientShares(uint256 have, uint256 want);
    error AdapterAssetMismatch(address vault, address adapter);

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        ISettingManagement _settingManagement,
        IERC20 _fyusd,
        IConcreteAdapter _adapter
    ) external initializer {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        if (address(_fyusd) == address(0)) revert ZeroAddress();
        if (address(_adapter) == address(0)) revert ZeroAddress();
        if (_adapter.asset() != address(_fyusd)) {
            revert AdapterAssetMismatch(address(_fyusd), _adapter.asset());
        }
        __ReentrancyGuard_init();
        settingManagement = _settingManagement;
        fyusd = _fyusd;
        adapter = _adapter;
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

    // ── User actions ──

    function deposit(uint256 fyusdAmount) external nonReentrant returns (uint256 shares) {
        if (vaultPaused) revert VaultPausedErr();
        if (fyusdAmount == 0) revert ZeroAmount();

        // Pull FYUSD from user, approve adapter, deposit to adapter.
        fyusd.safeTransferFrom(msg.sender, address(this), fyusdAmount);
        fyusd.forceApprove(address(adapter), fyusdAmount);
        shares = adapter.deposit(fyusdAmount);

        sharesOf[msg.sender] += shares;
        totalShares += shares;
        emit Deposit(msg.sender, fyusdAmount, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 fyusdAmount) {
        if (vaultPaused) revert VaultPausedErr();
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares(sharesOf[msg.sender], shares);

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;

        fyusdAmount = adapter.withdraw(shares);
        fyusd.safeTransfer(msg.sender, fyusdAmount);

        emit Withdraw(msg.sender, shares, fyusdAmount);
    }

    // ── Admin ──

    function setAdapter(IConcreteAdapter newAdapter) external onlyAdmin {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        if (newAdapter.asset() != address(fyusd)) {
            revert AdapterAssetMismatch(address(fyusd), newAdapter.asset());
        }
        // Migration to a v2 adapter is intentionally NOT automated — admin
        // must coordinate the asset move via {emergencyMigrate} (future
        // work) before flipping the binding. This keeps the share-state
        // invariant under the operator's control.
        emit AdapterUpdated(address(adapter), address(newAdapter));
        adapter = newAdapter;
    }

    function setPauserRole(address newPauser) external onlyAdmin {
        emit PauserRoleUpdated(pauserRole, newPauser);
        pauserRole = newPauser;
    }

    function setVaultPaused(bool paused) external onlyPauserOrAdmin {
        if (!paused) {
            if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        }
        vaultPaused = paused;
        emit VaultPausedSet(paused);
    }

    // ── View ──

    /// @notice FYUSD currently controlled by the adapter on behalf of
    ///         the vault — i.e. principal + accrued yield. Useful for
    ///         operator dashboards.
    function totalAssets() external view returns (uint256) {
        return adapter.totalAssets();
    }

    /// @notice Adapter-recorded share balance held by THIS vault. Should
    ///         track {totalShares} in lockstep; mismatch indicates a
    ///         migration in flight or an adapter bug.
    function adapterShares() external view returns (uint256) {
        return adapter.shareOf(address(this));
    }

    /// @notice Forward to the adapter; lets the admin dashboard render
    ///         a "7d realized APY" without a separate ABI call.
    function realizedYield7dBps() external view returns (uint256) {
        return adapter.realizedYield7d();
    }
}
