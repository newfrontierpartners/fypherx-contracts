/**
 * HOODI Phase 0 bootstrap — deploys the base layer contracts that
 * scripts/deploy-phase1.js + deploy-yield-vaults.js + deploy-fyusd-redemption.js
 * assume already exist.
 *
 * <p>Why this script exists separately from a unified deploy.js: the
 * shared {@code scripts/deploy.js} that the per-network entrypoints
 * (deploy-bsc-testnet.js / deploy-sepolia.js / deploy-mainnet.js)
 * referenced was deleted in commit 0965dd6c during the alpha audit-
 * scope cleanup. Reconstructing it for HOODI as a one-off is cheaper
 * than retrofitting the whole multi-network entry: HOODI is a single
 * testnet specifically for the FYUSD ↔ Concrete integration, and its
 * Phase 0 differs from Sepolia's (FYUSD is Concrete-deployed, not
 * ours).
 *
 * <p><b>What this deploys</b>:
 * <ol>
 *   <li>{@code SettingManagement} (proxy) — admin = deployer EOA</li>
 *   <li>{@code RUSD} (proxy) — owner = deployer</li>
 *   <li>{@code FYP} (proxy) — owner = deployer</li>
 *   <li>{@code USDT} ({@code MockERC20}, 6 decimals) — testnet mock</li>
 *   <li>{@code USDC} ({@code MockERC20}, 6 decimals) — testnet mock</li>
 *   <li>{@code FypherMinting} (proxy) — RUSD mint engine</li>
 * </ol>
 *
 * <p><b>What this deliberately skips</b>:
 * <ul>
 *   <li>{@code FYUSD} — Concrete already deployed it on HOODI at
 *       {@code 0xd1bbd247…25e6}. Do not redeploy.</li>
 *   <li>{@code WETH} — not needed for the FYUSD x Concrete smoke.</li>
 *   <li>{@code ReservePool} — Phase-2 / mainnet feature.</li>
 *   <li>iRUSD / SIRUSDSilo / cooldown vaults — alpha-audit backup.</li>
 * </ul>
 *
 * <p><b>Re-runnable</b>: each step checks if the address already
 * exists in {@code addresses/560048.json} and skips if so. Same
 * idempotent pattern as deploy-phase1.js.
 *
 * Usage:
 *   source .env.hoodi-deployer    # exports HOODI_DEPLOYER_PRIVATE_KEY
 *   npx hardhat run scripts/deploy-hoodi-phase0.js --network hoodi
 *
 * After this completes successfully, run in order:
 *   npx hardhat run scripts/deploy-phase1.js          --network hoodi
 *   npx hardhat run scripts/deploy-yield-vaults.js    --network hoodi
 *   npx hardhat run scripts/deploy-fyusd-redemption.js --network hoodi
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

// Concrete-deployed FYUSD on HOODI. Pre-populated in
// addresses/560048.json by the network-config PR.
const CONCRETE_FYUSD_HOODI = "0xd1bbd247Be78C68cDEB8486744bD4513e62025e6";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  HOODI Phase 0 bootstrap — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`ERROR: requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }
  console.log(`Deployer:   ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log("");

  const addrs = addresses.load(chainId);

  // ── 1. SettingManagement ──────────────────────────────────────────
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
    console.log(`  ✓ SettingManagement @ ${addrs.SettingManagement}`);
  } else {
    console.log(`  ✓ SettingManagement already deployed @ ${addrs.SettingManagement}`);
  }

  // ── 2. RUSD ───────────────────────────────────────────────────────
  if (!addrs.RUSD) {
    console.log("── Deploy RUSD ──");
    const RUSD = await ethers.getContractFactory("RUSD");
    const rusd = await upgrades.deployProxy(
      RUSD,
      [deployer.address /* owner */],
      { initializer: "initialize", kind: "transparent" },
    );
    await rusd.waitForDeployment();
    addrs.RUSD = await rusd.getAddress();
    console.log(`  ✓ RUSD @ ${addrs.RUSD}`);
  } else {
    console.log(`  ✓ RUSD already deployed @ ${addrs.RUSD}`);
  }

  // ── 3. FYP ────────────────────────────────────────────────────────
  if (!addrs.FYP) {
    console.log("── Deploy FYP ──");
    const FYP = await ethers.getContractFactory("FYP");
    const fyp = await upgrades.deployProxy(
      FYP,
      [deployer.address /* owner */],
      { initializer: "initialize", kind: "transparent" },
    );
    await fyp.waitForDeployment();
    addrs.FYP = await fyp.getAddress();
    console.log(`  ✓ FYP @ ${addrs.FYP}`);
  } else {
    console.log(`  ✓ FYP already deployed @ ${addrs.FYP}`);
  }

  // ── 4. FYUSD — pre-populated, sanity check only ───────────────────
  if (!addrs.FYUSD) {
    addrs.FYUSD = CONCRETE_FYUSD_HOODI;
    console.log(`  ✓ FYUSD @ ${addrs.FYUSD}  (Concrete-deployed; populated)`);
  } else if (addrs.FYUSD.toLowerCase() === CONCRETE_FYUSD_HOODI.toLowerCase()) {
    console.log(`  ✓ FYUSD @ ${addrs.FYUSD}  (Concrete-deployed; matches expected)`);
  } else {
    console.log(`  ⚠  FYUSD @ ${addrs.FYUSD}  (does NOT match expected ${CONCRETE_FYUSD_HOODI} — manual check needed)`);
  }

  // ── 5. USDT (MockERC20, 6 decimals) ───────────────────────────────
  if (!addrs.USDT) {
    console.log("── Deploy USDT (MockERC20) ──");
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdt = await Mock.deploy("Tether USD (HOODI Mock)", "USDT", 6);
    await usdt.waitForDeployment();
    addrs.USDT = await usdt.getAddress();
    console.log(`  ✓ USDT @ ${addrs.USDT}`);
  } else {
    console.log(`  ✓ USDT already deployed @ ${addrs.USDT}`);
  }

  // ── 6. USDC (MockERC20, 6 decimals) ───────────────────────────────
  if (!addrs.USDC) {
    console.log("── Deploy USDC (MockERC20) ──");
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdc = await Mock.deploy("USD Coin (HOODI Mock)", "USDC", 6);
    await usdc.waitForDeployment();
    addrs.USDC = await usdc.getAddress();
    console.log(`  ✓ USDC @ ${addrs.USDC}`);
  } else {
    console.log(`  ✓ USDC already deployed @ ${addrs.USDC}`);
  }

  // ── 7. FypherMinting ──────────────────────────────────────────────
  if (!addrs.FypherMinting) {
    console.log("── Deploy FypherMinting ──");
    const Minting = await ethers.getContractFactory("FypherMinting");
    const minting = await upgrades.deployProxy(
      Minting,
      [
        addrs.SettingManagement,
        addrs.RUSD,
        deployer.address, /* signer */
        deployer.address, /* executor */
      ],
      { initializer: "initialize", kind: "transparent" },
    );
    await minting.waitForDeployment();
    addrs.FypherMinting = await minting.getAddress();
    console.log(`  ✓ FypherMinting @ ${addrs.FypherMinting}`);
  } else {
    console.log(`  ✓ FypherMinting already deployed @ ${addrs.FypherMinting}`);
  }

  // ── 8. Wire RUSD minter = FypherMinting ───────────────────────────
  console.log("── Wire RUSD.setMinter(FypherMinting) ──");
  const RUSD_ABI = ["function setMinter(address) external", "function minter() view returns (address)"];
  const rusdRw = new ethers.Contract(addrs.RUSD, RUSD_ABI, deployer);
  try {
    const currentMinter = await rusdRw.minter();
    if (currentMinter.toLowerCase() === addrs.FypherMinting.toLowerCase()) {
      console.log(`  ✓ RUSD.minter already = FypherMinting`);
    } else {
      const tx = await rusdRw.setMinter(addrs.FypherMinting);
      await tx.wait();
      console.log(`  ✓ RUSD.minter set to FypherMinting (tx ${tx.hash})`);
    }
  } catch (e) {
    console.log(`  ⚠  setMinter wiring failed: ${e.message}`);
  }

  // ── Save ──────────────────────────────────────────────────────────
  addresses.save(chainId, addrs);
  console.log(`\n✓ Wrote addresses/${chainId}.json`);
  console.log("\nNext: npx hardhat run scripts/deploy-phase1.js --network hoodi\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
