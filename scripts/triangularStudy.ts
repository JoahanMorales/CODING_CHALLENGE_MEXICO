import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";

// Edge hunt: single-venue TRIANGULAR arbitrage. This is the most retail-reachable
// candidate -- it pays NO cross-venue withdrawal/transfer cost and NO USDT/USD basis,
// only the venue's three taker fees. We stream the three real legs from Binance
// (lowest major fee, and it publishes all three depth5 feeds) and compute the
// gross cycle return (VWAP for a realistic size, both directions) on every update,
// then report the distribution and the break-even fee tier. Honest question: is
// there any retail edge here, and if not, at what fee tier would it appear?
//
//   npm run study:triangular           # 120s
//   npm run study:triangular -- 240

const durationSec = Number(process.argv[2] ?? 120);
const outPath = process.argv[3] ?? "public/data/triangular-study.json";
const sizeBtc = 0.1;

type Level = [number, number]; // [price, size]
interface Book { bids: Level[]; asks: Level[]; at: number }
const books: Record<string, Book | undefined> = {};

function parseLevels(v: unknown): Level[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l): Level | null => (Array.isArray(l) && l.length >= 2 ? [Number(l[0]), Number(l[1])] : null))
    .filter((l): l is Level => l !== null && Number.isFinite(l[0]) && Number.isFinite(l[1]));
}

// VWAP buy: spend to acquire `qtyBase` of the base asset walking the asks.
// Returns the average price actually paid (or null if the book is too thin).
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
// VWAP sell: sell `qtyBase` walking the bids, returns average price received.
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

// Forward cycle BTC -> USDT -> ETH -> BTC: gross return in bps (no fees).
function forwardGrossBps(btc: Book, eth: Book, ethbtc: Book): number | null {
  const btcSell = sellVwap(btc.bids, sizeBtc); // BTC -> USDT
  if (!btcSell) return null;
  const usdt = sizeBtc * btcSell;
  // buy ETH with usdt: approximate ETH qty via top ask, then VWAP it
  const ethAskTop = eth.asks[0]?.[0];
  if (!ethAskTop) return null;
  const ethQty = usdt / ethAskTop;
  const ethBuy = buyVwap(eth.asks, ethQty); // USDT -> ETH
  if (!ethBuy) return null;
  const eth2 = usdt / ethBuy;
  const ethbtcSell = sellVwap(ethbtc.bids, eth2); // ETH -> BTC
  if (!ethbtcSell) return null;
  const endBtc = eth2 * ethbtcSell;
  return (endBtc / sizeBtc - 1) * 10000;
}

// Reverse cycle BTC -> ETH -> USDT -> BTC.
function reverseGrossBps(btc: Book, eth: Book, ethbtc: Book): number | null {
  const ethbtcAskTop = ethbtc.asks[0]?.[0];
  if (!ethbtcAskTop) return null;
  const ethQty = sizeBtc / ethbtcAskTop;
  const ethBuy = buyVwap(ethbtc.asks, ethQty); // BTC -> ETH
  if (!ethBuy) return null;
  const eth2 = sizeBtc / ethBuy;
  const usdtRecv = sellVwap(eth.bids, eth2); // ETH -> USDT
  if (!usdtRecv) return null;
  const usdt = eth2 * usdtRecv;
  const btcBuy = buyVwap(btc.asks, sizeBtc); // USDT -> BTC (acquire ~sizeBtc)
  if (!btcBuy) return null;
  const endBtc = usdt / btcBuy;
  return (endBtc / sizeBtc - 1) * 10000;
}

const samples: number[] = []; // best-direction gross bps per snapshot
function snapshot(): void {
  const btc = books["BTC/USDT"];
  const eth = books["ETH/USDT"];
  const ethbtc = books["ETH/BTC"];
  if (!btc || !eth || !ethbtc) return;
  const now = Date.now();
  if (now - btc.at > 1500 || now - eth.at > 1500 || now - ethbtc.at > 1500) return; // all legs fresh
  const f = forwardGrossBps(btc, eth, ethbtc);
  const r = reverseGrossBps(btc, eth, ethbtc);
  const best = Math.max(f ?? -Infinity, r ?? -Infinity);
  if (Number.isFinite(best)) samples.push(best);
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

// Fee tiers (round-trip = 3 legs). Binance: taker 0.10%, VIP tiers down to ~0.02%
// maker, BNB-discounted taker ~0.075%. bps of round-trip cost = 3 * legFeeBps.
const tiers = [
  { name: "Taker estándar (0.10%)", legBps: 10 },
  { name: "Taker con BNB (0.075%)", legBps: 7.5 },
  { name: "VIP taker (0.04%)", legBps: 4 },
  { name: "Maker VIP (0.02%)", legBps: 2 },
  { name: "Sin fees (límite teórico)", legBps: 0 }
];

console.log(`\nArbitrAI - edge hunt: arbitraje triangular en Binance (size ${sizeBtc} BTC) por ${durationSec}s\n`);
connect();
await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));

samples.sort((a, b) => a - b);
const q = (p: number) => (samples.length ? samples[Math.floor(p * (samples.length - 1))] : 0);
const tierResults = tiers.map((tier) => {
  const cost = 3 * tier.legBps;
  const net = samples.map((g) => g - cost);
  const profitable = net.filter((n) => n > 0).length;
  return {
    tier: tier.name,
    roundTripCostBps: cost,
    profitablePct: samples.length ? Number(((profitable / samples.length) * 100).toFixed(3)) : 0,
    bestNetBps: samples.length ? Number((q(1) - cost).toFixed(2)) : 0,
    medianNetBps: samples.length ? Number((q(0.5) - cost).toFixed(2)) : 0
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  venue: "binance",
  sizeBtc,
  durationSec,
  samples: samples.length,
  grossEdgeBps: {
    min: Number(q(0).toFixed(2)),
    median: Number(q(0.5).toFixed(2)),
    p99: Number(q(0.99).toFixed(2)),
    max: Number(q(1).toFixed(2))
  },
  tiers: tierResults,
  takeaway:
    tierResults[0].profitablePct > 0
      ? `Hay edge triangular incluso a taker estándar el ${tierResults[0].profitablePct}% del tiempo.`
      : tierResults.find((t) => t.profitablePct > 0)
        ? `No hay edge a taker estándar, pero SÍ aparece a tiers de fee más bajos — la brecha es la estructura de fees, no el mercado.`
        : "Sin edge triangular ni siquiera sin fees en esta ventana: el venue arbitra su propio triángulo en milisegundos."
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log("=== Resultado: arbitraje triangular (Binance) ===");
console.log(`  Muestras            : ${result.samples} (legs frescos < 1.5s)`);
console.log(`  Edge GROSS (bps)    : min ${result.grossEdgeBps.min} · mediana ${result.grossEdgeBps.median} · p99 ${result.grossEdgeBps.p99} · max ${result.grossEdgeBps.max}`);
console.log("\n  Rentabilidad por tier de fees (round-trip = 3 patas):");
for (const t of tierResults) {
  console.log(`    ${t.tier.padEnd(28)} costo ${String(t.roundTripCostBps).padStart(4)}bps -> rentable ${String(t.profitablePct).padStart(7)}% · mejor net ${t.bestNetBps}bps`);
}
console.log(`\n  ${result.takeaway}`);
console.log(`\n  Artefacto: ${outPath}\n`);
process.exit(0);
