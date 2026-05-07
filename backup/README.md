# Backup — Out-of-Scope Contracts

Everything in this folder is **deliberately excluded from the alpha-launch audit scope**. The code is preserved here (with full git history) for two reasons:

1. **On-chain reference.** Some of these contracts (LP, lending) are still deployed on BSC Testnet and may need future redeployment / migration; keeping the source close to the active tree avoids losing the implementations.
2. **Future re-introduction.** The roadmap calls for LP, lend/borrow, and perpetual derivatives in later phases. When those phases ship, the source moves back into the active tree (with whatever revisions the next audit cycle requires) — it does not get rewritten from scratch.

**No alpha contract imports anything from this folder.** The active build (`sotatek-smart-contracts/`) compiles cleanly without it. You can confirm by running `cd sotatek-smart-contracts && npx hardhat compile` from a clean `cache/`.

---

## Folder layout

```
backup/
├── irusd/     — Institutional fork (iRUSD / siRUSD / SIRUSDSilo)
├── lp/        — Pancake-V2-style liquidity vaults
├── lending/   — Morpho-Blue-style isolated lending markets
├── perps/     — Off-chain-matched perpetual derivatives Hardhat project
└── scripts/   — Deployment & wiring scripts that target the above
```

---

## `irusd/` — Institutional fork (excluded)

| File | Role |
|---|---|
| `InstitutionalRUSD.sol` | Institutional-only RUSD variant (iRUSD). Single-`_minter` slot; admin-set minter targets the institutional onboarding flow. |
| `StakedIRUSD.sol` | ERC-4626 cooldown vault for iRUSD (siRUSD share token). Same cooldown pattern as `StakedRUSD` but with the institutional silo. |
| `SIRUSDSilo.sol` | 3-param `withdraw(token, to, amount)` silo — escrow used during the iRUSD cooldown window. |

**Reason for exclusion.** The alpha launch ships retail-only flows (RUSD / FYUSD / FYP). The institutional fork has no frontend or backend integration — it is deployed on BSC Testnet (`iRUSD` `0x6Abddeb8…`, `StakedIRUSD` `0x058A9E41…`, `iRUSDSilo` `0xc16CeD6A…`, `SIRUSDSilo` `0xDa251B73…`) but no user-facing path reaches it today. Re-introduction will follow institutional onboarding and a separate audit cycle.

**No alpha contract imports the iRUSD trio.** Source-level mentions in `FYUSD.sol` and `SingleAdminAccessControl.sol` are NatSpec/comment context only. The legacy "two silos" arrangement on `StakedAUSD` (where `SIRUSDSilo` was a secondary institutional silo) has been retired; `StakedAUSD` now uses a single `RUSDSilo`-pattern silo.

The legacy "deploy everything" script `scripts/deploy.js` was moved to [`backup/scripts/deploy-legacy-full.js`](./scripts/deploy-legacy-full.js) because it instantiates the iRUSD trio. The active alpha deploy entry points are `sotatek-smart-contracts/scripts/deploy-bsc-testnet.js` and `scripts/deploy-phase1.js`.

## `lp/` — Liquidity layer (excluded)

| File | Role |
|---|---|
| `FypherLPVault.sol` | ERC-4626-shaped vault that wraps a Pancake-V2 LP-pair token and adds protocol-level position accounting |
| `FypherLiquidityManager.sol` | Owner-controlled router that deploys and registers `FypherLPVault` instances per RUSD/x pair |
| `mocks/MockPancakeV2.sol` | Pancake-V2 router/factory/pair mocks used by `tests/FypherLPVault.test.js` |
| `tests/FypherLPVault.test.js` | Hardhat test suite for the vault wrapper |

**Reason for exclusion.** The alpha launch ships RUSD / FYUSD / FYP issuance plus single-asset staking only. AMM-style LP exposure is deferred to the next phase; the deployed BSC Testnet instances (`FypherLPVault_RUSD_USDT`, `FypherLPVault_RUSD_USDC`, `FypherLPVault_RUSD_FYUSD`, `FypherLPVault_RUSD_FYP`) are dormant and not wired into any user-facing flow.

## `lending/` — Lending markets (excluded)

