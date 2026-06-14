/**
 * deploy-fyusd-earn-vault.js — deploy the 70:30 Earn blend vault + its
 * stablecoin Concrete adapter (PRODUCT-FLOWS C-4 / C-5). The collateral
 * stablecoin is USDT on the HOODI test integration (USDC or USDT in prod);
 * the contracts are asset-agnostic, so it's purely a deploy parameter.
 *
 * Deploys, in the only order that satisfies the contracts' constraints:
 *
 *   1. FyusdEarnVault proxy — UNINITIALIZED. The adapter's vault binding
 *      is immutable, so we need the vault's (proxy) address before we can
 *      construct the adapter; and the vault's initialize() needs the
 *      adapter address. We break the cycle by deploying the proxy without
 *      running initialize, then initializing it last.
 *   2. ConcreteStableAdapter(stablecoin, concreteVault, vaultProxyAddr).
 *   3. vault.initialize(SettingManagement, stablecoin, adapter, admin).
 *   4. (best-effort) if the deployer is the SettingManagement admin: set
 *      the keeper + the 14-day `vFyusdEarnCooldown` pool config so a dev
 *      deploy is turnkey. On mainnet (admin = Safe) these are printed as
 *      runbook steps instead.
 *
 * Chain-agnostic (per "체인 파라미터화 필수"): works on any network whose
 * addresses/<chainId>.json carries the stablecoin + SettingManagement. On
 * HOODI the Concrete test vault + test-USDT defaults are baked in; on other
 * chains you supply the Concrete Earn vault (CONCRETE_VAULT_ADDRESS).
 *
 * Deliberately NOT done here (separate, gated — see the printed runbook):
 *   - Whitelisting THIS adapter in Concrete's Earn V2 Hook system.
 *   - Granting the vault's KEEPER to the backend hot wallet if admin = Safe.
 *   - The external security audit gate before any mainnet money flows.
 *
 * Usage (HOODI — Concrete test vault + test-USDT defaults baked in):
 *   source .env.hoodi-deployer
 *   KEEPER_ADDRESS=0x<backend hot wallet> \
 *     npx hardhat run scripts/deploy-fyusd-earn-vault.js --network hoodi
 *
 * Other chains: also pass CONCRETE_VAULT_ADDRESS=0x<Concrete Earn V2 vault>
 * and STABLE_ADDRESS=0x<its deposit asset>.
 *
 * Optional overrides:
 *   STABLE_ADDRESS (or legacy USDC_ADDRESS) / SETTING_MANAGEMENT_ADDRESS
 *   CONCRETE_VAULT_ADDRESS (or legacy CONCRETE_USDC_VAULT_ADDRESS)
 *   ADMIN_ADDRESS  (default: addrs.OperatorSafe if set, else the deployer)
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const FOURTEEN_DAYS = 14n * 24n * 60n * 60n;
const COOLDOWN_KEY = "vFyusdEarnCooldown";
const ADMIN_ROLE = ethers.ZeroHash; // SingleAdminAccessControl: role 0 == admin

const ERC4626_ABI = ["function asset() view returns (address)"];
const SETTING_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getPoolConfigs(string key) view returns (uint256)",
  "function setPoolConfigs(string key, uint256 value)",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — source the target chain's deployer env first?");

  const addrs = addresses.load(chainId);
  // Concrete HOODI test integration (provided 2026-05-08 by the Concrete team,
  // verified on-chain): vault proxy below; deposit asset = test USDT (6-dec);
  // async vault with the withdrawal queue OFF → behaves atomically for now.
  const isHoodi = chainId === 560048;
  const HOODI_CONCRETE_VAULT  = "0x970b36501775b6f5f58d7ab6e1cda3c317550cf8";
  const HOODI_CONCRETE_STABLE = "0x6f4c66aE43C2F35668F54486AadeCB91Dd424127"; // test USDT

  // The collateral stablecoin the Concrete vault accepts (USDT on HOODI test;
  // USDC or USDT in prod). STABLE_ADDRESS is primary; USDC_ADDRESS kept for back-compat.
  const STABLE = process.env.STABLE_ADDRESS || process.env.USDC_ADDRESS
    || (isHoodi ? HOODI_CONCRETE_STABLE : addrs.USDC);
  const SETTING = process.env.SETTING_MANAGEMENT_ADDRESS || addrs.SettingManagement;
  // The Concrete Earn V2 ERC-4626 vault. CONCRETE_VAULT_ADDRESS is primary;
  // CONCRETE_USDC_VAULT_ADDRESS kept for back-compat; HOODI test default baked in.
  const CONCRETE = process.env.CONCRETE_VAULT_ADDRESS || process.env.CONCRETE_USDC_VAULT_ADDRESS
    || (isHoodi ? HOODI_CONCRETE_VAULT : undefined);
  const ADMIN = process.env.ADMIN_ADDRESS || addrs.OperatorSafe || deployer.address;
  const KEEPER = process.env.KEEPER_ADDRESS || "";

  if (!STABLE || !ethers.isAddress(STABLE)) throw new Error("stablecoin address (STABLE_ADDRESS) missing/invalid");
  if (!SETTING || !ethers.isAddress(SETTING)) throw new Error("SettingManagement address missing/invalid");
  if (!ADMIN || !ethers.isAddress(ADMIN)) throw new Error("ADMIN address missing/invalid");
  if (!CONCRETE || !ethers.isAddress(CONCRETE)) {
    throw new Error(
      "CONCRETE_VAULT_ADDRESS env must be the Concrete Earn V2 ERC-4626 vault whose deposit " +
      "asset == the stablecoin. The 30% leg cannot deposit without it.");
  }
  if (KEEPER && !ethers.isAddress(KEEPER)) throw new Error("KEEPER_ADDRESS invalid");

  console.log("Chain id:            ", chainId);
  console.log("Deployer:            ", deployer.address);
  console.log("Stablecoin:          ", STABLE);
  console.log("SettingManagement:   ", SETTING);
  console.log("Concrete vault:      ", CONCRETE);
  console.log("Admin (Safe/EOA):    ", ADMIN);
  console.log("Keeper (backend):    ", KEEPER || "(set later via setKeeper)");

  // ── Pre-flight 1: Concrete vault asset() must equal the stablecoin (else
  //    the adapter constructor reverts AdapterAssetMismatch). ──
  const concrete = new ethers.Contract(CONCRETE, ERC4626_ABI, deployer);
  let concreteAsset;
  try {
    concreteAsset = await concrete.asset();
  } catch (e) {
    throw new Error(`Could not read asset() on ${CONCRETE} — is it a standard ERC-4626? (${e.message})`);
  }
  if (concreteAsset.toLowerCase() !== STABLE.toLowerCase()) {
    throw new Error(
      `Concrete vault asset() = ${concreteAsset} but our stablecoin = ${STABLE}. ` +
      `Adapter constructor would revert AdapterAssetMismatch.`);
  }
  console.log("✅ pre-flight: Concrete vault asset() == stablecoin");

  // ── Pre-flight 2: admin must already hold the SettingManagement admin
  //    role (vault.initialize enforces this). ──
  const setting = new ethers.Contract(SETTING, SETTING_ABI, deployer);
  const adminOk = await setting.hasRole(ADMIN_ROLE, ADMIN);
  if (!adminOk) {
    throw new Error(
      `ADMIN ${ADMIN} is NOT the SettingManagement admin. ` +
      `vault.initialize would revert AdminMismatch. Pass ADMIN_ADDRESS = the current SM admin.`);
  }
  console.log("✅ pre-flight: ADMIN holds the SettingManagement admin role");

  // ── 1. Vault proxy, uninitialized ──
  const Vault = await ethers.getContractFactory("FyusdEarnVault");
  const vault = await upgrades.deployProxy(Vault, [], { initializer: false, kind: "transparent" });
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("✅ FyusdEarnVault proxy deployed:", vaultAddr);

  // ── 2. Adapter bound to the vault ──
  const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
  const adapter = await Adapter.deploy(STABLE, CONCRETE, vaultAddr);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("✅ ConcreteStableAdapter deployed:", adapterAddr);

  // ── 3. Initialize the vault ──
  await (await vault.initialize(SETTING, STABLE, adapterAddr, ADMIN)).wait();
  console.log("✅ FyusdEarnVault initialized (admin =", ADMIN + ")");

  // ── 4. Turnkey config IF the deployer is the SM admin (dev). On mainnet
  //    the admin is the Safe → these become runbook steps. ──
  const deployerIsAdmin = await setting.hasRole(ADMIN_ROLE, deployer.address);
  let keeperSet = false;
  let cooldownSet = false;

  if (deployerIsAdmin) {
    const existingCd = await setting.getPoolConfigs(COOLDOWN_KEY);
    if (existingCd === 0n) {
      await (await setting.setPoolConfigs(COOLDOWN_KEY, FOURTEEN_DAYS)).wait();
      cooldownSet = true;
      console.log(`✅ set ${COOLDOWN_KEY} = ${FOURTEEN_DAYS}s (14d)`);
    } else {
      console.log(`ℹ ${COOLDOWN_KEY} already = ${existingCd}s — left as-is`);
    }
    if (KEEPER) {
      await (await vault.setKeeper(KEEPER)).wait();
      keeperSet = true;
      console.log("✅ setKeeper:", KEEPER);
    }
  } else {
    console.log("ℹ deployer is not the SM admin — keeper + cooldown must be set via the admin (Safe).");
  }

  // ── Record ──
  addrs.FyusdEarnVault = vaultAddr;
  addrs.ConcreteStableAdapter = adapterAddr;
  addrs.ConcreteUsdcVault = CONCRETE;
  addresses.save(chainId, addrs);
  console.log(`✓ Wrote addresses/${chainId}.json (FyusdEarnVault + ConcreteStableAdapter + ConcreteUsdcVault)`);

  console.log("\n──────────────── NEXT (NOT done by this script) ────────────────");
  console.log(`1. Concrete whitelists THIS adapter in their Earn V2 Hook:\n     ${adapterAddr}`);
  if (!cooldownSet) {
    console.log(`2. Admin sets the cooldown: SettingManagement.setPoolConfigs("${COOLDOWN_KEY}", ${FOURTEEN_DAYS})`);
  }
  if (!keeperSet) {
    console.log(`3. Admin grants the keeper: FyusdEarnVault.setKeeper(<backend hot wallet>)`);
  }
  console.log("4. Admin sets a pauser guardian: FyusdEarnVault.setPauserRole(<guardian>)");
  console.log("5. Confirm Concrete is STANDARD (atomic) withdrawal mode — the adapter assumes it.");
  console.log("6. ⚠ AUDIT GATE: FyusdEarnVault is audit-critical (C-4). No mainnet money flows pre-audit.");
  console.log("7. Backend: point fypherx.earn.vault-address + adapter at the addresses above.");
  console.log("────────────────────────────────────────────────────────────────");
}

main().catch((e) => { console.error(e); process.exit(1); });
