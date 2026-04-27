# ADR-001: Burn 7-day delay enforced on-chain by UTC `block.timestamp`

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §3.1
- Resolves: GAP_ANALYSIS Q1

## Context

Phase 1 burn flow is "RUSD 즉시 소각, 출금 자산은 7일 후 청구". Two layer choices for the 7-day enforcement:

- **On-chain**: contract refuses `executeRedeem` until `block.timestamp >= request.requestedAt + 7 days`.
- **Off-chain only**: backend daemon refuses to sign before 7d, contract still allows immediate execution.

## Decision

7-day delay is enforced **on-chain**, gated by `block.timestamp` (UTC seconds). `block.number` is rejected because BSC has irregular block intervals (~3s now, was 5s pre-Lorentz upgrade) and Ethereum mainnet (Phase 1.2 target) is ~12s — both unstable as a clock.

```solidity
uint256 constant BURN_DELAY_SECONDS = 7 days; // 604800 UTC seconds
function executeRedeem(uint256 ticketId, ...) external {
    BurnTicket storage t = _tickets[ticketId];
    require(block.timestamp >= t.requestedAt + BURN_DELAY_SECONDS, "EarlyClaim");
    // ...
}
```

## Consequences

- **Trustless**: even if backend signer is compromised, user funds can't be drained pre-7d.
- **Backend daemon still required** to actually call `executeRedeem` at the right moment, but its role is timing/UX, not access control.
- **L1 timestamp manipulation** is bounded (~15s on Ethereum, ~3s on BSC) — not material vs 7d window.
- **Daylight saving / leap seconds** irrelevant — `block.timestamp` is monotonic UTC.
- Backend `BurnQueueDaemon` polls every ~5min, when `eligibleAt <= now()` issues the executor signature.
