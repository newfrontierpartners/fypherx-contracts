// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title FYP
 * @notice Governance token for the Fypher protocol. Pausable and burnable.
 *
 *         <p><b>FYP-17 — supply policy</b>. Mint authority is held by
 *         the contract owner and is intentionally UNCAPPED. FYP is
 *         the protocol's emission token: the owner mints new supply
 *         into {FypherStakingHub} to fund per-block rewards, plus
 *         ad-hoc grants for governance / treasury operations. There
 *         is no on-chain maximum supply and no hard-coded emission
 *         schedule. The trust assumption is that the owner key is
 *         held by the governance multisig (per ADR-007) and that
 *         supply expansion is signaled off-chain through normal
 *         governance channels. Integrators valuing FYP should treat
 *         {totalSupply()} as variable.
 *
 *         <p><b>FYP-16 — ownership renouncement disabled</b>. The
 *         {renounceOwnership} entry point inherited from
 *         OwnableUpgradeable is overridden to revert. Renouncing
 *         would permanently disable {mint} (no more emission funding
 *         for the staking hub), {pause}, and {unpause} — a
 *         "permissions-permanently-lost" failure mode that we
 *         explicitly do not want. Ownership transfers are still
 *         available via {transferOwnership} (two-step is not used
 *         here because the deployer-EOA → multisig handoff happens
 *         once at deploy time).
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0xE3aF5d908A868Cbd2a68F33752C48442C8195e47
 *      Implementation: 0x4328Db890043799e9b06cf03460a522ed072955f
 */
contract FYP is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PausableUpgradeable,
    OwnableUpgradeable
{
    // FYP-15 patch: removed the unused `error ZeroAddress();` decl.
    // No call site referenced it; OZ's Ownable rejects zero owner at
    // {__Ownable_init} already (revert OwnableInvalidOwner).

    /// @notice Reverted by {renounceOwnership} — see FYP-16 note on the
    ///         contract docstring above.
    error RenounceDisabled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __ERC20_init("FYP", "FYP");
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __Ownable_init(owner_);
    }

    /**
     * @notice Mint `amount` FYP to `to`. Owner-only (governance
     *         multisig). Supply policy is uncapped by design — see
     *         the contract docstring (FYP-17 note).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Disabled. FYP ownership cannot be renounced — see the
     *         contract docstring (FYP-16 note). The owner can still
     *         transfer ownership via {transferOwnership}.
     */
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }
}
