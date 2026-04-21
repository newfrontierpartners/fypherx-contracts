// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {IOracle} from "../interfaces/IOracle.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkOracleAdapter
/// @notice Computes `price(collateral, loan)` for a Fypher lending market from two Chainlink
///         USD-denominated feeds (one per side).
/// @dev Output scale matches the Morpho-style oracle convention:
///        price = (1 unit of collateral valued in loan units) × 1e36
///      Scaling accounts for token decimals AND per-feed decimals, so every Fypher market gets
///      a uniform `1e36` baseline regardless of the underlying assets.
///
///      `maxStaleness` is enforced on `latestRoundData().updatedAt`; feeds that are too stale
///      revert, forcing the market to halt borrow/liquidate paths until the feed recovers.
contract ChainlinkOracleAdapter is IOracle {
    AggregatorV3Interface public immutable collateralFeed;
    AggregatorV3Interface public immutable loanFeed;
    uint8 public immutable collateralTokenDecimals;
    uint8 public immutable loanTokenDecimals;
    uint256 public immutable maxStaleness;

    uint256 internal immutable _scaleFactor;
    uint8 internal immutable _collateralFeedDecimals;
    uint8 internal immutable _loanFeedDecimals;

    error StalePrice();
    error NonPositivePrice();

    constructor(
        address collateralFeed_,
        address loanFeed_,
        uint8 collateralTokenDecimals_,
        uint8 loanTokenDecimals_,
        uint256 maxStaleness_
    ) {
        collateralFeed = AggregatorV3Interface(collateralFeed_);
        loanFeed = AggregatorV3Interface(loanFeed_);
        collateralTokenDecimals = collateralTokenDecimals_;
        loanTokenDecimals = loanTokenDecimals_;
        maxStaleness = maxStaleness_;

        _collateralFeedDecimals = AggregatorV3Interface(collateralFeed_).decimals();
        _loanFeedDecimals = AggregatorV3Interface(loanFeed_).decimals();

        // Precompute the scale factor so `price()` stays cheap + reentrancy-safe.
        // Target:
        //   price = p_c * 1e36 * 1e(loanDec - collatDec + loanFeedDec - collatFeedDec) / p_l
        // Broken out:
        //   exponent = 36 + loanTokenDecimals - collateralTokenDecimals
        //            + loanFeedDecimals  - collateralFeedDecimals
        int256 exp = int256(36)
            + int256(uint256(loanTokenDecimals_)) - int256(uint256(collateralTokenDecimals_))
            + int256(uint256(_loanFeedDecimals)) - int256(uint256(_collateralFeedDecimals));

        require(exp >= 0 && exp <= 60, "ChainlinkOracleAdapter: scale out of range");
        _scaleFactor = 10 ** uint256(exp);
    }

    function price() external view override returns (uint256) {
        (, int256 pc, , uint256 updatedC, ) = collateralFeed.latestRoundData();
        (, int256 pl, , uint256 updatedL, ) = loanFeed.latestRoundData();

        if (pc <= 0 || pl <= 0) revert NonPositivePrice();
        if (block.timestamp - updatedC > maxStaleness) revert StalePrice();
        if (block.timestamp - updatedL > maxStaleness) revert StalePrice();

        return (uint256(pc) * _scaleFactor) / uint256(pl);
    }
}
