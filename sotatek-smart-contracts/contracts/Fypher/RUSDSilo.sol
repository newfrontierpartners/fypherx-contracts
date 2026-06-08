// SPDX-License-Identifier: MIT
// Reconstructed from on-chain bytecode at 0xcFE380230d30c0E4D31Febfe563187aD19d3b497
// BSC Testnet | Solidity ^0.8.22
//
// Same pattern used by:
//   - iRUSDSilo  (0x7f5159254685adC905975657697511381Bec93aa) — vault=stAUSD, token=iRUSD
//   - stAUSDSilo (0xc65FbB46E09fDc5a5e1E827FC9f9CA84a3E19C78) — vault=stAUSD, token=FYUSD

pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

error UnauthorizedCaller();

/**
 * @title RUSDSilo
 * @notice Minimal escrow that holds tokens during a vault's cooldown period.
 *         Only the linked staking vault may call `withdraw` to release tokens
 *         to the user after the cooldown expires.
 *
 * @dev   Constructor args are immutable — no proxy, no storage, no owner.
 *        The entire contract is a single permissioned `transfer` wrapper.
 *
 * Deployed instances:
 *   RUSDSilo   — STAKING_VAULT = StakedRUSD  (0x2c04…03D6), TOKEN = RUSD  (0x43Ce…DBF5)
 *   iRUSDSilo  — STAKING_VAULT = stAUSD      (0x57B7…Ffda), TOKEN = iRUSD (0x37B4…4dfb)
 *   stAUSDSilo — STAKING_VAULT = stAUSD      (0x57B7…Ffda), TOKEN = FYUSD (0x9FC6…bEd9)
 */
contract RUSDSilo {
    using SafeERC20 for IERC20;

    IERC20  public immutable TOKEN;
    address public immutable STAKING_VAULT;

    constructor(address _stakingVault, IERC20 _token) {
        // FYP-25: reject zero immutables (set once at deploy). require-string
        // (not a custom error) to avoid shadowing StakedRUSD's ZeroAddress.
        require(_stakingVault != address(0) && address(_token) != address(0), "Silo: zero address");
        STAKING_VAULT = _stakingVault;
        TOKEN = _token;
    }

    /// @notice Transfer `amount` of TOKEN to `to`. Only callable by
    ///         STAKING_VAULT.
    /// @dev FYP-12 patch. The previous body used `TOKEN.transfer` which
    ///      assumes every ERC-20 reverts on failure. Some tokens return
    ///      `false` instead (the spec allows it), and the bare-transfer
    ///      shape would silently no-op. SafeERC20.safeTransfer reverts
    ///      on either failure mode.
    function withdraw(address to, uint256 amount) external {
        if (msg.sender != STAKING_VAULT) revert UnauthorizedCaller();
        TOKEN.safeTransfer(to, amount);
    }
}
