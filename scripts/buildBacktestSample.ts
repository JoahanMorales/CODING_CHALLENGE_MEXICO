// Builds a compact, REAL backtest sample for the interactive what-if panel.
// It streams a recorded tape and keeps every cross-venue dislocation whose gross
// spread clears a low bar (>= MIN_GROSS_BPS). Each candidate carries its raw
// gross, the venue pair's real round-trip taker fee, both books' depth-5 and each
// quote's age. That is exactly the data the client needs to re-apply the operator's
// live gates (min net edge, fee-stress, slippage tolerance, min depth, quote
// freshness, active venues) and recompute executable trades + net P&L — without
// shipping the whole multi-hundred-MB tape to the browser.
//
//   npx tsx scripts/buildBacktestSample.ts <tape.jsonl> [salida.json]

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook } from "../src/lib/types";

const tapePath = process.argv[2];
if (!tapePath) {
  console.error("Uso: npx tsx scripts/buildBacktestSample.ts <tape.jsonl> [salida.json]");
  process.exit(1);
}
const outPath = process.argv[3] ?? "public/data/backtest-tape.json";
const MIN_GROSS_BPS = 15; // keep any dislocation that could plausibly clear fees at some setting
const MAX_CANDIDATES = 4000; // cap the payload; sampled evenly if exceeded

const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const takerBps = (e: ExchangeId) => Number(EXCHANGE_FEES[e].taker) * 10000;
const depth5 = (levels: { size: string }[] | undefined) =>
  (levels ?? []).slice(0, 5).reduce((s, l) => s + Number(l.size), 0);

interface Candidate {
  round: number;
  buy: ExchangeId;
  sell: ExchangeId;
  buyAsk: number;
  sellBid: number;
  grossBps: number;
  feeBps: number;
  buyDepth5: number;
  sellDepth5: number;
  buyAgeMs: number;
  sellAgeMs: number;
}

const candidates: Candidate[] = [];
let rounds = 0;
const rl = createInterface({ input: createReadStream(tapePath), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trim();
  if (!s) continue;
  let r: { t?: number; books?: NormalizedOrderBook[] };
  try { r = JSON.parse(s); } catch { continue; }
  if (!r.books?.length) continue;
  rounds += 1;
  const t = r.t ?? Date.now();
  const bk = new Map<ExchangeId, NormalizedOrderBook>();
  for (const b of r.books) if (b.bids?.[0] && b.asks?.[0]) bk.set(b.exchange, b);
  for (const [a, ba] of bk) {
    for (const [b, bb] of bk) {
      if (a === b) continue;
      const buyAsk = Number(ba.asks[0].price);
      const sellBid = Number(bb.bids[0].price);
      if (!(buyAsk > 0 && sellBid > 0)) continue;
      const grossBps = ((sellBid - buyAsk) / buyAsk) * 10000;
      if (grossBps < MIN_GROSS_BPS) continue;
      candidates.push({
        round: rounds,
        buy: a,
        sell: b,
        buyAsk: Math.round(buyAsk * 100) / 100,
        sellBid: Math.round(sellBid * 100) / 100,
        grossBps: Math.round(grossBps * 100) / 100,
        feeBps: Math.round((takerBps(a) + takerBps(b)) * 100) / 100,
        buyDepth5: Math.round(depth5(ba.asks) * 1000) / 1000,
        sellDepth5: Math.round(depth5(bb.bids) * 1000) / 1000,
        buyAgeMs: Math.max(0, Math.round(t - ba.receivedAt)),
        sellAgeMs: Math.max(0, Math.round(t - bb.receivedAt))
      });
    }
  }
}

// Even down-sample if we blew past the cap, preserving chronological spread.
let kept = candidates;
if (candidates.length > MAX_CANDIDATES) {
  const stride = candidates.length / MAX_CANDIDATES;
  kept = Array.from({ length: MAX_CANDIDATES }, (_, i) => candidates[Math.floor(i * stride)]);
}

const payload = {
  tape: basename(tapePath),
  generatedAt: new Date().toISOString(),
  roundsScanned: rounds,
  minGrossBps: MIN_GROSS_BPS,
  candidateCount: kept.length,
  candidates: kept
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload));
console.log(
  `Muestra: ${rounds.toLocaleString()} rondas, ${candidates.length} candidatos (gross>=${MIN_GROSS_BPS}bps), guardados ${kept.length} -> ${outPath}`
);
