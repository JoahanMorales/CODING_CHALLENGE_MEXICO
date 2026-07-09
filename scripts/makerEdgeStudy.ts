// Maker-side edge study on real tape: can passive market-making capture an edge, or
// does adverse selection eat the spread? The taker-side fee study showed cross-arb is
// untradeable at retail fees; this is the maker-side complement.
//
// Honest method — a COMPONENT DECOMPOSITION, not a fill simulation. Simulating passive
// fills from L2 snapshots (no trade prints) is unreliable: any "fill when the book
// trades through my price" rule only triggers on adverse moves and overstates adverse
// selection. So instead we measure the two things a maker's P&L is made of, directly
// and unconditionally, per venue:
//
//   * halfSpreadBps   = what a fill earns, best case: (ask - bid) / (2·mid) · 1e4
//   * midMoveBps@H    = the risk the quote carries: mean |mid[t+H] - mid[t]| / mid · 1e4
//                       -- the scale of price moves over the quote's lifetime, i.e. the
//                       ceiling on adverse selection per fill.
//
// If the half-spread is orders of magnitude below the mid move over the quote horizon,
// spread-capture alone cannot be the edge -- passive MM there is a rebate/latency game,
// not a spread game. We do NOT claim a single net "edge per fill": whether rebates tip
// it positive depends on fill dynamics L2 snapshots can't resolve, and we say so.
//
//   npm run study:maker data/tape-XXXX.jsonl [salida.json]

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

const tapePath = process.argv[2];
if (!tapePath) { console.error("Uso: npm run study:maker <tape.jsonl> [salida.json]"); process.exit(1); }
const outPath = process.argv[3] ?? "public/data/maker-edge.json";

const { EXCHANGE_IDS, EXCHANGE_FEES, EXCHANGE_LABELS } = await import("../src/lib/config/exchanges");
const H = Number(process.env.MARKOUT ?? 8); // rounds a passive quote realistically rests

const bidP = (b: NormalizedOrderBook) => Number(b.bids?.[0]?.price ?? 0);
const askP = (b: NormalizedOrderBook) => Number(b.asks?.[0]?.price ?? 0);

