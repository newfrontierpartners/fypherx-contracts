# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout (post audit-handoff restructure)

The repo is organized for an external security audit. There is **one canonical Hardhat project**:

- **`sotatek-smart-contracts/`** — alpha-launch contracts: stablecoins (RUSD/FYUSD/iRUSD), governance token (FYP), ERC-4626 cooldown vaults (sRUSD/stAUSD/siRUSD/sFYP), mint engine, burn queue, FYUSD epoch settlement, FYUSD yield vault, FYP emission staking hub, circuit breaker, settings registry. Deployed on BSC Testnet (chainId 97). **Default to working here.**

Out-of-scope code lives in `backup/`:

- `backup/lp/` — Pancake-V2-style LP vaults (deployed but dormant)
- `backup/lending/` — Morpho-Blue-style isolated lending markets (deployed but dormant)
- `backup/perps/` — Perpetual derivatives Hardhat subproject (formerly top-level `contracts/`; never deployed to production)
- `backup/scripts/` — Deployment + wiring scripts that target the above

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
- `Fypher/InstitutionalRUSD.sol` — institutional iRUSD (proxy)

### Mint / burn
- `Fypher/FypherMinting.sol` — EIP-712 quoted collateral → RUSD mint engine
- `Fypher/FypherBurnQueue.sol` — 7-day-delayed RUSD → collateral redemption

### Cooldown vaults (ERC-4626) + silos
- `Fypher/StakedRUSD.sol` (sRUSD) + `Fypher/RUSDSilo.sol`
- `Fypher/StakedAUSD.sol` (stAUSD) — uses both `RUSDSilo` (retail) and `SIRUSDSilo` (institutional)
- `Fypher/StakedIRUSD.sol` (siRUSD) + `Fypher/SIRUSDSilo.sol`
- `Fypher/StakedFYP.sol` (sFYP) + `Fypher/RUSDSilo.sol`

### FYP emission
- `Fypher/FypherStakingHub.sol` — multi-pool MasterChef-style FYP emission

### FYUSD yield system
- `Fypher/FyusdEpochSettlement.sol` — Get-FYUSD epoch state machine (OPEN/LOCKED/SETTLED/DISTRIBUTED/CANCELLED)
- `Fypher/FyusdYieldVault.sol` — Concrete-backed FYUSD yield wrapper
- `Fypher/IConcreteAdapter.sol` — adapter interface
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

Each user-facing contract has a matching `test/*.test.js`. `scripts/deploy-bsc-testnet.js` is the production entry point; `scripts/deploy-phase1.js` runs the wiring after deploy. Upgrades are scripted per-contract (`scripts/upgrade-{minting,fyusd}-impl.js`).

## Networks & environment

Configured in `sotatek-smart-contracts/hardhat.config.js`:

| Network | URL | Notes |
|---|---|---|
| `bscTestnet` | `https://data-seed-prebsc-1-s1.binance.org:8545` (chainId 97) | Production target for Phase 1 alpha |
| `hardhat` (in-memory) | n/a | Tests run here |

Required env (`.env` in `sotatek-smart-contracts/`):

```
PRIVATE_KEY=0x...                  # deployer EOA
BSCSCAN_API_KEY=...                # for source verification
```

⚠️ **Do not commit `.env`**, and confirm before any deploy that the key matches the intended environment.

## Backend ↔ contract coupling

These contracts are invoked by backend services, not by the frontends directly. When changing ABIs or function signatures, grep for Web3j bindings in `fypherx-backend-services/` (especially `fypherx-gateway` for mint signing + reads, `fypherx-risk-service` for staking + circuit-breaker, `fypherx-settlement-service` for epoch settle calls) and coordinate the update — there is no shared ABI package.

The backend reads addresses from `sotatek-smart-contracts/deployed-addresses.json` via `scripts/lib/addresses.js` (and the now-archived `backup/scripts/sync-addresses.js` historically re-wrote `application.yml` from this — for the alpha set, addresses are pinned in `k8s/fypherx-chain-config.yaml` instead).

## Audit scope marker

Whenever a contract change lands, ask whether the **`README.md`** §2 audit-scope inventory and **`backup/README.md`** are still accurate. They are the artifacts an external auditor sees first.
