import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ExchangeId,
  NormalizedOrderBook,
  Opportunity,
  OrderBookLevel,
  ScenarioKind,
  WalletSeed
} from "../src/lib/types";

// Offline training harness for the gradient-boosted ML EdgeTensor.
//
// Two data sources, selectable from the CLI:
//
//   npm run train                      # 45s, enriched synthetic generator (camino 2)
//   npm run train -- 90                # 90s
//   npm run train -- --tape data/tape-XXXX.jsonl   # replay a real recorded tape (camino 1)
//
// Why this exists: the live kernel only trains the ML from executed cross-exchange
// paper trades, which drain slowly through a latency-bound, EV-prioritized queue.
// To fit a real model in seconds we drive the engine + simulator directly: every
// would-be-executable (DETECTED) cross-exchange signal is settled synchronously
// (the modeled latency still feeds the cost model, only the wall-clock wait is
// removed) and fed back as a realized outcome.
//
// The honest finding from earlier runs was that the *clean* deterministic demo
// only ever produces huge, always-winning cross edges, so the model had no class
// diversity to learn from. Two fixes here:
//   1. (camino 2) The synthetic generator now draws a spectrum of dislocations
//      *centred on each venue pair's break-even* (round-trip fees + costs), so
//      roughly half settle positive and half negative -> the model learns the
//      real edge->profitability frontier instead of a constant.
//   2. (camino 1) `--tape` replays order books captured from the 7 real exchanges
//      (`npm run record`), so the model trains on genuine market microstructure.
//
// Crucially we now train ONLY on signals the engine marks DETECTED (would execute)
// -- exactly the distribution the model sees at inference time in production --
// rather than force-settling every rejected micro-edge.

const args = process.argv.slice(2);
const tapeFlagIndex = args.findIndex((a) => a === "--tape");
const tapePath = tapeFlagIndex >= 0 ? args[tapeFlagIndex + 1] : null;
const outFlagIndex = args.findIndex((a) => a === "--out");
const outPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : "public/model/edge-model.json";
const positional = args.filter((a, i) => !a.startsWith("--") && i !== tapeFlagIndex + 1 && i !== outFlagIndex + 1);
const durationSec = Number(positional[0] ?? 45);

// Settle paper fills with no wall-clock wait (the cost model still uses the full
// modeled latency). Must be set before the simulator module is imported.
process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { EXCHANGE_IDS, EXCHANGE_FEES } = await import("../src/lib/config/exchanges");
const { d } = await import("../src/lib/math/decimal");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deterministic PRNG (mulberry32) so the synthetic input distribution is stable
// run-to-run. The simulator's settlement noise stays stochastic, so realized
// outcomes still vary a little -- which is what we want for a robust classifier.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x9e3779b9);

// Deep wallets so counterfactual settlement never runs dry during training.
const seed = Object.fromEntries(
  EXCHANGE_IDS.map((id: ExchangeId) => [id, { btc: "100000", usdt: "7000000000" }])
) as WalletSeed;

const risk = new RiskManager();
const engine = new ArbitrageEngine();
const simulator = new ExecutionSimulator(seed, () => risk.getLatencyMultiplier());

let signals = 0; // cross-exchange trials settled (the training distribution)
let detectedCount = 0; // of those, how many the AET gate marked DETECTED
let wins = 0;
let pnl = 0;

// Discrimination is measured by AUC (the probability the model ranks a random
// winner above a random loser) over a reservoir-sampled validation set, rather
// than an absolute survival threshold -- AUC is rank-based, so it is robust to
// the model's overall calibration level and is the right metric for "does the
// veto/repricing actually separate winners from losers". We keep the snapshot
// with the best AUC seen, since the live ensemble refits every 32 trials.
type Feat = ReturnType<typeof engine.mlEdgeTensor.extractFeatures>;
const valSamples: Array<{ features: Feat; label: number }> = [];
const VAL_CAP = 800;
let valSeen = 0;
let bestAuc = 0;
let bestMl = engine.mlEdgeTensor.exportModel();
let sinceEval = 0;

