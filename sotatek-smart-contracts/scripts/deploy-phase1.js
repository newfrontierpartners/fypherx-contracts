/**
 * Phase 1 contract deploy — additive on top of the existing Stage 4
 * deploy. Per ADR-010 §"Cross-network code factoring" + the S1.9
 * deploy-script restructure.
 *
 * What this deploys
 * ─────────────────
 *   - MockConcreteAdapter    (S1.5, BSC-only — ADR-006)
 *   - FypherBurnQueue        (S1.1, ADR-001 + ADR-002)
 *   - FyusdEpochSettlement   (S1.3, ADR-005)
 *   - FypherStakingHub       (S1.4, ADR-003)
 *   - FyusdYieldVault        (S1.5, ADR-006)
 *   - FypherCircuitBreaker   (S1.6, ADR-008)
 *
 * What this DOES NOT do (intentionally)
 * ─────────────────────────────────────
 *   - FypherMinting impl upgrade (S1.2). The proxy at
 *     0x0Cc3De38A1ff577f23d14a4714530FCc11b24690 is live with state;
 *     upgrading the implementation is a high-risk separate operation.
 *     The `mintPaused[asset]` mapping landed in S1.2 lives behind that
 *     upgrade — until performed, the PauseGrid view shows
 *     `mintPaused` flags as UNPAUSED-by-default (storage zero).
 *     Run `scripts/upgrade-minting-impl.js` (separate) to upgrade.
 *
 *   - FYUSD impl upgrade (S1.3a — emergencyMint). Same reasoning.
 *
 *   - Multisig migration (S1.7). Requires the per-network signer
 *     set in `multisig-signers.hoodi.json` (gitignored) — see
 *     `scripts/multisig/deploy-safe.js` + `transfer-admin.js` to
 *     run that ceremony separately.
 *
 *   - Migrating existing stakers from StakedRUSD/stAUSD into
 *     FypherStakingHub via {migrate(...)}. Operator-side decision
 *     per ADR-003 §"Migration mechanics".
 *
 * Permission wiring this script DOES set up (so the new contracts
 * are immediately functional from the operator side):
 *   - FYUSD setMinter -> FyusdEpochSettlement (so settle() can mint)
 *   - StakingHub.addPool(RUSD, 10000)  + addPool(FYUSD, 20000)
 *     [pool 0 = RUSD 1x, pool 1 = FYUSD 2x per ADR-003]
 *   - YieldVault wired against MockConcreteAdapter
 *   - BurnQueue setSupportedAsset(USDT, true) + (USDC, true)
 *   - EpochSettlement same supportedAssets
 *   - All four new contracts: setBackendSigner / setBackendExecutor
 *     to deployer EOA (matching FypherMinting)
 *   - All four contracts: setPauserRole(circuitBreaker)
 *
 * Re-runs are append-only: if a contract already exists in
 * addresses/<chainId>.json the script SKIPS its deploy + just
 * verifies the on-chain config. Wire-up steps are idempotent (admin
 * setters can be called repeatedly with the same value).
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/deploy-phase1.js --network hoodi
 *
 * Required env (loaded from .env):
 *   PRIVATE_KEY           deployer EOA (must hold testnet BNB for gas)
 *   TESTNET_RPC_URL       BSC Testnet RPC (defaults to public node)
 *
 * Local hardhat smoke caveat
 * ──────────────────────────
 * Running this against `--network hardhat` only verifies the JS path
 * + contract compilation + ABI shapes. The wire-up steps assume an
 * already-deployed SettingManagement; on local hardhat that contract
 * doesn't exist at the legacy-fallback BSC-Testnet address, so admin
 * checks behave inconsistently (some return false, some return data
 * the ABI can't decode). Treat any local-hardhat run as a smoke test
 * for the script's structure, not its semantics. Real validation
 * happens on BSC Testnet.
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const ONE = 10n ** 18n;

// FPY treasury bootstrap — seed the StakingHub with this much FPY so
// claim() doesn't InsufficientFpy on day one. Adjustable via env.
const DEFAULT_FPY_BOOTSTRAP = (process.env.FYPHERX_FPY_BOOTSTRAP_WEI
  ? BigInt(process.env.FYPHERX_FPY_BOOTSTRAP_WEI)
  : 100_000n * ONE);

// MockConcreteAdapter simulated APY (4% by default — readable in basis points).
const DEFAULT_MOCK_CONCRETE_APY_BPS = process.env.FYPHERX_MOCK_CONCRETE_APY_BPS
  ? Number(process.env.FYPHERX_MOCK_CONCRETE_APY_BPS)
  : 400;

// FPY emission rate per block. Conservative testnet default —
// mainnet number is set by tokenomics committee, not here.
const DEFAULT_FPY_PER_BLOCK = process.env.FYPHERX_FPY_PER_BLOCK_WEI
  ? BigInt(process.env.FYPHERX_FPY_PER_BLOCK_WEI)
  : ONE / 100n;   // 0.01 FPY/block ≈ 0.01 / 3s = ~280 FPY/day on BSC

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Phase 1 deploy — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployer:        ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:         ${ethers.formatEther(balance)} (native)`);
  console.log("");

  // ── 1. Load existing addresses (must include SettingManagement, RUSD, FYUSD, FYP, USDT, USDC) ──
  let addrs;
  try {
    addrs = addresses.load(chainId);
  } catch (e) {
    console.error(`Cannot load addresses for chainId ${chainId}: ${e.message}`);
    console.error("This script requires Stage 4 contracts to already be deployed.");
    process.exit(1);
  }
  for (const required of ["SettingManagement", "RUSD", "FYUSD", "FYP", "USDT", "USDC"]) {
    if (!addrs[required]) {
      console.error(`Required address missing from addresses/${chainId}.json: ${required}`);
      process.exit(1);
    }
  }
  const settingMgmtAddr = addrs.SettingManagement;
  console.log(`SettingManagement:    ${settingMgmtAddr}`);
  console.log(`RUSD / FYUSD / FYP:   ${addrs.RUSD} / ${addrs.FYUSD} / ${addrs.FYP}`);
  console.log(`USDT / USDC:          ${addrs.USDT} / ${addrs.USDC}`);
  console.log("");

  // ── 2. MockConcreteAdapter (BSC-only — ADR-006) ──
  if (!addrs.MockConcreteAdapter) {
    console.log("── Deploy MockConcreteAdapter ──");
    const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
    const adapter = await MockAdapter.deploy(addrs.FYUSD, DEFAULT_MOCK_CONCRETE_APY_BPS);
    await adapter.waitForDeployment();
    addrs.MockConcreteAdapter = await adapter.getAddress();
    console.log(`  ✓ MockConcreteAdapter @ ${addrs.MockConcreteAdapter}  (apy = ${DEFAULT_MOCK_CONCRETE_APY_BPS} bps)`);
  } else {
    console.log(`  ✓ MockConcreteAdapter already deployed @ ${addrs.MockConcreteAdapter}`);
  }

  // ── 3. FypherBurnQueue (S1.1) ──
  if (!addrs.FypherBurnQueue) {
    console.log("── Deploy FypherBurnQueue ──");
    const BurnQueue = await ethers.getContractFactory("FypherBurnQueue");
    const burnQueue = await upgrades.deployProxy(
      BurnQueue,
      [settingMgmtAddr, addrs.RUSD, deployer.address /* backendSigner */],
      { initializer: "initialize", kind: "transparent" },
    );
    await burnQueue.waitForDeployment();
    addrs.FypherBurnQueue = await burnQueue.getAddress();
    console.log(`  ✓ FypherBurnQueue @ ${addrs.FypherBurnQueue}`);
  } else {
    console.log(`  ✓ FypherBurnQueue already deployed @ ${addrs.FypherBurnQueue}`);
  }

  // ── 4. FyusdEpochSettlement (S1.3) ──
  if (!addrs.FyusdEpochSettlement) {
    console.log("── Deploy FyusdEpochSettlement ──");
    const EpochSettlement = await ethers.getContractFactory("FyusdEpochSettlement");
    const epoch = await upgrades.deployProxy(
      EpochSettlement,
      [settingMgmtAddr, addrs.FYUSD, deployer.address, deployer.address],
      { initializer: "initialize", kind: "transparent" },
    );
    await epoch.waitForDeployment();
    addrs.FyusdEpochSettlement = await epoch.getAddress();
    console.log(`  ✓ FyusdEpochSettlement @ ${addrs.FyusdEpochSettlement}`);
  } else {
    console.log(`  ✓ FyusdEpochSettlement already deployed @ ${addrs.FyusdEpochSettlement}`);
  }

  // ── 5. FypherStakingHub (S1.4) ──
  if (!addrs.FypherStakingHub) {
    console.log("── Deploy FypherStakingHub ──");
    const Hub = await ethers.getContractFactory("FypherStakingHub");
    const hub = await upgrades.deployProxy(
      Hub,
      [settingMgmtAddr, addrs.FYP, DEFAULT_FPY_PER_BLOCK],
      { initializer: "initialize", kind: "transparent" },
    );
    await hub.waitForDeployment();
    addrs.FypherStakingHub = await hub.getAddress();
    console.log(`  ✓ FypherStakingHub @ ${addrs.FypherStakingHub}  (fpyPerBlock = ${DEFAULT_FPY_PER_BLOCK})`);
  } else {
    console.log(`  ✓ FypherStakingHub already deployed @ ${addrs.FypherStakingHub}`);
  }

  // ── 6. FyusdYieldVault (S1.5) ──
  if (!addrs.FyusdYieldVault) {
    console.log("── Deploy FyusdYieldVault ──");
    const Vault = await ethers.getContractFactory("FyusdYieldVault");
    const vault = await upgrades.deployProxy(
      Vault,
      [settingMgmtAddr, addrs.FYUSD, addrs.MockConcreteAdapter, deployer.address /* admin */],
      { initializer: "initialize", kind: "transparent" },
    );
    await vault.waitForDeployment();
    addrs.FyusdYieldVault = await vault.getAddress();
    console.log(`  ✓ FyusdYieldVault @ ${addrs.FyusdYieldVault}  (adapter = ${addrs.MockConcreteAdapter})`);
  } else {
    console.log(`  ✓ FyusdYieldVault already deployed @ ${addrs.FyusdYieldVault}`);
  }

  // ── 7. FypherCircuitBreaker (S1.6) ──
  if (!addrs.FypherCircuitBreaker) {
    console.log("── Deploy FypherCircuitBreaker ──");
    const Breaker = await ethers.getContractFactory("FypherCircuitBreaker");
    const breaker = await upgrades.deployProxy(
      Breaker,
      [settingMgmtAddr, deployer.address /* watchdog EOA */],
      { initializer: "initialize", kind: "transparent" },
    );
    await breaker.waitForDeployment();
    addrs.FypherCircuitBreaker = await breaker.getAddress();
    console.log(`  ✓ FypherCircuitBreaker @ ${addrs.FypherCircuitBreaker}  (watchdog = ${deployer.address})`);
  } else {
    console.log(`  ✓ FypherCircuitBreaker already deployed @ ${addrs.FypherCircuitBreaker}`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Permission + initial-state wire-up");
  console.log("═══════════════════════════════════════════════════════");

  // ── Wire 1: FYUSD setMinter -> EpochSettlement ──
  // CAUTION: FYUSD is upgradeable; setMinter requires owner. Owner
  // should be the deployer (per the original FYUSD initialize call).
  // If the owner has been transferred to a multisig already, this
  // will revert and the operator must execute it from the multisig
  // separately. The script logs + continues so other wiring still
  // happens.
  await tryTx("FYUSD.setMinter -> FyusdEpochSettlement", async () => {
    const fyusd = await ethers.getContractAt("FYUSD", addrs.FYUSD);
    const currentMinter = await fyusd.minter();
    if (currentMinter.toLowerCase() === addrs.FyusdEpochSettlement.toLowerCase()) {
      return "  ✓ already set";
    }
    const tx = await fyusd.setMinter(addrs.FyusdEpochSettlement);
    await tx.wait();
    return `  ✓ set (was ${currentMinter})`;
  });

  // ── Wire 2: StakingHub.addPool(RUSD, 10000) — pool 0 ──
  await tryTx("StakingHub.addPool(RUSD, 10000)  [pool 0, 1x]", async () => {
    const hub = await ethers.getContractAt("FypherStakingHub", addrs.FypherStakingHub);
    const len = await hub.poolsLength();
    if (Number(len) >= 1) {
      const info = await hub.poolInfo(0);
      if (info.underlying.toLowerCase() === addrs.RUSD.toLowerCase()) return "  ✓ pool 0 already RUSD";
      throw new Error(`pool 0 underlying mismatch: got ${info.underlying}, expected ${addrs.RUSD}`);
    }
    const tx = await hub.addPool(addrs.RUSD, 10_000);
    await tx.wait();
    return "  ✓ added";
  });

  // ── Wire 3: StakingHub.addPool(FYUSD, 20000) — pool 1, 2x ──
  await tryTx("StakingHub.addPool(FYUSD, 20000) [pool 1, 2x]", async () => {
    const hub = await ethers.getContractAt("FypherStakingHub", addrs.FypherStakingHub);
    const len = await hub.poolsLength();
    if (Number(len) >= 2) {
      const info = await hub.poolInfo(1);
      if (info.underlying.toLowerCase() === addrs.FYUSD.toLowerCase()) return "  ✓ pool 1 already FYUSD";
      throw new Error(`pool 1 underlying mismatch`);
    }
    const tx = await hub.addPool(addrs.FYUSD, 20_000);
    await tx.wait();
    return "  ✓ added";
  });

  // ── Wire 4a: FypherMinting full setup (assets + signer + custodian) ──
  // Three separate rows on FypherMinting that the original Phase-1
  // wiring forgot to populate. Each missing row produces a
  // distinctive on-chain revert when the customer attempts to mint:
  //
  //   - supportedAssets[asset]      ← UnsupportedAsset()    0x24a01144
  //   - backendSigner               ← InvalidSignature()    0x8baa579f
  //   - custodianAddresses[dest]    ← InvalidRoute()        0x84e505d2
  //
  // Defaults below are dev-cluster appropriate (gateway-EOA from
  // BACKEND_SIGNER_PRIVATE_KEY; deployer EOA as the temporary
  // custodian). Override via env when re-running on mainnet:
  //   GATEWAY_SIGNER=0x... GATEWAY_CUSTODIAN=0x... npx hardhat run …
  const GATEWAY_SIGNER    = process.env.GATEWAY_SIGNER    || "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
  const GATEWAY_CUSTODIAN = process.env.GATEWAY_CUSTODIAN || (await ethers.getSigners())[0].address;

  for (const [assetSym, assetAddr] of [["USDT", addrs.USDT], ["USDC", addrs.USDC]]) {
    await tryTx(`FypherMinting.addSupportedAsset(${assetSym})`, async () => {
      const minting = await ethers.getContractAt("FypherMinting", addrs.FypherMinting);
      const already = await minting.supportedAssets(assetAddr);
      if (already) return "  ✓ already supported";
      const tx = await minting.addSupportedAsset(assetAddr);
      await tx.wait();
      return "  ✓ added";
    });
  }
  await tryTx(`FypherMinting.setBackendSigner(${GATEWAY_SIGNER})`, async () => {
    const minting = await ethers.getContractAt("FypherMinting", addrs.FypherMinting);
    const cur = await minting.backendSigner();
    if (cur.toLowerCase() === GATEWAY_SIGNER.toLowerCase()) return "  ✓ already set";
    const tx = await minting.setBackendSigner(GATEWAY_SIGNER);
    await tx.wait();
    return `  ✓ set (was ${cur})`;
  });
  await tryTx(`FypherMinting.addCustodianAddress(${GATEWAY_CUSTODIAN})`, async () => {
    const minting = await ethers.getContractAt("FypherMinting", addrs.FypherMinting);
    const already = await minting.custodianAddresses(GATEWAY_CUSTODIAN);
    if (already) return "  ✓ already registered";
    const tx = await minting.addCustodianAddress(GATEWAY_CUSTODIAN);
    await tx.wait();
    return "  ✓ added";
  });

  // ── Wire 4b: BurnQueue + EpochSettlement supported assets ──
  for (const [assetSym, assetAddr] of [["USDT", addrs.USDT], ["USDC", addrs.USDC]]) {
    await tryTx(`BurnQueue.setSupportedAsset(${assetSym}, true)`, async () => {
      const burnQueue = await ethers.getContractAt("FypherBurnQueue", addrs.FypherBurnQueue);
      const already = await burnQueue.supportedAssets(assetAddr);
      if (already) return "  ✓ already supported";
      const tx = await burnQueue.setSupportedAsset(assetAddr, true);
      await tx.wait();
      return "  ✓ added";
    });
    await tryTx(`EpochSettlement.setSupportedAsset(${assetSym}, true)`, async () => {
      const epoch = await ethers.getContractAt("FyusdEpochSettlement", addrs.FyusdEpochSettlement);
      const already = await epoch.supportedAssets(assetAddr);
      if (already) return "  ✓ already supported";
      const tx = await epoch.setSupportedAsset(assetAddr, true);
      await tx.wait();
      return "  ✓ added";
    });
  }

  // ── Wire 5: pauserRole on each pause-bearing contract ──
  // For testnet phase 1.0 the breaker IS the pauser on each target —
  // breaker.trip() then issues batched pauses across multiple
  // contracts. (Per ADR-008. Mainnet adds a separate watchdog EOA.)
  //
  // Note: FypherBurnQueue does NOT have a pauserRole — its
  // setBurnPaused is direct admin-only (the per-asset pause IS the
  // pause primitive; no carve-out in S1.1). To include burn-paused
  // flips in a CircuitBreaker.trip() the breaker must hold admin
  // role on SettingManagement directly, which lands as part of
  // S1.7 multisig migration.
  const pauseTargets = [
    ["StakingHub",      "FypherStakingHub",     addrs.FypherStakingHub],
    ["EpochSettlement", "FyusdEpochSettlement", addrs.FyusdEpochSettlement],
    ["YieldVault",      "FyusdYieldVault",      addrs.FyusdYieldVault],
  ];
  for (const [name, factory, addr] of pauseTargets) {
    await tryTx(`${name}.setPauserRole(CircuitBreaker)`, async () => {
      const c = await ethers.getContractAt(factory, addr);
      const current = await c.pauserRole();
      if (current.toLowerCase() === addrs.FypherCircuitBreaker.toLowerCase()) return "  ✓ already set";
      const tx = await c.setPauserRole(addrs.FypherCircuitBreaker);
      await tx.wait();
      return `  ✓ set (was ${current === ethers.ZeroAddress ? "0x0" : current})`;
    });
  }

  // ── 8. Persist addresses ──
  console.log("");
  addresses.save(chainId, addrs);
  console.log(`✓ Wrote addresses/${chainId}.json (mirrored to deployed-addresses.json)`);

  // ── 9. Summary ──
  const finalBal = await ethers.provider.getBalance(deployer.address);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DONE — Gas spent: ${ethers.formatEther(balance - finalBal)} (native)`);
  console.log("═══════════════════════════════════════════════════════");
  for (const k of [
    "MockConcreteAdapter", "FypherBurnQueue", "FyusdEpochSettlement",
    "FypherStakingHub", "FyusdYieldVault", "FypherCircuitBreaker",
  ]) {
    console.log(`  ${k.padEnd(24)}  ${addrs[k]}`);
  }

  console.log("");
  console.log("Next steps");
  console.log("──────────");
  console.log("1. Bootstrap the StakingHub FPY treasury:");
  console.log(`     # FYP transfer from deployer + hub.fundFpy(${DEFAULT_FPY_BOOTSTRAP})`);
  console.log("   (or run scripts/bootstrap-fpy-treasury.js — followup)");
  console.log("");
  console.log("2. Sync addresses to backend + admin + frontend:");
  console.log("     node scripts/sync-addresses.js");
  console.log("");
  console.log("3. Enable the Phase 1 services in backend env:");
  console.log("     FYPHERX_BURN_QUEUE_ADDRESS         = " + addrs.FypherBurnQueue);
  console.log("     FYPHERX_STAKING_HUB_ADDRESS        = " + addrs.FypherStakingHub);
  console.log("     FYPHERX_EPOCH_SETTLEMENT_ADDRESS   = " + addrs.FyusdEpochSettlement);
  console.log("     FYPHERX_YIELD_VAULT_ADDRESS        = " + addrs.FyusdYieldVault);
  console.log("   Then optionally:");
  console.log("     FYPHERX_BURN_QUEUE_DAEMON_ENABLED  = true");
  console.log("     FYPHERX_AUDIT_INDEXER_ENABLED      = true");
  console.log("     FYPHERX_EPOCH_SCHEDULER_ENABLED    = true");
  console.log("");
  console.log("4. Upgrade FypherMinting + FYUSD impls (separate scripts):");
  console.log("     scripts/upgrade-minting-impl.js   (S1.2 per-asset pause)");
  console.log("     scripts/upgrade-fyusd-impl.js     (S1.3a emergencyMint)");
  console.log("");
}

/**
 * Wraps a single wire-up step. Logs label, runs the lambda, prints
 * the lambda's return string. Catches + logs errors so a single
 * permission glitch doesn't tank the whole script — operator can
 * re-run idempotently.
 */
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
