# Admin model — fypherx-contracts

Closes audit finding **I-2** (April 2026 deep audit). This file is the
single source of truth for *who can do what* across the canonical
contracts in this repo. If you are a governance reviewer, security
researcher, or operator: read this once before reading any single
contract in isolation.

## TL;DR

Two **independent** admin hierarchies coexist by design:

| Subsystem | Admin pattern | Stored in | Authorising contract |
| --- | --- | --- | --- |
| **Staking + Mint/Burn** (`StakedRUSD`, `StakedFYP`, `StakedAUSD`, `StakedIRUSD`, `FypherMinting`, `RUSD`, `iRUSD`, `FYUSD`, `FYP`) | `SettingManagement` (role-based via `SingleAdminAccessControl`) | `_admin` slot in `SingleAdminAccessControl` + `_roles[role][account]` in the same | `SettingManagement` (a deployed proxy) |
| **Perps** (`FypherPerpsClearinghouse`, `FypherXSettlement`, `FypherXInsuranceFundVault`, `FypherOracleRouter`) | Bare `address public owner` slot per contract | The contract itself | The contract itself |

These two never call each other. They share collateral *tokens* (RUSD,
FYUSD), but **not** governance state. Compromising the staking admin
does not affect perps, and vice versa.

## Why two hierarchies

Historical: the staking + mint stack was inherited from the Sotatek
codebase and uses an OZ-style role mapping with named roles
(`REWARDER_ROLE`, `RELEASE_TOKEN_ROLE`, `INSTITUTIONAL_ROLE`, two
`*_RESTRICTED_STAKER_ROLE`s — the rest were dead code and were
removed in the April-audit I-1 patch).

The perps stack was written from scratch for the FypherX rollup. Each
contract owns its own `owner` slot with a bare `onlyOwner` modifier
plus per-domain allowlists (`relayers`, `liquidators`, `operators`).
There is no role mapping; the allowlists are simple `mapping(address
=> bool)` flags.

We did not unify the two during the April audit because:

1. Storage layout for the staking proxies is locked under a
   TransparentProxy upgrade chain. A unification would require either
   a storage migration (risky) or a parallel-deploy-and-switch (slow).
2. The perps subsystem does not yet have a long enough operational
   tail to justify the role-mapping complexity. Its admin operations
   are limited to: relayer set, liquidator set, market config,
   insurance-fund pointer, oracle pause. All single-step, all
   `onlyOwner`.

If/when perps moves to mainnet with a multi-team operator model, the
recommended migration is to deploy a thin `Ownable`→`AccessManaged`
adapter on each perps contract rather than reusing
`SingleAdminAccessControl` (which embeds initializer + storage layout
contracts shouldn't inherit cold).

## Per-contract admin map

### Staking + Mint stack

All routes through `SettingManagement._admin`:

- `SettingManagement.transferAdmin` → 2-step (`acceptAdmin` required)
- `SettingManagement.grantRole` / `revokeRole` / `renounceRole`
- Per-vault `proposeSettingManager` / `acceptSettingManager`
  (April-audit C-3 patch): rotates the `settingManagement` pointer in
  each `Staked*` vault behind a 2-day timelock; `__SettingManager`
  rotation can therefore not happen atomically with admin compromise.

Critical roles that are **not renounceable** (April-audit H-3 patch):

- `bytes32(0)` — the default admin slot
- `REWARDER_ROLE`
- `RELEASE_TOKEN_ROLE`

### Perps stack

Each contract owns its own `owner` slot. Transfer is single-step via
`setOwner`. There is no pending-admin queue.

| Contract | owner-only setters | Allowlists |
| --- | --- | --- |
| `FypherPerpsClearinghouse` | `setOwner`, `setRelayer`, `setLiquidator`, `setInsuranceFund`, `configureMarket` | `relayers`, `liquidators` |
| `FypherXSettlement` | `setOwner`, `setRelayer`, `setTradeSigner` | `relayers` |
| `FypherXInsuranceFundVault` | `setOwner`, `setOperator` | `operators` |
| `FypherOracleRouter` | `setOwner`, `setPaused`, `configureMarketOracle` | (none) |

Note the `tradeSigner` slot in `FypherXSettlement` is a separate
EIP-712 signing key (April-audit H-5 patch); it is intentionally NOT
in the relayer allowlist, so a single relayer compromise cannot mint
fabricated `TradeSettled` events.

### Cross-stack coupling

Two implicit couplings between the stacks exist:

1. The **collateral token** of `FypherPerpsClearinghouse` is one of
   the staking-admin-controlled ERC-20s (RUSD or FYUSD in production).
   A staking admin who mints unbacked RUSD/FYUSD via
   `FypherMinting.mint` could in principle deposit the inflation into
   the perps collateral pool. Mitigation: the per-asset per-block
   mint cap in `FypherMinting._checkMintLimit` (April-audit M-7) plus
   the absolute net stables-delta cap (April-audit M-6).

2. The **insurance fund** (`FypherXInsuranceFundVault`) holds the same
   ERC-20 collateral and is consulted on liquidation deficits
   (April-audit H-4). Its `operators` set must include the
   clearinghouse address; conversely, the clearinghouse must point at
   the vault via `setInsuranceFund`. Both wires are audit-trailed via
   `OperatorUpdated` and `InsuranceFundUpdated` events.

## Operational recommendations (non-binding)

- Both `_admin` (staking) and each perps `owner` should be a
  multisig (3-of-5 minimum). Today neither is enforced on-chain;
  the recommendation is policy-only.
- `FypherOracleRouter.setPaused`, `FypherPerpsClearinghouse.liquidate`
  emissions, and any `*Updated` event on either stack should page
  on-call. They are the load-bearing observable signals.
- The `tradeSigner` key on `FypherXSettlement` should be HSM-backed
  and rotated independently of the relayer keyset.
