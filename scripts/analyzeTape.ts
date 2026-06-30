import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NormalizedOrderBook, Opportunity } from "../src/lib/types";

// Replays a recorded real-market tape through the engine and writes a committed
// analysis artifact (public/data/tape-analysis.json) that the /resultados page
// renders: the distribution of real cross-exchange net spreads (evidence that
// retail cross-exchange arb is unprofitable) and a latency-arbitrage summary.
//
//   npm run analyze:tape data/tape-XXXX.jsonl
//   npm run analyze:tape data/tape-XXXX.jsonl public/data/tape-analysis.json

const tapePath = process.argv[2];
const outPath = process.argv[3] ?? "public/data/tape-analysis.json";
if (!tapePath) {
  console.error("Uso: npm run analyze:tape <tape.jsonl> [salida.json]");
  process.exit(1);
}

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");

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
    // skip malformed
  }
}
if (!rounds.length) {
  console.error(`Tape vacío o ilegible: ${tapePath}`);
  process.exit(1);
}

const engine = new ArbitrageEngine();
const crossNetBps: number[] = [];
let crossTotal = 0;
let crossProfitable = 0;
let crossDetected = 0;
let latencyCandidates = 0;
let latencyDetected = 0;
let latencyMaxNetBps = -Infinity;
let latencyMaxStalenessMs = 0;
let statCandidates = 0;
let statDetected = 0;
let statMaxNetBps = -Infinity;
let statBestZAbs = 0;
// Independent staleness measurement: the max inter-venue receivedAt skew seen at
// any moment (what LATENCY_ARB compares against its 1800ms bar), regardless of
// whether a crossed book also existed. Shows how close REST capture gets.
const lastSeenAt = new Map<string, number>();
let maxObservedStalenessMs = 0;
let stalenessOver1800 = 0;
const venues = new Set<string>();
let firstT = Infinity;
let lastT = -Infinity;
let bookCount = 0;
let basisBps = "0.000";

function netBps(opportunity: Opportunity): number {
  // netSpreadPct is formatted in percent units (pct() multiplies by 100), so bps = value * 100.
  return Number(opportunity.netSpreadPct) * 100;
}

for (const round of rounds) {
  firstT = Math.min(firstT, round.t);
  lastT = Math.max(lastT, round.t);
  const offset = Date.now() - round.t;
  const rebased = round.books.map((book) => ({
    ...book,
    receivedAt: book.receivedAt + offset,
    exchangeTimestamp: book.exchangeTimestamp + offset
  }));
  for (const book of rebased) {
    venues.add(book.exchange);
    bookCount += 1;
    if (book.exchange === "binance" && book.quoteBasisBps) basisBps = book.quoteBasisBps;
    lastSeenAt.set(book.exchange, book.receivedAt);
    if (lastSeenAt.size >= 2) {
      const times = [...lastSeenAt.values()];
      const skew = Math.max(...times) - Math.min(...times);
      maxObservedStalenessMs = Math.max(maxObservedStalenessMs, skew);
      if (skew > 1800) stalenessOver1800 += 1;
    }
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type === "CROSS_EXCHANGE") {
        crossTotal += 1;
        const bps = netBps(opportunity);
        crossNetBps.push(bps);
        if (bps > 0) {
          crossProfitable += 1;
          // A positive raw net spread (after fees) doesn't mean the engine would
          // actually trade it -- the AET risk-adjustment (adverse selection,
          // volatility, latency risk, calibration bias) can still reject it. Track
          // both so we never conflate "the visible math is positive" with "the
          // engine marked this genuinely executable".
          if (opportunity.status === "DETECTED") crossDetected += 1;
        }
      } else if (opportunity.type === "LATENCY_ARB") {
        latencyCandidates += 1;
        if (opportunity.status === "DETECTED") latencyDetected += 1;
        latencyMaxNetBps = Math.max(latencyMaxNetBps, netBps(opportunity));
        const staleMatch = /stale (\d+)ms/.exec(opportunity.route);
        if (staleMatch) latencyMaxStalenessMs = Math.max(latencyMaxStalenessMs, Number(staleMatch[1]));
      } else if (opportunity.type === "STAT_ARB") {
        statCandidates += 1;
        if (opportunity.status === "DETECTED") statDetected += 1;
        statMaxNetBps = Math.max(statMaxNetBps, netBps(opportunity));
        const zMatch = /Z (-?\d+\.\d+)/.exec(opportunity.reason);
        if (zMatch) statBestZAbs = Math.max(statBestZAbs, Math.abs(Number(zMatch[1])));
      }
    }
  }
}

crossNetBps.sort((a, b) => a - b);
const quantile = (p: number) => (crossNetBps.length ? crossNetBps[Math.floor(p * (crossNetBps.length - 1))] : 0);

