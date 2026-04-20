# FypherX Deep Audit — post-P0 — `main @ 6507c2c`

**Date:** 2026-04-20
**Repo:** `fypherx-contracts` (canonical) — `main` after P0 PR #1 + #2 merge
**Scope:** Mint/Burn, Staking, Perps, Auth/Setting/Cross-cutting
**Out-of-scope (not yet in canonical main):** lending/borrowing, swap (PancakeSwap LP custodians), Phase-3 Merkle distributor

This report consolidates four parallel domain audits, **independently verified against canonical source**, and elevates one finding above the original auditor's severity (Staking C-1, see §3).

---

## 0. Executive ranking

| ID | Severity | Domain | One-line | Source-verified |
|----|----------|--------|----------|:---:|
| **C-1** | **CRITICAL** | Staking | `totalAssets` math is inverted in StakedRUSD — adds vested rewards to a balance that already contains them (double count → eventual insolvency on redeem). | ✅ |
| **C-2** | **CRITICAL** | Staking | StakedFYP / StakedAUSD / StakedIRUSD: `transferInRewards` instantly recognizes the full reward in `totalAssets` (no vesting at all), enabling deposit-sandwich on every reward distribution. | ✅ |
| **C-3** | **CRITICAL** | Auth | `setSettingManager()` is a 1-tx unprotected registry swap on every staking vault — a single admin compromise instantly cascades to all 4 vaults + FypherMinting. | ✅ |
| **H-1** | HIGH | Mint/Burn | `requestRedeem` does not mark the nonce in `_usedNonces`. A backend MINT signed at the same `(benefactor, nonce)` permanently blocks `executeRedeem`; user must self-rescue via `cancelRedeem`. | ✅ |
| **H-2** | HIGH | Auth | `StakedRUSD.initialize(admin_)` accepts but **silently drops** the `admin_` parameter. Vault has no admin until SettingManagement explicitly grants `bytes32(0)` to a key. Same shape for StakedIRUSD/FYP/AUSD. | ✅ |
| **H-3** | HIGH | Auth | `SingleAdminAccessControl.renounceRole(role, msg.sender)` is unguarded; if a critical role (e.g. `RELEASE_TOKEN_ROLE`, sole `REWARDER_ROLE`) is held by a single key, that key can permanently brick the function. Also: `_roleAdmin` is stored, exposed via `getRoleAdmin`, but **never written** — pure foot-gun for OZ-pattern integrators. | ✅ |
| **H-4** | HIGH | Perps | `FypherPerpsClearinghouse.liquidate()` writes losses into `collateralBalanceE18` (an `int256` that goes arbitrarily negative) with **no insurance-fund call, no cap, no notification**. The vault and clearinghouse are entirely decoupled. Cascading bad debt is unbounded and silent. | ✅ |
| **H-5** | HIGH | Perps | `FypherXSettlement.settleTrade()` accepts arbitrary `(price, qty, fees)` from the relayer with **no maker/taker signature verification, no order hash, no nonce binding**. Backend signer is the only line of defense. | ✅ |
| **M-1** | MEDIUM | Staking | Cooldown double-spend: a second `cooldownAssets` overwrites the prior `cooldowns[user]` entry while the silo still holds the first amount → user's first cooldown is stranded. (All 4 vaults.) | ✅ |
| **M-2** | MEDIUM | Staking | Pause is deposit/withdraw/redeem only — `cooldownAssets`, `cooldownShares`, `unstake`, `earlyUnstake` are **not** gated. A paused vault still leaks assets through cooldown. (All 4 vaults.) | ✅ |
| **M-3** | MEDIUM | Staking | `notRestricted(receiver)` is enforced on `deposit` only on **StakedRUSD**; StakedFYP/AUSD have no such guard, and **no vault** guards `withdraw/redeem/transfer/cooldown`. A restricted address can exit freely once it holds shares. | ✅ |
| **M-4** | MEDIUM | Staking | `userStakedAmount` is incremented on deposit but never decremented anywhere. If a downstream system (UI, reward calculator, future contract) relies on this scalar it will diverge from reality after the first withdrawal. | ✅ |
| **M-5** | MEDIUM | Mint/Burn | `executeRedeem` silently no-ops the collateral transfer when `supportedAssets[order.collateral_asset] == false`. Nonce is consumed and escrow is deleted regardless → user loses the RUSD escrow with no collateral payout if admin removed the asset between request and execution. | ✅ |
| **M-6** | MEDIUM | Mint/Burn | `stablesDeltaLimit` storage + `setStablesDeltaLimit()` setter + `StablesDeltaExceeded` error all exist but **nothing reads them** — declared risk control is unenforced. | ✅ |
| **M-7** | Mint/Burn | LOW | Per-asset `maxMintPerBlock[asset]` / `maxRedeemPerBlock[asset]` mappings + setters exist but neither `_checkMintLimit` nor `_checkRedeemLimit` reads them — only the global limits apply. | ✅ |
| **M-8** | MEDIUM | Auth | All four staking vaults' `initialize()` lack zero-address checks on `_rusd/_irusd/_fyp/_fyusd`, `_settingManagement`, `_silo`. FypherMinting (post-P0) does have these. | ✅ |
| **M-9** | MEDIUM | Perps | `FypherXInsuranceFundVault` accepts ETH (`receive() payable`) and pays ETH (`call{value:}`), but the clearinghouse uses ERC-20 collateral. Insurance fund cannot pay clearinghouse bad debt in the same denomination — pure decorative contract today. | ✅ |
| **M-10** | MEDIUM | Perps | `FypherOracleRouter.getPriceE18` reverts on stale price with no fallback feed and no pause flag in the clearinghouse. One feed outage halts trading and liquidations simultaneously. | ✅ |
| **L-1** | LOW | Staking | `_unvestedAmount()` function name implies "amount not yet vested" but its body returns the **vested** amount via `PoolMath.calculateVestedAmount`. (Independent of C-1: even if you fix the math, the name still misleads.) | ✅ |
| **L-2** | LOW | Staking | `MIN_SHARES = 1` constant in StakedRUSD is unused. ERC4626Upgradeable's default `_decimalsOffset() == 0` leaves the first-depositor inflation surface open. | ✅ |
| **L-3** | LOW | Staking | `unstakeRequests` mapping declared in StakedRUSD/StakedIRUSD, never read or written → dead state slot. | ✅ |
| **L-4** | LOW | Auth | Cooldown struct uses `uint152 underlyingAmount` and `uint104 cooldownEnd`. Casting `uint256` → `uint152` truncates silently above ~5.7e45 wei. Bound is in practice unreachable but is a code smell with no `require`. | ✅ |
| **L-5** | LOW | Mint/Burn | `FYUSD.setMinter()` does not emit `MinterUpdated` (RUSD does). Minor observability gap. | needs source verification — out of P0 scope |
| **L-6** | LOW | Auth | `InstitutionalRUSD.initialize` emits no event. Minor audit-trail gap. | needs source verification |
| **L-7** | LOW | Perps | Weighted-average entry price in `_addToPosition` truncates down with int division → ~0.01% per-trade bias in trader's favor on long add-ins. Not exploitable; cosmetic. | ✅ |
| **I-1** | INFO | Auth | `WHITELISTED_STAKER_ROLE`, `RETAIL_ROLE`, `MINTER_ROLE`, `BURNER_ROLE`, `TRANSFER_FEE_ROLE`, `ADMIN_ROLE` constants are defined in `SingleAdminAccessControl` but never checked anywhere → confusing surface for governance reviewers. | ✅ |
| **I-2** | INFO | Cross | Perps subsystem (`FypherPerpsClearinghouse` / `Settlement` / `InsuranceFundVault` / `OracleRouter`) uses bare `owner` pattern, **not** `SettingManagement`. Two parallel admin hierarchies with no coordination. Document or unify. | ✅ |

