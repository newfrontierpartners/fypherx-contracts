# S3 — Admin dashboard session kickoff prompt

> Copy-paste this prompt into the new Claude Code session to begin S3.

---

You are joining the Fypher Phase 1 implementation, admin dashboard session (S3).

**Read first, in order**:
1. `~/Downloads/CLAUDE_CODE_BRIEFING.md` — process rules. Critical: do NOT modify code without confirming the plan.
2. `~/Downloads/PHASE1_SPEC.md` — product spec.
3. `~/Documents/Fypher/fypherx-contracts/docs/GAP_ANALYSIS.md` — current state per area + product. S1 + S2 should now read "implemented".
4. `~/Documents/Fypher/fypherx-contracts/docs/decisions/ADR-001` through `ADR-010` (binding decisions).
5. `~/Documents/Fypher/fypherx-contracts/docs/SESSION_S1_PROMPT.md` and `SESSION_S2_PROMPT.md` — context on what S1 and S2 produced.
6. `~/Documents/Fypher/fypherx-admin-dashboard/CLAUDE.md` — admin repo conventions (Next.js 16 App Router, wagmi 3.5, TanStack Query 5, Tailwind 4, pnpm).

**Your scope (S3)**: admin dashboard only. Smart contracts (S1) are done. Backend gateway (S2) is done. Frontend customer app (S4) waits for the design handoff.

**Working tree**: `/Users/shchoi/Documents/Fypher/fypherx-admin-dashboard/`. Next.js 16 App Router + React 19 + Tailwind 4 + wagmi 3.5 + TanStack Query 5. **pnpm** (NOT npm). Branch off `develop`: `feat/phase1-admin`.

