# ADR-003: Deploy `FypherStakingHub` (single vault, sub-pools) + admin one-shot migration

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §3.3
- Resolves: GAP_ANALYSIS Q3 + B-4

## Context

Spec §3.3: "Staking vault 내부에 RUSD pool / FYUSD pool 분리... pool weight: RUSD = 1, FYUSD = 2... FPY accrual = `FPY_per_block × pool_weight × user_share`".

Current deploy: separate ERC-4626 vaults — `StakedRUSD` (`0xd7c0…`), `stAUSD` (`0xa940…`, plays the FYUSD-staking role), `StakedIRUSD`, `StakedFYP`. Each uses APR-rate vesting (8h linear), no per-pool weight, no per-block emission.

## Decision

**Deploy a new `FypherStakingHub`** (single contract, sub-pools indexed by `poolId`), then **one-shot migrate** existing positions via admin.

Architecture:

```solidity
contract FypherStakingHub {
    struct Pool {
        IERC20 underlying;
        uint256 totalShares;
        uint256 totalStaked;
        uint16  weightBps;        // 10000 = 1x, 20000 = 2x
        uint256 lastAccrualBlock;
        uint256 accFpyPerShare;   // scaled 1e18
        bool    paused;           // per-pool pause (ADR-008)
    }
    Pool[] public pools;
    mapping(uint256 => mapping(address => UserStake)) public stakes;

    function migrate(
        uint256 poolId,
        address[] calldata users,
        uint256[] calldata oldShares,
        uint256[] calldata oldUnderlying
    ) external onlyMultisig { ... }
}
```

Initial pools:
- `pools[0]` = RUSD (weightBps = 10000)
- `pools[1]` = FYUSD (weightBps = 20000)

Migration mechanics (B-4-A):
1. Deploy new hub.
2. Old vaults set `migrationLocked = true` (no new stake/unstake).
3. Admin calls `migrate(poolId, users[], oldShares[], oldUnderlying[])` reading from old vault.
4. Hub mints equivalent positions in new sub-pool, no token movement (escrow stays in old vault until users exit).
5. Old vault permits one-way withdraw → user receives original token, old shares burn → user re-stakes into hub.

Alternative considered: B-4-B (cooldown→withdraw→restake user-side). Rejected — Phase 1 testnet stake balances are low, admin migration is faster and avoids dust-stake stranding.

## Consequences

- New `FypherStakingHub` contract + tests.
- Deprecated: `StakedRUSD`, `stAUSD` (kept callable for legacy unstake during migration window, then `setMigrationLocked(true)`).
- Backend `VaultReadService` switches from per-vault read to hub `pools[poolId]` read.
- Admin operator runbook: pre-migration snapshot → execute `migrate()` per pool → verify totals match → lock old vaults.
- Mainnet (Phase 1.2): no migration needed if hub is the first deploy.