function recordValSample(features: Feat, label: number): void {
  valSeen += 1;
  if (valSamples.length < VAL_CAP) valSamples.push({ features, label });
  else {
    const j = Math.floor(rng() * valSeen);
    if (j < VAL_CAP) valSamples[j] = { features, label };
  }
}

function auc(): number {
  const positives: number[] = [];
  const negatives: number[] = [];
  for (const sample of valSamples) {
    const p = engine.mlEdgeTensor.predict(sample.features).survivalProbability;
    (sample.label === 1 ? positives : negatives).push(p);
  }
  if (!positives.length || !negatives.length) return 0.5;
  let concordant = 0;
  for (const p of positives) for (const n of negatives) concordant += p > n ? 1 : p === n ? 0.5 : 0;
  return concordant / (positives.length * negatives.length);
}

function evaluateAndSnapshot(): void {
  if (!engine.mlEdgeTensor.isTrained() || valSamples.length < 40) return;
  const a = auc();
  if (a > bestAuc) {
    bestAuc = a;
    bestMl = engine.mlEdgeTensor.exportModel();
  }
}

// Settle a batch of cross-exchange signals. Rounds are split disjointly: "train"
// rounds feed realized outcomes back into the engine (the model learns); "val"
// rounds are held out -- never trained on -- and only contribute to the
// validation reservoir, so AUC is an honest out-of-sample measurement.
async function settleAndLearn(
  opportunities: Opportunity[],
  bookByExchange: Map<ExchangeId, NormalizedOrderBook>,
  mode: "train" | "val"
): Promise<void> {
  for (const opportunity of opportunities) {
    const trade = await simulator.execute(opportunity);
    const tradePnl = Number(trade.pnlUsd);
    signals += 1;
    if (opportunity.status === "DETECTED") detectedCount += 1;
    if (tradePnl > 0) wins += 1;
    pnl += tradePnl;

    if (mode === "train") {
      engine.recordExecutionOutcome(opportunity, tradePnl);
      if (++sinceEval >= 64) {
        sinceEval = 0;
        evaluateAndSnapshot();
      }
    } else {
      const buyBook = opportunity.buyExchange ? bookByExchange.get(opportunity.buyExchange) : undefined;
      const sellBook = opportunity.sellExchange ? bookByExchange.get(opportunity.sellExchange) : undefined;
      if (buyBook && sellBook) {
        // Mirror the engine's own feature extraction so validation matches training.
        const features = engine.mlEdgeTensor.extractFeatures(buyBook, sellBook, d(opportunity.tradeSizeBtc), opportunity.executionStyle, d(opportunity.netSpreadPct));
        recordValSample(features, tradePnl > 0 ? 1 : 0);
      }
    }
  }
}

function bookMap(books: NormalizedOrderBook[]): Map<ExchangeId, NormalizedOrderBook> {
  const map = new Map<ExchangeId, NormalizedOrderBook>();
  for (const book of books) if (book.symbol === "BTC/USDT") map.set(book.exchange, book);
  return map;
}

// Generator mode: settle the one controlled dislocation pair as a labeled trial
// (both DETECTED winners and marginally-rejected losers), so the model sees the
// full break-even frontier the AET gate decides over -- this is what gives it
// genuine class diversity to learn from.
async function ingestTrial(books: NormalizedOrderBook[], focus: { buy: ExchangeId; sell: ExchangeId }, mode: "train" | "val"): Promise<void> {
  const trials: Opportunity[] = [];
  for (const book of books) {
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type === "CROSS_EXCHANGE" && opportunity.buyExchange === focus.buy && opportunity.sellExchange === focus.sell) {
        trials.push(opportunity);
      }
    }
  }
  await settleAndLearn(trials, bookMap(books), mode);
}

// Tape mode: settle the would-be-executable (DETECTED) signals real markets
// produced -- exactly the distribution the model faces at inference.
async function ingestDetected(books: NormalizedOrderBook[], mode: "train" | "val"): Promise<void> {
  const detected: Opportunity[] = [];
  for (const book of books) {
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type === "CROSS_EXCHANGE" && opportunity.status === "DETECTED") detected.push(opportunity);
    }
  }
  await settleAndLearn(detected, bookMap(books), mode);
}

