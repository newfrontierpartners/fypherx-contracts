# Phase 1 Gap Analysis

> Source spec: `~/Downloads/PHASE1_SPEC.md`
> Onboarding: `~/Downloads/CLAUDE_CODE_BRIEFING.md`
> Generated: 2026-04-26
> Scope: smart contracts, backend gateway, admin dashboard. Frontend deferred until design handoff.
> Repos:
> - `fypherx-contracts/sotatek-smart-contracts/` (Solidity 0.8.22, Hardhat, OZ Upgradeable v5)
> - `fypherx-backend-services/` (Java 17, Spring Boot 3.2.5, multi-module Gradle)
> - `fypherx-admin-dashboard/` (Next.js 16 App Router, wagmi 3.5)

Categorization keys:
- ✅ **Already exists** — usable as-is
- 🔧 **Needs modification** — exists but spec-incompatible
- ➕ **Needs creation** — completely new
- 🗑 **Needs deprecation** — exists but conflicts with new model
- ❓ **Open question** — awaiting product decision

---

## 1. Mint / Burn (RUSD)

| Capability | Contracts | Backend | Admin |
|---|---|---|---|
| Mint USDT/USDC → RUSD | ✅ `FypherMinting.mint()` (ERC20) | ✅ `POST /api/v1/defi/mint/sign` | ✅ `/admin/supply` view |
| Mint ETH (oracle-converted) → RUSD | 🔧 `FypherMinting.mintWETH()` is broken: payable but never consumes `msg.value`; never wraps to WETH; reverts unless asset is whitelisted ERC20 | 🔧 No `/mint/native` path | ➕ |
| Burn RUSD (immediate burn, 7-day claim) | 🗑 + ➕ Current `requestRedeem` escrows RUSD; `executeRedeem` callable any time by executor — **no time gate, no NFT ticket** | 🗑 + ➕ `BurnRequestEntity` has `{PENDING, EXECUTED, CANCELLED}` only — no `eligibleAt`, no daemon | ✅ Partial: `/admin/collateral` shows queue; ➕ no per-user 7d-maturity timeline |
| Claim ticket NFT | ➕ Doesn't exist | ➕ | ➕ |
| Per-product pause (mint vs burn) | 🔧 Single flag `mintRedeemDisabled` (combined) | ➕ No flag in `application.yml` | 🔧 `PauseModal` toggles whole contract |
| Collateral ratio monitor (<100% → pause) | ➕ No on-chain auto-pause | ➕ No daemon | ✅ `/admin/supply` shows %; ➕ no auto-trigger |
| ETH oracle deviation (>1% → pause) | ➕ | ➕ | ⚠ Status only |

**Critical gaps**: 7-day delay, NFT ticket, per-product pause, ETH wrap path, oracle-deviation auto-pause.

---

## 2. Get FYUSD (12h epoch + Bitgo Prime)

| Capability | Contracts | Backend | Admin |
|---|---|---|---|
| `FYUSD` token | ✅ `FYUSD.sol` (ERC20 + ERC20Burnable + Permit + Ownable, single `_minter`) | ✅ Address wired in `application.yml` | ✅ Listed in treasury catalog |
| Epoch deposit vault (T+0~T+10h) | ➕ | ➕ | ➕ |
| Epoch lock at T+10h | ➕ | ➕ | ➕ |
| Bitgo Prime client + settlement vault | ➕ | ➕ (no `BitgoClient`, no Bitgo URL/key in config) | ➕ |
| Per-epoch user → expected FYUSD mapping | ➕ | ➕ no `EpochDepositEntity` | ➕ |
| FYUSD distribute at T+12h | ➕ | ➕ | ➕ |
| Bitgo SLA monitor (>1h → next-epoch defer) | ➕ | ➕ | ➕ |
| Epoch ticket NFT | ➕ | ➕ | ➕ |
| **Reuses existing**: nothing | | | |

**Note**: `EpochService` / `EpochLifecycleService` exist in backend but cover **points rewards epochs** (Phase 3 leaderboard), not FYUSD batch settlement. Naming clash to be careful with.

