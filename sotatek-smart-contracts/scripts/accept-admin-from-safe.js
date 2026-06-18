/**
 * Phase 2.5 of ADR-012, Step 2 of the SettingManagement transferAdmin
 * two-step. Phase 1 set `_pendingAdmin = safeAddress` via the deployer
 * key; this script flips `_admin` to the Safe by:
 *
 *   1. Building the Safe transaction whose target is
 *      SettingManagement.acceptAdmin() (no args).
 *   2. Reading the safeTxHash on-chain via Safe.getTransactionHash so
 *      we don't re-implement EIP-712 in JS (same posture as
 *      backend's SafeTransactionProposer).
 *   3. Signing with two owners (owner #1 + owner #2 — meets the
 *      2-of-3 threshold) using ethers' raw secp256k1 sign-on-digest
 *      so v stays at 27/28 (Safe's "type 1" EOA signature).
 *   4. Concatenating both signatures sorted ASCENDING by signer
 *      address (Safe's checkNSignatures requires sorted owners — owner
 *      #1 = 0x1380… < owner #2 = 0x8657… so #1 goes first).
 *   5. Submitting Safe.execTransaction(...) from the gas-relayer EOA.
 *      The relayer pays gas; the Safe contract authorises the call
 *      via the bundled signatures.
 *   6. Verifying SettingManagement.owner() now returns the Safe
 *      address.
 *
 * After this script:
 *   - SettingManagement._admin = Safe address
 *   - SettingManagement._pendingAdmin = address(0)
 *   - Every Phase-1 contract's `onlyAdmin` modifier will reject
 *     the deployer EOA — only the Safe can call admin functions.
 *   - Backend admin endpoints in safe-propose mode will start
 *     producing successful proposals (which previously would have
 *     reverted at execTransaction-time because Safe wasn't admin).
 *
 * IDEMPOTENCY: re-running after success is a no-op. The script
 * checks SettingManagement.owner() up front; if already the Safe,
 * exits 0 with a "nothing to do" message.
 *
 * REVERSIBILITY: Step 1 (transferAdmin) is reversible — deployer can
 * call transferAdmin(deployer) again to clear the pending state.
 * THIS script (Step 2 / acceptAdmin) is NOT reversible from the
 * deployer side. Once it runs, only the Safe can initiate a transfer
 * back. Plan accordingly.
 *
 * Usage:
 *   cd sotatek-smart-contracts
 *   npx hardhat run scripts/accept-admin-from-safe.js --network sepolia
 */

const hre = require('hardhat');
const { ethers } = hre;
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev-multisig') });

// SettingManagement address is read from the per-chain address registry for
// whichever network the script runs against (chainId resolved in main()).
// Previously hard-coded to addresses/11155111.json (Sepolia only).
//
// NOTE: this script signs acceptAdmin() with RAW owner private keys
// (OWNER_1/2_PRIVATE_KEY) and assumes a 2-of-3 threshold — a dev-only
// convenience for driving the full flow from one workstation. On mainnet,
// where the Safe owners are hardware wallets without exportable keys, run
// Step 2 from the Safe Wallet UI instead (https://app.safe.global → the Safe
// → New transaction → Contract interaction → SettingManagement.acceptAdmin()),
// as printed by grant-admin-to-safe.js.
const addresses = require('./lib/addresses');

// Chain-aware explorer + Safe-app slug for the printed runbook URLs.
function chainLinks(chainId) {
  switch (chainId) {
    case 1:        return { explorer: 'https://etherscan.io',          safeSlug: 'eth' };
    case 11155111: return { explorer: 'https://sepolia.etherscan.io',  safeSlug: 'sep' };
    case 560048:   return { explorer: 'https://hoodi.etherscan.io',    safeSlug: 'hoodi' };
    default:       return { explorer: 'https://etherscan.io',          safeSlug: String(chainId) };
  }
}

