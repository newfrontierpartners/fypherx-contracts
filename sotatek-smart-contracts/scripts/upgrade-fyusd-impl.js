/**
 * Upgrade FYUSD proxy to the S1.3a implementation that appends the
 * {_emergencyMinter} slot + {emergencyMint(to, amount)} per ADR-005 §2.
 *
 * Why this matters
 * ────────────────
 * FYUSD's primary {_minter} slot is migrated to point at
 * {FyusdEpochSettlement} as part of deploy-phase1.js — once that
 * happens the standard mint path runs through epoch settlement.
 *
 * The {emergencyMint} escape hatch is the multisig-only path for
 * remediation scenarios that must NOT depend on epoch settlement
 * being healthy:
 *   - Bitgo Prime API outage longer than the next-epoch fallback
 *     window
 *   - audit-required compensatory mint
 *   - mainnet rotation events
 *
 * Storage layout safety
 * ─────────────────────
 * The S1.3a implementation appends one slot ({_emergencyMinter},
 * address) AFTER the existing {_minter} slot. {OZ Upgrades} validates
 * the layout against {.openzeppelin/<network>.json} and aborts on any
 * existing-slot shift / type-change / removal.
 *
 * Two follow-up admin txs the script also runs (idempotent):
 *   1. Verify {_minter} == FyusdEpochSettlement (set by
 *      deploy-phase1.js). Logs warning + continues if mismatch.
 *   2. {setEmergencyMinter(deployer)} — testnet escape EOA.
 *      Mainnet swaps to the multisig Safe address immediately.
 *
 * Re-run safe.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/upgrade-fyusd-impl.js --network bscTestnet
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  FYUSD impl upgrade (S1.3a) — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:  ${deployer.address}`);
  const balBefore = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balBefore)} (gas token)\n`);

  const addrs = addresses.load(chainId);
  const proxyAddr = addrs.FYUSD;
  if (!proxyAddr) throw new Error(`addresses/${chainId}.json missing FYUSD`);
  console.log(`Proxy:     ${proxyAddr}`);

  // ── Pre-upgrade snapshot ──
  const oldFyusd = await ethers.getContractAt("FYUSD", proxyAddr);
  const beforeMinter = await oldFyusd.minter();
  const beforeOwner  = await oldFyusd.owner();
  console.log(`Before:    minter=${beforeMinter}`);
  console.log(`           owner=${beforeOwner}`);

  // Owner check — setEmergencyMinter is onlyOwner, so the post-upgrade
  // wire-up step will fail if the owner has been transferred to a
  // multisig already.
  if (beforeOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`  ⚠ Owner is not deployer — setEmergencyMinter will fail.`);
    console.log(`    Re-run from the owner EOA, or execute setEmergencyMinter via`);
    console.log(`    the multisig Safe after this script lands the impl upgrade.`);
  }

  // ── Upgrade ──
  console.log("");
  console.log("── Deploying new implementation + switching proxy ──");
  const FYUSD = await ethers.getContractFactory("FYUSD");
  const upgraded = await upgrades.upgradeProxy(proxyAddr, FYUSD);
  await upgraded.waitForDeployment();
  console.log(`  ✓ Upgrade complete (proxy unchanged @ ${proxyAddr})`);

  // ── Post-upgrade verification ──
  const afterMinter = await upgraded.minter();
  const afterOwner  = await upgraded.owner();
  if (afterMinter.toLowerCase() !== beforeMinter.toLowerCase()) {
    throw new Error(`minter mismatch — storage layout corruption!`);
  }
  if (afterOwner.toLowerCase() !== beforeOwner.toLowerCase()) {
    throw new Error(`owner mismatch — storage layout corruption!`);
  }
  console.log(`  ✓ Slot _minter preserved  ${afterMinter}`);
  console.log(`  ✓ Slot owner   preserved  ${afterOwner}`);
  // New slot reads zero by default.
  const beforeEmergency = await upgraded.emergencyMinter();
  console.log(`  ✓ New slot _emergencyMinter readable  ${beforeEmergency}`);

  // ── Sanity: minter SHOULD equal FyusdEpochSettlement ──
  if (addrs.FyusdEpochSettlement) {
    const matches = afterMinter.toLowerCase() === addrs.FyusdEpochSettlement.toLowerCase();
    console.log(matches
      ? `  ✓ minter == FyusdEpochSettlement (deploy-phase1.js wire-up confirmed)`
      : `  ⚠ minter != FyusdEpochSettlement (${addrs.FyusdEpochSettlement}) — re-run deploy-phase1.js to fix`);
  }

  // ── Wire up: setEmergencyMinter ──
  console.log("");
  console.log("── Post-upgrade wire-up ──");
  const targetEmergency = process.env.FYPHERX_FYUSD_EMERGENCY_MINTER || deployer.address;
  await tryTx(`setEmergencyMinter(${targetEmergency})`, async () => {
    if (beforeEmergency.toLowerCase() === targetEmergency.toLowerCase()) return "  ✓ already set";
    const tx = await upgraded.setEmergencyMinter(targetEmergency);
    await tx.wait();
    return `  ✓ set (was ${beforeEmergency === ethers.ZeroAddress ? "0x0" : beforeEmergency})`;
  });

  // ── Summary ──
  const balAfter = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balBefore - balAfter)} (gas token)`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Proxy:             ${proxyAddr}`);
  console.log(`  minter:            ${await upgraded.minter()}`);
  console.log(`  emergencyMinter:   ${await upgraded.emergencyMinter()}`);
  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("- emergencyMint() now callable from the configured emergencyMinter EOA.");
  console.log("- Per ADR-005 §2, on mainnet this should be the multisig Safe — set");
  console.log("  via FYPHERX_FYUSD_EMERGENCY_MINTER env var on the next run, or");
  console.log("  from the multisig itself once owner is transferred.");
  console.log("- Audit-ledger indexer (S2.6) picks up EmergencyMint events automatically");
  console.log("  once enabled (FYPHERX_AUDIT_INDEXER_ENABLED=true).");
  console.log("");
}

async function tryTx(label, fn) {
  process.stdout.write(`  ${label.padEnd(48)} `);
  try {
    const detail = await fn();
    console.log(detail || "  ✓");
  } catch (e) {
    console.log(`  ✗ ${e.shortMessage || e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
