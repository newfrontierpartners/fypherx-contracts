// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IOracle} from "./interfaces/IOracle.sol";

/// @title OracleRouterV2
/// @notice Thin router that picks a pre-configured oracle adapter per (collateralToken, loanToken) pair
///         and forwards `price()` to it.
/// @dev Each market is constructed with a fixed oracle address — the router itself is NOT the market's
///      oracle. Markets are expected to be pointed either directly at an adapter, or at a small
///      dedicated "pair-price-view" contract that reads from this router's `getAdapter(...)`.
///      In v1 we keep it simple: markets hold the adapter address directly, and the router is used
///      by off-chain tooling + governance to maintain the map of adapters.
contract OracleRouterV2 is Ownable {
    /// @notice collateralToken => loanToken => oracle adapter address
    mapping(address => mapping(address => address)) public adapters;

    event AdapterSet(address indexed collateralToken, address indexed loanToken, address adapter);

    error UnknownPair();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Timelock-only: set the adapter for a pair.
    function setAdapter(address collateralToken, address loanToken, address adapter) external onlyOwner {
        adapters[collateralToken][loanToken] = adapter;
        emit AdapterSet(collateralToken, loanToken, adapter);
    }

    /// @notice Returns the adapter used for the (collateral, loan) pair.
    function getAdapter(address collateralToken, address loanToken) external view returns (address) {
        address a = adapters[collateralToken][loanToken];
        if (a == address(0)) revert UnknownPair();
        return a;
    }

    /// @notice Convenience view — fetches price via the registered adapter.
    function price(address collateralToken, address loanToken) external view returns (uint256) {
        address a = adapters[collateralToken][loanToken];
        if (a == address(0)) revert UnknownPair();
        return IOracle(a).price();
    }
}
