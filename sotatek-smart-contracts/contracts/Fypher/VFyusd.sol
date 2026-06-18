// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title vFYUSD — Earn receipt token (model A)
 * @notice The single user-facing Earn receipt for the model-A (hybrid) money
 *         path. Unlike the testnet mock (open-mint), prod vFYUSD is mint/burn
 *         controlled: only the backend keeper (MINTER_ROLE) issues it on an
 *         Earn deposit, and only the keeper (BURNER_ROLE) burns it on redeem.
 *         DEFAULT_ADMIN_ROLE (deployer → transferred to the Operator Safe)
 *         curates the roles. 6-dec to match the collateral / FYUSD.
 *
 *         Model A does NOT use an ERC-4626 vault for the receipt; the Concrete
 *         position is held by the Safe-governed custody and vFYUSD is this plain
 *         controlled ERC-20. (If you switch to model B / FyusdEarnVault, this
 *         token is unused.)
 */
contract VFyusd is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    uint8 private immutable _decimalsValue;

    /**
     * @param name_     e.g. "Fypher vFYUSD"
     * @param symbol_   e.g. "vFYUSD"
     * @param decimals_ 6 (match collateral / FYUSD)
     * @param admin     DEFAULT_ADMIN_ROLE holder (deployer; transfer to Safe later)
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin)
        ERC20(name_, symbol_)
    {
        require(admin != address(0), "admin=0");
        _decimalsValue = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimalsValue;
    }

    /// @notice Keeper issues vFYUSD on an Earn deposit.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Keeper burns vFYUSD on redeem without needing an allowance
    ///         (the ERC20Burnable {burn}/{burnFrom} remain available too).
    function burnByKeeper(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }
}
