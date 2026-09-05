/**
 * Stage 2 lending deploy — Ethereum HOODI testnet (chainId 560048).
 *
 * Mirror of deploy-lending-stage2-sepolia.js, retargeted at HOODI. Builds
 * on Stage 1 (deploy-lending-hoodi.js) by adding 4 more markets sharing
 * the existing KinkedIRM / InsuranceFundV2 / OracleRouterV2 / Factory.
 *
 * Markets added on HOODI (Stage 2):
 *   ┌──┬──────────┬──────┬──────┬──────────┬───────┬──────────────┐
 *   │ #│ Collat   │ Loan │ LLTV │ LiqBonus │ Resv  │ Oracle       │
 *   ├──┼──────────┼──────┼──────┼──────────┼───────┼──────────────┤
 *   │ 1│ sRUSD    │ USDT │ 9200 │   500    │  1000 │ Const 1e36   │
 *   │ 2│ sFYUSD   │ USDC │ 9200 │   500    │  1000 │ Const 1e36   │
 *   │ 3│ USDC     │ USDT │ 8700 │   300    │   500 │ Const 1e36   │
 *   │ 4│ FYUSD    │ USDT │ 9000 │   500    │  1000 │ Const 1e36   │
 *   └──┴──────────┴──────┴──────┴──────────┴───────┴──────────────┘
 *
 * (Skipped vs. Sepolia stage2: SIRUSD_USDT — StakedIRUSD not deployed on
 * HOODI yet; WETH_USDT — WETH address blank in addresses/560048.json.)
 *
 * Note: sFYUSD == StakedAUSD (same contract — see StakedAUSD.sol header).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-lending-stage2-hoodi.js --network hoodi
 *
 * Idempotency: re-running this script will redeploy the adapters + create
 * fresh market clones. To avoid orphan markets, only run once per Stage 2
 * release. The script appends new entries under `lending.markets.*` and
 * leaves existing keys (including Stage 1 RUSD_USDT) intact.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 560048;

const PRICE_1E36 = 10n ** 36n;

const MARKETS = [
  // key             collateralKey   loanKey  lltv  bonus  reserve  priceTag
  { key: "SRUSD_USDT",  collat: "StakedRUSD", loan: "USDT", lltv: 9200, bonus: 500, reserve: 1000, priceTag: "1e36" },
  { key: "SFYUSD_USDC", collat: "stAUSD",     loan: "USDC", lltv: 9200, bonus: 500, reserve: 1000, priceTag: "1e36" },
  { key: "USDC_USDT",   collat: "USDC",       loan: "USDT", lltv: 8700, bonus: 300, reserve:  500, priceTag: "1e36" },
  { key: "FYUSD_USDT",  collat: "FYUSD",      loan: "USDT", lltv: 9000, bonus: 500, reserve: 1000, priceTag: "1e36" },
];

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `deploy-lending-stage2-hoodi.js requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}. ` +
      `Re-run with --network hoodi.`
    );
  }
  const [deployer] = await ethers.getSigners();
  console.log(`\n[stage2-deploy] chainId ${chainId} deployer ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`[stage2-deploy] balance ${ethers.formatEther(bal)} ETH\n`);

  const map = addresses.load(chainId);
  if (!map.lending) {
    throw new Error("Stage 1 lending block missing — run deploy-lending-hoodi.js first.");
  }

  const oracleRouterAddr  = require_(map.lending, "oracleRouter");
  const irmAddr           = require_(map.lending, "irm");
  const insuranceFundAddr = require_(map.lending, "insuranceFund");
  const factoryAddr       = require_(map.lending, "marketFactory");
  const reuseAdapter1e36  = map.lending?.oracleAdapters?.RUSD_USDT;

  console.log(`[stage2-deploy] reusing system contracts:`);
  console.log(`           irm           ${irmAddr}`);
  console.log(`           fund          ${insuranceFundAddr}`);
  console.log(`           oracleRouter  ${oracleRouterAddr}`);
  console.log(`           factory       ${factoryAddr}`);
  console.log(`           const-1e36    ${reuseAdapter1e36}\n`);

  const factory      = await ethers.getContractAt("FypherLendingMarketFactory", factoryAddr);
  const oracleRouter = await ethers.getContractAt("OracleRouterV2", oracleRouterAddr);

  // One adapter per unique price tag. Stage 1 already deployed a 1e36
  // adapter for RUSD/USDT — reuse it for every stable-stable pair.
  const adapters = { "1e36": reuseAdapter1e36 };
  const Adapter  = await ethers.getContractFactory("ConstantOracleAdapter");

  const newMarkets  = {};
  const newAdapters = {};

  for (let i = 0; i < MARKETS.length; i++) {
    const m = MARKETS[i];
    console.log(`[stage2-deploy] ${i + 1}/${MARKETS.length} ${m.key}`);

    const collateral = require_(map, m.collat);
    const loan       = require_(map, m.loan);

    let adapterAddr = adapters[m.priceTag];
    if (!adapterAddr) {
      const adapter = await Adapter.deploy(PRICE_1E36);
      await adapter.waitForDeployment();
      adapterAddr = await adapter.getAddress();
      adapters[m.priceTag] = adapterAddr;
      newAdapters[`${m.priceTag}_${m.key}`] = adapterAddr;
      console.log(`           deployed adapter (${m.priceTag}) ${adapterAddr}`);
    } else {
      console.log(`           reusing adapter (${m.priceTag}) ${adapterAddr}`);
    }

    await (await oracleRouter.setAdapter(collateral, loan, adapterAddr)).wait();

    const init = {
      loanToken:           loan,
      collateralToken:     collateral,
      oracle:              adapterAddr,
      irm:                 irmAddr,
      lltvBps:             BigInt(m.lltv),
      liquidationBonusBps: BigInt(m.bonus),
      reserveFactorBps:    BigInt(m.reserve),
      supplyCap:           0n,
      borrowCap:           0n,
      timelock:            deployer.address,
      insuranceFund:       insuranceFundAddr,
    };
    const tx = await factory.createMarket(init);
    const rcpt = await tx.wait();
    const topic = factory.interface.getEvent("MarketCreated").topicHash;
    const log = rcpt.logs.find(l => l.topics[0] === topic);
    if (!log) throw new Error(`MarketCreated event missing for ${m.key}`);
    const marketAddr = factory.interface.parseLog(log).args.market;
    console.log(`           ↳ market ${marketAddr}\n`);

    newMarkets[m.key] = {
      address:             marketAddr,
      loanToken:           loan,
      collateralToken:     collateral,
      oracle:              adapterAddr,
      irm:                 irmAddr,
      lltvBps:             m.lltv,
      liquidationBonusBps: m.bonus,
      reserveFactorBps:    m.reserve,
      supplyCap:           "0",
      borrowCap:           "0",
    };
  }

  map.lending.markets        = { ...(map.lending.markets || {}), ...newMarkets };
  map.lending.oracleAdapters = { ...(map.lending.oracleAdapters || {}), ...newAdapters };
  addresses.save(chainId, map);
  console.log(`[stage2-deploy] addresses/${chainId}.json updated (added ${Object.keys(newMarkets).length} markets)`);

  console.log("\n[stage2-deploy] DONE — Stage 2 markets:");
  for (const [k, v] of Object.entries(newMarkets)) {
    console.log(`  ${k.padEnd(14)} ${v.address}`);
  }

  console.log("\n[stage2-deploy] Wire gateway to enumerate via factory:");
  console.log(`  export FYPHERX_LENDING_MARKET_FACTORY=${factoryAddr}`);
  console.log(`  # then restart fypherx-gateway`);
}

function require_(map, key) {
  const v = map[key];
  if (!v || typeof v !== "string" || !v.startsWith("0x")) {
    throw new Error(`Missing/invalid address for "${key}" in addresses file`);
  }
  return v;
}

main().catch((err) => { console.error(err); process.exit(1); });
