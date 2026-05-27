// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {IIrm} from "./interfaces/IIrm.sol";
import {MathLib, WAD} from "./libraries/MathLib.sol";

/// @title KinkedIRM
/// @notice Aave-style two-slope interest rate model, returning the borrow rate PER SECOND
///         scaled by 1e18.
/// @dev Parameters are expressed on an annualised basis (WAD fractions per year) and
///      converted to per-second on each call. The IRM is stateless and shared across
///      multiple markets — parameters are immutable after construction.
contract KinkedIRM is IIrm {
    using MathLib for uint256;

    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @notice Base rate (per year, WAD) applied at 0 utilisation.
    uint256 public immutable baseRatePerYear;
    /// @notice Kink utilisation (WAD fraction — e.g. 0.8e18 = 80%).
    uint256 public immutable kinkUtilisation;
    /// @notice Slope applied between 0 and kink utilisation (per year, WAD).
    uint256 public immutable slope1PerYear;
    /// @notice Slope applied above kink utilisation, scaled over the remaining (WAD - kink) range.
    uint256 public immutable slope2PerYear;

    error InvalidKink();
    error InvalidSlope();

    constructor(
        uint256 baseRatePerYear_,
        uint256 kinkUtilisation_,
        uint256 slope1PerYear_,
        uint256 slope2PerYear_
    ) {
        if (kinkUtilisation_ == 0 || kinkUtilisation_ >= WAD) revert InvalidKink();
        if (slope1PerYear_ == 0) revert InvalidSlope();
        baseRatePerYear = baseRatePerYear_;
        kinkUtilisation = kinkUtilisation_;
        slope1PerYear = slope1PerYear_;
        slope2PerYear = slope2PerYear_;
    }

    /// @inheritdoc IIrm
    function borrowRate(uint256 totalSupplyAssets, uint256 totalBorrowAssets) external returns (uint256) {
        return _rate(totalSupplyAssets, totalBorrowAssets);
    }

    /// @inheritdoc IIrm
    function borrowRateView(uint256 totalSupplyAssets, uint256 totalBorrowAssets) external view returns (uint256) {
        return _rate(totalSupplyAssets, totalBorrowAssets);
    }

    function _rate(uint256 totalSupplyAssets, uint256 totalBorrowAssets) internal view returns (uint256) {
        uint256 utilisation;
        if (totalSupplyAssets == 0) {
            utilisation = 0;
        } else {
            utilisation = totalBorrowAssets.wDivDown(totalSupplyAssets);
            if (utilisation > WAD) utilisation = WAD;
        }

        uint256 ratePerYear;
        if (utilisation <= kinkUtilisation) {
            ratePerYear = baseRatePerYear + (slope1PerYear * utilisation) / kinkUtilisation;
        } else {
            uint256 excess = utilisation - kinkUtilisation;
            uint256 range = WAD - kinkUtilisation;
            ratePerYear = baseRatePerYear + slope1PerYear + (slope2PerYear * excess) / range;
        }

        return ratePerYear / SECONDS_PER_YEAR;
    }
}
