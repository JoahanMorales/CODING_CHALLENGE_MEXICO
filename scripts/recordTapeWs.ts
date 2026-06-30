import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import type { ExchangeId, NormalizedOrderBook, QuoteAsset, SymbolId } from "../src/lib/types";

// Real-market tape recorder over WEBSOCKET feeds (camino 1, latency edition).
//
// Unlike the REST recorder (which polls every venue together, so all books are
// captured synchronized and inter-venue staleness never exceeds the poll budget),
// this subscribes to each exchange's independent WS stream. When one venue's feed
// lags or goes quiet while others keep printing, its last book genuinely goes stale
// relative to the rest -- the exact >1800ms inter-venue skew LATENCY_ARB looks for.
// Every ~700ms we snapshot the current per-venue books (each carrying its own real
// receivedAt) into a tape round, so replay preserves the staleness.
//
//   npm run record:ws            # 120s -> data/tape-ws-<ts>.jsonl
//   npm run record:ws -- 300     # 300s
//
// Then: npm run analyze:tape data/tape-ws-<ts>.jsonl

const durationSec = Number(process.argv[2] ?? 120);
const outPath = process.argv[3] ?? `data/tape-ws-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const roundMs = 700;

const { QuoteNormalizer } = await import("../src/lib/services/QuoteNormalizer");
const { BookIntegrityService } = await import("../src/lib/services/BookIntegrityService");

const quotes = new QuoteNormalizer();
const integrity = new BookIntegrityService();
const carry: Partial<Record<ExchangeId, NormalizedOrderBook>> = {};
const msgCount: Partial<Record<ExchangeId, number>> = {};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}
function safeParse(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}
function levels(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((l): [string, string] | null => (Array.isArray(l) && l.length >= 2 ? [String(l[0]), String(l[1])] : null))
    .filter((l): l is [string, string] => Boolean(l))
    .slice(0, 5);
}
function sortedFromMap(m: Map<string, string>, side: "bid" | "ask"): Array<[string, string]> {
  return [...m.entries()]
    .filter(([, s]) => Number(s) > 0)
    .sort((a, b) => (side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0])))
    .slice(0, 5);
}

function record(exchange: ExchangeId, bidsRaw: Array<[string, string]>, asksRaw: Array<[string, string]>, quoteAsset: QuoteAsset, sourceSymbol: string): void {
  if (!bidsRaw.length || !asksRaw.length) return;
  const receivedAt = Date.now();
  const symbol: SymbolId = "BTC/USDT";
  carry[exchange] = {
    exchange,
    symbol,
    sourceSymbol,
    quoteAsset,
    quoteToUsdRate: quotes.quoteToUsdRate(quoteAsset),
    quoteBasisBps: quotes.quoteBasisBps(quoteAsset),
    bids: quotes.normalizeLevels(bidsRaw, quoteAsset),
    asks: quotes.normalizeLevels(asksRaw, quoteAsset),
    receivedAt,
    exchangeTimestamp: receivedAt,
    processingLatencyMs: 0.5,
    integrity: integrity.assess(exchange, { streamKey: symbol, snapshot: true })
  };
  msgCount[exchange] = (msgCount[exchange] ?? 0) + 1;
}

// --- Independent WS subscriptions (auto-reconnect). ---
function connect(name: ExchangeId, url: string, onOpen: (s: WebSocket) => void, onMessage: (data: unknown) => void): void {
  const socket = new WebSocket(url);
  socket.on("open", () => onOpen(socket));
  socket.on("message", (payload) => onMessage(safeParse(payload.toString())));
  socket.on("close", () => setTimeout(() => connect(name, url, onOpen, onMessage), 1500));
  socket.on("error", () => socket.close());
}

function start(): void {
  // Binance: full depth5 snapshots every 100ms.
  connect("binance", "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms", () => undefined, (data) => {
    const d = isRecord(data) ? data.data : null;
    if (!isRecord(d)) return;
    record("binance", levels(d.bids), levels(d.asks), "USDT", "BTC/USDT");
  });

  // OKX: books5 full snapshots.
  connect("okx", "wss://ws.okx.com:8443/ws/v5/public",
    (s) => s.send(JSON.stringify({ op: "subscribe", args: [{ channel: "books5", instId: "BTC-USDT" }] })),
    (data) => {
      const arr = isRecord(data) && Array.isArray(data.data) ? data.data : null;
      const book = arr?.find(isRecord);
      if (book) record("okx", levels(book.bids), levels(book.asks), "USDT", "BTC/USDT");
    });

  // Gate: order_book 5 levels @100ms.
  connect("gate", "wss://api.gateio.ws/ws/v4/",
    (s) => s.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.order_book", event: "subscribe", payload: ["BTC_USDT", "5", "100ms"] })),
    (data) => {
      if (!isRecord(data) || data.channel !== "spot.order_book") return;
      const result = isRecord(data.result) ? data.result : null;
      if (result) record("gate", levels(result.bids), levels(result.asks), "USDT", "BTC/USDT");
    });

  // Bybit: orderbook.50 (snapshot + deltas) -> maintain maps.
  const bybitBids = new Map<string, string>();
  const bybitAsks = new Map<string, string>();
  connect("bybit", "wss://stream.bybit.com/v5/public/spot",
    (s) => s.send(JSON.stringify({ op: "subscribe", args: ["orderbook.50.BTCUSDT"] })),
    (data) => {
      if (!isRecord(data) || data.topic !== "orderbook.50.BTCUSDT") return;
      const d = isRecord(data.data) ? data.data : null;
      if (!d) return;
      if (data.type === "snapshot") {
        bybitBids.clear();
        bybitAsks.clear();
      }
      levels(d.b).forEach(([p, s]) => (Number(s) === 0 ? bybitBids.delete(p) : bybitBids.set(p, s)));
      levels(d.a).forEach(([p, s]) => (Number(s) === 0 ? bybitAsks.delete(p) : bybitAsks.set(p, s)));
      record("bybit", sortedFromMap(bybitBids, "bid"), sortedFromMap(bybitAsks, "ask"), "USDT", "BTC/USDT");
    });

  // Coinbase: level2 (snapshot + updates) on USD -> maintain maps (basis crosses).
  const cbBids = new Map<string, string>();
  const cbAsks = new Map<string, string>();
  connect("coinbase", "wss://advanced-trade-ws.coinbase.com",
    (s) => s.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "level2" })),
    (data) => {
      if (!isRecord(data) || data.channel !== "l2_data" || !Array.isArray(data.events)) return;
      data.events.filter(isRecord).forEach((event) => {
        if (event.type === "snapshot") {
          cbBids.clear();
          cbAsks.clear();
        }
        (Array.isArray(event.updates) ? event.updates : []).filter(isRecord).forEach((u) => {
          const price = num(u.price_level);
          const size = num(u.new_quantity);
          if (!price || size === null) return;
          const map = u.side === "bid" ? cbBids : cbAsks;
          if (Number(size) === 0) map.delete(price);
          else map.set(price, size);
        });
      });
      record("coinbase", sortedFromMap(cbBids, "bid"), sortedFromMap(cbAsks, "ask"), "USD", "BTC-USD");
    });
}

async function pollBasis(): Promise<void> {
  try {
    const r = await fetch("https://api.exchange.coinbase.com/products/USDT-USD/ticker", { headers: { "User-Agent": "ArbitrAI WS Recorder" } });
    const p = num((await r.json() as Record<string, unknown>).price);
    if (p) quotes.setUsdtUsdRate(p);
  } catch {
    /* keep last basis */
  }
}

mkdirSync(dirname(outPath), { recursive: true });
const stream = createWriteStream(outPath, { flags: "a" });

console.log(`\nArbitrAI - grabando tape WS (feeds independientes) por ${durationSec}s`);
console.log(`  destino: ${outPath}  (ronda ${roundMs}ms)\n`);
console.log(["  t(s)", "rondas", "venues", "maxSkew(ms)", "basis(bps)"].join(" "));
console.log("-".repeat(56));

await pollBasis();
start();

const startedAt = Date.now();
let rounds = 0;
let totalBooks = 0;
let maxSkew = 0;

const roundTimer = setInterval(() => {
  const books = Object.values(carry).filter((b): b is NormalizedOrderBook => Boolean(b));
  if (books.length >= 2) {
    stream.write(`${JSON.stringify({ t: Date.now(), books })}\n`);
    rounds += 1;
    totalBooks += books.length;
    const times = books.map((b) => b.receivedAt);
    maxSkew = Math.max(maxSkew, Math.max(...times) - Math.min(...times));
  }
}, roundMs);

const basisTimer = setInterval(() => void pollBasis(), 15000);
const reportTimer = setInterval(() => {
  console.log([
    ((Date.now() - startedAt) / 1000).toFixed(0).padStart(5),
    String(rounds).padStart(6),
    `${Object.values(carry).filter(Boolean).length}`.padStart(6),
    String(Math.round(maxSkew)).padStart(11),
    quotes.quoteBasisBps("USDT").padStart(10)
  ].join(" "));
}, 5000);

await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
clearInterval(roundTimer);
clearInterval(basisTimer);
clearInterval(reportTimer);
await new Promise<void>((resolve) => stream.end(resolve));

console.log("\n=== Tape WS grabado ===");
console.log(`  Rondas         : ${rounds}`);
console.log(`  Libros totales : ${totalBooks}`);
console.log(`  Mensajes/venue : ${Object.entries(msgCount).map(([k, v]) => `${k}:${v}`).join(" ") || "ninguno"}`);
console.log(`  Max skew obs.  : ${Math.round(maxSkew)}ms (bar latency-arb: 1800ms)`);
console.log(`  Archivo        : ${outPath}`);
console.log(`\n  Analiza con: npm run analyze:tape ${outPath}\n`);
process.exit(0);
