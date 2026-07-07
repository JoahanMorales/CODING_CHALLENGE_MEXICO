// Dump the REAL-DATA spread-reversion training set for the GPU trainer, with the
// microstructure history LIVE (feeds MlEdgeTensor.observeBook per round, like the
// live ArbitrageEngine does) so the momentum / realized-vol / imbalance-delta
// features are real instead of near-constant. Streams the tape in two passes with
// readline so it handles the full multi-hundred-MB overnight tape without loading
// it into memory, and writes a compact float32 binary (+ JSON meta) so Python
// loads it instantly instead of crawling through np.loadtxt.
//
//   npx tsx scripts/dumpReversionData.ts data/tape-XXXX.jsonl
//
// Output: scripts/gpu/data/reversion-samples.f32   (row-major float32, NF+2 cols)
//         scripts/gpu/data/reversion-meta.json      (featureKeys, numFeatures, rows, ...)

import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

const tapePath = process.argv[2];
if (!tapePath) { console.error("Uso: npx tsx scripts/dumpReversionData.ts <tape.jsonl>"); process.exit(1); }
const outBin = process.argv[3] ?? "scripts/gpu/data/reversion-samples.f32";
const outMeta = "scripts/gpu/data/reversion-meta.json";

const { MlEdgeTensor } = await import("../src/lib/services/MlEdgeTensor");
const { EXCHANGE_IDS } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

const FEATURE_KEYS = [
  "netEdgeBps", "alignment", "liquidityScore", "freshnessScore", "volatilityBps",
  "micropriceSkewBps", "orderFlowImbalance", "multiLevelOfi", "buySpreadBps", "sellSpreadBps",
  "buyDepth5", "sellDepth5", "quoteSkewMs", "ageMs", "styleTaker", "styleMaker", "styleStatArb",
  "buyImbalance", "sellImbalance", "buyMidMomentumBps", "sellMidMomentumBps", "realizedVolBps",
  "buyImbalanceDelta", "sellImbalanceDelta"
] as const;
const NF = FEATURE_KEYS.length;
const COLS = NF + 2; // features + label + round

const WINDOW = 24, LOOKAHEAD = 8, Z_ENTRY = 1.0, REVERT_FRAC = 0.4; // identical to reversionStudy

function midFromLevels(book: NormalizedOrderBook): number {
  const bid = Number(book.bids[0]?.price ?? 0);
  const ask = Number(book.asks[0]?.price ?? 0);
  return bid && ask ? (bid + ask) / 2 : 0;
}

async function* tapeRounds(): AsyncGenerator<NormalizedOrderBook[]> {
  const rl = createInterface({ input: createReadStream(tapePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { books?: NormalizedOrderBook[] };
      if (parsed && Array.isArray(parsed.books) && parsed.books.length) yield parsed.books;
    } catch { /* skip */ }
  }
}

// ---- Pass 1: build per-venue mid series (carry-forward) to find candidates ----
process.stdout.write(`\nArbitrAI · dump reversión REAL (observeBook ON, streaming) — ${tapePath}\n  pasada 1: series de spread...\n`);
const mids: Record<string, number[]> = Object.fromEntries(EXCHANGE_IDS.map((e: ExchangeId) => [e, []]));
const carryMid: Partial<Record<ExchangeId, number>> = {};
let roundCount = 0;
for await (const books of tapeRounds()) {
  for (const b of books) if (b.symbol === "BTC/USDT") carryMid[b.exchange] = midFromLevels(b);
  for (const e of EXCHANGE_IDS) mids[e].push(carryMid[e] ?? NaN);
  roundCount += 1;
}
if (roundCount < 40) { console.error(`Tape demasiado corto (${roundCount} rondas).`); process.exit(1); }

const pairs: Array<[ExchangeId, ExchangeId]> = [];
for (let i = 0; i < EXCHANGE_IDS.length; i += 1)
  for (let j = i + 1; j < EXCHANGE_IDS.length; j += 1) pairs.push([EXCHANGE_IDS[i], EXCHANGE_IDS[j]]);

// candidatesByT[t] = list of {a,b,label,netSpreadArg}
const candidatesByT = new Map<number, Array<{ a: ExchangeId; b: ExchangeId; label: number; netArg: number }>>();
let candidates = 0, reverted = 0;
for (const [a, b] of pairs) {
  const sA = mids[a], sB = mids[b];
  for (let t = 0; t < roundCount; t += 1) {
    const spread = sA[t] - sB[t];
    if (t < WINDOW || !Number.isFinite(spread) || t + LOOKAHEAD >= roundCount) continue;
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
    const label = Math.abs(future - mean) <= Math.abs(spread - mean) * (1 - REVERT_FRAC) ? 1 : 0;
    candidates += 1; reverted += label;
    const netArg = (spread - mean) / (sA[t] || 1);
    const list = candidatesByT.get(t) ?? [];
    list.push({ a, b, label, netArg });
    candidatesByT.set(t, list);
  }
}
process.stdout.write(`  candidatas=${candidates}  revirtieron=${reverted} (${(reverted / candidates * 100).toFixed(1)}%)\n  pasada 2: observeBook + features -> ${outBin}\n`);

// ---- Pass 2: replay in round order, feed observeBook, extract at candidate times ----
const model = new MlEdgeTensor();
mkdirSync(dirname(outBin), { recursive: true });
const stream = createWriteStream(outBin);
let buf = new Float32Array(COLS * 16384);
let bufPos = 0;
let written = 0;
async function flush(force = false) {
  if (bufPos === 0) return;
  if (force || bufPos >= buf.length - COLS) {
    await new Promise<void>((res) => stream.write(Buffer.from(buf.buffer, 0, bufPos * 4), () => res()));
    bufPos = 0;
  }
}

const carryBook: Partial<Record<ExchangeId, NormalizedOrderBook>> = {};
let t = 0;
for await (const books of tapeRounds()) {
  for (const b of books) if (b.symbol === "BTC/USDT") { model.observeBook(b); carryBook[b.exchange] = b; }
  const cands = candidatesByT.get(t);
  if (cands) {
    for (const c of cands) {
      const ba = carryBook[c.a], bb = carryBook[c.b];
      if (!ba || !bb) continue;
      const feat = model.extractFeatures(ba, bb, d("0.05"), "STAT_MEAN_REVERSION", d(String(c.netArg))) as unknown as Record<string, number>;
      for (let j = 0; j < NF; j += 1) buf[bufPos + j] = feat[FEATURE_KEYS[j]] ?? 0;
      buf[bufPos + NF] = c.label;
      buf[bufPos + NF + 1] = t;
      bufPos += COLS; written += 1;
      await flush();
    }
  }
  t += 1;
}
await flush(true);
await new Promise<void>((res) => stream.end(res));

writeFileSync(outMeta, JSON.stringify({
  featureKeys: FEATURE_KEYS, numFeatures: NF, cols: COLS, format: "float32", rows: written,
  tape: tapePath, rounds: roundCount, candidates, reverted,
  baseRatePct: Number((candidates ? (reverted / candidates) * 100 : 0).toFixed(1)),
  observeBook: true, params: { window: WINDOW, lookahead: LOOKAHEAD, zEntry: Z_ENTRY, revertFraction: REVERT_FRAC }
}, null, 2));
process.stdout.write(`  hecho: ${written} filas (${COLS} cols float32)  meta -> ${outMeta}\n\n`);
process.exit(0);
