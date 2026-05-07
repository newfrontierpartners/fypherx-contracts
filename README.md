# Fypher Protocol — Alpha Audit Package

This repository is the smart-contract codebase for the **alpha launch** of the Fypher protocol, prepared for an external security audit. Everything outside the alpha launch scope (lending markets, LP vaults, perpetual derivatives) has been moved into [`backup/`](./backup/) and is **out of scope**; the canonical audit target is [`sotatek-smart-contracts/contracts/`](./sotatek-smart-contracts/contracts/).

| Field | Value |
|---|---|
| Live network | BNB Smart Chain Testnet (chainId `97`) |
| Solidity | `0.8.22`, optimizer enabled, **runs = 1** |
| Framework | Hardhat 2.28 + OpenZeppelin Contracts v5.0.2 + `@openzeppelin/hardhat-upgrades` |
| Upgrade pattern | TransparentUpgradeableProxy (per major contract); proxy admin = deployer EOA |
| In-scope files | 25 Solidity files / ~5,100 lines (incl. comments) |
| Tests | 7 suites / 84 unit + invariant tests under `sotatek-smart-contracts/test/` |
| Source of truth (addresses) | [`sotatek-smart-contracts/deployed-addresses.json`](./sotatek-smart-contracts/deployed-addresses.json) |

```
fypherx-contracts/
├── README.md                           ← you are here (audit overview)
├── sotatek-smart-contracts/            ← AUDIT TARGET
│   ├── contracts/
│   │   ├── Fypher/                     19 production contracts
│   │   ├── interfaces/                 3 interfaces
│   │   ├── libraries/                  1 library (PoolMath)
│   │   └── mocks/                      2 test fixtures
│   ├── test/                           7 test suites
│   ├── scripts/                        deploy + ops scripts
│   ├── contracts.md                    deployed address registry
│   ├── deployed-addresses.json         machine-readable address map
│   └── hardhat.config.js
├── backup/                             OUT OF SCOPE — see backup/README.md
├── audit/                              prior-audit artifacts (Apr 2026 P0 deep dive)
└── docs/                               architecture decision records, deployment notes
```

---

## 1. What Fypher is, in one paragraph

Fypher is a stablecoin and yield protocol built on BSC. End users deposit whitelisted ERC-20 collateral (USDT, USDC, WETH, BTC, BNB) into the **`FypherMinting`** contract and receive **`RUSD`**, the protocol's native dollar-pegged stablecoin, on a 1-for-1 basis after a backend-signed quote is verified on-chain. RUSD can be staked for **`StakedRUSD` (sRUSD)** to earn yield, or converted into **`FYUSD`** — a yield-bearing stablecoin whose underlying capital is custodied by Bitgo Prime and farmed against the **Concrete protocol** for off-chain yield. **`FYP`** is the protocol's governance token; staking sRUSD or FYUSD into the **`FypherStakingHub`** mints `FYP` rewards on a per-block emission schedule. Finally, the **`FypherCircuitBreaker`** is registered as the per-asset / per-phase pauser on every Phase 1 contract and acts as the single emergency-response surface for ops.

> **Out of alpha scope.** The institutional fork — `InstitutionalRUSD` (iRUSD), `StakedIRUSD` (siRUSD), `SIRUSDSilo` — has been moved to [`backup/irusd/`](./backup/irusd/) for the alpha audit. Those contracts are deployed on BSC Testnet but are not exercised by any user-facing flow in the alpha launch. Re-introduction will follow institutional onboarding and a separate audit cycle.

---

## 2. Audit scope

### In scope (audit these)

All files under `sotatek-smart-contracts/contracts/`:

#### 2.1 Tokens (3 base + 2 vault receipt + 3 staked-receipt)

**Base tokens (3, in scope as standalone contracts):**

| Contract | Purpose | Upgradeable | Decimals | Initial supply |
|---|---|---|---|---|
| `RUSD.sol` | Primary dollar-pegged stablecoin | ✓ TransparentProxy | 18 | 0; minted by `FypherMinting` only |
| `FYUSD.sol` | Yield-bearing stablecoin (Bitgo + Concrete backed) | ✓ | 18 | 0; minted by `FyusdEpochSettlement` only |
| `FYP.sol` | Governance token (pausable, burnable) | ✓ | 18 | Minted at deploy to deployer; FYP treasury distributes via `FypherStakingHub.fundFpy()` |

All three use ERC20Permit (EIP-2612) and ERC20Pausable. RUSD and FYUSD also expose a single-minter slot guarded by `SingleAdminAccessControl`; the slot can only be reassigned by the admin, and emits `MinterUpdated` so off-chain audit indexers can track every reassignment.

**Vault receipt tokens (2, ERC4626 share tokens minted by the yield vaults):**

| Symbol | Underlying | Mint contract | NAV mechanism |
|---|---|---|---|
| `vFYUSD` | FYUSD | `FyusdYieldVault.sol` | Per-share NAV grows as `IConcreteAdapter.totalAssets()` accrues yield. Cooldown 7 days (admin-tunable via `vFyusdCooldown` pool config). |
| `vRUSD` | RUSD | `RUSDYieldVault.sol` | Same model as vFYUSD, dedicated adapter binding. Cooldown 14 days (admin-tunable via `vRusdCooldown` pool config). |

Both vTokens are full ERC20Permit + ERC20Pausable. They are transferable, composable as collateral elsewhere in DeFi, and share-count-stable (yield = NAV growth, not share inflation).

**Staked receipt tokens (3, ERC4626 share tokens — see §2.3):** `sRUSD`, `stAUSD` (= staked FYUSD, legacy name), `sFYP`.

The institutional `InstitutionalRUSD` (iRUSD) token has been moved to [`backup/irusd/`](../backup/irusd/) and is not part of the alpha audit scope.

#### 2.2 Mint / burn engine (2)

| Contract | Purpose |
|---|---|
| `FypherMinting.sol` | Off-chain-quoted, on-chain-verified collateral → RUSD swap. EIP-712 typed signatures with `OrderType` (MINT \| REDEEM) bound into the digest. Per-block per-asset rate limits. Whitelisted custodian routing. |
| `FypherBurnQueue.sol` | 7-day-delayed RUSD → collateral redemption. Burns RUSD immediately on request, releases collateral after `BURN_DELAY_SECONDS = 7 days`. Backend-signed quotes prevent front-running of asset/amount. |

