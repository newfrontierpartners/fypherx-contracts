/**
 * GIWA Sepolia Phase 0 bootstrap — chainId 91342.
 *
 * <p>Sibling of {@code deploy-hoodi-phase0.js}, with one structural
 * difference that drives everything else: <b>on GIWA we deploy FYUSD
 * ourselves</b>. On HOODI, Concrete had already deployed FYUSD and we
 * adopted their token; on mainnet, FYUSD is issued by BitGo. Neither
 * counterparty supports GIWA, so the GIWA environment is deliberately
 * self-contained — our own FYUSD proxy, our own test stables, and (in
 * {@code deploy-giwa-teller.js}) an on-chain 1:1 issuance desk in place of
 * the custodial mint path.
 *
 * <p><b>What this deploys</b>:
 * <ol>
 *   <li>{@code SettingManagement} (proxy) — admin = deployer EOA</li>
 *   <li>{@code RUSD} (proxy) — owner = deployer</li>
 *   <li>{@code FYP} (proxy) — owner = deployer</li>
 *   <li>{@code FYUSD} (proxy) — owner = deployer  <b>[GIWA-specific]</b></li>
 *   <li>{@code USDT} ({@code MockERC20}, 6 decimals) — open-mint faucet</li>
 *   <li>{@code USDC} ({@code MockERC20}, 6 decimals) — open-mint faucet</li>
 *   <li>{@code FypherMinting} (proxy) — RUSD mint engine</li>
 * </ol>
 *
 * <p><b>Re-runnable</b>: every step skips if the address already exists in
 * {@code addresses/91342.json}. Same idempotent pattern as the HOODI
 * scripts, so a run that dies mid-sequence (out of gas, RPC blip) can be
 * resumed by simply running it again.
 *
 * Usage:
 *   source .env.giwa-deployer    # exports GIWA_DEPLOYER_PRIVATE_KEY
 *   npx hardhat run scripts/deploy-giwa-phase0.js --network giwaSepolia
 *
 * After this completes, run in order (see scripts/deploy-giwa.js):
 *   npx hardhat run scripts/deploy-phase1.js      --network giwaSepolia
 *   npx hardhat run scripts/deploy-yield-vaults.js --network giwaSepolia
 *   npx hardhat run scripts/deploy-giwa-teller.js  --network giwaSepolia
 */
const { ethers, upgrades } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 91342;

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  GIWA Sepolia Phase 0 bootstrap — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`ERROR: requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}. Re-run with --network giwaSepolia.`);
    process.exit(1);
  }
  if (!deployer) {
    console.error("ERROR: no signer. Set GIWA_DEPLOYER_PRIVATE_KEY (see scripts/gen-giwa-deployer.js).");
    process.exit(1);
  }
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Balance:    ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("");

  const addrs = addresses.load(chainId);

  // ── 1. SettingManagement ──────────────────────────────────────────
  if (!addrs.SettingManagement) {
    console.log("── Deploy SettingManagement ──");
    const Setting = await ethers.getContractFactory("SettingManagement");
    const setting = await upgrades.deployProxy(Setting, [deployer.address], {
      initializer: "initialize",
      kind: "transparent",
    });
    await setting.waitForDeployment();
    addrs.SettingManagement = await setting.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ SettingManagement @ ${addrs.SettingManagement}`);
  } else {
    console.log(`  ✓ SettingManagement already deployed @ ${addrs.SettingManagement}`);
  }

  // ── 2. RUSD ───────────────────────────────────────────────────────
  if (!addrs.RUSD) {
    console.log("── Deploy RUSD ──");
    const RUSD = await ethers.getContractFactory("RUSD");
    const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
      initializer: "initialize",
      kind: "transparent",
    });
    await rusd.waitForDeployment();
    addrs.RUSD = await rusd.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ RUSD @ ${addrs.RUSD}`);
  } else {
    console.log(`  ✓ RUSD already deployed @ ${addrs.RUSD}`);
  }

  // ── 3. FYP ────────────────────────────────────────────────────────
  if (!addrs.FYP) {
    console.log("── Deploy FYP ──");
    const FYP = await ethers.getContractFactory("FYP");
    const fyp = await upgrades.deployProxy(FYP, [deployer.address], {
      initializer: "initialize",
      kind: "transparent",
    });
    await fyp.waitForDeployment();
    addrs.FYP = await fyp.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ FYP @ ${addrs.FYP}`);
  } else {
    console.log(`  ✓ FYP already deployed @ ${addrs.FYP}`);
  }

  // ── 4. FYUSD — GIWA-specific: we deploy it ────────────────────────
  // On HOODI this slot is Concrete's token and on mainnet it is BitGo's.
  // GIWA has neither, so the environment owns its own FYUSD proxy. The
  // minter is left unset here and claimed by FyusdTeller in the final
  // step — deploy-phase1.js would otherwise point it at
  // FyusdEpochSettlement, which on GIWA has no BitGo settlement behind it.
  if (!addrs.FYUSD) {
    console.log("── Deploy FYUSD (GIWA-owned) ──");
    const FYUSD = await ethers.getContractFactory("FYUSD");
    const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
      initializer: "initialize",
      kind: "transparent",
    });
    await fyusd.waitForDeployment();
    addrs.FYUSD = await fyusd.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ FYUSD @ ${addrs.FYUSD}`);
  } else {
    console.log(`  ✓ FYUSD already deployed @ ${addrs.FYUSD}`);
  }

  // ── 5. USDT (MockERC20, 6 decimals, open mint = faucet) ───────────
  if (!addrs.USDT) {
    console.log("── Deploy USDT (MockERC20) ──");
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdt = await Mock.deploy("Tether USD (GIWA Test)", "USDT", 6);
    await usdt.waitForDeployment();
    addrs.USDT = await usdt.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ USDT @ ${addrs.USDT}`);
  } else {
    console.log(`  ✓ USDT already deployed @ ${addrs.USDT}`);
  }

  // ── 6. USDC (MockERC20, 6 decimals, open mint = faucet) ───────────
  if (!addrs.USDC) {
    console.log("── Deploy USDC (MockERC20) ──");
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdc = await Mock.deploy("USD Coin (GIWA Test)", "USDC", 6);
    await usdc.waitForDeployment();
    addrs.USDC = await usdc.getAddress();
    addresses.save(chainId, addrs);
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
      [addrs.SettingManagement, addrs.RUSD, deployer.address /* signer */, deployer.address /* executor */],
      { initializer: "initialize", kind: "transparent" },
    );
    await minting.waitForDeployment();
    addrs.FypherMinting = await minting.getAddress();
    addresses.save(chainId, addrs);
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
      console.log("  ✓ RUSD.minter already = FypherMinting");
    } else {
      const tx = await rusdRw.setMinter(addrs.FypherMinting);
      await tx.wait();
      console.log(`  ✓ RUSD.minter set to FypherMinting (tx ${tx.hash})`);
    }
  } catch (e) {
    console.log(`  ⚠  setMinter wiring failed: ${e.message}`);
  }

  addresses.save(chainId, addrs);
  console.log(`\n✓ Wrote addresses/${chainId}.json`);
  console.log("\nNext: npx hardhat run scripts/deploy-phase1.js --network giwaSepolia\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
