import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook, QuoteAsset, SymbolId } from "../src/lib/types";

// Real-market tape recorder (camino 1).
//
// Connects to the 7 production exchanges over their public REST order-book
// endpoints, normalizes every snapshot through the same QuoteNormalizer the live
// gateway uses (so USD venues are basis-adjusted to USDT exactly as in
// production), and appends one JSON line per polling round to a tape file:
//
//   {"t": <captureMs>, "books": [NormalizedOrderBook, ...]}
//
// The tape is replayed by `npm run train -- --tape <file>` to train the ML on
// genuine exchange microstructure. Tapes live under data/ (gitignored).
//
//   npm run record               # 60s -> data/tape-<ts>.jsonl
//   npm run record -- 180        # 180s
//   npm run record -- 120 data/my-tape.jsonl

const durationSec = Number(process.argv[2] ?? 60);
const outPath = process.argv[3] ?? `data/tape-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const intervalMs = 700;

const { QuoteNormalizer } = await import("../src/lib/services/QuoteNormalizer");
const { BookIntegrityService } = await import("../src/lib/services/BookIntegrityService");
const { EXCHANGE_IDS } = await import("../src/lib/config/exchanges");

const quotes = new QuoteNormalizer();
const integrity = new BookIntegrityService();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-fetch timeout: a venue that doesn't answer within the budget is simply
// absent from this round, so its last book goes stale relative to the venues that
// did answer -- which is exactly the real staleness LATENCY_ARB looks for.
async function getJson(url: string, timeoutMs = 600): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ArbitrAI Hackathon Recorder" },
      signal: controller.signal
    });
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function num(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}
function readArray(source: unknown, key: string): unknown[] | null {
  if (!isRecord(source)) return null;
  return Array.isArray(source[key]) ? (source[key] as unknown[]) : null;
}
function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source)) return null;
  return isRecord(source[key]) ? (source[key] as Record<string, unknown>) : null;
}

// Parse [[price, size, ...], ...] -> [[price, size], ...], top 5.
function levels(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((level): [string, string] | null => (Array.isArray(level) && level.length >= 2 ? [String(level[0]), String(level[1])] : null))
    .filter((level): level is [string, string] => Boolean(level))
    .slice(0, 5);
}

function makeBook(
  exchange: ExchangeId,
  bidsRaw: Array<[string, string]>,
  asksRaw: Array<[string, string]>,
  quoteAsset: QuoteAsset,
  sourceSymbol: string,
  exchangeTimestamp: number
): NormalizedOrderBook | null {
  if (!bidsRaw.length || !asksRaw.length) return null;
  const receivedAt = Date.now();
  const symbol: SymbolId = "BTC/USDT";
  return {
    exchange,
    symbol,
    sourceSymbol,
    quoteAsset,
    quoteToUsdRate: quotes.quoteToUsdRate(quoteAsset),
    quoteBasisBps: quotes.quoteBasisBps(quoteAsset),
    bids: quotes.normalizeLevels(bidsRaw, quoteAsset),
    asks: quotes.normalizeLevels(asksRaw, quoteAsset),
    receivedAt,
    exchangeTimestamp: exchangeTimestamp || receivedAt,
    processingLatencyMs: 0.5,
    integrity: integrity.assess(exchange, { streamKey: symbol, snapshot: true })
  };
}

async function pollBasis(): Promise<void> {
  try {
    const payload = await getJson("https://api.exchange.coinbase.com/products/USDT-USD/ticker");
    const price = num(isRecord(payload) ? payload.price : null);
    if (price) quotes.setUsdtUsdRate(price);
  } catch {
    // Keep the last known basis.
  }
}

// --- Per-venue REST snapshot fetchers (BTC, top 5). ---
const fetchers: Record<ExchangeId, () => Promise<NormalizedOrderBook | null>> = {
  async binance() {
    const data = await getJson("https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5");
    return makeBook("binance", levels(isRecord(data) ? data.bids : null), levels(isRecord(data) ? data.asks : null), "USDT", "BTC/USDT", 0);
  },
  async bitstamp() {
    const data = await getJson("https://www.bitstamp.net/api/v2/order_book/btcusd/");
    return makeBook("bitstamp", levels(isRecord(data) ? data.bids : null), levels(isRecord(data) ? data.asks : null), "USD", "BTC/USD", 0);
  },
  async kucoin() {
    const data = await getJson("https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=BTC-USDT");
    const book = isRecord(data) && isRecord(data.data) ? data.data : null;
    return makeBook("kucoin", levels(book?.bids), levels(book?.asks), "USDT", "BTC/USDT", 0);
  },
  async okx() {
    const data = await getJson("https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=5");
    const book = readArray(data, "data")?.find(isRecord);
    return makeBook("okx", levels(book?.bids), levels(book?.asks), "USDT", "BTC/USDT", Number(num(book ? book.ts : null) ?? 0));
  },
  async gate() {
    const data = await getJson("https://api.gateio.ws/api/v4/spot/order_book?currency_pair=BTC_USDT&limit=5");
    return makeBook("gate", levels(isRecord(data) ? data.bids : null), levels(isRecord(data) ? data.asks : null), "USDT", "BTC/USDT", Number(num(isRecord(data) ? data.current : null) ?? 0));
  },
  async bybit() {
    const data = await getJson("https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=5");
    const result = readRecord(data, "result");
    return makeBook("bybit", levels(result?.b), levels(result?.a), "USDT", "BTC/USDT", Number(num(result ? result.ts : null) ?? 0));
  },
  async coinbase() {
    const data = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/book?level=2");
    return makeBook("coinbase", levels(isRecord(data) ? data.bids : null), levels(isRecord(data) ? data.asks : null), "USD", "BTC-USD", 0);
  },
  async kraken() {
    const data = await getJson("https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=5");
    const result = readRecord(data, "result");
    const first = result ? Object.values(result).find(isRecord) : null;
    return makeBook("kraken", levels(first?.bids), levels(first?.asks), "USD", "BTC/USD", 0);
  },
  async bitfinex() {
    const payload = await getJson("https://api-pub.bitfinex.com/v2/book/tBTCUSD/P0?len=25");
    if (!Array.isArray(payload)) return null;
    const bids: Array<[string, string]> = [];
    const asks: Array<[string, string]> = [];
    payload.filter(Array.isArray).forEach((level: unknown[]) => {
      const price = String(level[0] ?? "");
      const amount = Number(level[2] ?? 0);
      if (!price || amount === 0) return;
      if (amount > 0) bids.push([price, String(amount)]);
      else asks.push([price, String(Math.abs(amount))]);
    });
    bids.sort((a, b) => Number(b[0]) - Number(a[0]));
    asks.sort((a, b) => Number(a[0]) - Number(b[0]));
    return makeBook("bitfinex", bids.slice(0, 5), asks.slice(0, 5), "USD", "tBTCUSD", 0);
  }
};

mkdirSync(dirname(outPath), { recursive: true });
const stream = createWriteStream(outPath, { flags: "a" });

console.log(`\nArbitrAI - grabando tape real de ${EXCHANGE_IDS.length} exchanges por ${durationSec}s`);
console.log(`  destino: ${outPath}  (intervalo ${intervalMs}ms)\n`);
console.log(["  t(s)", "rondas", "libros", "venues vivos", "  basis(bps)"].join(" "));
console.log("-".repeat(60));

await pollBasis();
const startedAt = Date.now();
const endAt = startedAt + durationSec * 1000;
let nextBasisAt = startedAt + 15000;
let rounds = 0;
let totalBooks = 0;
const liveVenues = new Set<ExchangeId>();

while (Date.now() < endAt) {
  const roundStart = Date.now();
  const settled = await Promise.allSettled(EXCHANGE_IDS.map((id: ExchangeId) => fetchers[id]()));
  const books: NormalizedOrderBook[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value) {
      books.push(result.value);
      liveVenues.add(EXCHANGE_IDS[i]);
    }
  });
  if (books.length >= 2) {
    stream.write(`${JSON.stringify({ t: Date.now(), books })}\n`);
    rounds += 1;
    totalBooks += books.length;
  }

  if (Date.now() >= nextBasisAt) {
    void pollBasis();
    nextBasisAt += 15000;
  }
  if (rounds % 7 === 0 || Date.now() >= endAt) {
    console.log([
      ((Date.now() - startedAt) / 1000).toFixed(0).padStart(5),
      String(rounds).padStart(6),
      String(totalBooks).padStart(6),
      `${books.length}/${EXCHANGE_IDS.length}`.padStart(12),
      quotes.quoteBasisBps("USDT").padStart(12)
    ].join(" "));
  }

  const elapsed = Date.now() - roundStart;
  if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
}

await new Promise<void>((resolve) => stream.end(resolve));
console.log("\n=== Tape grabado ===");
console.log(`  Rondas capturadas : ${rounds}`);
console.log(`  Libros totales    : ${totalBooks}`);
console.log(`  Venues vistos     : ${[...liveVenues].join(", ") || "ninguno"}`);
console.log(`  Base USDT/USD     : ${quotes.snapshot().usdtUsdRate} (${quotes.quoteBasisBps("USDT")} bps)`);
console.log(`  Archivo           : ${outPath}`);
console.log(`\n  Entrena con: npm run train -- --tape ${outPath}\n`);
process.exit(0);