#### 2.3 Staking — 7-day cooldown vaults (3 + 1 silo)

ERC-4626 vaults; depositors receive shares (s* tokens) that are non-transferable during cooldown. Withdrawals run through a silo escrow:

| Vault | Underlying | Silo |
|---|---|---|
| `StakedRUSD.sol` (sRUSD) | RUSD | `RUSDSilo.sol` |
| `StakedAUSD.sol` (stAUSD) | **FYUSD** (legacy name; underlying is FYUSD) | `RUSDSilo.sol` |
| `StakedFYP.sol` (sFYP) | FYP | `RUSDSilo.sol` |

The silo contract is intentionally minimal — it holds tokens during the 7-day window and only allows `withdraw` calls from the staking vault that deployed it. It has no proxy, no storage, no admin; this is by design (it is a pure escrow).

> **Note on `StakedAUSD`.** Despite the contract name, the underlying asset is **FYUSD** (see `__ERC4626_init(_fyusd)` in `initialize`). The "AUSD" name is a legacy artifact retained because the BSC Testnet proxy is already deployed at this implementation. The companion institutional vault `StakedIRUSD` (siRUSD) and its silo `SIRUSDSilo` are out of alpha scope (see [`backup/irusd/`](../backup/irusd/)).

#### 2.4 FYP emission staking hub (1)

| Contract | Purpose |
|---|---|
| `FypherStakingHub.sol` | Single multi-pool staking contract that emits `FYP` per block, allocated across pools by `weightBps`. Sub-pools currently registered: pool 0 = sRUSD, pool 1 = stAUSD. Standard MasterChef-style accounting (`accFpyPerShare`, `fpyDebt`). |

The `FypherStakingHub` is independent of the per-token cooldown vaults above — users stake the *vault share token* (`sRUSD`/`stAUSD`) into the hub to earn FYP. There is no cooldown on the hub itself; cooldown is enforced at the underlying vault layer.

#### 2.5 Yield-vault system — Concrete-backed (5)

| Contract | Purpose |
|---|---|
| `FyusdEpochSettlement.sol` | Get-FYUSD flow. Users deposit collateral during an `OPEN` epoch with a backend-signed quote; backend custodian deposits to Bitgo Prime; once Bitgo confirms, executor mints FYUSD pro-rata to depositors against the deposited collateral. State machine: `OPEN → LOCKED → SETTLED → DISTRIBUTED`, plus `CANCELLED` for SLA breach. |
| `FyusdYieldVault.sol` (vFYUSD) | ERC4626 receipt-token vault for the Concrete-backed FYUSD yield strategy. Users deposit FYUSD, receive `vFYUSD` shares whose per-share NAV grows as the adapter accrues yield. Withdrawals go through a 7-day (admin-tunable) cooldown queue + `RUSDSilo`-pattern escrow; direct `withdraw`/`redeem` revert. |
| `RUSDYieldVault.sol` (vRUSD) | ERC4626 receipt-token vault for the Concrete-backed RUSD yield strategy — mirror of `FyusdYieldVault` for the RUSD asset. 14-day cooldown default. |
| `IConcreteAdapter.sol` | Asset-agnostic adapter interface — `asset()`, `totalAssets()`, `shareOf()`, `realizedYield7d()`, `deposit()`, `withdraw()`. One adapter instance per (vault, asset) binding (separate FYUSD adapter and RUSD adapter on mainnet). |
| `ConcreteAdapterV1.sol` | Mainnet binding to the Concrete protocol vault. **All state-changing methods currently revert `NotImplemented`** — this is a stub awaiting the Concrete protocol's mainnet metadata (per ADR-006). On BSC Testnet both vaults use `MockConcreteAdapter` (one instance per asset) instead. The contract is in scope so the auditor can review the interface and the eventual binding shape, but the implementation will land in a follow-up PR coordinated with Concrete. |

**Cooldown invariant.** Both yield vaults enforce a single exit path: `cooldownAssets`/`cooldownShares` → silo escrow → `unstake` after `cooldownEnd`. The cooldown duration is read live from `SettingManagement.getPoolConfigs(...)` so admin can tune `vFyusdCooldown` (default 7 d) and `vRusdCooldown` (default 14 d) independently without redeploying the vaults.

#### 2.6 System / config / safety (4)

| Contract | Purpose |
|---|---|
| `SettingManagement.sol` | Central registry — admin role, fee receiver, cooldown duration, supported-collateral list, blacklist, pool config. Read by every other contract. Upgradeable. |
| `SingleAdminAccessControl.sol` | Two-step admin transfer (propose → accept after timelock). Base contract for token contracts and others that need a single-admin model. |
| `ReservePool.sol` | Holds the protocol's emergency reserve liquidity (target = 3% of issuance). Non-proxy contract; admin-only `distribute` and `emergencyWithdraw`. |
| `FypherCircuitBreaker.sol` | Pre-registered `Trigger`s (named, with pre-encoded pause / unpause call data). A watchdog EOA can call `trip(triggerId, calls, reasonHash)` to execute the pause sequence; multisig admin calls `reset` to unpause. The breaker is the registered `pauserRole` on every Phase 1 pausable contract. |

#### 2.7 Interfaces & libraries (4)

| File | Purpose |
|---|---|
| `interfaces/ISettingManagement.sol` | Public read interface to `SettingManagement` — every other contract reads from here. |
| `interfaces/IStakedRUSD.sol`, `IStakedRUSDCooldown.sol` | Interfaces consumed by the silo + cooldown vault flow. |
| `libraries/PoolMath.sol` | Shared math helpers for ERC-4626 cooldown vaults (RUSD, AUSD, FYP). 45 lines, no external calls. |

#### 2.8 Test fixtures (2)

| File | Purpose |
|---|---|
| `mocks/MockERC20.sol` | Minimal mintable/burnable ERC-20 used as fake collateral in tests. Anyone can call `mint(to, amount)` — never deploy this on mainnet. |
| `mocks/MockConcreteAdapter.sol` | Implements `IConcreteAdapter` against a fixed APY for BSC Testnet. Replaces `ConcreteAdapterV1` on testnet so the FYUSD yield vault has end-to-end deposit/withdraw flows. |

