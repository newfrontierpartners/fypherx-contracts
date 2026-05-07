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

### 3. Safe Wallet UI as the canonical deployment + signing surface

Use the **official Safe Wallet UI** (https://app.safe.global) for:

- Deployment for production
- Owner signature collection (web UI per operator) on every chain
- Transaction history view (audit secondary view)

Backend integrates via the **Safe Transaction Service API** (read +
propose only). Backend never holds an owner key. Final `execTransaction`
call is fired by the gas relayer once threshold is reached — backend
proposes, operators sign in the web UI, backend's relayer executes.

**Dev-environment exception.** Phase 1's Sepolia bring-up uses a
deterministic `scripts/deploy-operator-safe.js` against the canonical
Safe v1.4.1 Proxy Factory (`0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`)
with the same setup payload the official UI emits — saltNonce derived
from the sorted owner addresses + threshold so the Safe address is
deterministic and reproducible. Output Safe is verifiable in the Safe
Wallet UI immediately after deploy (signers can see it under their
"Owned Safes"). Production deploys still go through the Safe Wallet
UI per the policy above; dev automation is allowed because the Safe
contracts are identical between the two paths and the failure modes
of a hand-rolled deploy (wrong owners, wrong threshold, wrong
fallback handler) are caught by the same UI verification step.

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

### 6. Admin transfer mechanics + production rollout

`SettingManagement` extends our in-house `SingleAdminAccessControl`
(NOT OpenZeppelin's `AccessControl`). Per its source:

```solidity
function hasRole(bytes32 role, address account) public view returns (bool) {
    if (role == bytes32(0)) return account == _admin;   // single slot!
    return _roles[role][account];
}
```

The `DEFAULT_ADMIN_ROLE` slot is therefore physically a single address.
The earlier draft of this ADR sketched a "30-day dual admin" transition,
which is impossible under this contract. Instead, the contract exposes
a **two-step admin transfer** primitive that gives the same fallback
window:

```solidity
function transferAdmin(address newAdmin) external onlyAdmin {
    _pendingAdmin = newAdmin;
    emit AdminTransferRequested(_admin, newAdmin);
}

function acceptAdmin() external {
    if (msg.sender != _pendingAdmin) revert NotPendingAdmin();
    _admin = msg.sender;
    _pendingAdmin = address(0);
    emit AdminTransferred(prevAdmin, msg.sender);
}
```

The transition therefore looks like:

| Step | Who | Action | Effect |
|---|---|---|---|
| **1** (Phase 1) | deployer | `transferAdmin(safe)` | `_pendingAdmin = safe`. **`_admin` UNCHANGED** — deployer still admin. |
| (gap, hours → days, reversible) | deployer | `transferAdmin(deployer)` if anything is wrong | clears the pending transfer, no further changes |
| **2** (Phase 2 / Phase 3) | Safe (multisig) | `Safe.execTransaction(target=SettingManagement, data=acceptAdmin())` | `_admin = safe`. Irreversible cut-over. |

This gives the same operational property as a 30-day dual-admin window
(deployer keeps emergency authority during the bake period), while
matching the actual contract semantics. The bake period length is now
governed by *when Step 2 fires* rather than by an off-chain calendar —
operations may extend or compress it as needed.

#### Production rollout sequence

Dev keys are **hot keys generated by a script**. They never touch
production. The production rollout is:

1. Each operator generates an owner key on a hardware wallet (Ledger /
   Trezor) — keys never leave the device.
2. Three operator hardware addresses are recorded in a prod ADR
   amendment (separate doc, not this one).
3. Production Safe is deployed via the Safe Wallet UI on **mainnet**
   with those three hardware addresses as owners, threshold = 2.
4. Production gas relayer key is generated inside KMS/HSM (AWS KMS or
   GCP Cloud KMS); backend signs through KMS rather than holding the
   raw key. The k8s secret holds an IAM-binding pointer, not the raw
   private key.
5. Step 1 (`transferAdmin`) and Step 2 (`acceptAdmin`) bake period is
   minimum 7 days on production: deploy team validates that the Safe
   can sign + execute a *no-op* admin tx (e.g. `setBackendSigner` to
   the same value) before Step 2 fires. If anything fails, deployer
   re-runs `transferAdmin(deployer)` and the cut-over is cancelled.
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

## 7. Phase 1 outcome (2026-05-08, Sepolia)

Live state on Sepolia after Phase 1 PR landed:

| Item | Value |
|---|---|
| Operator Safe address | `0xeE959d46a5db4379dCe86163E6994e4E34B6ef01` |
| Safe version | v1.4.1 (canonical singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`) |
| Owners | `0x1380894103DF06c96C51DA202ba29DD930423B57`, `0x8657b9ee04c40B6440Dde6F79825553541F731c3`, `0x91AE8FC0AD11c04eee34768F38a2fD76FDa5b179` |
| Threshold | 2-of-3 |
| Safe deploy tx | [0x3a2de6f2…d26d](https://sepolia.etherscan.io/tx/0x3a2de6f21efd8dd24f94b771f330ebe140df8dfaa99878e5f95207bbb260d26d) |
| `SettingManagement.transferAdmin(safe)` tx | [0x51888e7f…43a8](https://sepolia.etherscan.io/tx/0x51888e7fba10832af1eceabe504e203c525afef8fab1a664b19a05d5312b43a8) |
| Current on-chain admin | deployer (`0x31B6…Acb4`) — unchanged, owns admin until Step 2 |
| Pending admin | Safe — set by `AdminTransferRequested` event in tx above |
| Gas relayer EOA | `0x5fA4e48f27CfE353E077a78962e2b578f72B1b97` (no on-chain role yet) |
| Safe Wallet UI link | https://app.safe.global/home?safe=sep:0xeE959d46a5db4379dCe86163E6994e4E34B6ef01 |

### Phase 1 → Phase 2 hand-off

Three things must happen before Phase 2 backend code can deploy:

1. **At least one Safe owner signs into the Safe Wallet UI** (Sepolia
   network, Safe address above) and confirms the Safe shows up under
   "Owned Safes" with the correct owner list + threshold. This is the
   manual verification step the §3 dev-environment exception relies on.
2. **The pending admin transfer is left as-is** until Phase 2 wires
   the SafeTransactionService adapter; once the adapter can route txs
   through the Safe, the team triggers `acceptAdmin` from the Safe
   Wallet UI (or via the adapter) to complete the cut-over.
3. **Gas relayer EOA stays funded** — the gateway will start using it
   in Phase 2, so its 0.05 ETH dev balance must persist (top up if
   draining).

### What did NOT change in Phase 1

- `backendExecutor` slot on every Phase-1 contract (FyusdEpochSettlement,
  FypherBurnQueue, FypherStakingHub, FyusdYieldVault, RUSDYieldVault,
  FyusdEpochRedemption) is **still the deployer EOA**. Flipping it to
  the gas relayer is Phase 2 work — doing it now would break the
  EpochScheduler daemon which currently signs lockEpoch / settleEpoch
  with the deployer key.
- `BACKEND_EXECUTOR_PRIVATE_KEY` env var on the gateway pod is
  **still the deployer key**. Renaming + repointing happens in Phase 2
  alongside the SafeTransactionService adapter.
- Deployer EOA's admin power is **fully intact**. All existing admin
  flows (open / lock / cancel epoch from `/admin/fyusd-epochs`,
  setSupportedAsset, etc.) keep working.

This means Phase 1 is purely additive — no operator-visible change
yet. The Safe is staged but inert until Phase 2 turns it on.

## References

- Gnosis Safe contracts: https://github.com/safe-global/safe-smart-account
- Safe Transaction Service API: https://safe-transaction-sepolia.safe.global
- Safe Wallet UI: https://app.safe.global
- ADR-005 (multisig hint): `docs/decisions/ADR-005-bitgo-prime-interface-first.md`
- ADR-009 (audit ledger / event indexer): `docs/decisions/ADR-009-audit-ledger-web3j-indexer.md`
- Existing dev secret template: `fypherx-backend-services/k8s/fypherx-chain-secrets.template.yaml`