**Note**: FYUSD currently has `address private _minter` (single address). For Phase 1, this `_minter` will become the `FyusdEpochSettlement` contract, and the `EOA` minting path goes away (or becomes admin-only emergency).

**Critical gaps**: All four phases (deposit / lock / Bitgo / distribute) are 100% greenfield.

---

## 3. Staking (RUSD pool 1x + FYUSD pool 2x)

| Capability | Contracts | Backend | Admin |
|---|---|---|---|
| RUSD staking vault | ✅ `StakedRUSD.sol` (ERC4626 + APRRate + 8h linear vesting) | ✅ `GET /stakes/{token}` reads on-chain | ✅ `/admin` overview |
| FYUSD staking vault | 🔧 `StakedAUSD.sol` (= stAUSD) acts as the FYUSD-backed vault, but model is APRRate not pool-weight | ⚠ `VaultReadService` hardcodes 3 vaults | ⚠ user-facing only |
| **Single vault with sub-pools** (per spec §3.3) | 🗑 Current = separate ERC4626 vaults per token | n/a | n/a |
| **FPY emission** = `FPY/block × pool_weight × user_share` | ➕ Current uses APR % vesting, NOT block-based emission | ➕ no `FpyRewardService` | ⚠ `/admin/rewards` covers points epochs only, not FPY emission |
| Pool weight (RUSD=1, FYUSD=2) | ➕ Not configurable | ➕ | ➕ |
| FPY emission treasury (release schedule) | ➕ `FYP.sol` exists as ERC20 but no emission schedule contract | ➕ | ➕ |
| Cooldown silos | ✅ `RUSDSilo` / `SIRUSDSilo` / `FYPSilo` / `stAUSDSilo` exist | n/a | ✅ `/staking/withdraw` |
| Per-pool pause | ✅ each `Staked*` has `pause()`/`unpause()` | ➕ | ✅ `PauseModal` |
| FPY emission audit (mismatch alarm) | ➕ | ➕ | ➕ |

**Naming**: spec says **FPY**, contracts say **FYP**. Same token? Confirm before any rename. Current `FYP` token deployed at `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C`.

**Critical gaps**: pool-weight FPY emission engine; sub-pool architecture decision (refactor vs wrap); FPY emission audit ledger.

---

## 4. Vault (Concrete external adapter)

| Capability | Contracts | Backend | Admin |
|---|---|---|---|
| FYUSD-only deposit vault | ➕ Nothing (`FypherLPVault` is for Pancake LP, unrelated) | ➕ | ➕ |
| Concrete adapter (forwards to external pool) | ➕ | ➕ no `ConcreteClient` | ➕ |
| Share mapping (Concrete share → user share) | ➕ | ➕ | ➕ |
| Yield buffer + distribution scheduler | ➕ | ➕ | ➕ |
| 7d-realized APY display | ➕ | ➕ | ➕ |
| Withdraw (principal + yield) | ➕ | ➕ | ➕ |

**100% greenfield.** Concrete protocol BSC Testnet endpoint + share token contract address are required from product side before implementation.

---

## 5. Cross-cutting

### 5.1 Admin Vault Layer (spec §4)

| Vault | Status |
|---|---|
| Collateral vault | ✅ `ReservePool` (single pool, no hot/cold split) |
| Burn queue vault | 🔧 RUSD escrow inside `FypherMinting`; ➕ no separate vault |
| Epoch deposit vault | ➕ |
| Bitgo settlement vault | ➕ |
| Staking vault (RUSD/FYUSD pool) | 🗑 separate vaults — see §3 |
| FPY reward vault | ➕ |
| Concrete adapter | ➕ |
| Yield buffer | ➕ |
| Reserve treasury (cold multisig) | ➕ |
| Hot operating wallet | ➕ deployer EOA serves both roles |
| FPY emission treasury | ➕ |

### 5.2 Security