### Out of scope

Everything under [`backup/`](./backup/), namely:

- **`backup/lp/`** — Pancake-V2-style LP vaults (`FypherLPVault`, `FypherLiquidityManager`)
- **`backup/lending/`** — Morpho-Blue-style isolated lending markets (`FypherLendingMarket*`, `KinkedIRM`, `InsuranceFundV2`, oracle adapters)
- **`backup/perps/`** — Perpetual derivatives Hardhat subproject (`FypherPerpsClearinghouse`, `FypherXSettlement`, `FypherXInsuranceFundVault`, `FypherOracleRouter`)

See [`backup/README.md`](./backup/README.md) for the full inventory and the rationale for exclusion. **None of the in-scope contracts import or call any backed-up contract**, and the alpha tree compiles cleanly without the backup folder.

---

## 3. System architecture

### 3.1 Top-down dependency graph (in-scope only)

```
                        ┌────────────────────────┐
                        │  SettingManagement     │  ← admin, fee receiver,
                        │  (registry, upgrade)   │    cooldown, blacklist
                        └────────────┬───────────┘
                                     │ reads
        ┌────────────────────────────┼──────────────────────────────┐
        │                            │                              │
   ┌────▼─────┐    ┌─────────┐  ┌────▼─────┐  ┌────────────┐  ┌────▼────────────┐
   │  RUSD    │◄───┤ Fypher  │  │ FYUSD    │◄─┤ FyusdEpoch │  │ FYP             │
   │  (token) │mint│ Minting │  │ (token)  │  │ Settlement │  │ (token)         │
   └────┬─────┘    │ (proxy) │  └────┬─────┘  └────────────┘  └────┬────────────┘
        │ burnFrom └────┬────┘       │ deposit/withdraw          fundFpy()
        ▼               │            ▼                              │ rewards
   ┌────────────┐ collateral    ┌─────────────┐  forwards        ┌──▼────────────┐
   │ FypherBurn │   inflow      │ FyusdYield  │ ──────────────►  │ FypherStaking │
   │ Queue      │  (USDT/USDC/  │ Vault       │  IConcrete       │ Hub (multi-   │
   │ (7-day)    │   WETH/BTC/   └─────────────┘  Adapter          │ pool, FYP    │
   └────────────┘    BNB)              │                          │ emissions)   │
                                       │   shares 1:1             └──┬────────────┘
                                       ▼                             │
                                ┌──────────────┐                     │
                                │ Mock /       │                     │
                                │ ConcreteAdap-│                     │
                                │ terV1 (stub) │                     │
                                └──────────────┘                     │
                                                                     │
  Cooldown vaults (ERC-4626, 7-day):                                 │
  ┌────────────┐   ┌────────────┐   ┌────────────┐                   │
  │ StakedRUSD │   │ StakedAUSD │   │ StakedFYP  │◄──────────────────┘
  │ (sRUSD)    │   │ = stFYUSD  │   │ (sFYP)     │
  └─────┬──────┘   └─────┬──────┘   └─────┬──────┘
        │ withdraw       │ withdraw       │ withdraw
        ▼ via            ▼ via            ▼ via
  ┌────────────┐   ┌────────────┐   ┌────────────┐
  │ RUSDSilo   │   │ RUSDSilo   │   │ RUSDSilo   │
  └────────────┘   └────────────┘   └────────────┘

  Safety:
  ┌──────────────────────────┐
  │ FypherCircuitBreaker     │ pauserRole on:
  │ (Trigger registry +      │   FypherMinting, FypherBurnQueue,
  │  watchdog trip / multisig│   FypherStakingHub, FyusdEpochSettlement,
  │  reset)                  │   FyusdYieldVault, all Staked* vaults
  └──────────────────────────┘
```

### 3.2 Trust boundaries

There are three off-chain authorities that the on-chain contracts trust within bounded scopes:

1. **Backend signer** (`SettingManagement.signer()`).  
   Signs EIP-712 quotes for `FypherMinting`, `FypherBurnQueue`, `FyusdEpochSettlement`. The signer can authorize a user to mint/burn/deposit a specific (asset, amount, expiry, nonce) tuple, but cannot change protocol parameters or move funds outside the user's quote. Signature replay is prevented by per-user nonces and expiry timestamps. The `OrderType` field in `FypherMinting`'s EIP-712 schema additionally prevents replay of a MINT signature as a REDEEM (an issue addressed by the Apr 2026 P0 audit — see §7).

2. **Settlement executor** (`FyusdEpochSettlement`-only).  
   An EOA registered in `SettingManagement` that the backend uses to call `lockEpoch` and `settleEpoch` after Bitgo Prime confirms an off-chain deposit. The executor cannot cancel or re-open epochs (admin-only) and cannot mint outside the (epochId, fyusdMinted) parameters of its own settle call.

3. **Watchdog EOA** (`FypherCircuitBreaker`).  
   An off-chain monitor that calls `trip(triggerId, ...)` when oracle deviation, collateral shortfall, or Bitgo SLA breach is detected. The watchdog can only execute pre-registered `pauseCalls` for known triggers; it cannot register new triggers and cannot unpause anything. Unpause is admin (multisig) only — see ADR-007.

The remaining authority is the **single admin** registered in `SingleAdminAccessControl` (typically a Gnosis Safe multisig). The admin can:

- upgrade any of the TransparentUpgradeableProxy contracts (proxy admin = deployer, scheduled to migrate to multisig);
- reassign minter / executor / signer / watchdog slots;
- register and modify circuit-breaker triggers;
- set fees, cooldown durations, supported-collateral lists, blacklist entries on `SettingManagement`;
- emergency-withdraw from `ReservePool`.

The admin **cannot** mint tokens directly (RUSD / FYUSD have a single-minter slot pinned to a specific contract; FYP is funded into the staking hub via `fundFpy`), and cannot bypass the 7-day burn / cooldown windows (the windows are enforced via `block.timestamp` in non-upgradeable code paths).

---

## 4. Business-logic flows

This section walks through every user-facing flow in production. Each subsection ends with the trust assumptions and invariants the auditor should focus on.

### 4.1 Mint RUSD

