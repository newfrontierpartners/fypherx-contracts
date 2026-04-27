# ADR-008: Per-asset / per-pool pause flags (option B)

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §5, §6
- Resolves: GAP_ANALYSIS Q8

## Context

Spec §5 monitoring table calls for "ETH oracle 편차 > 1% → Mint pause" — implies ability to pause one mint asset (ETH) without affecting others. Spec §6 says "각 상품 독립적으로 pause 가능". User selected the finer-grained option B over the simpler 4-flag option A.

## Decision

Pause state is broken down to asset / pool granularity.

### `FypherMinting`

```solidity
mapping(address => bool) public mintPaused;   // key = collateral asset
mapping(address => bool) public burnPaused;   // key = collateral asset
modifier whenMintAllowed(address asset)  { if (mintPaused[asset])  revert MintPausedForAsset(); _; }
modifier whenBurnAllowed(address asset)  { if (burnPaused[asset])  revert BurnPausedForAsset(); _; }
```

Removes legacy `mintRedeemDisabled` (boolean) — replaced by per-asset mappings. A `pauseAll()` admin convenience iterates supported assets.

### `FypherStakingHub`

`Pool` struct already has `bool paused`. Modifiers gate `stake(poolId)` and `unstake(poolId)` on `pools[poolId].paused`.

### `FyusdYieldVault` (Concrete entry)

Single `bool vaultPaused` — Concrete adapter is one entry point per network.

### `FyusdEpochSettlement`

`bool depositPaused` (gates new epoch deposits) + `bool settlementPaused` (gates Bitgo call). Two separate flags so we can stop deposits but still settle in-flight epochs.

### Authorization

- **Pause** (turn on): callable by `PAUSER_ROLE` (single EOA per ADR-007) **or** multisig.
- **Unpause** (turn off): multisig quorum only — never PAUSER_ROLE alone.

Asymmetric: latency-critical, fail-safe defaults toward "stop".

### Total flag count

| Surface | Flags |
|---|---|
| Mint per asset (USDT, USDC, WETH initially) | 3 |
| Burn per asset (same 3) | 3 |
| Stake per pool (RUSD, FYUSD initially) | 2 |
| Vault | 1 |
| Epoch deposit | 1 |
| Epoch settlement | 1 |
| **Total** | **11** |

## Consequences

- Admin dashboard `/admin/pause` page shows an 11-row toggle grid.
- Each toggle emits a `Paused(scope, asset/poolId, on)` event → audit ledger.
- Backend `application.yml` adds `fypherx.defi.pause.{mint,burn,stake,vault,epoch}` for client-side UI gating (optimization; on-chain truth wins).
- Circuit breaker logic (oracle deviation → auto-pause) targets specific `mintPaused[ETH]` rather than full mint stop — fewer false-positive halts.
- Operator runbook documents which asset/pool must be paused for each spec §5 alert.
