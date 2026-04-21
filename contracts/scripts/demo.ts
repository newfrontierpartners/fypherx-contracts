/**
 * FypherX Perps — BSC Testnet live demo script.
 *
 * Usage (from fypherx-contracts/contracts):
 *   npx ts-node scripts/demo.ts <cmd> [args...]
 *
 * Commands:
 *   status                  Print balances, account snapshot, positions, on-chain BTC mark
 *   sync-price [market]     Pull real spot price (BTCUSDT / ETHUSDT) from Binance
 *                           and write it to the MockPriceOracle (default: BTC-PERP)
 *   approve <amount>        Approve clearinghouse to pull RUSD
 *   deposit <amount>        Deposit RUSD into the clearinghouse
 *   withdraw <amount>       Withdraw free collateral
 *   long  <market> <size> <leverage>   Open / add long
 *   short <market> <size> <leverage>   Open / add short
 *   close <market>          Close the entire position at current mark
 *   keeper [markets...]     Stream Binance WS trades and push to MockPriceOracle
 *                           with hybrid throttle (heartbeat 60s OR delta 10bps).
 *                           Defaults to BTC-PERP,ETH-PERP. Ctrl+C to stop.
 *   full-demo               Run end-to-end flow: sync → deposit → long → snapshot → close → short → close
 *
 * Size is the position size in base units (e.g. 0.01 BTC). Leverage is a decimal number (e.g. 5).
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ---------- Types & constants ----------

type Deployments = {
  collateralToken: string;
  oracleRouterAddress: string;
  settlementAddress: string;
  insuranceFundVaultAddress: string;
  clearinghouseAddress: string;
  oracles: Record<string, { feed: string; decimals: number }>;
};

const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments", "bscTestnet.json");
const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const PK = process.env.DEPLOYER_PRIVATE_KEY;
const EXPLORER = "https://testnet.bscscan.com";

if (!PK) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");

const deployments: Deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));

// Binance symbol map
const BINANCE_SYMBOL: Record<string, string> = {
  "BTC-PERP": "BTCUSDT",
  "ETH-PERP": "ETHUSDT",
};

// ---------- Minimal ABIs ----------

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ORACLE_FEED_ABI = [
  "function setLatestAnswer(int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

const ORACLE_ROUTER_ABI = [
  "function getPriceE18(bytes32) view returns (uint256)",
  "function marketOracles(bytes32) view returns (address feed, uint8 feedDecimals, uint32 maxStaleness, bool active)",
  "function configureMarketOracle(bytes32 marketId, address feed, uint8 feedDecimals, uint32 maxStaleness, bool active)",
];

const CLEARINGHOUSE_ABI = [
  "function deposit(uint256 amountE18)",
  "function withdraw(uint256 amountE18)",
  "function executeMatchedTrade(address account, bytes32 marketId, bool isLong, uint256 sizeDeltaE18, uint256 executionPriceE18, uint256 requestedLeverageE18)",
  "function collateralBalanceE18(address) view returns (int256)",
  "function positions(address,bytes32) view returns (bool isLong, uint256 sizeE18, uint256 entryPriceE18, uint256 marginE18)",
  "function getAccountSnapshot(address) view returns (int256 collateralE18, int256 unrealizedPnlE18, int256 equityE18, uint256 initialMarginUsedE18, uint256 maintenanceMarginE18, bool liquidatable)",
  "function getAccountMarkets(address) view returns (bytes32[])",
  "function markets(bytes32) view returns (bool active, uint32 initialMarginBps, uint32 maintenanceMarginBps, uint32 maxTradeDeviationBps, uint256 maxLeverageE18, uint256 maxPositionSizeE18)",
  "function configureMarket(bytes32 marketId, uint32 initialMarginBps, uint32 maintenanceMarginBps, uint32 maxTradeDeviationBps, uint256 maxLeverageE18, uint256 maxPositionSizeE18, bool active)",
];

// ---------- Helpers ----------

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PK, provider);

const rusd = new ethers.Contract(deployments.collateralToken, ERC20_ABI, wallet);
const router = new ethers.Contract(deployments.oracleRouterAddress, ORACLE_ROUTER_ABI, wallet);
const ch = new ethers.Contract(deployments.clearinghouseAddress, CLEARINGHOUSE_ABI, wallet);

const marketIdBytes32 = (m: string) => ethers.encodeBytes32String(m);

const feedFor = (market: string) => {
  const o = deployments.oracles[market];
  if (!o) throw new Error(`Unknown market ${market}`);
  return new ethers.Contract(o.feed, ORACLE_FEED_ABI, wallet);
};

const fmtE18 = (v: bigint | string | number, digits = 4) =>
  Number(ethers.formatUnits(v.toString(), 18)).toFixed(digits);

const fmtE8 = (v: bigint, digits = 2) =>
  Number(ethers.formatUnits(v, 8)).toFixed(digits);

const link = (hash: string) => `${EXPLORER}/tx/${hash}`;

async function logTx(label: string, tx: ethers.ContractTransactionResponse) {
  console.log(`  → ${label}  ${link(tx.hash)}`);
  const r = await tx.wait();
  console.log(`     mined in block ${r?.blockNumber} (gas ${r?.gasUsed})`);
  return r;
}

async function fetchSpotPriceUSD(market: string): Promise<number> {
  const sym = BINANCE_SYMBOL[market];
  if (!sym) throw new Error(`No Binance mapping for ${market}`);
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed: ${res.status}`);
  const data = (await res.json()) as { price: string };
  return Number(data.price);
}

// ---------- Commands ----------

async function cmdStatus() {
  const addr = wallet.address;
  console.log(`\n=== FypherX Perps — status (${addr}) ===`);
  console.log(`RPC       ${RPC_URL}`);
  console.log(`Clearing  ${deployments.clearinghouseAddress}`);
  console.log(`RUSD      ${deployments.collateralToken}`);

  const [bnb, rusdBal] = await Promise.all([
    provider.getBalance(addr),
    rusd.balanceOf(addr) as Promise<bigint>,
  ]);
  console.log(`\nWallet: ${ethers.formatEther(bnb)} BNB | ${fmtE18(rusdBal)} RUSD`);

  const snap = await ch.getAccountSnapshot(addr);
  console.log(`\nAccount snapshot:`);
  console.log(`  collateral    ${fmtE18(snap[0])} RUSD`);
  console.log(`  unrealizedPnl ${fmtE18(snap[1])}`);
  console.log(`  equity        ${fmtE18(snap[2])}`);
  console.log(`  IM used       ${fmtE18(snap[3])}`);
  console.log(`  MM required   ${fmtE18(snap[4])}`);
  console.log(`  liquidatable  ${snap[5]}`);

  const marketIds: string[] = await ch.getAccountMarkets(addr);
  console.log(`\nPositions (${marketIds.length}):`);
  for (const id of marketIds) {
    const m = ethers.decodeBytes32String(id);
    const p = await ch.positions(addr, id);
    if (p[1] === 0n) continue;
    const mark = (await router.getPriceE18(id)) as bigint;
    console.log(
      `  ${m}: ${p[0] ? "LONG " : "SHORT"}  size=${fmtE18(p[1])}  entry=$${fmtE18(p[2], 2)}  mark=$${fmtE18(mark, 2)}  margin=${fmtE18(p[3])} RUSD`
    );
  }

  console.log(`\nOn-chain marks:`);
  for (const m of Object.keys(deployments.oracles)) {
    try {
      const mark = (await router.getPriceE18(marketIdBytes32(m))) as bigint;
      console.log(`  ${m}: $${fmtE18(mark, 2)}`);
    } catch (e: any) {
      console.log(`  ${m}: <unavailable: ${e.reason ?? e.shortMessage ?? e.message}>`);
    }
  }
  console.log();
}

async function cmdConfigureMarkets() {
  console.log(`\n=== Configuring markets on clearinghouse ${deployments.clearinghouseAddress} ===`);
  for (const market of Object.keys(deployments.oracles)) {
    const id = marketIdBytes32(market);
    const cfg = await ch.markets(id);
    if (cfg[0]) {
      console.log(`  ${market}: already active (IM ${cfg[1]}bps, MM ${cfg[2]}bps, maxLev ${fmtE18(cfg[4], 0)}x)`);
      continue;
    }
    console.log(`  ${market}: configureMarket(IM=500, MM=300, dev=2000, maxLev=20x, maxSize=5, active=true)`);
    const tx = await ch.configureMarket(
      id, 500, 300, 2000,
      ethers.parseUnits("20", 18),
      ethers.parseUnits("5", 18),
      true
    );
    await logTx(`configureMarket[${market}]`, tx);
  }
}

async function cmdRegisterOracles() {
  console.log(`\n=== Registering oracle feeds on router ${deployments.oracleRouterAddress} ===`);
  for (const [market, info] of Object.entries(deployments.oracles)) {
    const id = marketIdBytes32(market);
    const cfg = await router.marketOracles(id);
    if (cfg[0].toLowerCase() === info.feed.toLowerCase() && cfg[3]) {
      console.log(`  ${market}: already registered (${info.feed})`);
      continue;
    }
    console.log(`  ${market}: configuring feed=${info.feed}  decimals=${info.decimals}  staleness=3600  active=true`);
    const tx = await router.configureMarketOracle(id, info.feed, info.decimals, 3600, true);
    await logTx(`configureMarketOracle[${market}]`, tx);
  }
}

async function cmdSyncPrice(market = "BTC-PERP") {
  console.log(`\n=== Sync ${market} price from Binance → MockPriceOracle ===`);
  const spot = await fetchSpotPriceUSD(market);
  console.log(`  Binance spot: $${spot.toFixed(2)}`);

  const feed = feedFor(market);
  const decimals: number = Number(await feed.decimals());
  const answer = BigInt(Math.round(spot * 10 ** decimals));
  console.log(`  setLatestAnswer(${answer})  [${decimals} decimals]`);

  const tx = await feed.setLatestAnswer(answer);
  await logTx(`setLatestAnswer`, tx);

  const markE18 = (await router.getPriceE18(marketIdBytes32(market))) as bigint;
  console.log(`  router mark now: $${fmtE18(markE18, 2)}\n`);
  return markE18;
}

async function cmdApprove(amountStr: string) {
  const amount = ethers.parseUnits(amountStr, 18);
  console.log(`\n=== Approving ${amountStr} RUSD → clearinghouse ===`);
  const tx = await rusd.approve(deployments.clearinghouseAddress, amount);
  await logTx(`rusd.approve`, tx);
}

async function cmdDeposit(amountStr: string) {
  const amount = ethers.parseUnits(amountStr, 18);
  const allowance: bigint = await rusd.allowance(wallet.address, deployments.clearinghouseAddress);
  if (allowance < amount) {
    console.log(`  allowance insufficient (${fmtE18(allowance)} < ${amountStr}); approving first`);
    const atx = await rusd.approve(deployments.clearinghouseAddress, amount);
    await logTx(`rusd.approve`, atx);
  }
  console.log(`\n=== Depositing ${amountStr} RUSD ===`);
  const tx = await ch.deposit(amount);
  await logTx(`clearinghouse.deposit`, tx);
}

async function cmdWithdraw(amountStr: string) {
  const amount = ethers.parseUnits(amountStr, 18);
  console.log(`\n=== Withdraw ${amountStr} RUSD ===`);
  const tx = await ch.withdraw(amount);
  await logTx(`clearinghouse.withdraw`, tx);
}

async function openTrade(market: string, isLong: boolean, sizeStr: string, leverageStr: string) {
  await cmdSyncPrice(market);

  const markE18 = (await router.getPriceE18(marketIdBytes32(market))) as bigint;
  const sizeE18 = ethers.parseUnits(sizeStr, 18);
  const leverageE18 = ethers.parseUnits(leverageStr, 18);

  console.log(`\n=== ${isLong ? "LONG" : "SHORT"} ${sizeStr} ${market} @ mark $${fmtE18(markE18, 2)}  ${leverageStr}x ===`);
  const tx = await ch.executeMatchedTrade(
    wallet.address,
    marketIdBytes32(market),
    isLong,
    sizeE18,
    markE18,
    leverageE18
  );
  await logTx(`executeMatchedTrade`, tx);
  return { isLong, sizeE18, entryPriceE18: markE18 };
}

async function cmdClose(market: string) {
  await cmdSyncPrice(market);
  const id = marketIdBytes32(market);
  const p = await ch.positions(wallet.address, id);
  if (p[1] === 0n) {
    console.log(`  no open ${market} position`);
    return null;
  }
  const markE18 = (await router.getPriceE18(id)) as bigint;
  const closeIsLong = !p[0];
  console.log(
    `\n=== Close ${market}: ${p[0] ? "LONG" : "SHORT"} size=${fmtE18(p[1])} @ mark $${fmtE18(markE18, 2)} ===`
  );
  const tx = await ch.executeMatchedTrade(
    wallet.address,
    id,
    closeIsLong,
    p[1],
    markE18,
    ethers.parseUnits("1", 18)
  );
  await logTx(`executeMatchedTrade (close)`, tx);
  return { isLong: p[0], sizeE18: p[1] as bigint, exitPriceE18: markE18, entryPriceE18: p[2] as bigint };
}

async function cmdFullDemo() {
  console.log("\n################ FULL DEMO ################");
  await cmdRegisterOracles();
  await cmdConfigureMarkets();
  await cmdSyncPrice("BTC-PERP");

  const bal: bigint = await rusd.balanceOf(wallet.address);
  const snap0 = await ch.getAccountSnapshot(wallet.address);
  const TARGET = ethers.parseUnits("1000", 18);
  if (snap0[0] >= TARGET) {
    console.log(`\n(Skipping deposit — collateral already ${fmtE18(snap0[0])} RUSD)`);
  } else if (bal > 0n) {
    const depositAmt = bal < TARGET ? bal : TARGET;
    await cmdDeposit(ethers.formatUnits(depositAmt, 18));
  } else {
    console.error(
      `\n⚠️  Deployer has 0 RUSD and no collateral on the clearinghouse.\n` +
      `   Please mint RUSD to ${wallet.address} first, then re-run \`npm run demo:full\`.\n` +
      `   RUSD token: ${deployments.collateralToken}\n` +
      `   Mint via the RUSD dApp / core protocol — this demo reuses the existing token,\n` +
      `   it does NOT deploy a new RUSD or call a test faucet.\n`
    );
    process.exit(1);
  }

  type Row = { side: string; entry: bigint; exit: bigint; size: bigint; pnl: bigint; collatBefore: bigint; collatAfter: bigint };
  const rows: Row[] = [];

  const runRound = async (isLong: boolean) => {
    const label = isLong ? "LONG" : "SHORT";
    const before = (await ch.getAccountSnapshot(wallet.address))[0] as bigint;
    const opened = await openTrade("BTC-PERP", isLong, "0.01", "5");
    await cmdStatus();
    const closed = await cmdClose("BTC-PERP");
    await cmdStatus();
    const after = (await ch.getAccountSnapshot(wallet.address))[0] as bigint;
    if (opened && closed) {
      rows.push({
        side: label,
        entry: opened.entryPriceE18,
        exit: closed.exitPriceE18,
        size: opened.sizeE18,
        pnl: after - before,
        collatBefore: before,
        collatAfter: after,
      });
    }
  };

  const bnbBefore = await provider.getBalance(wallet.address);
  const collatStart = (await ch.getAccountSnapshot(wallet.address))[0] as bigint;

  await runRound(true);
  await runRound(false);

  const bnbAfter = await provider.getBalance(wallet.address);
  const collatEnd = (await ch.getAccountSnapshot(wallet.address))[0] as bigint;
  const totalPnl = collatEnd - collatStart;
  const gasBnb = bnbBefore - bnbAfter;

  console.log("\n================ P&L SUMMARY ================");
  console.log("Trade   Entry        Exit         Δ Price    Size      PnL (RUSD)");
  console.log("------  -----------  -----------  ---------  --------  ------------");
  for (const r of rows) {
    const deltaE18 = r.exit - r.entry;
    const sign = deltaE18 >= 0n ? "+" : "-";
    const absDelta = deltaE18 >= 0n ? deltaE18 : -deltaE18;
    const pnlSign = r.pnl >= 0n ? "+" : "-";
    const absPnl = r.pnl >= 0n ? r.pnl : -r.pnl;
    console.log(
      `${r.side.padEnd(6)}  $${fmtE18(r.entry, 2).padStart(10)}  $${fmtE18(r.exit, 2).padStart(10)}  ${sign}$${fmtE18(absDelta, 2).padStart(7)}  ${fmtE18(r.size).padStart(8)}  ${pnlSign}${fmtE18(absPnl, 6).padStart(11)}`
    );
  }
  console.log("---------------------------------------------------------------");
  const netSign = totalPnl >= 0n ? "+" : "-";
  const absNet = totalPnl >= 0n ? totalPnl : -totalPnl;
  console.log(`Collateral:   ${fmtE18(collatStart)} RUSD  →  ${fmtE18(collatEnd)} RUSD`);
  console.log(`Net PnL:      ${netSign}${fmtE18(absNet, 6)} RUSD`);
  console.log(`Gas spent:    ${ethers.formatEther(gasBnb)} BNB`);
  console.log("=============================================\n");
  console.log("################ DEMO DONE ################\n");
}

// ---------- Dispatch ----------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "status":           return cmdStatus();
    case "register-oracles":    return cmdRegisterOracles();
    case "configure-markets":   return cmdConfigureMarkets();
    case "sync-price":       return cmdSyncPrice(args[0]);
    case "approve":     return cmdApprove(args[0] ?? "10000");
    case "deposit":     return cmdDeposit(args[0] ?? "2000");
    case "withdraw":    return cmdWithdraw(args[0] ?? "100");
    case "long":        return openTrade(args[0] ?? "BTC-PERP", true,  args[1] ?? "0.01", args[2] ?? "5");
    case "short":       return openTrade(args[0] ?? "BTC-PERP", false, args[1] ?? "0.01", args[2] ?? "5");
    case "close":       return cmdClose(args[0] ?? "BTC-PERP");
    case "full-demo":
    case undefined:
    case "":            return cmdFullDemo();
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
