import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import { avellanedaStoikovMakerFraction } from "../src/lib/services/ArbitrageEngine";

// THE SYNTHESIS: can combining everything we've learned (Kelly sizing, the AET+ML
// ensemble, Avellaneda-Stoikov maker pricing, the triangular maker-EV model) into
// one simultaneous multi-strategy portfolio beat what any single strategy achieves
// alone? We test this for real, live, synchronized across strategies (not three
// separate captures glued together), and report the honest answer either way.
//
// Method: connect to the SAME feeds the production engine uses (5 venues' BTC/USDT
// for cross-exchange + stat-arb, via the real ArbitrageEngine; Binance's 3 legs for
// the triangular maker-EV model) at once. Every ~700ms round, compute each
// strategy's best available risk-adjusted edge (bps, comparable units across all
// three -- same definition used throughout this project's evidence). Track the
// per-round series for each strategy AND their sum (= what a portfolio that bet on
// all three every round would have realized). Then check, with real numbers,
// whether expectation is linear here (portfolio mean = sum of strategy means -- a
// mathematical identity, not a hypothesis) and whether diversification reduces
// variance/Sharpe even when it can't change the sign of a negative-EV sum.
//
//   npm run study:portfolio              # 600s (10 min)
//   npm run study:portfolio -- 1200      # 20 min

const durationSec = Number(process.argv[2] ?? 600);
const outPath = process.argv[3] ?? "public/data/portfolio-study.json";
const roundMs = 700;
const makerClipBtc = 0.02;

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { QuoteNormalizer } = await import("../src/lib/services/QuoteNormalizer");
const { BookIntegrityService } = await import("../src/lib/services/BookIntegrityService");
const { EXCHANGE_IDS } = await import("../src/lib/config/exchanges");

type ExchangeId = (typeof EXCHANGE_IDS)[number];
const engine = new ArbitrageEngine();
const quotes = new QuoteNormalizer();
const integrity = new BookIntegrityService();

// --- Cross-exchange / stat-arb feed (5 independent venues, same approach as
// recordTapeWs.ts): keep the latest real book per venue. ---
interface EngineBook {
  exchange: ExchangeId;
  symbol: "BTC/USDT";
  sourceSymbol: string;
  quoteAsset: "USDT" | "USD";
  quoteToUsdRate: string;
  quoteBasisBps: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  receivedAt: number;
  exchangeTimestamp: number;
  processingLatencyMs: number;
  integrity: ReturnType<typeof integrity.assess>;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}
function levels(v: unknown): Array<[string, string]> {
  if (!Array.isArray(v)) return [];
  return v
    .map((l): [string, string] | null => (Array.isArray(l) && l.length >= 2 ? [String(l[0]), String(l[1])] : null))
    .filter((l): l is [string, string] => Boolean(l))
    .slice(0, 5);
}
function sortedFromMap(m: Map<string, string>, side: "bid" | "ask"): Array<[string, string]> {
  return [...m.entries()].filter(([, s]) => Number(s) > 0).sort((a, b) => (side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))).slice(0, 5);
}
const crossCarry = new Map<ExchangeId, EngineBook>();
function recordCrossBook(exchange: ExchangeId, bidsRaw: Array<[string, string]>, asksRaw: Array<[string, string]>, quoteAsset: "USDT" | "USD", sourceSymbol: string): void {
  if (!bidsRaw.length || !asksRaw.length) return;
  const receivedAt = Date.now();
  crossCarry.set(exchange, {
    exchange, symbol: "BTC/USDT", sourceSymbol, quoteAsset,
    quoteToUsdRate: quotes.quoteToUsdRate(quoteAsset), quoteBasisBps: quotes.quoteBasisBps(quoteAsset),
    bids: quotes.normalizeLevels(bidsRaw, quoteAsset), asks: quotes.normalizeLevels(asksRaw, quoteAsset),
    receivedAt, exchangeTimestamp: receivedAt, processingLatencyMs: 0.5,
    integrity: integrity.assess(exchange, { streamKey: "BTC/USDT", snapshot: true })
  });
}

function connectWs(name: string, url: string, onOpen: (s: WebSocket) => void, onMessage: (data: unknown) => void): void {
  const socket = new WebSocket(url);
  socket.on("open", () => onOpen(socket));
  socket.on("message", (payload) => {
    try {
      onMessage(JSON.parse(payload.toString()));
    } catch {
      /* skip */
    }
  });
  socket.on("close", () => setTimeout(() => connectWs(name, url, onOpen, onMessage), 1500));
  socket.on("error", () => socket.close());
}

