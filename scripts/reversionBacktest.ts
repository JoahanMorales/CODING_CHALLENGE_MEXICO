// Tradeability backtest for the real spread-reversion signal. The reversion AUC
// (~0.67) only says "the deviation tends to shrink"; this asks the honest money
// question: if you actually traded a convergence position on every |z|>1 signal
// and unwound it LOOKAHEAD rounds later, would the captured reversion beat the
// round-trip fees? Model-independent (needs no GPU): the decisive stat is whether,
// even with PERFECT foresight (trade only the deviations that DID revert), the mean
// gross reversion edge exceeds the cheapest round-trip fee. Streams the tape.
//
//   npx tsx scripts/reversionBacktest.ts data/tape-XXXX.jsonl

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

const tapePath = process.argv[2];
if (!tapePath) { console.error("Uso: npx tsx scripts/reversionBacktest.ts <tape.jsonl>"); process.exit(1); }
const outPath = process.argv[3] ?? "scripts/gpu/out/reversion-backtest.json";

const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const takerBps = (e: ExchangeId) => Number(EXCHANGE_FEES[e].taker) * 10000;

const WINDOW = 24, LOOKAHEAD = Number(process.env.LOOKAHEAD ?? 8), Z_ENTRY = 1.0, REVERT_FRAC = 0.4;

function midFromLevels(book: NormalizedOrderBook): number {
  const bid = Number(book.bids[0]?.price ?? 0);
  const ask = Number(book.asks[0]?.price ?? 0);
  return bid && ask ? (bid + ask) / 2 : 0;
}

// Pass: build per-venue mid series (carry-forward).
const mids: Record<string, number[]> = Object.fromEntries(EXCHANGE_IDS.map((e: ExchangeId) => [e, []]));
const carry: Partial<Record<ExchangeId, number>> = {};
let rounds = 0;
const rl = createInterface({ input: createReadStream(tapePath), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  try {
    const p = JSON.parse(s) as { books?: NormalizedOrderBook[] };
    if (p && Array.isArray(p.books) && p.books.length) {
      for (const b of p.books) if (b.symbol === "BTC/USDT") carry[b.exchange] = midFromLevels(b);
      for (const e of EXCHANGE_IDS) mids[e].push(carry[e] ?? NaN);
      rounds += 1;
    }
  } catch { /* skip */ }
}

const pairs: Array<[ExchangeId, ExchangeId]> = [];
for (let i = 0; i < EXCHANGE_IDS.length; i += 1)
  for (let j = i + 1; j < EXCHANGE_IDS.length; j += 1) pairs.push([EXCHANGE_IDS[i], EXCHANGE_IDS[j]]);

let candidates = 0, reverted = 0;
let sumGrossAll = 0, sumGrossRev = 0;      // captured reversion (bps)
let sumFeeAll = 0, sumFeeRev = 0;          // round-trip taker cost (bps) for the pair
let netPositiveAll = 0, netPositiveRev = 0; // # where gross beat the pair's round-trip fee
const cheapestRoundTrip = 2 * Math.min(...pairs.map(([a, b]) => takerBps(a) + takerBps(b)));

for (const [a, b] of pairs) {
  const sA = mids[a], sB = mids[b];
  const roundTripFee = 2 * (takerBps(a) + takerBps(b)); // enter+exit, both legs
  for (let t = 0; t < rounds; t += 1) {
    const spread = sA[t] - sB[t];
    if (t < WINDOW || !Number.isFinite(spread) || t + LOOKAHEAD >= rounds) continue;
    let sum = 0, n = 0;
    for (let k = t - WINDOW; k < t; k += 1) { const v = sA[k] - sB[k]; if (Number.isFinite(v)) { sum += v; n += 1; } }
    if (n < WINDOW * 0.6) continue;
    const mean = sum / n;
    let varSum = 0; for (let k = t - WINDOW; k < t; k += 1) { const v = sA[k] - sB[k]; if (Number.isFinite(v)) varSum += (v - mean) ** 2; }
    const std = Math.sqrt(varSum / n);
    if (std <= 0) continue;
    if (Math.abs((spread - mean) / std) < Z_ENTRY) continue;
    const future = sA[t + LOOKAHEAD] - sB[t + LOOKAHEAD];
    if (!Number.isFinite(future)) continue;
    const devNow = Math.abs(spread - mean);
    const devLater = Math.abs(future - mean);
    const label = devLater <= devNow * (1 - REVERT_FRAC) ? 1 : 0;
    const mid = sA[t] || 1;
    const grossBps = ((devNow - devLater) / mid) * 10000; // reversion captured if you caught it

    candidates += 1; reverted += label;
    sumGrossAll += grossBps; sumFeeAll += roundTripFee;
    if (grossBps > roundTripFee) netPositiveAll += 1;
    if (label === 1) {
      sumGrossRev += grossBps; sumFeeRev += roundTripFee;
      if (grossBps > roundTripFee) netPositiveRev += 1;
    }
  }
}

const meanGrossAll = sumGrossAll / candidates;
const meanGrossRev = sumGrossRev / reverted;
const meanFeeAll = sumFeeAll / candidates;
const meanFeeRev = sumFeeRev / reverted;
const result = {
  generatedAt: new Date().toISOString(), tape: tapePath, rounds, candidates, reverted,
  baseRatePct: Number((reverted / candidates * 100).toFixed(1)),
  cheapestRoundTripFeeBps: Number(cheapestRoundTrip.toFixed(2)),
  meanGrossReversionBps_all: Number(meanGrossAll.toFixed(3)),
  meanGrossReversionBps_revertedOnly: Number(meanGrossRev.toFixed(3)),
  meanRoundTripFeeBps_all: Number(meanFeeAll.toFixed(2)),
  meanNetBps_all: Number((meanGrossAll - meanFeeAll).toFixed(3)),
  meanNetBps_perfectForesight: Number((meanGrossRev - meanFeeRev).toFixed(3)),
  pctBeatingFee_all: Number((netPositiveAll / candidates * 100).toFixed(2)),
  pctBeatingFee_perfectForesight: Number((netPositiveRev / reverted * 100).toFixed(2)),
  verdict:
    (meanGrossRev - cheapestRoundTrip) < 0
      ? "UNTRADEABLE: even with PERFECT foresight (trading only deviations that DID revert) the mean captured reversion is below the CHEAPEST round-trip fee. No model gating can turn this profitable at retail taker fees."
      : "Gross reversion exceeds the cheapest round-trip fee on the reverted subset -- worth a full execution-aware backtest (spreads, slippage, sizing) before any claim."
};

mkdirSync("scripts/gpu/out", { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log("\n=== Backtest de rentabilidad de la reversión (datos reales) ===");
console.log(`  Tape                         : ${tapePath} (${rounds} rondas)`);
console.log(`  Candidatas / revirtieron     : ${candidates} / ${reverted} (${result.baseRatePct}%)`);
console.log(`  Fee round-trip más barato    : ${result.cheapestRoundTripFeeBps} bps`);
console.log(`  Edge bruto medio (todas)     : ${result.meanGrossReversionBps_all} bps`);
console.log(`  Edge bruto (previsión perfecta): ${result.meanGrossReversionBps_revertedOnly} bps  <-- techo absoluto`);
console.log(`  Neto medio (previsión perfecta): ${result.meanNetBps_perfectForesight} bps`);
console.log(`  % que le gana al fee (perfecta): ${result.pctBeatingFee_perfectForesight}%`);
console.log(`\n  ${result.verdict}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
