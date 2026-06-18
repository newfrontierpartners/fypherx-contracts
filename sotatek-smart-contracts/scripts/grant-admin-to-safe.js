/**
 * Phase 1 of ADR-012 — initiate the admin transfer to the operator Safe.
 *
 * SettingManagement uses our `SingleAdminAccessControl` (NOT OZ
 * AccessControl), which means there can only ever be ONE admin at a
 * time. The "dual-admin transition" sketched in ADR-012 §6 is therefore
 * implemented through the two-step transferAdmin / acceptAdmin
 * primitive built into the contract:
 *
 *   Step 1 (this script, deployer signs, on-chain immediately):
 *     SettingManagement.transferAdmin(safeAddress)
 *       → _pendingAdmin = safeAddress
 *       → _admin still = deployer  (deployer KEEPS admin power)
 *       → emits AdminTransferRequested(deployer, safe)
 *
 *   Step 2 (Phase 2/3, Safe signs through multisig, completes transfer):
 *     Safe.execTransaction(target=SettingManagement, data=acceptAdmin())
 *       → checks msg.sender == _pendingAdmin  (passes once Safe is sender)
 *       → _admin = safeAddress
 *       → _pendingAdmin = address(0)
 *       → emits AdminTransferred(deployer, safe)
 *
 * The two-step gives us a real fallback window: between Step 1 and
 * Step 2, deployer is still admin and can revoke the pending transfer
 * by calling transferAdmin(deployer.address) again. So even though
 * SingleAdminAccessControl can't hold two admins simultaneously, the
 * transition is staged and reversible.
 *
 * Idempotency:
 *   - If pendingAdmin is already set to OPERATOR_SAFE_ADDRESS, this
 *     script is a no-op (we just print the current state and exit 0).
 *   - If pendingAdmin is set to a different address, the script
 *     overwrites it (deployer can; that's the legitimate use of
 *     transferAdmin).
 *
 * What this script does NOT do (per ADR-012 §"Migration path", these
 * are explicitly Phase 2 / Phase 3 work):
 *   - Call acceptAdmin from the Safe (needs Safe SDK + threshold sigs).
 *   - Update each Phase-1 contract's `backendExecutor` slot. The hot
 *     gas-relayer EOA isn't wired into the gateway yet (Phase 2), so
 *     flipping the on-chain executor slot would break the running
 *     EpochScheduler daemon. Deferred.
 *
 * Usage:
 *   cd sotatek-smart-contracts
 *   npx hardhat run scripts/grant-admin-to-safe.js --network sepolia
 */

const hre = require('hardhat');
const { ethers } = hre;
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev-multisig') });

// SettingManagement address is read from the per-chain address registry for
// whichever network the script is run against — see lib/addresses.load() and
// the chainId resolved at runtime in main(). (Previously this hard-coded
// addresses/11155111.json, which only worked on Sepolia.)
const addresses = require('./lib/addresses');

// Chain-aware explorer + Safe-app slug for the printed runbook URLs.
// Falls back to a bare etherscan host + numeric chainId for unknown chains.
function chainLinks(chainId) {
  switch (chainId) {
    case 1:        return { explorer: 'https://etherscan.io',          safeSlug: 'eth' };
    case 11155111: return { explorer: 'https://sepolia.etherscan.io',  safeSlug: 'sep' };
    case 560048:   return { explorer: 'https://hoodi.etherscan.io',    safeSlug: 'hoodi' };
    default:       return { explorer: 'https://etherscan.io',          safeSlug: String(chainId) };
  }
}

