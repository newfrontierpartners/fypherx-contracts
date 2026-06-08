// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title FYUSD
 * @notice FYUSD token — underlying asset for the stAUSD vault and the
 *         Phase 1 epoch-settled stablecoin sourced via Bitgo Prime
 *         (PHASE1_SPEC §3.2).
 *
 * @dev Upgradeable (TransparentProxy). Deployed at: 0x9FC6C8eAeB305BE708b957d7cfF7E424D6F2bEd9
 *
 *      Phase 1 / S1.3a upgrade (ADR-005 §2):
 *
 *      The primary {_minter} slot is migrated to point at the
 *      {FyusdEpochSettlement} contract once that contract is live so
 *      the standard Bitgo-settled mint path goes through epoch
 *      settlement.
 *
 *      A separate {_emergencyMinter} slot is reserved for ops
 *      remediation paths that must NOT depend on the epoch
 *      settlement contract being healthy:
 *        - Bitgo Prime API outage longer than the fallback window
 *        - audit-required compensatory mint
 *        - mainnet rotation events
 *
 *      The emergency minter is intended to be the multisig admin
 *      (per ADR-007). All emergencyMint calls emit
 *      {EmergencyMint(operator, to, amount)} so the audit-ledger
 *      indexer (ADR-009) records every non-standard mint.
 *
 *      Storage layout is append-only:
 *        - existing slot: `_minter` (untouched)
 *        - new slot:      `_emergencyMinter`
 *      OZ Upgrades validation enforces this at upgrade time.
 */
contract FYUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    OwnableUpgradeable
{
    address private _minter;

    // ── S1.3a / ADR-005 §2 — appended slot, storage-layout safe ──
    /**
     * @notice Multisig-only escape hatch for emergency mints. Address
     *         (typically the Gnosis Safe per ADR-007) is set by the
     *         contract owner via {setEmergencyMinter}.
     */
    address private _emergencyMinter;

    /// @notice Emitted whenever the single-minter slot is reassigned.
    /// @dev April-audit L-5 patch. The companion RUSD token already
    ///      emits an analogous event on rotation; FYUSD was the only
    ///      sibling token without it, leaving a silent observability
    ///      gap that off-chain monitors of "who can mint FYUSD" had no
    ///      cheap signal for.
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);

    /// @notice Emitted exactly once when {initialize} sets the initial owner.
    /// @dev April-audit L-6 patch (companion to InstitutionalRUSD). Same
    ///      audit-trail rationale: a dedicated single signal is cheaper
    ///      to grep for than the OZ stack's `OwnershipTransferred(0, x)`
    ///      pattern.
    event Initialized(address indexed initialOwner);

    /// @notice Emitted whenever the emergency-minter slot is reassigned.
    ///         Same observability rationale as {MinterUpdated}.
    event EmergencyMinterUpdated(address indexed previousEmergencyMinter, address indexed newEmergencyMinter);

    /// @notice Emitted on every {emergencyMint} call. Audit-ledger
    ///         indexer (ADR-009) keys on this event to flag any FYUSD
    ///         supply increase that did NOT originate from epoch
    ///         settlement.
    event EmergencyMint(address indexed operator, address indexed to, uint256 amount);

    error NotMinter();
    error NotEmergencyMinter();
    error ZeroAddress();
    error ZeroAmount();

    modifier onlyMinter() {
        if (msg.sender != _minter) revert NotMinter();
        _;
    }

    modifier onlyEmergencyMinter() {
        if (msg.sender != _emergencyMinter) revert NotEmergencyMinter();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __ERC20_init("FYUSD", "FYUSD");
        __ERC20Burnable_init();
        __ERC20Permit_init("FYUSD");
        __Ownable_init(owner_);
        emit Initialized(owner_);
    }

    function minter() external view returns (address) {
        return _minter;
    }

    function emergencyMinter() external view returns (address) {
        return _emergencyMinter;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newMinter == _minter) return;
        emit MinterUpdated(_minter, newMinter);
        _minter = newMinter;
    }

    /**
     * @notice Set the emergency-minter address. Owner-only because the
     *         role is a high-risk operations escape hatch. In production
     *         the expected setting is the multisig Safe address (ADR-007).
     */
    function setEmergencyMinter(address newEmergencyMinter) external onlyOwner {
        if (newEmergencyMinter == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newEmergencyMinter == _emergencyMinter) return;
        emit EmergencyMinterUpdated(_emergencyMinter, newEmergencyMinter);
        _emergencyMinter = newEmergencyMinter;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /**
     * @notice Mint outside the standard epoch-settlement flow. Multisig
     *         (or whichever address holds the {_emergencyMinter} role)
     *         only. Every call emits {EmergencyMint} so the audit-ledger
     *         indexer picks it up (ADR-009).
     */
    function emergencyMint(address to, uint256 amount) external onlyEmergencyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit EmergencyMint(msg.sender, to, amount);
    }

    /// @notice Reverted by {renounceOwnership} — see FYP-16.
    error RenounceDisabled();

    /// @dev FYP-16: ownership renouncement is disabled (mirrors {FYP}).
    ///      Renouncing would permanently lose owner authority (minter /
    ///      emergency-minter management, etc.), a non-recoverable failure mode.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
