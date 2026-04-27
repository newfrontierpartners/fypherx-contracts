# ADR-002: Burn + Get-FYUSD claim tickets are DB-only IDs (no NFT)

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §3.1, §3.2, §7
- Resolves: GAP_ANALYSIS Q2 + Q11

## Context

Spec §7 says "Claim ticket NFT 화" is preferred for wallet visibility. Trade-offs:

| | NFT (ERC-721) | DB-only ID |
|---|---|---|
| Wallet visibility | ✓ | ✗ |
| Gas cost per request | +~80k | 0 |
| L2/cross-chain | composable | not |
| Implementation cost | +1 contract per ticket type | 0 |
| Spec compliance | spec preferred | spec acceptable (UX surfaced via app) |

## Decision

Tickets are tracked as **off-chain UUID** in PostgreSQL, exposed via API. No NFT contract is deployed in Phase 1.

- Burn tickets: `burn_request.id` (UUID v4) — already exists in `BurnRequestEntity`.
- Get-FYUSD epoch tickets: new `epoch_deposit.id` (UUID v4) on `EpochDepositEntity`.

The on-chain contract still emits a numeric `ticketId` (uint256 sequence) for event-log indexing, but the user-visible identifier is the UUID.

## Consequences

- Wallet apps cannot display tickets natively — front-end + admin must show "pending tickets" list.
- Cross-chain redeem composability lost — acceptable for Phase 1 (single chain per network).
- Phase 2+ may upgrade to NFT (additive — UUID can serve as NFT metadata).
- Contract gas is materially cheaper.
