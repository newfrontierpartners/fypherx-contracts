// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

struct UserCooldown {
    uint104 cooldownEnd;
    uint152 underlyingAmount;
}

interface IStakedRUSDCooldown {
    function cooldowns(address user) external view returns (uint104 cooldownEnd, uint152 underlyingAmount);
    function cooldownAssets(uint256 assets) external;
    function cooldownShares(uint256 shares) external;
    function unstake(address receiver) external;
}
