# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two trees — pick the right one

This directory holds **two parallel Hardhat projects**:

- **`contracts/`** — active FypherX contracts (perps clearinghouse, settlement, insurance fund, oracle router, mocks). **Default to working here.**
- **`sotatek-smart-contracts/`** — parallel / vendor tree with its own `contracts/`, `deployed-addresses.json`, `flows.md`, `contracts.md`, and `setup-contracts.js`. Treat as a separate project; don't mix paths with `contracts/`.

Each has its own `package.json`, `hardhat.config.js`, and `node_modules`. There is no root npm workspace.

## Commands (from `contracts/`)

```bash
npm install
npm run compile                  # hardhat compile
npm test                         # hardhat test (runs test/*.test.js)
npm run node                     # local hardhat node on :8545
npm run deploy:local             # scripts/deploy.js against localhost
npm run deploy:sepolia           # scripts/deploy.js against sepolia (needs TESTNET_RPC_URL + DEPLOYER_PRIVATE_KEY)

# Single test file:
npx hardhat test test/FypherPerpsClearinghouse.test.js
# Single test name:
npx hardhat test --grep "matches opposite orders"
```

Solidity **0.8.20**. Hardhat paths: `sources: ./src`, `artifacts: ./artifacts`, `cache: ./cache`. Deployment artifacts land in `./deployments/`.

## Contracts (in `contracts/src/`)

- `FypherPerpsClearinghouse.sol` — perps clearinghouse (core)
- `FypherXSettlement.sol` — on-chain settlement, called by the backend `fypherx-settlement-service` relayer in `rpc` mode
- `FypherXInsuranceFundVault.sol` — insurance fund vault, managed by backend `fypherx-risk-service`
- `FypherOracleRouter.sol` — price oracle router
- `MockERC20.sol`, `MockPriceOracle.sol` — test scaffolding (do not deploy to production networks)

Each contract has a matching `test/*.test.js`. `scripts/deploy.js` is the single entry point for both networks.

## Networks & environment

Configured in `hardhat.config.js`:

| Network | URL env var | Notes |
|---|---|---|
| `localhost` | `LOCAL_RPC_URL` (default `http://127.0.0.1:8545`) | Pairs with `npm run node` |
| `sepolia` | `TESTNET_RPC_URL` | Despite the name, production target is **BSC Testnet** — verify `TESTNET_RPC_URL` points where you expect before deploying |

Single deployer key via `DEPLOYER_PRIVATE_KEY` (loaded from `.env`). ⚠️ **Do not commit `.env`**, and confirm before any deploy that the key and RPC match the intended environment.

## Backend ↔ contract coupling

These contracts are invoked by backend services, not by the frontends directly. When changing ABIs or function signatures, grep for Web3j bindings in `fypherx-backend-services/` (especially `fypherx-gateway`, `fypherx-risk-service`, `fypherx-settlement-service`) and coordinate the update — there is no shared ABI package.
