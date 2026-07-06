// Two-model committee study. Scores a fresh, round-disjoint held-out set of
// labelled cross-exchange trials with BOTH shipped models -- the gradient-boosted
// tree ensemble (public/model/edge-model.json) and the NeuralEdge MLP
// (public/model/neural-edge.json) -- plus their average (the "committee"), and
// reports AUC + Brier for each. Writes public/data/neural-study.json for the UI.
//
//   npm run study:neural            # 15k held-out trials

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook, OrderBookLevel } from "../src/lib/types";

process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { NeuralEdge } = await import("../src/lib/services/NeuralEdge");
const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

const targetSamples = Number(process.argv[2] ?? 15000);
// Distinct seed from training so this held-out set is genuinely unseen by both.
const seed = Number(process.argv[3] ?? 0x51ed270b);
const outPath = "public/data/neural-study.json";

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);

const risk = new RiskManager();
const engine = new ArbitrageEngine();
const wallets = Object.fromEntries(EXCHANGE_IDS.map((id: ExchangeId) => [id, { btc: "100000", usdt: "7000000000" }]));
const simulator = new ExecutionSimulator(wallets as never, () => risk.getLatencyMultiplier());
const neural = new NeuralEdge();

// Load both shipped models.
function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
const treeBundle = readJson("public/model/edge-model.json") as { ml?: unknown } | null;
const treeLoaded = treeBundle?.ml ? engine.mlEdgeTensor.importModel(treeBundle.ml as Parameters<typeof engine.mlEdgeTensor.importModel>[0]) : false;
const nnBundle = readJson("public/model/neural-edge.json");
const nnLoaded = neural.importModel(nnBundle);
if (!treeLoaded || !nnLoaded) {
  console.error(`\nFaltan modelos: tree=${treeLoaded} nn=${nnLoaded}. Entrena con npm run train:search y npm run train:neural.\n`);
  process.exit(1);
}

const takerBps = (e: ExchangeId) => Number(EXCHANGE_FEES[e].taker) * 10000;
const spreadOf = (i: number) => 1.2 + i * 0.35;
const sizeOf = (i: number) => 0.72 + i * 0.11;
let genMid = 70000;
function book(exchange: ExchangeId, mid: number, spread: number, topSize: number, receivedAt: number): NormalizedOrderBook {
  const bids: OrderBookLevel[] = []; const asks: OrderBookLevel[] = [];
  for (let l = 0; l < 5; l += 1) {
    const step = spread * (l + 0.5); const size = topSize * (1 + l * 0.42);
    bids.push({ price: (mid - step).toFixed(2), size: size.toFixed(8) });
    asks.push({ price: (mid + step).toFixed(2), size: (size * 0.92).toFixed(8) });
  }
  return { exchange, symbol: "BTC/USDT", sourceSymbol: "BTC/USDT", quoteAsset: "USDT", quoteToUsdRate: "1.00000000", quoteBasisBps: "0.000", bids, asks, receivedAt, exchangeTimestamp: receivedAt - Math.floor(rng() * 35), processingLatencyMs: Number((rng() * 2.7 + 0.4).toFixed(2)), integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "neural-study" } };
}
function round(): { books: NormalizedOrderBook[]; focus: { buy: ExchangeId; sell: ExchangeId } } {
  genMid *= Math.exp((rng() - 0.5) * 0.0008);
  const now = Date.now();
  const books = EXCHANGE_IDS.map((e: ExchangeId, i: number) => book(e, genMid + (rng() - 0.5) * 24, spreadOf(i), sizeOf(i), now));
  const bi = Math.floor(rng() * EXCHANGE_IDS.length);
  let si = Math.floor(rng() * EXCHANGE_IDS.length); if (si === bi) si = (si + 1) % EXCHANGE_IDS.length;
  const be = EXCHANGE_IDS[bi]; const se = EXCHANGE_IDS[si];
  const strong = rng() < 0.2;
  const netTargetBps = strong ? 45 + rng() * 30 : -12 + rng() * 34;
  const grossEdgeBps = Math.max(2, netTargetBps + takerBps(be) + takerBps(se) + 8);
  const thin = !strong && rng() < 0.3;
  const x = ((genMid * grossEdgeBps) / 10000 + spreadOf(bi) * 0.5 + spreadOf(si) * 0.5) / 2;
  const skewMs = Math.floor(rng() * 1500);
  books[bi] = book(be, genMid - x, spreadOf(bi), thin ? sizeOf(bi) * 0.1 : sizeOf(bi), now);
  books[si] = book(se, genMid + x, spreadOf(si), thin ? sizeOf(si) * 0.1 : sizeOf(si), now - skewMs);
  return { books, focus: { buy: be, sell: se } };
}

