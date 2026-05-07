/**
 * Phase 2.5 of ADR-012 — register the gateway gas-relayer EOA as a
 * Safe delegate so the backend can propose admin transactions without
 * holding a Safe owner key (preserving ADR-012 §3 "backend never holds
 * an owner key").
 *
 * One-shot: this script needs to run exactly once per (Safe, delegate)
 * pair on the active chain. The Safe Transaction Service indexes the
 * registration off-chain — there's no on-chain transaction, so the
 * deployer is NOT involved here.
 *
 * Inputs (from `.env.dev-multisig`):
 *   OWNER_1_PRIVATE_KEY               — signer of the delegate registration
 *   OPERATOR_SAFE_ADDRESS             — Safe address (Phase 1 result)
 *   EXECUTOR_GAS_RELAYER_ADDRESS      — delegate to register
 *
 * Wire format (Safe Transaction Service v2 endpoint):
 *
 *   POST https://safe-transaction-sepolia.safe.global/api/v2/delegates/
 *   Body: {
 *     "safe":      "<0xSafe>",        # per-Safe scoping (preferred)
 *     "delegate":  "<0xDelegate>",
 *     "delegator": "<0xOwner>",       # signer of the EIP-712 payload
 *     "label":     "Fypherx gateway gas relayer (dev)",
 *     "signature": "0x...132chars..." # EIP-712 v4 sig over Delegate(delegateAddress,totp)
 *   }
 *
 * EIP-712 domain (verified against safe-transaction-service source):
 *   name:    "Safe Transaction Service"
 *   version: "1.0"
 *   chainId: <int>     (NO verifyingContract)
 *
 * EIP-712 message:
 *   delegateAddress: <address>
 *   totp:            floor(now_seconds / 3600)
 *     The service accepts the previous hour as well, so clock-skew
 *     within ~one hour is tolerated.
 *
 * Idempotency: the service rejects a second registration of the same
 * (safe, delegate, delegator) tuple with HTTP 400 / "Delegate already
 * exists". We treat that as success — re-running this script after a
 * transient HTTP failure is safe.
 *
 * ADR reference: docs/decisions/ADR-012-operator-multisig-and-gas-relayer.md
 *
 * Usage:
 *   cd sotatek-smart-contracts
 *   npx hardhat run scripts/register-backend-delegate.js --network sepolia
 *
 * (We use `hardhat run` so the chainId / RPC / dotenv loading match
 *  the rest of the deploy scripts in this folder, even though we
 *  never actually touch a contract on chain.)
 */

const hre = require('hardhat');
const { ethers } = hre;
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev-multisig') });

// ── Defaults — override via env if needed. ─────────────────────────────────
const SAFE_TX_SERVICE_URL = process.env.SAFE_TX_SERVICE_URL
  ?? 'https://safe-transaction-sepolia.safe.global';
const DELEGATE_LABEL = process.env.DELEGATE_LABEL
  ?? 'Fypherx gateway gas relayer (dev)';

