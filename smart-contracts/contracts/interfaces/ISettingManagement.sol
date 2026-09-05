// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ISettingManagement {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function getRoleAdmin(bytes32 role) external view returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address account) external;

    function getFees(string calldata feeType) external view returns (uint256);
    function setFees(string calldata feeType, uint256 fee) external;
    function getFeeReceiver() external view returns (address);
    function setFeeReceiver(address receiver) external;

    function getPoolConfigs(string calldata key) external view returns (uint256);
    function setPoolConfigs(string calldata key, uint256 value) external;

    function reservePool() external view returns (address);
    function setReservePool(address pool) external;
    function reserveTarget() external view returns (uint256);
    function setReserveTarget(uint256 target) external;

    function isBlacklisted(address account) external view returns (bool);
    function addToBlacklist(address account) external;
    function removeFromBlacklist(address account) external;
}
