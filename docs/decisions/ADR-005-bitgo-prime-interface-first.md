# ADR-005: Bitgo Prime via interface-first client; FYUSD `_minter` migrates with `emergencyMint` retained

- Status: Accepted
- Date: 2026-04-26
- Spec ref: `PHASE1_SPEC.md` §3.2
- Bitgo docs: https://developers.bitgo.com/docs/stablecoins-mint
- Resolves: GAP_ANALYSIS Q5 + Q12 + B-1

## Context

Spec §3.2 routes Get-FYUSD through Bitgo Prime stablecoin mint (12h epoch). User wants real API integration eventually, but no Bitgo Prime account / API key in hand at Phase 1 kickoff.

FYUSD currently has `address private _minter` (single-address authority). When `FyusdEpochSettlement` becomes the on-chain mint authority, the EOA-mint path disappears — Q12 asks whether to retain an `emergencyMint(admin, amount)` escape.

## Decision

### 1. Backend integration: interface-first

```java
public interface BitgoClient {
    BitgoOrderResponse requestMint(BitgoMintRequest req);
    BitgoOrderStatus  pollOrder(String orderId);
}
```

Two implementations selected by env:
- `MockBitgoClient` — **default for BSC Testnet phase**. Returns deterministic settlement after configurable delay (`fypherx.bitgo.mock-delay-seconds`).
- `RealBitgoClient` — HTTP client against Bitgo Prime REST per the linked docs. Activated by `FYPHERX_BITGO_MODE=live`.

Config keys (filled at Bitgo onboarding):
```
FYPHERX_BITGO_MODE=mock|live
FYPHERX_BITGO_BASE_URL=https://app.bitgo.com   # or https://app.bitgo-test.com for sandbox
FYPHERX_BITGO_ENTERPRISE_ID=...
FYPHERX_BITGO_WALLET_ID=...
FYPHERX_BITGO_ACCESS_TOKEN=...   # via k8s Secret
FYPHERX_BITGO_WALLET_PASSPHRASE=...   # via k8s Secret
```

Production (mainnet) MUST use `live`. The `BitgoConfig` validator throws at boot if `mode=mock` while `runtime-environment=production-like`.

### 2. FYUSD `_minter` migration

Sequence:
1. Deploy `FyusdEpochSettlement` contract.
2. Call `FYUSD.setMinter(<settlementAddress>)` — replaces deployer EOA.
3. Add a separate `address private _emergencyMinter` slot + `function setEmergencyMinter(address)` (multisig-only) + `function emergencyMint(address to, uint256 amount) external onlyEmergencyMinter`.

This preserves operations capability for:
- Bitgo Prime API outage longer than fallback window.
- Audit-required minting (e.g., one-off compensatory mint).
- Mainnet rotation events.

Audit ledger (ADR-009) records every `EmergencyMint` event with operator wallet, reason hash, and on-chain tx.

## Consequences

- Backend ships with mock initially; switch to live = config flag.
- FYUSD contract upgrade required (add `_emergencyMinter` storage). Since FYUSD is upgradeable (TransparentProxy) this is an upgrade-only change with a storage-layout-aware implementation contract.
- Spec §6 multisig requirement covers the emergency minter — multisig-only modifier enforced.
- Mock client behavior is observable in audit ledger so testing in BSC Testnet is realistic.
