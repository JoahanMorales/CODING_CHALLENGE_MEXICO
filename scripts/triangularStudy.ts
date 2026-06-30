import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import { avellanedaStoikovMakerFraction } from "../src/lib/services/ArbitrageEngine";

// Edge hunt: single-venue TRIANGULAR arbitrage. This is the most retail-reachable
// candidate -- it pays NO cross-venue withdrawal/transfer cost and NO USDT/USD basis,
// only the venue's three fees. We stream the three real legs from Binance and run
// TWO analyses on every update:
//
//  1) TAKER (cross the spread, VWAP, across a size sweep) against real retail fee
//     tiers -- the straightforward "does the visible spread clear costs" question.
//  2) MAKER (post inside the spread using the same Avellaneda-Stoikov fraction the
//     production engine uses for cross-exchange, so the model is consistent app-
//     wide) with a fill-probability x leg-risk expected-value model, because a
//     maker rebate can ONLY be earned by providing liquidity, never by taking it --
//     applying a rebate on top of taker VWAP economics (an earlier version of this
//     study did) is methodologically inconsistent and overstates the case. The
//     maker EV correctly prices the leg risk of NOT getting filled on all 3 legs.
//
//   npm run study:triangular           # 120s
//   npm run study:triangular -- 240
//
// Maker rebate source: OKX spot VIP8 maker fee is -0.005% (a real rebate) --
// https://www.okx.com/en-us/fees -- reached only above ~$12M/30d volume or large
// OKB holdings (institutional, not retail-reachable; included as the best-case
// published bound, clearly labelled, never blended with taker economics).

const durationSec = Number(process.argv[2] ?? 120);
const outPath = process.argv[3] ?? "public/data/triangular-study.json";
const SIZES_BTC = [0.01, 0.05, 0.1, 0.5, 1.0];
const headlineSize = 0.1;
const makerClipBtc = 0.02; // realistic resting size for a retail maker quote

type Level = [number, number]; // [price, size]
interface Book { bids: Level[]; asks: Level[]; at: number }
const books: Record<string, Book | undefined> = {};

function parseLevels(v: unknown): Level[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l): Level | null => (Array.isArray(l) && l.length >= 2 ? [Number(l[0]), Number(l[1])] : null))
    .filter((l): l is Level => l !== null && Number.isFinite(l[0]) && Number.isFinite(l[1]));
}

// --- Taker (VWAP, crosses the spread) ---
function buyVwap(asks: Level[], qtyBase: number): number | null {
  let remaining = qtyBase;
  let cost = 0;
  for (const [price, size] of asks) {
    const fill = Math.min(remaining, size);
    cost += fill * price;
    remaining -= fill;
    if (remaining <= 1e-12) return cost / qtyBase;
  }
  return null;
}
function sellVwap(bids: Level[], qtyBase: number): number | null {
  let remaining = qtyBase;
  let proceeds = 0;
  for (const [price, size] of bids) {
    const fill = Math.min(remaining, size);
    proceeds += fill * price;
    remaining -= fill;
    if (remaining <= 1e-12) return proceeds / qtyBase;
  }
  return null;
}
function forwardGrossBps(btc: Book, eth: Book, ethbtc: Book, sizeBtc: number): number | null {
  const btcSell = sellVwap(btc.bids, sizeBtc);
  if (!btcSell) return null;
  const usdt = sizeBtc * btcSell;
  const ethAskTop = eth.asks[0]?.[0];
  if (!ethAskTop) return null;
  const ethQty = usdt / ethAskTop;
  const ethBuy = buyVwap(eth.asks, ethQty);
  if (!ethBuy) return null;
  const eth2 = usdt / ethBuy;
  const ethbtcSell = sellVwap(ethbtc.bids, eth2);
  if (!ethbtcSell) return null;
  const endBtc = eth2 * ethbtcSell;
  return (endBtc / sizeBtc - 1) * 10000;
}
function reverseGrossBps(btc: Book, eth: Book, ethbtc: Book, sizeBtc: number): number | null {
  const ethbtcAskTop = ethbtc.asks[0]?.[0];
  if (!ethbtcAskTop) return null;
  const ethQty = sizeBtc / ethbtcAskTop;
  const ethBuy = buyVwap(ethbtc.asks, ethQty);
  if (!ethBuy) return null;
  const eth2 = sizeBtc / ethBuy;
  const usdtRecv = sellVwap(eth.bids, eth2);
  if (!usdtRecv) return null;
  const usdt = eth2 * usdtRecv;
  const btcBuy = buyVwap(btc.asks, sizeBtc);
  if (!btcBuy) return null;
  const endBtc = usdt / btcBuy;
  return (endBtc / sizeBtc - 1) * 10000;
}

