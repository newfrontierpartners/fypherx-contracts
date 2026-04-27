# ADR-007: Replace `SingleAdminAccessControl` with Gnosis Safe-style multisig

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §6
- Resolves: GAP_ANALYSIS Q7 + B-3

## Context

Current admin is `SingleAdminAccessControl` — one EOA, no quorum. Spec §6 requires multisig for cold treasury, FPY emission, and admin override. Phase 1.0 (BSC Testnet) needs working multisig for testing the operator flow; Phase 1.2 (Ethereum mainnet) needs production-grade multisig.

## Decision

`SettingManagement.admin` is migrated to a **Gnosis Safe** (or Safe-compatible) multisig.

### Signer sets

- **BSC Testnet (Phase 1.0)**: 2-of-3
  - Deployer EOA (`0x31B60b11...`)
  - Product owner EOA (TBD — user to provide)
  - Engineering placeholder EOA (rotated to real collaborator pre-launch)
- **Ethereum Mainnet (Phase 1.2)**: 3-of-5
  - Dev #1, Dev #2 (active engineering)
  - Ops #1, Ops #2 (operations)
  - Cold #1 (offline hardware wallet, recovery only)

Initial signer addresses to be captured per environment in `docs/decisions/multisig-signers.md` (created at S1 deploy time, not committed with raw keys).

### Migration steps (per network)

1. Deploy Gnosis Safe via official factory; record Safe address.
2. `SettingManagement.transferAdmin(<safeAddress>)` — single-sig last call from current EOA admin.
3. All future admin operations (`setBackendSigner`, `addSupportedAsset`, `pause(*)`, `setMinter`, `migrate`, etc.) require Safe quorum.

### Pauser carve-out

For low-latency circuit-breaker scenarios (oracle deviation, collateral shortfall), a separate `PAUSER_ROLE` is granted to a single ops EOA (BSC Testnet) or the on-call engineer's EOA (mainnet). Pauser can only `pause(*)` — cannot mint, transfer, or unpause. Unpause requires multisig quorum. See ADR-008 for pause semantics.

## Consequences

- Every admin operation in operator console (admin dashboard) generates a Safe transaction → operator opens Safe UI / API to collect signatures → broadcast.
- Admin dashboard adds "pending Safe txs" sidebar.
- Adds ~30k gas per admin tx vs single-EOA — irrelevant for ops cadence.
- `PAUSER_ROLE` introduces a single point of control for emergency pause — acceptable since pause is a defensive (not custodial) action.
- Recovery: if the Safe loses quorum (e.g., 3 of 5 keys lost on mainnet), no admin op possible — emphasizes need for cold key backups.
