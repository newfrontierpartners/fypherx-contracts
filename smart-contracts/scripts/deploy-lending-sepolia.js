/**
 * Stage 1 lending deploy — Ethereum Sepolia (chainId 11155111).
 *
 * Deploys the shared lending system + a single RUSD/USDT market to smoke
 * the end-to-end pipeline (factory → market → backend reader → frontend).
 *
 * System contracts (deployed once, shared by every market):
 *   1. KinkedIRM            — Aave-style two-slope IRM, params:
 *                               base = 4%/yr, kink = 80%, slope1 = 10%, slope2 = 250%
 *   2. InsuranceFundV2      — owner = deployer (testnet placeholder for Timelock)
 *   3. OracleRouterV2       — owner = deployer; off-chain registry of (collat,loan)→adapter
 *   4. FypherLendingMarketFactory(owner=deployer, insuranceFund)
 *      • Then `insuranceFund.setFactory(factory)` so the factory can auto-whitelist
 *        new markets via `setMarketAllowed(market, true)` on createMarket.
 *
 * Stage 1 market (RUSD/USDT):
 *   5. ConstantOracleAdapter(1e36) — RUSD pegged 1:1 to USDT, both 18 decimals.
 *   6. oracleRouter.setAdapter(RUSD, USDT, adapter) — registry mirror for off-chain tooling.
 *   7. factory.createMarket(InitParams{
 *        loanToken: USDT, collateralToken: RUSD,
 *        oracle: adapter, irm: kinkedIRM,
 *        lltvBps: 9200, liquidationBonusBps: 500, reserveFactorBps: 1000,
 *        supplyCap: 0 (uncapped), borrowCap: 0 (uncapped),
 *        timelock: deployer, insuranceFund
 *      })
 *
 * Output: appends a top-level `lending` block to addresses/11155111.json
 * with system + market addresses. Idempotent w.r.t. existing keys (it
 * overwrites the lending block on every run; non-lending keys untouched).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-lending-sepolia.js --network sepolia
 *
 * Stage 2 (7 remaining markets) is intentionally NOT in this script —
 * smoke verify Stage 1 first.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 11155111;

// IRM params (annualised, WAD = 1e18). 10000 bps = 100%.
const WAD = 10n ** 18n;
const IRM_BASE_RATE_PER_YEAR  = (WAD * 4n) / 100n;    // 4%
const IRM_KINK_UTILISATION    = (WAD * 80n) / 100n;   // 80%
const IRM_SLOPE1_PER_YEAR     = (WAD * 10n) / 100n;   // 10%
const IRM_SLOPE2_PER_YEAR     = (WAD * 250n) / 100n;  // 250%

// Market-creation params.
const STAGE1_LLTV_BPS               = 9200n;  // 92%   — RUSD pegged to USDT (Tier 1 stable/synth)
const STAGE1_LIQUIDATION_BONUS_BPS  = 500n;   // 5%
const STAGE1_RESERVE_FACTOR_BPS     = 1000n;  // 10%
const STAGE1_SUPPLY_CAP             = 0n;    // 0 = uncapped
const STAGE1_BORROW_CAP             = 0n;    // 0 = uncapped

// Oracle scale (Morpho convention): 1 unit collateral valued in loan units, scaled by 1e36.
// RUSD (18 dec) ⇄ USDT (18 dec) at 1:1 → constant 1e36.
const STAGE1_CONSTANT_PRICE_1E36 = 10n ** 36n;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `deploy-lending-sepolia.js requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}. ` +
      `Re-run with --network sepolia.`
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log(`\n[lending-deploy] chainId ${chainId}`);
  console.log(`[lending-deploy] deployer ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`[lending-deploy] balance  ${ethers.formatEther(bal)} ETH\n`);

  // Load existing alpha-launch addresses to wire in token addresses.
  const existing = addresses.load(chainId);
  const RUSD = requireAddr(existing, "RUSD");
  const USDT = requireAddr(existing, "USDT");
  console.log(`[lending-deploy] RUSD = ${RUSD}`);
  console.log(`[lending-deploy] USDT = ${USDT}\n`);

  /* ----------------------------- System ----------------------------- */

  console.log("[lending-deploy] 1/7 KinkedIRM ...");
  const KinkedIRM = await ethers.getContractFactory("KinkedIRM");
  const irm = await KinkedIRM.deploy(
    IRM_BASE_RATE_PER_YEAR,
    IRM_KINK_UTILISATION,
    IRM_SLOPE1_PER_YEAR,
    IRM_SLOPE2_PER_YEAR
  );
  await irm.waitForDeployment();
  const irmAddr = await irm.getAddress();
  console.log(`           ↳ ${irmAddr}`);

  console.log("[lending-deploy] 2/7 InsuranceFundV2 ...");
  const InsuranceFundV2 = await ethers.getContractFactory("InsuranceFundV2");
  const insuranceFund = await InsuranceFundV2.deploy(deployer.address);
  await insuranceFund.waitForDeployment();
  const insuranceFundAddr = await insuranceFund.getAddress();
  console.log(`           ↳ ${insuranceFundAddr}`);

  console.log("[lending-deploy] 3/7 OracleRouterV2 ...");
  const OracleRouterV2 = await ethers.getContractFactory("OracleRouterV2");
  const oracleRouter = await OracleRouterV2.deploy(deployer.address);
  await oracleRouter.waitForDeployment();
  const oracleRouterAddr = await oracleRouter.getAddress();
  console.log(`           ↳ ${oracleRouterAddr}`);

  console.log("[lending-deploy] 4/7 FypherLendingMarketFactory ...");
  const Factory = await ethers.getContractFactory("FypherLendingMarketFactory");
  const factory = await Factory.deploy(deployer.address, insuranceFundAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`           ↳ ${factoryAddr}`);

  // Allow the factory to auto-whitelist new markets on createMarket.
  console.log("[lending-deploy]     insuranceFund.setFactory(factory) ...");
  await (await insuranceFund.setFactory(factoryAddr)).wait();

  /* -------------------------- Stage 1 market ------------------------- */

  console.log("\n[lending-deploy] 5/7 ConstantOracleAdapter (RUSD↔USDT, 1e36) ...");
  const ConstantOracleAdapter = await ethers.getContractFactory("ConstantOracleAdapter");
  const oracleAdapter = await ConstantOracleAdapter.deploy(STAGE1_CONSTANT_PRICE_1E36);
  await oracleAdapter.waitForDeployment();
  const oracleAdapterAddr = await oracleAdapter.getAddress();
  console.log(`           ↳ ${oracleAdapterAddr}`);

  console.log("[lending-deploy] 6/7 oracleRouter.setAdapter(RUSD, USDT, adapter) ...");
  await (await oracleRouter.setAdapter(RUSD, USDT, oracleAdapterAddr)).wait();

  console.log("[lending-deploy] 7/7 factory.createMarket(RUSD/USDT) ...");
  const initParams = {
    loanToken:           USDT,
    collateralToken:     RUSD,
    oracle:              oracleAdapterAddr,
    irm:                 irmAddr,
    lltvBps:             STAGE1_LLTV_BPS,
    liquidationBonusBps: STAGE1_LIQUIDATION_BONUS_BPS,
    reserveFactorBps:    STAGE1_RESERVE_FACTOR_BPS,
    supplyCap:           STAGE1_SUPPLY_CAP,
    borrowCap:           STAGE1_BORROW_CAP,
    timelock:            deployer.address,
    insuranceFund:       insuranceFundAddr,
  };
  const tx = await factory.createMarket(initParams);
  const rcpt = await tx.wait();

  // Pull market address from the MarketCreated event.
  const marketCreatedTopic = factory.interface.getEvent("MarketCreated").topicHash;
  const log = rcpt.logs.find(
    (l) => l.address.toLowerCase() === factoryAddr.toLowerCase() && l.topics[0] === marketCreatedTopic
  );
  if (!log) throw new Error("MarketCreated event not found in createMarket receipt");
  const decoded = factory.interface.parseLog(log);
  const marketAddr = decoded.args.market;
  console.log(`           ↳ market ${marketAddr}`);

  /* ------------------------- Persist addresses ----------------------- */

  const lendingBlock = {
    irm:              irmAddr,
    insuranceFund:    insuranceFundAddr,
    oracleRouter:     oracleRouterAddr,
    marketFactory:    factoryAddr,
    timelock:         deployer.address,        // testnet placeholder
    irmParams: {
      baseRatePerYearWad:   IRM_BASE_RATE_PER_YEAR.toString(),
      kinkUtilisationWad:   IRM_KINK_UTILISATION.toString(),
      slope1PerYearWad:     IRM_SLOPE1_PER_YEAR.toString(),
      slope2PerYearWad:     IRM_SLOPE2_PER_YEAR.toString(),
    },
    oracleAdapters: {
      RUSD_USDT: oracleAdapterAddr,
    },
    markets: {
      RUSD_USDT: {
        address:             marketAddr,
        loanToken:           USDT,
        collateralToken:     RUSD,
        oracle:              oracleAdapterAddr,
        irm:                 irmAddr,
        lltvBps:             Number(STAGE1_LLTV_BPS),
        liquidationBonusBps: Number(STAGE1_LIQUIDATION_BONUS_BPS),
        reserveFactorBps:    Number(STAGE1_RESERVE_FACTOR_BPS),
        supplyCap:           STAGE1_SUPPLY_CAP.toString(),
        borrowCap:           STAGE1_BORROW_CAP.toString(),
      },
    },
  };

  const merged = { ...existing, lending: lendingBlock };
  addresses.save(chainId, merged);
  console.log(`\n[lending-deploy] addresses/${chainId}.json updated (key: \"lending\")`);

  console.log("\n[lending-deploy] DONE — Stage 1 deployed:");
  console.log(JSON.stringify(lendingBlock, null, 2));
}

function requireAddr(map, key) {
  const v = map[key];
  if (!v || typeof v !== "string" || !v.startsWith("0x")) {
    throw new Error(`Missing/invalid address for "${key}" in addresses file`);
  }
  return v;
}

main().catch((err) => { console.error(err); process.exit(1); });
