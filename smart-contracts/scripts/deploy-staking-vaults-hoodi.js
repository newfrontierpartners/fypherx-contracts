/**
 * Deploy the cooldown-vault trio + ReservePool on HOODI so the
 * customer mint→stake flow works end-to-end. The HOODI Phase-0/1
 * deploy intentionally skipped these (the network was set up as the
 * FYUSD-x-Concrete integration smoke), but the {@code /earn} page
 * and the live adapter both expect them to exist on every supported
 * chain, so this script fills the gap.
 *
 * Deploys (idempotent — skips entries already present in
 * addresses/560048.json):
 *
 *   - {@code ReservePool} — direct constructor, no proxy. Holds the
 *     emergency 3% reserve. Becomes the FypherMinting route
 *     destination (replacing the dev-cluster's deployer-EOA stand-in).
 *
 *   - {@code StakedRUSD} (sRUSD) — ERC-4626 cooldown vault, proxy.
 *     Constructor-time creates its own {@code RUSDSilo} so no
 *     chicken-and-egg cycle. Initialize takes RUSD + SettingManagement
 *     + admin EOA.
 *
 *   - {@code StakedAUSD} (stAUSD; underlying = FYUSD) — proxy +
 *     external silo. Cycle broken by the
 *     {@code upgrades.deployProxy(..., { initializer: false })}
 *     pattern: proxy first, silo second (with proxy as STAKING_VAULT),
 *     then call initialize manually.
 *
 *   - {@code StakedFYP} (sFYP) — same pattern as stAUSD.
 *
 * Re-runs are safe — the script reads addresses/<chainId>.json and
 * skips any contract whose address is already populated.
 *
 * Usage:
 *   source .env.hoodi-deployer
 *   npx hardhat run scripts/deploy-staking-vaults-hoodi.js --network hoodi
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const ZERO = "0x0000000000000000000000000000000000000000";

function isSet(v) {
  return v && v !== "" && v !== ZERO;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const addrs = addresses.load(chainId);

  console.log("════════════════════════════════════════════════════════");
  console.log("  HOODI: deploy cooldown vaults + ReservePool");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Deployer:           ${deployer.address}`);
  console.log(`  SettingManagement:  ${addrs.SettingManagement}`);
  console.log(`  RUSD:               ${addrs.RUSD}`);
  console.log(`  FYUSD:              ${addrs.FYUSD}`);
  console.log(`  FYP:                ${addrs.FYP}`);
  console.log("");

  if (!isSet(addrs.SettingManagement) || !isSet(addrs.RUSD)
      || !isSet(addrs.FYUSD) || !isSet(addrs.FYP)) {
    throw new Error("Phase-0 addresses missing. Run deploy-hoodi-phase0.js first.");
  }

  // ── 1. ReservePool ────────────────────────────────────────────
  if (!isSet(addrs.ReservePool)) {
    console.log("── Deploy ReservePool ──");
    const ReservePool = await ethers.getContractFactory("ReservePool");
    const rp = await ReservePool.deploy(addrs.SettingManagement);
    await rp.waitForDeployment();
    addrs.ReservePool = await rp.getAddress();
    console.log(`  ✓ ReservePool @ ${addrs.ReservePool}`);
  } else {
    console.log(`  ✓ ReservePool already deployed @ ${addrs.ReservePool}`);
  }

  // ── 2. StakedRUSD (sRUSD) — embedded silo ─────────────────────
  if (!isSet(addrs.StakedRUSD)) {
    console.log("\n── Deploy StakedRUSD (proxy) ──");
    const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
    const sRusd = await upgrades.deployProxy(
      StakedRUSD,
      [addrs.RUSD, addrs.SettingManagement, deployer.address],
      { initializer: "initialize", kind: "transparent" },
    );
    await sRusd.waitForDeployment();
    addrs.StakedRUSD = await sRusd.getAddress();
    console.log(`  ✓ StakedRUSD @ ${addrs.StakedRUSD}`);

    // The contract creates its own RUSDSilo in initialize() — read it
    // out so we can persist the address for the audit trail.
    const siloAddr = await sRusd.silo();
    addrs.RUSDSilo = siloAddr;
    console.log(`  ✓ RUSDSilo (embedded) @ ${siloAddr}`);
  } else {
    console.log(`\n  ✓ StakedRUSD already deployed @ ${addrs.StakedRUSD}`);
  }

  // ── 3. StakedAUSD (stAUSD; underlying = FYUSD) — external silo ──
  if (!isSet(addrs.stAUSD)) {
    console.log("\n── Deploy StakedAUSD (proxy, deferred init) ──");
    const StakedAUSD = await ethers.getContractFactory("StakedAUSD");
    const stAUSD = await upgrades.deployProxy(
      StakedAUSD,
      [],
      { initializer: false, kind: "transparent" },
    );
    await stAUSD.waitForDeployment();
    const stAUSDAddr = await stAUSD.getAddress();
    console.log(`  ✓ StakedAUSD proxy @ ${stAUSDAddr}`);

    console.log("── Deploy stAUSDSilo (immutable: STAKING_VAULT, TOKEN) ──");
    const RUSDSilo = await ethers.getContractFactory("RUSDSilo");
    const stAUSDSilo = await RUSDSilo.deploy(stAUSDAddr, addrs.FYUSD);
    await stAUSDSilo.waitForDeployment();
    const stAUSDSiloAddr = await stAUSDSilo.getAddress();
    console.log(`  ✓ stAUSDSilo @ ${stAUSDSiloAddr}`);

    console.log("── stAUSD.initialize(FYUSD, SettingManagement, silo) ──");
    const initTx = await stAUSD.initialize(addrs.FYUSD, addrs.SettingManagement, stAUSDSiloAddr);
    await initTx.wait();
    console.log(`     ✓ initialized (tx ${initTx.hash})`);

    addrs.stAUSD = stAUSDAddr;
    addrs.stAUSDSilo = stAUSDSiloAddr;
  } else {
    console.log(`\n  ✓ StakedAUSD already deployed @ ${addrs.stAUSD}`);
  }

  // ── 4. StakedFYP (sFYP) ────────────────────────────────────────
  if (!isSet(addrs.StakedFYP)) {
    console.log("\n── Deploy StakedFYP (proxy, deferred init) ──");
    const StakedFYP = await ethers.getContractFactory("StakedFYP");
    const sFYP = await upgrades.deployProxy(
      StakedFYP,
      [],
      { initializer: false, kind: "transparent" },
    );
    await sFYP.waitForDeployment();
    const sFYPAddr = await sFYP.getAddress();
    console.log(`  ✓ StakedFYP proxy @ ${sFYPAddr}`);

    console.log("── Deploy FYPSilo (immutable: STAKING_VAULT, TOKEN) ──");
    const RUSDSilo = await ethers.getContractFactory("RUSDSilo");
    const fypSilo = await RUSDSilo.deploy(sFYPAddr, addrs.FYP);
    await fypSilo.waitForDeployment();
    const fypSiloAddr = await fypSilo.getAddress();
    console.log(`  ✓ FYPSilo @ ${fypSiloAddr}`);

    console.log("── sFYP.initialize(FYP, SettingManagement, silo) ──");
    const initTx = await sFYP.initialize(addrs.FYP, addrs.SettingManagement, fypSiloAddr);
    await initTx.wait();
    console.log(`     ✓ initialized (tx ${initTx.hash})`);

    addrs.StakedFYP = sFYPAddr;
    addrs.FYPSilo = fypSiloAddr;
  } else {
    console.log(`\n  ✓ StakedFYP already deployed @ ${addrs.StakedFYP}`);
  }

  // ── Save ──────────────────────────────────────────────────────
  addresses.save(chainId, addrs);
  console.log(`\n✓ Wrote addresses/${chainId}.json`);

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Deployed addresses:");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  ReservePool:  ${addrs.ReservePool}`);
  console.log(`  StakedRUSD:   ${addrs.StakedRUSD}`);
  console.log(`  RUSDSilo:     ${addrs.RUSDSilo}`);
  console.log(`  stAUSD:       ${addrs.stAUSD}`);
  console.log(`  stAUSDSilo:   ${addrs.stAUSDSilo}`);
  console.log(`  StakedFYP:    ${addrs.StakedFYP}`);
  console.log(`  FYPSilo:      ${addrs.FYPSilo}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1) Update fypherx-frontend/src/lib/defi/contracts/addresses.ts");
  console.log("     HOODI_CONTRACTS with the StakedRUSD/stAUSD/StakedFYP addresses");
  console.log("  2) Update fypherx-chain-config k8s ConfigMap if backend reads any of these");
  console.log("  3) Re-run scripts/audit-hoodi.js to verify wiring");
}

main().catch((e) => { console.error(e); process.exit(1); });
