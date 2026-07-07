// Deep(er) model for edge survival: a small feed-forward neural network trained
// from scratch in pure TypeScript (no framework, no native deps -- runs anywhere
// Node or the browser does, exactly like the tree ensemble it complements). The
// gradient-boosted stumps split axis-aligned; an MLP with a couple of ReLU layers
// can bend non-axis-aligned decision boundaries over the 24 microstructure +
// temporal features, so the two disagree in useful ways and can be ensembled.
//
// Trained on the same enriched synthetic generator the tree uses (dislocations
// centred on each pair's break-even), validated by AUC over a round-disjoint
// held-out split, and persisted to public/model/neural-edge.json.
//
//   npm run train:neural            # default 40k samples, ~40 epochs
//   npm run train:neural -- 60000 60

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook, OrderBookLevel } from "../src/lib/types";

process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

const args = process.argv.slice(2);
const targetSamples = Number(args[0] ?? 40000);
const epochs = Number(args[1] ?? 40);
const seed = Number(args[2] ?? 0x9e3779b9);
const outPath = "public/model/neural-edge.json";

// The 24 features, in the order NeuralEdge will always read them (matches the
// FeatureVector declaration in MlEdgeTensor). Kept explicit so training and
// inference never drift.
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

// ---- Synthetic generator (mirrors scripts/trainModel.ts: demo-shaped books,
// dislocations drawn around each pair's break-even so labels split ~50/50) ----
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

interface Sample { x: number[]; y: number; round: number }
const samples: Sample[] = [];
let round = 0;
process.stdout.write(`\nArbitrAI · NeuralEdge — generando ~${targetSamples} muestras etiquetadas...\n`);

while (samples.length < targetSamples) {
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
      samples.push({ x: FEATURE_KEYS.map((k) => feat[k] ?? 0), y: Number(trade.pnlUsd) > 0 ? 1 : 0, round });
    }
  }
  round += 1;
  if (round % 2000 === 0) process.stdout.write(`  ${samples.length}/${targetSamples} muestras (${round} rondas)\n`);
}
process.stdout.write(`  generadas ${samples.length} muestras en ${round} rondas\n`);

// ---- Standardize features (z-score); persist mean/std for inference ----
const mean = new Array(NF).fill(0);
const std = new Array(NF).fill(0);
for (const s of samples) for (let j = 0; j < NF; j += 1) mean[j] += s.x[j];
for (let j = 0; j < NF; j += 1) mean[j] /= samples.length;
for (const s of samples) for (let j = 0; j < NF; j += 1) std[j] += (s.x[j] - mean[j]) ** 2;
// Floor NEAR-zero variance, not just exact-zero: features that are effectively
// constant (e.g. buy/sellImbalance == 1/24) otherwise get std ~1e-14, and z-scoring
// then divides floating-point dust by it -- the amplified noise dominates and the
// net becomes fragile (a tiny input perturbation flips predictions). Treating them
// as std=1 neutralises the constant instead of amplifying its noise.
for (let j = 0; j < NF; j += 1) { const s = Math.sqrt(std[j] / samples.length); std[j] = s < 1e-8 ? 1 : s; }
const norm = (x: number[]) => x.map((v, j) => (v - mean[j]) / std[j]);

// Round-disjoint split: last 20% of rounds held out (never trained on).
const valStart = Math.floor(round * 0.8);
const train = samples.filter((s) => s.round < valStart).map((s) => ({ x: norm(s.x), y: s.y }));
const val = samples.filter((s) => s.round >= valStart).map((s) => ({ x: norm(s.x), y: s.y }));
process.stdout.write(`  train=${train.length}  val(held-out)=${val.length}\n\n`);

// ---- MLP: 24 -> H1 -> H2 -> 1, ReLU hidden, sigmoid out, BCE loss, Adam ----
const H1 = 32;
const H2 = 16;

