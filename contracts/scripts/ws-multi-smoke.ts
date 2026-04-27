/**
 * Multi-source WS smoke test. Connects to 5 public exchange streams in
 * parallel, grabs 3 ticks from each, reports which work + latency. Run
 * this when Binance might be blocked (prod US hosting, some EU CDNs).
 *
 *   npx ts-node scripts/ws-multi-smoke.ts
 *
 * Each adapter normalises to { source, price, qty, lagMs }.
 */

import WebSocket from "ws";

type Tick = { source: string; price: number; qty: number; lagMs: number };
type SourceResult = {
  name: string;
  url: string;
  connected: boolean;
  connectMs: number | null;
  ticks: Tick[];
  error: string | null;
};

interface Source {
  name: string;
  url: string;
  // Optional subscribe message to send after connect
  subscribe?: string;
  // Parse a raw WS message → tick (or null to ignore)
  parse: (raw: string) => Tick | null;
}

const TARGET_TICKS = 3;
const TIMEOUT_MS = 12_000;

const SOURCES: Source[] = [
  {
    name: "Binance spot",
    url: "wss://stream.binance.com:9443/ws/btcusdt@trade",
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { source: "binance-spot", price: Number(m.p), qty: Number(m.q), lagMs: Date.now() - Number(m.T) };
    },
  },
  {
    name: "Binance data-vision mirror",
    url: "wss://data-stream.binance.vision/ws/btcusdt@trade",
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { source: "binance-vision", price: Number(m.p), qty: Number(m.q), lagMs: Date.now() - Number(m.T) };
    },
  },
  {
    name: "Binance futures (fapi)",
    url: "wss://fstream.binance.com/ws/btcusdt@trade",
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (!m.p || !m.T) return null;
      return { source: "binance-fapi", price: Number(m.p), qty: Number(m.q), lagMs: Date.now() - Number(m.T) };
    },
  },
  {
    name: "OKX spot",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: JSON.stringify({
      op: "subscribe",
      args: [{ channel: "trades", instId: "BTC-USDT" }],
    }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      const d = m?.data?.[0];
      if (!d || !d.px || !d.ts) return null;
      return { source: "okx", price: Number(d.px), qty: Number(d.sz), lagMs: Date.now() - Number(d.ts) };
    },
  },
  {
    name: "Bybit spot",
    url: "wss://stream.bybit.com/v5/public/spot",
    subscribe: JSON.stringify({ op: "subscribe", args: ["publicTrade.BTCUSDT"] }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      const d = m?.data?.[0];
      if (!d || !d.p || !d.T) return null;
      return { source: "bybit", price: Number(d.p), qty: Number(d.v), lagMs: Date.now() - Number(d.T) };
    },
  },
  {
    name: "Coinbase (Exchange)",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["matches"],
    }),
    parse: (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== "match" || !m.price || !m.time) return null;
      return { source: "coinbase", price: Number(m.price), qty: Number(m.size), lagMs: Date.now() - new Date(m.time).getTime() };
    },
  },
];

async function testSource(src: Source): Promise<SourceResult> {
  const result: SourceResult = {
    name: src.name,
    url: src.url,
    connected: false,
    connectMs: null,
    ticks: [],
    error: null,
  };

  return new Promise((resolve) => {
    const t0 = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(src.url);
    } catch (e) {
      result.error = (e as Error).message;
      resolve(result);
      return;
    }

    const timer = setTimeout(() => {
      if (result.ticks.length < TARGET_TICKS) {
        result.error = result.error ?? `timeout after ${TIMEOUT_MS}ms (${result.ticks.length}/${TARGET_TICKS} ticks)`;
      }
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(result);
    }, TIMEOUT_MS);

    ws.on("open", () => {
      result.connected = true;
      result.connectMs = Date.now() - t0;
      if (src.subscribe) ws.send(src.subscribe);
    });

    ws.on("message", (data) => {
      try {
        const tick = src.parse(data.toString());
        if (!tick) return;
        result.ticks.push(tick);
        if (result.ticks.length >= TARGET_TICKS) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          resolve(result);
        }
      } catch (e) {
        result.error = `parse: ${(e as Error).message}`;
      }
    });

    ws.on("error", (err) => {
      result.error = err.message;
    });

    ws.on("close", () => {
      if (!result.connected) {
        clearTimeout(timer);
        resolve(result);
      }
    });
  });
}

(async () => {
  console.log(`[multi-smoke] testing ${SOURCES.length} sources in parallel, target=${TARGET_TICKS} ticks each, timeout=${TIMEOUT_MS / 1000}s\n`);

  const results = await Promise.all(SOURCES.map(testSource));

  console.log("─".repeat(92));
  console.log("Source                           Status     Connect   Ticks   Avg Price    Lag       Error");
  console.log("─".repeat(92));
  for (const r of results) {
    const status = r.ticks.length >= TARGET_TICKS ? "✅ OK   " : r.connected ? "⚠ PARTIAL" : "❌ FAIL ";
    const connectMs = r.connectMs ? `${r.connectMs}ms`.padEnd(8) : "—".padEnd(8);
    const tickCount = `${r.ticks.length}/${TARGET_TICKS}`.padEnd(6);
    const avgPrice = r.ticks.length > 0
      ? `$${(r.ticks.reduce((a, t) => a + t.price, 0) / r.ticks.length).toFixed(2)}`.padEnd(11)
      : "—".padEnd(11);
    const avgLag = r.ticks.length > 0
      ? `${Math.round(r.ticks.reduce((a, t) => a + t.lagMs, 0) / r.ticks.length)}ms`.padEnd(8)
      : "—".padEnd(8);
    const err = r.error ? r.error.slice(0, 40) : "";
    console.log(`${r.name.padEnd(32)} ${status}  ${connectMs}  ${tickCount}  ${avgPrice} ${avgLag}  ${err}`);
  }
  console.log("─".repeat(92));

  const working = results.filter((r) => r.ticks.length >= TARGET_TICKS);
  console.log(`\n${working.length}/${SOURCES.length} sources healthy.`);
  if (working.length > 0) {
    console.log(`Recommended primary: ${working.sort((a, b) => (a.connectMs ?? 1e9) - (b.connectMs ?? 1e9))[0].name}`);
  }
})();