function startCrossFeeds(): void {
  connectWs("binance-btc", "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms", () => undefined, (data) => {
    const d = isRecord(data) ? data.data : null;
    if (isRecord(d)) recordCrossBook("binance", levels(d.bids), levels(d.asks), "USDT", "BTC/USDT");
  });
  connectWs("okx", "wss://ws.okx.com:8443/ws/v5/public",
    (s) => s.send(JSON.stringify({ op: "subscribe", args: [{ channel: "books5", instId: "BTC-USDT" }] })),
    (data) => {
      const arr = isRecord(data) && Array.isArray(data.data) ? data.data : null;
      const book = arr?.find(isRecord);
      if (book) recordCrossBook("okx", levels(book.bids), levels(book.asks), "USDT", "BTC/USDT");
    });
  connectWs("gate", "wss://api.gateio.ws/ws/v4/",
    (s) => s.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.order_book", event: "subscribe", payload: ["BTC_USDT", "5", "100ms"] })),
    (data) => {
      if (!isRecord(data) || data.channel !== "spot.order_book") return;
      const result = isRecord(data.result) ? data.result : null;
      if (result) recordCrossBook("gate", levels(result.bids), levels(result.asks), "USDT", "BTC/USDT");
    });
  const bybitBids = new Map<string, string>();
  const bybitAsks = new Map<string, string>();
  connectWs("bybit", "wss://stream.bybit.com/v5/public/spot",
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
      recordCrossBook("bybit", sortedFromMap(bybitBids, "bid"), sortedFromMap(bybitAsks, "ask"), "USDT", "BTC/USDT");
    });
  const cbBids = new Map<string, string>();
  const cbAsks = new Map<string, string>();
  connectWs("coinbase", "wss://advanced-trade-ws.coinbase.com",
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
      recordCrossBook("coinbase", sortedFromMap(cbBids, "bid"), sortedFromMap(cbAsks, "ask"), "USD", "BTC-USD");
    });
}

// --- Triangular feed (Binance's 3 legs, maker-EV model -- same as triangularStudy.ts). ---
type Level = [number, number];
interface TriBook { bids: Level[]; asks: Level[]; at: number }
const triBooks: Record<string, TriBook | undefined> = {};
function parseTriLevels(v: unknown): Level[] {
  if (!Array.isArray(v)) return [];
  return v.map((l): Level | null => (Array.isArray(l) && l.length >= 2 ? [Number(l[0]), Number(l[1])] : null)).filter((l): l is Level => l !== null && Number.isFinite(l[0]) && Number.isFinite(l[1]));
}
interface LegQuote { makerBuy: number; makerSell: number; fillProb: number; spreadBps: number }
function legQuote(book: TriBook, qtyBase: number): LegQuote | null {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask || !(ask[0] > bid[0])) return null;
  const [bidPx, bidSz] = bid;
  const [askPx, askSz] = ask;
  const spreadBps = ((askPx - bidPx) / askPx) * 10000;
  const bidDepth = book.bids.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
  const askDepth = book.asks.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
  const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const frac = avellanedaStoikovMakerFraction(spreadBps, bidDepth + askDepth, imbalance);
  return {
    makerBuy: askPx - (askPx - bidPx) * frac,
    makerSell: bidPx + (askPx - bidPx) * frac,
    fillProb: Math.max(0.18, Math.min(0.82, 0.28 + Math.min(1, (bidSz + askSz) / Math.max(qtyBase * 6, 1e-9)) * 0.34 + Math.max(0, 1 - spreadBps / 6) * 0.2)),
    spreadBps
  };
}
function triangularMakerEvBps(retailFeeBpsPerLeg: number): number | null {
  const btc = triBooks["BTC/USDT"];
  const eth = triBooks["ETH/USDT"];
  const ethbtc = triBooks["ETH/BTC"];
  if (!btc || !eth || !ethbtc) return null;
  const now = Date.now();
  if (now - btc.at > 1500 || now - eth.at > 1500 || now - ethbtc.at > 1500) return null;
  const btcQ = legQuote(btc, makerClipBtc);
  const ethQ = legQuote(eth, (makerClipBtc * btc.bids[0][0]) / eth.bids[0][0]);
  const ethbtcQ = legQuote(ethbtc, makerClipBtc / ethbtc.bids[0][0]);
  if (!btcQ || !ethQ || !ethbtcQ) return null;
  const fwdUsdt = makerClipBtc * btcQ.makerSell;
  const fwdEth = fwdUsdt / ethQ.makerBuy;
  const fwdEndBtc = fwdEth * ethbtcQ.makerSell;
  const fwdGross = (fwdEndBtc / makerClipBtc - 1) * 10000;
  const revEth = makerClipBtc / ethbtcQ.makerBuy;
  const revUsdt = revEth * ethQ.makerSell;
  const revEndBtc = revUsdt / btcQ.makerBuy;
  const revGross = (revEndBtc / makerClipBtc - 1) * 10000;
  const grossBps = Math.max(fwdGross, revGross);
  const pAll3 = btcQ.fillProb * ethQ.fillProb * ethbtcQ.fillProb;
  const unwindCostBps = (btcQ.spreadBps + ethQ.spreadBps + ethbtcQ.spreadBps) / 3 / 2;
  return pAll3 * (grossBps + 3 * retailFeeBpsPerLeg) - (1 - pAll3) * unwindCostBps;
}

