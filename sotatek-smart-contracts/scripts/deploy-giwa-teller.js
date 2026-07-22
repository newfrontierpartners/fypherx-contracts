/**
 * GIWA final step — deploy {@link FyusdTeller} and hand it the FYUSD
 * minter role, then seed the Earn yield buffer.
 *
 * <p><b>Run this LAST</b>, after deploy-phase1.js and deploy-yield-vaults.js.
 * That ordering is deliberate: deploy-phase1.js points
 * {@code FYUSD.minter} at {@code FyusdEpochSettlement}, which is the
 * correct wiring on HOODI and mainnet (BitGo settles, the epoch contract
 * mints) but is a dead end on GIWA — there is no BitGo behind it. This
 * script reclaims the minter for the teller so the GIWA money path is
 * genuinely end-to-end on-chain. The phase-1 script itself is left
 * untouched so HOODI/mainnet behaviour is unchanged.
 *
 * <p>Steps:
 * <ol>
 *   <li>Deploy {@code FyusdTeller(FYUSD, deployer)}</li>
 *   <li>{@code FYUSD.setMinter(teller)}</li>
 *   <li>{@code teller.setSupportedAsset(USDT/USDC, true)}</li>
 *   <li>Mint test stables to the deployer, run them through the teller,
 *       and {@code fundYield} the FYUSD MockConcreteAdapter so Earn
 *       redemptions have real yield to pay out from block one</li>
 * </ol>
 *
 * <p>Idempotent: re-running skips the deploy, re-asserts the wiring, and
 * tops the yield buffer back up to the target.
 *
 * Usage:
 *   source .env.giwa-deployer
 *   npx hardhat run scripts/deploy-giwa-teller.js --network giwaSepolia
 *
 * Env:
 *   GIWA_YIELD_BUFFER_FYUSD   target adapter yield buffer, whole FYUSD
 *                             (default 100000)
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 91342;
const KEY_TELLER = "FyusdTeller";
const KEY_FYUSD_ADAPTER = "MockConcreteAdapterFyusd";

const YIELD_BUFFER_FYUSD = BigInt(process.env.GIWA_YIELD_BUFFER_FYUSD || "100000");

async function tryTx(label, fn) {
  try {
    const result = await fn();
    console.log(`${label}\n${result}`);
  } catch (e) {
    console.log(`${label}\n  ⚠  failed: ${e.shortMessage || e.message}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  GIWA FyusdTeller deploy + wiring — chainId ${chainId}`);
  console.log("═══════════════════════════════════════════════════════");
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`ERROR: requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}.`);
    process.exit(1);
  }

  const addrs = addresses.load(chainId);
  for (const key of ["FYUSD", "USDT", "USDC"]) {
    if (!addrs[key]) {
      console.error(`ERROR: addresses/${chainId}.json is missing ${key}. Run deploy-giwa-phase0.js first.`);
      process.exit(1);
    }
  }
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`FYUSD:     ${addrs.FYUSD}`);
  console.log("");

  // ── 1. Deploy the teller ──────────────────────────────────────────
  if (!addrs[KEY_TELLER]) {
    console.log("── Deploy FyusdTeller ──");
    const Teller = await ethers.getContractFactory("FyusdTeller");
    const teller = await Teller.deploy(addrs.FYUSD, deployer.address);
    await teller.waitForDeployment();
    addrs[KEY_TELLER] = await teller.getAddress();
    addresses.save(chainId, addrs);
    console.log(`  ✓ FyusdTeller @ ${addrs[KEY_TELLER]}`);
  } else {
    console.log(`  ✓ FyusdTeller already deployed @ ${addrs[KEY_TELLER]}`);
  }

  const teller = await ethers.getContractAt("FyusdTeller", addrs[KEY_TELLER]);
  const fyusd = await ethers.getContractAt("FYUSD", addrs.FYUSD);

  // ── 2. FYUSD.setMinter(teller) — reclaim from EpochSettlement ─────
  await tryTx("── FYUSD.setMinter -> FyusdTeller ──", async () => {
    const current = await fyusd.minter();
    if (current.toLowerCase() === addrs[KEY_TELLER].toLowerCase()) return "  ✓ already set";
    const tx = await fyusd.setMinter(addrs[KEY_TELLER]);
    await tx.wait();
    return `  ✓ set (was ${current})`;
  });

  // ── 3. Supported assets ───────────────────────────────────────────
  for (const sym of ["USDT", "USDC"]) {
    await tryTx(`── FyusdTeller.setSupportedAsset(${sym}) ──`, async () => {
      if (await teller.supported(addrs[sym])) return "  ✓ already supported";
      const tx = await teller.setSupportedAsset(addrs[sym], true);
      await tx.wait();
      return `  ✓ ${sym} @ ${addrs[sym]}`;
    });
  }

  // ── 4. Seed the Earn yield buffer ─────────────────────────────────
  // MockConcreteAdapter pays simulated yield out of its own FYUSD balance
  // and reverts InsufficientLiquidity when short. Without a buffer, the
  // very first Earn redemption after any elapsed time fails — which on a
  // demo chain looks exactly like a broken product.
  if (!addrs[KEY_FYUSD_ADAPTER]) {
    console.log(`\n  ⚠  ${KEY_FYUSD_ADAPTER} not in addresses/${chainId}.json — run deploy-yield-vaults.js, then re-run this script to seed the yield buffer.`);
  } else {
    await tryTx("── Seed MockConcreteAdapterFyusd yield buffer ──", async () => {
      const target = YIELD_BUFFER_FYUSD * 10n ** 18n;
      const held = await fyusd.balanceOf(addrs[KEY_FYUSD_ADAPTER]);
      if (held >= target) return `  ✓ buffer already ${ethers.formatEther(held)} FYUSD`;
      const shortfall = target - held;

      // Mint the shortfall through the teller itself rather than via a
      // privileged mint, so the 1:1 reserve invariant the explorer shows
      // stays true for every FYUSD in existence — including ours.
      const usdt = await ethers.getContractAt("MockERC20", addrs.USDT);
      const usdtNeeded = shortfall / 10n ** 12n; // 18-dec FYUSD -> 6-dec USDT
      await (await usdt.mint(deployer.address, usdtNeeded)).wait();
      await (await usdt.approve(addrs[KEY_TELLER], usdtNeeded)).wait();
      await (await teller.mint(addrs.USDT, usdtNeeded)).wait();

      const adapter = await ethers.getContractAt("MockConcreteAdapter", addrs[KEY_FYUSD_ADAPTER]);
      await (await fyusd.approve(addrs[KEY_FYUSD_ADAPTER], shortfall)).wait();
      await (await adapter.fundYield(shortfall)).wait();
      return `  ✓ funded ${ethers.formatEther(shortfall)} FYUSD (target ${YIELD_BUFFER_FYUSD})`;
    });
  }

  addresses.save(chainId, addrs);
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  GIWA money path is live and fully on-chain");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Faucet:  MockERC20.mint(you, amount) on USDT ${addrs.USDT}`);
  console.log(`  Mint:    FyusdTeller.mint(USDT, amount)      ${addrs[KEY_TELLER]}`);
  console.log(`  Earn:    FyusdYieldVault.deposit(...)        ${addrs.FyusdYieldVaultErc4626 || "(run deploy-yield-vaults.js)"}`);
  console.log("");
  console.log("  Verify everything on Blockscout:");
  console.log("    npx hardhat run scripts/verify-giwa.js --network giwaSepolia");
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
