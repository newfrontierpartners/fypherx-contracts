// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title IOracle
/// @notice Returns the price of 1 unit of collateral quoted in loan-token units, scaled by 1e36.
/// @dev Inherited from Morpho Blue's IOracle convention:
///      price = (1 collateral unit) / (1 loan-token unit) * 1e36,
///      i.e. a uint with `36 + loanDecimals - collateralDecimals` decimals of precision.
interface IOracle {
    function price() external view returns (uint256);
}