function heInit(rows: number, cols: number): number[][] {
  const scale = Math.sqrt(2 / rows);
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rng() * 2 - 1) * scale));
}
type Mat = number[][];
type Vec = number[];
let W1 = heInit(NF, H1); let b1: Vec = new Array(H1).fill(0);
let W2 = heInit(H1, H2); let b2: Vec = new Array(H2).fill(0);
let W3 = heInit(H2, 1); let b3: Vec = [0];

// Adam moments
const zeros = (r: number, c: number): Mat => Array.from({ length: r }, () => new Array(c).fill(0));
const mW1 = zeros(NF, H1), vW1 = zeros(NF, H1), mb1 = new Array(H1).fill(0), vb1 = new Array(H1).fill(0);
const mW2 = zeros(H1, H2), vW2 = zeros(H1, H2), mb2 = new Array(H2).fill(0), vb2 = new Array(H2).fill(0);
const mW3 = zeros(H2, 1), vW3 = zeros(H2, 1), mb3 = [0], vb3 = [0];
const lr = 0.003, beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
let adamT = 0;

const relu = (v: Vec) => v.map((x) => (x > 0 ? x : 0));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
function matVec(x: Vec, W: Mat, b: Vec): Vec {
  const out = b.slice();
  for (let i = 0; i < W.length; i += 1) {
    const xi = x[i];
    if (xi === 0) continue;
    const row = W[i];
    for (let j = 0; j < row.length; j += 1) out[j] += xi * row[j];
  }
  return out;
}

function forward(x: Vec) {
  const z1 = matVec(x, W1, b1); const a1 = relu(z1);
  const z2 = matVec(a1, W2, b2); const a2 = relu(z2);
  const z3 = matVec(a2, W3, b3); const p = sigmoid(z3[0]);
  return { a1, a2, z1, z2, p };
}

// Accumulate gradients over a mini-batch, then one Adam step.
function trainBatch(batch: Array<{ x: Vec; y: number }>): number {
  const gW1 = zeros(NF, H1), gb1 = new Array(H1).fill(0);
  const gW2 = zeros(H1, H2), gb2 = new Array(H2).fill(0);
  const gW3 = zeros(H2, 1), gb3 = [0];
  let loss = 0;
  for (const { x, y } of batch) {
    const { a1, a2, z1, z2, p } = forward(x);
    loss += -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
    const dz3 = p - y; // dL/dz3
    for (let i = 0; i < H2; i += 1) gW3[i][0] += a2[i] * dz3;
    gb3[0] += dz3;
    const da2 = new Array(H2).fill(0);
    for (let i = 0; i < H2; i += 1) da2[i] = W3[i][0] * dz3;
    const dz2 = da2.map((g, i) => (z2[i] > 0 ? g : 0));
    for (let i = 0; i < H1; i += 1) for (let j = 0; j < H2; j += 1) gW2[i][j] += a1[i] * dz2[j];
    for (let j = 0; j < H2; j += 1) gb2[j] += dz2[j];
    const da1 = new Array(H1).fill(0);
    for (let i = 0; i < H1; i += 1) { let s = 0; for (let j = 0; j < H2; j += 1) s += W2[i][j] * dz2[j]; da1[i] = s; }
    const dz1 = da1.map((g, i) => (z1[i] > 0 ? g : 0));
    for (let i = 0; i < NF; i += 1) for (let j = 0; j < H1; j += 1) gW1[i][j] += x[i] * dz1[j];
    for (let j = 0; j < H1; j += 1) gb1[j] += dz1[j];
  }
  const n = batch.length;
  adamT += 1;
  const bc1 = 1 - beta1 ** adamT, bc2 = 1 - beta2 ** adamT;
  const step = (W: Mat, g: Mat, m: Mat, v: Mat) => {
    for (let i = 0; i < W.length; i += 1) for (let j = 0; j < W[i].length; j += 1) {
      const gr = g[i][j] / n;
      m[i][j] = beta1 * m[i][j] + (1 - beta1) * gr;
      v[i][j] = beta2 * v[i][j] + (1 - beta2) * gr * gr;
      W[i][j] -= (lr * (m[i][j] / bc1)) / (Math.sqrt(v[i][j] / bc2) + eps);
    }
  };
  const stepVec = (b: Vec, g: Vec, m: Vec, v: Vec) => {
    for (let j = 0; j < b.length; j += 1) {
      const gr = g[j] / n;
      m[j] = beta1 * m[j] + (1 - beta1) * gr;
      v[j] = beta2 * v[j] + (1 - beta2) * gr * gr;
      b[j] -= (lr * (m[j] / bc1)) / (Math.sqrt(v[j] / bc2) + eps);
    }
  };
  step(W1, gW1, mW1, vW1); stepVec(b1, gb1, mb1, vb1);
  step(W2, gW2, mW2, vW2); stepVec(b2, gb2, mb2, vb2);
  step(W3, gW3, mW3, vW3); stepVec(b3, gb3, mb3, vb3);
  return loss / n;
}

