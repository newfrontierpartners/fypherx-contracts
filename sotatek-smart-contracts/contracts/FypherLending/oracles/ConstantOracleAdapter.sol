// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {IOracle} from "../interfaces/IOracle.sol";

/// @title ConstantOracleAdapter
/// @notice Returns a hard-coded `price()` — used for stable/stable or stable/peg markets on testnet
///         where introducing a Chainlink dependency would be overkill.
/// @dev Price must be supplied in the `1e36` scale convention shared by all Fypher oracles.
///      For two 18-decimal tokens at 1:1 (e.g. RUSD/USDT when RUSD is pegged), this is `1e36`.
contract ConstantOracleAdapter is IOracle {
    uint256 public immutable override price;

    constructor(uint256 price_) {
        require(price_ > 0, "ConstantOracleAdapter: zero price");
        price = price_;
    }
}