```
User wallet               FypherMinting               RUSD
   │                            │                      │
   │  (off-chain) request quote │                      │
   │  ─────────────────────►    │  Backend signs       │
   │  ◄──── EIP-712 signature   │  (signer EOA)        │
   │                            │                      │
   │  ERC20.approve(asset, ...) │                      │
   │  ─────────────────────►    │                      │
   │                            │                      │
   │  mint(quote, sig)          │                      │
   │  ─────────────────────►    │                      │
   │                            │  ECDSA.recover(sig)  │
   │                            │  == settings.signer  │
   │                            │  expiry > now        │
   │                            │  nonce unused        │
   │                            │  rate-limit ok       │
   │                            │  custodian list ok   │
   │                            │                      │
   │                            │  pull collateral     │
   │                            │  ────────────────►   │
   │                            │  (per-custodian      │
   │                            │   ratio split,       │
   │                            │   sum == 10_000 bps) │
   │                            │                      │
   │                            │  RUSD.mint(user, x)  │
   │                            │  ────────────────►   │
   │  ◄──── x RUSD              │                      │
```

**Quote schema (EIP-712).**

```solidity
struct Order {
    OrderType orderType;          // MINT | REDEEM
    address user;
    address collateralAsset;
    uint256 collateralAmount;
    uint256 rusdAmount;
    uint256 nonce;
    uint256 expiry;
}
```

The domain separator is computed on demand (chain-id aware) so cross-chain replay is prevented automatically without an init-time write.

**Key invariants to audit:**

- The `signer == settings.signer()` check is performed *every* mint — there is no cached value. If `settings.signer()` is rotated, prior signatures (with future expiry) are invalidated.
- `nonce` is per-user, persistent. Once consumed, the same `(user, nonce)` cannot mint again, regardless of `orderType`.
- `_distributeCollateral` enforces (a) every recipient is in `settings.allowedCustodians()`, (b) the `ratiosBps[]` array sums to exactly `10_000`, (c) no `(addr=0, ratio=0)` row passes — else it reverts. This was a P0 finding (C-4) addressed before audit handoff.
- `mintWETH` is permanently disabled (reverts `DeprecatedFunction`) — the previous implementation minted RUSD without ever transferring collateral (P0 finding).

### 4.2 Burn RUSD (7-day delay)

```
User wallet              FypherBurnQueue            RUSD               Collateral
   │                          │                       │                     │
   │  (off-chain) burn quote  │                       │                     │
   │  ─────────────────►      │  Backend signs        │                     │
   │  ◄── (BurnQuote, sig)    │                       │                     │
   │                          │                       │                     │
   │  RUSD.approve(burn, x)   │                       │                     │
   │  ─────────────────►      │                       │                     │
   │                          │                       │                     │
   │  requestBurn(q, sig)     │                       │                     │
   │  ─────────────────►      │                       │                     │
   │                          │  RUSD.burnFrom(user)  │                     │
   │                          │  ─────────────────►   │                     │
   │                          │                       │                     │
   │                          │  ticket.unlockAt =    │                     │
   │                          │   block.timestamp +   │                     │
   │                          │   7 days              │                     │
   │                          │                       │                     │
   │  ◄── ticket id           │                       │                     │
   │                                                                        │
   │  ... wait 7 days ...                                                   │
   │                                                                        │
   │  claim(ticketId)                                                       │
   │  ─────────────────►      │                       │                     │
   │                          │  unlockAt <= now      │                     │
   │                          │  not claimed          │                     │
   │                          │                                             │
   │                          │  collateral.transfer(user, q.collateralAmt) │
   │                          │  ─────────────────────────────────────────► │
   │  ◄── collateral                                                        │
```

**Why a 7-day delay?** It is the spec's primary defense against (a) flash-loan-style mint→burn arbitrage during oracle de-pegs, (b) fast-exit attacks during the protocol's bootstrapping period, and (c) collateral runs that would drain the reserve before ops can react. The delay is enforced via `block.timestamp + 7 days` in `requestBurn` and a `block.timestamp >= unlockAt` check in `claim`. There is no admin override; the only emergency lever is `emergencyReverse` which is multisig-only and requires re-minting via `FypherMinting`.

**Cancellation is intentionally not supported** in v1 — re-minting after cancel would require either an upgrade or re-routing through `FypherMinting`, and the team chose to keep the redemption commitment on-chain irrevocable. This is documented behavior, not an oversight.

**Per-asset pause** (`assetPaused[asset]`, ADR-008): the circuit breaker can pause new burn requests for a specific collateral asset (e.g. if WETH oracle is stale) while allowing claims of already-pending tickets to proceed.

**Key invariants:**

- Tickets can only be claimed once. `claimed[ticketId] = true` is set before the collateral transfer.
- The collateral asset and amount are bound into the EIP-191 signed quote, so the user cannot front-run with a different (asset, amount) than the backend approved.
- The contract holds collateral in trust between request and claim. Auditing the deposit / refill model for that trust balance is critical — `FypherBurnQueue` does **not** mint or burn collateral, it transfers from a custody address whose balance the ops team is responsible for keeping topped up.

### 4.3 Get FYUSD (epoch settlement)

```
       OPEN ──────► LOCKED ──────► SETTLED ──────► DISTRIBUTED
        │             │              │
        │             │              │ (admin) cancelEpoch
        │             ▼              ▼
        └────► CANCELLED  (refund collateral via standard claim path)
```

| State | Who can transition | What they do |
|---|---|---|
| **OPEN** | (auto on `openEpoch`) | Users call `deposit(quote, sig)` to post collateral and lock in their FYUSD entitlement (pro-rata once the epoch settles). |
| **LOCKED** | anyone after `lockAt` | Triggers the off-chain Bitgo Prime deposit. No more `deposit` calls accepted. |
| **SETTLED** | executor EOA | After Bitgo confirms, executor calls `settleEpoch(epochId, fyusdMinted)`. The contract mints the agreed FYUSD amount via `FYUSD._minter` (set to this contract) and records each user's entitlement. |
| **DISTRIBUTED** | (auto, when last claim is processed) | All users have called `claim`. |
| **CANCELLED** | admin | If Bitgo SLA breaches, admin calls `cancelEpoch`. The standard `claim()` path detects CANCELLED state and refunds collateral instead of FYUSD. |