// Minimal Safe v1.4.1 ABI — only entries this script touches.
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)',
];
// Minimal SettingManagement ABI for the verification + state checks.
const SM_ABI = [
  'function owner() view returns (address)',
  'function acceptAdmin() external',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OPERATION_CALL = 0;

async function main() {
  const provider = ethers.provider;
  const network  = await provider.getNetwork();
  const chainId  = Number(network.chainId);
  const links    = chainLinks(chainId);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 2.5 Step 2 — Safe accepts admin (ADR-012)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Network              : ${network.name} (${chainId})`);

  // Pull addresses + keys.
  const safeAddress     = ensure('OPERATOR_SAFE_ADDRESS');
  const registry        = addresses.load(chainId);
  const settingMgmtAddr = registry.SettingManagement;
  if (!settingMgmtAddr || !ethers.isAddress(settingMgmtAddr)) {
    throw new Error(`Invalid/missing SettingManagement in addresses/${chainId}.json: ${settingMgmtAddr}`);
  }

  const owner1     = new ethers.Wallet(ensure('OWNER_1_PRIVATE_KEY'),               provider);
  const owner2     = new ethers.Wallet(ensure('OWNER_2_PRIVATE_KEY'),               provider);
  const relayer    = new ethers.Wallet(ensure('EXECUTOR_GAS_RELAYER_PRIVATE_KEY'),  provider);

  console.log(`SettingManagement    : ${settingMgmtAddr}`);
  console.log(`Operator Safe        : ${safeAddress}`);
  console.log(`Signer (owner #1)    : ${owner1.address}`);
  console.log(`Signer (owner #2)    : ${owner2.address}`);
  console.log(`Tx submitter (relayer): ${relayer.address}`);
  console.log('');

  // Wire contracts.
  const safe       = new ethers.Contract(safeAddress, SAFE_ABI, provider);
  const setting    = new ethers.Contract(settingMgmtAddr, SM_ABI, relayer);
  const settingIface = new ethers.Interface(SM_ABI);

  // ── Idempotency check ──
  const adminBefore = await setting.owner();
  console.log(`SettingManagement.owner() current : ${adminBefore}`);
  if (adminBefore.toLowerCase() === safeAddress.toLowerCase()) {
    console.log('  ✓ Safe is already admin — nothing to do (idempotent OK).');
    return;
  }
  if (adminBefore.toLowerCase() !== '0x31B60b11533c97b5ED7b1B650D31855F3754Acb4'.toLowerCase()) {
    console.warn(`  ⚠ Current admin is neither the Safe nor the dev deployer (${adminBefore}).`);
    console.warn('    This script expects the deployer EOA to still be admin and Safe to be');
    console.warn('    the pending admin. Aborting before doing anything weird.');
    process.exitCode = 1;
    return;
  }

  // ── Threshold + owners sanity check ──
  const [threshold, owners] = await Promise.all([safe.getThreshold(), safe.getOwners()]);
  console.log(`Safe threshold       : ${threshold} of ${owners.length}`);
  if (Number(threshold) !== 2) {
    console.warn(`  ⚠ Expected threshold=2 for 2-of-3 dev Safe; got ${threshold}.`);
    console.warn('    Continuing anyway — script signs with 2 owners and Safe will accept any');
    console.warn('    threshold ≤ 2 with our signatures.');
  }
  // Pin our two signers to recognised owners.
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  for (const w of [owner1, owner2]) {
    if (!ownerSet.has(w.address.toLowerCase())) {
      throw new Error(`${w.address} is not an owner of Safe ${safeAddress}`);
    }
  }

  // ── Build the Safe tx ──
  const data = settingIface.encodeFunctionData('acceptAdmin', []);
  const nonce = await safe.nonce();
  console.log(`Safe nonce           : ${nonce}`);
  console.log('');

  // ── Compute safeTxHash on chain ──
  console.log('→ reading safeTxHash via Safe.getTransactionHash');
  const safeTxHash = await safe.getTransactionHash(
    settingMgmtAddr,        // to
    0n,                     // value
    data,                   // data
    OPERATION_CALL,         // operation
    0n, 0n, 0n,             // safeTxGas, baseGas, gasPrice (no refund)
    ZERO_ADDRESS,           // gasToken
    ZERO_ADDRESS,           // refundReceiver
    nonce,                  // _nonce
  );
  console.log(`  safeTxHash         : ${safeTxHash}`);

  // ── Sign with each owner ──
  // ethers v6 SigningKey.sign(digest) signs the digest directly
  // (no extra hashing) — that's the format Safe ECRECOVERs against
  // for type-1 (EOA) signatures.
  const signFor = (wallet) => {
    const sig = wallet.signingKey.sign(safeTxHash);
    // ethers normalises v to 27/28. Safe expects 27/28 directly for
    // type-1 sigs (no +4 offset).
    const v = sig.v;
    if (v !== 27 && v !== 28) {
      throw new Error(`Unexpected v=${v} from owner ${wallet.address}; expected 27 or 28`);
    }
    // r||s||v packed
    return ethers.concat([sig.r, sig.s, '0x' + v.toString(16).padStart(2, '0')]);
  };

  const sig1 = signFor(owner1);
  const sig2 = signFor(owner2);

  // Safe checkNSignatures requires signatures sorted by signer
  // address ASCENDING. Lower address first.
  const ordered = owner1.address.toLowerCase() < owner2.address.toLowerCase()
    ? [sig1, sig2]
    : [sig2, sig1];
  const signatures = ethers.concat(ordered);
  console.log(`  signatures (130-byte concat) : ${signatures.slice(0, 14)}…${signatures.slice(-4)} (${(signatures.length - 2) / 2} bytes)`);
  console.log('');

  // ── Submit execTransaction via the gas-relayer EOA ──
  console.log('→ submitting Safe.execTransaction(SettingManagement.acceptAdmin)');
  const safeWithSigner = new ethers.Contract(safeAddress, SAFE_ABI, relayer);
  const tx = await safeWithSigner.execTransaction(
    settingMgmtAddr,
    0,
    data,
    OPERATION_CALL,
    0, 0, 0,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    signatures,
    { gasLimit: 250_000n }
  );
  console.log(`  tx hash            : ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  block              : ${receipt.blockNumber}`);
  console.log(`  gas used           : ${receipt.gasUsed.toString()}`);
  console.log(`  status             : ${receipt.status === 1 ? 'success' : 'reverted'}`);
  if (receipt.status !== 1) {
    throw new Error('Safe.execTransaction reverted — check the receipt manually');
  }

  // ── Verify ──
  const adminAfter = await setting.owner();
  console.log('');
  console.log(`SettingManagement.owner() after  : ${adminAfter}`);
  if (adminAfter.toLowerCase() !== safeAddress.toLowerCase()) {
    throw new Error(`acceptAdmin tx succeeded but admin slot didn't flip. Got ${adminAfter}, expected ${safeAddress}.`);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ Step 2 complete — Safe is now admin');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Etherscan tx       : ${links.explorer}/tx/${tx.hash}`);
  console.log(`  Safe Wallet UI     : https://app.safe.global/transactions/history?safe=${links.safeSlug}:${safeAddress}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Flip FYPHERX_ADMIN_TX_MODE=safe-propose in dev k8s ConfigMap.');
  console.log('    2. Restart fypherx-gateway pod so the new env var loads.');
  console.log('    3. Try an admin action through /admin/fyusd-epochs — the toast');
  console.log('       should now read "Pending in operator Safe — sign in Safe Wallet UI".');
  console.log('');
}

function ensure(envName) {
  const v = process.env[envName];
  if (!v || v.trim() === '' || v.startsWith('0xTBD') || v.startsWith('0xREPLACE')) {
    throw new Error(`${envName} missing in .env.dev-multisig — got "${v}"`);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