// --- Maker (posts inside the spread; same A-S fraction as production cross-exchange) ---
interface LegQuote { makerBuy: number; makerSell: number; fillProb: number; spreadBps: number }
function legQuote(book: Book, qtyBase: number): LegQuote | null {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask || !(ask[0] > bid[0])) return null;
  const [bidPx, bidSz] = bid;
  const [askPx, askSz] = ask;
  const spreadBps = ((askPx - bidPx) / askPx) * 10000;
  const bidDepth = book.bids.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
  const askDepth = book.asks.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
  const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const frac = avellanedaStoikovMakerFraction(spreadBps, bidDepth + askDepth, imbalance);
  const makerBuy = askPx - (askPx - bidPx) * frac;
  const makerSell = bidPx + (askPx - bidPx) * frac;
  // Single-book adaptation of the engine's estimateMakerFillProbability formula.
  const depthScore = Math.min(1, (bidSz + askSz) / Math.max(qtyBase * 6, 1e-9));
  const spreadScore = Math.max(0, 1 - spreadBps / 6);
  const fillProb = Math.max(0.18, Math.min(0.82, 0.28 + depthScore * 0.34 + spreadScore * 0.2));
  return { makerBuy, makerSell, fillProb, spreadBps };
}
interface MakerCycle { grossBps: number; pAll3: number; unwindCostBps: number }
function makerCycle(btcQ: LegQuote, ethQ: LegQuote, ethbtcQ: LegQuote): MakerCycle {
  // Forward maker: sell BTC@makerSell, buy ETH@makerBuy, sell ETH(as BTC)@makerSell.
  const fwdUsdt = makerClipBtc * btcQ.makerSell;
  const fwdEth = fwdUsdt / ethQ.makerBuy;
  const fwdEndBtc = fwdEth * ethbtcQ.makerSell;
  const fwdGross = (fwdEndBtc / makerClipBtc - 1) * 10000;
  // Reverse maker: buy ETH-with-BTC@makerBuy, sell ETH(USDT)@makerSell, buy BTC@makerBuy.
  const revEth = makerClipBtc / ethbtcQ.makerBuy;
  const revUsdt = revEth * ethQ.makerSell;
  const revEndBtc = revUsdt / btcQ.makerBuy;
  const revGross = (revEndBtc / makerClipBtc - 1) * 10000;
  const grossBps = Math.max(fwdGross, revGross);
  const pAll3 = btcQ.fillProb * ethQ.fillProb * ethbtcQ.fillProb;
  const unwindCostBps = (btcQ.spreadBps + ethQ.spreadBps + ethbtcQ.spreadBps) / 3 / 2;
  return { grossBps, pAll3, unwindCostBps };
}

const samplesBySize: Record<number, number[]> = Object.fromEntries(SIZES_BTC.map((s) => [s, []]));
const makerSamples: MakerCycle[] = [];

function snapshot(): void {
  const btc = books["BTC/USDT"];
  const eth = books["ETH/USDT"];
  const ethbtc = books["ETH/BTC"];
  if (!btc || !eth || !ethbtc) return;
  const now = Date.now();
  if (now - btc.at > 1500 || now - eth.at > 1500 || now - ethbtc.at > 1500) return;
  for (const size of SIZES_BTC) {
    const f = forwardGrossBps(btc, eth, ethbtc, size);
    const r = reverseGrossBps(btc, eth, ethbtc, size);
    const best = Math.max(f ?? -Infinity, r ?? -Infinity);
    if (Number.isFinite(best)) samplesBySize[size].push(best);
  }
  const btcQ = legQuote(btc, makerClipBtc);
  const ethQ = legQuote(eth, (makerClipBtc * btc.bids[0][0]) / eth.bids[0][0]);
  const ethbtcQ = legQuote(ethbtc, makerClipBtc / ethbtc.bids[0][0]);
  if (btcQ && ethQ && ethbtcQ) makerSamples.push(makerCycle(btcQ, ethQ, ethbtcQ));
}

function connect(): void {
  const url = "wss://stream.binance.com:9443/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms/ethbtc@depth5@100ms";
  const socket = new WebSocket(url);
  socket.on("message", (payload) => {
    try {
      const parsed = JSON.parse(payload.toString()) as { stream?: string; data?: { bids?: unknown; asks?: unknown } };
      const stream = parsed.stream ?? "";
      const data = parsed.data;
      if (!data) return;
      const symbol = stream.startsWith("btcusdt") ? "BTC/USDT" : stream.startsWith("ethusdt") ? "ETH/USDT" : stream.startsWith("ethbtc") ? "ETH/BTC" : null;
      if (!symbol) return;
      books[symbol] = { bids: parseLevels(data.bids), asks: parseLevels(data.asks), at: Date.now() };
      snapshot();
    } catch {
      /* skip */
    }
  });
  socket.on("close", () => setTimeout(connect, 1500));
  socket.on("error", () => socket.close());
}