---

## 1. Verification status

Every finding above marked ✅ has been independently re-verified by reading the canonical source at HEAD `6507c2c`. The two `needs source verification` entries (L-5, L-6) come from the auditor's claim alone and were not the focus of this re-check; severity is bounded at LOW so they are non-blocking.

P0 patches (C-1…C-5 + `mintWETH` deprecation) all verified PASS by the mint/burn auditor against `FypherMinting.sol` and `StakedRUSD.sol`.

---

## 2. Domains the audit could **not** cover (gap report)

The user's prompt explicitly mentioned `swap`, `lending/borrowing` alongside the three covered domains. These are **not present** in canonical `main` today:

| Domain | Status in canonical main | Notes |
|---|---|---|
| Mint / Burn | ✅ Present, audited | `FypherMinting`, `RUSD`, `FYUSD`, `FYP`, `InstitutionalRUSD` |
| Staking | ✅ Present, audited | `StakedRUSD`, `StakedFYP`, `StakedAUSD`, `StakedIRUSD`, silos, `ReservePool` |
| Perps | ✅ Present, audited | `FypherPerpsClearinghouse`, `FypherXSettlement`, `FypherXInsuranceFundVault`, `FypherOracleRouter` |
| Lending / Borrowing | ❌ Not present | All work (oracle V2, IRM, lending market, factory, timelock, insurance V2, tests) currently lives only in the wrong-repo branches under `newfrontierpartners/smart-contracts`. Migration deferred per prior session. |
| Swap (LP custodians, PancakeSwap V2) | ❌ Not present | Same — wrong-repo only. Migration deferred. |
| Phase-3 Merkle distributor | ❌ Not present | Same. |