| Path | Role |
|---|---|
| `src/FypherLendingMarket.sol` | Per-pair isolated lending market (Morpho Blue lineage). Supply / borrow / repay / withdraw with shares-based accounting |
| `src/FypherLendingMarketFactory.sol` | Timelock-gated factory that creates market instances and wires them into the insurance fund whitelist |
| `src/KinkedIRM.sol` | Kinked-curve interest-rate model (utilization-based) consumed by markets |
| `src/OracleRouterV2.sol` | Oracle adapter registry — chooses between Chainlink and Constant-price adapters per (loan, collateral) pair |
| `src/InsuranceFundV2.sol` | Bad-debt absorber, callable only by whitelisted markets |
| `src/Imports.sol` | Compile-time anchor that pulls all FypherLending sources into the artifact tree |
| `src/oracles/{Chainlink,Constant}OracleAdapter.sol` | Two oracle adapter implementations |
| `src/libraries/*.sol` | Math / shares / events / errors / utils helpers |
| `src/interfaces/*.sol` | External interface declarations |

**Reason for exclusion.** Lending is post-alpha. Per the smart-contracts duplicate-cleanup memo (2026-04-22), the on-chain instances on BSC Testnet (Timelock `0x1Bd5E8…`, Oracle `0x9fd95852…`, InsuranceFund `0x94fDa66b…`, IRM `0xFc05AD…`, Factory `0xBDC04…`, Market_RUSD_USDT `0x14Aceb…`) exist but are not exercised by the alpha frontend or backend. A queued market-creation timelock batch on testnet is **unexecutable** because the executable payload was lost in a prior cleanup; any re-introduction of lending will redeploy fresh.

## `perps/` — Perpetual derivatives (excluded)

This is a complete second Hardhat project — its own `package.json`, `hardhat.config.js`, `node_modules`-target, sources, scripts, tests. The original location was the top-level `contracts/` directory of `fypherx-contracts`; it has been renamed under `backup/perps/` so the audit can focus on the canonical alpha tree.

| File | Role |
|---|---|
| `src/FypherPerpsClearinghouse.sol` | Position management, leverage, margin, liquidations |
| `src/FypherXSettlement.sol` | Settlement of off-chain matched trades (replay-safe) |
| `src/FypherXInsuranceFundVault.sol` | Insurance fund managed by `fypherx-risk-service` backend |
| `src/FypherOracleRouter.sol` | Chainlink-compatible mark-price oracle router with staleness checks |
| `test/*` | Four test suites (one per contract) |
| `test/mocks/{MockERC20,MockPriceOracle}.sol` | Test fixtures for the perps suite |
| `scripts/{deploy.js, demo.ts, keeper.ts, ws-{multi,}smoke.ts}` | Deployment & operational scripts |

**Reason for exclusion.** Perpetual derivatives are deferred well past the alpha launch. The contracts have only ever been deployed to local Hardhat / Sepolia in CI smoke tests; **no production deployment exists on BSC Testnet or mainnet**, and the customer-facing perps surfaces in `fypherx-frontend` (`/app/perps`) are placeholder pages.

## `scripts/` — Deployment & wiring scripts (excluded)

| File | Role |
|---|---|
| `deploy-lp-lending.js`         | Single-shot deploy of LP vaults + lending market for `RUSD/USDT`, with timelock queue for the market-creation step |
| `deploy-lp-lending-resume.js`  | Continuation script for the post-timelock half of the above (queued batch finalization) |
| `lending-smoke.js`             | End-to-end smoke test against deployed LP+lending stack |
| `sync-addresses.js`            | Rewrites backend `application.yml` and frontend env bindings from `deployed-addresses.json` — most of the rewritten keys reference LP/lending |
| `verify-wiring.js`             | Walks the deployed lending+LP graph and asserts each contract's `oracle / irm / timelock / insuranceFund / factory / owner` references match expectations |
| `probe-{pair-reserves,pairs,pancake}.js` | One-off PancakeV2 introspection helpers |

These scripts are kept here so the addresses they wire stay traceable, but they should not be run during the audit.

---

## Compiling the backup tree (optional)

The lending/LP code under `backup/lp/` and `backup/lending/src/` is **not** picked up by the alpha Hardhat config — `sotatek-smart-contracts/hardhat.config.js` uses the default `./contracts` path, which now contains only the in-scope tree. If an auditor wants to inspect compiled artifacts for the excluded code, they can either (a) do it as a read-only review against the prior on-chain instances on BSC Testnet, or (b) temporarily move the files back under `sotatek-smart-contracts/contracts/` to compile.

The `backup/perps/` subproject has its own `hardhat.config.js` and is fully self-contained — running `cd backup/perps && npm install && npx hardhat compile` will build it independently.