function auc(data: Array<{ x: Vec; y: number }>): number {
  const scored = data.map((s) => ({ p: forward(s.x).p, y: s.y }));
  const pos = scored.filter((s) => s.y === 1);
  const neg = scored.filter((s) => s.y === 0);
  if (!pos.length || !neg.length) return 0.5;
  scored.sort((a, b) => a.p - b.p);
  let rankSum = 0;
  for (let i = 0; i < scored.length; i += 1) if (scored[i].y === 1) rankSum += i + 1;
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

const BATCH = 64;
let bestValAuc = 0;
let bestWeights = "";
process.stdout.write("  epoch   trainLoss   valLoss    valAUC\n  " + "-".repeat(42) + "\n");
for (let e = 0; e < epochs; e += 1) {
  for (let i = train.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  let trLoss = 0; let batches = 0;
  for (let i = 0; i < train.length; i += BATCH) { trLoss += trainBatch(train.slice(i, i + BATCH)); batches += 1; }
  trLoss /= batches;
  let vLoss = 0;
  for (const s of val) { const p = forward(s.x).p; vLoss += -(s.y * Math.log(p + eps) + (1 - s.y) * Math.log(1 - p + eps)); }
  vLoss /= Math.max(1, val.length);
  const vAuc = auc(val);
  if (vAuc > bestValAuc) { bestValAuc = vAuc; bestWeights = JSON.stringify({ W1, b1, W2, b2, W3, b3 }); }
  if (e % 4 === 0 || e === epochs - 1) {
    process.stdout.write(`  ${String(e).padStart(5)}   ${trLoss.toFixed(4).padStart(9)}   ${vLoss.toFixed(4).padStart(7)}   ${vAuc.toFixed(4).padStart(7)}\n`);
  }
}

// Restore best-val snapshot before persisting.
const best = JSON.parse(bestWeights) as { W1: Mat; b1: Vec; W2: Mat; b2: Vec; W3: Mat; b3: Vec };
const bundle = {
  version: 1,
  kind: "mlp",
  savedAt: new Date().toISOString(),
  arch: [NF, H1, H2, 1],
  featureKeys: FEATURE_KEYS,
  mean, std,
  valAuc: Number(bestValAuc.toFixed(4)),
  trainSamples: train.length,
  valSamples: val.length,
  weights: best
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

process.stdout.write("\n=== NeuralEdge entrenado ===\n");
process.stdout.write(`  Arquitectura     : ${NF} -> ${H1} -> ${H2} -> 1 (ReLU, sigmoid)\n`);
process.stdout.write(`  Muestras         : ${train.length} train / ${val.length} val (held-out por rondas)\n`);
process.stdout.write(`  Mejor AUC val    : ${bestValAuc.toFixed(4)}  (0.5 = azar)\n`);
process.stdout.write(`  Modelo guardado  : ${outPath}\n\n`);
process.exit(0);