| Item | Status |
|---|---|
| ReentrancyGuard | ✅ all stateful contracts |
| Pausable | ✅ all `Staked*`, `FYP`, `InstitutionalRUSD` |
| SafeERC20 | ✅ |
| Per-product pause | 🔧 only per-contract pause; no per-user-flow pause |
| Multisig (cold treasury, FPY emission, admin override) | ➕ `SettingManagement` uses `SingleAdminAccessControl` — single admin EOA |
| Circuit breaker (auto on oracle/collateral) | ➕ |
| Audit ledger (on-chain event + off-chain DB) | 🔧 mint-sign only (`AdminAuditLogEntity`); ➕ no event indexer/reconciliation |

### 5.3 Monitoring (spec §5)

| Metric | Threshold | Where shown |
|---|---|---|
| Collateral ratio | <100% → mint pause | ✅ `/admin/supply` (no auto-trigger) |
| ETH oracle 편차 | >1% → mint pause | ⚠ status only, no trigger |
| Burn queue accumulation vs 7d maturity | gap > 0 → reserve top-up | ➕ |
| Epoch 미배포 잔량 | ≠0 → audit | ➕ |
| Bitgo SLA | >1h → next-epoch defer | ➕ |
| FPY emission rate vs distribute | mismatch → emission pause | ⚠ points epoch coverage only |
| Concrete APY drift | ±X% → notify | ➕ |
| sRUSD/sFYUSD ↔ underlying parity | ≠1:1 → halt | ⚠ vault-drift threshold exists, not 1:1 invariant |

---

## 6. Open questions — RESOLVED 2026-04-26 (see `docs/decisions/`)

All 12 questions answered. Each ADR is the binding source of truth.

