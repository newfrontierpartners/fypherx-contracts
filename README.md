# fypherx-contracts

Solidity smart contracts for **FypherX**. Bundles two complementary subprojects:

- `sotatek-smart-contracts/` — **Fypher core protocol** (stablecoins RUSD/FYUSD/iRUSD, governance token FYP, ERC-4626 staking vaults, minting/redemption engine). Built and deployed on BSC Testnet.
- `contracts/` — **FypherX perpetual derivatives layer** (clearinghouse, settlement, insurance vault, oracle router). Targets local Hardhat and Sepolia.

## Subproject 1 — `sotatek-smart-contracts/`

Core stablecoin + staking system. **Already deployed on BSC Testnet** (chainId 97).

| Stack | |
|---|---|
| Solidity | 0.8.22 (optimizer: 1 run) |
| Framework | Hardhat 2.28 |
| Libraries | OpenZeppelin Contracts 5.0.2 + Upgradeable + hardhat-upgrades |
| Pattern | TransparentUpgradeableProxy for all major contracts |

### Key contracts

| Contract | Purpose |
|---|---|
| `RUSD`, `FYUSD`, `FYP`, `InstitutionalRUSD` | Tokens (ERC20Upgradeable + Permit) |
| `StakedRUSD`, `StakedAUSD`, `StakedFYP`, `StakedIRUSD` | ERC4626 vaults with 7-day cooldown |
| `RUSDSilo`, `SIRUSDSilo` | Cooldown escrow contracts |
| `FypherMinting` | Collateral → RUSD swap with ECDSA-signed off-chain orders |
| `ReservePool` | Emergency liquidity reserve (target 3%) |
| `SettingManagement` | Central role/fee/config registry |
| `SingleAdminAccessControl` | Two-step admin transfer base |

### Deployed addresses (BSC Testnet)

See [`sotatek-smart-contracts/contracts.md`](sotatek-smart-contracts/contracts.md) and `sotatek-smart-contracts/deployed-addresses.json`.

| Contract | Address |
|---|---|
| FypherMinting | `0x0Cc3De38A1ff577f23d14a4714530FCc11b24690` |
| RUSD | `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5` |
| FYUSD | `0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE` |
| FYP | `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C` |
| iRUSD | `0x6Abddeb89854bc477D680c431C18979227c64480` |

### Commands

```bash
cd sotatek-smart-contracts
npm install
npm run compile
npm run deploy:testnet      # BSC Testnet
node setup-contracts.js     # Configure roles, signer, custodian after deploy
```

Required env (`.env`): `PRIVATE_KEY`, `BSCSCAN_API_KEY`.

---

## Subproject 2 — `contracts/`

Perpetual derivatives layer. Hardhat-based, targets localhost and Sepolia.

| Stack | |
|---|---|
| Solidity | 0.8.20 |
| Framework | Hardhat 2.24, ethers v3.1.0 |

### Key contracts

| Contract | Purpose |
|---|---|
| `FypherPerpsClearinghouse` | Position management, leverage, collateral, liquidations |
| `FypherXSettlement` | Off-chain matched trades → on-chain settlement (replay-safe) |
| `FypherXInsuranceFundVault` | Insurance fund deposits/withdrawals |
| `FypherOracleRouter` | Chainlink-compatible price feed aggregator with staleness checks |
| `MockPriceOracle`, `MockERC20` | Test fixtures |

### Commands

```bash
cd contracts
npm install
npm run compile
npm test
npm run deploy:local        # localhost
npm run deploy:sepolia      # Sepolia testnet
```

Required env: `INITIAL_RELAYER`, `INITIAL_OPERATOR`, `DEPLOY_MOCK_ORACLES`.

### Tests

4 test suites under `contracts/test/` covering clearinghouse position mgmt, settlement idempotency, insurance vault, and oracle router.

---

## Note on the sibling repo

There is a separate `smart-contracts` repo containing a duplicate copy of the `sotatek-smart-contracts/` source from an earlier extraction. **This repo (`fypherx-contracts/sotatek-smart-contracts/`) is the source of truth** — `deployed-addresses.json`, `contracts.md`, deployment scripts, and OpenZeppelin proxy registry all live here.

## Related repos

- **fypherx-backend-services** — calls these contracts via Web3j (settlement, mint signer, vault reads)
- **fypherx-frontend** — calls these contracts via viem (mint, stake, burn flows)