**Backend endpoints S3 consumes** (all live after S2 PRs #101 + #102):

| Endpoint | What | Used by |
|---|---|---|
| `GET /api/v1/defi/pauses` | 11-flag pause grid (PauseStateReadService) | S3.1 PauseGridView |
| `GET /api/v1/defi/staking/pools` | Per-pool TVL + weight + accFpyPerShare + paused | S3.2 StakingPoolsView |
| `GET /api/v1/defi/fpy/{address}` | Per-user pending FPY across pools | S3.2 (user lookup tab) |
| `GET /api/v1/defi/yield-vault` | Concrete vault TVL + 7d realized APY | S3.3 VaultYieldView |
| `GET /api/v1/defi/yield-vault/user/{address}` | Per-user share position | S3.3 (user lookup tab) |
| `GET /api/v1/defi/fyusd/deposits?wallet=...` | Per-user epoch deposit history | S3.4 EpochsView |
| `GET /api/v1/defi/burn/requests/admin` | Admin burn queue list | S3.5 BurnQueueView (extends existing) |

**Deliverables** (each = own commit; recommended order smallest → largest):

| # | Page / change | Backend ref |
|---|---|---|
| S3.1 | `/admin/pause-grid` — 11-flag pause grid with state badges (PAUSED / UNPAUSED / UNKNOWN). Read-only, polls every 30s. The actual pause/unpause buttons stay on the existing per-contract `PauseModal`. | S2.5 |
| S3.2 | `/admin/staking-pools` — per-pool table (RUSD pool / FYUSD pool): TVL, weightBps × 1e4 = "Nx multiplier", accFpyPerShare, paused. Plus a user lookup tab calling `/fpy/{address}`. | S2.3 |
| S3.3 | `/admin/vault-yield` — Concrete vault tile: totalAssets, totalShares, 7d realized APY (gauge), adapterShares parity check. User lookup tab too. | S2.4 |
| S3.4 | `/admin/fyusd-epochs` — current epoch state from on-chain (read via wagmi reads against `fyusdEpochSettlementAddress`), list of recent deposits, Bitgo SLA tracker (compares deposit epoch's `lockAt` to actual settlement timestamp). | S2.2 |
| S3.5 | `/admin/burn-queue` extension — extend existing `/admin/collateral` page (or fork) with the new-flow ticket lifecycle: `eligibleAt` countdown, claim_tx_hash status, daemon health indicator. | S2.1 (extends existing) |
| S3.6 | `/admin/audit-ledger` — paged event log view consuming a future `GET /api/v1/admin/audit/events` endpoint (S2.6 backend already persists `audit_event_log` rows; the read endpoint is S3-side scope OR add it to the gateway as a tiny S3.6.b followup). | S2.6 |

**Conventions to follow** (from existing tree):
- App Router under `src/app/`. Each new page = `src/app/admin/{slug}/page.tsx`.
- All backend calls go through `src/lib/fypherx/client.ts` — extend that file, don't add ad-hoc fetches elsewhere. Confirm each new endpoint there before consuming it in a page.
- Auth: wallet JWT via wagmi; existing `src/lib/adminAuth.ts` + `src/lib/fetchAdmin.ts` handle the header.
- Tailwind 4 + the existing component primitives in `src/components/`. Reuse the table / badge / card patterns from `/admin/collateral` and `/admin/supply` rather than introducing new ones.
- Live-vs-demo gate: every new page is "Live" — don't tag as "Demo" placeholder.
- TanStack Query 5 hooks for backend reads (cache key = endpoint + params). 30-60s `staleTime` typical for admin dashboards.
- **No frontend RBAC.** Backend is the security boundary; pages can render freely (any auth header that the backend rejects = 401 toast).
- Tests: vitest + jsdom infrastructure exists but no tests yet — adding the first vitest spec for one of S3's hooks would seed the practice. Optional this PR.

**Out of scope for S3**:
- Contracts (done).
- Backend gateway (done).
- Customer-facing frontend (S4 — waits for design handoff).
- New backend endpoints — except optionally `GET /admin/audit/events` for S3.6, which can be a tiny gateway-side commit on the same PR.
- KMS / HSM / multisig signer rotation UI (out of Phase 1).

**Workflow** (per briefing):
1. After reading the docs above, send a recap message confirming you understand each S3 deliverable's binding decision.
2. Propose the implementation order. Recommended: S3.1 → S3.3 → S3.2 → S3.5 → S3.4 → S3.6 (smallest read-only first; S3.6 last because it may need a backend addition).
3. WAIT for user approval before writing code.
4. Per-deliverable: extend `src/lib/fypherx/client.ts` first, then page, then commit.

**Existing assets you can reuse**:
- `src/lib/admin/treasuryCatalog.ts` — single source of truth for contract addresses + `pausable` flag. Extend with the new Phase 1 contracts (FypherBurnQueue, FypherStakingHub, FyusdEpochSettlement, FyusdYieldVault) — admin grids need them in the catalog to render.
- `src/lib/admin/treasuryReads.ts` — example of a wagmi read helper.
- `src/components/admin/PauseModal.tsx` — keep for individual contract pause; S3.1 just adds a parallel grid VIEW.
- `/admin/collateral/page.tsx` — burn queue page to extend in S3.5.
- `/admin/supply/page.tsx` — pattern for grid + reserve coverage badges.
- `/app/admin/page.tsx` — the Command Center hub, where S3 navigation tiles should land.

**Things deliberately NOT being done in S3** (don't try to fix in scope):
- Customer frontend pages (waiting for Claude Design handoff).
- Real Bitgo Prime UI affordances beyond SLA tracking (waiting for ops integration).
- Concrete adapter swap UI (mainnet-only concern; out of scope until 1.2).

**Key on-chain context**:
- Active deploy: BSC Testnet (chainId 97). Per-chain addresses at `fypherx-contracts/sotatek-smart-contracts/addresses/97.json` (S1.9 restructure).
- The Phase 1 contracts (BurnQueue, StakingHub, EpochSettlement, YieldVault) are merged into the `develop` branch of the contracts repo but **not yet deployed to BSC Testnet** — operator deploy is pending. Until then S3 pages render with the same `UNKNOWN-when-unconfigured` semantics the backend already exposes.
- Admin app's `addresses.ts` is the parallel source-of-truth file that needs to grow Phase 1 entries once the contracts deploy.

Begin by reading the docs and confirming the plan.
