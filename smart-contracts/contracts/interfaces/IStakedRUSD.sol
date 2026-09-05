// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IStakedRUSD {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function cooldownAssets(uint256 assets) external;
    function cooldownShares(uint256 shares) external;
    function unstake(address receiver) external;
    function transferInRewards(uint256 amount) external;
    function totalAssets() external view returns (uint256);
}