**Conclusion:** I cannot certify swap or lending here. They have to be migrated to canonical `main` first, then audited as a follow-on. I called this out explicitly so the user is not under the impression those domains were silently cleared.

---

## 3. The promoted finding — why C-1 is actually critical

The original staking audit flagged **S-1** as a HIGH-severity *naming* problem (function `_unvestedAmount()` returns the vested portion). On verification, the underlying *math* is wrong, not just the name.

### Code as-shipped (`StakedRUSD.sol:109-120`)

```solidity
function totalAssets() public view override returns (uint256) {
    return IERC20(asset()).balanceOf(address(this)) + _unvestedAmount();
}

function _unvestedAmount() internal view returns (uint256) {
    if (vestingAmount == 0) return 0;
    return PoolMath.calculateVestedAmount(
        vestingAmount,
        _lastDistributionTimestamp,
        VESTING_PERIOD
    );
}
```

### What `PoolMath.calculateVestedAmount` actually returns (`PoolMath.sol:34-44`)

```solidity
function calculateVestedAmount(uint256 totalAmount, uint256 vestingStart, uint256 vestingPeriod)
    internal view returns (uint256)
{
    if (block.timestamp >= vestingStart + vestingPeriod) {
        return totalAmount;                              // == fully vested
    }
    uint256 elapsed = block.timestamp - vestingStart;
    return (totalAmount * elapsed) / vestingPeriod;      // linear ramp 0 → totalAmount
}
```

It returns **the amount already vested** (linear 0 → `totalAmount` over `period`).

### What `transferInRewards` does (`StakedRUSD.sol:216-222`)

```solidity
IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);  // → balance += amount
vestingAmount += amount;                                                // → vestingAmount += amount
_lastDistributionTimestamp = block.timestamp;
```

The reward is **already in `balance`** the moment this returns.

### Walkthrough (1000 staked, 100 reward, period = 8h)

| t       | balance | vestingAmount | calculateVestedAmount | totalAssets (current code) | totalAssets (Ethena-correct) |
|---------|---------|----------------|------------------------|----------------------------|------------------------------|
| 0⁻      | 1000    | 0              | 0                      | 1000                       | 1000                         |
| 0⁺      | 1100    | 100            | 0                      | **1100** (jumps +100)      | 1000 (rewards locked)        |
| 4 h     | 1100    | 100            | 50                     | **1150**                   | 1050                         |
| 8 h     | 1100    | 100            | 100                    | **1200**                   | 1100                         |
| 8 h + ε | 1100    | 100            | 100                    | **1200** (forever)         | 1100                         |

The contract permanently advertises `totalAssets = balance + vestingAmount` after vesting completes (because `vestingAmount` is never decremented and `calculateVestedAmount` saturates at the full amount).

### Solvency consequence

`previewRedeem(1000 shares)` at t = 8h returns `1000 * 1200 / 1000 = 1200` RUSD. The vault holds 1100 RUSD. The first redeemer succeeds (gets 1200 in expectation, but only 1100 is on hand → `safeTransfer` reverts), or under share-rounding the last few redeemers cannot exit at all. The over-statement equals the cumulative `vestingAmount` and grows monotonically with every `transferInRewards` call.

### Reference shape (Ethena's sUSDe pattern, for comparison)