The `FYUSD._minter` slot is pinned to `FyusdEpochSettlement` — no other contract can mint FYUSD. This is the single largest concentration-of-trust point in the protocol; the auditor should pay special attention to:

- Reentrancy / cross-function reentrancy on `deposit`/`settle`/`claim` (they share the per-(epochId, user) entitlement map);
- The accounting between `epoch.fyusdMinted` and the sum of `claim`ed amounts (must equal exactly, no leftover, no over-claim);
- The cancel path must refund **collateral** to the original depositor in proportion to their `collateralDeposited`, not in proportion to entitlement (which has not yet crystallized).

The Apr 2026 invariant suite (`test/Invariants.test.js`) includes "Invariant 3: epoch leftover == 0 after all claims" specifically to test this.

### 4.4 FYUSD Yield Vault

User-facing flow:

```
User → FYUSD.permit(...)           (EIP-2612, no separate approve)
User → FyusdYieldVault.deposit(amount, deadline, v, r, s)
       └─ vault forwards to ConcreteAdapter.deposit(amount)
                  └─ adapter routes into Concrete protocol
                  └─ adapter mints `shares` 1:1 to vault
       └─ vault credits `shares` to user
User ← (deposit successful)

User → FyusdYieldVault.withdraw(shares)
       └─ vault calls ConcreteAdapter.withdraw(shares)
                  └─ adapter pulls FYUSD out of Concrete
                  └─ adapter transfers FYUSD to vault
       └─ vault transfers FYUSD to user
User ← (FYUSD with accrued yield)
```

**Why the vault layer?** Three reasons documented in the contract header (line 17–28):

1. Per-user shares are isolated from the protocol's adapter shares, so the adapter can be migrated to a v2 contract without users having to track a new share token.
2. `vaultPaused` (ADR-008) gives ops a single switch to freeze deposits/withdraws independent of Concrete's own pause state.
3. Lets the admin swap mock <-> real adapter at deploy time per network without changing the user-visible contract address.

On BSC Testnet the adapter is `MockConcreteAdapter` (returns a fixed APY). On mainnet the adapter will be `ConcreteAdapterV1` once the Concrete protocol's binding metadata is finalized. **`ConcreteAdapterV1` currently reverts every method with `NotImplemented`** — this is intentional (per ADR-006) so accidental BSC-Testnet deployment of the stub fails loudly. The interface is locked.

Auditor note: the `realizedYield7d()` is a *display-only* read used by the customer frontend to show a 7-day APY estimate. It does not influence accounting; only `totalAssets()` and `shareOf(user)` matter for share/asset conversion.

### 4.4½ Vault deposit / cooldown (vFYUSD / vRUSD)

Mirror of the staking-vault flow, with the underlying held in the Concrete adapter rather than directly in the vault:

```
User wallet                    FyusdYieldVault                 IConcreteAdapter
   │  deposit(assets, recv)       │                                 │
   │ ──────────────────────────►  │  pull FYUSD                     │
   │                              │  ──────────────────────────►   │  adapter.deposit
   │                              │                                 │
   │  ◄────────────  vFYUSD mint  │                                 │
   │  (shares = assets / NAV)     │                                 │
   │                              │                                 │
   │  ... time passes; adapter accrues yield ...                    │
   │                              │                                 │
   │  cooldownAssets(X)           │                                 │
   │ ──────────────────────────►  │  burn vFYUSD shares             │
   │                              │  ──────────────────────────►   │  adapter.withdraw(shares)
   │                              │  ◄──────── FYUSD ─────────      │
   │                              │  → silo (escrow during cooldown)│
   │                              │                                 │
   │  ... cooldown elapses ...    │                                 │
   │                              │                                 │
   │  unstake(receiver)           │  silo.withdraw(receiver, X)     │
   │  ◄──────── FYUSD ──────────  │                                 │
```

`RUSDYieldVault` follows the same shape with `RUSD` as the asset. Auditor focus areas:

- The `_withdraw` ERC4626 hook is overridden to revert — direct exit must not be possible. Any path that ends up in OZ's `_withdraw` is a bug.
- Vault `totalSupply` MUST equal `adapter.shareOf(vault)` invariant: every `_deposit` mints both 1:1; every `_exitToCooldown` burns both 1:1. Verify no path mints/burns one without the other.
- `_exitToCooldown` calls `adapter.withdraw(shares)` and asserts the FYUSD returned ≥ the user's expected `assets`. Slippage > 0 wei reverts (`AdapterReturnedShort`); the audit should consider whether a malicious adapter v2 could under-pay and what the migration story is (see `setAdapter`).
- Cooldown duration is admin-mutable via `SettingManagement.setPoolConfigs(key, seconds)`. New cooldown entries pick up the change on the next call; existing entries' `cooldownEnd` is never retro-shortened (`_accrueCooldown` only extends forward).

### 4.5 Cooldown staking (sRUSD / stAUSD / sFYP)

All three ERC-4626 vaults follow the same pattern:

1. `deposit(assets, receiver)` — deposits the underlying token, mints shares.
2. `cooldownAssets(assets)` (or `cooldownShares(shares)`) — moves the user's shares into a 7-day "cooling" state and transfers the underlying tokens out of the vault into the silo.
3. `unstake(receiver)` — after `cooldownEnd`, transfers tokens from the silo to `receiver`. Reverts if cooldown not yet elapsed.

The silo contract `RUSDSilo` is intentionally minimal:

- No proxy, no admin, no storage other than the vault address (immutable in the constructor).
- Only the vault that deployed it can call `withdraw(to, amount)`.
- No emergency-recover function — if the silo holds an asset that should not be there (e.g. a stuck transfer), the only path to recover is via the vault that owns it.

**StakedAUSD (stAUSD) note.** Despite the legacy `AUSD` name, the underlying asset is **FYUSD** (`__ERC4626_init(_fyusd)` in `initialize`). The vault uses a single `RUSDSilo`-pattern silo (constructor-set `silo` address). The historical "two silos" arrangement (retail + institutional) has been retired together with the iRUSD trio; the secondary silo `SIRUSDSilo` is preserved in [`backup/irusd/`](../backup/irusd/) but not part of the alpha audit.

### 4.6 FYP emission staking (FypherStakingHub)