function startTriangularFeed(): void {
  connectWs("binance-tri", "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms/ethbtc@depth5@100ms", () => undefined, (data) => {
    const stream = isRecord(data) && typeof data.stream === "string" ? data.stream : "";
    const d = isRecord(data) ? data.data : null;
    if (!isRecord(d)) return;
    const symbol = stream.startsWith("btcusdt") ? "BTC/USDT" : stream.startsWith("ethusdt") ? "ETH/USDT" : stream.startsWith("ethbtc") ? "ETH/BTC" : null;
    if (!symbol) return;
    triBooks[symbol] = { bids: parseTriLevels(d.bids), asks: parseTriLevels(d.asks), at: Date.now() };
  });
}

function netBps(opportunity: { netSpreadPct: string }): number {
  return Number(opportunity.netSpreadPct) * 100;
}

// --- Per-round portfolio sampling. ---
interface Round { cross: number; statArb: number; triangular: number }
const rounds: Round[] = [];

console.log(`\nArbitrAI - sintesis de portafolio: cross + stat-arb + triangular-maker, en vivo y sincronizado, por ${durationSec}s\n`);
startCrossFeeds();
startTriangularFeed();

const startedAt = Date.now();
const endAt = startedAt + durationSec * 1000;
const roundTimer = setInterval(() => {
  // null = no candidate generated this round (sit out, contributes 0 -- genuinely
  // no opportunity to evaluate). A candidate that exists but is negative must flow
  // through as negative: clamping at 0 here would hide the real (mostly negative)
  // EV and bias the portfolio experiment toward the hypothesis we're testing.
  let crossBest: number | null = null;
  let statBest: number | null = null;
  for (const book of crossCarry.values()) {
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type === "CROSS_EXCHANGE") crossBest = crossBest === null ? netBps(opportunity) : Math.max(crossBest, netBps(opportunity));
      else if (opportunity.type === "STAT_ARB") statBest = statBest === null ? netBps(opportunity) : Math.max(statBest, netBps(opportunity));
    }
  }
  const tri = triangularMakerEvBps(-10); // retail Binance maker fee, 0.10%/leg
  rounds.push({ cross: crossBest ?? 0, statArb: statBest ?? 0, triangular: tri ?? 0 });
}, roundMs);

let lastReportAt = startedAt;
const reportTimer = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`  t=${elapsed.toFixed(0)}s  rounds=${rounds.length}  venues=${crossCarry.size}/5  triLegsReady=${Boolean(triBooks["BTC/USDT"] && triBooks["ETH/USDT"] && triBooks["ETH/BTC"])}`);
  lastReportAt = Date.now();
}, 10000);
void lastReportAt;

await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
clearInterval(roundTimer);
clearInterval(reportTimer);

// --- Analysis: per-strategy stats, portfolio (sum) stats, linearity check, correlation. ---
function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function stdev(arr: number[], m: number): number {
  return arr.length ? Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) : 0;
}
function sharpeLike(arr: number[]): number {
  const m = mean(arr);
  const sd = stdev(arr, m);
  return sd > 0 ? (m / sd) * Math.sqrt(arr.length) : 0;
}
function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length;
  const sa = stdev(a, ma);
  const sb = stdev(b, mb);
  return sa > 0 && sb > 0 ? cov / (sa * sb) : 0;
}

const crossSeries = rounds.map((r) => r.cross);
const statSeries = rounds.map((r) => r.statArb);
const triSeries = rounds.map((r) => r.triangular);
const portfolioSeries = rounds.map((r) => r.cross + r.statArb + r.triangular);

const crossMean = mean(crossSeries);
const statMean = mean(statSeries);
const triMean = mean(triSeries);
const portfolioMean = mean(portfolioSeries);
const sumOfMeans = crossMean + statMean + triMean;
const linearityErrorBps = Math.abs(portfolioMean - sumOfMeans);