async function main() {
  const network = await ethers.provider.getNetwork();

  // Pull addresses + the owner-signing key.
  const safeAddress      = ensure('OPERATOR_SAFE_ADDRESS');
  const delegateAddress  = ensure('EXECUTOR_GAS_RELAYER_ADDRESS');
  const owner1PrivateKey = ensure('OWNER_1_PRIVATE_KEY');

  // Owner #1 signs the registration. The choice is arbitrary — any
  // current Safe owner can register a delegate. We pick #1 to keep
  // the dev procedure deterministic.
  const owner1 = new ethers.Wallet(owner1PrivateKey, ethers.provider);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 2.5 — register backend gas relayer as Safe delegate (ADR-012)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Network            : ${network.name} (${network.chainId})`);
  console.log(`Safe Tx Service    : ${SAFE_TX_SERVICE_URL}`);
  console.log(`Operator Safe      : ${safeAddress}`);
  console.log(`Delegate (relayer) : ${delegateAddress}`);
  console.log(`Delegator (owner)  : ${owner1.address}`);
  console.log(`Label              : ${DELEGATE_LABEL}`);
  console.log('');

  // ── EIP-712 typed-data signing ──
  // Reference: safe-transaction-service/history/helpers.py DelegateSignatureHelperV2.
  // Domain has 3 fields exactly — no verifyingContract.
  const totp = Math.floor(Date.now() / 1000 / 3600);
  const domain = {
    name:    'Safe Transaction Service',
    version: '1.0',
    chainId: Number(network.chainId),
  };
  const types = {
    Delegate: [
      { name: 'delegateAddress', type: 'address' },
      { name: 'totp',            type: 'uint256' },
    ],
  };
  const message = {
    delegateAddress: ethers.getAddress(delegateAddress),  // checksummed
    totp,
  };

  console.log(`→ signing EIP-712 Delegate{address=${message.delegateAddress}, totp=${totp}}`);
  const signature = await owner1.signTypedData(domain, types, message);
  console.log(`  signature        : ${signature.slice(0, 14)}…${signature.slice(-4)} (${(signature.length - 2) / 2} bytes)`);
  console.log('');

  // ── POST to the Safe Transaction Service ──
  const url = `${stripSlash(SAFE_TX_SERVICE_URL)}/api/v2/delegates/`;
  const body = {
    safe:      ethers.getAddress(safeAddress),
    delegate:  ethers.getAddress(delegateAddress),
    delegator: owner1.address,
    label:     DELEGATE_LABEL,
    signature,
  };

  console.log(`→ POST ${url}`);
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const respText = await resp.text();
  if (resp.status === 201 || resp.status === 200) {
    console.log(`  HTTP ${resp.status} ✓ delegate registered`);
  } else if (resp.status === 400 && /already exists/i.test(respText)) {
    // Idempotent: re-running after a network blip is fine.
    console.log(`  HTTP 400 — delegate already registered (idempotent OK)`);
  } else {
    console.error('');
    console.error(`  HTTP ${resp.status} — unexpected response`);
    console.error(`  Body: ${respText}`);
    process.exitCode = 1;
    return;
  }

  console.log('');

  // ── Verify ──
  // The v2 list endpoint takes the Safe as a query string, not a path
  // segment (the path-segment variant returns 404 on Sepolia even for
  // safes that have delegates).
  const verifyUrl = `${stripSlash(SAFE_TX_SERVICE_URL)}/api/v2/delegates/?safe=${safeAddress}`;
  console.log(`→ GET  ${verifyUrl}`);
  const vResp = await fetch(verifyUrl);
  const vBody = await vResp.text();
  if (vResp.status !== 200) {
    console.warn(`  HTTP ${vResp.status} — verification skipped (registration probably still propagating)`);
  } else {
    let vJson;
    try { vJson = JSON.parse(vBody); } catch { vJson = { results: [] }; }
    const results = Array.isArray(vJson.results) ? vJson.results : [];
    const match = results.find((r) =>
      r.delegate?.toLowerCase()  === delegateAddress.toLowerCase() &&
      r.delegator?.toLowerCase() === owner1.address.toLowerCase()
    );
    if (match) {
      console.log(`  ✓ delegate confirmed by service: label="${match.label}"`);
    } else {
      console.warn('  ⚠ delegate not yet visible in delegates list — may take a few seconds to index');
      console.warn('    Re-run verification:');
      console.warn(`    curl ${verifyUrl}`);
    }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ Phase 2.5 delegate registration done');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. fypherx-backend-services Phase 2.5 PR migrates each');
  console.log('       admin endpoint from executor.send() to');
  console.log('       executor.sendOrPropose(). Once that lands AND the');
  console.log('       gateway flips FYPHERX_ADMIN_TX_MODE=safe-propose,');
  console.log('       admin clicks land as Safe proposals automatically.');
  console.log('');
  console.log(`    2. Test propose flow once safe-propose mode is on:`);
  console.log(`         POST /api/admin/defi/fyusd/epochs   (open new epoch)`);
  console.log(`       The response should contain {mode: "safe-propose",`);
  console.log(`       safeTxHash: 0x...} and the proposal should appear at`);
  console.log(`       https://app.safe.global/transactions/queue?safe=sep:${safeAddress}`);
  console.log('');
  console.log('    3. Owners sign in the Safe Wallet UI (2-of-3) →');
  console.log('       Execute → Safe.execTransaction(...) lands the call');
  console.log('       on chain.');
  console.log('');
}

function ensure(envName) {
  const v = process.env[envName];
  if (!v || v.trim() === '' || v.startsWith('0xTBD') || v.startsWith('0xREPLACE')) {
    throw new Error(`${envName} missing in .env.dev-multisig — got "${v}"`);
  }
  return v;
}

function stripSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