This is the protocol's incentive distribution layer. It is a single multi-pool MasterChef-style contract:

```
fpyPerBlock × poolWeight / totalAllocBps = pool's FPY/block

For each pool:
  accFpyPerShare += emitted_since_last_accrual / totalStaked
  user.pending     = user.amount × accFpyPerShare - user.fpyDebt
  on stake/unstake/claim: pay pending FPY, update fpyDebt
```

Currently registered pools (per `deployed-addresses.json` + on-chain state):

| Pool ID | Underlying | Default weight |
|---|---|---|
| 0 | sRUSD (StakedRUSD share) | `10_000` (1.0×) |
| 1 | stAUSD (StakedAUSD share) | `20_000` (2.0×) |

The hub does **not** introduce a cooldown. The cooldown is on the underlying vault (sRUSD / stAUSD); the hub just stakes the share token. This decouples emission economics from withdrawal economics.

**FPY supply.** The hub holds an FPY balance funded by `fundFpy(amount)` (anyone, but only the FYP treasury actually does it in practice). The admin sets `fpyPerBlock`. If the hub runs out of FPY and a user calls `claimRewards`, the call reverts with `InsufficientFpy(have, want)` — there is no auto-burn or auto-mint.

**Per-pool pause.** ADR-008. `setPoolPaused(poolId, true)` blocks `stake` to that pool but leaves `unstake` and `claim` open so users can always exit a paused pool.

Auditor focus:

- The accrual math (`accFpyPerShare`, `fpyDebt`) is the standard MasterChef pattern — verify rounding direction is consistent across stake/unstake/claim/migrate.
- `migrate(fromPool, toPool, amount)` performs an atomic move; verify there is no block of FPY that goes unaccounted in the hop.
- `setPoolWeight` recomputes `totalAllocBps`. Verify pool weight changes apply to *future* blocks only, not retroactive (an off-by-one here would let a user claim emissions at the new weight for blocks that already accrued at the old weight).

### 4.7 Circuit breaker (FypherCircuitBreaker)

Pre-registered triggers map a named ops scenario to a sequence of pause / unpause calls:

```solidity
struct Trigger {
    string  name;            // e.g. "ETH_ORACLE_STALE"
    string  description;
    Call[]  pauseCalls;      // executed by trip()
    Call[]  unpauseCalls;    // executed by reset()
    bool    tripped;
    uint64  trippedAt;
}
struct Call {
    address target;          // pause-target contract
    bytes   data;            // ABI-encoded selector + args
}
```

Triggers are registered by admin (multisig) ahead of incident time. At incident time, the **watchdog EOA** (an off-chain monitor) calls `trip(triggerId, calls, reasonHash)`:

- `triggerId` and `calls` are passed redundantly so the trip transaction doubles as a self-describing audit-ledger row (ADR-009);
- Each `Call` is executed sequentially via low-level `call`. If any call reverts, the whole trip reverts (atomic).
- `trip` cannot be called when the trigger is already tripped, and cannot register new pause calls (only execute pre-registered ones).

The reverse path (`reset`) is **admin-only** — the watchdog cannot unpause. This asymmetry is deliberate and matches the pause-vs-unpause asymmetry on each downstream contract (per ADR-007).

Auditor focus:

