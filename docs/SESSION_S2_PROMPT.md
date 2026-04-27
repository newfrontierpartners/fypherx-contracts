# S2 — Backend gateway session kickoff prompt

> Copy-paste this prompt into the new Claude Code session to begin S2.

---

You are joining the Fypher Phase 1 implementation, backend gateway session (S2).

**Read first, in order**:
1. `~/Downloads/CLAUDE_CODE_BRIEFING.md` — process rules. Critical: do NOT modify code without confirming the plan.
2. `~/Downloads/PHASE1_SPEC.md` — product spec.
3. `~/Documents/Fypher/fypherx-contracts/docs/GAP_ANALYSIS.md` — current state per area + product (S1 column should now read "implemented" for everything except S2/S3 followups).
4. `~/Documents/Fypher/fypherx-contracts/docs/decisions/ADR-001` through `ADR-010` (binding decisions).
5. `~/Documents/Fypher/fypherx-contracts/docs/SESSION_S1_PROMPT.md` — the contracts session prompt, for context on what S1 produced.
6. `~/Documents/Fypher/fypherx-backend-services/CLAUDE.md` — backend repo conventions (Spring Boot stack, modules, ports).

**Your scope (S2)**: backend gateway only. Smart contracts (S1) are done. Admin (S3) is a separate session. Frontend (S4) waits for the design handoff.

**Working tree**: `/Users/shchoi/Documents/Fypher/fypherx-backend-services/fypherx-gateway/`. Java 17, Spring Boot 3.2.5, Gradle multi-module. PostgreSQL 16 + Redis 7. Web3j 4.10.3 for chain interaction. Branch off `develop`: `feat/phase1-backend`.

**Phase 1 contracts you will integrate against** (deployed by S1, addresses live in `fypherx-contracts/sotatek-smart-contracts/addresses/97.json` for BSC Testnet):

| Contract | What S2 needs from it |
|---|---|
| `FypherMinting` (existing, S1.2 refactor) | Mint sign endpoint already exists; per-asset pause query for the new pause feature flags (S2.5) |
| `FypherBurnQueue` (S1.1, new) | Backend signs the BurnQuote at request time; daemon polls for tickets eligible to claim (S2.1) |
| `FyusdEpochSettlement` (S1.3, new) | New deposit + epoch lifecycle endpoints (S2.2) |
| `FYUSD` (S1.3, upgraded) | `_minter` slot now points at FyusdEpochSettlement; `emergencyMint` reachable for ops |
| `FypherStakingHub` (S1.4, new) | FPY accrual reader (S2.3) — view-only `pendingFpy(poolId, user)` |
| `FyusdYieldVault` + `IConcreteAdapter` (S1.5, new) | Vault read service (S2.4) — totalAssets, realizedYield7d, sharesOf |
| `FypherCircuitBreaker` (S1.6, new) | Watchdog EOA (off-chain monitor in this session) calls trip() per spec §5 thresholds |

**Deliverables (each = own commit)**:

| # | Service / change | Spec / ADR ref |
|---|---|---|
| S2.1 | `BurnQueueDaemon` — Spring `@Scheduled` job that polls FypherBurnQueue for tickets where `block.timestamp >= claimableAt`, posts the executor signature to claim, marks the off-chain `BurnRequestEntity` row EXECUTED. Add `eligibleAt` field to entity. | ADR-001, spec §3.1 |
| S2.2 | `EpochDepositService` + `BitgoClient` interface + `MockBitgoClient` impl — accepts user deposits during the OPEN window, signs deposit quotes for FyusdEpochSettlement, scheduled lock at T+10h, calls Bitgo for settlement, distributes at T+12h. New REST endpoints `/api/v1/defi/fyusd/epoch/{id}` etc. | ADR-005, spec §3.2 |
| S2.3 | FPY accrual reader — new endpoints `/api/v1/defi/fpy/{address}` and `/api/v1/defi/staking/pools` reading FypherStakingHub view fns. | ADR-003, spec §3.3 |
| S2.4 | Concrete vault read service — endpoints to surface FyusdYieldVault `totalAssets`, `sharesOf(user)`, 7d realized APY for the admin dashboard. | ADR-006, spec §3.4 |
| S2.5 | Per-product pause feature flags — read on-chain `mintPaused[asset]`, `burnPaused[asset]`, `pools[id].paused`, `vaultPaused`, `depositPaused[asset]`, `settlementPaused`; expose at `/api/v1/defi/pauses` for the admin grid; UI gating only (on-chain truth wins). | ADR-008 |
| S2.6 | Audit indexer scaffold — `EventIndexerService` that registers Web3j filter subscriptions for the contracts listed in ADR-009; `event_log` + `indexer_cursor` JPA entities; daily reconciliation cron skeleton (the comparison logic itself can be a stub for now). | ADR-009 |

