// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./SingleAdminAccessControl.sol";

/**
 * @title SettingManagement
 * @notice Shared registry for roles, fees, pool configurations, and blacklist.
 *         All vaults delegate access control checks to this contract via
 *         `settingManagement.hasRole(role, account)`.
 *
 * @dev Upgradeable via TransparentUpgradeableProxy. Solidity v0.8.22, optimizer 1 run.
 *      Deployed at: 0x369b280Eef40930605372B8AA3de04BF6911A8A6 (BSC Testnet)
 *      Implementation: 0x426ed5a7988da6912d320c9fc7baee18ec6506f6
 */
contract SettingManagement is SingleAdminAccessControl {
    // ── Storage ──
    mapping(string => uint256) private _fees;         // feeType => basis points
    mapping(string => uint256) private _poolConfigs;   // key => value
    address private _feeReceiver;
    address private _reservePool;
    uint256 private _reserveTarget;                    // basis points (e.g. 300 = 3%)
    mapping(address => bool) private _blacklisted;

    // ── Events ──
    event FeeUpdated(string indexed feeType, uint256 fee);
    event FeeReceiverUpdated(address indexed receiver);
    event PoolConfigUpdated(string indexed key, uint256 value);
    event ReservePoolUpdated(address indexed pool);
    event ReserveTargetUpdated(uint256 target);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    // ── Errors ──
    error AccountBlacklisted(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin_) external initializer {
        __SingleAdminAccessControl_init(admin_);
    }

    // ── Fees ──
    function getFees(string calldata feeType) external view returns (uint256) {
        return _fees[feeType];
    }

    function setFees(string calldata feeType, uint256 fee) external onlyAdmin {
        _fees[feeType] = fee;
        emit FeeUpdated(feeType, fee);
    }

    function getFeeReceiver() external view returns (address) {
        return _feeReceiver;
    }

    function setFeeReceiver(address receiver) external onlyAdmin {
        _feeReceiver = receiver;
        emit FeeReceiverUpdated(receiver);
    }

    // ── Pool Configs ──
    function getPoolConfigs(string calldata key) external view returns (uint256) {
        return _poolConfigs[key];
    }

    function setPoolConfigs(string calldata key, uint256 value) external onlyAdmin {
        _poolConfigs[key] = value;
        emit PoolConfigUpdated(key, value);
    }

    // ── Reserve ──
    function reservePool() external view returns (address) {
        return _reservePool;
    }

    function setReservePool(address pool) external onlyAdmin {
        _reservePool = pool;
        emit ReservePoolUpdated(pool);
    }

    function reserveTarget() external view returns (uint256) {
        return _reserveTarget;
    }

    function setReserveTarget(uint256 target) external onlyAdmin {
        _reserveTarget = target;
        emit ReserveTargetUpdated(target);
    }

    // ── Blacklist ──
    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    function addToBlacklist(address account) external onlyAdmin {
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function removeFromBlacklist(address account) external onlyAdmin {
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }
}
