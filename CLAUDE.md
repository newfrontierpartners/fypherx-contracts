# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout (post audit-handoff restructure)

The repo is organized for an external security audit. There is **one canonical Hardhat project**:

- **`sotatek-smart-contracts/`** — alpha-launch contracts: stablecoins (RUSD/FYUSD), governance token (FYP), ERC-4626 cooldown vaults (sRUSD/stAUSD/sFYP — note: stAUSD's underlying is FYUSD), ERC-4626 yield receipt vaults (vFYUSD/vRUSD, Concrete-backed), mint engine, burn queue, FYUSD epoch settlement, FYP emission staking hub, circuit breaker, settings registry. Deployed on Ethereum Sepolia (chainId 11155111) as of 2026-04-30 (migrated from BSC Testnet chainId 97). Address registry: `addresses/11155111.json`. **Default to working here.**

Out-of-scope code lives in `backup/`:

- `backup/irusd/` — Institutional fork: `InstitutionalRUSD` (iRUSD), `StakedIRUSD` (siRUSD), `SIRUSDSilo`. Deployed on BSC Testnet but unused by alpha frontend/backend.
- `backup/lp/` — Pancake-V2-style LP vaults (deployed but dormant)
- `backup/lending/` — Morpho-Blue-style isolated lending markets (deployed but dormant)
- `backup/perps/` — Perpetual derivatives Hardhat subproject (formerly top-level `contracts/`; never deployed to production)
- `backup/scripts/` — Deployment + wiring scripts that target the above (incl. legacy `deploy-legacy-full.js` that deploys the iRUSD trio)

See [`backup/README.md`](./backup/README.md) for why each subdir is excluded. **No alpha contract imports from `backup/`** — `cd sotatek-smart-contracts && npx hardhat clean && npx hardhat compile` succeeds without it.

If you are asked to work on lending / LP / perps code, expect to (a) move sources back from `backup/` into the active tree first, (b) update the audit-scope docs in `README.md` and `backup/README.md`, (c) re-run compile + tests against the merged tree.

## Commands (from `sotatek-smart-contracts/`)

```bash
npm install
npx hardhat compile                   # compile (Solidity 0.8.22, optimizer runs=1)
npx hardhat clean && npx hardhat compile   # full rebuild
npx hardhat test                      # 7 suites, ~84 tests
npx hardhat test test/FypherMinting.test.js
npx hardhat test --grep "rate limit"
```

Solidity **0.8.22**. Hardhat default paths (`sources: ./contracts`, `artifacts: ./artifacts`, `cache: ./cache`).

## Contracts (in `sotatek-smart-contracts/contracts/`)

### Tokens
- `Fypher/RUSD.sol` — primary stablecoin (proxy)
- `Fypher/FYUSD.sol` — yield-bearing stablecoin (proxy)
- `Fypher/FYP.sol` — governance token (proxy)

### Mint / burn
- `Fypher/FypherMinting.sol` — EIP-712 quoted collateral → RUSD mint engine
- `Fypher/FypherBurnQueue.sol` — 7-day-delayed RUSD → collateral redemption

### Cooldown vaults (ERC-4626) + silos
- `Fypher/StakedRUSD.sol` (sRUSD) + `Fypher/RUSDSilo.sol`
- `Fypher/StakedAUSD.sol` (stAUSD; underlying = **FYUSD**, legacy name) + `Fypher/RUSDSilo.sol`
- `Fypher/StakedFYP.sol` (sFYP) + `Fypher/RUSDSilo.sol`

### FYP emission
- `Fypher/FypherStakingHub.sol` — multi-pool MasterChef-style FYP emission

### Yield-vault system (Concrete-backed)
- `Fypher/FyusdEpochSettlement.sol` — Get-FYUSD epoch state machine (OPEN/LOCKED/SETTLED/DISTRIBUTED/CANCELLED)
- `Fypher/FyusdYieldVault.sol` (vFYUSD) — ERC4626 receipt vault, 7-day cooldown via `vFyusdCooldown` pool config
- `Fypher/RUSDYieldVault.sol` (vRUSD) — ERC4626 receipt vault for RUSD, 14-day cooldown via `vRusdCooldown` pool config
- `Fypher/IConcreteAdapter.sol` — asset-agnostic adapter interface (one instance per (vault, asset) binding)
- `Fypher/ConcreteAdapterV1.sol` — mainnet binding stub (reverts NotImplemented today)

### Safety / config
- `Fypher/SettingManagement.sol` — central registry (admin, fees, signer, custodians, blacklist)
- `Fypher/SingleAdminAccessControl.sol` — two-step admin transfer base
- `Fypher/ReservePool.sol` — emergency liquidity reserve
- `Fypher/FypherCircuitBreaker.sol` — pre-registered Trigger executor; pauserRole on all Phase 1 contracts

### Interfaces / libraries / mocks
- `interfaces/{ISettingManagement, IStakedRUSD, IStakedRUSDCooldown}.sol`
- `libraries/PoolMath.sol` — shared math for cooldown vaults
- `mocks/MockERC20.sol`, `mocks/MockConcreteAdapter.sol` — test fixtures

Each user-facing contract has a matching `test/*.test.js`. `scripts/deploy-sepolia.js` is the current production entry point (was `deploy-bsc-testnet.js` pre-2026-04-30); `scripts/deploy-phase1.js` runs the wiring after deploy. Upgrades are scripted per-contract (`scripts/upgrade-{minting,fyusd}-impl.js`).

## Networks & environment

Configured in `sotatek-smart-contracts/hardhat.config.js`:

| Network | URL | Notes |
|---|---|---|
| `sepolia` | `https://ethereum-sepolia-rpc.publicnode.com` (chainId 11155111) | Production target for Phase 1 alpha (migrated 2026-04-30) |
| `bscTestnet` | `https://data-seed-prebsc-1-s1.binance.org:8545` (chainId 97) | Legacy — pre-2026-04-30 deployment, no longer the active target |
| `hardhat` (in-memory) | n/a | Tests run here |

Required env (`.env` in `sotatek-smart-contracts/`):

```
PRIVATE_KEY=0x...                  # deployer EOA
ETHERSCAN_API_KEY=...              # for source verification (single key covers Etherscan + BscScan)
```

⚠️ **Do not commit `.env`**, and confirm before any deploy that the key matches the intended environment.

## Backend ↔ contract coupling

These contracts are invoked by backend services, not by the frontends directly. When changing ABIs or function signatures, grep for Web3j bindings in `fypherx-backend-services/` (especially `fypherx-gateway` for mint signing + reads, `fypherx-risk-service` for staking + circuit-breaker, `fypherx-settlement-service` for epoch settle calls) and coordinate the update — there is no shared ABI package.

The backend reads addresses from `sotatek-smart-contracts/deployed-addresses.json` via `scripts/lib/addresses.js` (and the now-archived `backup/scripts/sync-addresses.js` historically re-wrote `application.yml` from this — for the alpha set, addresses are pinned in `k8s/fypherx-chain-config.yaml` instead).

## Audit scope marker

Whenever a contract change lands, ask whether the **`README.md`** §2 audit-scope inventory and **`backup/README.md`** are still accurate. They are the artifacts an external auditor sees first.