| # | Question | Decision | ADR |
|---|---|---|---|
| 1 | Burn 7-day enforcement layer | On-chain `block.timestamp` UTC gate | [ADR-001](decisions/ADR-001-burn-7day-on-chain-utc.md) |
| 2 | Burn claim ticket form | DB-only UUID (no NFT) | [ADR-002](decisions/ADR-002-claim-ticket-db-only.md) |
| 3 | Staking refactor strategy | B안 — new `FypherStakingHub` vault + admin one-shot migration | [ADR-003](decisions/ADR-003-staking-hub-with-admin-migration.md) |
| 4 | FYP vs FPY | FYP (spec docs to be normalized) | [ADR-004](decisions/ADR-004-fyp-naming.md) |
| 5 | Bitgo Prime integration | Real API; interface-first (`MockBitgoClient` default for testnet, `RealBitgoClient` for live) | [ADR-005](decisions/ADR-005-bitgo-prime-interface-first.md) |
| 6 | Concrete protocol mode | Same interface; `MockConcreteAdapter` on BSC, `ConcreteAdapterV1` on Ethereum mainnet | [ADR-006](decisions/ADR-006-concrete-mock-on-bsc-real-on-eth.md) |
| 7 | Multisig admin | Gnosis Safe replaces `SingleAdminAccessControl`; testnet 2-of-3, mainnet 3-of-5; separate `PAUSER_ROLE` | [ADR-007](decisions/ADR-007-multisig-admin.md) |
| 8 | Per-product pause granularity | Option B — 11 flags total (per-asset mint/burn, per-pool stake, vault, epoch deposit, epoch settlement) | [ADR-008](decisions/ADR-008-per-asset-pool-pause.md) |
| 9 | Audit ledger scope | Full — Web3j indexer + daily reconciliation cron + admin view | [ADR-009](decisions/ADR-009-audit-ledger-web3j-indexer.md) |
| 10 | Launch network plan | 3-stage: BSC Testnet → Ethereum Sepolia → Ethereum Mainnet | [ADR-010](decisions/ADR-010-network-rollout-bsc-testnet-then-eth-mainnet.md) |
| 11 | Get-FYUSD epoch ticket form | DB-only UUID (same as #2) | [ADR-002](decisions/ADR-002-claim-ticket-db-only.md) |
| 12 | FYUSD `_minter` migration | `setMinter(EpochSettlement)` + retain `emergencyMint(admin, amount)` via separate `_emergencyMinter` slot (multisig-only) | [ADR-005](decisions/ADR-005-bitgo-prime-interface-first.md) §2 |

---

## 7. Proposed work plan

Per briefing §"세션 분리 권장": one Claude session per area. Order by dependency (contracts → backend → admin).

### Session 1 — Smart contracts (this session would be heaviest)

Order of implementation (each = own commit + tests):

1. `FypherBurnQueue` — 7-day delay gate + ERC-721 claim ticket (or simple ID-based ticket per Q2). Burn flow: user → `requestBurn()` mints ticket → after 7d ticket-holder calls `claim()`.
2. `FypherMinting` refactor — split `mintRedeemDisabled` into `{mintPaused, burnPaused}`; fix `mintWETH` to actually wrap ETH; add oracle-deviation auto-pause hook.
3. `FyusdEpochSettlement` — deposit vault + epoch ID + Bitgo settlement hook + distribute. Spec §3.2.
4. `FpyEmissionEngine` — block-based emission with per-pool weights. Adapter pattern: existing `Staked*` vaults register as pools.
5. `ConcreteAdapter` (or `MockConcreteAdapter` per Q6) + `FyusdYieldVault` for §3.4.
6. `FypherCircuitBreaker` — manual + auto trigger interface.
7. `SettingManagement` migration to `MultisigAdmin` (per Q7).
8. Unit tests: invariants from briefing (`RUSD ≤ collateral`, `sRUSD == underlying`, `epoch leftover == 0`).
9. Hardhat deploy script + addresses sync to backend/admin/frontend.

### Session 2 — Backend gateway

1. Burn queue: add `eligibleAt` field, daemon scanning, `executeRedeem` only after gate.
2. FYUSD epoch service: `EpochDepositService` + `BitgoClient` (mockable interface) + scheduler.
3. FPY accrual reader: read `FpyEmissionEngine` view fns; expose `/api/v1/defi/fpy/{address}` with claimable + accrued.
4. Concrete vault read service: TVL, 7d realized APY, deposit/withdraw preview.
5. Per-product pause feature flags in `application.yml` + `/admin/pause` endpoints.
6. Audit indexer (per Q9): scaffold `EventIndexerService` + `event_log` table, populate from new contract events.

### Session 3 — Admin dashboard

1. `/admin/burn-queue/` — per-user pending tickets + 7d timeline + reserve forecast.
2. `/admin/fyusd-epochs/` — current epoch state + Bitgo SLA + distribute audit.
3. `/admin/staking-pools/` — per-pool TVL + FPY emission + weight controls.
4. `/admin/vault-yield/` — Concrete APY + buffer + parity monitor.
5. `/admin/audit-ledger/` — event stream view (depends on backend indexer).
6. Per-product pause UI: split current `PauseModal` into per-flow toggles.

### Session 4 — Frontend (later, when Claude Design handoff lands)

Wire all of the above into the customer-facing flows. Out of scope until design.

---

## 8. ADRs — written 2026-04-26

All 10 ADRs live in `docs/decisions/` and are referenced from §6 above. Each ADR is the binding spec for the corresponding code in S1–S3.

Read order before starting S1:
1. `ADR-010` (network plan) — sets cross-cutting context.
2. `ADR-007` (multisig) + `ADR-008` (pause) — affect every contract.
3. `ADR-001` + `ADR-002` (burn 7-day + ticket).
4. `ADR-003` (staking hub).
5. `ADR-005` (FYUSD epoch + Bitgo).
6. `ADR-006` (Concrete vault).
7. `ADR-009` (audit ledger) — affects backend more than contracts.
8. `ADR-004` (FYP naming) — informational only.

Cross-network address management (per ADR-010): the existing `deployed-addresses.json` will be split into `addresses/{bsc-testnet,sepolia,mainnet}.json`. Backend + admin both read by `chainId`. To be done in S1.9 (deployment script restructure).
