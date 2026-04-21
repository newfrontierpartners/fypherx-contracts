/**
 * WS smoke test — connect to Binance public trade stream for BTCUSDT,
 * log the first 10 ticks, then exit. Run before wiring the keeper to
 * validate: geo-access, WS library, message format, latency.
 *
 *   npx ts-node scripts/ws-smoke.ts [symbol] [count]
 *
 * Examples:
 *   npx ts-node scripts/ws-smoke.ts                 # BTCUSDT × 10 ticks
 *   npx ts-node scripts/ws-smoke.ts ethusdt 5       # ETHUSDT × 5 ticks
 */

import WebSocket from "ws";

const symbol = (process.argv[2] ?? "btcusdt").toLowerCase();
const limit = Number(process.argv[3] ?? 10);
const url = `wss://stream.binance.com:9443/ws/${symbol}@trade`;

console.log(`[ws-smoke] connecting to ${url}`);
const t0 = Date.now();
const ws = new WebSocket(url);

let ticks = 0;
const timeout = setTimeout(() => {
  console.error(`[ws-smoke] TIMEOUT: no tick in 15s. Possible geo-block or network issue.`);
  ws.terminate();
  process.exit(2);
}, 15_000);

ws.on("open", () => {
  console.log(`[ws-smoke] connected in ${Date.now() - t0}ms`);
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    // Trade stream payload shape:
    // { e: "trade", E: eventTime, s: symbol, t: tradeId, p: price, q: qty, T: tradeTime, m: isBuyerMaker }
    const price = Number(msg.p);
    const tradeTime = Number(msg.T);
    const lag = Date.now() - tradeTime;
    ticks++;
    console.log(
      `[${ticks}/${limit}] ${msg.s} $${price.toFixed(2)}  qty=${Number(msg.q).toFixed(6)}  lag=${lag}ms  ${msg.m ? "SELL" : "BUY"}`
    );
    if (ticks >= limit) {
      clearTimeout(timeout);
      console.log(`[ws-smoke] OK. Received ${ticks} ticks in ${Date.now() - t0}ms.`);
      ws.close();
      process.exit(0);
    }
  } catch (e) {
    console.error(`[ws-smoke] malformed message:`, data.toString().slice(0, 200), e);
  }
});

ws.on("error", (err) => {
  clearTimeout(timeout);
  console.error(`[ws-smoke] WS error:`, err.message);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log(`[ws-smoke] closed (code=${code}${reason ? `, reason=${reason}` : ""})`);
});
