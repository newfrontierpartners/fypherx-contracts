# FypherX Perps — Tài liệu deploy BSC Testnet

Đi kèm với [`admin-model.md`](./admin-model.md). Phạm vi: bốn contract **perpetual-derivatives** trong `contracts/src/` đã deploy lên BNB Smart Chain Testnet (chainId **97**), cộng với các mock oracle đi kèm. Về core stablecoin + staking (`sotatek-smart-contracts/`), xem `contracts.md` trong subproject đó.

Tài liệu này là điểm bàn giao giữa contracts và các team backend / frontend / ops. Nếu bạn đang wire một service, đọc file này TRƯỚC khi gọi bất kỳ function nào.

> 🇬🇧 English: [`perps-deployment-en.md`](./perps-deployment-en.md)

---

## 1. Địa chỉ đã deploy

| Contract | Address | Explorer |
|---|---|---|
| `FypherOracleRouter` | `0x8ECB432CC3B946e1Fb3baDA3907fE9d344F6bC2C` | [BSCScan](https://testnet.bscscan.com/address/0x8ECB432CC3B946e1Fb3baDA3907fE9d344F6bC2C#code) |
| `FypherXSettlement` | `0x86DF90F043f32bf1959620AB987dCfD70F840464` | [BSCScan](https://testnet.bscscan.com/address/0x86DF90F043f32bf1959620AB987dCfD70F840464#code) |
| `FypherXInsuranceFundVault` | `0x3800CC3D90463758704D900274D467C93c71440E` | [BSCScan](https://testnet.bscscan.com/address/0x3800CC3D90463758704D900274D467C93c71440E#code) |
| `FypherPerpsClearinghouse` | `0xd362A48d30E2ED6CBe866D5Ad11E79b88212336A` | [BSCScan](https://testnet.bscscan.com/address/0xd362A48d30E2ED6CBe866D5Ad11E79b88212336A#code) |
| `MockPriceOracle` (BTC-PERP) | `0x019e19639A119330eEFbC5668cD4616dDA007469` | [BSCScan](https://testnet.bscscan.com/address/0x019e19639A119330eEFbC5668cD4616dDA007469#code) |
| `MockPriceOracle` (ETH-PERP) | `0x1F86FeD85ef415a0bEFeEc6d0F263f74DE4E3965` | [BSCScan](https://testnet.bscscan.com/address/0x1F86FeD85ef415a0bEFeEc6d0F263f74DE4E3965#code) |

**Collateral token** (thừa kế từ staking stack): `RUSD` tại `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5`.

**Deployer / owner ban đầu của mọi perps contract**: `0x31B60b11533c97b5ED7b1B650D31855F3754Acb4`. EOA này đồng thời giữ các role `relayer`, `liquidator`, `operator`, `tradeSigner` — OK cho testnet/demo, nhưng **bắt buộc** phải tách và chuyển sang HSM/multisig trước khi lên mainnet.

**Các market đã cấu hình trên clearinghouse**:

| Market ID (bytes32) | Initial margin | Maintenance margin | Max deviation | Max leverage | Max size |
|---|---|---|---|---|---|
| `BTC-PERP` | 5.00% | 3.00% | 20.00% | 20× | 5 BTC |
| `ETH-PERP` | 5.00% | 3.00% | 20.00% | 20× | 5 ETH |

---

## 2. Tham chiếu theo từng contract

### 2.1 FypherOracleRouter — bộ tổng hợp mark-price

Router feed tương thích Chainlink, có kiểm tra staleness và cờ pause toàn cục. Mọi lệnh đọc mark-price trong perps stack đều đi qua đây.

**Admin**

| Function | Caller | Mục đích |
|---|---|---|
| `setOwner(address)` | owner | Chuyển quyền sở hữu (một bước). |
| `setPaused(bool)` | owner | Pause / unpause toàn cục. Khi paused, `getPriceE18` revert. |
| `configureMarketOracle(bytes32 marketId, address feed, uint8 decimals, uint64 maxStalenessSeconds, bool active)` | owner | Đăng ký hoặc cập nhật feed cho 1 market. |

**Read**

| Function | Trả về |
|---|---|
| `getPriceE18(bytes32 marketId)` | Mark price chuẩn hóa về 1e18. Revert nếu: paused, market chưa cấu hình, answer quá cũ (>`maxStalenessSeconds`), answer ≤ 0. |
| `paused()` | Cờ pause toàn cục. |
| `owner()` | Owner hiện tại. |

**Events**: `OwnerUpdated`, `MarketOracleConfigured`, `PausedSet`.

### 2.2 FypherXSettlement — trade journal EIP-712

Event journal ghi-một-lần cho các trade matched off-chain. Relayer truyền tải; key `tradeSigner` *riêng biệt* ký payload EIP-712 (April-audit H-5).

**Admin**

| Function | Caller | Mục đích |
|---|---|---|
| `setOwner(address)` | owner | Chuyển quyền sở hữu. |
| `setRelayer(address, bool)` | owner | Thêm/thu hồi key relayer. |
| `setTradeSigner(address)` | owner | Rotate key trade-signer. |

**Write**

| Function | Caller | Mục đích |
|---|---|---|
| `settleTrade(Trade trade, bytes signature)` | relayer | Emit `TradeSettled` cho trade có EIP-712 digest được ký bởi `tradeSigner`. Revert nếu replay (`tradeId` đã settle rồi), sai chữ ký, hoặc signer chưa set. |

**Read**

| Function | Trả về |
|---|---|
| `digest(Trade)` | EIP-712 digest mà `tradeSigner` phải ký. |
| `domainSeparator()` | EIP-712 domain separator cho `{name: "FypherXSettlement", version: "1", chainId, verifyingContract}`. |
| `settledTrades(bytes32 tradeId)` | `true` sau khi settle. |
| `tradeSigner()` | Address signer hiện tại. |
| `relayers(address)` | Cờ relayer cho từng address. |

**Events**: `TradeSettled`, `OwnerUpdated`, `RelayerUpdated`, `TradeSignerUpdated`.

### 2.3 FypherXInsuranceFundVault — buffer bad-debt bằng ERC-20

Giữ collateral để clearinghouse rút ra khi cần bù deficit của liquidation. Backing bằng ERC-20 (April-audit M-9); đường ETH-receive cũ đã bị bỏ.

**Admin**

| Function | Caller | Mục đích |
|---|---|---|
| `setOwner(address)` | owner | Chuyển quyền sở hữu. |
| `setOperator(address, bool)` | owner | Thêm/thu hồi address có quyền gọi `withdraw`. Clearinghouse **phải** nằm trong set này. |

**Write**

| Function | Caller | Mục đích |
|---|---|---|
| `deposit(uint256 amount, bytes32 referenceId)` | bất kỳ ai | Rút `amount` token từ caller qua `transferFrom` và emit `FundDeposited`. |
| `withdraw(address to, uint256 amount, bytes32 referenceId)` | operator | Chuyển `amount` cho `to`. Revert nếu amount = 0, recipient = zero, hoặc không đủ balance. |

**Read**: `balance()`, `operators(address)`, `token()`, `owner()`.

**Events**: `FundDeposited`, `FundWithdrawn`, `OperatorUpdated`, `OwnerUpdated`.

### 2.4 FypherPerpsClearinghouse — sổ position trung tâm

Trung tâm của hệ thống: vault collateral, sổ position, math margin/leverage, liquidation. Mọi trade đi vào qua `executeMatchedTrade` (gate bởi relayer); mark price cho mọi phép kiểm tra lấy từ `FypherOracleRouter`.

**Admin**

| Function | Caller | Mục đích |
|---|---|---|
| `setOwner(address)` | owner | Chuyển quyền sở hữu. |
| `setRelayer(address, bool)` | owner | Thêm/thu hồi relayer (được gọi `executeMatchedTrade`). |
| `setLiquidator(address, bool)` | owner | Thêm/thu hồi liquidator (relayer cũng tự động là liquidator). |
| `setInsuranceFund(address)` | owner | Trỏ sang `FypherXInsuranceFundVault`. Bắt buộc để `liquidate` có thể bù deficit. |
| `configureMarket(marketId, imBps, mmBps, maxDevBps, maxLevE18, maxSizeE18, active)` | owner | Tạo hoặc cập nhật market. |

**Trader**

| Function | Mục đích |
|---|---|
| `deposit(uint256 amountE18)` | Rút collateral qua `transferFrom`. Caller phải `approve` trước. |
| `withdraw(uint256 amountE18)` | Rút collateral về. Revert nếu equity sau rút < initial margin đang dùng. |

**Relayer**

| Function | Mục đích |
|---|---|
| `executeMatchedTrade(account, marketId, isLong, sizeDeltaE18, executionPriceE18, requestedLeverageE18)` | Áp một trade đã match vào ledger của `account`. Tự dispatch sang open / add / reduce / close / flip dựa trên trạng thái position hiện tại. |

**Liquidator**

| Function | Mục đích |
|---|---|
| `liquidate(account, marketId)` | Revert nếu chưa `isLiquidatable(account)`. Đóng position, áp PnL realized; nếu thiếu, rút từ insurance fund (April-audit H-4); revert nếu fund chưa set hoặc không đủ. |

**Read**

| Function | Trả về |
|---|---|
| `positions(account, marketId)` | `Position{ isLong, sizeE18, entryPriceE18, marginE18, leverageE18 }`. |
| `collateralBalanceE18(account)` | Balance có dấu; có thể âm trước khi liquidate được xử lý. |
| `equity(account)` | `collateral + unrealizedPnl`. |
| `isLiquidatable(account)` | `equity < maintenanceMargin`. |
| `getAccountSnapshot(account)` | Gộp: collateral, uPnL, equity, IM đang dùng, MM yêu cầu, liquidatable. |
| `getConfiguredMarkets()` | Danh sách toàn bộ market IDs. |
| `getAccountMarkets(account)` | Các market account đã từng giữ. |
| `totalInitialMarginUsed`, `totalMaintenanceMarginRequired`, `totalUnrealizedPnl` | Tổng hợp theo account. |

**Events**: `TradeApplied`, `CollateralDeposited`, `CollateralWithdrawn`, `PositionLiquidated`, `InsuranceFundDrawn`, `MarketConfigured`, `InsuranceFundUpdated`, `RelayerUpdated`, `LiquidatorUpdated`, `OwnerUpdated`.

---

## 3. Các flow end-to-end

### 3.1 Trader mở position

```
Trader                    Backend (matching)           Chain
  │                             │                         │
  │  1. approve RUSD ──────────────────────────────────▶ RUSD.approve(clearinghouse, ∞)
  │  2. deposit ────────────────────────────────────────▶ Clearinghouse.deposit(amount)
  │                                                       └─ emit CollateralDeposited
  │  3. đặt limit order ──▶ book off-chain
  │                             │  match đối tác
  │                             │  4. settleTrade (journal) ▶ Settlement.settleTrade(trade, sig)
  │                             │                            └─ emit TradeSettled
  │                             │  5. executeMatchedTrade ──▶ Clearinghouse.executeMatchedTrade(...)
  │                             │                            ├─ oracle.getPriceE18()
  │                             │                            ├─ kiểm tra deviation
  │                             │                            ├─ open/add/reduce/close/flip
  │                             │                            └─ emit TradeApplied
```

**Lưu ý**: `settleTrade` và `executeMatchedTrade` là hai lệnh on-chain độc lập. Settlement journal là bản ghi chống giả mạo; clearinghouse là sổ position sống. Cả hai đều phải thành công thì trade mới final. Backend chịu trách nhiệm sắp xếp thứ tự (settle trước, execute sau) để tránh trường hợp execute fail nhưng trade đã có bản ghi settle mà không có position đi kèm.

### 3.2 Liquidation với insurance-fund backstop

```
Liquidator bot            Chain
  │                         │
  │  poll accounts ────────▶ Clearinghouse.isLiquidatable(account)
  │  nếu true ─────────────▶ Clearinghouse.liquidate(account, marketId)
  │                         │  ├─ đóng position theo mark hiện tại
  │                         │  ├─ áp PnL realized vào collateralBalanceE18
  │                         │  ├─ nếu collateralBalanceE18 < 0:
  │                         │  │    ├─ insuranceFund.withdraw(clearinghouse, deficit)
  │                         │  │    ├─ emit InsuranceFundDrawn
  │                         │  │    └─ zero hoá ledger account (không còn kẽ hở equity âm)
  │                         │  └─ emit PositionLiquidated
```

**Backstop cứng**: `liquidate` sẽ **revert** — không âm thầm thành công — nếu (a) chưa set insurance fund, hoặc (b) fund balance < deficit. Operator phải quyết định: bơm thêm fund, hoặc route sang backstop off-chain. Không có kịch bản bad debt âm thầm.

### 3.3 Operator bơm insurance fund

```
Operator              Chain
  │                     │
  │  approve ──────────▶ RUSD.approve(vault, amount)
  │  deposit ──────────▶ InsuranceFundVault.deposit(amount, reference)
  │                     └─ emit FundDeposited(operator, amount, reference)
```

Ai cũng có thể deposit (fund thiết kế theo hướng additive) — chỉ `operators` được withdraw.

### 3.4 Ký chữ ký settlement

Off-chain, `tradeSigner` ký payload EIP-712 với domain `{name: "FypherXSettlement", version: "1", chainId: 97, verifyingContract: settlementAddress}` và struct:

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

Relayer transmit `(trade, signature)` qua `settleTrade`. Chống replay: `settledTrades[tradeId]` được set sau lần thành công đầu tiên.

### 3.5 Cấu hình market (admin)

```
Owner ──▶ Clearinghouse.configureMarket(marketId, imBps, mmBps, maxDevBps, maxLevE18, maxSizeE18, active)
           │  validate: imBps > 0 ≤ 10000, mmBps ≤ imBps, maxLevE18 ≥ 1e18, maxSizeE18 > 0
           └─ emit MarketConfigured
Owner ──▶ OracleRouter.configureMarketOracle(marketId, feed, decimals, maxStaleness, active)
           └─ emit MarketOracleConfigured
```

---

## 4. Wiring cho backend / frontend

Copy các address bên trên vào backend env:

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

Flow mint signer (staking stack) xem file `docs/DEX_PERPS_PROVISIONING.md` đã có sẵn trong backend repo.

**Frontend (viem)**: bốn address perps đặt vào các biến `NEXT_PUBLIC_PERPS_*`. Adapter mode: `NEXT_PUBLIC_DEFI_ADAPTER_MODE=live-contract` để write on-chain; `contract-ready` để read chain + mock write.

---

## 5. Các gap đã biết (chưa giải quyết trên testnet)

1. **Single-key operator** — deployer đang giữ cả `owner` + `relayer` + `liquidator` + `operator` + `tradeSigner` trên mọi contract. Trước mainnet, tách ra:
   - `owner` → multisig 3-of-5
   - `relayer` → hot wallet trong backend (rate-limited)
   - `liquidator` → hot wallet(s) trong bot
   - `operator` → multisig (slow path) + optional bot (fast path)
   - `tradeSigner` → HSM-backed, rotate độc lập
2. **Mock oracle** — feed BTC/ETH là các instance `MockPriceOracle` mà deployer có thể set giá tùy ý. Trước mainnet, swap sang feed Chainlink thật qua `OracleRouter.configureMarketOracle` và bỏ mock.
3. **Insurance fund đang trống** — `vault.balance() == 0` trên address đã deploy. Mọi liquidation có deficit hiện sẽ revert với `insurance underfunded`. Phải bơm vault qua `deposit` trước khi bật trading thật.
4. **Chưa có rate limit / circuit breaker** — đã có market-level pause, nhưng chưa có per-trader cap hay daily volume cap toàn book. Chấp nhận được cho demo; không được cho mainnet.

---

## 6. Coverage của test

67 Hardhat tests cover admin access control, deployment validation, deposit/withdraw, open/add/reduce/close/flip, liquidation có và không có insurance fund, flow chữ ký EIP-712, oracle staleness/pause, và các view helper. Chạy:

```bash
cd fypherx-contracts/contracts
npm test
```

---

## 7. Redeploy

```bash
cd fypherx-contracts/contracts
# .env yêu cầu: DEPLOYER_PRIVATE_KEY, BSCSCAN_API_KEY,
#               BSC_TESTNET_RPC (optional), DEPLOY_MOCK_ORACLES=true,
#               AUTO_CONFIGURE_MARKETS=true
npm run deploy:bscTestnet

# sau đó verify từng address (xem hardhat.config.js cho entry bscTestnet):
npx hardhat verify --network bscTestnet <oracleRouter>
npx hardhat verify --network bscTestnet <settlement> <relayer> <signer>
npx hardhat verify --network bscTestnet <insuranceFund> <collateralToken> <operator>
npx hardhat verify --network bscTestnet <clearinghouse> <collateralToken> <oracleRouter>
```

Address và ABI được ghi vào `contracts/deployments/bscTestnet.json` và `contracts/artifacts/src/*.sol/*.json`.