```solidity
function totalAssets() public view returns (uint256) {
    return _asset.balanceOf(address(this)) - getUnvestedAmount();
    //                                       ↑ subtract the LOCKED portion
}
function getUnvestedAmount() public view returns (uint256) {
    uint256 timeSinceLastDistribution = block.timestamp - lastDistributionTimestamp;
    if (timeSinceLastDistribution >= VESTING_PERIOD) return 0;
    return ((VESTING_PERIOD - timeSinceLastDistribution) * vestingAmount) / VESTING_PERIOD;
}
```

i.e. *subtract the still-locked portion*, not *add the released portion*. Either:
1. Rename `_unvestedAmount` and flip to subtraction, **or**
2. Reset `vestingAmount` to 0 each round and treat it as a per-round counter (incompatible with current append behavior).

Option 1 is the Ethena-faithful fix and is the smallest change. C-1's patch is the math flip + decrement-on-vest-complete OR an `unvested()` helper that returns `vestingAmount - vestedSoFar`.

---

## 4. The other promoted angle — why C-2 is paired with C-1

`StakedFYP / StakedAUSD / StakedIRUSD` use the *same* `vestingAmount` storage and `transferInRewards` shape, but their `totalAssets` is bare:

```solidity
// StakedFYP.sol:85-87, StakedAUSD.sol:88-90, StakedIRUSD.sol:95-97
function totalAssets() public view override returns (uint256) {
    return IERC20(asset()).balanceOf(address(this));   // ← no vesting term at all
}
```

So the reward is **fully recognized the instant `transferInRewards` returns**. Concretely:

| t  | balance | totalAssets | Share price | Comment |
|----|---------|-------------|-------------|---------|
| 0⁻ | 1000    | 1000        | 1.000       |         |
| 0⁺ | 1100    | 1100        | **1.100**   | +10 % step in one block |

Anyone watching mempool for `transferInRewards` can sandwich:
1. `deposit(N)` in the same block, immediately before the rewarder tx
2. let the rewarder tx land
3. `cooldownShares(myShares)` next block, then `unstake` after the cooldown window

The sandwich captures the entire reward proportionally even though the depositor was not staked when the protocol earned it. Because `REWARDER_ROLE` holders are typically known/operationally-scheduled, this is a *predictable* MEV path, not a probabilistic one.

C-2's patch is to copy StakedRUSD's vesting calculation **after** C-1 is corrected (i.e., the corrected version of it) into the other three vaults.

---

## 5. Recommended PR plan

PRs are grouped to keep diffs small, review easy, and the storage layout safe under TransparentProxy. Each PR is independently mergeable.

### **PR-A: Fix staking-vault solvency (C-1 + C-2 + L-1)**

> "Correct ERC4626 totalAssets to subtract the still-vesting portion (Ethena-style); apply across all four vaults; rename helper to `_unvestedAmount` faithfully."

- `StakedRUSD.sol`: replace `balance + _unvestedAmount` with `balance - _unvestedAmount`, where the helper now returns `vestingAmount - calculateVestedAmount(...)` (the *locked* portion), saturating at 0.
- `StakedFYP/AUSD/IRUSD.sol`: add the same `totalAssets` override with the same helper.
- Optional but recommended: also reset `vestingAmount = 0` and replay only the most recent cohort, OR subtract the previously-vested amount from `vestingAmount` in `transferInRewards` to keep the "locked" interpretation consistent across distributions.
- Storage layout: append-only — only adds a private function; no slot collision.
- New test cases:
  - reward distribution + redeem at t=0/4h/8h → assets-out matches expected schedule
  - second `transferInRewards` mid-vest → no crash, share price stays monotone
  - 1000 fuzz trades with random rewarder schedule → no totalAssets > balance invariant break

### **PR-B: Fix admin-cascade & registry-swap blast radius (C-3 + H-2 + H-3 + M-8)**

> "Make admin transitions explicit, recoverable, and bounded."

- `StakedRUSD/IRUSD/FYP/AUSD`: add a 2-day timelock buffer to `setSettingManager` (request → cooldown → accept). Use the existing two-step admin pattern in `SingleAdminAccessControl` as the design template.
- `StakedRUSD/IRUSD`: make `admin_` actually do something. Either remove from the signature *or* call `settingManagement.grantRole(bytes32(0), admin_)` if the SettingManagement design allows it. Document the chosen path.
- `SingleAdminAccessControl.renounceRole`: add `require(msg.sender == _admin || role != bytes32(0))` and consider blocking renounce for an enumerated set of "critical" roles (REWARDER, RELEASE_TOKEN). Either delete `_roleAdmin` and `getRoleAdmin` or implement the full hierarchy.
- All four vault `initialize()`s: add zero-address `require`s on the constructor parameters.
- Storage layout: append-only (only adds an `address public pendingSettingManagement` + `uint256 public pendingSettingManagerEta` per vault, plus an event).

