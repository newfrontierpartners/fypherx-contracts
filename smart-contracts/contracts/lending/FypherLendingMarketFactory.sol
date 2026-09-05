// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {FypherLendingMarket} from "./FypherLendingMarket.sol";
import {InsuranceFundV2} from "./InsuranceFundV2.sol";

/// @title FypherLendingMarketFactory
/// @notice Deploys `FypherLendingMarket` instances in a single governance-controlled batch.
/// @dev Owner is expected to be the Timelock. Each create-market call is expected to be
///      bundled with the InsuranceFund whitelist update so the new market can call
///      `coverBadDebt` once live.
contract FypherLendingMarketFactory is Ownable {
    InsuranceFundV2 public immutable insuranceFund;

    /// @notice All markets ever created by this factory, in creation order.
    address[] public markets;

    event MarketCreated(
        address indexed market,
        address indexed loanToken,
        address indexed collateralToken,
        address oracle,
        address irm,
        uint256 lltvBps,
        uint256 liquidationBonusBps
    );

    constructor(address owner_, InsuranceFundV2 insuranceFund_) Ownable(owner_) {
        insuranceFund = insuranceFund_;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    /// @notice Timelock-only: deploy a new market and whitelist it on the insurance fund.
    function createMarket(FypherLendingMarket.InitParams calldata p) external onlyOwner returns (address market) {
        FypherLendingMarket m = new FypherLendingMarket(p);
        market = address(m);
        markets.push(market);

        // Factory must itself have been given MARKET_ADMIN authority over the fund for this to succeed.
        insuranceFund.setMarketAllowed(market, true);

        emit MarketCreated(market, p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltvBps, p.liquidationBonusBps);
    }
}
