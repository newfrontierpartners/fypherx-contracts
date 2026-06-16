# PROD Deploy Runbook — Get FYUSD / Earn / Redeem (Ethereum mainnet, chainId 1)

2026-06-17. Scope **excludes epoch + the FYUSD token contract** (FYUSD = BitGo enterprise issuance off-chain; Get-FYUSD & Redeem are pure BitGo direct-custody). **Only Earn (70:30) has on-chain contracts.** Collateral = **both USDC and USDT** → two earn vaults + two adapters.

> ⚠️ No mainnet money flows until the external audit clears `FyusdEarnVault` / `ConcreteStableAdapter` / `EarnLockRegistry`. You can deploy contracts, but do not route real funds pre-audit.

## Contracts to deploy (dependency order)
1. **SettingManagement** (proxy) — `initialize(deployer)`; admin transferred to the Operator Safe afterwards.
2. **ReservePool** — `constructor(SettingManagement)`; + `SettingManagement.setReservePool(pool)`.
3. **FypherCircuitBreaker** (proxy) — `initialize(SettingManagement, watchdog)`.
4. **FyusdEarnVault ×2** (proxy, ERC-4626 = vFYUSD) — `initialize(SM, stable, adapter, admin)`. One for USDC, one for USDT. **audit-critical.**
5. **ConcreteStableAdapter ×2** — `constructor(stable, concreteMainnetVault, vaultProxy)`; `concreteVault.asset()` must == stable.
6. **EarnLockRegistry** — `constructor()` + `setLocker(relayer, true)`.

**Not deployed:** FYUSD.sol, FyusdEpochSettlement/Redemption, FypherMinting/BurnQueue/StakingHub/FyusdYieldVault, RUSD/FYP/Staked*, lending, Mock*.

## Scripts
- ✅ `deploy-mainnet-core.js` (NEW) — SettingManagement + ReservePool + CircuitBreaker.
- ✅ `deploy-fyusd-earn-vault.js` — vault + adapter (+init). **Run twice** (USDC, USDT). Records a single key per name → capture both pairs out-of-band.
- ✅ `deploy-earn-lock-registry.js` — lock registry.
- ✅ `deploy-operator-safe.js` — Safe (or use app.safe.global UI). `SAFE_THRESHOLD` env; owner list is 3 (extend to 5 for 3-of-5).
- ✅ `grant-admin-to-safe.js` / `accept-admin-from-safe.js` — chain-aware now. **acceptAdmin() on mainnet → run from the Safe UI** (HW-wallet owners).
- ❌ `deploy-mainnet.js` (broken — missing scripts/deploy.js) · ❌ `deploy-phase1.js` (deploys excluded epoch/FYUSD/yield-vault). DO NOT USE.

## Ordered checklist (1pm)
```bash
cd sotatek-smart-contracts
# .env: PRIVATE_KEY=<funded mainnet deployer>, ETHERSCAN_API_KEY, MAINNET_RPC_URL=<private RPC>
npx hardhat compile

# 1) Operator Safe — app.safe.global (recommended) OR:
SAFE_THRESHOLD=3 npx hardhat run scripts/deploy-operator-safe.js --network mainnet
#    → record Safe addr into addresses/1.json (OperatorSafe) + .env (OPERATOR_SAFE_ADDRESS) + dashboard addresses.ts[1]

# 2) Core (SM + ReservePool + CircuitBreaker)
WATCHDOG_ADDRESS=0x<guardian> npx hardhat run scripts/deploy-mainnet-core.js --network mainnet

# 3) Earn vault + adapter — USDC
STABLE_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
CONCRETE_VAULT_ADDRESS=0x<Concrete mainnet USDC vault> \
ADMIN_ADDRESS=0x<deployer = current SM admin> \
  npx hardhat run scripts/deploy-fyusd-earn-vault.js --network mainnet
#    → record FyusdEarnVault(USDC) + ConcreteStableAdapter(USDC)

# 3b) Earn vault + adapter — USDT
STABLE_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7 \
CONCRETE_VAULT_ADDRESS=0x<Concrete mainnet USDT vault> \
ADMIN_ADDRESS=0x<deployer> \
  npx hardhat run scripts/deploy-fyusd-earn-vault.js --network mainnet
#    → record FyusdEarnVault(USDT) + ConcreteStableAdapter(USDT)

# 4) Lock registry
RELAYER_ADDRESS=0x<backend gas-relayer> npx hardhat run scripts/deploy-earn-lock-registry.js --network mainnet

# 5) Admin → Safe (two-step)
npx hardhat run scripts/grant-admin-to-safe.js --network mainnet   # transferAdmin(safe) — reversible
#    Then in app.safe.global (eth:<safe>): SettingManagement.acceptAdmin() — sign w/ threshold owners
#    → the Safe becomes admin of ALL contracts (they resolve admin via SM.hasRole live)
#    Also: EarnLockRegistry.setOwner(safe) (Safe tx)

# 6) Post-deploy (from the Safe): per vault — setKeeper(<backend hot wallet>), setPauserRole(<guardian|circuitBreaker>),
#    SettingManagement.setPoolConfigs("vFyusdEarnCooldown", 1209600). Concrete whitelists BOTH adapter addresses.

# 7) Verify: npx hardhat verify --network mainnet <addr> <ctor args>  (adapters, ReservePool, EarnLockRegistry)
```

## Backend (gateway) config
```
FYPHERX_CHAIN_ID=1 · ETH_RPC=<mainnet RPC>
FYPHERX_ADMIN_TX_MODE=safe-propose
FYPHERX_OPERATOR_SAFE_ADDRESS=<safe>
FYPHERX_SAFE_TX_SERVICE_URL=https://api.safe.global/tx-service/eth · FYPHERX_SAFE_CHAIN_SLUG=eth
FYPHERX_EARN_VAULT_ADDRESS=<vault(s)> · FYPHERX_EARN_COLLATERAL_SYMBOL=USDC|USDT
BETA_ALLOCATION_FYUSD_BPS=7000  (70:30, backend-managed, not on-chain)
BACKEND_GAS_RELAYER_PRIVATE_KEY=<relayer; register as Safe delegate on api.safe.global/tx-service/eth>
```

## Team-owned blockers (resolve before deploy)
1. **Concrete mainnet vault addresses ×2** (USDC + USDT) + Concrete whitelists both our adapter addresses post-deploy.
2. **Safe owners + threshold** (ADR-007 → 3-of-5; deploy-operator-safe owner list is 3 → extend to 5, or use the Safe UI).
3. **Funded mainnet deployer key** (PRIVATE_KEY) — ~8 deploys + admin txs of ETH.
4. **External audit gate** cleared for FyusdEarnVault / ConcreteStableAdapter / EarnLockRegistry.
5. **MAINNET_RPC_URL** — set a private provider (llamarpc default is fine only for resolution).
