# ADR-006: Concrete adapter mocked on BSC, real on Ethereum

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §3.4
- Concrete docs: https://docs.concrete.xyz/
- Resolves: GAP_ANALYSIS Q6 + B-2

## Context

Concrete (concrete.xyz) is an institutional yield platform deployed on **Ethereum mainnet** (and L2s like Base). It is **not deployed on BSC**, and Concrete docs do not list a BSC roadmap. Phase 1 testing path is BSC Testnet (per ADR-010).

## Decision

Adopt **option B-2-A**: same Solidity interface for both networks, two implementations.

```solidity
interface IConcreteAdapter {
    function deposit(uint256 fyusdAmount) external returns (uint256 shares);
    function withdraw(uint256 shares) external returns (uint256 fyusdAmount);
    function totalAssets() external view returns (uint256);
    function shareOf(address user) external view returns (uint256);
    function realizedYield7d() external view returns (uint256 yieldBps); // for "7d realized APY" UI
}
```

Implementations:
- `MockConcreteAdapter.sol` — BSC Testnet. Internally tracks shares 1:1 with FYUSD; accrues fake yield at configurable APY (default 4%) for realistic UX testing.
- `ConcreteAdapterV1.sol` — Ethereum mainnet. Calls into the real Concrete vault contract per their protocol docs (specific contract address + ABI to be sourced at mainnet deploy time from Concrete docs / their team).

The `FyusdYieldVault` (user-facing entry contract) holds an `IConcreteAdapter adapter` slot, set at deploy time per network. No code change between networks.

Interface lock-in is binding: any Concrete protocol change post-Phase 1 may require adapter v2 + migration script. Acceptable risk given Concrete's stable mainnet contracts.

## Consequences

- BSC Testnet: full UX is testable with simulated yield — admin can verify deposit, withdraw, share-mapping, "7d realized APY" UI, audit ledger.
- Ethereum mainnet: requires confirmation of exact Concrete vault address + signature compatibility before deploy. To be sourced at mainnet readiness from Concrete docs/team.
- Vault APY display in admin uses `realizedYield7d()` — same in both implementations.
- If Concrete's interface differs at mainnet readiness, ConcreteAdapterV1 absorbs the diff; FyusdYieldVault stays unchanged.