// Per-venue mid + half-spread series (carry-forward), built streaming.
const mids: Record<string, number[]> = {}, halves: Record<string, number[]> = {};
for (const e of EXCHANGE_IDS) { mids[e] = []; halves[e] = []; }
const carry: Partial<Record<ExchangeId, NormalizedOrderBook>> = {};
let rounds = 0;
const rl = createInterface({ input: createReadStream(tapePath), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  let p: { books?: NormalizedOrderBook[] }; try { p = JSON.parse(s); } catch { continue; }
  if (!p?.books?.length) continue;
  for (const b of p.books) if (b.symbol === "BTC/USDT") carry[b.exchange] = b;
  for (const e of EXCHANGE_IDS) {
    const b = carry[e];
    const bid = b ? bidP(b) : 0, ask = b ? askP(b) : 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : NaN;
    mids[e].push(mid);
    halves[e].push(mid > 0 && ask > bid ? ((ask - bid) / (2 * mid)) * 1e4 : NaN);
  }
  rounds += 1;
}
if (rounds < 100) { console.error(`Tape demasiado corto (${rounds} rondas).`); process.exit(1); }

interface VenueRow {
  venue: string; label: string; samples: number;
  halfSpreadBps: number;   // captured per fill, best case
  midMoveBps: number;      // adverse-selection scale over H rounds
  ratio: number;           // midMove / halfSpread -- how many x the risk dwarfs the spread
  breakevenRebateBps: number; // upper-bound rebate needed so spread+rebate covers the move
  makerFeeBps: number;     // the venue's actual maker fee (>0 = a cost, not a rebate)
}

const perVenue: VenueRow[] = [];
for (const e of EXCHANGE_IDS) {
  const M = mids[e], HS = halves[e];
  let sumHalf = 0, nHalf = 0, sumMove = 0, nMove = 0;
  for (let t = 0; t < rounds - H; t += 1) {
    if (Number.isFinite(HS[t])) { sumHalf += HS[t]; nHalf += 1; }
    if (M[t] > 0 && M[t + H] > 0) { sumMove += (Math.abs(M[t + H] - M[t]) / M[t]) * 1e4; nMove += 1; }
  }
  if (!nHalf || !nMove) continue;
  const halfSpreadBps = sumHalf / nHalf;
  const midMoveBps = sumMove / nMove;
  perVenue.push({
    venue: e, label: EXCHANGE_LABELS[e as ExchangeId] ?? e, samples: nHalf,
    halfSpreadBps: Number(halfSpreadBps.toFixed(4)),
    midMoveBps: Number(midMoveBps.toFixed(3)),
    ratio: Number((midMoveBps / Math.max(1e-9, halfSpreadBps)).toFixed(1)),
    breakevenRebateBps: Number(Math.max(0, midMoveBps - halfSpreadBps).toFixed(3)),
    makerFeeBps: Number((Number(EXCHANGE_FEES[e as ExchangeId].maker) * 1e4).toFixed(2))
  });
}
perVenue.sort((a, b) => a.halfSpreadBps - b.halfSpreadBps);

// Liquidity-weighted-ish summary over the liquid venues (exclude the widest outlier,
// which is a different, thin regime).
const liquid = perVenue.filter((v) => v.halfSpreadBps < 0.1);
const meanHalf = liquid.reduce((s, v) => s + v.halfSpreadBps, 0) / (liquid.length || 1);
const meanMove = liquid.reduce((s, v) => s + v.midMoveBps, 0) / (liquid.length || 1);
const bestRealRebateBps = 2.5; // most generous real maker rebate tier (one leg)

const result = {
  generatedAt: new Date().toISOString(), tape: tapePath, rounds, markoutRounds: H,
  liquidVenues: { meanHalfSpreadBps: Number(meanHalf.toFixed(4)), meanMidMoveBps: Number(meanMove.toFixed(3)), ratio: Number((meanMove / Math.max(1e-9, meanHalf)).toFixed(0)) },
  bestRealRebateBps,
  perVenue,
  verdict:
    `En las venues líquidas el medio spread es ~${meanHalf.toFixed(3)} bps (1 tick — casi nada que capturar), pero el mid se mueve ~${meanMove.toFixed(2)} bps durante la vida de la quote (~${H} rondas): el riesgo es ~${(meanMove / Math.max(1e-9, meanHalf)).toFixed(0)}× el spread. O sea el spread NO compensa el riesgo de inventario: el market-making pasivo aquí no es un juego de capturar spread, es un juego de rebate/latencia. Incluso el mejor rebate real (~${bestRealRebateBps} bps) queda por debajo del movimiento adverso típico, y si el neto sobrevive depende de la dinámica de fills que los snapshots L2 no pueden resolver — por eso no afirmamos un edge neto único. Honesto: sin ventaja de latencia o rebates agresivos, no hay almuerzo gratis del lado maker tampoco.`
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log("\n=== Estudio maker-side (descomposición, datos reales) ===");
console.log(`  Tape          : ${tapePath} (${rounds} rondas) · markout ${H} rondas`);
console.log(`  Líquidas      : medio spread ~${meanHalf.toFixed(4)} bps · mid move ~${meanMove.toFixed(3)} bps · ratio ~${(meanMove / Math.max(1e-9, meanHalf)).toFixed(0)}×`);
console.log(`\n  Por venue (medio spread / mid move@${H} / ratio / rebate breakeven):`);
for (const v of perVenue) console.log(`    ${v.label.padEnd(10)} ${String(v.halfSpreadBps).padStart(8)} / ${String(v.midMoveBps).padStart(7)} / ${String(v.ratio).padStart(7)}× / ${String(v.breakevenRebateBps).padStart(6)} bps`);
console.log(`\n  Veredicto: ${result.verdict}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
