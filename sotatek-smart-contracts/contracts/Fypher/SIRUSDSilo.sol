// SPDX-License-Identifier: MIT
// Reconstructed from on-chain bytecode at 0x4122cE99D3dBBFF96B8D87Cd0e86E5493d09BeD5
// BSC Testnet | Solidity ^0.8.22

pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

error UnauthorizedCaller();

/**
 * @title SIRUSDSilo
 * @notice Escrow that holds tokens during StakedIRUSD's cooldown period.
 *         Unlike RUSDSilo, this silo does NOT hardcode the token address —
 *         it accepts the token as a parameter in `withdraw`, allowing
 *         the vault to release different tokens if needed.
 *
 *         Only the linked staking vault (StakedIRUSD) may call `withdraw`.
 *
 * @dev   STAKING_VAULT = StakedIRUSD (0x854c2AB7AeEcF92E5f9Ee5da46d38FE48253B707)
 */
contract SIRUSDSilo {
    address public immutable STAKING_VAULT;

    constructor(address _stakingVault) {
        STAKING_VAULT = _stakingVault;
    }

    /// @notice Transfer `amount` of `token` to `to`. Only callable by STAKING_VAULT.
    /// @param token  The ERC-20 token to transfer out of this escrow.
    /// @param to     Recipient address.
    /// @param amount Amount to transfer.
    function withdraw(address token, address to, uint256 amount) external {
        if (msg.sender != STAKING_VAULT) revert UnauthorizedCaller();
        IERC20(token).transfer(to, amount);
    }
}