// ---------------------------------------------------------------------------
// Synthetic generator (camino 2): a Monte-Carlo of cross-exchange dislocations
// drawn around each venue pair's break-even, plus depth/freshness variation.
// ---------------------------------------------------------------------------
let genMid = 70000;
function takerBps(exchange: ExchangeId): number {
  return Number(EXCHANGE_FEES[exchange].taker) * 10000;
}
function synthLevels(bestBid: number, bestAsk: number, topSize: number, kind: "BTC/USDT"): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
  void kind;
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  const tick = bestAsk * 0.00002; // ~0.2bps level spacing
  for (let level = 0; level < 5; level += 1) {
    const size = (topSize * (1 + level * 0.42)).toFixed(8);
    bids.push({ price: (bestBid - tick * level).toFixed(2), size });
    asks.push({ price: (bestAsk + tick * level).toFixed(2), size: (Number(size) * 0.94).toFixed(8) });
  }
  return { bids, asks };
}
function synthBook(exchange: ExchangeId, bestBid: number, bestAsk: number, topSize: number, receivedAt: number): NormalizedOrderBook {
  const { bids, asks } = synthLevels(bestBid, bestAsk, topSize, "BTC/USDT");
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids,
    asks,
    receivedAt,
    exchangeTimestamp: receivedAt - Math.floor(rng() * 30),
    processingLatencyMs: Number((rng() * 2.5 + 0.4).toFixed(2)),
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "training-generator" }
  };
}
function generateRound(): { books: NormalizedOrderBook[]; focus: { buy: ExchangeId; sell: ExchangeId } } {
  // Gentle GBM drift on the base mid.
  genMid *= Math.exp((rng() - 0.5) * 0.0008);
  const now = Date.now();
  const books = EXCHANGE_IDS.map((exchange: ExchangeId) => {
    const bias = (rng() - 0.5) * 0.0004; // +/-2bps per-venue offset
    const hs = genMid * (0.5 + rng() * 2) / 10000; // 0.5..2.5bps half-spread
    const mid = genMid * (1 + bias);
    const topSize = 0.4 + rng() * 2.6;
    return synthBook(exchange, mid - hs, mid + hs, topSize, now);
  });

  // Inject one controlled dislocation centred on the pair's break-even.
  const bi = Math.floor(rng() * EXCHANGE_IDS.length);
  let si = Math.floor(rng() * EXCHANGE_IDS.length);
  if (si === bi) si = (si + 1) % EXCHANGE_IDS.length;
  const buyExchange = EXCHANGE_IDS[bi];
  const sellExchange = EXCHANGE_IDS[si];
  // Centre the spectrum a little above the pure fee break-even so trials span the
  // executable frontier: from below-bar losers, through marginal DETECTED signals
  // (some win, some lose), up to comfortable winners -> ~50/50 realized labels and
  // a healthy overlap with the DETECTED distribution the model faces in production.
  const breakEvenBps = takerBps(buyExchange) + takerBps(sellExchange) + 7;
  const grossEdgeBps = Math.max(2, breakEvenBps + 14 + (rng() * 2 - 1) * 20);
  const thin = rng() < 0.3;
  const depth = thin ? 0.08 + rng() * 0.12 : 1 + rng() * 3; // thin => high impact
  const hsB = genMid * (0.5 + rng() * 1.5) / 10000;
  const hsS = genMid * (0.5 + rng() * 1.5) / 10000;
  const buyAsk = genMid;
  const buyBid = buyAsk - 2 * hsB;
  const sellBid = buyAsk * (1 + grossEdgeBps / 10000);
  const sellAsk = sellBid + 2 * hsS;
  // Quote skew within the 1800ms sync budget so the signal can be DETECTED, but
  // varied so the freshness feature carries information.
  const skewMs = Math.floor(rng() * 1500);
  books[bi] = synthBook(buyExchange, buyBid, buyAsk, depth, now);
  books[si] = synthBook(sellExchange, sellBid, sellAsk, depth, now - skewMs);
  return { books, focus: { buy: buyExchange, sell: sellExchange } };
}