const result = {
  generatedAt: new Date().toISOString(),
  durationSec,
  rounds: rounds.length,
  strategies: {
    cross: { meanBps: Number(crossMean.toFixed(4)), stdevBps: Number(stdev(crossSeries, crossMean).toFixed(4)), sharpeLike: Number(sharpeLike(crossSeries).toFixed(3)) },
    statArb: { meanBps: Number(statMean.toFixed(4)), stdevBps: Number(stdev(statSeries, statMean).toFixed(4)), sharpeLike: Number(sharpeLike(statSeries).toFixed(3)) },
    triangular: { meanBps: Number(triMean.toFixed(4)), stdevBps: Number(stdev(triSeries, triMean).toFixed(4)), sharpeLike: Number(sharpeLike(triSeries).toFixed(3)) }
  },
  portfolio: {
    meanBps: Number(portfolioMean.toFixed(4)),
    stdevBps: Number(stdev(portfolioSeries, portfolioMean).toFixed(4)),
    sharpeLike: Number(sharpeLike(portfolioSeries).toFixed(3))
  },
  linearityCheck: {
    sumOfIndividualMeansBps: Number(sumOfMeans.toFixed(4)),
    portfolioMeanBps: Number(portfolioMean.toFixed(4)),
    differenceBps: Number(linearityErrorBps.toFixed(6)),
    confirms: linearityErrorBps < 0.01
  },
  correlations: {
    crossVsStatArb: Number(correlation(crossSeries, statSeries).toFixed(3)),
    crossVsTriangular: Number(correlation(crossSeries, triSeries).toFixed(3)),
    statArbVsTriangular: Number(correlation(statSeries, triSeries).toFixed(3))
  },
  bestSingleStrategy: [
    { name: "cross", mean: crossMean },
    { name: "statArb", mean: statMean },
    { name: "triangular", mean: triMean }
  ].sort((a, b) => b.mean - a.mean)[0].name,
  portfolioBeatsBestSingle: portfolioMean > Math.max(crossMean, statMean, triMean),
  takeaway: ""
};

result.takeaway = portfolioMean > 0
  ? `El portafolio combinado tiene EV positivo (${result.portfolio.meanBps}bps/ronda) -- una genuina ventaja de combinar estrategias.`
  : `EV del portafolio = ${result.portfolio.meanBps}bps/ronda (negativo), e identico a la suma de los EVs individuales (${result.linearityCheck.sumOfIndividualMeansBps}bps, diferencia ${result.linearityCheck.differenceBps}bps) -- la expectativa es lineal por definicion matematica: sumar apuestas de EV negativo nunca produce un portafolio de EV positivo, sin importar como se combinen o diversifiquen. La diversificacion (correlaciones cross-statArb=${result.correlations.crossVsStatArb}, cross-triangular=${result.correlations.crossVsTriangular}) puede reducir la VARIANZA del resultado, pero no puede cambiar el signo de la expectativa. No hay combinacion de las senales que tenemos que le gane a un mercado eficiente -- esa es la conclusion matematica, no una falta de esfuerzo.`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log("\n=== Sintesis de portafolio multi-estrategia ===");
console.log(`  Rondas sincronizadas : ${result.rounds}`);
console.log(`  Cross-exchange  : media ${result.strategies.cross.meanBps}bps  sigma ${result.strategies.cross.stdevBps}  sharpe ${result.strategies.cross.sharpeLike}`);
console.log(`  Stat-Arb        : media ${result.strategies.statArb.meanBps}bps  sigma ${result.strategies.statArb.stdevBps}  sharpe ${result.strategies.statArb.sharpeLike}`);
console.log(`  Triangular maker: media ${result.strategies.triangular.meanBps}bps  sigma ${result.strategies.triangular.stdevBps}  sharpe ${result.strategies.triangular.sharpeLike}`);
console.log(`  PORTAFOLIO      : media ${result.portfolio.meanBps}bps  sigma ${result.portfolio.stdevBps}  sharpe ${result.portfolio.sharpeLike}`);
console.log(`\n  Chequeo de linealidad: suma de medias individuales = ${result.linearityCheck.sumOfIndividualMeansBps}bps vs media del portafolio = ${result.linearityCheck.portfolioMeanBps}bps (diff ${result.linearityCheck.differenceBps})`);
console.log(`  Correlaciones: cross~statArb=${result.correlations.crossVsStatArb}  cross~triangular=${result.correlations.crossVsTriangular}  statArb~triangular=${result.correlations.statArbVsTriangular}`);
console.log(`\n  ${result.takeaway}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