// Taker fee tiers (round-trip = 3 legs). All non-negative: taking liquidity never
// earns a rebate, only pays a fee -- so no rebate tier belongs here.
const takerTiers = [
  { name: "Taker estándar (0.10%)", legBps: 10, retailReachable: true },
  { name: "Taker con BNB (0.075%)", legBps: 7.5, retailReachable: true },
  { name: "VIP taker (0.04%)", legBps: 4, retailReachable: false }
];

console.log(`\nArbitrAI - edge hunt: arbitraje triangular en Binance (taker VWAP + maker EV) por ${durationSec}s\n`);
connect();
await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));

function quantileOf(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : 0;
}

const sizeSweep = SIZES_BTC.map((size) => {
  const arr = samplesBySize[size];
  return {
    sizeBtc: size,
    samples: arr.length,
    medianGrossBps: Number(quantileOf(arr, 0.5).toFixed(2)),
    p99GrossBps: Number(quantileOf(arr, 0.99).toFixed(2)),
    maxGrossBps: Number(quantileOf(arr, 1).toFixed(2))
  };
});

const headline = samplesBySize[headlineSize];
const q = (p: number) => quantileOf(headline, p);
const takerTierResults = takerTiers.map((tier) => {
  const cost = 3 * tier.legBps;
  const net = headline.map((g) => g - cost);
  const profitable = net.filter((n) => n > 0).length;
  return {
    tier: tier.name,
    retailReachable: tier.retailReachable,
    roundTripCostBps: Number(cost.toFixed(2)),
    profitablePct: headline.length ? Number(((profitable / headline.length) * 100).toFixed(3)) : 0,
    bestNetBps: headline.length ? Number((q(1) - cost).toFixed(2)) : 0,
    medianNetBps: headline.length ? Number((q(0.5) - cost).toFixed(2)) : 0
  };
});
const anyTakerProfitable = takerTierResults.some((t) => t.profitablePct > 0);

// --- Maker EV: P(all 3 legs fill) x (gross + fee) - P(not all fill) x unwind cost. ---
const makerGross = makerSamples.map((m) => m.grossBps);
const observedPAll3Avg = makerSamples.length ? makerSamples.reduce((s, m) => s + m.pAll3, 0) / makerSamples.length : 0;
function makerEv(feeBpsPerLeg: number, pAll3Override?: number): { meanEvBps: number; profitablePct: number } {
  const evs = makerSamples.map((m) => {
    const p = pAll3Override ?? m.pAll3;
    return p * (m.grossBps + 3 * feeBpsPerLeg) - (1 - p) * m.unwindCostBps;
  });
  const mean = evs.length ? evs.reduce((s, e) => s + e, 0) / evs.length : 0;
  const profitable = evs.length ? (evs.filter((e) => e > 0).length / evs.length) * 100 : 0;
  return { meanEvBps: Number(mean.toFixed(3)), profitablePct: Number(profitable.toFixed(2)) };
}

const retailMakerFeeBpsPerLeg = -10; // retail PAYS 0.10% maker (Binance has no retail maker discount vs taker)
const okxRebateBpsPerLeg = 0.5; // OKX VIP8 spot maker rebate (institutional-only)

const makerEvScenarios = {
  observado: {
    description: "Probabilidad de fill estimada de la microestructura real (spread/profundidad por pata)",
    pAll3Avg: Number(observedPAll3Avg.toFixed(4)),
    retail: makerEv(retailMakerFeeBpsPerLeg),
    okxVip8Rebate: makerEv(okxRebateBpsPerLeg)
  },
  sensibilidad: [0.9, 0.7, 0.5, 0.3].map((p) => ({
    fillProbPerLeg: p,
    pAll3: Number((p * p * p).toFixed(4)),
    retail: makerEv(retailMakerFeeBpsPerLeg, p * p * p),
    okxVip8Rebate: makerEv(okxRebateBpsPerLeg, p * p * p)
  }))
};
const anyMakerProfitable = makerEvScenarios.observado.okxVip8Rebate.meanEvBps > 0
  || makerEvScenarios.sensibilidad.some((s) => s.okxVip8Rebate.meanEvBps > 0);

