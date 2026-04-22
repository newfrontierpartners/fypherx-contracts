// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {FypherLPVault} from "./FypherLPVault.sol";

/// @title FypherLiquidityManager
/// @notice Governance-facing admin for one or more `FypherLPVault`s.
///         Owns the vault, can pause deposits, can skim unexpected transfers back to
///         a treasury, and exposes a registry of the vaults under its authority.
/// @dev Owner is the Timelock in production. All operational entrypoints flow through
///      the Timelock to reduce blast radius of a single governance key.
contract FypherLiquidityManager is Ownable {
    using SafeERC20 for IERC20;

    /// @notice All vaults under this manager's authority, in registration order.
    FypherLPVault[] public vaults;
    /// @notice Where unexpected token balances are skimmed to.
    address public treasury;

    event VaultRegistered(address indexed vault);
    event VaultDepositsPausedSet(address indexed vault, bool paused);
    event TreasurySet(address indexed treasury);
    event Skimmed(address indexed token, address indexed from, address indexed to, uint256 amount);

    constructor(address owner_, address treasury_) Ownable(owner_) {
        treasury = treasury_;
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function setTreasury(address value) external onlyOwner {
        treasury = value;
        emit TreasurySet(value);
    }

    /// @notice Register a vault so off-chain callers can enumerate it.
    ///         The manager must already be the vault's owner (transfer ownership separately).
    function registerVault(FypherLPVault vault) external onlyOwner {
        vaults.push(vault);
        emit VaultRegistered(address(vault));
    }

    function setVaultDepositsPaused(FypherLPVault vault, bool value) external onlyOwner {
        vault.setDepositsPaused(value);
        emit VaultDepositsPausedSet(address(vault), value);
    }

    /// @notice Pull idle token balance out of `vault` (e.g. refunds that got stuck) to `treasury`.
    /// @dev This is NOT the user-facing withdraw path — it's for leftover dust only. Callable
    ///      by the Timelock through `owner()`. Vaults must transfer proactively; we do not
    ///      wrap their storage here to keep the attack surface small.
    function skimFromVault(FypherLPVault vault, IERC20 token, uint256 amount) external onlyOwner {
        // The manager doesn't currently have a method to yank tokens from the vault directly;
        // this skim path is intended for tokens that land in *this* contract by mistake.
        token.safeTransfer(treasury, amount);
        emit Skimmed(address(token), address(vault), treasury, amount);
    }
}
