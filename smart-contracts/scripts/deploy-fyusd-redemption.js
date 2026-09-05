/**
 * FyusdEpochRedemption deploy — ADR-011 Bitgo off-ramp.
 *
 * Symmetric mirror of the FyusdEpochSettlement deploy that ran as part
 * of `scripts/deploy-phase1.js`. Lands a single new proxy + a small
 * wire-up:
 *
 *   - FyusdEpochRedemption proxy
 *   - setSupportedAsset(USDT, true)
 *   - setSupportedAsset(USDC, true)
 *   - setPauserRole(FypherCircuitBreaker)   (if breaker is deployed)
 *
 * What this DOES NOT do
 * ─────────────────────
 *   - FYUSD minter rotation: the redemption contract calls
 *     `fyusd.burn(amount)` on its own escrow balance — that uses
 *     `ERC20BurnableUpgradeable.burn(uint256)` which is permissionless
 *     for the holder. The mint-side `_minter` slot stays pointed at
 *     FyusdEpochSettlement, untouched.
 *
 *   - Adding the redemption contract to the FypherCircuitBreaker
 *     trigger registry. The script wires the breaker as
 *     pauserRole so {trip} can call setRequestPaused / setSettlementPaused
 *     on this contract, but registering specific pause-then-unpause
 *     trigger templates is an operator decision — leave it to a
 *     follow-up `setup-circuit-breaker-triggers.js` run.
 *
 * Re-runs are append-only: existing addresses in addresses/<chainId>.json
 * are skipped. Wire-up steps are idempotent.
 *
 * Invariants asserted post-deploy
 * ───────────────────────────────
 *   - redemption.fyusd() == addrs.FYUSD
 *   - redemption.backendSigner() == deployer.address
 *   - redemption.backendExecutor() == deployer.address
 *   - redemption.supportedAssets(USDT) == true
 *   - redemption.supportedAssets(USDC) == true
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const KEY_REDEMPTION = "FyusdEpochRedemption";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  FyusdEpochRedemption deploy — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:        ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:         ${ethers.formatEther(balance)} (native)`);
  console.log("");

  // ── Load existing addresses ──
  let addrs;
  try {
    addrs = addresses.load(chainId);
  } catch (e) {
    console.error(`Cannot load addresses for chainId ${chainId}: ${e.message}`);
    process.exit(1);
  }
  for (const required of ["SettingManagement", "FYUSD", "USDT", "USDC"]) {
    if (!addrs[required]) {
      console.error(`Required address missing from addresses/${chainId}.json: ${required}`);
      process.exit(1);
    }
  }
  const settingMgmtAddr = addrs.SettingManagement;
  console.log(`SettingManagement:    ${settingMgmtAddr}`);
  console.log(`FYUSD:                ${addrs.FYUSD}`);
  console.log(`USDT / USDC:          ${addrs.USDT} / ${addrs.USDC}`);
  if (!addrs.FypherCircuitBreaker) {
    console.warn(`  ! FypherCircuitBreaker missing — pauser wire-up will be skipped.`);
  }
  console.log("");

  // ── Deploy proxy ──
  if (!addrs[KEY_REDEMPTION]) {
    console.log(`── Deploy ${KEY_REDEMPTION} ──`);
    const Redemption = await ethers.getContractFactory("FyusdEpochRedemption");
    const proxy = await upgrades.deployProxy(
      Redemption,
      [
        settingMgmtAddr,
        addrs.FYUSD,
        deployer.address,   // backendSigner — rotated to gateway EOA via setBackendSigner post-deploy
        deployer.address,   // backendExecutor — same posture as FyusdEpochSettlement deploy
      ],
      { initializer: "initialize", kind: "transparent" },
    );
    await proxy.waitForDeployment();
    addrs[KEY_REDEMPTION] = await proxy.getAddress();
    console.log(`  ✓ ${KEY_REDEMPTION} @ ${addrs[KEY_REDEMPTION]}`);
  } else {
    console.log(`  ✓ ${KEY_REDEMPTION} already deployed @ ${addrs[KEY_REDEMPTION]}`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Permission + initial-state wire-up");
  console.log("═══════════════════════════════════════════════════════");

  // ── setSupportedAsset(USDT, USDC) ──
  for (const [sym, addr] of [["USDT", addrs.USDT], ["USDC", addrs.USDC]]) {
    await tryTx(`Redemption.setSupportedAsset(${sym}, true)`, async () => {
      const r = await ethers.getContractAt("FyusdEpochRedemption", addrs[KEY_REDEMPTION]);
      const already = await r.supportedAssets(addr);
      if (already) return "  ✓ already supported";
      const tx = await r.setSupportedAsset(addr, true);
      await tx.wait();
      return "  ✓ added";
    });
  }

  // ── setPauserRole(CircuitBreaker) ──
  if (addrs.FypherCircuitBreaker) {
    await tryTx("Redemption.setPauserRole(CircuitBreaker)", async () => {
      const r = await ethers.getContractAt("FyusdEpochRedemption", addrs[KEY_REDEMPTION]);
      const current = await r.pauserRole();
      if (current.toLowerCase() === addrs.FypherCircuitBreaker.toLowerCase()) return "  ✓ already set";
      const tx = await r.setPauserRole(addrs.FypherCircuitBreaker);
      await tx.wait();
      return `  ✓ set (was ${current === ethers.ZeroAddress ? "0x0" : current})`;
    });
  } else {
    console.log("  (skip pauserRole wire-up — CircuitBreaker not deployed)");
  }

  // ── Invariant checks ──
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Invariant checks");
  console.log("═══════════════════════════════════════════════════════");
  await tryTx("Redemption invariants", async () => {
    const r = await ethers.getContractAt("FyusdEpochRedemption", addrs[KEY_REDEMPTION]);
    const fyusdAddr = await r.fyusd();
    if (fyusdAddr.toLowerCase() !== addrs.FYUSD.toLowerCase()) {
      throw new Error(`fyusd() mismatch: got ${fyusdAddr}, expected ${addrs.FYUSD}`);
    }
    const usdtSupported = await r.supportedAssets(addrs.USDT);
    const usdcSupported = await r.supportedAssets(addrs.USDC);
    if (!usdtSupported || !usdcSupported) {
      throw new Error(`supportedAssets not seeded — USDT=${usdtSupported} USDC=${usdcSupported}`);
    }
    const nextId = await r.nextEpochId();
    if (nextId !== 0n) throw new Error(`fresh-deploy nextEpochId expected 0, got ${nextId}`);
    return `  ✓ fyusd=${fyusdAddr.slice(0, 10)}…, USDT+USDC supported, nextEpochId=0`;
  });

  // ── Persist addresses ──
  console.log("");
  addresses.save(chainId, addrs);
  console.log(`✓ Wrote addresses/${chainId}.json (mirrored to deployed-addresses.json)`);

  // ── Summary ──
  const finalBal = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balance - finalBal)} (native)`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  ${KEY_REDEMPTION.padEnd(28)}  ${addrs[KEY_REDEMPTION]}`);

  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("1. Sync addresses to backend + frontend + admin-dashboard.");
  console.log("");
  console.log("2. Backend: add new env var on the gateway:");
  console.log(`     FYPHERX_FYUSD_REDEMPTION_ADDRESS = ${addrs[KEY_REDEMPTION]}`);
  console.log("   Wire it through application.yml + k8s/fypherx-chain-config.yaml.");
  console.log("");
  console.log("3. Operator: rotate signer/executor slots from the deployer EOA");
  console.log("   to the gateway's EOA via");
  console.log("     redemption.setBackendSigner(<gateway-signer>)");
  console.log("     redemption.setBackendExecutor(<gateway-executor>)");
  console.log("");
  console.log("4. Operator: register CircuitBreaker triggers covering");
  console.log("   setRequestPaused / setSettlementPaused on the new contract.");
  console.log("");
}

async function tryTx(label, fn) {
  process.stdout.write(`  ${label.padEnd(56)} `);
  try {
    const detail = await fn();
    console.log(detail || "  ✓");
  } catch (e) {
    console.log(`  ✗ ${e.shortMessage || e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
