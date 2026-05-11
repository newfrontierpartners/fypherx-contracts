// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/*
 * Adapted from Morpho Blue (https://github.com/morpho-org/morpho-blue).
 * Copyright (c) Morpho Labs, licensed under GPL-2.0-or-later.
 * Minor changes: local error constants instead of importing ErrorsLib.
 */

/// @title UtilsLib
/// @notice Library exposing helpers reused across Fypher lending contracts.
library UtilsLib {
    string private constant MAX_UINT128_EXCEEDED = "uint128 overflow";

    /// @dev Returns true if there is exactly one zero among `x` and `y`.
    function exactlyOneZero(uint256 x, uint256 y) internal pure returns (bool z) {
        assembly {
            z := xor(iszero(x), iszero(y))
        }
    }

    /// @dev Returns the min of `x` and `y`.
    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        assembly {
            z := xor(x, mul(xor(x, y), lt(y, x)))
        }
    }

    /// @dev Returns `x` safely cast to uint128.
    function toUint128(uint256 x) internal pure returns (uint128) {
        require(x <= type(uint128).max, MAX_UINT128_EXCEEDED);
        return uint128(x);
    }

    /// @dev Returns max(0, x - y).
    function zeroFloorSub(uint256 x, uint256 y) internal pure returns (uint256 z) {
        assembly {
            z := mul(gt(x, y), sub(x, y))
        }
    }
}
