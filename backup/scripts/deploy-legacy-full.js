const { ethers, upgrades, network } = require("hardhat");
const addresses = require("./lib/addresses");

// MockERC20 must never be deployed to a real production network — minting to
// deployer is unrestricted and deploying these tokens on mainnet would brick
// state (real users could be tricked into transacting against fake collateral).
// Restrict to local and BSC Testnet only.
const ALLOWED_MOCK_NETWORKS = ["hardhat", "localhost", "bscTestnet"];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  FYPHER PROTOCOL — Full Deploy (Original Source)");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "BNB\n");

  const deployed = {};
  const tx = (label) => console.log(`  ✓ ${label}`);

  // ── 1. SettingManagement ──
  console.log("── 1. SettingManagement ──");
  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const settingMgmt = await upgrades.deployProxy(SettingManagement, [deployer.address]);
  await settingMgmt.waitForDeployment();
  deployed.SettingManagement = await settingMgmt.getAddress();
  tx(deployed.SettingManagement);

  // ── 2. Tokens ──
  console.log("\n── 2. Tokens ──");
  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address]);
  await rusd.waitForDeployment();
  deployed.RUSD = await rusd.getAddress();
  tx("RUSD " + deployed.RUSD);

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address]);
  await fyusd.waitForDeployment();
  deployed.FYUSD = await fyusd.getAddress();
  tx("FYUSD " + deployed.FYUSD);

  const FYPFactory = await ethers.getContractFactory("FYP");
  const fyp = await upgrades.deployProxy(FYPFactory, [deployer.address]);
  await fyp.waitForDeployment();
  deployed.FYP = await fyp.getAddress();
  tx("FYP " + deployed.FYP);

  const InstitutionalRUSD = await ethers.getContractFactory("InstitutionalRUSD");
  const irusd = await upgrades.deployProxy(InstitutionalRUSD, [deployer.address]);
  await irusd.waitForDeployment();
  deployed.iRUSD = await irusd.getAddress();
  tx("iRUSD " + deployed.iRUSD);

  // ── 3. Mock Collaterals ──
  console.log("\n── 3. Collaterals ──");
  if (!ALLOWED_MOCK_NETWORKS.includes(network.name)) {
    throw new Error(
      `MockERC20 deployment forbidden on network "${network.name}". ` +
      `Allowed networks: ${ALLOWED_MOCK_NETWORKS.join(", ")}. ` +
      `On production networks, wire real collateral token addresses into the config instead.`
    );
  }
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  for (const name of ["USDT", "USDC", "WETH", "BTC", "BNB"]) {
    const mock = await MockERC20.deploy(name, name, 18);
    await mock.waitForDeployment();
    deployed[name] = await mock.getAddress();
    tx(name + " " + deployed[name]);
  }

  // ── 4. ReservePool ──
  console.log("\n── 4. ReservePool ──");
  const ReservePool = await ethers.getContractFactory("ReservePool");
  const reservePool = await ReservePool.deploy(deployed.SettingManagement);
  await reservePool.waitForDeployment();
  deployed.ReservePool = await reservePool.getAddress();
  tx(deployed.ReservePool);

  // ── 5. Staking Vaults ──
  console.log("\n── 5. Staking Vaults ──");

  // StakedRUSD (3 params: rusd, settingManagement, admin)
  const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
  const stakedRUSD = await upgrades.deployProxy(
    StakedRUSD,
    [deployed.RUSD, deployed.SettingManagement, deployer.address],
    { unsafeAllow: ["delegatecall"] }
  );
  await stakedRUSD.waitForDeployment();
  deployed.StakedRUSD = await stakedRUSD.getAddress();
  deployed.RUSDSilo = await stakedRUSD.silo();
  tx("StakedRUSD " + deployed.StakedRUSD);
  tx("  └─ RUSDSilo " + deployed.RUSDSilo);

  // StakedIRUSD — needs SIRUSDSilo (deploy silo with deployer as temp vault)
  const SIRUSDSilo = await ethers.getContractFactory("SIRUSDSilo");
  const sirusdSilo = await SIRUSDSilo.deploy(deployer.address);
  await sirusdSilo.waitForDeployment();
  deployed.SIRUSDSilo = await sirusdSilo.getAddress();

  const StakedIRUSD = await ethers.getContractFactory("StakedIRUSD");
  const stakedIRUSD = await upgrades.deployProxy(
    StakedIRUSD,
    [deployed.iRUSD, deployed.SettingManagement, deployed.SIRUSDSilo],
    { unsafeAllow: ["delegatecall"] }
  );
  await stakedIRUSD.waitForDeployment();
  deployed.StakedIRUSD = await stakedIRUSD.getAddress();
  tx("StakedIRUSD " + deployed.StakedIRUSD);
  tx("  └─ SIRUSDSilo " + deployed.SIRUSDSilo);

  // StakedFYP — needs FYPSilo (RUSDSilo pattern)
  const RUSDSilo = await ethers.getContractFactory("RUSDSilo");
  const fypSilo = await RUSDSilo.deploy(deployer.address, deployed.FYP);
  await fypSilo.waitForDeployment();
  deployed.FYPSilo = await fypSilo.getAddress();

  const StakedFYP = await ethers.getContractFactory("StakedFYP");
  const stakedFYP = await upgrades.deployProxy(
    StakedFYP,
    [deployed.FYP, deployed.SettingManagement, deployed.FYPSilo],
    { unsafeAllow: ["delegatecall"] }
  );
  await stakedFYP.waitForDeployment();
  deployed.StakedFYP = await stakedFYP.getAddress();
  tx("StakedFYP " + deployed.StakedFYP);
  tx("  └─ FYPSilo " + deployed.FYPSilo);

  // StakedAUSD — needs stAUSDSilo
  const stausdSilo = await RUSDSilo.deploy(deployer.address, deployed.FYUSD);
  await stausdSilo.waitForDeployment();
  deployed.stAUSDSilo = await stausdSilo.getAddress();

  const StakedAUSD = await ethers.getContractFactory("StakedAUSD");
  const stakedAUSD = await upgrades.deployProxy(
    StakedAUSD,
    [deployed.FYUSD, deployed.SettingManagement, deployed.stAUSDSilo],
    { unsafeAllow: ["delegatecall"] }
  );
  await stakedAUSD.waitForDeployment();
  deployed.stAUSD = await stakedAUSD.getAddress();
  tx("stAUSD " + deployed.stAUSD);
  tx("  └─ stAUSDSilo " + deployed.stAUSDSilo);

  // iRUSD Silo
  const irusdSilo = await RUSDSilo.deploy(deployed.stAUSD, deployed.iRUSD);
  await irusdSilo.waitForDeployment();
  deployed.iRUSDSilo = await irusdSilo.getAddress();
  tx("  └─ iRUSDSilo " + deployed.iRUSDSilo);

  // ── 6. FypherMinting ──
  console.log("\n── 6. FypherMinting ──");
  // Original source: initialize(settingManagement, rusd, signer, executor)
  const FypherMinting = await ethers.getContractFactory("FypherMinting");
  const minting = await upgrades.deployProxy(
    FypherMinting,
    [deployed.SettingManagement, deployed.RUSD, deployer.address, deployer.address],
    { unsafeAllow: ["delegatecall"] }
  );
  await minting.waitForDeployment();
  deployed.FypherMinting = await minting.getAddress();
  tx(deployed.FypherMinting);

  // ── 7. Configuration ──
  console.log("\n── 7. Config ──");

  // RUSD minter → FypherMinting
  await (await rusd.setMinter(deployed.FypherMinting)).wait();
  tx("RUSD minter → FypherMinting");

  // Register collateral assets
  for (const name of ["USDT", "USDC", "WETH", "BTC", "BNB"]) {
    await (await minting.addSupportedAsset(deployed[name])).wait();
  }
  tx("5 collateral assets registered");

  // Add deployer as custodian
  await (await minting.addCustodianAddress(deployer.address)).wait();
  tx("Custodian: deployer");

  // Add ReservePool as custodian
  await (await minting.addCustodianAddress(deployed.ReservePool)).wait();
  tx("Custodian: ReservePool");

  // Set reserve pool in SettingManagement
  await (await settingMgmt.setReservePool(deployed.ReservePool)).wait();
  tx("Reserve pool linked");

  // Set cooldown duration (7 days)
  await (await settingMgmt.setPoolConfigs("cooldownDuration", 7 * 24 * 60 * 60)).wait();
  tx("Cooldown: 7 days");

  // Set reserve target (3%)
  await (await settingMgmt.setReserveTarget(300)).wait();
  tx("Reserve target: 3%");

  // Set fee receiver
  await (await settingMgmt.setFeeReceiver(deployer.address)).wait();
  tx("Fee receiver → deployer");

  // ── 8. Test Tokens ──
  console.log("\n── 8. Test Tokens ──");
  const amt = ethers.parseUnits("10000", 18);
  for (const name of ["USDC", "USDT"]) {
    const token = await ethers.getContractAt("MockERC20", deployed[name]);
    await (await token.mint(deployer.address, amt)).wait();
    tx(`${name}: 10,000`);
  }

  // ── Summary ──
  const finalBalance = await ethers.provider.getBalance(deployer.address);
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  DONE — Gas:", ethers.formatEther(balance - finalBalance), "BNB");
  console.log("  Contracts:", Object.keys(deployed).length);
  console.log("═══════════════════════════════════════════════════════");
  for (const [k, v] of Object.entries(deployed)) console.log(`  ${k.padEnd(20)} ${v}`);

  // ADR-010: per-chain addresses are the source of truth. The legacy
  // deployed-addresses.json is mirrored for back-compat with the dozen+
  // existing scripts that read it directly.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  addresses.save(chainId, deployed);
  console.log(`\nSaved to addresses/${chainId}.json (mirrored to deployed-addresses.json)`);
}

module.exports = main;

// When run directly via `npx hardhat run scripts/deploy.js`, fire main().
// When required by a per-network entrypoint, the entrypoint awaits main().
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
