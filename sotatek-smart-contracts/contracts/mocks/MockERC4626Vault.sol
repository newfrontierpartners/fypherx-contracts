// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title MockERC4626Vault
 * @notice Minimal ERC-4626 vault used to simulate Concrete's Earn V2
 *         vault in adapter tests. Pure pass-through with one extra
 *         convenience: {simulateYield} airdrops a configurable
 *         underlying amount into the vault so totalAssets() inflates
 *         without affecting share supply — exactly the dynamic the
 *         {ConcreteAdapterV1} uses to read realized yield.
 *
 * <p>NOT for production use — anyone can mint, anyone can simulate
 * yield. Test fixture only.
 */
contract MockERC4626Vault is ERC4626 {
    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
    {}

    /// @notice Pull `amount` underlying from the caller, balance lands
    ///         in the vault → totalAssets grows by `amount` → share
    ///         price rises pro-rata. Lets tests drive yield-accrual
    ///         scenarios without waiting on a real strategy.
    function simulateYield(uint256 amount) external {
        IERC20(asset()).transferFrom(msg.sender, address(this), amount);
    }
}
