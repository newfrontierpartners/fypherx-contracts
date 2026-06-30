# Perp DEX hardening — design proposals (PH-4 / PH-6 / PH-8 / PH-9)

> Status: **proposals only — not implemented.** PH-1/2/3/5/7/10 landed as code in
> PR #68 (small, clearly-correct, fully-tested). The four items below involve
> economic/architecture decisions or cross-system changes that warrant human
> review and a deliberate design pass before code. DEV/testnet scope; the audit
> gate still applies before any mainnet routing.

---

## PH-4 — Multi-feed oracle + mark/index separation (#24)

**Problem.** `FypherOracleRouter` reads a single Chainlink-style feed per market and
returns one `getPriceE18`, used identically for trade-deviation, MM, uPnL, and
liquidation. On Hoodi the "feeds" are keeper-fed mocks (centralised). Single-feed +
no mark/index distinction is the Mango-class risk ($115M).

**Proposed design.**
- Per market store an ordered set of feeds `{feed, decimals, maxStaleness, weight}`.
- `getIndexPriceE18(marketId)` = median (or trimmed-mean) of all fresh feeds; revert
  if fewer than `minFresh` feeds are within staleness.
- `getMarkPriceE18(marketId)` = index ± a bounded premium (clamped), or a separate
  mark feed; clearinghouse uses **mark** for liquidation/MM and **index** for funding.
- Add a per-feed deviation guard: reject if any feed diverges > `maxFeedDeviationBps`
  from the median (drop the outlier rather than revert when `freshCount > minFresh`).
- Keep the global `paused` (M-10).

**Interface sketch.**
```solidity
function configureMarketFeeds(bytes32 marketId, Feed[] calldata feeds, uint8 minFresh, uint32 maxFeedDeviationBps);
function getIndexPriceE18(bytes32 marketId) external view returns (uint256);
function getMarkPriceE18(bytes32 marketId) external view returns (uint256);
```

**Clearinghouse impact.** Replace `oracleRouter.getPriceE18` call sites: liquidation/MM
→ mark; execution-deviation reference → index; funding (off-chain) → index. Non-trivial;
touches every risk view. **Test plan:** median selection, outlier drop, min-fresh
revert, mark-vs-index liquidation behaviour, staleness.

**Why deferred.** Changes the core price surface + the off-chain keeper contract shape;
needs a feed-provider decision (Chainlink vs Pyth vs internal) and an economic review of
the premium/clamp params.

---

## PH-6 — Safe multisig + timelock admin, role unification (#26)

**Problem.** The perp contracts use a bare single-key `owner` (no 2-step, no timelock),
separate from the alpha `SettingManagement` hierarchy (April-audit I-2). A single
compromised key can re-point the oracle, relayers, liquidators, and insurance fund.

**Proposed design.**
- Transfer each contract's `owner` to a **Gnosis Safe (3-of-5)**.
- Add **2-step ownership** (`transferOwnership` + `acceptOwnership`) to avoid fat-finger
  loss (mirror alpha's `SingleAdminAccessControl`).
- Route **parameter changes through a Timelock** (e.g. OZ `TimelockController`): market
  config, oracle feeds, insurance-fund pointer, reward params — queued with a delay so
  the community/keepers can react. Keep an **un-timelocked emergency pause** (PH-5) for
  incident response.
- Define a **role matrix**: owner(Safe+timelock) / relayer(settlement svc) /
  liquidator(keeper) / operator(vault) / pauser — distinct keys, documented, KMS-held.

**Why deferred.** Operational + key-management change (Safe deployment, signer set,
timelock delay choice) more than a code change; coordinate with the existing prod Safe
(`0x1b52d3Db…`) and the alpha admin model. Should land just before audit freeze.

---

## PH-8 — Keeper price-push access control (#28)

**Problem.** This stack's price authority is an off-chain keeper pushing
`setLatestAnswer` to the (mock) oracle — exactly the **KiloEx ($7.4M, 2025-04)** shape:
a meta-tx/forwarder bypass let an attacker impersonate the keeper and write arbitrary
prices, then open-low/close-high.

**Proposed design (on-chain feed contract that the router reads).**
- Strict `onlyKeeper` allowlist on the price-write entrypoint; **no `MinimalForwarder`/
  ERC-2771 `_msgSender()`** on this path (use raw `msg.sender`).
- Per-write **sanity bands**: reject a new answer that moves > `maxPushDeviationBps` from
  the last answer within `minInterval` (rate-limit + bound), with an owner override for
  genuine gaps.
- **Heartbeat + staleness** already consumed by the router (PH-4).
- Separate keeper key per environment; KMS-held (ties to PH-6).
- Emit `AnswerPushed(feed, answer, keeper)` for monitoring; RMS alerts on out-of-band.

**Off-chain (perp-services `OnChainOracleKeeper`).** Multi-source CEX aggregation
(already present) with outlier rejection before push; circuit-break on source disagreement.

**Why deferred.** Couples the on-chain feed contract design with PH-4 and the off-chain
keeper; the mock-oracle on Hoodi must be replaced with the hardened feed first.

---

## PH-9 — Commit-reveal + TWAP liquidation (#29)

**Problem.** Off-chain matching + keeper execution is an atomic front-running surface;
spot-price manipulation can trigger malicious liquidations.

**Proposed design.**
- **Commit-reveal block separation**: a user/relayer request and the keeper execution
  must land in different blocks (or be separated by a `minDelay`), so an attacker can't
  bundle manipulate→liquidate atomically.
- **TWAP/median for the liquidation trigger**: liquidate against a short TWAP (or the
  PH-4 median index) rather than a single spot read, so a one-block spike can't force a
  liquidation.
- Keep PH-3 liquidation reward + PH-10 cross-margin completeness on top.

**Why deferred.** Adds latency/UX trade-offs (commit-reveal delay) and a TWAP accumulator
(gas + storage); needs a product decision on the delay window and a mechanism review.

---

## Sequencing recommendation

1. **PH-6** (admin/keys) + **PH-8** (keeper auth) — highest residual risk, gate before audit.
2. **PH-4** (oracle) — foundational for PH-8/PH-9; pick the feed provider first.
3. **PH-9** (liquidation MEV) — after PH-4's TWAP/median exists.

All four should be specced, reviewed, then implemented on the same `harden/*` dev branch
(PR #68 lineage), tested, and included in the external audit scope (§4 of the beta spec).
