# ADR-011: FYUSD redemption — Phase-2 path selection

- Status: Proposed
- Date: 2026-05-08
- Resolves: fypherx-frontend `docs/alpha-launch-flows-coverage.md` §7 ("FYUSD redemption to USDT/USDC")
- Trap report: fypherx-frontend PR #158 (FYUSD "Burn" trap)
- Related: ADR-005 (Bitgo Prime mint), ADR-001 (RUSD burn-queue), ADR-006 (Concrete adapter)

## Context

Alpha shipped without a FYUSD → stablecoin redemption path. RUSD has
the 7-day `FypherBurnQueue` exit; FYUSD has nothing. Both
`swapTokens('FYUSD','RUSD')` and direct `burnFyusd` revert
`unsupported(...)` in the live-contract adapter today (see
`fypherx-frontend/src/lib/defi/adapters/liveContractAdapter.ts` §"FYUSD
mint / burn (NOT user-callable on-chain today)").

The frontend's `WithdrawFunnel` previously masked the gap: clicking
**Burn** on a FYUSD wallet row started a `swap('FYUSD','RUSD')` stage
that silently hung in pending forever (no on-chain tx, no settle
event). #158 removed the trap by deleting the primary Burn action on
the FYUSD row. Users now have **no exit path from FYUSD** — they can
stake / vault FYUSD, but they can't unwind it back to USDT/USDC.

This ADR picks the Phase-2 mechanism. Two viable paths, one
recommendation.

## Constraints

1. **FYUSD supply integrity**. FYUSD is minted only by
   `FyusdEpochSettlement` (collateral landed at Bitgo Prime).
   Any redemption path must extinguish FYUSD on the same backing
   (don't leak supply, don't double-pay collateral).
2. **No spot AMM on Sepolia / mainnet alpha**. Pancake/Uniswap on
   mainnet would let `FYUSD → USDC` swap exist — but the alpha LP
   stack is in `backup/lp/` (deferred per `backup/README.md` §lp).
   Building it back out for redemption alone is over-scope.
3. **Bitgo Prime integration already exists**. The mint-side flow
   already drives Bitgo: backend `requestMint` → operator confirms
   → `settleEpoch`. A symmetric redeem-side flow can reuse
   `BitgoClient` with a `requestRedeem` method.
4. **Cooldown is acceptable**. RUSD burn already imposes 7d. Users
   redeeming FYUSD can be told this is not an instant exit; the UX
   gate already exists.

## Path A — Bitgo off-ramp (mirror the mint flow)

Mirror `FyusdEpochSettlement`'s mint mechanic in reverse.

### Mechanism

1. User calls `FyusdEpochRedemption.requestRedeem(fyusdAmount, targetAsset)`
   on a new contract. The contract:
   - pulls `fyusdAmount` from the user via `transferFrom`,
   - burns it via `FYUSD.burn(...)` (FYUSD already inherits
     `ERC20BurnableUpgradeable`),
   - mints a redemption ticket with `claimableAt = now + N hours`.
2. Backend operator (manual or via daemon) reads pending tickets,
   instructs Bitgo Prime to wire the equivalent USDT/USDC out of the
   custodial wallet.
3. Once Bitgo confirms, operator calls
   `FyusdEpochRedemption.settleRedemption(ticketId, txRef)` on-chain;
   the user's ticket flips to `CLAIMABLE`.
4. User calls `claim(ticketId)` — collateral lands in their wallet.

### Pros

- **Closes the loop with the same custody model.** Mint side already
  trusts Bitgo Prime; redeem reuses the same custodian, audit ledger
  entries, alerting story.
- **Reuses ADR-005 plumbing.** `BitgoClient` interface gains
  `requestRedeem(orderId, amount, asset)` symmetric to `requestMint`.
  Mock + real implementations stay in lockstep.
- **No AMM dependency.** Works on Sepolia + mainnet without a
  Pancake/Uniswap pool.
- **Capital-efficient.** Doesn't need an on-chain liquidity buffer;
  Bitgo holds the collateral the FYUSD was originally minted against.
- **Mirrors the user's mental model.** "Get-FYUSD takes 12h via
  epoch" → "Redeem-FYUSD takes M hours via epoch". Symmetry is
  teachable.

### Cons

- **Bitgo SLA dependence.** A redemption SLA breach is the same
  failure mode the mint side handles via `cancelEpoch`. Need the
  equivalent escape hatch (`cancelRedemption`) + an admin-only
  emergency exit.
- **Manual operator load.** Each redemption requires the operator to
  wire collateral out of Bitgo. Per-cohort batching (like the mint
  side aggregates per-epoch) keeps this bounded but it's
  ops-intensive at low volume.
- **One more state machine.** New contract + lifecycle table +
  scheduler + admin dashboard tab. ~40% of the engineering effort
  the mint side took.

## Path B — On-chain FYUSD ↔ RUSD swap (then RUSD burn)

Add a peg-keeping AMM-lite contract (or a dedicated stableswap pool)
that lets users convert FYUSD ↔ RUSD on-chain. Combined with the
existing 7d RUSD burn-queue this gives FYUSD users a 7-day exit
without standing up the Bitgo redeem side.

### Mechanism

1. Deploy `FyusdRusdPeg.sol` (single-pair stableswap or
   constant-product with peg-corrected curve).
2. Seed it with FYUSD + RUSD reserves from protocol treasury (Treasury
   Safe per Safe topology in `audit/README.md` §5.1).
3. User exits via WithdrawFunnel: `swap(FYUSD → RUSD)` →
   `requestBurn(RUSD → USDT/USDC)`. WithdrawFunnel already implements
   this two-stage flow (`src/features/.../WithdrawFunnel.tsx` line
   ~115); the only blocker is the missing on-chain swap target.

### Pros

- **No Bitgo redeem-side build-out.** Uses the existing RUSD
  burn-queue as the off-ramp — already audited, already in production.
- **Composable.** Other protocols can integrate the FYUSD/RUSD
  pool the moment it's deployed. Better DEX listing story.
- **Front-end unblocked instantly.** WithdrawFunnel's existing
  two-stage path lights up; no new screens.
- **Operator-light.** No per-redemption manual step. AMM matches
  bids automatically.

### Cons

- **Peg sustainability requires liquidity.** The protocol must
  continuously provide enough FYUSD + RUSD reserves to keep the
  swap rate inside the peg band. Cheap to start, expensive to
  maintain across a market drawdown — drained reserves break
  redemption silently.
- **New contract in scope for audit.** Stableswap math is
  non-trivial; the curve choice affects slippage + LP economics.
  Adding it to the alpha audit blew out the original "no LP /
  no lending" scope decision.
- **Mismatched custody trust model.** FYUSD is backed by Bitgo
  collateral; the AMM redemption pulls from on-chain treasury, not
  the custodian. A run on the AMM doesn't touch Bitgo, which means
  the protocol can run out of redemption capacity even though the
  custodian still has the underlying. This is the failure mode
  Terra-class stables repeatedly hit.
- **Treasury capital lockup.** Reserves can't earn yield while
  parked in the AMM (ignoring concentrated-liquidity tricks that
  add their own surface area).

## Decision (recommended)

**Adopt Path A — Bitgo off-ramp**, with the same interface-first
posture ADR-005 took for the mint side.

The deciding factor is **custody trust-model alignment**. FYUSD is a
Bitgo-collateralised stable; its redemption must redeem against that
same collateral. Path B's AMM is a parallel reserve that can dry up
even when the custodian has full backing — that's the regulatory and
narrative failure mode the protocol is most exposed to. Path A
closes the loop with the same custodian on both sides.

The cost — a second epoch-style state machine — is contained:

- Reuses `BitgoClient` interface (extend by one method).
- Reuses `EpochLifecycleEntity` shape (add a `direction` discriminator).
- Reuses the operator dashboard pattern (mirror
  `/admin/fyusd-epochs` → `/admin/fyusd-redemptions`).

Path B remains a viable Phase-3 add-on once treasury has surplus
liquidity to allocate. Adding an AMM later doesn't conflict with the
Bitgo off-ramp — they operate side-by-side and offer users different
trade-offs (AMM = instant + slippage cost; Bitgo = N-hour wait + no
slippage).

## Implementation sketch (Path A)

### 1. Contracts (fypherx-contracts)

New `Fypher/FyusdEpochRedemption.sol` — symmetric to
`FyusdEpochSettlement`. State machine:

```
OPEN → LOCKED → SETTLED → DISTRIBUTED
                      ↓
                  CANCELLED
```

Storage:
- `mapping(uint256 => RedemptionEpoch) epochs`
- `RedemptionEpoch { uint8 status; uint256 totalFyusdBurned;
  mapping(address => uint256) requested;
  mapping(address => bool) claimed; uint256 collateralPerFyusd; }`

Functions:
- `openEpoch(duration, lockOffset)` — admin
- `requestRedeem(epochId, fyusdAmount, targetAsset)` — user, with
  EIP-712 quote signed by backend (mirrors `FypherMinting`)
- `lockEpoch(id)` — admin
- `settleEpoch(id, totalCollateralAvailable, collateralAsset)` —
  admin, after Bitgo wires the collateral to the contract
- `claim(epochId, user)` — anyone
- `cancelEpoch(id, reasonHash)` — admin

The contract holds the collateral between settle + claim — same
custody pattern as `FyusdEpochSettlement` holds FYUSD.

### 2. Backend (fypherx-gateway)

- Extend `BitgoClient` with `requestRedeem(orderId, amountFyusd,
  targetAsset)` + `pollRedemption(orderId)`.
- `RedemptionScheduler` (analog of `EpochScheduler`) drives
  open → lock → settle automatically when enabled.
- New admin endpoints:
  - `POST /api/admin/defi/fyusd/redemptions` (open)
  - `POST .../redemptions/{id}/lock`
  - `POST .../redemptions/{id}/bitgo-sent`
  - `POST .../redemptions/{id}/bitgo-confirmed`
  - `POST .../redemptions/{id}/settle`
  - `POST .../redemptions/{id}/cancel`
  - `GET .../redemptions` — list with lifecycle status

Reuses the `EpochLifecycleEntity` shape with a new `direction`
column (`MINT | REDEEM`).

### 3. Customer frontend (fypherx-frontend)

- New `/fyusd-redeem` page mirroring `/fyusd`. Same epoch-progress
  visualizer, deposit/claim cards.
- `WithdrawFunnel` FYUSD-burn path replaced: instead of
  `swapBetween(FYUSD,RUSD) → requestBurnRusdTo`, it now calls
  `requestFyusdRedemption(amount, target)` → polls until claimable.
- Portfolio FYUSD wallet row gets the **Burn** action back, pointing
  at the new flow.

### 4. Admin dashboard (fypherx-admin-dashboard)

Mirror `/admin/fyusd-epochs` as `/admin/fyusd-redemptions` —
reuses `EpochAdminControls` component with a `direction` prop.

## Open questions

- **Cooldown duration**: 12h symmetric with mint, or shorter?
  Bitgo wire latency is the floor; 6h is plausible if operator
  cadence supports it. Recommend default 12h, admin-tunable via
  `vFyusdRedemptionCooldown` pool config.
- **Per-asset cap**: should the contract enforce a max redemption
  size per epoch to bound Bitgo wire batches? RUSD burn-queue has
  per-block / per-asset caps (M-7 patch); same posture here.
- **Fee model**: redemption fee charged in basis points, paid in
  FYUSD before burn? Mirrors the 0.1% mint fee in `DefiSettings`.
- **Emergency exit**: if Bitgo SLA breaches AND `cancelEpoch` fires,
  users get FYUSD refunded — not collateral. Is that the right
  default, or should the contract let admin push USDT directly out
  of a buffer?

These are all parameter tuning, not architectural. Decide at
implementation time.

## Out of scope (this ADR)

- Phase-3 AMM-based redemption (Path B) — separate ADR if/when
  protocol treasury has surplus liquidity to allocate.
- Cross-asset routing (FYUSD → BTC, FYUSD → ETH) — alpha keeps
  redemption to USDT/USDC only, mirroring the mint side.
- Permissionless redemption without operator confirmation — the
  Bitgo wire is inherently operator-gated; making it permissionless
  needs a different custody model entirely.
