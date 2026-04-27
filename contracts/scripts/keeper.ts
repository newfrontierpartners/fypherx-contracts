/**
 * FypherX price keeper — streams real-time prices from public exchange
 * WebSockets and pushes them to the on-chain MockPriceOracle on BSC Testnet
 * with hybrid throttling (heartbeat OR delta).
 *
 * Architecture
 * ────────────
 *   ┌─── Binance (primary) ───┐
 *   │   Binance-vision        │──►  PriceAggregator
 *   │   Binance futures       │       │  (keeps latest tick + source)
 *   │   OKX                   │       ▼
 *   │   Bybit                 │   Throttle loop (every 2s):
 *   │   Coinbase              │     - if stale > heartbeatSec → push
 *   └─────────────────────────┘     - if |Δ bps| > deltaBps   → push
 *                                     otherwise skip
 *                                   │
 *                                   ▼
 *                         setLatestAnswer on-chain
 *
 * Failover: sources ordered by priority. Aggregator picks the highest-priority
 * source whose last tick is younger than `STALE_MS`. If Binance drops or
 * becomes stale (> 10s no tick), OKX/Bybit/Coinbase auto-promote.
 *
 * Usage
 * ─────
 *   npx ts-node scripts/keeper.ts                 # defaults: BTC-PERP,ETH-PERP
 *   npx ts-node scripts/keeper.ts BTC-PERP        # single market
 *   HEARTBEAT_SEC=30 DELTA_BPS=5 npx ts-node scripts/keeper.ts
 *
 * Ctrl+C to stop. Script auto-reconnects WS on close.
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_SEC = Number(process.env.HEARTBEAT_SEC ?? 60);
const DELTA_BPS = Number(process.env.DELTA_BPS ?? 10);           // 10bps = 0.1%
const STALE_MS = Number(process.env.STALE_MS ?? 10_000);          // 10s no tick → stale
const THROTTLE_CHECK_MS = 2_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 30_000;
const WS_PING_MS = 180_000;                                       // 3 min

const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const PK = process.env.DEPLOYER_PRIVATE_KEY;
if (!PK) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");

const EXPLORER = "https://testnet.bscscan.com";

type Deployments = {
  oracles: Record<string, { feed: string; decimals: number }>;
};
const deployments: Deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments", "bscTestnet.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PK, provider);

const ORACLE_FEED_ABI = [
  "function setLatestAnswer(int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

// ────────────────────────────────────────────────────────────────────────────
// Source definitions — per market, ordered by priority.
// Each entry: { name, url, subscribe?, parse(raw) → { price, ts } | null }
// ────────────────────────────────────────────────────────────────────────────

interface ParsedTick { price: number; ts: number }
interface SourceSpec {
  name: string;
  url: string;
  subscribe?: string;
  parse: (raw: string) => ParsedTick | null;
}

function binanceSpot(symbol: string): SourceSpec {
  return {
    name: "binance-spot",
    url: `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@trade`,
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { price: Number(m.p), ts: Number(m.T) };
    },
  };
}

function binanceVision(symbol: string): SourceSpec {
  return {
    name: "binance-vision",
    url: `wss://data-stream.binance.vision/ws/${symbol.toLowerCase()}@trade`,
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { price: Number(m.p), ts: Number(m.T) };
    },
  };
}

function binanceFutures(symbol: string): SourceSpec {
  return {
    name: "binance-fapi",
    url: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@trade`,
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { price: Number(m.p), ts: Number(m.T) };
    },
  };
}

function okxSpot(instId: string): SourceSpec {
  return {
    name: "okx",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId }] }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      const d = m?.data?.[0];
      if (!d?.px || !d?.ts) return null;
      return { price: Number(d.px), ts: Number(d.ts) };
    },
  };
}

function bybitSpot(symbol: string): SourceSpec {
  return {
    name: "bybit",
    url: "wss://stream.bybit.com/v5/public/spot",
    subscribe: JSON.stringify({ op: "subscribe", args: [`publicTrade.${symbol}`] }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      const d = m?.data?.[0];
      if (!d?.p || !d?.T) return null;
      return { price: Number(d.p), ts: Number(d.T) };
    },
  };
}

function coinbaseSpot(productId: string): SourceSpec {
  return {
    name: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: JSON.stringify({
      type: "subscribe",
      product_ids: [productId],
      channels: ["matches"],
    }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== "match" || !m.price || !m.time) return null;
      return { price: Number(m.price), ts: new Date(m.time).getTime() };
    },
  };
}

// market → ordered source list (primary first)
const MARKET_SOURCES: Record<string, SourceSpec[]> = {
  "BTC-PERP": [
    binanceSpot("BTCUSDT"),
    binanceVision("BTCUSDT"),
    binanceFutures("BTCUSDT"),
    okxSpot("BTC-USDT"),
    bybitSpot("BTCUSDT"),
    coinbaseSpot("BTC-USD"),
  ],
  "ETH-PERP": [
    binanceSpot("ETHUSDT"),
    binanceVision("ETHUSDT"),
    binanceFutures("ETHUSDT"),
    okxSpot("ETH-USDT"),
    bybitSpot("ETHUSDT"),
    coinbaseSpot("ETH-USD"),
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// PriceStream — one WS connection with auto-reconnect
// ────────────────────────────────────────────────────────────────────────────

class PriceStream {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  public lastPrice = 0;
  public lastTickMs = 0;
  public connected = false;

  constructor(public readonly market: string, public readonly spec: SourceSpec) {}

  start() {
    this.connect();
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try { this.ws?.removeAllListeners(); this.ws?.close(); } catch { /* */ }
    this.ws = null;
  }

  private connect() {
    const ws = new WebSocket(this.spec.url);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      if (this.spec.subscribe) ws.send(this.spec.subscribe);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try { ws.ping(); } catch { /* */ }
      }, WS_PING_MS);
    });

    ws.on("message", (data) => {
      try {
        const tick = this.spec.parse(data.toString());
        if (!tick || !Number.isFinite(tick.price)) return;
        this.lastPrice = tick.price;
        this.lastTickMs = Date.now();
      } catch { /* ignore malformed */ }
    });

    ws.on("error", () => { /* handled in close */ });

    ws.on("close", () => {
      this.connected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * (2 ** this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  isFresh(now = Date.now()): boolean {
    return this.connected && this.lastTickMs > 0 && now - this.lastTickMs < STALE_MS;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregator — picks best source per market, with failover
// ────────────────────────────────────────────────────────────────────────────

class MarketAggregator {
  public readonly streams: PriceStream[];

  constructor(public readonly market: string) {
    const specs = MARKET_SOURCES[market];
    if (!specs) throw new Error(`No sources for ${market}`);
    this.streams = specs.map((s) => new PriceStream(market, s));
  }

  start() { this.streams.forEach((s) => s.start()); }
  stop()  { this.streams.forEach((s) => s.stop()); }

  /** Returns best current price + source name, or null if no source is fresh. */
  best(): { price: number; source: string } | null {
    for (const s of this.streams) {
      if (s.isFresh()) return { price: s.lastPrice, source: s.spec.name };
    }
    return null;
  }

  summary(): string {
    return this.streams
      .map((s) => {
        if (!s.connected) return `${s.spec.name}:off`;
        const age = s.lastTickMs ? `${((Date.now() - s.lastTickMs) / 1000).toFixed(1)}s` : "—";
        return `${s.spec.name}:${age}`;
      })
      .join(" ");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Throttled on-chain pusher
// ────────────────────────────────────────────────────────────────────────────

interface MarketState {
  market: string;
  feed: ethers.Contract;
  feedDecimals: number;
  aggregator: MarketAggregator;
  lastPushedPrice: number;
  lastPushedAt: number;
  pendingTx: Promise<unknown> | null;
}

async function initMarket(market: string): Promise<MarketState> {
  const info = deployments.oracles[market];
  if (!info) throw new Error(`Market ${market} not in deployments`);

  const feed = new ethers.Contract(info.feed, ORACLE_FEED_ABI, wallet);
  const feedDecimals = Number(await feed.decimals());

  // Bootstrap: read the last on-chain price so we don't push a redundant tx
  let lastOnChain = 0;
  try {
    const r = await feed.latestRoundData();
    lastOnChain = Number(ethers.formatUnits(r[1], feedDecimals));
  } catch { /* ignore */ }

  const agg = new MarketAggregator(market);
  agg.start();

  return {
    market,
    feed,
    feedDecimals,
    aggregator: agg,
    lastPushedPrice: lastOnChain,
    lastPushedAt: lastOnChain > 0 ? Date.now() : 0,
    pendingTx: null,
  };
}

function shouldPush(state: MarketState, newPrice: number, now: number): { should: boolean; reason: string } {
  if (state.pendingTx) return { should: false, reason: "tx pending" };
  if (state.lastPushedPrice === 0) return { should: true, reason: "initial" };
  const deltaBps = Math.abs(newPrice - state.lastPushedPrice) / state.lastPushedPrice * 10_000;
  if (deltaBps >= DELTA_BPS) return { should: true, reason: `Δ${deltaBps.toFixed(2)}bps` };
  const ageSec = (now - state.lastPushedAt) / 1000;
  if (ageSec >= HEARTBEAT_SEC) return { should: true, reason: `heartbeat ${ageSec.toFixed(0)}s` };
  return { should: false, reason: "" };
}

async function pushIfNeeded(state: MarketState): Promise<void> {
  const now = Date.now();
  const best = state.aggregator.best();
  if (!best) {
    const ts = new Date(now).toISOString().split("T")[1].slice(0, 8);
    console.warn(`[${ts}] ${state.market}  all sources stale — ${state.aggregator.summary()}`);
    return;
  }

  const decision = shouldPush(state, best.price, now);
  if (!decision.should) return;

  const answer = BigInt(Math.round(best.price * 10 ** state.feedDecimals));
  const pricePrev = state.lastPushedPrice;
  state.lastPushedPrice = best.price;
  state.lastPushedAt = now;

  const send = state.feed.setLatestAnswer(answer)
    .then(async (tx: ethers.ContractTransactionResponse) => {
      const r = await tx.wait();
      const ts = new Date().toISOString().split("T")[1].slice(0, 8);
      const deltaBps = pricePrev > 0
        ? ((best.price - pricePrev) / pricePrev * 10_000).toFixed(2)
        : "—";
      console.log(
        `[${ts}] ${state.market}  $${best.price.toFixed(2)}  ` +
        `src=${best.source.padEnd(14)}  Δ=${deltaBps.padStart(7)}bps  ` +
        `reason=${decision.reason}  block=${r?.blockNumber}  ${EXPLORER}/tx/${tx.hash}`
      );
    })
    .catch((err: Error) => {
      // Roll back the "pushed" state so next tick retries
      state.lastPushedPrice = pricePrev;
      console.error(`[${state.market}] push failed:`, err.message);
    })
    .finally(() => {
      state.pendingTx = null;
    });

  state.pendingTx = send;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const marketsArg = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const markets = marketsArg.length > 0 ? marketsArg : ["BTC-PERP", "ETH-PERP"];

  console.log(`[keeper] starting`);
  console.log(`  relayer  : ${wallet.address}`);
  console.log(`  rpc      : ${RPC_URL}`);
  console.log(`  markets  : ${markets.join(", ")}`);
  console.log(`  throttle : heartbeat=${HEARTBEAT_SEC}s  delta=${DELTA_BPS}bps`);
  console.log(`  failover : stale=${STALE_MS}ms, sources per market=${MARKET_SOURCES[markets[0]]?.length ?? 0}`);
  console.log();

  const states = await Promise.all(markets.map(initMarket));

  console.log(`[keeper] all streams started. First push in ~${THROTTLE_CHECK_MS}ms.\n`);

  // Status line every 15s so user sees keeper alive
  const statusTimer = setInterval(() => {
    const ts = new Date().toISOString().split("T")[1].slice(0, 8);
    for (const s of states) {
      console.log(`[${ts}] ${s.market}  status: ${s.aggregator.summary()}`);
    }
  }, 15_000);

  const throttleTimer = setInterval(() => {
    for (const s of states) void pushIfNeeded(s);
  }, THROTTLE_CHECK_MS);

  const shutdown = () => {
    console.log(`\n[keeper] stopping…`);
    clearInterval(statusTimer);
    clearInterval(throttleTimer);
    for (const s of states) s.aggregator.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
