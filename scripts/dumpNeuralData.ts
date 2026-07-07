// Dump the NeuralEdge synthetic training set to CSV so the GPU/PyTorch trainer
// (scripts/gpu/train_neural_gpu.py) can learn on the *exact same* labelled
// distribution the pure-TS trainer (scripts/trainNeural.ts) uses. This is only a
// data exporter -- it runs the identical demo-shaped generator + ExecutionSimulator
// labelling, then writes raw (un-standardised) features so Python owns the split,
// standardisation and training. Keeping the generator here (not re-implemented in
// Python) guarantees the two paths never drift.
//
//   npm run dump:neural            # default 150000 samples
//   npm run dump:neural -- 40000 7 out.csv
//
// Output: scripts/gpu/data/neural-samples.csv  (cols: <24 features>,y,round)
//         scripts/gpu/data/neural-meta.json     (featureKeys, counts)

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook, OrderBookLevel } from "../src/lib/types";

process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

const args = process.argv.slice(2);
const targetSamples = Number(args[0] ?? 150000);
const seed = Number(args[1] ?? 0x9e3779b9);
const outCsv = args[2] ?? "scripts/gpu/data/neural-samples.csv";
const outMeta = "scripts/gpu/data/neural-meta.json";

// Same 24 features, same order, as trainNeural.ts + MlEdgeTensor's FeatureVector.
const FEATURE_KEYS = [
  "netEdgeBps", "alignment", "liquidityScore", "freshnessScore", "volatilityBps",
  "micropriceSkewBps", "orderFlowImbalance", "multiLevelOfi", "buySpreadBps", "sellSpreadBps",
  "buyDepth5", "sellDepth5", "quoteSkewMs", "ageMs", "styleTaker", "styleMaker", "styleStatArb",
  "buyImbalance", "sellImbalance", "buyMidMomentumBps", "sellMidMomentumBps", "realizedVolBps",
  "buyImbalanceDelta", "sellImbalanceDelta"
] as const;
const NF = FEATURE_KEYS.length;

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);

// ---- Synthetic generator (verbatim from scripts/trainNeural.ts) ----
const risk = new RiskManager();
const engine = new ArbitrageEngine();
const seedWallets = Object.fromEntries(EXCHANGE_IDS.map((id: ExchangeId) => [id, { btc: "100000", usdt: "7000000000" }]));
const simulator = new ExecutionSimulator(seedWallets as never, () => risk.getLatencyMultiplier());

const takerBps = (exchange: ExchangeId) => Number(EXCHANGE_FEES[exchange].taker) * 10000;
const spreadOf = (index: number) => 1.2 + index * 0.35;
const sizeOf = (index: number) => 0.72 + index * 0.11;
let genMid = 70000;

function demoShapedBook(exchange: ExchangeId, mid: number, spread: number, topSize: number, receivedAt: number): NormalizedOrderBook {
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let level = 0; level < 5; level += 1) {
    const step = spread * (level + 0.5);
    const size = topSize * (1 + level * 0.42);
    bids.push({ price: (mid - step).toFixed(2), size: size.toFixed(8) });
    asks.push({ price: (mid + step).toFixed(2), size: (size * 0.92).toFixed(8) });
  }
  return {
    exchange, symbol: "BTC/USDT", sourceSymbol: "BTC/USDT", quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000", quoteBasisBps: "0.000", bids, asks, receivedAt,
    exchangeTimestamp: receivedAt - Math.floor(rng() * 35),
    processingLatencyMs: Number((rng() * 2.7 + 0.4).toFixed(2)),
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "neural-generator" }
  };
}

function generateRound(): { books: NormalizedOrderBook[]; focus: { buy: ExchangeId; sell: ExchangeId } } {
  genMid *= Math.exp((rng() - 0.5) * 0.0008);
  const now = Date.now();
  const books = EXCHANGE_IDS.map((exchange: ExchangeId, index: number) =>
    demoShapedBook(exchange, genMid + (rng() - 0.5) * 24, spreadOf(index), sizeOf(index), now));
  const bi = Math.floor(rng() * EXCHANGE_IDS.length);
  let si = Math.floor(rng() * EXCHANGE_IDS.length);
  if (si === bi) si = (si + 1) % EXCHANGE_IDS.length;
  const buyExchange = EXCHANGE_IDS[bi];
  const sellExchange = EXCHANGE_IDS[si];
  const roundTripFeesBps = takerBps(buyExchange) + takerBps(sellExchange);
  const strong = rng() < 0.2;
  const netTargetBps = strong ? 45 + rng() * 30 : -12 + rng() * 34;
  const grossEdgeBps = Math.max(2, netTargetBps + roundTripFeesBps + 8);
  const thin = !strong && rng() < 0.3;
  const step0Buy = spreadOf(bi) * 0.5;
  const step0Sell = spreadOf(si) * 0.5;
  const target = (genMid * grossEdgeBps) / 10000;
  const x = (target + step0Buy + step0Sell) / 2;
  const sizeBuy = thin ? sizeOf(bi) * 0.1 : sizeOf(bi);
  const sizeSell = thin ? sizeOf(si) * 0.1 : sizeOf(si);
  const skewMs = Math.floor(rng() * 1500);
  books[bi] = demoShapedBook(buyExchange, genMid - x, spreadOf(bi), sizeBuy, now);
  books[si] = demoShapedBook(sellExchange, genMid + x, spreadOf(si), sizeSell, now - skewMs);
  return { books, focus: { buy: buyExchange, sell: sellExchange } };
}

mkdirSync(dirname(outCsv), { recursive: true });
const stream = createWriteStream(outCsv, { flags: "w" });
stream.write(FEATURE_KEYS.join(",") + ",y,round\n");

let round = 0;
let written = 0;
process.stdout.write(`\nArbitrAI · NeuralEdge GPU dump — generando ~${targetSamples} muestras -> ${outCsv}\n`);

while (written < targetSamples) {
  const { books, focus } = generateRound();
  const byExchange = new Map<ExchangeId, NormalizedOrderBook>();
  for (const book of books) if (book.symbol === "BTC/USDT") byExchange.set(book.exchange, book);
  for (const book of books) {
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type !== "CROSS_EXCHANGE" || opportunity.buyExchange !== focus.buy || opportunity.sellExchange !== focus.sell) continue;
      const trade = await simulator.execute(opportunity);
      const buyBook = byExchange.get(focus.buy);
      const sellBook = byExchange.get(focus.sell);
      if (!buyBook || !sellBook) continue;
      const feat = engine.mlEdgeTensor.extractFeatures(buyBook, sellBook, d(opportunity.tradeSizeBtc), opportunity.executionStyle, d(opportunity.netSpreadPct).div(100)) as unknown as Record<string, number>;
      const y = Number(trade.pnlUsd) > 0 ? 1 : 0;
      const row = FEATURE_KEYS.map((k) => feat[k] ?? 0);
      stream.write(row.join(",") + `,${y},${round}\n`);
      written += 1;
    }
  }
  round += 1;
  if (round % 4000 === 0) process.stdout.write(`  ${written}/${targetSamples} muestras (${round} rondas)\n`);
}

await new Promise<void>((resolve) => stream.end(resolve));
writeFileSync(outMeta, JSON.stringify({ featureKeys: FEATURE_KEYS, numFeatures: NF, samples: written, rounds: round, seed }, null, 2));
process.stdout.write(`  hecho: ${written} muestras en ${round} rondas\n  meta -> ${outMeta}\n\n`);
process.exit(0);