// Histogram in 10bps bins over the observed range (clamped to a sane window).
const binSize = 10;
const lo = Math.floor(Math.max(-200, quantile(0)) / binSize) * binSize;
const hi = Math.ceil(Math.min(60, quantile(1)) / binSize) * binSize;
const histogram: Array<{ binBps: number; count: number }> = [];
for (let edge = lo; edge < hi; edge += binSize) {
  const count = crossNetBps.filter((v) => v >= edge && v < edge + binSize).length;
  histogram.push({ binBps: edge, count });
}

const durationSec = Math.round((lastT - firstT) / 1000);
const crossProfitablePct = crossTotal ? Number(((crossProfitable / crossTotal) * 100).toFixed(2)) : 0;
const analysis = {
  generatedAt: new Date().toISOString(),
  tape: tapePath,
  capture: {
    rounds: rounds.length,
    books: bookCount,
    venues: [...venues],
    durationSec,
    usdtUsdBasisBps: basisBps
  },
  cross: {
    candidates: crossTotal,
    profitable: crossProfitable,
    profitablePct: crossProfitablePct,
    // "profitable" only means the raw net spread (after fees) was positive -- it
    // does NOT mean the engine would trade it. "detected" is the AET-risk-adjusted
    // truth: did expectedValueUsd/survivalProbability/sync/health all clear the
    // executable bar. A gap between the two (profitable > 0, detected = 0) shows
    // the risk-adjustment gate correctly rejecting thin, risky raw-positive spreads.
    detected: crossDetected,
    netSpreadBps: {
      min: Number(quantile(0).toFixed(2)),
      p25: Number(quantile(0.25).toFixed(2)),
      median: Number(quantile(0.5).toFixed(2)),
      p75: Number(quantile(0.75).toFixed(2)),
      max: Number(quantile(1).toFixed(2))
    },
    histogram
  },
  latency: {
    candidates: latencyCandidates,
    detected: latencyDetected,
    maxNetBps: latencyCandidates ? Number(latencyMaxNetBps.toFixed(2)) : 0,
    maxStalenessMs: latencyMaxStalenessMs,
    maxObservedStalenessMs,
    stalenessOver1800,
    thresholdMs: 1800
  },
  statArb: {
    candidates: statCandidates,
    detected: statDetected,
    maxNetBps: statCandidates ? Number(statMaxNetBps.toFixed(2)) : 0,
    bestZAbs: Number(statBestZAbs.toFixed(2)),
    requiredZAbs: 1.6
  },
  verdict:
    crossDetected > 0
      ? `${crossDetected} de ${crossTotal} dislocaciones cross fueron DETECTED (ejecutables) por el motor.`
      : crossProfitable === 0
        ? "A tarifas retail, ninguna dislocación cross-exchange real superó fees+base. El mercado es eficiente; el valor está en rechazarlas con precisión."
        : `${crossProfitable} de ${crossTotal} (${crossProfitablePct}%) tuvieron spread neto positivo tras fees, pero 0 fueron DETECTED: el ajuste por riesgo del Edge Tensor (supervivencia, P&L ajustado a riesgo) rechazó correctamente todas -- el edge visible es real pero demasiado delgado para sobrevivir el riesgo de ejecución de dos patas no simultáneas.`
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(analysis, null, 2));

console.log("\n=== Análisis del tape real ===");
console.log(`  Tape              : ${tapePath}`);
console.log(`  Captura           : ${rounds.length} rondas · ${bookCount} libros · ${[...venues].length} venues · ${durationSec}s`);
console.log(`  Base USDT/USD     : ${basisBps} bps`);
console.log(`\n  Cross-exchange:`);
console.log(`    candidatas      : ${crossTotal}`);
console.log(`    spread neto>0   : ${crossProfitable} (${analysis.cross.profitablePct}%) -- NO implica ejecutable, ver DETECTED`);
console.log(`    DETECTED        : ${crossDetected} (ejecutable según el motor: sync + salud + supervivencia + EV)`);
console.log(`    net spread bps  : min ${analysis.cross.netSpreadBps.min} · mediana ${analysis.cross.netSpreadBps.median} · max ${analysis.cross.netSpreadBps.max}`);
console.log(`\n  Latency-arb (stale-quote):`);
console.log(`    candidatas         : ${latencyCandidates}`);
console.log(`    DETECTED           : ${latencyDetected}`);
console.log(`    max staleness obs. : ${maxObservedStalenessMs}ms (bar: 1800ms · superado ${stalenessOver1800}x)`);
if (latencyCandidates) console.log(`    max net edge       : ${analysis.latency.maxNetBps} bps`);
console.log(`\n  Stat-arb: ${statCandidates} candidatas, ${statDetected} DETECTED`);
if (statCandidates) console.log(`    mejor |z| observado: ${analysis.statArb.bestZAbs} (umbral ${analysis.statArb.requiredZAbs}) · mejor net edge: ${analysis.statArb.maxNetBps}bps`);
console.log(`\n  Veredicto: ${analysis.verdict}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
