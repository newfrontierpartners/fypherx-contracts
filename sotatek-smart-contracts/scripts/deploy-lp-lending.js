/**
 * Deploys the FypherLending + FypherLP stack on top of the already-live
 * Fypher perps + stable stack (tokens from `deployed-addresses.json`).
 *
 *  Order:
 *    1. OpenZeppelin TimelockController (proposer = deployer, executor = deployer — DAO
 *       takeover happens in a later ops tx, not here).
 *    2. ConstantOracleAdapter for RUSD/USDT @ 1e36 (both stable, both 18 decimals).
 *    3. OracleRouterV2 — adapter registry; wires RUSD→USDT → the constant adapter above.
 *    4. KinkedIRM — shared IRM (4% base, 80% kink, 10% slope1, 250% slope2 annualised).
 *    5. InsuranceFundV2 — shared fund owned by Timelock. `setFactory(factory)` is called
 *       once the factory is live so createMarket can self-whitelist new markets.
 *    6. FypherLendingMarketFactory — owned by Timelock, wired to InsuranceFund.
 *    7. RUSD/USDT market — created via the factory. InitParams:
 *         lltvBps = 9000 (90%)
 *         liquidationBonusBps = 500 (5%)
 *         reserveFactorBps = 1000 (10%)
 *         supplyCap / borrowCap = 0 (uncapped for testnet)
 *    8. For each quote symbol in {USDT, USDC, FYUSD, FYP}:
 *         a. PancakeV2 pair (factory.createPair if absent, else reuse).
 *         b. FypherLPVault (RUSD/quote) owned by the deployer until step 9.
 *    9. FypherLiquidityManager (owner = deployer for now).
 *         a. Registers all four vaults.
 *         b. Each vault.transferOwnership(manager).
 *         c. manager.transferOwnership(Timelock).
 *
 *  The resulting addresses are merged into `deployed-addresses.json` in-place so downstream
 *  backend/frontend config updates can read from one source of truth.
 *
 *  NOTE: `timelock` is deployed with a min-delay of 0 on BSC testnet so deploy-time
 *        governance calls don't wait. Production deploys must bump this to >=24h.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ADDR_PATH = path.join(__dirname, "..", "deployed-addresses.json");
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;

/**
 * Quote symbols paired with RUSD on the LP side. Order matches the backend
 * `application.yml` `lp-pairs` list and the frontend
 * `liveLpPools.ts ALL_LP_POOL_CANDIDATES` table — keeping all three in sync
 * is what makes the new symbols routable end-to-end.
 *
 * To add a fifth pair: deploy the quote token, append its symbol here,
 * append the address mirror in `deployed-addresses.json`, then add the
 * matching `lp-pairs` entry on the backend and `liveLpPools.ts` row on
 * the frontend.
 */
const LP_QUOTES = ["USDT", "USDC", "FYUSD", "FYP"];

/**
 * Ensure a Pancake V2 pair exists for `(tokenA, tokenB)` — if `getPair`
 * returns the zero address we create it on-chain and return the new pair.
 *
 * Returns the deployed pair address. The factory's pair is canonical: it
 * doesn't matter which order tokenA/tokenB go in — V2 sorts them by address.
 */
