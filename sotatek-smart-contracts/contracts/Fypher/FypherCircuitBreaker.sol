// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/ISettingManagement.sol";

/**
 * @title FypherCircuitBreaker
 * @notice Spec §6 + ADR-008 orchestrator. The breaker is registered as
 *         the {pauserRole} on every Phase 1 contract that exposes a
 *         per-asset/pool/phase pause (FypherMinting, FypherBurnQueue,
 *         FypherStakingHub, FyusdEpochSettlement, FyusdYieldVault).
 *
 *         Two operating modes per spec §6 ("자동 trigger + multisig
 *         manual override 조합"):
 *
 *           1. Auto trigger: an off-chain monitor (the {watchdog} EOA)
 *              detects an oracle deviation, collateral shortfall, or
 *              Bitgo SLA breach (PHASE1_SPEC §5 thresholds) and calls
 *              {trip(triggerId, calls, reasonHash)}. The breaker
 *              executes the encoded `setXxxPaused(target, true)` calls
 *              one at a time and emits {Tripped} for the audit ledger
 *              (ADR-009).
 *
 *           2. Manual override: multisig admin calls {reset(triggerId,
 *              calls, reasonHash)}, which executes the corresponding
 *              `setXxxPaused(target, false)` calls. Unpause is admin-
 *              only — matches the asymmetric authorization on each
 *              target contract.
 *
 *         The breaker also lets ops register named triggers ahead of
 *         time so the dashboard can render a clean grid of
 *         "things-that-can-be-tripped" instead of asking operators to
 *         hand-encode call data at incident time.
 *
 *         Each {Trigger} record carries a name, description, and the
 *         pre-encoded (target, pause-call, unpause-call) tuples. This
 *         is the on-chain ledger of "what does ETH oracle deviation
 *         mean, in concrete pause terms" — auditable forever.
 *
 *         <p><b>FYP-18 — unpauseCalls are an off-chain template by
 *         design</b>. The {Trigger.unpauseCalls} array is recorded
 *         and validated during {registerTrigger} / {updateTrigger},
 *         but {reset} deliberately does NOT iterate it on-chain.
 *         Reason: under SingleAdminAccessControl, the breaker holds
 *         pauserRole on each target (so it can call setXxxPaused
 *         with paused=true) but NOT admin role — every target's
 *         unpause path is admin-only (ADR-007 asymmetric authorisation).
 *         So the breaker cannot execute the unpause subcalls itself;
 *         the multisig must submit them directly.
 *
 *         The unpauseCalls array is therefore an on-chain TEMPLATE
 *         that the multisig dashboard reads (via {unpauseCallAt}) to
 *         pre-fill the exact (target, calldata) tuples a human
 *         operator should sign on the Safe UI. CertiK suggested
 *         moving this template into a TriggerRegistered event field
 *         to drop storage cost. We chose to keep it in storage so
 *         the dashboard does not depend on a log-indexer being up at
 *         incident time (latency-critical). The storage cost is
 *         paid once per trigger (4-8 triggers total expected), not
 *         per trip, so the trade is acceptable.
 *
 * @dev Tracked decisions: ADR-007 (multisig as admin), ADR-008
 *      (per-asset pause), ADR-009 (audit ledger).
 */
