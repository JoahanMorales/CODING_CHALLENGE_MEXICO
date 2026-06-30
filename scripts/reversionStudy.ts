import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

// Real-data ML study: does the cross-venue BTC spread mean-revert, and can the
// gradient-boosted EdgeTensor predict it from order-book microstructure?
//
// At retail fees no BTC arbitrage is *profitable* (the market is efficient -- see
// the /resultados evidence). But short-horizon spread reversion is a genuine,
// learnable signal. For every moment a venue-pair spread deviates from its rolling
// mean (|z| > 1) we label whether it reverted (the deviation shrank by >=40% K
// rounds later), train the ML on real order-book features, and report held-out AUC
// over a round-disjoint split. This is real ML learning real market structure --
// honestly framed: predictive, but untradeable at retail fees, which is exactly
// why execution stays gated.
//
//   npm run study:reversion data/tape-XXXX.jsonl

const tapePath = process.argv[2];
const outPath = process.argv[3] ?? "public/data/reversion-study.json";
if (!tapePath) {
  console.error("Uso: npm run study:reversion <tape.jsonl> [salida.json]");
  process.exit(1);
}

const { MlEdgeTensor } = await import("../src/lib/services/MlEdgeTensor");
const { EXCHANGE_IDS } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

interface TapeRound {
  t: number;
  books: NormalizedOrderBook[];
}

const rounds: TapeRound[] = [];
for (const line of readFileSync(tapePath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const parsed = JSON.parse(trimmed) as TapeRound;
    if (parsed && Array.isArray(parsed.books) && parsed.books.length) rounds.push(parsed);
  } catch {
    /* skip */
  }
}
if (rounds.length < 40) {
  console.error(`Tape demasiado corto (${rounds.length} rondas); graba al menos ~60s.`);
  process.exit(1);
}

function midOf(book: NormalizedOrderBook): number {
  const bid = Number(book.bids[0]?.price ?? 0);
  const ask = Number(book.asks[0]?.price ?? 0);
  return bid && ask ? (bid + ask) / 2 : 0;
}

// Per-round book map per venue (carry last-known forward so pairs stay aligned).
const bookByRound: Array<Partial<Record<ExchangeId, NormalizedOrderBook>>> = [];
const carry: Partial<Record<ExchangeId, NormalizedOrderBook>> = {};
for (const round of rounds) {
  for (const book of round.books) {
    if (book.symbol === "BTC/USDT") carry[book.exchange] = book;
  }
  bookByRound.push({ ...carry });
}

const model = new MlEdgeTensor();
const WINDOW = 24; // rolling window (rounds) for the spread mean/std
const LOOKAHEAD = 8; // forward markout horizon (~5-6s at 700ms cadence)
const Z_ENTRY = 1.0; // deviation magnitude to treat as a candidate
const REVERT_FRAC = 0.4; // counts as reverted if the deviation shrank by >=40%

const val: Array<{ features: ReturnType<typeof model.extractFeatures>; label: number }> = [];
let candidates = 0;
let reverted = 0;

const pairs: Array<[ExchangeId, ExchangeId]> = [];
for (let i = 0; i < EXCHANGE_IDS.length; i += 1) {
  for (let j = i + 1; j < EXCHANGE_IDS.length; j += 1) pairs.push([EXCHANGE_IDS[i], EXCHANGE_IDS[j]]);
}

for (const [a, b] of pairs) {
  // Precompute the full spread series first so the forward markout (t+LOOKAHEAD)
  // is actually available when we evaluate round t.
  const spreads: number[] = bookByRound.map((books) => {
    const ba = books[a];
    const bb = books[b];
    return ba && bb ? midOf(ba) - midOf(bb) : NaN;
  });
  for (let t = 0; t < bookByRound.length; t += 1) {
    const spread = spreads[t];
    if (t < WINDOW || !Number.isFinite(spread) || t + LOOKAHEAD >= bookByRound.length) continue;

    const win = spreads.slice(t - WINDOW, t).filter(Number.isFinite);
    if (win.length < WINDOW * 0.6) continue;
    const mean = win.reduce((s, v) => s + v, 0) / win.length;
    const variance = win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length;
    const std = Math.sqrt(variance);
    if (std <= 0) continue;
    const z = (spread - mean) / std;
    if (Math.abs(z) < Z_ENTRY) continue;

    const future = spreads[t + LOOKAHEAD];
    if (!Number.isFinite(future)) continue;
    const deviationNow = Math.abs(spread - mean);
    const deviationLater = Math.abs(future - mean);
    const label = deviationLater <= deviationNow * (1 - REVERT_FRAC) ? 1 : 0;
    candidates += 1;
    reverted += label;

    const ba2 = bookByRound[t][a]!;
    const bb2 = bookByRound[t][b]!;
    const features = model.extractFeatures(ba2, bb2, d("0.05"), "STAT_MEAN_REVERSION", d(String((spread - mean) / midOf(ba2))));
    // Round-disjoint-ish split: hold out 1 in 5 entries by round index.
    if (t % 5 === 0) val.push({ features, label });
    else model.train(`${a}:${b}`, features, label, 1);
  }
}

function auc(): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (const sample of val) {
    const p = model.predict(sample.features).survivalProbability;
    (sample.label === 1 ? pos : neg).push(p);
  }
  if (!pos.length || !neg.length) return 0.5;
  let concordant = 0;
  for (const p of pos) for (const n of neg) concordant += p > n ? 1 : p === n ? 0.5 : 0;
  return concordant / (pos.length * neg.length);
}

const baseRate = candidates ? reverted / candidates : 0;
const heldOutAuc = auc();
const study = {
  generatedAt: new Date().toISOString(),
  tape: tapePath,
  rounds: rounds.length,
  params: { window: WINDOW, lookahead: LOOKAHEAD, zEntry: Z_ENTRY, revertFraction: REVERT_FRAC },
  candidates,
  reverted,
  baseRatePct: Number((baseRate * 100).toFixed(1)),
  trainSamples: candidates - val.length,
  valSamples: val.length,
  heldOutAuc: Number(heldOutAuc.toFixed(4)),
  trees: model.treeCount(),
  takeaway:
    heldOutAuc > 0.55
      ? "El spread cross-venue revierte de forma predecible desde la microestructura: el ML supera el azar en datos reales. Es una señal genuina, aunque no rentable tras fees retail (por eso la ejecución sigue gateada)."
      : "El spread revierte (base rate alto) pero la microestructura aporta poca señal extra en esta ventana."
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(study, null, 2));

console.log("\n=== Estudio de reversión a la media (datos reales) ===");
console.log(`  Tape            : ${tapePath} (${rounds.length} rondas)`);
console.log(`  Candidatas      : ${candidates} desviaciones |z|>${Z_ENTRY}`);
console.log(`  Base rate       : ${study.baseRatePct}% revirtieron en ${LOOKAHEAD} rondas`);
console.log(`  Train / val     : ${study.trainSamples} / ${study.valSamples} (holdout 1/5)`);
console.log(`  Árboles         : ${study.trees}`);
console.log(`  AUC held-out    : ${study.heldOutAuc}  (0.5 = azar)`);
console.log(`\n  ${study.takeaway}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
