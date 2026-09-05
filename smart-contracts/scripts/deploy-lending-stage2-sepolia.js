/**
 * Stage 2 lending deploy — Ethereum Sepolia (chainId 11155111).
 *
 * Builds on Stage 1 (deploy-lending-sepolia.js) by adding 5 more markets
 * sharing the same KinkedIRM / InsuranceFundV2 / OracleRouterV2 / Factory.
 *
 * For testnet we keep oracles trivial — every pair is constant-priced via
 * ConstantOracleAdapter (Morpho 1e36 scale). All ERC20 mocks on Sepolia
 * are 18 decimals (verified via mint-tokens.js), so the math is uniform:
 *   1:1 pairs        → price = 1e36
 *   WETH ≈ $3000     → price = 3000 × 1e36
 *
 * Markets added (Stage 2):
 *   ┌──┬──────────┬──────┬──────┬──────────┬───────┬──────────────┐
 *   │ #│ Collat   │ Loan │ LLTV │ LiqBonus │ Resv  │ Oracle       │
 *   ├──┼──────────┼──────┼──────┼──────────┼───────┼──────────────┤
 *   │ 1│ sRUSD    │ USDT │ 9200 │   500    │  1000 │ Const 1e36   │
 *   │ 2│ sFYUSD   │ USDC │ 9200 │   500    │  1000 │ Const 1e36   │
 *   │ 3│ siRUSD   │ USDT │ 9000 │   500    │  1000 │ Const 1e36   │
 *   │ 4│ USDC     │ USDT │ 8700 │   300    │   500 │ Const 1e36   │
 *   │ 5│ WETH     │ USDT │ 8000 │   750    │  1500 │ Const 3e39   │
 *   └──┴──────────┴──────┴──────┴──────────┴───────┴──────────────┘
 *
 * Note: sFYUSD == StakedAUSD (same contract — see StakedAUSD.sol header).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-lending-stage2-sepolia.js --network sepolia
 *
 * Idempotency: re-running this script will redeploy the adapters + create
 * fresh market clones. To avoid orphan markets, only run once per Stage 2
 * release. The script appends new entries under `lending.markets.*` and
 * leaves existing keys (including Stage 1 RUSD_USDT) intact.
 */
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

const EXPECTED_CHAIN_ID = 11155111;

// Constants matching Stage 1.
const PRICE_1E36   = 10n ** 36n;
const PRICE_WETH   = 3000n * (10n ** 36n);  // WETH @ ~$3000, both 18 dec.

// Per-market init params (mirrors Tier-tier doc).
const MARKETS = [
  // key             collateralKey  loanKey  lltv  liqBonus  reserve
  { key: "SRUSD_USDT",  collat: "StakedRUSD",  loan: "USDT", lltv: 9200, bonus: 500, reserve: 1000, priceTag: "1e36"  },
  { key: "SFYUSD_USDC", collat: "stAUSD",      loan: "USDC", lltv: 9200, bonus: 500, reserve: 1000, priceTag: "1e36"  },
  { key: "SIRUSD_USDT", collat: "StakedIRUSD", loan: "USDT", lltv: 9000, bonus: 500, reserve: 1000, priceTag: "1e36"  },
  { key: "USDC_USDT",   collat: "USDC",        loan: "USDT", lltv: 8700, bonus: 300, reserve:  500, priceTag: "1e36"  },
  { key: "WETH_USDT",   collat: "WETH",        loan: "USDT", lltv: 8000, bonus: 750, reserve: 1500, priceTag: "3e39"  },
];

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `deploy-lending-stage2-sepolia.js requires chainId ${EXPECTED_CHAIN_ID}, got ${chainId}. ` +
      `Re-run with --network sepolia.`
    );
  }
  const [deployer] = await ethers.getSigners();
  console.log(`\n[stage2-deploy] chainId ${chainId} deployer ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`[stage2-deploy] balance ${ethers.formatEther(bal)} ETH\n`);

  const map = addresses.load(chainId);
  if (!map.lending) {
    throw new Error("Stage 1 lending block missing — run deploy-lending-sepolia.js first.");
  }

  const oracleRouterAddr   = require_(map.lending, "oracleRouter");
  const irmAddr            = require_(map.lending, "irm");
  const insuranceFundAddr  = require_(map.lending, "insuranceFund");
  const factoryAddr        = require_(map.lending, "marketFactory");
  const reuseAdapter1e36   = map.lending?.oracleAdapters?.RUSD_USDT;

  console.log(`[stage2-deploy] reusing system contracts:`);
  console.log(`           irm           ${irmAddr}`);
  console.log(`           fund          ${insuranceFundAddr}`);
  console.log(`           oracleRouter  ${oracleRouterAddr}`);
  console.log(`           factory       ${factoryAddr}`);
  console.log(`           const-1e36    ${reuseAdapter1e36}\n`);

  const factory      = await ethers.getContractAt("FypherLendingMarketFactory", factoryAddr);
  const oracleRouter = await ethers.getContractAt("OracleRouterV2", oracleRouterAddr);

  // We deploy one fresh adapter per *unique* price tag the markets need
  // beyond the Stage 1 1e36 adapter. For now that's just WETH ($3000).
  const adapters = { "1e36": reuseAdapter1e36 };
  const Adapter = await ethers.getContractFactory("ConstantOracleAdapter");

  const newMarkets = {};
  const newAdapters = {};

  for (let i = 0; i < MARKETS.length; i++) {
    const m = MARKETS[i];
    console.log(`[stage2-deploy] ${i + 1}/${MARKETS.length} ${m.key}`);

    const collateral = require_(map, m.collat);
    const loan       = require_(map, m.loan);

    let adapterAddr = adapters[m.priceTag];
    if (!adapterAddr) {
      const price = m.priceTag === "3e39" ? PRICE_WETH : PRICE_1E36;
      const adapter = await Adapter.deploy(price);
      await adapter.waitForDeployment();
      adapterAddr = await adapter.getAddress();
      adapters[m.priceTag] = adapterAddr;
      newAdapters[`${m.priceTag}_${m.key}`] = adapterAddr;
      console.log(`           deployed adapter (${m.priceTag}) ${adapterAddr}`);
    } else {
      console.log(`           reusing adapter (${m.priceTag}) ${adapterAddr}`);
    }

    // Register router mapping (idempotent — overwrites if pre-existing).
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

  // Persist — merge into existing lending block.
  map.lending.markets       = { ...(map.lending.markets || {}), ...newMarkets };
  map.lending.oracleAdapters = { ...(map.lending.oracleAdapters || {}), ...newAdapters };
  addresses.save(chainId, map);
  console.log(`[stage2-deploy] addresses/${chainId}.json updated (added ${Object.keys(newMarkets).length} markets)`);

  console.log("\n[stage2-deploy] DONE — Stage 2 markets:");
  for (const [k, v] of Object.entries(newMarkets)) {
    console.log(`  ${k.padEnd(14)} ${v.address}`);
  }
}

function require_(map, key) {
  const v = map[key];
  if (!v || typeof v !== "string" || !v.startsWith("0x")) {
    throw new Error(`Missing/invalid address for "${key}" in addresses file`);
  }
  return v;
}

main().catch((err) => { console.error(err); process.exit(1); });
