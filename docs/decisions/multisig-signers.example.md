# Multisig signer set — environment template

> Per ADR-007 §"Signer sets". Copy this file to **gitignored**
> per-environment JSON files at the contracts repo root:
>
>   - `sotatek-smart-contracts/multisig-signers.bscTestnet.json`
>   - `sotatek-smart-contracts/multisig-signers.sepolia.json`
>   - `sotatek-smart-contracts/multisig-signers.mainnet.json`
>
> The `multisig-signers.*.json` glob is in `.gitignore` (verify before
> populating).

## File format

```json
{
  "owners": [
    "0x...",
    "0x...",
    "0x..."
  ],
  "threshold": 2,
  "notes": {
    "0x...": "Deployer EOA (rotates pre-launch)",
    "0x...": "Product owner",
    "0x...": "Engineering placeholder (rotate to real signer)"
  }
}
```

`threshold` is optional — if omitted, the script falls back to the
spec value in `scripts/multisig/safe-config.js`:

| Network          | Default threshold | Default signer count |
|------------------|------------------|----------------------|
| BSC Testnet      | 2-of-3           | 3                    |
| Ethereum Sepolia | 2-of-3           | 3                    |
| Ethereum Mainnet | 3-of-5           | 5                    |

## Why per-environment

Each network MUST hold its own Safe at its own address with its own
signer set. The mainnet Safe SHOULD include cold-storage hardware
wallets that don't appear on lower environments. Sharing keys across
environments collapses the production safety boundary.

## Operational policy

Per ADR-007:

- **Pause** (turn on circuit breaker) — pauser EOA OR multisig.
- **Unpause** (turn off) — multisig only.
- **Mint signer rotation, supportedAsset add/remove, FYUSD minter
  reassignment, FYUSD emergencyMinter reassignment, StakingHub pool
  weight, deploy-time `transferAdmin`** — multisig only.

## Signer rotation

Use Safe's standard `addOwnerWithThreshold` / `removeOwner` /
`swapOwner` calls — issued as Safe transactions and executed via the
Safe UI. The deployer EOA SHOULD be removed from the signer set
immediately after the Phase 1 production handoff.
