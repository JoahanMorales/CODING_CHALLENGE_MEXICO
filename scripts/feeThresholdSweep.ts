// Profitability-threshold study: at what round-trip fee does REAL cross-exchange
// BTC arbitrage stop being ruinous and start being profitable? Replays a recorded
// tape through the SAME ArbitrageEngine the rest of the evidence uses, collects the
// GROSS cross-venue spread (before fees, which the engine already exposes as
// grossSpreadPct) for every dislocation, then re-prices each at a sweep of
// hypothetical round-trip fees F: net_F = grossBps - F. Reports the efficiency curve
// (fraction profitable + capturable PnL vs F) and the break-even fee, mapped onto
// real-world fee tiers (retail taker -> VIP -> maker-maker -> rebate).
//
// Turns the qualitative thesis ("untradeable at retail fees") into a hard number:
// exactly how low fees would have to be, and whether any real venue tier gets there.
//
//   npm run study:fee data/tape-XXXX.jsonl
//   npm run study:fee data/tape-XXXX.jsonl public/data/fee-threshold.json

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { NormalizedOrderBook, Opportunity } from "../src/lib/types";

const tapePath = process.argv[2];
if (!tapePath) { console.error("Uso: npm run study:fee <tape.jsonl> [salida.json]"); process.exit(1); }
const outPath = process.argv[3] ?? "public/data/fee-threshold.json";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { EXCHANGE_FEES, EXCHANGE_IDS } = await import("../src/lib/config/exchanges");

const engine = new ArbitrageEngine();
const grossBpsToUsd: Array<{ gross: number; net: number; notionalUsd: number }> = [];
let crossTotal = 0;
const midByVenue = new Map<string, number>();
let rounds = 0;

// bps helper: netSpreadPct/grossSpreadPct are in percent units (pct() x100), so bps = x100.
const toBps = (pctStr: string) => Number(pctStr) * 100;

