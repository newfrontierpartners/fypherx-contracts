// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title IIrm
/// @notice Per-market Interest Rate Model interface.
/// @dev Simplified from Morpho Blue's IIrm: since each Fypher lending market is its own
///      contract, the IRM doesn't need MarketParams; it only needs the live utilisation.
interface IIrm {
    /// @notice Returns the borrow rate per second (scaled by 1e18) given current market state.
    /// @dev May mutate IRM storage for rate-smoothing implementations.
    function borrowRate(uint256 totalSupplyAssets, uint256 totalBorrowAssets) external returns (uint256);

    /// @notice Same as `borrowRate` but view-only — used by off-chain quoters.
    function borrowRateView(uint256 totalSupplyAssets, uint256 totalBorrowAssets) external view returns (uint256);
}
