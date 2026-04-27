# S1 — Smart contracts session kickoff prompt

> Copy-paste this prompt into the new Claude Code session to begin S1.

---

You are joining the Fypher Phase 1 implementation, smart-contracts session (S1).

**Read first, in order**:
1. `~/Downloads/CLAUDE_CODE_BRIEFING.md` — process rules. Critical: do NOT modify code without confirming the plan.
2. `~/Downloads/PHASE1_SPEC.md` — product spec.
3. `~/Documents/Fypher/docs/GAP_ANALYSIS.md` — current state per area + product.
4. `~/Documents/Fypher/docs/decisions/ADR-001` through `ADR-010` (in the order listed in `GAP_ANALYSIS.md` §8).

**Your scope (S1)**: smart contracts only. Backend (S2) and admin (S3) are separate sessions. Frontend (S4) waits for design handoff.

**Working tree**: `/Users/shchoi/Documents/Fypher/fypherx-contracts/sotatek-smart-contracts/`. Solidity 0.8.22, Hardhat, OpenZeppelin Upgradeable v5. Branch off `develop`: `feat/phase1-contracts`.

**Deliverables (each = own commit + tests)**:

| # | Contract / change | Spec / ADR ref |
|---|---|---|
| S1.1 | `FypherBurnQueue` — separate contract; 7-day on-chain UTC gate; DB-only ticket id (uint256 sequence) | ADR-001, ADR-002 |
| S1.2 | `FypherMinting` refactor — split `mintRedeemDisabled` into per-asset `mintPaused[asset]` + `burnPaused[asset]`; fix broken `mintWETH` to wrap real `msg.value`; add oracle-deviation pause hook | ADR-008, spec §3.1, §5 |
| S1.3 | `FyusdEpochSettlement` — 12h epoch deposit vault + epoch lifecycle (`OPEN→LOCKED→SETTLED→DISTRIBUTED`) + Bitgo settlement entry hook + per-epoch user accounting + `emergencyMint` retained on FYUSD | ADR-005, spec §3.2 |
| S1.4 | `FypherStakingHub` — single vault, sub-pools (`pools[0]=RUSD`, `pools[1]=FYUSD`), per-pool weight (1x / 2x), block-based FPY emission (`accFpyPerShare` accumulator); admin `migrate()` from old `StakedRUSD`/`stAUSD` | ADR-003, spec §3.3 |
| S1.5 | `FyusdYieldVault` + `IConcreteAdapter` interface + `MockConcreteAdapter` (BSC) + stub `ConcreteAdapterV1` (mainnet, signature-only — implementation deferred to mainnet readiness) | ADR-006, spec §3.4 |
| S1.6 | `FypherCircuitBreaker` — manual + auto trigger interface; integrates with per-asset pause from S1.2 | ADR-008, spec §6 |
| S1.7 | `MultisigAdmin` migration — `SettingManagement.transferAdmin(safeAddress)` script + per-network signer set captured in `docs/decisions/multisig-signers.md` (NOT committed with raw keys) | ADR-007 |
| S1.8 | Invariant tests (per briefing): `RUSD ≤ collateral`, `sRUSD == underlying`, `epoch leftover == 0`, `FPY emitted == FPY accrued`, `7d delay never bypassed` | briefing §"테스트 필수" |
| S1.9 | Deployment script restructure — `deploy-{bsc-testnet,sepolia,mainnet}.js` reading `addresses/{chainId}.json`; sync to backend + admin via existing `sync-addresses.js` helper | ADR-010 |

**Conventions to follow** (from existing tree):
- Contracts in `contracts/Fypher/` directory.
- ReentrancyGuardUpgradeable, Initializable, TransparentProxy via OZ.
- Events declared inline; errors via custom `error` keyword.
- One contract per file. Imports grouped (OZ → interfaces → local).
- Tests in `test/`, naming `<Contract>.test.js`.
- Use `setting-management` -> `multisig` migration as the FIRST step of every deploy script (ADR-007).

**Out of scope for S1**:
- Backend code (S2).
- Admin/frontend code (S3, S4).
- Real `ConcreteAdapterV1` implementation (deferred to mainnet readiness; sig-only stub OK).
- Real Bitgo client wiring (interface lives in S2 backend; on-chain entry hook is enough).
- KMS/HSM integration (separate P0 track).

**Workflow**:
1. After reading the docs above, send a recap message confirming you understand each ADR's binding decision.
2. Propose the implementation order (probably S1.7 multisig + S1.2 minting refactor first, since other contracts depend on the new admin gate and pause modifiers).
3. WAIT for user approval before writing code.
4. Per-deliverable: write tests first (where practical), then contract, run `npx hardhat test`, commit, move on.

**Existing assets you can reuse**:
- `RUSD.sol`, `FYUSD.sol`, `FYP.sol` — token contracts already deployed.
- `ReservePool.sol` — collateral vault.
- `*Silo.sol` — cooldown silos.
- `SettingManagement.sol` — admin gate (will be migrated to multisig in S1.7).

**Things deliberately NOT being done in S1** (don't try to fix in scope):
- Frontend customer flows (waiting for Claude Design handoff).
- The pre-existing perps clearinghouse drift between frontend/backend addresses (separate follow-up chip from prior session).
- Migration to EIP-712 typed data for mint signing (existing P0, separate track per CLAUDE.md).

**Key on-chain context**:
- Active deploy: BSC Testnet (chainId 97).
- Deployer EOA: `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4`. Private key in `sotatek-smart-contracts/.env` `PRIVATE_KEY`.
- `FypherMinting` proxy: `0x0Cc3De38A1ff577f23d14a4714530FCc11b24690`.
- `FYUSD`: `0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE`.
- `FYP`: `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C`.
- Backend `BACKEND_SIGNER_PRIVATE_KEY` and Bitgo/Concrete env vars not yet wired (S2 scope).

Begin by reading the docs and confirming the plan.