**Conventions to follow** (from existing tree):
- Module layout per `fypherx-backend-services/CLAUDE.md`. Inter-service comms = synchronous REST.
- Web3j `Credentials` for signing. `BACKEND_SIGNER_PRIVATE_KEY` and `BACKEND_EXECUTOR_PRIVATE_KEY` are already in env / k8s Secret (see prior fix that landed in PR #84 of the backend repo).
- DB: Hibernate-managed with `ddl-auto: update` for gateway. **No Flyway/Liquibase yet** — verify generated DDL against staging before deploying.
- Tests: JUnit 5 + Mockito. New services should ship with at least one `@SpringBootTest` happy-path test.
- Audit log writes go through `AdminAuditLogJpaRepository` (already exists, used by `MintingSignerService`).

**Out of scope for S2**:
- Smart contracts (done in S1).
- Admin / frontend code.
- Real `BitgoClient` implementation (interface-first per ADR-005; Mock impl for now, real wired when keys are provisioned).
- Real Concrete adapter integration (S1.5 stub — backend just reads `MockConcreteAdapter` view fns on BSC).
- KMS / HSM key migration.

**Workflow** (per briefing):
1. After reading the docs above, send a recap message confirming you understand each S2 deliverable's binding decision.
2. Propose the implementation order. Suggested: S2.1 (smallest, daemon) → S2.5 (read-only flags) → S2.3 (read-only FPY) → S2.4 (read-only vault) → S2.6 (indexer scaffold) → S2.2 (largest, epoch + Bitgo).
3. WAIT for user approval before writing code.
4. Per-deliverable: write tests first (where practical), then service, run `./gradlew :fypherx-gateway:test`, commit, move on.

**Existing assets you can reuse**:
- `MintingSignerService.java` — EIP-191 personal_sign pattern; copy for BurnQueue executor signature.
- `BurnRequestEntity` (in `fypherx-common/entity/`) — extend with `eligibleAt` + `txHash` columns. The full lifecycle is already wired in `DefiController.java`.
- `LiquidityPositionService` — example pattern of a daemon that scans on-chain state.
- `AdminAuditLogEntity` + `AdminAuditLogJpaRepository` — write side of the audit ledger that S2.6 should formalise.
- The k8s `chain-secrets` Secret already includes `BACKEND_SIGNER_PRIVATE_KEY` + `BACKEND_EXECUTOR_PRIVATE_KEY` (see PR #84 of the backend repo). Add `FYPHERX_BITGO_*` env vars per ADR-005.

**Things deliberately NOT being done in S2** (don't try to fix in scope):
- Frontend customer flows (waiting for Claude Design handoff).
- Migration to EIP-712 typed data for mint signing (already P0, separate track per CLAUDE.md). Note: contracts use EIP-712 since the April audit landed; the backend mint-sign code probably needs to be updated too — flag as a P0 for the next backend session, NOT this S2 work, unless the user explicitly requests it.

**Key on-chain context**:
- Active deploy: BSC Testnet (chainId 97). Per-chain addresses at `fypherx-contracts/sotatek-smart-contracts/addresses/97.json`.
- Deployer EOA: `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4`. Private key in `sotatek-smart-contracts/.env` `PRIVATE_KEY`. This is the same key as the backend `BACKEND_SIGNER_PRIVATE_KEY` and `BACKEND_EXECUTOR_PRIVATE_KEY` defaults.
- ABI files: re-export from `sotatek-smart-contracts/artifacts/contracts/Fypher/{...}.sol/{...}.json` after `npx hardhat compile`. The backend uses Web3j `Contract.deployedAt(...)` style binding.

Begin by reading the docs and confirming the plan.
