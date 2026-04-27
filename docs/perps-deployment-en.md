# FypherX Perps — BSC Testnet Deployment Reference

Companion to [`admin-model.md`](./admin-model.md). Scope: the four **perpetual-derivatives** contracts deployed under `contracts/src/` on BNB Smart Chain Testnet (chainId **97**), plus their mock oracle fixtures. For the core stablecoin + staking stack (`sotatek-smart-contracts/`), see that subproject's `contracts.md`.

This file is the hand-off surface between contracts and the backend / frontend / ops teams. If you are wiring a service, read this before calling anything.

> 🇻🇳 Vietnamese: [`perps-deployment-vi.md`](./perps-deployment-vi.md)

---

## 1. Deployed addresses

| Contract | Address | Explorer |
|---|---|---|
| `FypherOracleRouter` | `0x8ECB432CC3B946e1Fb3baDA3907fE9d344F6bC2C` | [BSCScan](https://testnet.bscscan.com/address/0x8ECB432CC3B946e1Fb3baDA3907fE9d344F6bC2C#code) |
| `FypherXSettlement` | `0x86DF90F043f32bf1959620AB987dCfD70F840464` | [BSCScan](https://testnet.bscscan.com/address/0x86DF90F043f32bf1959620AB987dCfD70F840464#code) |
| `FypherXInsuranceFundVault` | `0x3800CC3D90463758704D900274D467C93c71440E` | [BSCScan](https://testnet.bscscan.com/address/0x3800CC3D90463758704D900274D467C93c71440E#code) |
| `FypherPerpsClearinghouse` | `0xd362A48d30E2ED6CBe866D5Ad11E79b88212336A` | [BSCScan](https://testnet.bscscan.com/address/0xd362A48d30E2ED6CBe866D5Ad11E79b88212336A#code) |
| `MockPriceOracle` (BTC-PERP) | `0x019e19639A119330eEFbC5668cD4616dDA007469` | [BSCScan](https://testnet.bscscan.com/address/0x019e19639A119330eEFbC5668cD4616dDA007469#code) |
| `MockPriceOracle` (ETH-PERP) | `0x1F86FeD85ef415a0bEFeEc6d0F263f74DE4E3965` | [BSCScan](https://testnet.bscscan.com/address/0x1F86FeD85ef415a0bEFeEc6d0F263f74DE4E3965#code) |

**Collateral token** (inherited from the staking stack): `RUSD` at `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5`.

**Deployer / initial owner of every perps contract**: `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4`. This single EOA also holds the initial `relayer`, `liquidator`, `operator`, and `tradeSigner` roles — fine for testnet demo, must be split and moved to HSM/multisig before mainnet.

**Markets configured on the clearinghouse**:

| Market ID (bytes32) | Init margin | Maint margin | Max deviation | Max leverage | Max size |
|---|---|---|---|---|---|
| `BTC-PERP` | 5.00% | 3.00% | 20.00% | 20× | 5 BTC |
| `ETH-PERP` | 5.00% | 3.00% | 20.00% | 20× | 5 ETH |

---

## 2. Contract-by-contract reference

### 2.1 FypherOracleRouter — mark-price aggregator

Chainlink-compatible feed router with staleness guard and a global pause flag. Every mark-price read in the perps stack goes through here.

**Admin**

| Function | Caller | Purpose |
|---|---|---|
| `setOwner(address)` | owner | Transfer ownership (single step). |
| `setPaused(bool)` | owner | Global pause / unpause. `getPriceE18` reverts while paused. |
| `configureMarketOracle(bytes32 marketId, address feed, uint8 decimals, uint64 maxStalenessSeconds, bool active)` | owner | Register or update a market's feed. |

**Read**

| Function | Returns |
|---|---|
| `getPriceE18(bytes32 marketId)` | Mark price normalized to 1e18. Reverts on: paused, unconfigured market, stale answer (>`maxStalenessSeconds`), zero/negative answer. |
| `paused()` | Global pause flag. |
| `owner()` | Current owner. |

**Events**: `OwnerUpdated`, `MarketOracleConfigured`, `PausedSet`.

### 2.2 FypherXSettlement — EIP-712 signed trade journal

Write-once event journal for off-chain matched trades. A relayer transmits; a *separate* `tradeSigner` key signs the EIP-712 payload (April-audit H-5).

**Admin**

| Function | Caller | Purpose |
|---|---|---|
| `setOwner(address)` | owner | Transfer ownership. |
| `setRelayer(address, bool)` | owner | Add/revoke a relayer key. |
| `setTradeSigner(address)` | owner | Rotate the trade-signer key. |

**Write**

| Function | Caller | Purpose |
|---|---|---|
| `settleTrade(Trade trade, bytes signature)` | relayer | Emit `TradeSettled` for a trade whose EIP-712 digest was signed by `tradeSigner`. Reverts on replay (`tradeId` already settled), bad signature, or unset signer. |

**Read**

| Function | Returns |
|---|---|
| `digest(Trade)` | EIP-712 digest the `tradeSigner` must sign. |
| `domainSeparator()` | EIP-712 domain separator for `{name: "FypherXSettlement", version: "1", chainId, verifyingContract}`. |
| `settledTrades(bytes32 tradeId)` | `true` once settled. |
| `tradeSigner()` | Current signer address. |
| `relayers(address)` | Per-address relayer flag. |

**Events**: `TradeSettled`, `OwnerUpdated`, `RelayerUpdated`, `TradeSignerUpdated`.

### 2.3 FypherXInsuranceFundVault — ERC-20 bad-debt buffer

Holds collateral the clearinghouse can pull from to cover liquidation deficits. ERC-20 backed (April-audit M-9); the previous ETH-receive path has been removed.

**Admin**

| Function | Caller | Purpose |
|---|---|---|
| `setOwner(address)` | owner | Transfer ownership. |
| `setOperator(address, bool)` | owner | Add/revoke an address that can call `withdraw`. The clearinghouse must be in this set. |

**Write**

| Function | Caller | Purpose |
|---|---|---|
| `deposit(uint256 amount, bytes32 referenceId)` | anyone | Pull `amount` of the vault token via `transferFrom` and emit `FundDeposited`. |
| `withdraw(address to, uint256 amount, bytes32 referenceId)` | operator | Transfer `amount` to `to`. Reverts on zero amount, zero recipient, or insufficient balance. |

**Read**: `balance()`, `operators(address)`, `token()`, `owner()`.

**Events**: `FundDeposited`, `FundWithdrawn`, `OperatorUpdated`, `OwnerUpdated`.

### 2.4 FypherPerpsClearinghouse — position ledger

The centerpiece: collateral vault, position ledger, leverage/margin math, liquidations. All trades enter through `executeMatchedTrade` (relayer-gated); the mark price for every check is pulled from `FypherOracleRouter`.

**Admin**

| Function | Caller | Purpose |
|---|---|---|
| `setOwner(address)` | owner | Transfer ownership. |
| `setRelayer(address, bool)` | owner | Add/revoke relayer (can call `executeMatchedTrade`). |
| `setLiquidator(address, bool)` | owner | Add/revoke liquidator (relayers also count as liquidators). |
| `setInsuranceFund(address)` | owner | Point at the `FypherXInsuranceFundVault`. Required for `liquidate` to cover deficits. |
| `configureMarket(marketId, imBps, mmBps, maxDevBps, maxLevE18, maxSizeE18, active)` | owner | Create or update a market. |

**Trader**

| Function | Purpose |
|---|---|
| `deposit(uint256 amountE18)` | Pull collateral via `transferFrom`. Caller must `approve` first. |
| `withdraw(uint256 amountE18)` | Return collateral. Reverts if post-withdraw equity < initial margin used. |

**Relayer**

| Function | Purpose |
|---|---|
| `executeMatchedTrade(account, marketId, isLong, sizeDeltaE18, executionPriceE18, requestedLeverageE18)` | Apply a matched trade on `account`'s ledger. Auto-dispatches to open / add / reduce / close / flip based on current position state. |

**Liquidator**

| Function | Purpose |
|---|---|
| `liquidate(account, marketId)` | Reverts unless `isLiquidatable(account)`. Closes the position, applies realised PnL; if deficit, pulls from insurance fund (April-audit H-4); reverts if fund unset or underfunded. |

**Read**

| Function | Returns |
|---|---|
| `positions(account, marketId)` | `Position{ isLong, sizeE18, entryPriceE18, marginE18, leverageE18 }`. |
| `collateralBalanceE18(account)` | Signed balance; can dip negative before a liquidation is processed. |
| `equity(account)` | `collateral + unrealizedPnl`. |
| `isLiquidatable(account)` | `equity < maintenanceMargin`. |
| `getAccountSnapshot(account)` | Bundled: collateral, uPnL, equity, IM used, MM required, liquidatable. |
| `getConfiguredMarkets()` | All configured market IDs. |
| `getAccountMarkets(account)` | Markets the account has ever held. |
| `totalInitialMarginUsed`, `totalMaintenanceMarginRequired`, `totalUnrealizedPnl` | Per-account aggregates. |

**Events**: `TradeApplied`, `CollateralDeposited`, `CollateralWithdrawn`, `PositionLiquidated`, `InsuranceFundDrawn`, `MarketConfigured`, `InsuranceFundUpdated`, `RelayerUpdated`, `LiquidatorUpdated`, `OwnerUpdated`.

---

## 3. End-to-end flows

### 3.1 Trader opens a position

```
Trader                  Backend (matching)            Chain
  │                          │                          │
  │  1. approve RUSD ───────────────────────────────────▶ RUSD.approve(clearinghouse, ∞)
  │  2. deposit ─────────────────────────────────────────▶ Clearinghouse.deposit(amount)
  │                                                       └─ emits CollateralDeposited
  │  3. submit limit order ─▶ off-chain book
  │                          │  match opponent
  │                          │  4. settleTrade (journal) ▶ Settlement.settleTrade(trade, sig)
  │                          │                            └─ emits TradeSettled
  │                          │  5. executeMatchedTrade ──▶ Clearinghouse.executeMatchedTrade(...)
  │                          │                            ├─ oracle.getPriceE18()
  │                          │                            ├─ deviation check
  │                          │                            ├─ open/add/reduce/close/flip
  │                          │                            └─ emits TradeApplied
```

**Note**: `settleTrade` and `executeMatchedTrade` are independent on-chain writes. The settlement journal is the tamper-resistant record; the clearinghouse is the live ledger. Both must succeed for a trade to be final. Backend is responsible for ordering (settle first, execute second) so a failed execute doesn't leave a settled trade without a position.

### 3.2 Liquidation with insurance-fund backstop

```
Liquidator bot           Chain
  │                        │
  │  poll accounts ───────▶ Clearinghouse.isLiquidatable(account)
  │  if true ─────────────▶ Clearinghouse.liquidate(account, marketId)
  │                        │  ├─ closes position at current mark
  │                        │  ├─ applies realised PnL to collateralBalanceE18
  │                        │  ├─ if collateralBalanceE18 < 0:
  │                        │  │    ├─ insuranceFund.withdraw(clearinghouse, deficit)
  │                        │  │    ├─ emits InsuranceFundDrawn
  │                        │  │    └─ zeroes the account ledger (no negative-equity loophole)
  │                        │  └─ emits PositionLiquidated
```

**Backstop contract**: `liquidate` reverts — not silently succeeds — if (a) no insurance fund set, or (b) fund balance < deficit. The operator must choose: top up the fund, or route to an off-chain backstop. Silent bad debt is not possible.

### 3.3 Operator tops up the insurance fund

```
Operator            Chain
  │                   │
  │  approve ────────▶ RUSD.approve(vault, amount)
  │  deposit ────────▶ InsuranceFundVault.deposit(amount, reference)
  │                   └─ emits FundDeposited(operator, amount, reference)
```

Anyone can deposit (the fund is additive by design) — only `operators` can withdraw.

### 3.4 Trade settlement signature

Off-chain, the `tradeSigner` signs an EIP-712 payload with domain `{name: "FypherXSettlement", version: "1", chainId: 97, verifyingContract: settlementAddress}` and struct:

```solidity
struct Settle {
  bytes32 tradeId;
  bytes32 marketId;
  bytes32 makerSubaccountId;
  bytes32 takerSubaccountId;
  uint256 priceE18;
  uint256 quantityE18;
  uint256 makerFeeE18;
  uint256 takerFeeE18;
  bytes32 payloadHash;  // keccak256(trade.payload)
}
```

Relayer transmits `(trade, signature)` via `settleTrade`. Replay protection: `settledTrades[tradeId]` is set on first success.

### 3.5 Market configuration (admin)

```
Owner ──▶ Clearinghouse.configureMarket(marketId, imBps, mmBps, maxDevBps, maxLevE18, maxSizeE18, active)
           │  validates: imBps > 0 ≤ 10000, mmBps ≤ imBps, maxLevE18 ≥ 1e18, maxSizeE18 > 0
           └─ emits MarketConfigured
Owner ──▶ OracleRouter.configureMarketOracle(marketId, feed, decimals, maxStaleness, active)
           └─ emits MarketOracleConfigured
```

---

## 4. Backend / frontend wiring

Copy the addresses above into the backend env:

```bash
# fypherx-backend-services
FYPHERX_PERPS_CLEARINGHOUSE_ADDRESS=0xd362A48d30E2ED6CBe866D5Ad11E79b88212336A
FYPHERX_PERPS_SETTLEMENT_ADDRESS=0x86DF90F043f32bf1959620AB987dCfD70F840464
FYPHERX_PERPS_INSURANCE_FUND_ADDRESS=0x3800CC3D90463758704D900274D467C93c71440E
FYPHERX_PERPS_ORACLE_ROUTER_ADDRESS=0x8ECB432CC3B946e1Fb3baDA3907fE9d344F6bC2C
FYPHERX_PERPS_COLLATERAL_TOKEN=0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5
BSC_TESTNET_RPC=https://data-seed-prebsc-1-s1.binance.org:8545
FYPHERX_SETTLEMENT_RELAYER_MODE=rpc
```

For the mint signer flow (staking stack), see the existing `docs/DEX_PERPS_PROVISIONING.md` in the backend repo.

**Frontend (viem)**: the four perps addresses go into `NEXT_PUBLIC_PERPS_*` env vars. Adapter mode: `NEXT_PUBLIC_DEFI_ADAPTER_MODE=live-contract` for on-chain writes; `contract-ready` for chain reads + mock writes.

---

## 5. Known gaps (not yet addressed on testnet)

1. **Single-key operator** — deployer holds `owner` + `relayer` + `liquidator` + `operator` + `tradeSigner` on every contract. For mainnet, split into:
   - `owner` → 3-of-5 multisig
   - `relayer` → hot wallet in backend (rate-limited)
   - `liquidator` → hot wallet(s) in bot
   - `operator` → multisig (slow path) + optional bot (fast path)
   - `tradeSigner` → HSM-backed, rotated independently
2. **Mock oracles** — BTC/ETH feeds are `MockPriceOracle` instances the deployer can set to any value. Before mainnet, swap in Chainlink feeds via `OracleRouter.configureMarketOracle` and remove the mocks.
3. **Insurance fund is unfunded** — `vault.balance() == 0` on the deployed address. Any deficit liquidation currently reverts with `insurance underfunded`. Seed the vault via `deposit` before enabling real trading.
4. **No rate limits / circuit breakers** — market-level pause exists, but no per-trader cap or book-wide daily volume cap. Acceptable for demo; not for mainnet.

---

## 6. Test coverage

67 Hardhat tests cover admin access control, deployment validation, deposit/withdraw, open/add/reduce/close/flip, liquidation with and without insurance fund, EIP-712 signature flow, oracle staleness/pause, and view helpers. Run:

```bash
cd fypherx-contracts/contracts
npm test
```

---

## 7. Redeploy

```bash
cd fypherx-contracts/contracts
# .env required: DEPLOYER_PRIVATE_KEY, BSCSCAN_API_KEY,
#                BSC_TESTNET_RPC (optional), DEPLOY_MOCK_ORACLES=true,
#                AUTO_CONFIGURE_MARKETS=true
npm run deploy:bscTestnet

# then verify each address (see hardhat.config.js for bscTestnet entry):
npx hardhat verify --network bscTestnet <oracleRouter>
npx hardhat verify --network bscTestnet <settlement> <relayer> <signer>
npx hardhat verify --network bscTestnet <insuranceFund> <collateralToken> <operator>
npx hardhat verify --network bscTestnet <clearinghouse> <collateralToken> <oracleRouter>
```

Addresses and ABIs land in `contracts/deployments/bscTestnet.json` and `contracts/artifacts/src/*.sol/*.json`.
