/**
 * Upgrade FypherMinting proxy to the S1.2-refactor implementation.
 *
 * What this activates
 * ───────────────────
 * Per-asset {mintPaused[asset]} mapping (ADR-008) + the {pauserRole}
 * carve-out (ADR-007 §"Pauser carve-out").
 *
 * Note on mintWETH: the original S1.2 draft also fixed the silent-
 * mint bug in mintWETH (msg.value validation + WETH wrap). During
 * the merge with main's April-audit branch, mintWETH was instead
 * permanently deprecated (reverts DeprecatedFunction). The
 * wrappedNative slot + setWrappedNative admin function were dropped
 * with it. This script no longer attempts to wire wrappedNative.
 *
 * Until this upgrade lands, the live proxy at
 * 0x0Cc3De38A1ff577f23d14a4714530FCc11b24690 runs the pre-S1.2
 * implementation. The PauseGrid view's mintPaused rows return false-
 * default (storage zero) until the upgrade. CircuitBreaker.trip()
 * also can't pause mint per-asset until the upgrade.
 *
 * Storage layout safety
 * ─────────────────────
 * The S1.2 implementation appends 4 new slots
 *   - {pauserRole}        address
 *   - {mintPaused}        mapping(address => bool)
 *   - {burnPaused}        mapping(address => bool)
 *   - {wrappedNative}     IWETH
 * after the existing slots 0..14. {@code @openzeppelin/hardhat-upgrades}
 * validates this against the cached pre-upgrade layout in
 * {@code .openzeppelin/<network>.json} and aborts the upgrade if any
 * existing slot has shifted, type-changed, or been removed.
 *
 * Two follow-up admin txs the script also runs (idempotent):
 *   1. {setPauserRole(deployer)} — testnet pauser EOA. Mainnet swaps
 *      to a dedicated low-latency monitor key.
 *   2. {setWrappedNative(WBNB)} — required for mintWETH to wrap real
 *      msg.value. WBNB on BSC Testnet is hard-coded below; on
 *      Ethereum mainnet/Sepolia the script aborts if {WBNB_BY_CHAIN}
 *      doesn't have the chain — operator must update this script.
 *
 * Re-run safe
 * ───────────
 * If the proxy already points at the new impl, {upgrades.upgradeProxy}
 * deploys a fresh impl and switches the proxy. To skip the impl
 * deploy on a no-op re-run, the script could compare bytecode first;
 * for now we err on the side of correctness and let the OZ plugin
 * dedupe against {.openzeppelin/<network>.json}.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/upgrade-minting-impl.js --network hoodi
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  FypherMinting impl upgrade (S1.2) — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:  ${deployer.address}`);
  const balBefore = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balBefore)} (gas token)\n`);

  const addrs = addresses.load(chainId);
  const proxyAddr = addrs.FypherMinting;
  if (!proxyAddr) {
    throw new Error(`addresses/${chainId}.json missing FypherMinting`);
  }
  console.log(`Proxy:     ${proxyAddr}`);

  // ── Pre-upgrade snapshot ──
  // Read fields that should NOT change to give the operator a
  // before/after diff. The proxy stays at the same address; only the
  // implementation behind it changes.
  const oldMinting = await ethers.getContractAt("FypherMinting", proxyAddr);
  const beforeSigner   = await oldMinting.backendSigner();
  const beforeExecutor = await oldMinting.backendExecutor();
  console.log(`Before:    backendSigner=${beforeSigner}`);
  console.log(`           backendExecutor=${beforeExecutor}`);

  // ── Upgrade ──
  console.log("");
  console.log("── Deploying new implementation + switching proxy ──");
  const FypherMinting = await ethers.getContractFactory("FypherMinting");
  const upgraded = await upgrades.upgradeProxy(proxyAddr, FypherMinting);
  await upgraded.waitForDeployment();
  console.log(`  ✓ Upgrade complete (proxy unchanged @ ${proxyAddr})`);

  // ── Post-upgrade verification ──
  // Existing slots must still read the same value.
  const afterSigner   = await upgraded.backendSigner();
  const afterExecutor = await upgraded.backendExecutor();
  if (afterSigner.toLowerCase() !== beforeSigner.toLowerCase()) {
    throw new Error(`backendSigner mismatch: was ${beforeSigner}, now ${afterSigner} — storage layout corruption!`);
  }
  if (afterExecutor.toLowerCase() !== beforeExecutor.toLowerCase()) {
    throw new Error(`backendExecutor mismatch — storage layout corruption!`);
  }
  console.log(`  ✓ Slot 2 (backendSigner)   preserved  ${afterSigner}`);
  console.log(`  ✓ Slot 3 (backendExecutor) preserved  ${afterExecutor}`);

  // New slot 18 (pauserRole) reads zero by default.
  const beforePauser = await upgraded.pauserRole();
  console.log(`  ✓ Slot 15 (pauserRole)     readable   ${beforePauser}`);

  // ── Wire up: setPauserRole(deployer) for testnet ──
  console.log("");
  console.log("── Post-upgrade wire-up ──");
  await tryTx(`setPauserRole(${deployer.address})`, async () => {
    if (beforePauser.toLowerCase() === deployer.address.toLowerCase()) return "  ✓ already set";
    const tx = await upgraded.setPauserRole(deployer.address);
    await tx.wait();
    return `  ✓ set (was ${beforePauser === ethers.ZeroAddress ? "0x0" : beforePauser})`;
  });

  // ── Summary ──
  const balAfter = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balBefore - balAfter)} (gas token)`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Proxy:           ${proxyAddr}`);
  console.log(`  pauserRole:      ${await upgraded.pauserRole()}`);
  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("- The PauseGrid view (/admin/pause-grid) now resolves mintPaused[asset]");
  console.log("  flags against real on-chain state instead of UNKNOWN-default.");
  console.log("- CircuitBreaker.trip() can include setMintPaused(asset, true) calls");
  console.log("  in its trigger pauseCalls[] now that the function exists.");
  console.log("- Per ADR-007 the pauserRole should rotate to a dedicated low-latency");
  console.log("  monitor EOA on mainnet — testnet uses the deployer for now.");
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