async function ensurePair(factory, tokenA, tokenB, label) {
  const existing = await factory.getPair(tokenA, tokenB);
  if (existing !== ethers.ZeroAddress) {
    console.log(`   ${label}: reused ${existing}`);
    return existing;
  }
  const tx = await factory.createPair(tokenA, tokenB);
  const rcpt = await tx.wait();
  const pair = await factory.getPair(tokenA, tokenB);
  if (pair === ethers.ZeroAddress) {
    throw new Error(`createPair(${tokenA}, ${tokenB}) returned zero post-tx`);
  }
  console.log(`   ${label}: created ${pair}  (gas: ${rcpt.gasUsed.toString()})`);
  return pair;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  FYPHER LP + LENDING — Fresh Deploy");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB\n");

  const existing = JSON.parse(fs.readFileSync(ADDR_PATH, "utf8"));
  const out = { ...existing };

  // RUSD + every quote token + the Pancake plumbing must already be in the
  // address map. Pairs themselves are NOT required up front — step 8 calls
  // `factory.createPair` if they're missing.
  const need = ["RUSD", "PancakeV2Router", "PancakeV2Factory", ...LP_QUOTES];
  for (const k of need) {
    if (!out[k]) throw new Error(`missing ${k} in deployed-addresses.json`);
  }

  // ── 1. Timelock ──
  console.log("── 1. Timelock ──");
  const Timelock = await ethers.getContractFactory("TimelockController");
  const MIN_DELAY = 0;                          // testnet convenience; bump for prod
  const proposers = [deployer.address];
  const executors = [deployer.address];
  const timelock = await Timelock.deploy(MIN_DELAY, proposers, executors, deployer.address);
  await timelock.waitForDeployment();
  out.FypherTimelock = await timelock.getAddress();
  console.log(`   ${out.FypherTimelock}`);

  // ── 2. Constant Oracle Adapter (RUSD/USDT = 1.0 at 1e36) ──
  console.log("\n── 2. ConstantOracleAdapter (RUSD/USDT = 1e36) ──");
  const ConstantAdapter = await ethers.getContractFactory("ConstantOracleAdapter");
  const adapter = await ConstantAdapter.deploy(ORACLE_PRICE_SCALE);
  await adapter.waitForDeployment();
  out.ConstantAdapter_RUSD_USDT = await adapter.getAddress();
  console.log(`   ${out.ConstantAdapter_RUSD_USDT}`);

  // ── 3. OracleRouterV2 ──
  console.log("\n── 3. OracleRouterV2 ──");
  const OracleRouter = await ethers.getContractFactory("OracleRouterV2");
  const router = await OracleRouter.deploy(deployer.address);
  await router.waitForDeployment();
  out.FypherOracleRouterV2 = await router.getAddress();
  console.log(`   ${out.FypherOracleRouterV2}`);

  await (await router.setAdapter(out.RUSD, out.USDT, out.ConstantAdapter_RUSD_USDT)).wait();
  console.log(`   router.setAdapter(RUSD→USDT) ✓`);
  // transfer router ownership to timelock
  await (await router.transferOwnership(out.FypherTimelock)).wait();
  console.log(`   router ownership → Timelock ✓`);

  // ── 4. KinkedIRM (4% base, 80% kink, 10% slope1, 250% slope2) ──
  console.log("\n── 4. KinkedIRM ──");
  const KinkedIRM = await ethers.getContractFactory("KinkedIRM");
  const irm = await KinkedIRM.deploy(
    (4n * WAD) / 100n,       // baseRatePerYear = 4%
    (80n * WAD) / 100n,      // kinkUtilisation = 80%
    (10n * WAD) / 100n,      // slope1PerYear = 10%
    (250n * WAD) / 100n      // slope2PerYear = 250%
  );
  await irm.waitForDeployment();
  out.FypherKinkedIRM = await irm.getAddress();
  console.log(`   ${out.FypherKinkedIRM}`);

  // ── 5. InsuranceFundV2 ──
  console.log("\n── 5. InsuranceFundV2 ──");
  const InsuranceFund = await ethers.getContractFactory("InsuranceFundV2");
  // Owner = deployer initially so we can set factory; we transfer ownership to Timelock at the end.
  const fund = await InsuranceFund.deploy(deployer.address);
  await fund.waitForDeployment();
  out.FypherXInsuranceFundV2 = await fund.getAddress();
  console.log(`   ${out.FypherXInsuranceFundV2}`);

  // ── 6. MarketFactory ──
  console.log("\n── 6. MarketFactory ──");
  const MarketFactory = await ethers.getContractFactory("FypherLendingMarketFactory");
  const factory = await MarketFactory.deploy(deployer.address, out.FypherXInsuranceFundV2);
  await factory.waitForDeployment();
  out.FypherLendingMarketFactory = await factory.getAddress();
  console.log(`   ${out.FypherLendingMarketFactory}`);

  await (await fund.setFactory(out.FypherLendingMarketFactory)).wait();
  console.log(`   fund.setFactory(factory) ✓`);

  // ── 7. RUSD/USDT Market ──
  console.log("\n── 7. RUSD/USDT Market ──");
  const initParams = {
    loanToken:           out.USDT,
    collateralToken:     out.RUSD,
    oracle:              out.ConstantAdapter_RUSD_USDT,
    irm:                 out.FypherKinkedIRM,
    lltvBps:             9000,    // 90% LLTV (stable-stable)
    liquidationBonusBps: 500,     // 5% bonus
    reserveFactorBps:    1000,    // 10% reserve factor
    supplyCap:           0,       // uncapped testnet
    borrowCap:           0,
    timelock:            out.FypherTimelock,
    insuranceFund:       out.FypherXInsuranceFundV2,
  };
  const createTx = await factory.createMarket(initParams);
  const createRcpt = await createTx.wait();
  const marketAddress = (await factory.markets(0));
  out.FypherLendingMarket_RUSD_USDT = marketAddress;
  console.log(`   ${marketAddress}`);
  console.log(`   (createMarket gas: ${createRcpt.gasUsed.toString()})`);

  // Hand factory + fund over to Timelock — deployer loses admin capability here.
  await (await factory.transferOwnership(out.FypherTimelock)).wait();
  console.log(`   factory ownership → Timelock ✓`);
  await (await fund.transferOwnership(out.FypherTimelock)).wait();
  console.log(`   fund ownership → Timelock ✓`);

  // ── 8. Pancake V2 pairs + FypherLPVaults (one per quote symbol) ──
  // We loop over LP_QUOTES so {USDT, USDC, FYUSD, FYP} all share the
  // same code path. Adding a fifth quote token = append to LP_QUOTES at
  // the top of the file.
  console.log("\n── 8. Pancake V2 pairs + FypherLPVaults ──");
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

  /** Each entry: { sym, vaultAddress } so step 9 can register them in order. */
  const deployedVaults = [];
  for (const sym of LP_QUOTES) {
    const quoteAddr = out[sym];
    if (!quoteAddr) {
      throw new Error(`quote token ${sym} missing from deployed-addresses.json`);
    }

    // 8a. Ensure the Pancake V2 pair exists.
    const pairAddr = await ensurePair(
      pancakeFactory, out.RUSD, quoteAddr, `pair RUSD/${sym}`
    );
    out[`PancakeV2Pair_RUSD_${sym}`] = pairAddr;

    // 8b. Deploy a vault for it. Owner stays as `deployer` until step 9
    //     hands it to the manager (so we can register before transferring).
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

  // Order matters: vaults must be transferred to the manager BEFORE the
  // manager itself is handed to the Timelock — `registerVault` is `onlyOwner`
  // and we want the deployer to do it during this script, not push a
  // governance proposal for every Stage 4 quote.
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