contract FypherCircuitBreaker is Initializable, ReentrancyGuardUpgradeable {

    // ── Constants ──
    /// @notice FYP-50 patch. Cap on pause / unpause call slots per
    ///         trigger. 16 fits comfortably more than the 5-7 target
    ///         contracts each named trigger pauses in practice, and
    ///         keeps {trip} below the gas-budget pain point at
    ///         incident time.
    uint256 public constant MAX_CALLS_PER_TRIGGER = 16;

    // ── Types ──

    struct Call {
        address target;
        bytes   data;
    }

    struct Trigger {
        string  name;
        string  description;
        Call[]  pauseCalls;     // executed by {trip}
        Call[]  unpauseCalls;   // executed by {reset}
        bool    tripped;
        uint64  trippedAt;
    }

    // ── Storage ──

    ISettingManagement public settingManagement;
    address            public watchdog;

    Trigger[] private _triggers;

    // ── Events ──

    event WatchdogUpdated(address indexed oldWatchdog, address indexed newWatchdog);
    event TriggerRegistered(uint256 indexed triggerId, string name, uint256 pauseCallCount);
    event Tripped(uint256 indexed triggerId, string name, address indexed by, bytes32 reasonHash);
    event Reset(uint256 indexed triggerId, string name, address indexed by, bytes32 reasonHash);
    event SubcallFailed(uint256 indexed triggerId, uint256 callIndex, address target, bytes returnData);

    // ── Errors ──

    error NotAdmin();
    error NotWatchdogOrAdmin();
    error TriggerNotFound(uint256 triggerId);
    error AlreadyTripped();
    error NotTripped();
    error ZeroAddress();
    error EmptyTrigger();
    error SubcallReverted(uint256 callIndex, address target, bytes returnData);
    /// @notice FYP-50: too many pause/unpause calls registered for
    ///         this trigger.
    error CallsetTooLarge(uint256 length, uint256 cap);

    // ── Init ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(ISettingManagement _settingManagement, address _watchdog)
        external
        initializer
    {
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        settingManagement = _settingManagement;
        watchdog = _watchdog;
    }

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    modifier onlyWatchdogOrAdmin() {
        if (msg.sender != watchdog && !settingManagement.hasRole(bytes32(0), msg.sender)) {
            revert NotWatchdogOrAdmin();
        }
        _;
    }

    // ── Trigger registry (admin) ──

    /**
     * @notice Register a named trigger plus its pre-encoded pause /
     *         unpause call sets. Admin-only because mis-registered
     *         triggers can pause the wrong things.
     *
     *         Returns the assigned triggerId (0-indexed). The slot is
     *         append-only — there's no de-register; admins can edit a
     *         trigger via {updateTrigger}.
     */
    function registerTrigger(
        string calldata name,
        string calldata description,
        Call[] calldata pauseCalls,
        Call[] calldata unpauseCalls
    ) external onlyAdmin returns (uint256 triggerId) {
        uint256 pauseLen = pauseCalls.length;
        if (pauseLen == 0) revert EmptyTrigger();
        // FYP-50: callset caps so {trip} stays affordable at incident
        // time. Apply to both arrays — unpauseCalls is dashboard
        // template only, but the storage cost is still amortised by
        // the same cap.
        if (pauseLen > MAX_CALLS_PER_TRIGGER) revert CallsetTooLarge(pauseLen, MAX_CALLS_PER_TRIGGER);
        uint256 unpauseLen = unpauseCalls.length;
        if (unpauseLen > MAX_CALLS_PER_TRIGGER) revert CallsetTooLarge(unpauseLen, MAX_CALLS_PER_TRIGGER);
        triggerId = _triggers.length;
        Trigger storage t = _triggers.push();
        t.name = name;
        t.description = description;
        // FYP-38: cache .length to avoid re-reading per iteration.
        for (uint256 i = 0; i < pauseLen; ++i) {
            if (pauseCalls[i].target == address(0)) revert ZeroAddress();
            t.pauseCalls.push(pauseCalls[i]);
        }
        for (uint256 i = 0; i < unpauseLen; ++i) {
            if (unpauseCalls[i].target == address(0)) revert ZeroAddress();
            t.unpauseCalls.push(unpauseCalls[i]);
        }
        emit TriggerRegistered(triggerId, name, pauseLen);
    }

    /**
     * @notice Replace an existing trigger's definition. Admin-only.
     *         Used when target contract addresses rotate (e.g. a proxy
     *         upgrade that points at a new pause function selector).
     */
    function updateTrigger(
        uint256 triggerId,
        string calldata name,
        string calldata description,
        Call[] calldata pauseCalls,
        Call[] calldata unpauseCalls
    ) external onlyAdmin {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        uint256 pauseLen = pauseCalls.length;
        if (pauseLen == 0) revert EmptyTrigger();
        if (pauseLen > MAX_CALLS_PER_TRIGGER) revert CallsetTooLarge(pauseLen, MAX_CALLS_PER_TRIGGER);
        uint256 unpauseLen = unpauseCalls.length;
        if (unpauseLen > MAX_CALLS_PER_TRIGGER) revert CallsetTooLarge(unpauseLen, MAX_CALLS_PER_TRIGGER);
        Trigger storage t = _triggers[triggerId];
        // FYP-56 patch. Refuse to overwrite a tripped trigger — the
        // pause-call set is currently in-effect against its targets,
        // so the on-chain "what was tripped" ledger entry from the
        // {Tripped} event must keep matching the stored
        // {pauseCalls}. Operators who actually want to edit a
        // tripped trigger should {reset} first.
        if (t.tripped) revert AlreadyTripped();
        t.name = name;
        t.description = description;
        delete t.pauseCalls;
        delete t.unpauseCalls;
        // FYP-38: cache .length to avoid re-reading per iteration.
        for (uint256 i = 0; i < pauseLen; ++i) {
            if (pauseCalls[i].target == address(0)) revert ZeroAddress();
            t.pauseCalls.push(pauseCalls[i]);
        }
        for (uint256 i = 0; i < unpauseLen; ++i) {
            if (unpauseCalls[i].target == address(0)) revert ZeroAddress();
            t.unpauseCalls.push(unpauseCalls[i]);
        }
        emit TriggerRegistered(triggerId, name, pauseLen);
    }

    // ── Trip / Reset ──

    /**
     * @notice Execute the trigger's pause-call set in order. Watchdog or
     *         admin can trip. The breaker MUST hold pauserRole on every
     *         target contract that the calls touch — otherwise the
     *         `setXxxPaused` selector reverts.
     *
     *         If any subcall reverts, the entire {trip} reverts so the
     *         operator sees a consistent "tripped or not" state.
     */
    function trip(uint256 triggerId, bytes32 reasonHash)
        external
        onlyWatchdogOrAdmin
        nonReentrant
    {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        Trigger storage t = _triggers[triggerId];
        if (t.tripped) revert AlreadyTripped();
        t.tripped = true;
        t.trippedAt = uint64(block.timestamp);
        // FYP-38: cache .length once — storage SLOAD only on first read.
        uint256 callLen = t.pauseCalls.length;
        for (uint256 i = 0; i < callLen; ++i) {
            (bool ok, bytes memory ret) = t.pauseCalls[i].target.call(t.pauseCalls[i].data);
            if (!ok) revert SubcallReverted(i, t.pauseCalls[i].target, ret);
        }
        emit Tripped(triggerId, t.name, msg.sender, reasonHash);
    }

    /**
     * @notice Mark the trigger as resolved in the breaker's audit ledger.
     *         Admin-only (multisig). Does NOT actually call the unpause
     *         functions on each target — under SingleAdminAccessControl
     *         the breaker cannot hold admin role on the targets, so the
     *         unpause must be issued by the multisig directly to each
     *         target via {target.setXxxPaused(asset, false)}. The
     *         breaker.reset() call is the on-chain commit that "ops have
     *         decided the incident is over"; the actual unpause txs are
     *         the operational follow-up.
     *
     *         The {Reset} event lets the audit-ledger indexer (ADR-009)
     *         pair the trip with its corresponding resolution.
     *
     *         {unpauseCalls} stay in storage as an off-chain template:
     *         the multisig dashboard reads {unpauseCallAt} to render the
     *         exact tx batch a human should sign on the Safe UI.
     */
    function reset(uint256 triggerId, bytes32 reasonHash)
        external
        onlyAdmin
    {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        Trigger storage t = _triggers[triggerId];
        if (!t.tripped) revert NotTripped();
        t.tripped = false;
        t.trippedAt = 0;
        emit Reset(triggerId, t.name, msg.sender, reasonHash);
    }

    // ── Admin ──

    function setWatchdog(address newWatchdog) external onlyAdmin {
        // FYP-25: zero watchdog is a footgun — the {onlyWatchdogOrAdmin}
        // modifier would still let the admin trip, but external
        // dashboards that read {watchdog} for "who can trip" would
        // see address(0) and assume the role is intentionally unset.
        if (newWatchdog == address(0)) revert ZeroAddress();
        // FYP-39: skip the SSTORE + event when the value is unchanged.
        if (newWatchdog == watchdog) return;
        emit WatchdogUpdated(watchdog, newWatchdog);
        watchdog = newWatchdog;
    }

    // ── View ──

    function triggersLength() external view returns (uint256) {
        return _triggers.length;
    }

    function triggerInfo(uint256 triggerId)
        external
        view
        returns (
            string memory name,
            string memory description,
            uint256 pauseCallCount,
            uint256 unpauseCallCount,
            bool    tripped,
            uint64  trippedAt
        )
    {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        Trigger storage t = _triggers[triggerId];
        return (t.name, t.description, t.pauseCalls.length, t.unpauseCalls.length, t.tripped, t.trippedAt);
    }

    function pauseCallAt(uint256 triggerId, uint256 idx)
        external
        view
        returns (address target, bytes memory data)
    {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        Call storage c = _triggers[triggerId].pauseCalls[idx];
        return (c.target, c.data);
    }

    function unpauseCallAt(uint256 triggerId, uint256 idx)
        external
        view
        returns (address target, bytes memory data)
    {
        if (triggerId >= _triggers.length) revert TriggerNotFound(triggerId);
        Call storage c = _triggers[triggerId].unpauseCalls[idx];
        return (c.target, c.data);
    }
}
