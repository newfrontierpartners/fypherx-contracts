# ADR-009: Full audit ledger via Web3j event indexer + daily reconciliation

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §6
- Resolves: GAP_ANALYSIS Q9 + B-5

## Context

Spec §6: "Audit ledger: on-chain event + off-chain DB 양쪽 기록, 일일 reconciliation". Currently only mint-sign actions write to `AdminAuditLogEntity` — there is no on-chain event indexer, no reconciliation cron.

User selected the full Phase 1 scope (not stub) and the Web3j subscription path (option B-5-A) over The Graph or custom poller.

## Decision

### Architecture

```
  contracts                backend (gateway)                   PostgreSQL
  ─────────                ────────────────                   ──────────
  emit X    ───filter────▶  EventIndexerService               event_log
                            ├─ subscribes per contract        ├─ id (uuid)
                            ├─ decodes log → typed event      ├─ block_number
                            └─ writes event_log row           ├─ tx_hash
                                                              ├─ contract
  business state ────────▶  ReconciliationService             ├─ event_name
  (db: burn_request,        ├─ daily cron 03:00 UTC           ├─ args_json
   epoch_deposit,           ├─ for each (date, contract)      ├─ recorded_at
   stake_position)          │  count on-chain events          └─ business_link_id
                            │  vs derived business count
                            ├─ writes reconciliation_run row
                            └─ alerts on mismatch >0
```

### Indexed events (Phase 1 scope)

- `FypherMinting.Mint` / `Redeem` / `RedeemRequested` / `RedeemExecuted` / `Paused`
- `FypherBurnQueue.BurnRequested` / `BurnClaimed`
- `FyusdEpochSettlement.DepositMade` / `EpochLocked` / `BitgoOrderSubmitted` / `EpochSettled` / `Distributed`
- `FypherStakingHub.Staked` / `Unstaked` / `RewardsClaimed`
- `FyusdYieldVault.Deposit` / `Withdraw`
- `FYUSD.EmergencyMint` (high-sensitivity)
- All `Paused`/`Unpaused` from any contract

### Implementation

- `EventIndexerService`: `@Service` + `@PostConstruct` registers Web3j `flowable` subscriptions per (contract address, event signature). On each log: decode → write `event_log` row.
- Resilience: persist last processed block per contract in `indexer_cursor` table; on restart, replay from cursor. RPC reconnect with backoff on disconnect.
- Reconciliation: `@Scheduled(cron="0 0 3 * * *")` (03:00 UTC daily). Compares event counts to business derivations:
  - on-chain `Mint` count == off-chain `mint_audit` row count for that day
  - on-chain `BurnRequested` count == `burn_request` rows with `requestedAt::date = X`
  - etc.
- Mismatches → write `reconciliation_run` row + send alert (Slack webhook initially).

### Storage

`event_log` table sized for ~10k events/day (indexer cap testnet) or ~100k events/day (mainnet projection). Partitioned monthly. Retention: indefinite for audit (compliance).

### Alternatives rejected

- **The Graph subgraph**: external dependency on Hosted Service / decentralized network; harder to reconcile against backend's authoritative tables.
- **Custom block-poller**: re-implements what Web3j already provides; reorg handling more error-prone.

## Consequences

- New Spring `@Service` + repository + 2 entities (`EventLogEntity`, `IndexerCursorEntity`, `ReconciliationRunEntity`).
- Backend now critical-path for audit — outage delays reconciliation but doesn't lose events (cursor replay).
- DB write volume +O(events). Manageable; same Postgres instance.
- Admin dashboard `/admin/audit-ledger` reads `event_log` + `reconciliation_run`.
- Mainnet: scale RPC plan for sustained subscription (Infura/Alchemy paid tier or own node).