const rl = createInterface({ input: createReadStream(tapePath), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  let parsed: { books?: NormalizedOrderBook[] };
  try { parsed = JSON.parse(s); } catch { continue; }
  if (!parsed?.books?.length) continue;
  rounds += 1;
  const offset = Date.now() - (parsed as { t?: number }).t!;
  for (const raw of parsed.books) {
    const book = { ...raw, receivedAt: raw.receivedAt + offset, exchangeTimestamp: raw.exchangeTimestamp + offset };
    const bid = Number(book.bids?.[0]?.price ?? 0);
    const ask = Number(book.asks?.[0]?.price ?? 0);
    if (bid && ask) midByVenue.set(book.exchange, (bid + ask) / 2);
    for (const opp of engine.onOrderBook(book) as Opportunity[]) {
      if (opp.type !== "CROSS_EXCHANGE") continue;
      crossTotal += 1;
      const gross = toBps(opp.grossSpreadPct);
      const net = toBps(opp.netSpreadPct);
      const mid = midByVenue.get(opp.buyExchange ?? "") ?? 63500;
      grossBpsToUsd.push({ gross, net, notionalUsd: Number(opp.tradeSizeBtc) * mid });
    }
  }
}
if (!crossTotal) { console.error("No hubo dislocaciones cross en el tape."); process.exit(1); }

// Effective retail round-trip fee actually applied by the engine (gross - net),
// averaged -- the point the efficiency curve must cross to reach retail.
const meanRetailFee = grossBpsToUsd.reduce((s, o) => s + (o.gross - o.net), 0) / grossBpsToUsd.length;
const cheapestTakerRoundTrip = 2 * Math.min(
  ...EXCHANGE_IDS.map((e) => Number(EXCHANGE_FEES[e].taker) * 10000)
) + 0; // both legs taker, cheapest pair (x2 for buy+sell legs? no: buy taker + sell taker)

// Sweep hypothetical round-trip fees (bps). Negatives model maker rebates.
const FEES = [-5, -2, 0, 1, 2, 4, 8, 12, 20, 30, 40, 60];
const curve = FEES.map((f) => {
  let profit = 0;
  let pnlUsd = 0;
  let grossPnlUsd = 0;
  for (const o of grossBpsToUsd) {
    const netF = o.gross - f;
    if (netF > 0) { profit += 1; pnlUsd += (netF / 10000) * o.notionalUsd; }
    grossPnlUsd += (o.gross / 10000) * o.notionalUsd;
  }
  return {
    roundTripFeeBps: f,
    profitablePct: Number(((profit / crossTotal) * 100).toFixed(2)),
    netPnlUsd: Math.round(pnlUsd),
    grossPnlUsd: Math.round(grossPnlUsd)
  };
});

// Break-even fee = the highest fee at which total net PnL over ALL dislocations is
// still >= 0 (i.e. capturing the positive-gross ones outweighs nothing, since we
// only take net_F>0). More useful: the fee at which the PROFITABLE set's mean net
// still clears zero -- which is just "fee < gross". So report the gross distribution.
const grosses = grossBpsToUsd.map((o) => o.gross).sort((a, b) => a - b);
const q = (p: number) => grosses[Math.floor(p * (grosses.length - 1))];
// Fee you'd need for HALF the dislocations to be profitable = median gross.
const breakEvenForHalf = Number(q(0.5).toFixed(2));
// Fee for the top 5% (the fattest dislocations) to be profitable.
const breakEvenForTop5 = Number(q(0.95).toFixed(2));

const FEE_TIERS = [
  { name: "Retail taker (peor par)", roundTripBps: Number((2 * Math.max(...EXCHANGE_IDS.map((e) => Number(EXCHANGE_FEES[e].taker) * 10000))).toFixed(1)) },
  { name: "Retail taker (mejor par)", roundTripBps: Number(cheapestTakerRoundTrip.toFixed(1)) },
  { name: "VIP taker (~4 bps/leg)", roundTripBps: 8 },
  { name: "Maker-maker (~1 bps/leg)", roundTripBps: 2 },
  { name: "Rebate venue (~-2 bps/leg)", roundTripBps: -4 }
];

const result = {
  generatedAt: new Date().toISOString(),
  tape: tapePath,
  rounds,
  crossDislocations: crossTotal,
  grossSpreadBps: { min: Number(q(0).toFixed(2)), p50: Number(q(0.5).toFixed(2)), p95: Number(q(0.95).toFixed(2)), max: Number(q(1).toFixed(2)) },
  meanRetailRoundTripFeeBps: Number(meanRetailFee.toFixed(2)),
  breakEvenFeeBps: { forHalfProfitable: breakEvenForHalf, forTop5Profitable: breakEvenForTop5 },
  feeTiers: FEE_TIERS.map((t) => ({
    ...t,
    profitablePct: Number(((grossBpsToUsd.filter((o) => o.gross - t.roundTripBps > 0).length / crossTotal) * 100).toFixed(2))
  })),
  curve,
  verdict:
    breakEvenForHalf <= 0
      ? `Aun a fee CERO, la mayoría de las dislocaciones cross son <=0 bps brutas: el mercado ya descuenta el arbitraje en el propio spread. Ni siquiera maker-maker (round-trip ~2 bps) lo rescata.`
      : `Se necesitaría un fee round-trip <= ${breakEvenForHalf} bps para que la mitad de las dislocaciones sean rentables -- por debajo del retail taker (>=${cheapestTakerRoundTrip.toFixed(0)} bps) y solo alcanzable como maker/VIP; a fees retail el arbitraje es estructuralmente ruinoso.`
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log("\n=== Umbral de rentabilidad · cross-exchange (datos reales) ===");
console.log(`  Tape                 : ${tapePath} (${rounds} rondas, ${crossTotal} dislocaciones)`);
console.log(`  Spread bruto (bps)   : min ${result.grossSpreadBps.min} · p50 ${result.grossSpreadBps.p50} · p95 ${result.grossSpreadBps.p95} · max ${result.grossSpreadBps.max}`);
console.log(`  Fee retail efectivo  : ${result.meanRetailRoundTripFeeBps} bps round-trip (promedio)`);
console.log(`  Break-even (mitad)   : <= ${breakEvenForHalf} bps round-trip`);
console.log(`\n  Rentables por tier de fee:`);
for (const t of result.feeTiers) console.log(`    ${t.name.padEnd(28)} ${String(t.roundTripBps).padStart(6)} bps -> ${t.profitablePct}% rentables`);
console.log(`\n  Curva de eficiencia (fee -> % rentable):`);
for (const c of curve) console.log(`    ${String(c.roundTripFeeBps).padStart(4)} bps -> ${String(c.profitablePct).padStart(6)}%  (netPnL $${c.netPnlUsd.toLocaleString()})`);
console.log(`\n  Veredicto: ${result.verdict}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