const result = {
  generatedAt: new Date().toISOString(),
  venue: "binance",
  headlineSizeBtc: headlineSize,
  makerClipBtc,
  durationSec,
  samples: headline.length,
  grossEdgeBps: {
    min: Number(q(0).toFixed(2)),
    median: Number(q(0.5).toFixed(2)),
    p99: Number(q(0.99).toFixed(2)),
    max: Number(q(1).toFixed(2))
  },
  sizeSweep,
  taker: { tiers: takerTierResults, anyProfitable: anyTakerProfitable },
  maker: {
    makerGrossBps: {
      median: Number(quantileOf(makerGross, 0.5).toFixed(2)),
      p99: Number(quantileOf(makerGross, 0.99).toFixed(2)),
      max: Number(quantileOf(makerGross, 1).toFixed(2))
    },
    evScenarios: makerEvScenarios,
    anyProfitable: anyMakerProfitable
  },
  takeaway: anyTakerProfitable
    ? "Edge taker encontrado -- revisar taker.tiers."
    : makerEvScenarios.observado.okxVip8Rebate.meanEvBps > 0
      ? `Hallazgo: cotizar como maker (capturar el spread en vez de pagarlo) sube el edge bruto de ${q(0.5).toFixed(2)}bps mediana (taker) a ${quantileOf(makerGross, 0.5).toFixed(2)}bps (maker) -- pero exige llenar las 3 patas a la vez. Con la probabilidad de fill real observada (${(observedPAll3Avg * 100).toFixed(1)}%), el EV a fee RETAIL es fuertemente negativo (${makerEvScenarios.observado.retail.meanEvBps}bps): el riesgo de pata domina. Solo bajo el único rebate spot real publicado (OKX VIP8, institucional, ~$12M/mes de volumen) el EV se vuelve marginalmente positivo (+${makerEvScenarios.observado.okxVip8Rebate.meanEvBps}bps) -- y es frágil: cae negativo en escenarios de fill más conservadores (ver sensibilidad). Conclusión: el edge triangular, si existe, es exclusivo de market makers institucionales con rebates y volumen masivo que amortiza el riesgo de pata sobre miles de intentos simultáneos -- no es alcanzable para un trader retail.`
      : `Sin edge alcanzable en ningún modelo. Taker: arbitrado a nivel de microsegundos (mediana ${q(0.5).toFixed(1)}bps). Maker con probabilidad de fill real de la microestructura (${(observedPAll3Avg * 100).toFixed(1)}% de llenar las 3 patas): EV esperado ${makerEvScenarios.observado.retail.meanEvBps}bps a fee retail, ${makerEvScenarios.observado.okxVip8Rebate.meanEvBps}bps incluso con el único rebate real publicado (institucional). El riesgo de pata (no llenar las 3 patas a la vez) domina cualquier ganancia de spread.`
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log("=== Resultado: arbitraje triangular (Binance) ===");
console.log(`  Muestras taker (size ${headlineSize} BTC) : ${result.samples}  ·  muestras maker: ${makerSamples.length}`);
console.log(`  Edge GROSS taker (bps)  : min ${result.grossEdgeBps.min} · mediana ${result.grossEdgeBps.median} · p99 ${result.grossEdgeBps.p99} · max ${result.grossEdgeBps.max}`);
console.log(`  Edge GROSS maker (bps)  : mediana ${result.maker.makerGrossBps.median} · p99 ${result.maker.makerGrossBps.p99} · max ${result.maker.makerGrossBps.max}`);
console.log("\n  Sensibilidad al tamaño (taker, gross bps):");
for (const s of sizeSweep) console.log(`    ${String(s.sizeBtc).padStart(5)} BTC  mediana ${String(s.medianGrossBps).padStart(7)}  p99 ${String(s.p99GrossBps).padStart(7)}`);
console.log("\n  Taker por tier de fees:");
for (const t of takerTierResults) console.log(`    ${t.tier.padEnd(28)} costo ${String(t.roundTripCostBps).padStart(5)}bps -> rentable ${String(t.profitablePct).padStart(7)}%`);
console.log(`\n  Maker EV (P(3 patas llenan) x ganancia - P(parcial) x costo de deshacer):`);
console.log(`    Observado (P3patas=${(observedPAll3Avg * 100).toFixed(1)}%): retail ${makerEvScenarios.observado.retail.meanEvBps}bps · OKX VIP8 rebate ${makerEvScenarios.observado.okxVip8Rebate.meanEvBps}bps`);
for (const s of makerEvScenarios.sensibilidad) console.log(`    P/pata=${s.fillProbPerLeg} (P3=${(s.pAll3 * 100).toFixed(1)}%): retail ${s.retail.meanEvBps}bps · OKX rebate ${s.okxVip8Rebate.meanEvBps}bps`);
console.log(`\n  ${result.takeaway}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
