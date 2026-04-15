// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title PoolMath
 * @notice Library for APR calculation, fee computation, principal/profit separation,
 *         and average rate tracking used across all Fypher vaults.
 */
library PoolMath {
    uint256 constant BPS = 10000; // basis points denominator
    uint256 constant YEAR = 365 days;

    /// @notice Calculate fee from amount in basis points
    function calculateFee(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        return (amount * feeBps) / BPS;
    }

    /// @notice Calculate APR from monthly profit and total assets
    function calculateAPR(uint256 monthlyProfit, uint256 totalAssets) internal pure returns (uint256) {
        if (totalAssets == 0) return 0;
        return (monthlyProfit * 12 * BPS) / totalAssets;
    }

    /// @notice Calculate reward amount based on APR and time elapsed
    function calculateReward(
        uint256 principal,
        uint256 aprBps,
        uint256 timeElapsed
    ) internal pure returns (uint256) {
        return (principal * aprBps * timeElapsed) / (BPS * YEAR);
    }

    /// @notice Calculate vested amount given vesting period
    function calculateVestedAmount(
        uint256 totalAmount,
        uint256 vestingStart,
        uint256 vestingPeriod
    ) internal view returns (uint256) {
        if (block.timestamp >= vestingStart + vestingPeriod) {
            return totalAmount;
        }
        uint256 elapsed = block.timestamp - vestingStart;
        return (totalAmount * elapsed) / vestingPeriod;
    }
}