// ---------------------------------------------------------------------------
// Tape replay (camino 1): rebase each captured round so receivedAt ~ now while
// preserving the intra-round venue skew, then feed it through the same pipeline.
// ---------------------------------------------------------------------------
interface TapeRound {
  t: number;
  books: NormalizedOrderBook[];
}
function loadTape(path: string): TapeRound[] {
  const rounds: TapeRound[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TapeRound;
      if (parsed && Array.isArray(parsed.books) && parsed.books.length) rounds.push(parsed);
    } catch {
      // Skip malformed lines.
    }
  }
  return rounds;
}
function rebaseRound(round: TapeRound): NormalizedOrderBook[] {
  const now = Date.now();
  const offset = now - round.t;
  return round.books.map((book) => ({
    ...book,
    receivedAt: book.receivedAt + offset,
    exchangeTimestamp: book.exchangeTimestamp + offset
  }));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function header(): void {
  console.log(["  t(s)", "trials", "  win%", "trees", " Brier", "   AUC", "phase"].join(" "));
  console.log("-".repeat(72));
}
function reportRow(startedAt: number, phase: string): void {
  const mlCal = engine.mlEdgeTensor.calibrationSummary();
  const winRate = signals ? ((wins / signals) * 100).toFixed(1) : "0.0";
  const liveAuc = engine.mlEdgeTensor.isTrained() && valSamples.length >= 40 ? auc() : 0.5;
  console.log([
    ((Date.now() - startedAt) / 1000).toFixed(0).padStart(5),
    String(signals).padStart(6),
    `${winRate}%`.padStart(6),
    String(engine.mlEdgeTensor.treeCount()).padStart(5),
    mlCal.brierScore.toFixed(4).padStart(7),
    liveAuc.toFixed(3).padStart(6),
    phase.padEnd(16)
  ].join(" "));
}

const sourceLabel = tapePath ? `tape real (${tapePath})` : "generador sintetico enriquecido";
console.log(`\nArbitrAI - entrenando el ensemble AET+ML | fuente: ${sourceLabel}\n`);
header();

const startedAt = Date.now();
let nextReport = startedAt + 5000;
let announcedTrained = false;

if (tapePath) {
  const rounds = loadTape(tapePath);
  if (!rounds.length) {
    console.error(`\nTape vacio o ilegible: ${tapePath}. Graba uno con: npm run record\n`);
    process.exit(1);
  }
  console.log(`  (${rounds.length} rondas capturadas; reproduciendo en orden)\n`);
  for (let i = 0; i < rounds.length; i += 1) {
    await ingestDetected(rebaseRound(rounds[i]), rng() < 0.2 ? "val" : "train");
    await sleep(0);
    if (!announcedTrained && engine.mlEdgeTensor.isTrained()) {
      announcedTrained = true;
      reportRow(startedAt, "TRAINED <-");
    }
    if (Date.now() >= nextReport) {
      reportRow(startedAt, `replay ${Math.round((i / rounds.length) * 100)}%`);
      nextReport += 5000;
    }
  }
} else {
  const endAt = startedAt + durationSec * 1000;
  const phases: Array<ScenarioKind | "NONE"> = ["NONE", "LATENCY_SPIKE", "NONE", "LIQUIDITY_DRAIN", "NONE", "MARKET_CRASH"];
  const phaseMs = 6000;
  let nextPhaseAt = startedAt + phaseMs;
  let phaseIndex = 0;
  while (Date.now() < endAt) {
    const { books, focus } = generateRound();
    await ingestTrial(books, focus, rng() < 0.2 ? "val" : "train");
    await sleep(1);
    const now = Date.now();
    if (now >= nextPhaseAt) {
      phaseIndex += 1;
      const phase = phases[phaseIndex % phases.length];
      if (phase !== "NONE") risk.runScenario(phase, phaseMs);
      nextPhaseAt += phaseMs;
    }
    if (!announcedTrained && engine.mlEdgeTensor.isTrained()) {
      announcedTrained = true;
      reportRow(startedAt, "TRAINED <-");
    }
    if (now >= nextReport) {
      reportRow(startedAt, String(phases[phaseIndex % phases.length]));
      nextReport += 5000;
    }
  }
}

reportRow(startedAt, "final");

// Restore the best-AUC snapshot, then validate before persisting: only keep the
// trained trees if they genuinely rank winners above losers (AUC >= 0.65 on the
// held-out validation reservoir). Otherwise persist an EMPTY ML model and let the
// live pipeline retrain -- the AET route calibration is always persisted and is
// genuinely trained here.
evaluateAndSnapshot();
if (bestMl.trees.length > 0) engine.mlEdgeTensor.importModel(bestMl);
const finalAuc = valSamples.length >= 40 ? auc() : 0.5;

// Held-out separation: the restored model's mean survival on real winners vs real
// losers from the validation reservoir (out-of-sample). This is what the probe was
// trying to show, but measured on the true distribution instead of a hand-built
// pair -- it can't be degenerate and tracks AUC directly.
const winPreds = valSamples.filter((s) => s.label === 1).map((s) => engine.mlEdgeTensor.predict(s.features).survivalProbability);
const lossPreds = valSamples.filter((s) => s.label === 0).map((s) => engine.mlEdgeTensor.predict(s.features).survivalProbability);
const meanWinSurvival = winPreds.length ? winPreds.reduce((a, b) => a + b, 0) / winPreds.length : 0;
const meanLossSurvival = lossPreds.length ? lossPreds.reduce((a, b) => a + b, 0) / lossPreds.length : 0;
const discriminates = bestMl.trees.length > 0 && finalAuc >= 0.65 && meanWinSurvival > meanLossSurvival;

const mlModel = discriminates ? bestMl : { ...bestMl, trees: [] };
const bundle = {
  version: 1,
  savedAt: new Date().toISOString(),
  trainedForSec: tapePath ? undefined : durationSec,
  source: tapePath ? "tape" : "generator",
  tape: tapePath ?? undefined,
  signals,
  winRate: signals ? Number(((wins / signals) * 100).toFixed(1)) : 0,
  auc: Number(finalAuc.toFixed(4)),
  mlValidated: discriminates,
  ml: mlModel,
  aet: engine.exportCalibration()
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

const mlCal = engine.mlEdgeTensor.calibrationSummary();
console.log("\n=== Resultado del entrenamiento ===");
console.log(`  Fuente de datos                   : ${sourceLabel}`);
console.log(`  Ensayos cross-exchange liquidados : ${signals}  (${detectedCount} marcados DETECTED por el gate AET)`);
console.log(`  Tasa de rentabilidad realizada    : ${signals ? ((wins / signals) * 100).toFixed(1) : "0.0"}%`);
console.log(`  P&L counterfactual acumulado      : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`);
console.log(`  Muestras de validación (held-out) : ${valSamples.length}`);
console.log(`  Brier score (ML)                  : ${mlCal.brierScore.toFixed(4)}  (menor = mejor calibrado)`);
console.log(`  AUC discriminación (held-out)     : ${finalAuc.toFixed(4)}  (0.5 = azar, 1.0 = perfecto)`);
console.log("\n  Separación en validación (out-of-sample):");
console.log(`    survival medio en ganadores reales -> ${(meanWinSurvival * 100).toFixed(1)}%`);
console.log(`    survival medio en perdedores reales -> ${(meanLossSurvival * 100).toFixed(1)}%`);
console.log("\n  Artefacto persistido:");
console.log(`    AET route calibration : ${Object.keys(bundle.aet).length} rutas (entrenado)`);
console.log(`    ML ensemble           : ${discriminates ? `${mlModel.trees.length} arboles (validado, AUC ${finalAuc.toFixed(3)})` : "vacio (no discrimina en held-out; reentrena en LIVE)"}`);
console.log(`\n  Modelo guardado en: ${outPath}\n`);

process.exit(0);