### **PR-C: Fix mint/burn nonce + escrow corner cases (H-1 + M-5 + M-6 + M-7)**

> "Make redeem nonces, asset removal, and stablesDeltaLimit do what their names say."

- `requestRedeem`: set `_usedNonces[msg.sender][nonce] = true` *or* introduce a separate `_redeemNonces` namespace. Decide once and document.
- `executeRedeem`: replace the `if (supportedAssets[...])` skip with `revert UnsupportedAsset()`. The escrow is the contract's promise to the user that *something* will happen — silent loss is not "something."
- Implement `stablesDeltaLimit` enforcement in `mint` and `executeRedeem`, OR delete the storage / setter / error to reduce surface.
- Either implement per-asset rate limits or remove the `maxMintPerBlock[asset]` / `maxRedeemPerBlock[asset]` setters.
- Storage layout: append-only.

### **PR-D: Plug staking exit & restriction holes (M-1 + M-2 + M-3 + M-4 + L-3 + L-4)**

> "Tighten the cooldown/exit/transfer surface to match the deposit surface."

- All vaults: in `cooldownAssets/cooldownShares`, revert if `cooldowns[msg.sender].underlyingAmount != 0` (forces explicit `unstake` first).
- All vaults: gate `cooldownAssets/cooldownShares/unstake/earlyUnstake` with `whenNotPaused` *or* explicitly document the soft-pause design in code.
- StakedFYP/AUSD: add `notRestricted(receiver)` to `deposit`, matching StakedRUSD.
- All vaults: extend `notRestricted` to `withdraw/redeem/_update` (transfer) for `from` and `to`. (Be careful: this changes ERC-20 transferability semantics for restricted addresses. Required if the restriction is for compliance.)
- `_update`: optionally bound the pause/restriction.
- Decide on `userStakedAmount`: either decrement on `_withdraw` or rename + comment as "lifetime gross deposits" and document non-decrement.
- Delete `unstakeRequests` mapping (storage append-only on the *opposite* end is impossible — leaving the slot in place but unused is the safe path under proxy upgrades).
- Bound check on cooldown casts: `require(assets <= type(uint152).max)` etc.

### **PR-E: Make perps risk-aware (H-4 + H-5 + M-9 + M-10)**

> "The perps stack does not currently know losses can exceed the insurance vault's balance. Fix that."