interface Scored { tree: number; nn: number; committee: number; label: number }
const scored: Scored[] = [];
console.log(`\nArbitrAI · estudio de comité (árbol + red neuronal) — ${targetSamples} ensayos held-out...\n`);
let rounds = 0;
while (scored.length < targetSamples) {
  const { books, focus } = round();
  const byExchange = new Map<ExchangeId, NormalizedOrderBook>();
  for (const b of books) byExchange.set(b.exchange, b);
  for (const b of books) {
    for (const opp of engine.onOrderBook(b)) {
      if (opp.type !== "CROSS_EXCHANGE" || opp.buyExchange !== focus.buy || opp.sellExchange !== focus.sell) continue;
      const trade = await simulator.execute(opp);
      const buyBook = byExchange.get(focus.buy); const sellBook = byExchange.get(focus.sell);
      if (!buyBook || !sellBook) continue;
      const feat = engine.mlEdgeTensor.extractFeatures(buyBook, sellBook, d(opp.tradeSizeBtc), opp.executionStyle, d(opp.netSpreadPct).div(100));
      const tree = engine.mlEdgeTensor.predict(feat).survivalProbability;
      const nn = neural.predict(feat as unknown as Record<string, number>);
      scored.push({ tree, nn, committee: (tree + nn) / 2, label: Number(trade.pnlUsd) > 0 ? 1 : 0 });
    }
  }
  rounds += 1;
}

function auc(rows: Array<{ p: number; label: number }>): number {
  const pos = rows.filter((r) => r.label === 1).length;
  const neg = rows.length - pos;
  if (!pos || !neg) return 0.5;
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i].label === 1) rankSum += i + 1;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
const brier = (rows: Array<{ p: number; label: number }>) => rows.reduce((s, r) => s + (r.p - r.label) ** 2, 0) / rows.length;

const metrics = (pick: (s: Scored) => number) => {
  const rows = scored.map((s) => ({ p: pick(s), label: s.label }));
  return { auc: Number(auc(rows).toFixed(4)), brier: Number(brier(rows).toFixed(4)) };
};
const tree = metrics((s) => s.tree);
const nn = metrics((s) => s.nn);
const committee = metrics((s) => s.committee);
const winners = scored.filter((s) => s.label === 1).length;

const ranked = [
  { name: "árbol con gradient boosting", m: tree },
  { name: "red neuronal", m: nn },
  { name: "comité", m: committee }
].sort((a, b) => a.m.brier - b.m.brier);
const best = ranked[0];
const takeaway =
  best.name === "comité"
    ? `El comité (promedio de los dos modelos independientes) logra el mejor Brier (${committee.brier} vs árbol ${tree.brier} / red ${nn.brier}) con AUC ${committee.auc}. Dos familias de modelo que separan winners de losers por caminos distintos se corrigen mutuamente el ruido de calibración.`
    : `En este held-out la ${best.name} es el modelo individual más fuerte (AUC ${best.m.auc}, Brier ${best.m.brier}); el comité promedia ambas opiniones como segunda voz robusta. Dos modelos independientes de arquitectura distinta reducen el riesgo de que una sola familia se equivoque en conjunto.`;

const artifact = {
  generatedAt: new Date().toISOString(),
  source: "generator",
  heldOutSamples: scored.length,
  winners,
  winRatePct: Number(((winners / scored.length) * 100).toFixed(1)),
  tree,
  neural: nn,
  committee,
  neuralArch: (nnBundle as { arch?: number[] })?.arch ?? null,
  takeaway
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log("=== Comité de dos modelos (held-out) ===");
console.log(`  Muestras         : ${scored.length}  (${artifact.winRatePct}% winners)`);
console.log(`  Árbol (GBM)      : AUC ${tree.auc}  Brier ${tree.brier}`);
console.log(`  Red neuronal     : AUC ${nn.auc}  Brier ${nn.brier}`);
console.log(`  Comité (promedio): AUC ${committee.auc}  Brier ${committee.brier}`);
console.log(`\n  ${takeaway}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