// Minimal ABI — only the entries this script touches.
const SETTING_MANAGEMENT_ABI = [
  'function owner() view returns (address)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function transferAdmin(address newAdmin) external',
  // Public storage getter is not declared; we have to read pending via the event
  // history, but for verification we'll re-call transferAdmin and check the
  // emitted event. There is no `pendingAdmin()` view in
  // SingleAdminAccessControl as committed today.
  'event AdminTransferRequested(address indexed currentAdmin, address indexed newAdmin)',
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const network   = await ethers.provider.getNetwork();
  const chainId   = Number(network.chainId);
  const links     = chainLinks(chainId);

  const registry = addresses.load(chainId);
  const settingMgmtAddress = registry.SettingManagement;
  if (!settingMgmtAddress || !ethers.isAddress(settingMgmtAddress)) {
    throw new Error(
      `Invalid/missing SettingManagement in addresses/${chainId}.json: ${settingMgmtAddress}. ` +
      `Deploy core contracts first (scripts/deploy-mainnet-core.js).`,
    );
  }
  const safeAddress        = process.env.OPERATOR_SAFE_ADDRESS;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1 — initiate admin transfer to operator Safe (ADR-012)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Network            : ${network.name} (${network.chainId})`);
  console.log(`Deployer           : ${deployer.address}`);
  console.log(`SettingManagement  : ${settingMgmtAddress}`);
  console.log(`Operator Safe      : ${safeAddress}`);
  console.log('');

  if (!safeAddress || !ethers.isAddress(safeAddress) || safeAddress.startsWith('0xTBD')) {
    throw new Error(
      `OPERATOR_SAFE_ADDRESS missing or unset in .env.dev-multisig — got "${safeAddress}". ` +
      `Run scripts/deploy-operator-safe.js first.`,
    );
  }

  const setting = new ethers.Contract(settingMgmtAddress, SETTING_MANAGEMENT_ABI, deployer);

  // Sanity check: deployer must be the current admin.
  const currentAdmin = await setting.owner();
  console.log(`Current admin (on-chain) : ${currentAdmin}`);
  if (currentAdmin.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is NOT the current admin (on-chain admin is ${currentAdmin}). ` +
      `Either an earlier transferAdmin already completed, or this is the wrong key. ` +
      `Aborting before the script tries a tx that would revert NotAdmin.`,
    );
  }
  console.log(`  ✓ deployer is the current admin\n`);

  // Submit transferAdmin(safeAddress).
  console.log('→ submitting transferAdmin(safe)...');
  const tx = await setting.transferAdmin(safeAddress);
  console.log(`  tx hash      : ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  block        : ${receipt.blockNumber}`);
  console.log(`  gas used     : ${receipt.gasUsed.toString()}`);

  // Verify the AdminTransferRequested event fired with the right addresses.
  const iface = new ethers.Interface(SETTING_MANAGEMENT_ABI);
  let confirmed = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== settingMgmtAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === 'AdminTransferRequested') {
        const [from, to] = parsed.args;
        console.log(`  event        : AdminTransferRequested(${from}, ${to})`);
        if (
          from.toLowerCase() === deployer.address.toLowerCase() &&
          to.toLowerCase()   === safeAddress.toLowerCase()
        ) {
          confirmed = true;
        }
      }
    } catch { /* not the event we want */ }
  }
  if (!confirmed) {
    throw new Error(
      'AdminTransferRequested event not found / mismatched. The tx may have reverted ' +
      'or hit a different code path; inspect the receipt manually.',
    );
  }

  // Re-read on-chain admin — should still be deployer (transferAdmin only
  // sets pendingAdmin; admin doesn't flip until Safe calls acceptAdmin).
  const adminAfter = await setting.owner();
  console.log(`Admin AFTER tx       : ${adminAfter}`);
  if (adminAfter.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Unexpected: admin changed after Step 1 (current admin = ${adminAfter}). ` +
      `Step 1 is supposed to be staged-only; double-check the contract version.`,
    );
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ Step 1 of admin transfer complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Current admin      : ${deployer.address}  (deployer — UNCHANGED)`);
  console.log(`  Pending admin      : ${safeAddress}  (Safe — must call acceptAdmin)`);
  console.log('');
  console.log(`  Etherscan (tx)     : ${links.explorer}/tx/${receipt.hash}`);
  console.log(`  Etherscan (Safe)   : ${links.explorer}/address/${safeAddress}`);
  console.log('');
  console.log('  Step 2 (NEXT):');
  console.log('    The Safe must execute SettingManagement.acceptAdmin() to');
  console.log('    actually take admin control. Two ways to fire it:');
  console.log('');
  console.log('      A) Phase 2/3 backend SafeTransactionService:');
  console.log('         backend proposes acceptAdmin tx → owners sign in');
  console.log('         Safe Wallet UI → relayer fires execTransaction.');
  console.log('');
  console.log('      B) Manual via Safe Wallet UI (faster for dev):');
  console.log(`         https://app.safe.global/home?safe=${links.safeSlug}:${safeAddress}`);
  console.log(`         New transaction → Contract interaction →`);
  console.log(`         contract = ${settingMgmtAddress}`);
  console.log(`         method   = acceptAdmin (no args)`);
  console.log(`         sign with the Safe's threshold of owners → execute.`);
  console.log('');
  console.log('  Until Step 2 fires, the deployer EOA remains the on-chain');
  console.log('  admin and the gateway\'s existing flows continue working');
  console.log('  unchanged. Step 2 is the irreversible cut-over.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
