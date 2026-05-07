# ADR-012: Operator multisig + gas relayer wallet split

- Status: Accepted (Phase 0)
- Date: 2026-05-08
- Spec ref: extends ADR-005 §6 ("Spec §6 multisig requirement covers the emergency minter — multisig-only modifier enforced") and ADR-009 §"Auth posture" (admin endpoints sit behind operator auth)
- Resolves: GAP_ANALYSIS Q4 (single-key admin), Q14 (gas custody)

## Context

Today the gateway holds a single hot EOA — `BACKEND_EXECUTOR_PRIVATE_KEY` —
that does three jobs at once:

1. holds the on-chain admin role (`SettingManagement.DEFAULT_ADMIN_ROLE`)
2. submits every admin transaction (openEpoch / lockEpoch / settleEpoch /
   cancelEpoch / setSupportedAsset / setBackendSigner / etc.)
3. pays the gas for each of those transactions out of its own balance

That conflation has three concrete problems:

- **Single point of failure.** A compromised env var = full takeover of
  every Phase-1 contract on-chain. There is no operator-side approval
  layer between "an attacker reads our k8s secret" and "the admin
  contracts all flip state."
- **No accountability trail.** Every admin tx looks identical on chain
  (signed by one key) — there is no on-chain record of which operator
  authorised it. The audit ledger (ADR-009) records intent off-chain
  but signing identity is lost.
- **Custody confusion.** The same hot key holds gas + admin role. We
  can't refill gas without exposing the admin key, and we can't rotate
  the admin key without redeploying the gas relayer.

ADR-005 §6 already mandates a multisig "covers the emergency minter"
but never spelled out the operator-flow architecture for the day-to-day
admin path. This ADR fills that gap.

## Decision

### 1. Two-wallet split

Replace the single `BACKEND_EXECUTOR_PRIVATE_KEY` with **two
independently-keyed wallets** that have different roles, different
custody, and different blast radii:

```
[Operator EOA #1] [Operator EOA #2] [Operator EOA #3]    ← Safe owners
                       │                                  ← keys held by humans
                       ▼  N-of-M signing (2-of-3)
              [Gnosis Safe (multisig)]                    ← DEFAULT_ADMIN_ROLE on
                       │                                    every Phase-1 contract
                       │                                  ← holds operator-side
                       │                                    assets (RUSD, FYUSD,
                       │                                    USDT, USDC, etc.)
                       │
                       │ Safe.execTransaction(...)
                       ▼  (msg.sender == Safe address)
              [Admin contracts]
                       ▲
                       │ submits raw tx + pays gas
              [Executor EOA (gas relayer)]                ← single hot key
                       ▲                                  ← admin role: NONE
                       │                                  ← Sepolia ETH only
                       │ BACKEND_GAS_RELAYER_PRIVATE_KEY
              [Backend gateway]
```

**Roles & responsibilities:**

