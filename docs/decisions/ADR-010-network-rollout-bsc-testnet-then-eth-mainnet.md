# ADR-010: Three-network rollout (BSC Testnet → Ethereum Sepolia → Ethereum Mainnet)

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` (network not specified)
- Resolves: GAP_ANALYSIS Q10

## Context

Current deploys live on BSC Testnet (chainId 97). Phase 1 production target is Ethereum Mainnet (per user). External integrations (Bitgo, Concrete) have native Ethereum support; BSC support is partial (Bitgo) or absent (Concrete).

## Decision

Three-stage rollout:

| Phase | Network | Chain ID | Bitgo | Concrete | Multisig | Purpose |
|---|---|---|---|---|---|---|
| **1.0** | BSC Testnet | 97 | Mock (ADR-005) | Mock (ADR-006) | 2-of-3 Safe | Internal testing, UI iteration, bug bash |
| **1.1** | Ethereum Sepolia | 11155111 | Bitgo Sandbox (real API, fake funds) | Real (if Concrete sepolia exists) or Mock | 2-of-3 Safe | Pre-prod with real-API integration tests |
| **1.2** | Ethereum Mainnet | 1 | Bitgo Prime (live) | Concrete (live) | 3-of-5 Safe | Production launch |

### Cross-network code factoring

- Single Solidity codebase. Per-network differences live in:
  - `deploy-{network}.js` deployment script.
  - `addresses-{chainId}.json` (replaces single `deployed-addresses.json`).
- Adapters (`IBitgoClient`, `IConcreteAdapter`) chosen at backend boot via env: `FYPHERX_NETWORK={bsc-testnet,sepolia,mainnet}`.
- Frontend / admin: `CONTRACT_ADDRESSES[chainId]` map already exists in admin dashboard (`addresses.ts` keyed by `BSC_TESTNET_CHAIN_ID = 97`); extend to keys 11155111 and 1.

### Promotion criteria (1.0 → 1.1)

- All Phase 1 user flows green on BSC Testnet for ≥2 weeks.
- Audit ledger reconciliation 0 mismatches across that window.
- `FypherCircuitBreaker` exercised at least once via simulated oracle deviation.
- Multisig migration drill on testnet.

### Promotion criteria (1.1 → 1.2)

- External audit on contracts.
- Bitgo Prime mainnet account active with live KYC/onboarding.
- Concrete mainnet adapter signature verified against Concrete deployed contracts.
- Cold-storage signers physically deployed (hardware wallets distributed).
- Runbooks signed off by ops.

## Consequences

- `deployed-addresses.json` becomes per-chain folder.
- Backend env adds `FYPHERX_NETWORK` selector + chain-specific RPC config blocks.
- Admin dashboard chain switch: wagmi wallet `chainId` already drives address map, but operator UI needs visible "you are on chainX" banner per environment.
- 3 deploy pipelines (one per chain) — codified as `.github/workflows/deploy-{chain}.yml`.
- Contract upgrades: each chain has independent proxy admin; coordinated upgrades require per-chain Safe txs.