- `FypherPerpsClearinghouse`:
  - Add `address public insuranceFundVault; address public insuranceCollateralToken;` immutable.
  - In `liquidate()`, after computing `realizedPnlE18`, if `realizedPnlE18 < 0` AND `collateralBalanceE18[account] + realizedPnlE18 < 0`, call `IInsuranceFund(insuranceFundVault).cover(account, abs(shortfall))` and revert if the insurance fund cannot cover (or sweep collateral into a `socializedLossE18` sink and emit).
  - Add a `paused` flag for circuit-breaker on oracle outage.
  - Add a non-zero, capped `liquidationRewardBps` paid to the liquidator out of the *insurance fund*, not the trader (the trader's collateral is already gone).
- `FypherXSettlement.settleTrade`:
  - Require an EIP-712 signature from a single configurable `tradeSigner` over the full `(tradeId, marketId, makerSubaccountId, takerSubaccountId, priceE18, quantityE18, makerFeeE18, takerFeeE18)` tuple.
  - Reject zero `tradeId`. Already deduped by `settledTrades[tradeId]`.
- `FypherXInsuranceFundVault`:
  - Switch from ETH (`receive() payable` + `call{value:}`) to ERC-20 of the same token as the perps clearinghouse collateral.
  - Add `nonReentrant` on `withdraw` for defense-in-depth (currently a non-issue because state changes after the call are absent, but cheap insurance).
- `FypherOracleRouter`:
  - Add a fallback feed array per market so a single revert does not halt the protocol.
  - Or, if multi-feed is too much surface, pair with the clearinghouse `paused` so an oracle outage degrades to "no new trades, no new liquidations" rather than full revert storm.

### **PR-F (low-priority cleanup): I-1 + I-2 + L-2 + L-5 + L-6 + L-7**

> "Documentation, dead code, and observability."

- Remove unused role constants in `SingleAdminAccessControl`.
- Add `_decimalsOffset()` override returning e.g. `1e6` to all four vaults to neutralize the first-depositor inflation surface (L-2). Note: this changes share-decimal accounting; needs a migration plan if the vaults already have stake.
- Add `MinterUpdated` event to `FYUSD.setMinter` (L-5) — verify against source first.
- Add init event to `InstitutionalRUSD.initialize` (L-6).
- Switch `_addToPosition` weighted-average to a rounding-up helper or document the bias (L-7).
- Add a top-level `OWNERSHIP.md` or `docs/admin-model.md` explaining the dual perps-vs-staking admin hierarchies (I-2).

---

## 6. Operational findings (independent of patches)

- **No dual-control on any admin path today.** All `onlyAdmin` (staking) and `onlyOwner` (perps) calls accept a single signature. A multisig (3-of-5 minimum) for both `_admin` in SettingManagement and `owner` in each perps contract is the cheapest single risk reduction available.
- **Pause coverage is inconsistent.** Staking vaults have a soft pause (deposit-only). FypherMinting has `mintRedeemDisabled` covering both flows. Perps clearinghouse has no pause at all. Recommend adding a uniform `paused` flag with consistent semantics across all three.
- **No event monitoring contract today.** `setSettingManager`, `setBackendSigner`, `setBackendExecutor`, `transferAdmin`/`acceptAdmin`, `setMinter`, `grantRole`/`revokeRole`/`renounceRole` should be alarmed in 24/7 monitoring with a paged response. They are the weaponizable knobs.
- **Reward distribution is a known MEV target** (see C-2 analysis). Until C-2 is patched, recommend distributing rewards via `flashbots`-equivalent private mempool on BSC, and rotating distribution times.
- **Insurance-fund accounting today is decorative.** No on-chain accounting links clearinghouse losses to vault balance. Off-chain dashboards must reconcile the two, and operators must manually top up. This is fine short-term; it is *not* fine if perps go to mainnet without H-4 fixed.
- **Lending and swap subsystems** still live in the wrong-repo branches and are not in canonical `main`. Until they are migrated, no audit can certify them.

---

## 7. Suggested merge order

1. **PR-A (Staking solvency, C-1 + C-2)** — solvency-affecting, ship first.
2. **PR-B (Admin cascade, C-3 + H-2 + H-3 + M-8)** — defense-in-depth for everything else.
3. **PR-C (Mint/Burn corner cases, H-1 + M-5 + M-6 + M-7)** — closes the redeem-escrow holes opened by P0.
4. **PR-E (Perps risk-aware, H-4 + H-5 + M-9 + M-10)** — gates perps for any near-mainnet move.
5. **PR-D (Staking exit holes, M-1..M-4 + L-3 + L-4)** — quality-of-life and compliance.
6. **PR-F (cleanup, lows + infos)** — non-blocking.

---

## 8. Verification commands (for reviewer follow-up)

```sh
# C-1 / C-2: confirm vesting math
grep -n "totalAssets\|_unvestedAmount\|calculateVestedAmount" \
  sotatek-smart-contracts/contracts/Fypher/Staked*.sol \
  sotatek-smart-contracts/contracts/libraries/PoolMath.sol

# C-3 / H-2: confirm setSettingManager + initialize ignored param
grep -n "setSettingManager\|admin_" \
  sotatek-smart-contracts/contracts/Fypher/Staked*.sol

# H-1: confirm requestRedeem nonce omission
grep -n "_usedNonces\|requestRedeem\|cancelRedeem" \
  sotatek-smart-contracts/contracts/Fypher/FypherMinting.sol

# H-3: confirm renounceRole + _roleAdmin
grep -n "renounceRole\|_roleAdmin" \
  sotatek-smart-contracts/contracts/Fypher/SingleAdminAccessControl.sol

# H-4 / H-5: perps liquidation + settlement signature
grep -n "liquidate\|insuranceFund\|signature\|recover" \
  contracts/src/FypherPerpsClearinghouse.sol \
  contracts/src/FypherXSettlement.sol \
  contracts/src/FypherXInsuranceFundVault.sol
```
