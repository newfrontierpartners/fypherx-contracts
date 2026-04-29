/**
 * RESUME script for an aborted `deploy-lp-lending.js` run.
 *
 * The canonical deploy aborted inside step 8 with an RPC staleness race:
 * after `createPair(RUSD, USDC)` the follow-up `getPair` returned the zero
 * address (BSC testnet nodes don't always serve the post-mine state from the
 * same view). A `scripts/probe-pairs.js` sweep confirmed the pair was, in
 * fact, created on-chain.
 *
 * We take the addresses the aborted run already produced (Timelock, Adapter,
 * OracleRouterV2, KinkedIRM, InsuranceFundV2, MarketFactory, LendingMarket,
 * LPVault_RUSD_USDT), finish the remaining work, and persist everything to
 * `deployed-addresses.json` at the end:
 *   - ensure pairs for RUSD/{FYUSD, FYP} (USDC is already created)
 *   - deploy LPVaults for RUSD/{USDC, FYUSD, FYP}
 *   - deploy fresh FypherLiquidityManager
 *   - register all 4 vaults, transfer vault ownership → manager,
 *     transfer manager ownership → Timelock
 *
 * `ensurePairResilient` retries the post-createPair `getPair` read for up
 * to 30s so the RPC-race is no longer fatal.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ADDR_PATH = path.join(__dirname, "..", "deployed-addresses.json");

// ─── Already-deployed resume state from the aborted run ───
// (See console transcript in the conversation.)
const RESUME = {
  FypherTimelock:               "0x1Bd5E8BE643353591Ad20D23CDC9E6FA42bbcC24",
  ConstantAdapter_RUSD_USDT:    "0xc3bF58ABAB728B135457bce38D21a394B624dBf4",
  FypherOracleRouterV2:         "0x9fd95852380D71Dd594A77eDF352bF98c6F85364",
  FypherKinkedIRM:              "0xFc05AD985d9Fb9F55DdF83CDcD546120DD74489D",
  FypherXInsuranceFundV2:       "0x94fDa66b58bb48Ae9d08971b23E33F0D9698aaa0",
  FypherLendingMarketFactory:   "0xBDC048aa1E8Ed2A394BA78930e3F5DF33719e0F0",
  FypherLendingMarket_RUSD_USDT:"0x14Acebc05D2EBdB76BCdA9cf724D22a9107Ad6D3",
  PancakeV2Pair_RUSD_USDT:      "0x8Db6D9529344b55156B2f602a550f71A07320087",
  FypherLPVault_RUSD_USDT:      "0xCa53C8fDe4b06e0957D7aCE3b63CdB8730fd37C2",
  // USDC pair was created on-chain but never persisted.
  PancakeV2Pair_RUSD_USDC:      "0x42114F5B72044725ec3Ef8aF802FC37339CA167b",
};

const LP_QUOTES = ["USDT", "USDC", "FYUSD", "FYP"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `factory.getPair` is the only way to discover the new pair — but BSC
 * testnet's public RPC occasionally serves a stale view for a few seconds
 * after the tx lands. We poll up to 15 times (30s total) before giving up.
 */
async function ensurePairResilient(factory, tokenA, tokenB, label) {
  const existing = await factory.getPair(tokenA, tokenB);
  if (existing !== ethers.ZeroAddress) {
    console.log(`   ${label}: reused ${existing}`);
    return existing;
  }
  const tx = await factory.createPair(tokenA, tokenB);
  const rcpt = await tx.wait();
  for (let i = 0; i < 15; i++) {
    const pair = await factory.getPair(tokenA, tokenB);
    if (pair !== ethers.ZeroAddress) {
      console.log(`   ${label}: created ${pair}  (gas: ${rcpt.gasUsed.toString()})`);
      return pair;
    }
    await sleep(2000);
  }
  throw new Error(`ensurePair: ${label} still zero after 30s`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  FYPHER LP + LENDING — RESUME");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB\n");

  const existing = JSON.parse(fs.readFileSync(ADDR_PATH, "utf8"));
  const out = { ...existing, ...RESUME };

  // Quote tokens and Pancake plumbing must be present.
  const need = ["RUSD", "PancakeV2Router", "PancakeV2Factory", ...LP_QUOTES];
  for (const k of need) {
    if (!out[k]) throw new Error(`missing ${k} in deployed-addresses.json`);
  }

  // ── 8. Pancake V2 pairs + FypherLPVaults (resume) ──
  console.log("── 8. Pancake V2 pairs + FypherLPVaults (resume) ──");
  const factoryAbi = [
    "function getPair(address,address) view returns (address)",
    "function createPair(address,address) returns (address)",
  ];
  const pancakeFactory = new ethers.Contract(
    out.PancakeV2Factory,
    factoryAbi,
    deployer
  );
  const LPVault = await ethers.getContractFactory("FypherLPVault");

  const deployedVaults = [];

  // USDT vault already deployed — reuse.
  deployedVaults.push({
    sym: "USDT",
    vaultAddress: RESUME.FypherLPVault_RUSD_USDT,
    vault: await ethers.getContractAt("FypherLPVault", RESUME.FypherLPVault_RUSD_USDT),
  });
  console.log(`   vault RUSD/USDT: reused ${RESUME.FypherLPVault_RUSD_USDT}`);

  for (const sym of ["USDC", "FYUSD", "FYP"]) {
    const quoteAddr = out[sym];
    // 8a. Ensure pair exists (USDC pair already created).
    const pairAddr = await ensurePairResilient(
      pancakeFactory, out.RUSD, quoteAddr, `pair RUSD/${sym}`
    );
    out[`PancakeV2Pair_RUSD_${sym}`] = pairAddr;

    // 8b. Deploy the vault.
    const vault = await LPVault.deploy(
      deployer.address,
      out.RUSD,
      quoteAddr,
      pairAddr,
      out.PancakeV2Router,
      `Fypher LP Vault RUSD/${sym}`,
      `fyLP-RUSD-${sym}`
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();
    out[`FypherLPVault_RUSD_${sym}`] = vaultAddr;
    console.log(`   vault RUSD/${sym}: ${vaultAddr}`);
    deployedVaults.push({ sym, vaultAddress: vaultAddr, vault });
  }

  // ── 9. Liquidity Manager — register every vault, hand ownership over ──
  console.log("\n── 9. FypherLiquidityManager ──");
  const LiquidityManager = await ethers.getContractFactory("FypherLiquidityManager");
  const mgr = await LiquidityManager.deploy(deployer.address, deployer.address);
  await mgr.waitForDeployment();
  out.FypherLiquidityManager = await mgr.getAddress();
  console.log(`   ${out.FypherLiquidityManager}`);

  for (const { sym, vaultAddress, vault } of deployedVaults) {
    await (await vault.transferOwnership(out.FypherLiquidityManager)).wait();
    console.log(`   vault RUSD/${sym} ownership → LiquidityManager ✓`);
    await (await mgr.registerVault(vaultAddress)).wait();
    console.log(`   manager.registerVault(RUSD/${sym}) ✓`);
  }
  await (await mgr.transferOwnership(out.FypherTimelock)).wait();
  console.log(`   manager ownership → Timelock ✓`);

  // ── Persist ──
  fs.writeFileSync(ADDR_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Addresses written to deployed-addresses.json");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
