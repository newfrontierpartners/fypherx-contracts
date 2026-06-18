/**
 * deploy-mainnet-core.js — bootstrap the three core contracts that have NO
 * standalone deploy script of their own: SettingManagement, ReservePool, and
 * FypherCircuitBreaker. These are the prerequisites for the Earn (70:30)
 * money path on a fresh chain, deployed BEFORE
 * scripts/deploy-fyusd-earn-vault.js (which assumes SettingManagement already
 * exists in addresses/<chainId>.json).
 *
 * Until now SettingManagement/ReservePool/CircuitBreaker were only deployed
 * embedded inside the HOODI-gated deploy-hoodi-phase0.js / deploy-staking-
 * vaults-hoodi.js scripts, which also deploy a pile of out-of-scope contracts
 * (RUSD, FYP, FypherMinting, mock USDT/USDC, …) and hard-gate on chainId
 * 560048. This script extracts JUST the three core contracts and is
 * chain-agnostic: it works on mainnet (1), sepolia (11155111), and hoodi
 * (560048) alike. Nothing is gated on chainId.
 *
 * Deploys, in order:
 *
 *   1. SettingManagement (Transparent proxy) — initialize(deployer).
 *      The deployer becomes the single admin (SingleAdminAccessControl).
 *      It is transferred to the Operator Safe LATER via the existing
 *      grant-admin-to-safe.js → accept-admin-from-safe.js two-step. This
 *      script does NOT transfer admin (deliberately — the Earn vault deploy
 *      needs the deployer to still hold the SM admin role to pass its
 *      AdminMismatch pre-flight).
 *   2. ReservePool — constructor(settingManagement). Plain (non-proxy)
 *      deploy; admin checks delegate to SettingManagement.hasRole(0, ...).
 *   3. FypherCircuitBreaker (Transparent proxy) —
 *      initialize(settingManagement, watchdog).
 *
 * After (3), while the deployer is still the SM admin, it wires
 * SettingManagement.setReservePool(reservePool) (onlyAdmin — the deployer
 * holds the admin role right after initialize, so this succeeds).
 *
 * Re-runs are append-only / idempotent: if a contract already exists in
 * addresses/<chainId>.json the script SKIPS its deploy and reuses the
 * recorded address. setReservePool is only sent if the on-chain value
 * differs (the setter itself also no-ops on an unchanged value).
 *
 * What this script does NOT do (printed as runbook steps at the end):
 *   - Transfer SettingManagement admin to the Operator Safe (grant/accept
 *     scripts, run AFTER the Earn vault deploy).
 *   - Deploy the Earn vaults + adapters (deploy-fyusd-earn-vault.js, once
 *     per stablecoin — USDC and USDT).
 *   - Deploy the EarnLockRegistry (deploy-earn-lock-registry.js).
 *   - Set CircuitBreaker triggers / grant it the SM admin role for
 *     registry-level trips (ops decision, post-audit).
 *
 * Required env (.env):
 *   PRIVATE_KEY            deployer EOA for the target network (mainnet uses
 *                          the shared PRIVATE_KEY per hardhat.config.js).
 * Optional env:
 *   WATCHDOG_ADDRESS       circuit-breaker watchdog (an EOA allowed to trip
 *                          pauses). Defaults to the deployer if unset.
 *
 * Usage:
 *   # mainnet (prod):
 *   npx hardhat run scripts/deploy-mainnet-core.js --network mainnet
 *   # testable on hoodi / sepolia too:
 *   npx hardhat run scripts/deploy-mainnet-core.js --network hoodi
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const ADMIN_ROLE = ethers.ZeroHash; // SingleAdminAccessControl: role 0 == admin

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — is PRIVATE_KEY set for this network?");

  const balance = await ethers.provider.getBalance(deployer.address);
  const watchdog = process.env.WATCHDOG_ADDRESS || deployer.address;
  if (!ethers.isAddress(watchdog)) {
    throw new Error(`WATCHDOG_ADDRESS invalid: ${watchdog}`);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Core bootstrap — SettingManagement + ReservePool + CircuitBreaker");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Chain id:   ${chainId}`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log(`Watchdog:   ${watchdog}${watchdog === deployer.address ? " (= deployer)" : ""}`);
  console.log("");

  // load() throws on a chain with no addresses file at all; tolerate a fresh
  // chain by starting from an empty map so a brand-new mainnet deploy works.
  let addrs;
  try {
    addrs = addresses.load(chainId);
  } catch {
    console.log(`(no addresses/${chainId}.json yet — starting fresh)`);
    addrs = {};
  }

  // ── 1. SettingManagement (Transparent proxy) ─────────────────────────
  if (!addrs.SettingManagement) {
    console.log("── Deploy SettingManagement ──");
    const Setting = await ethers.getContractFactory("SettingManagement");
    const setting = await upgrades.deployProxy(
      Setting,
      [deployer.address /* admin */],
      { initializer: "initialize", kind: "transparent" },
    );
    await setting.waitForDeployment();
    addrs.SettingManagement = await setting.getAddress();
    console.log(`  ✓ SettingManagement @ ${addrs.SettingManagement} (admin = deployer)`);
  } else {
    console.log(`  ✓ SettingManagement already deployed @ ${addrs.SettingManagement}`);
  }

  // ── 2. ReservePool (plain, non-proxy) ────────────────────────────────
  if (!addrs.ReservePool) {
    console.log("── Deploy ReservePool ──");
    const Reserve = await ethers.getContractFactory("ReservePool");
    const reserve = await Reserve.deploy(addrs.SettingManagement);
    await reserve.waitForDeployment();
    addrs.ReservePool = await reserve.getAddress();
    console.log(`  ✓ ReservePool @ ${addrs.ReservePool}`);
  } else {
    console.log(`  ✓ ReservePool already deployed @ ${addrs.ReservePool}`);
  }

  // ── 3. FypherCircuitBreaker (Transparent proxy) ──────────────────────
  if (!addrs.FypherCircuitBreaker) {
    console.log("── Deploy FypherCircuitBreaker ──");
    const Breaker = await ethers.getContractFactory("FypherCircuitBreaker");
    const breaker = await upgrades.deployProxy(
      Breaker,
      [addrs.SettingManagement, watchdog],
      { initializer: "initialize", kind: "transparent" },
    );
    await breaker.waitForDeployment();
    addrs.FypherCircuitBreaker = await breaker.getAddress();
    console.log(`  ✓ FypherCircuitBreaker @ ${addrs.FypherCircuitBreaker} (watchdog = ${watchdog})`);
  } else {
    console.log(`  ✓ FypherCircuitBreaker already deployed @ ${addrs.FypherCircuitBreaker}`);
  }

  // ── Record (before the wiring tx, so addresses survive a wiring failure) ──
  addresses.save(chainId, addrs);
  console.log(`\n✓ Wrote addresses/${chainId}.json (SettingManagement + ReservePool + FypherCircuitBreaker)`);

  // ── 4. Wire SettingManagement.setReservePool(reservePool) ────────────
  //     setReservePool is onlyAdmin; the deployer holds the admin role
  //     right after initialize(deployer), so this succeeds while admin has
  //     NOT yet been transferred to the Safe. Idempotent: skip if already
  //     pointed at this ReservePool (the setter also no-ops on no-change).
  const setting = new ethers.Contract(
    addrs.SettingManagement,
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function reservePool() view returns (address)",
      "function setReservePool(address pool)",
    ],
    deployer,
  );

  let reserveWired = false;
  const deployerIsAdmin = await setting.hasRole(ADMIN_ROLE, deployer.address);
  const currentReserve = await setting.reservePool();
  if (currentReserve.toLowerCase() === addrs.ReservePool.toLowerCase()) {
    console.log(`\nℹ SettingManagement.reservePool already = ${addrs.ReservePool} — left as-is`);
    reserveWired = true;
  } else if (deployerIsAdmin) {
    console.log(`\n→ wiring SettingManagement.setReservePool(${addrs.ReservePool})`);
    await (await setting.setReservePool(addrs.ReservePool)).wait();
    console.log(`  ✓ setReservePool done`);
    reserveWired = true;
  } else {
    console.log(
      `\nℹ deployer is NOT the SettingManagement admin — setReservePool must be ` +
      `done by the current admin (the Safe).`,
    );
  }

  // ── Runbook summary ──────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Core bootstrap complete");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  SettingManagement    : ${addrs.SettingManagement}  (admin = deployer)`);
  console.log(`  ReservePool          : ${addrs.ReservePool}`);
  console.log(`  FypherCircuitBreaker : ${addrs.FypherCircuitBreaker}  (watchdog = ${watchdog})`);
  console.log("");
  console.log("  NEXT (NOT done by this script):");
  if (!reserveWired) {
    console.log(`   0. Admin: SettingManagement.setReservePool(${addrs.ReservePool})`);
  }
  console.log("   1. Deploy the Earn vaults + adapters — ONE PER STABLECOIN:");
  console.log("        STABLE_ADDRESS=<USDC> CONCRETE_VAULT_ADDRESS=<Concrete USDC vault> \\");
  console.log("          ADMIN_ADDRESS=<deployer, the current SM admin> \\");
  console.log("          npx hardhat run scripts/deploy-fyusd-earn-vault.js --network <net>");
  console.log("        STABLE_ADDRESS=<USDT> CONCRETE_VAULT_ADDRESS=<Concrete USDT vault> \\");
  console.log("          ADMIN_ADDRESS=<deployer, the current SM admin> \\");
  console.log("          npx hardhat run scripts/deploy-fyusd-earn-vault.js --network <net>");
  console.log("      (deploy-fyusd-earn-vault.js records ONE FyusdEarnVault +");
  console.log("       ConcreteStableAdapter pair into addresses/<chainId>.json; run it");
  console.log("       twice — once per stable — and capture both pairs of addresses,");
  console.log("       since the registry holds a single key per name.)");
  console.log("   2. Deploy the EarnLockRegistry:");
  console.log("        RELAYER_ADDRESS=<backend relayer> \\");
  console.log("          npx hardhat run scripts/deploy-earn-lock-registry.js --network <net>");
  console.log("   3. Transfer admin to the Operator Safe (AFTER the vault deploys, so the");
  console.log("      deployer still holds SM admin for the vault AdminMismatch pre-flight):");
  console.log("        npx hardhat run scripts/deploy-operator-safe.js   --network <net>");
  console.log("        npx hardhat run scripts/grant-admin-to-safe.js    --network <net>");
  console.log("        # Safe then calls acceptAdmin() (Safe UI, or accept-admin-from-safe.js)");
  console.log("   4. CircuitBreaker: register triggers + (ops) grant it the SM admin role");
  console.log("      for registry-level trips. Post-audit.");
  console.log("   5. ⚠ AUDIT GATE: no mainnet money flows before the external audit clears");
  console.log("      FyusdEarnVault / ConcreteStableAdapter / EarnLockRegistry.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