- The `Call` data is constructed at trigger-registration time and stored on-chain. Verify there is no way for a malicious admin to register a trigger whose `pauseCalls` execute arbitrary state writes (the targets *are* admin-controllable, so this is a multisig governance concern more than a contract-level bug, but the audit should confirm the breaker itself does not reduce the cost of an admin-malice attack);
- Ensure `trip` cannot be replayed against the same trigger to consume a second `Call[]` array (it can't — `tripped` flag prevents);
- The `reasonHash` is a `bytes32` indexer hint — verify it is purely informational and does not gate any behavior.

---

## 5. Privileged roles & access control summary

| Role | Holder | Setter | Powers |
|---|---|---|---|
| **Admin** | Multisig (TBD on mainnet; deployer EOA on testnet) | self (two-step transfer) | Upgrade proxies; rotate every other role; set fees / cooldown / blacklist on `SettingManagement`; emergency-withdraw `ReservePool`; register and modify breaker triggers; `cancelEpoch` |
| **Backend signer** | EOA `0x31B60b…` (testnet) | Admin | Signs EIP-712 quotes for mint / burn / epoch-deposit. Cannot move funds outside the user's quote. |
| **Settlement executor** | EOA `0x31B60b…` (testnet) | Admin | Calls `lockEpoch` and `settleEpoch` on `FyusdEpochSettlement`. Cannot mint outside the settle parameters. |
| **Watchdog** | EOA (off-chain monitor) | Admin | Calls `trip` on the circuit breaker for pre-registered triggers. Cannot unpause. |
| **Pauser** | `FypherCircuitBreaker` | Admin (per-target) | Per-asset / per-pool / per-phase pause across all Phase 1 contracts. |
| **Custodian** | Whitelisted addresses in `settings.allowedCustodians()` | Admin | Receive collateral routed by `FypherMinting` per the order's `(addrs[], ratiosBps[])` split. |
| **RUSD minter** | `FypherMinting` (sole) | Admin (via RUSD's `_setMinter`) | Mint RUSD. The slot is single-valued. |
| **FYUSD minter** | `FyusdEpochSettlement` (sole) | Admin (via FYUSD's `_setMinter`) | Mint FYUSD. Single-valued. |
| **FYP minter** | (none, post-deploy) | n/a | FYP is minted only at deploy. After that, FYP supply is fixed; emissions are paid out of `FypherStakingHub`'s funded balance. |

The deployer EOA (`0x31B60b11533c97b5ED7b1B650D31855F3754Acb4`) currently holds Admin, Backend signer, Settlement executor, Watchdog, and proxy-admin authorities on BSC Testnet. **Migration to a Gnosis Safe multisig is a pre-mainnet TODO** documented in `docs/admin-model.md`.

#### 5.1 Gnosis Safe compatibility

Every governance / treasury / pause role in the alpha set is implemented via either an `Ownable` check (`_checkOwner`) or a `SettingManagement.hasRole(...)` check against `msg.sender`. Both work transparently when `msg.sender` is a Gnosis Safe (which calls into the target contract as itself); none of these contracts reads `tx.origin` and none requires the caller to produce an ECDSA signature. The recommended deployment topology for mainnet is therefore:

| Tier | Holder | Roles |
|---|---|---|
| **Treasury Safe** (cold, ≥3-of-5 board) | Gnosis Safe | `SettingManagement` admin (`DEFAULT_ADMIN_ROLE`), every `ProxyAdmin.owner`, RUSD/FYUSD/FYP `owner`, RUSD/FYUSD `_minter` reassignment authority, `ReservePool` admin, fee receiver, custodian whitelist target. |
| **Ops Safe** (warm, ≥2-of-3 ops) | Gnosis Safe | Day-to-day pool-config tuning (`setPoolConfigs("vFyusdCooldown", ...)` etc.), trigger registration on `FypherCircuitBreaker`, REWARDER_ROLE in staking vaults. |
| **Hot EOAs** (HSM-backed, rotated) | EOA | Backend signer (EIP-712 quote signing), Settlement executor (`FyusdEpochSettlement.lockEpoch` / `settleEpoch`), Watchdog (`FypherCircuitBreaker.trip`). |

**Why some roles must stay EOA.** `FypherMinting`, `FypherBurnQueue`, and `FyusdEpochSettlement` all call `ECDSA.recover` on the off-chain quote — Gnosis Safe addresses do not produce ECDSA signatures (they use EIP-1271 contract-wallet signatures), so a Safe cannot occupy those slots without first introducing `SignatureChecker` support. That migration is tracked but is a non-goal for the alpha audit; the current design keeps the signing key in an HSM-backed EOA so the loss surface is the HSM, not a multisig that humans approve into.

The alpha contracts therefore impose **zero blockers** to a Safe-driven governance topology: all admin paths use plain `msg.sender` semantics, and the deployer can rotate every governance slot to the Treasury Safe in a single batch (see `docs/admin-model.md` for the rotation script).

---

## 6. Storage layout & upgradeability

Every major contract is deployed behind a `TransparentUpgradeableProxy`. The proxy admin is a separate contract (`ProxyAdmin` from OZ) owned by the deployer EOA today, scheduled to migrate to the multisig.

**Append-only storage**: every prior P0 patch (Apr 2026 audit) was deliberately authored to add new slots at the *end* of the existing storage layout — see `FypherMinting.sol` lines 50–55:

```
─ slot 15: pendingRedeems                  (April P0 — C-2)
─ slot 16: mintedPerAssetPerBlock          (April-audit M-7)
─ slot 17: redeemedPerAssetPerBlock        (April-audit M-7)
All pre-existing slots (0..14) are untouched.
```

The OZ Upgrades plugin's `unsafeAllow` flags are **not** used in production deploys (verified via the `bsc-testnet.json` registry under `sotatek-smart-contracts/.openzeppelin/`). Auditor should sanity-check the storage compatibility of any in-flight upgrade by running `npx hardhat run scripts/upgrade-{minting,fyusd}-impl.js --network bscTestnet` against a fresh proxy registry.

**Non-upgradeable by design**: `RUSDSilo`, `ReservePool`, `ConcreteAdapterV1`, `MockConcreteAdapter`, `MockERC20`, `PoolMath`. The silo is a minimal-trust escrow; ReservePool is a thin admin contract; the rest are libraries / mocks / stubs.

---

## 7. Prior audit findings (Apr 2026 P0 deep dive)

The most recent internal audit is documented in [`audit/2026-04-20-post-p0-deep-audit.md`](./audit/2026-04-20-post-p0-deep-audit.md). The P0 findings have all been patched in the current codebase; the contract source code has natspec annotations identifying each patch. Summary:

| Severity | ID | Finding | Patch location |
|---|---|---|---|
| **Critical** | C-2 | `cancelRedeem` could drain the contract balance (read from arbitrary storage instead of caller's escrow record) | `FypherMinting.cancelRedeem` — slot 15 `pendingRedeems` added; only refunds the caller's own escrow |
| **Critical** | C-3 | EIP-191 mint signatures could be replayed as redeem signatures (no `OrderType` field) | `FypherMinting` — full EIP-712 + `OrderType` discriminator |
| **Critical** | C-4 | `_distributeCollateral` did not validate custodian whitelist or ratio sum | `FypherMinting._distributeCollateral` — whitelist check + 10_000 bps sum check |
| **Critical** | (mintWETH) | `mintWETH` minted RUSD without transferring collateral | `FypherMinting.mintWETH` — `revert DeprecatedFunction()` |
| Medium | M-7 | No per-block per-asset rate limiting on mint or redeem | Slots 16, 17 added; `_checkRateLimit` invoked on both flows |
| Low | L-3 | Reserved-but-unused storage slots in `StakedIRUSD` (out of alpha scope; preserved in `backup/irusd/`) | Documented; not exploitable |
| Low | L-5 | `MinterUpdated` event missing on RUSD minter rotations | Added |
| Low | L-6 | `OwnerInitialized` event missing | Added |

The audit firm should focus on:

1. **Patches' completeness.** Did the C-3 typed-data migration cover every signature path? (Check `FypherBurnQueue` and `FyusdEpochSettlement`, which use a different signing scheme — EIP-191 — for legacy reasons.)
2. **Storage append-only.** Re-deploy the latest implementation against the existing testnet proxy and confirm OZ Upgrades plugin reports zero storage collisions.
3. **Edge cases on rate limits.** What happens at block.number == 0 during a fork? Does the per-block counter wrap correctly across asset additions?
4. **Cross-contract reentrancy.** `FypherMinting → custodian → ReservePool` (if a custodian ever points back at the protocol's own ReservePool) — confirm the custodian whitelist forbids this.
5. **The Concrete adapter stub.** `ConcreteAdapterV1` reverts everything today. The auditor should review the *interface* in `IConcreteAdapter` for completeness (totalAssets, shareOf, deposit, withdraw, realizedYield7d) and flag any missing function the eventual implementation will need.

---

## 8. Build & test instructions

### 8.1 Prerequisites

- Node.js 20.x (recommended; 18.x also works)
- npm 10.x

### 8.2 Compile

```bash
cd sotatek-smart-contracts
npm install
npx hardhat clean
npx hardhat compile
```

Expected output: `Compiled 55 Solidity files successfully (evm target: paris).`  
(55 includes OpenZeppelin transitive imports.)

### 8.3 Run tests

```bash
npx hardhat test                                # all 7 suites, ~84 tests
npx hardhat test test/FypherMinting.test.js     # one suite
npx hardhat test --grep "rate limit"            # by name
```

Tests run on the in-memory Hardhat network. There are no on-chain tests in CI — BSC Testnet is exercised by the deploy scripts and the backend smoke tests, not by Hardhat.

### 8.4 Test inventory

| Suite | Tests | Coverage focus |
|---|---|---|
| `FypherMinting.test.js` | 10 | EIP-712 typed data, OrderType discriminator, custodian routing, rate limits, mintWETH revert |
| `FypherBurnQueue.test.js` | 19 | Quote signing, 7-day delay, claim path, per-asset pause, emergency reverse |
| `FypherStakingHub.test.js` | 15 | Multi-pool emissions, weight changes, fundFpy behavior, migrate, per-pool pause |
| `FyusdEpochSettlement.test.js` | 18 | OPEN→LOCKED→SETTLED→DISTRIBUTED state machine, cancel path, claim accounting |
| `FyusdYieldVault.test.js` | 9 | Permit deposit, withdraw, vault pause, mock-adapter integration |
| `FypherCircuitBreaker.test.js` | 7 | Trigger registration, trip atomicity, reset gating, reasonHash plumbing |
| `Invariants.test.js` | 6 | (i) RUSD totalSupply ≤ collateral backing; (ii) pool.totalStaked == sum(user stakes) == underlying balance; (iii) epoch leftover == 0 after all claims; (iv) FPY emission conservation; (v) 7-day burn delay never bypassed; (vi) cooldown silo balance == sum of pending unstakes |

### 8.5 Deploy (reference)

The audit does not need to redeploy, but the scripts are listed here for completeness:

```bash
npx hardhat run scripts/deploy-sepolia.js       --network sepolia    # primary alpha target (post-2026-04-30)
npx hardhat run scripts/deploy-phase1.js        --network sepolia
node scripts/setup-custodian.js                 # configures custodian whitelist post-deploy
node scripts/bootstrap-fpy-treasury.js          # funds FypherStakingHub with FPY
```

Required env (`.env`):

```
PRIVATE_KEY=0x...                  # deployer EOA private key
BSCSCAN_API_KEY=...                # for verification
```

---

## 9. Deployed addresses (BSC Testnet, chainId 97)

The full registry is in [`sotatek-smart-contracts/deployed-addresses.json`](./sotatek-smart-contracts/deployed-addresses.json). The in-scope contracts are:

| Contract | Address |
|---|---|
| `SettingManagement` | `0x3DF5EafAd1E3979A0901dC3B24650eC745d1c9b2` |
| `RUSD` (proxy) | `0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5` |
| `FYUSD` (proxy) | `0x3b1f4CA20fCDf837d89b3606900a4e60C3fba6EE` |
| `FYP` (proxy) | `0x8Ac0e5C2B3670F78039A7Ea19C9a79Ef28c65a4C` |
| `FypherMinting` (proxy) | `0x0Cc3De38A1ff577f23d14a4714530FCc11b24690` |
| `FypherBurnQueue` (proxy) | `0xDb7a81FC773C9359d02ee1F1DD18F0e41063d2c4` |
| `ReservePool` | `0x9DDac07079537159765A6e083b1BB3A2fcFB84bB` |
| `StakedRUSD` (proxy) | `0xd7c0921c1a18BeBEE74F9E88BF1d035Ac77b1db6` |
| `RUSDSilo` | `0x78F42c44B94Af3692b5cD7105d50894B5da3Bc75` |
| `StakedAUSD` (stAUSD, proxy) | `0xa9401313d8DFe2FE302431A208DEFCde058E9D52` |
| `stAUSDSilo` | `0x5Df79Bd61f49a7D55E38bCAcfdFa1dCe309e63B7` |
| `StakedFYP` (proxy) | `0xb43404C7Dc934743BdbFd3821617d0add6eFeBcA` |
| `FYPSilo` | `0x5143e509911b3A9351D25dDf9d8724AFAe1E3511` |
| `FypherStakingHub` (proxy) | `0x6323bbD14C51F69a27D69D53626d8D7b37196F64` |
| `FyusdEpochSettlement` (proxy) | `0xbd372A8cd580e56Db4206ad932285AaD34c66F81` |
| `FyusdYieldVault` (proxy) | `0x21b71289F8FcA473590440507F2fE0F38301B0F2` |
| `FypherCircuitBreaker` (proxy) | `0x028Af7D4C8FA053810e6C6D9c75F5594Eb56c1D7` |
| `MockConcreteAdapter` (testnet only) | `0x8A1c84d41bBCD773A46d4D886c1929c54a317111` |

The mock collateral tokens (`USDT`, `USDC`, `WETH`, `BTC`, `BNB` at testnet addresses) are also in the registry but are deployment-only (anyone can `mint`); they are not in audit scope.

---

## 10. Reference materials

| Path | What it is |
|---|---|
| [`audit/2026-04-20-post-p0-deep-audit.md`](./audit/2026-04-20-post-p0-deep-audit.md) | Latest internal audit report (P0 deep dive, all findings patched) |
| [`docs/admin-model.md`](./docs/admin-model.md) | Privileged-role model + multisig migration plan |
| [`docs/decisions/`](./docs/decisions/) | Architecture decision records (ADR-001 through ADR-009) |
| [`docs/GAP_ANALYSIS.md`](./docs/GAP_ANALYSIS.md) | Spec ↔ implementation gap analysis from late-stage Phase 1 |
| [`sotatek-smart-contracts/contracts.md`](./sotatek-smart-contracts/contracts.md) | Deployed-address registry with BscScan links |
| [`sotatek-smart-contracts/flows.md`](./sotatek-smart-contracts/flows.md) | Sequence diagrams for each user flow |
| [`backup/README.md`](./backup/README.md) | Out-of-scope contract inventory |

---

## 11. Contact

Questions during the audit can be directed to the deploy-key owner (Fypher core engineering). For on-chain references, the BSC Testnet explorer is the source of truth — every in-scope contract is verified on BscScan.