| Wallet | Custody | What it can do | What it can't do |
|---|---|---|---|
| **Gnosis Safe** | 3 owner EOAs, 2-of-3 threshold | Hold admin role on every Phase-1 contract. Hold operator-side assets. Sign admin txs via owner consensus. | Submit on-chain txs by itself (it's a contract — needs a tx caller). |
| **Operator EOA #1/#2/#3** | One operator each, hardware wallet recommended (Ledger / Trezor) for prod | Sign Safe transactions. Add/remove other owners (subject to threshold). | Hold any assets directly. Submit admin txs. |
| **Executor EOA (gas relayer)** | Backend k8s secret, hot key | Submit `Safe.execTransaction(...)` calls. Pay gas. Read-only access to the Safe Transaction Service API. | Hold or move the Safe's assets. Skip the multisig — admin contracts revert if `msg.sender != Safe`. |
| **(deprecated) BACKEND_EXECUTOR_PRIVATE_KEY** | k8s secret today | Everything (current state). | — |

The blast radius of a leaked gas-relayer key is now **bounded to its own
Sepolia ETH balance**: an attacker can drain the relayer's gas, but cannot
move Safe assets, cannot change supported assets, cannot open / lock /
settle epochs, cannot pause anything. The Safe still requires 2 of 3
operator signatures.

### 2. Threshold = 2-of-3

Three operator owners, two signatures required to execute. Rationale:

- **2-of-3 vs 3-of-3:** absorbs one key loss / one operator vacation
  without freezing operations. 3-of-3 is too brittle for a multi-time-
  zone team.
- **2-of-3 vs 1-of-N:** any single key loss/leak still requires a
  second signature. Restores meaningful approval semantics.
- **2-of-3 vs 3-of-5:** five owners is over-coordinated for the team
  size today. Can grow later via Safe `addOwnerWithThreshold` once the
  ops team scales.

Production may rotate to 3-of-5 with a delay-only timelock module — out
of scope for this ADR.

### 3. Safe Wallet UI as deployment + signing surface

Use the **official Safe Wallet UI** (https://app.safe.global) for:

- Deployment (Safe Proxy Factory through the official UI; we don't
  hand-roll the Safe deploy script)
- Owner signature collection (web UI per operator)
- Transaction history view (audit secondary view)

Backend integrates via the **Safe Transaction Service API** (read +
propose only). Backend never holds an owner key. Final `execTransaction`
call is fired by the gas relayer once threshold is reached — backend
proposes, operators sign in the web UI, backend's relayer executes.

### 4. Migration path (Phase 0 → 1 → 2 → 3 → 4)

| Phase | Scope | What changes on-chain | What changes in code |
|---|---|---|---|
| **0 (this ADR)** | Architecture spec + dev keys generated | Nothing on-chain | This file. Dev key manifest template (gitignored secrets). |
| **1 — Sepolia bring-up** | Safe deployed, admin role granted to Safe, gas relayer funded | `SettingManagement.grantRole(0x0, <safe>)` for each Phase-1 contract; deployer admin role retained as fallback. | `scripts/deploy-operator-safe.js` (one-shot deploy via Safe UI then record address); `scripts/grant-admin-to-safe.js` (transfer-with-fallback). |
| **2 — Backend adapter** | Same | None | Backend `SafeTransactionService` (Safe Tx Service API client) + `SafeTransactionProposer` adapter that wraps every existing `AdminOnchainExecutor.send(...)` call. Old `BACKEND_EXECUTOR_PRIVATE_KEY` env var renamed to `BACKEND_GAS_RELAYER_PRIVATE_KEY` with a 1-release legacy-alias period. |
| **3 — Admin dashboard UX** | Same | None | New `/admin/safe-transactions` panel: pending Safe txs, per-operator signature progress, Execute button when threshold reached. Existing admin pages (`/admin/fyusd-epochs`, `/admin/fyusd-redemptions`, etc.) flip from "submit on-chain immediately" to "propose to Safe". |
| **4 — Auto-execute (optional)** | Same | None | Backend scheduler watches for threshold-reached Safe txs and auto-fires execTransaction so operators don't have to remember to click the final button. |
| **(future) Production hardening** | Hardware-wallet owners; timelock module on the Safe; deployer admin role revoked; gas relayer key in KMS/HSM. | `revokeRole(0x0, deployer)`; `enableModule(<delayModule>)`. | Same. |

Each phase ships as its own PR. Phase 0 (this) lands first; Phase 1
unblocks dev environment; Phases 2 + 3 land before any Phase-1 contract
upgrade is performed via the Safe.

### 5. Dev environment keys

Keys for the **dev environment only** are listed below (addresses; the
matching private keys live in the gitignored
`k8s/dev-multisig-secrets.local.yaml`, derived from the generation
session that produced this ADR). These are NOT for production — see
§"Production rollout" for the rotation plan.

| Role | Address | Sepolia ETH refill | Held by |
|---|---|---|---|
| Safe owner #1 | `0x1380894103DF06c96C51DA202ba29DD930423B57` | 0.05 ETH | dev secrets file |
| Safe owner #2 | `0x8657b9ee04c40B6440Dde6F79825553541F731c3` | 0.05 ETH | dev secrets file |
| Safe owner #3 | `0x91AE8FC0AD11c04eee34768F38a2fD76FDa5b179` | 0.05 ETH | dev secrets file |
| Gas relayer | `0x5fA4e48f27CfE353E077a78962e2b578f72B1b97` | **0.5 ETH** (primary gas source) | k8s secret (`BACKEND_GAS_RELAYER_PRIVATE_KEY`) |
| Safe address | `0x...` | TBD (Phase 1 deployment) | derived from owners + factory |

The 0.5 ETH on the gas relayer is sized to cover roughly:
- ~50 admin transactions × ~200k gas × 10 gwei ≈ 0.1 ETH
- Plus 5x safety margin for the audit / load-test cycle

Owner EOAs only need a small dust amount (0.05 ETH) because they don't
submit on-chain txs in the normal flow — they only sign Safe Tx Service
payloads off-chain. The dust is for any owner-initiated on-chain
operation (e.g., changing threshold, replacing an owner) which the
owner submits directly.

### 6. Production rollout

Dev keys are **hot keys generated by a script**. They never touch
production. The production rollout is:

1. Each operator generates an owner key on a hardware wallet (Ledger /
   Trezor) — keys never leave the device.
2. Three operator hardware addresses are recorded in the prod ADR
   amendment (separate doc, not this one).
3. Production Safe is deployed via the Safe Wallet UI on **mainnet**
   with those three hardware addresses as owners, threshold = 2.
4. Production gas relayer key is generated inside KMS/HSM (AWS KMS or
   GCP Cloud KMS); backend signs through KMS rather than holding the
   raw key. The k8s secret holds an IAM-binding pointer, not the raw
   private key.
5. Deployer admin role on every Phase-1 contract is revoked once the
   Safe has been operational for 30 days without incident.
6. Optional: a `DelayModule` is enabled on the Safe so admin txs have
   a 24h delay between proposal-execution and contract-effect — gives
   the team a kill-switch window.

The dev environment intentionally skips the hardware-wallet + KMS +
timelock pieces so the path is testable end-to-end without operator
hardware. The architecture itself is identical.

## Consequences

### Positive

- **Operator approval layer.** No single-key takeover of admin
  surface. A leaked relayer key drains gas, nothing more.
- **On-chain accountability.** Every admin tx is signed by ≥2 named
  owners; the Safe Tx Service surface records who signed when.
- **Custody clarity.** Assets live in the Safe; gas lives in the
  relayer. Refilling gas no longer touches the admin key.
- **Audit-ready.** ADR-005's Spec §6 multisig requirement now has a
  concrete implementation, not a TODO.
- **Production path identical to dev path.** The dev environment uses
  hot keys + a Sepolia Safe; production uses hardware-wallet keys +
  KMS + a mainnet Safe. The contract calls and the backend adapter
  are unchanged across the two — risk surface is the keys, not the
  protocol.

### Negative / cost

- **Operator coordination overhead.** Every admin action now needs ≥2
  operators online to sign. Mitigation: 2-of-3 absorbs one absent
  owner; emergency procedures live in §"Production rollout" for
  longer outages.
- **Latency.** The propose → sign → execute flow is slower than
  "backend posts tx directly". Order of minutes, not seconds. Fine
  for admin actions, NOT fine for hot paths (none of which are admin
  actions, but the team should know).
- **New dependency on Safe Tx Service.** If the Safe Transaction
  Service API is unreachable, backend can't propose new txs. We can
  fall back to direct `Safe.execTransaction` with off-chain signed
  data passed through k8s secret; documented in Phase 2 PR's
  fallback path.
- **Two more env vars.** `BACKEND_GAS_RELAYER_PRIVATE_KEY` (replaces
  `BACKEND_EXECUTOR_PRIVATE_KEY`), `FYPHERX_OPERATOR_SAFE_ADDRESS`
  (new), `FYPHERX_SAFE_TX_SERVICE_URL` (new). Documented in the
  k8s secret template.

### Neutral

- Dev environment continues to use hot keys; the keys generated for
  this ADR rotate once we have hardware-wallet owners, but the dev
  Safe address can stay the same (or be redeployed cheaply).

## References

- Gnosis Safe contracts: https://github.com/safe-global/safe-smart-account
- Safe Transaction Service API: https://safe-transaction-sepolia.safe.global
- Safe Wallet UI: https://app.safe.global
- ADR-005 (multisig hint): `docs/decisions/ADR-005-bitgo-prime-interface-first.md`
- ADR-009 (audit ledger / event indexer): `docs/decisions/ADR-009-audit-ledger-web3j-indexer.md`
- Existing dev secret template: `fypherx-backend-services/k8s/fypherx-chain-secrets.template.yaml`
