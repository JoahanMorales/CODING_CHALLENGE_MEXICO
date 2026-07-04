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
const seedFlagIndex = args.findIndex((a) => a === "--seed");
const opOutFlagIndex = args.findIndex((a) => a === "--opOut");
const splitFlagIndex = args.findIndex((a) => a === "--split");
const evalTapeFlagIndex = args.findIndex((a) => a === "--evalTape");
// Generator mode writes the committed demo warm-start; tape mode (real, often
// all-losing data) writes a separate artifact so it never clobbers the demo.
const outPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : tapePath ? "data/tape-model.json" : "public/model/edge-model.json";
const rngSeed = seedFlagIndex >= 0 ? Number(args[seedFlagIndex + 1]) : 0x9e3779b9;
// Optional operating-point artifact: calibration + threshold sweep over the
// held-out fold, written for /resultados when the flag is present.
const opOutPath = opOutFlagIndex >= 0 ? args[opOutFlagIndex + 1] : null;
// Held-out split strategy for tape mode. "random" interleaves val rounds
// (default, maximum sample diversity); "temporal" holds out the LAST 20% of
// rounds chronologically -- the walk-forward test: the model never sees any
// data from the future segment it is judged on, and the calibration fold
// strictly precedes the evaluation fold inside that segment too.
const splitMode: "random" | "temporal" = splitFlagIndex >= 0 && args[splitFlagIndex + 1] === "temporal" ? "temporal" : "random";
// Optional second tape settled AFTER training with the frozen model: a pure
// cross-regime transfer test (e.g. train overnight, evaluate daytime).
const evalTapePath = evalTapeFlagIndex >= 0 ? args[evalTapeFlagIndex + 1] : null;
// Feature-bagging experiment knobs (see MlEdgeTensor.configureBoosting). Unset =
// the committed deterministic fit. --colsample <0..1> forces column subsampling
// per tree; --stopRmse / --minTrees / --maxTrees let the fit grow deeper so the
// bagged features actually get rounds to be chosen.
const colsampleFlagIndex = args.findIndex((a) => a === "--colsample");
const stopRmseFlagIndex = args.findIndex((a) => a === "--stopRmse");
const minTreesFlagIndex = args.findIndex((a) => a === "--minTrees");
const maxTreesFlagIndex = args.findIndex((a) => a === "--maxTrees");
const colsample = colsampleFlagIndex >= 0 ? Number(args[colsampleFlagIndex + 1]) : null;
const stopRmseArg = stopRmseFlagIndex >= 0 ? Number(args[stopRmseFlagIndex + 1]) : null;
const minTreesArg = minTreesFlagIndex >= 0 ? Number(args[minTreesFlagIndex + 1]) : null;
const maxTreesArg = maxTreesFlagIndex >= 0 ? Number(args[maxTreesFlagIndex + 1]) : null;
// Optional: persist the held-out op-reservoir records (features + label + pnl)
// as JSONL so model experiments (bagging, calibration, ...) can be re-run in
// seconds off the dump instead of replaying the whole tape again.
const dumpRecordsFlagIndex = args.findIndex((a) => a === "--dumpRecords");
const dumpRecordsPath = dumpRecordsFlagIndex >= 0 ? args[dumpRecordsFlagIndex + 1] : null;
const flagValueIndices = new Set<number>();
if (tapeFlagIndex >= 0) flagValueIndices.add(tapeFlagIndex + 1);
if (outFlagIndex >= 0) flagValueIndices.add(outFlagIndex + 1);
if (seedFlagIndex >= 0) flagValueIndices.add(seedFlagIndex + 1);
if (opOutFlagIndex >= 0) flagValueIndices.add(opOutFlagIndex + 1);
if (splitFlagIndex >= 0) flagValueIndices.add(splitFlagIndex + 1);
if (evalTapeFlagIndex >= 0) flagValueIndices.add(evalTapeFlagIndex + 1);
if (colsampleFlagIndex >= 0) flagValueIndices.add(colsampleFlagIndex + 1);
if (stopRmseFlagIndex >= 0) flagValueIndices.add(stopRmseFlagIndex + 1);
if (minTreesFlagIndex >= 0) flagValueIndices.add(minTreesFlagIndex + 1);
if (maxTreesFlagIndex >= 0) flagValueIndices.add(maxTreesFlagIndex + 1);
if (dumpRecordsFlagIndex >= 0) flagValueIndices.add(dumpRecordsFlagIndex + 1);
const positional = args.filter((a, i) => !a.startsWith("--") && !flagValueIndices.has(i));
const durationSec = Number(positional[0] ?? 45);

// Settle paper fills with no wall-clock wait (the cost model still uses the full
// modeled latency). Must be set before the simulator module is imported.
process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { fitPlattScaling, fitIsotonicCalibration, interpolateIsotonic } = await import("../src/lib/services/MlEdgeTensor");
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
const rng = mulberry32(rngSeed);

// Deep wallets so counterfactual settlement never runs dry during training.
const seed = Object.fromEntries(
  EXCHANGE_IDS.map((id: ExchangeId) => [id, { btc: "100000", usdt: "7000000000" }])
) as WalletSeed;

const risk = new RiskManager();
const engine = new ArbitrageEngine();
// Feature-bagging experiment: only touches the fit when a knob is passed.
if (colsample !== null || stopRmseArg !== null || minTreesArg !== null || maxTreesArg !== null) {
  engine.mlEdgeTensor.configureBoosting({
    ...(colsample !== null && Number.isFinite(colsample) ? { featureSampleRatio: colsample } : {}),
    ...(stopRmseArg !== null && Number.isFinite(stopRmseArg) ? { stopRmse: stopRmseArg } : {}),
    ...(minTreesArg !== null && Number.isFinite(minTreesArg) ? { minStopTrees: minTreesArg } : {}),
    ...(maxTreesArg !== null && Number.isFinite(maxTreesArg) ? { maxTrees: maxTreesArg } : {}),
    seed: rngSeed
  });
  console.log(`[bagging] colsample=${colsample ?? "-"} stopRmse=${stopRmseArg ?? "-"} minTrees=${minTreesArg ?? "-"} maxTrees=${maxTreesArg ?? "-"}`);
}
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

// A second, much larger held-out reservoir that also keeps the realized P&L and
// gate status per trial. It feeds the post-training calibration fit and the
// operating-point sweep ("is there ANY survival threshold whose selected trades
// have positive counterfactual P&L out-of-sample?"). Kept separate from the
// 800-sample reservoir above because that one is re-scored every 64 trials for
// the snapshot gate (pairwise AUC would be too slow at this size).
//
// Sampling strategy depends on the split: random split uses reservoir sampling
// (uniform over all val trials); temporal split uses stride sampling instead,
// because it must PRESERVE CHRONOLOGICAL ORDER so the calibration fold can be
// the strictly-earlier half of the held-out segment (reservoir sampling would
// scramble time and leak future data into the calibrator).
interface OpRecord { features: Feat; label: number; pnlUsd: number; detected: boolean }
const opRecords: OpRecord[] = [];
const OP_CAP = 30000;
const TEMPORAL_STRIDE = 5;
let opSeen = 0;

function recordOpSample(record: OpRecord): void {
  opSeen += 1;
  if (splitMode === "temporal") {
    if (opSeen % TEMPORAL_STRIDE === 0) opRecords.push(record);
    return;
  }
  if (opRecords.length < OP_CAP) opRecords.push(record);
  else {
    const j = Math.floor(rng() * opSeen);
    if (j < OP_CAP) opRecords[j] = record;
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

// Demo-safety guard: the worst ML survival the *current* model assigns to a set
// of clearly-profitable demo-shaped winners (the big fragmentation pulse down to
// a modest edge). A model that drops any of these below the veto floor would
// wrongly reject the demo's genuine winners, so we only ever snapshot a model
// that keeps them comfortably above it -- this is what makes the shipped warm-
// start robust to the synthetic->demo distribution shift.
function demoMinWinnerSurvival(): number {
  let min = 1;
  // Net edges spanning the demo's real DETECTED winners (~12-30bps) down to a
  // modest one. A safe model keeps all of them above the 0.30 veto floor.
  for (const netBps of [30, 22, 16, 12]) {
    const gapUsd = (netBps + 20) / 10000 * 70000; // add ~20bps fees to recover the gross gap
    const buy = demoShapedBook("binance", 70000 - gapUsd / 2, spreadOf(0), sizeOf(0), Date.now());
    const sell = demoShapedBook("bybit", 70000 + gapUsd / 2, spreadOf(4), sizeOf(4), Date.now());
    const features = engine.mlEdgeTensor.extractFeatures(buy, sell, d("0.05"), "INSTANT_TAKER", d(String(netBps / 10000)));
    min = Math.min(min, engine.mlEdgeTensor.predict(features).survivalProbability);
  }
  return min;
}

function evaluateAndSnapshot(): void {
  if (!engine.mlEdgeTensor.isTrained() || valSamples.length < 40) return;
  const a = auc();
  // Only accept a snapshot that both ranks well (AUC) and is demo-safe.
  if (a > bestAuc && demoMinWinnerSurvival() > 0.45) {
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
        // Mirror the engine's own feature extraction so validation matches training
        // and inference (netSpreadPct is in percent units -> divide by 100).
        const features = engine.mlEdgeTensor.extractFeatures(buyBook, sellBook, d(opportunity.tradeSizeBtc), opportunity.executionStyle, d(opportunity.netSpreadPct).div(100));
        recordValSample(features, tradePnl > 0 ? 1 : 0);
        recordOpSample({ features, label: tradePnl > 0 ? 1 : 0, pnlUsd: tradePnl, detected: opportunity.status === "DETECTED" });
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

// Tape mode: settle every real cross-exchange candidate (any status) the books
// produced and label by realized outcome. Efficient real markets reject ~all of
// them at retail fees, so this both calibrates the AET on real outcomes and
// honestly reveals how much (or how little) genuine cross-exchange edge exists.
async function ingestCandidates(books: NormalizedOrderBook[], mode: "train" | "val"): Promise<void> {
  const candidates: Opportunity[] = [];
  for (const book of books) {
    for (const opportunity of engine.onOrderBook(book)) {
      if (opportunity.type === "CROSS_EXCHANGE") candidates.push(opportunity);
    }
  }
  await settleAndLearn(candidates, bookMap(books), mode);
}

// ---------------------------------------------------------------------------
// Synthetic generator (camino 2). Critically, the books are built with the SAME
// structure as the live demo's MarketDataService (per-venue spread/size formula,
// 5 levels, ask size * 0.92) so the trained model transfers to the distribution
// it will actually serve -- a model trained on differently-shaped books wrongly
// vetoes the demo's genuine winners (distribution shift). The only thing we vary
// is the cross-exchange dislocation: its magnitude is drawn around each pair's
// break-even, with depth (impact) and quote-skew (freshness) variation, so the
// realized labels split ~50/50 and the model learns the edge->profit frontier.
// ---------------------------------------------------------------------------
let genMid = 70000;
function takerBps(exchange: ExchangeId): number {
  return Number(EXCHANGE_FEES[exchange].taker) * 10000;
}
// Per-venue spread/size match the demo's index-based formula (MarketDataService).
const spreadOf = (index: number) => 1.2 + index * 0.35;
const sizeOf = (index: number) => 0.72 + index * 0.11;
// Mirrors MarketDataService.makeBook (BTC/USDT): step = spread*(level+0.5),
// size = topSize*(1+level*0.42), ask size * 0.92.
function demoShapedBook(exchange: ExchangeId, mid: number, spread: number, topSize: number, receivedAt: number): NormalizedOrderBook {
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let level = 0; level < 5; level += 1) {
    const step = spread * (level + 0.5);
    const size = topSize * (1 + level * 0.42);
    bids.push({ price: (mid - step).toFixed(2), size: size.toFixed(8) });
    asks.push({ price: (mid + step).toFixed(2), size: (size * 0.92).toFixed(8) });
  }
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
    exchangeTimestamp: receivedAt - Math.floor(rng() * 35),
    processingLatencyMs: Number((rng() * 2.7 + 0.4).toFixed(2)),
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "training-generator" }
  };
}
function generateRound(): { books: NormalizedOrderBook[]; focus: { buy: ExchangeId; sell: ExchangeId } } {
  // Gentle GBM drift on the base mid.
  genMid *= Math.exp((rng() - 0.5) * 0.0008);
  const now = Date.now();
  const books = EXCHANGE_IDS.map((exchange: ExchangeId, index: number) => {
    const bias = (rng() - 0.5) * 24; // +/-12 USD smooth-ish per-venue offset
    return demoShapedBook(exchange, genMid + bias, spreadOf(index), sizeOf(index), now);
  });

  // Inject one controlled dislocation drawn around the pair's break-even.
  const bi = Math.floor(rng() * EXCHANGE_IDS.length);
  let si = Math.floor(rng() * EXCHANGE_IDS.length);
  if (si === bi) si = (si + 1) % EXCHANGE_IDS.length;
  const buyExchange = EXCHANGE_IDS[bi];
  const sellExchange = EXCHANGE_IDS[si];
  // Centre the spectrum a little above the pure fee break-even so trials span the
  // executable frontier: from below-bar losers, through marginal DETECTED signals
  // (some win, some lose), up to comfortable winners -> ~50/50 realized labels.
  // Draw the NET edge (after the pair's round-trip fees) directly, on the same
  // bps scale as the demo's real winners, then add fees back to get the gross
  // dislocation. Targeting NET rather than gross-above-break-even is what makes
  // the model's learned threshold transfer across venue pairs (a high-fee pair
  // like Coinbase otherwise needs a huge gross edge, which would push the learned
  // win threshold far above the demo's modest edges and wrongly veto them).
  const roundTripFeesBps = takerBps(buyExchange) + takerBps(sellExchange);
  const strong = rng() < 0.2;
  const netTargetBps = strong ? 45 + rng() * 30 : -12 + rng() * 34; // bulk ~[-12,+22], tail [45,75]
  const grossEdgeBps = Math.max(2, netTargetBps + roundTripFeesBps + 8); // +8bps for the other costs the engine models
  const thin = !strong && rng() < 0.3;
  // The dislocation lowers the buy venue and raises the sell venue around genMid
  // so that sellBid - buyAsk == grossEdge. step0 = spread*0.5 is the top-level
  // offset for each book, matching the demo's shape.
  const step0Buy = spreadOf(bi) * 0.5;
  const step0Sell = spreadOf(si) * 0.5;
  const target = genMid * grossEdgeBps / 10000;
  const x = (target + step0Buy + step0Sell) / 2;
  const sizeBuy = thin ? sizeOf(bi) * 0.1 : sizeOf(bi);
  const sizeSell = thin ? sizeOf(si) * 0.1 : sizeOf(si);
  // Quote skew within the 1800ms sync budget so the signal can be DETECTED, but
  // varied so the freshness feature carries information.
  const skewMs = Math.floor(rng() * 1500);
  books[bi] = demoShapedBook(buyExchange, genMid - x, spreadOf(bi), sizeBuy, now);
  books[si] = demoShapedBook(sellExchange, genMid + x, spreadOf(si), sizeSell, now - skewMs);
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
console.log(`\nArbitrAI - entrenando el ensemble AET+ML | fuente: ${sourceLabel} | seed: ${rngSeed}\n`);
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
  console.log(`  (${rounds.length} rondas capturadas; reproduciendo en orden; split ${splitMode})\n`);
  const temporalValStart = Math.floor(rounds.length * 0.8);
  for (let i = 0; i < rounds.length; i += 1) {
    const mode = splitMode === "temporal" ? (i >= temporalValStart ? "val" : "train") : rng() < 0.2 ? "val" : "train";
    await ingestCandidates(rebaseRound(rounds[i]), mode);
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

// ---------------------------------------------------------------------------
// Calibration + operating-point sweep over the large held-out reservoir.
// The reservoir is split into two disjoint halves: "calib" fits the candidate
// calibration maps (Platt 1999 AND isotonic/PAV, Zadrozny-Elkan 2002) for the
// restored best-AUC ensemble; "eval" is never touched by any fit and decides
// which calibrator (if any) ships, reports Brier before/after, and hosts the
// threshold sweep -- so both the calibration benefit and the operating-point
// P&L are honest out-of-sample measurements. Under the temporal split the
// halves are chronological (calib strictly precedes eval), making the whole
// chain walk-forward: train < calibrate < evaluate in time. Both maps are
// monotonic, so AUC (ranking) is unchanged by design; what they fix is the
// probability SCALE, which is exactly what Kelly sizing consumes.
// ---------------------------------------------------------------------------
const sig = (x: number): number => 1 / (1 + Math.exp(-x));

// Wilson 95% score interval lower bound: the statistically honest way to quote
// a win rate from n trades (a 100% rate over 30 trades is NOT a 100% claim).
function wilsonLow95(winCount: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.959963984540054;
  const p = winCount / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - half) / denom);
}

// Mann-Whitney rank-sum AUC with tie correction: O(n log n), safe for the
// full-size transfer sets where pairwise counting would be quadratic.
function aucRankSum(records: Array<{ survival: number; label: number }>): number {
  const pos = records.reduce((s, r) => s + r.label, 0);
  const neg = records.length - pos;
  if (!pos || !neg) return 0.5;
  const sorted = [...records].sort((a, b) => a.survival - b.survival);
  let rankSumPos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].survival === sorted[i].survival) j += 1;
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) if (sorted[k].label === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

interface CalibrationReport {
  method: "platt" | "isotonic" | "identity";
  attached: boolean;
  calibSamples: number;
  evalSamples: number;
  brierPreCalibration: number;
  brierPlatt: number | null;
  brierIsotonic: number | null;
  brierPostCalibration: number;
  platt?: { a: number; b: number };
  isotonicKnots?: number;
}
interface SweepRow {
  threshold: number;
  trades: number;
  winRatePct: number;
  winRateCi95LoPct: number;
  totalPnlUsd: number;
  meanPnlUsd: number;
}
interface ScoredTrial { survival: number; label: number; pnlUsd: number; detected: boolean }
interface SweepReport {
  gateBaseline: { trades: number; winRatePct: number; winRateCi95LoPct: number; totalPnlUsd: number };
  sweep: SweepRow[];
  best: SweepRow | null;
}
interface TransferReport extends SweepReport {
  tape: string;
  samples: number;
  auc: number;
  brier: number;
  takeaway: string;
}
interface FeatureImportance {
  feature: string;
  aucDrop: number;
}
interface OperatingPointReport extends SweepReport {
  split: "random" | "temporal";
  evalSamples: number;
  aucEval: number;
  calibration: CalibrationReport | null;
  importance?: FeatureImportance[];
  transfer?: TransferReport;
  takeaway: string;
}
let operatingPoint: OperatingPointReport | null = null;

// Denser in [0.3, 0.7] where the calibrated survival actually lives (Platt caps
// it around 0.6-0.7 on this data), so the operating-point curve has resolution
// where it matters instead of collapsing to empty rows above the cap.
const SWEEP_THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];

function buildSweep(scoredInput: ScoredTrial[]): SweepReport {
  const scored = [...scoredInput].sort((a, b) => b.survival - a.survival);
  const sweep: SweepRow[] = [];
  for (const threshold of SWEEP_THRESHOLDS) {
    let trades = 0;
    let winCount = 0;
    let totalPnl = 0;
    for (const r of scored) {
      if (r.survival < threshold) break;
      trades += 1;
      winCount += r.label;
      totalPnl += r.pnlUsd;
    }
    sweep.push({
      threshold,
      trades,
      winRatePct: trades ? Number(((winCount / trades) * 100).toFixed(1)) : 0,
      winRateCi95LoPct: trades ? Number((wilsonLow95(winCount, trades) * 100).toFixed(1)) : 0,
      totalPnlUsd: Number(totalPnl.toFixed(2)),
      meanPnlUsd: trades ? Number((totalPnl / trades).toFixed(4)) : 0
    });
  }
  const gateTrades = scored.filter((r) => r.detected);
  const gateWins = gateTrades.reduce((s, r) => s + r.label, 0);
  const gateBaseline = {
    trades: gateTrades.length,
    winRatePct: gateTrades.length ? Number(((gateWins / gateTrades.length) * 100).toFixed(1)) : 0,
    winRateCi95LoPct: gateTrades.length ? Number((wilsonLow95(gateWins, gateTrades.length) * 100).toFixed(1)) : 0,
    totalPnlUsd: Number(gateTrades.reduce((s, r) => s + r.pnlUsd, 0).toFixed(2))
  };
  const candidates = sweep.filter((row) => row.trades >= 30);
  const best = candidates.length
    ? candidates.reduce((bestRow, row) => (row.totalPnlUsd > bestRow.totalPnlUsd ? row : bestRow))
    : null;
  return { gateBaseline, sweep, best };
}

if (bestMl.trees.length > 0 && opRecords.length >= 200) {
  const withMargin: Array<OpRecord & { margin: number }> = [];
  for (const record of opRecords) {
    const margin = engine.mlEdgeTensor.rawMargin(record.features);
    if (margin !== null && Number.isFinite(margin)) withMargin.push({ ...record, margin });
  }
  // Temporal split: records are already in chronological order (stride
  // sampling), so slicing at the midpoint keeps calib strictly BEFORE eval in
  // time. Random split: deterministic shuffle, stable per seed.
  if (splitMode !== "temporal") {
    for (let i = withMargin.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [withMargin[i], withMargin[j]] = [withMargin[j], withMargin[i]];
    }
  }
  const half = Math.floor(withMargin.length / 2);
  const calibFold = withMargin.slice(0, half);
  const evalFold = withMargin.slice(half);

  const brierOf = (map: (m: number) => number): number =>
    evalFold.reduce((s, r) => s + (map(r.margin) - r.label) ** 2, 0) / Math.max(1, evalFold.length);

  const brierPre = brierOf(sig);
  const calibPoints = calibFold.map((r) => ({ margin: r.margin, label: r.label }));
  const platt = fitPlattScaling(calibPoints);
  const isotonic = fitIsotonicCalibration(calibPoints);
  const brierPlatt = platt ? brierOf((m) => sig(platt.a * m + platt.b)) : null;
  const brierIsotonic = isotonic ? brierOf((m) => interpolateIsotonic(isotonic, m)) : null;

  // The two calibrators compete on the untouched eval half; ship the winner
  // only if it beats identity there AND (in generator mode) keeps the demo
  // winners comfortably above the veto floor.
  let method: "platt" | "isotonic" | "identity" = "identity";
  if (brierPlatt !== null && brierPlatt < brierPre && (brierIsotonic === null || brierPlatt <= brierIsotonic)) method = "platt";
  else if (brierIsotonic !== null && brierIsotonic < brierPre) method = "isotonic";

  let attached = false;
  if (method === "platt" && platt) {
    engine.mlEdgeTensor.setPlattCalibration(platt.a, platt.b);
    attached = true;
  } else if (method === "isotonic" && isotonic) {
    attached = engine.mlEdgeTensor.setIsotonicCalibration(isotonic.x, isotonic.y);
  }
  if (attached && !tapePath && demoMinWinnerSurvival() <= 0.45) {
    engine.mlEdgeTensor.importModel(bestMl); // revert to identity calibration
    attached = false;
    method = "identity";
  }

  const brierPost = method === "platt" && brierPlatt !== null ? brierPlatt : method === "isotonic" && brierIsotonic !== null ? brierIsotonic : brierPre;
  const calibrationReport: CalibrationReport = {
    method,
    attached,
    calibSamples: calibFold.length,
    evalSamples: evalFold.length,
    brierPreCalibration: Number(brierPre.toFixed(4)),
    brierPlatt: brierPlatt !== null ? Number(brierPlatt.toFixed(4)) : null,
    brierIsotonic: brierIsotonic !== null ? Number(brierIsotonic.toFixed(4)) : null,
    brierPostCalibration: Number(brierPost.toFixed(4)),
    ...(platt ? { platt: { a: Number(platt.a.toFixed(6)), b: Number(platt.b.toFixed(6)) } } : {}),
    ...(isotonic ? { isotonicKnots: isotonic.x.length } : {})
  };

  const survivalOf =
    attached && method === "platt" && platt
      ? (m: number) => sig(platt.a * m + platt.b)
      : attached && method === "isotonic" && isotonic
        ? (m: number) => interpolateIsotonic(isotonic, m)
        : sig;
  const scored: ScoredTrial[] = evalFold.map((r) => ({ survival: survivalOf(r.margin), label: r.label, pnlUsd: r.pnlUsd, detected: r.detected }));
  const aucEval = aucRankSum(scored);
  const { gateBaseline, sweep, best } = buildSweep(scored);

  // Permutation feature importance: shuffle one feature's values across the eval
  // fold, recompute each margin, and measure how much the ranking AUC drops.
  // A feature the ensemble never split on stays ~0; the ones carrying signal
  // show the biggest drop -- this makes the model's reasoning legible (which of
  // the 24 microstructure + temporal inputs it actually uses to separate
  // winners from losers). Monotone calibration doesn't change ranking, so we
  // measure the drop on the raw margins directly.
  let importance: FeatureImportance[] | undefined;
  if (evalFold.length >= 50) {
    const baselineMarginAuc = aucRankSum(evalFold.map((r) => ({ survival: r.margin, label: r.label })));
    const featureKeys = Object.keys(evalFold[0].features) as Array<keyof Feat>;
    importance = featureKeys
      .map((key) => {
        const shuffled = evalFold.map((r) => r.features[key]);
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rng() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const permutedAuc = aucRankSum(
          evalFold.map((r, i) => ({
            survival: engine.mlEdgeTensor.rawMargin({ ...r.features, [key]: shuffled[i] }) ?? 0,
            label: r.label
          }))
        );
        return { feature: String(key), aucDrop: Number((baselineMarginAuc - permutedAuc).toFixed(4)) };
      })
      .sort((a, b) => b.aucDrop - a.aucDrop);
  }

  const takeaway = best && best.totalPnlUsd > 0
    ? `Existe un punto de operación con P&L contrafactual positivo out-of-sample${splitMode === "temporal" ? " (validación walk-forward: el modelo nunca vio el segmento temporal evaluado)" : ""}: umbral ${best.threshold} -> ${best.trades} trades, ${best.winRatePct}% ganadores (IC95 inferior ${best.winRateCi95LoPct}%), +$${best.totalPnlUsd.toFixed(2)}. Importante: es liquidación contrafactual bajo el modelo de costos del simulador sobre dislocaciones reales, no trading en vivo — y la selectividad extrema (${((best.trades / Math.max(1, evalFold.length)) * 100).toFixed(2)}% de las señales) muestra lo raro que es el edge.`
    : `Ningún umbral de supervivencia produce P&L contrafactual positivo out-of-sample (mejor: ${best ? `$${best.totalPnlUsd.toFixed(2)} en umbral ${best.threshold}` : "sin candidatos con >=30 trades"}). Incluso seleccionando solo las señales de mayor confianza del modelo, los costos reales dominan — la conclusión honesta se mantiene: el valor está en rechazar bien, no en un edge retail.`;

  operatingPoint = {
    split: splitMode,
    evalSamples: evalFold.length,
    aucEval: Number(aucEval.toFixed(4)),
    calibration: calibrationReport,
    importance,
    gateBaseline,
    sweep,
    best,
    takeaway
  };
}

// ---------------------------------------------------------------------------
// Cross-regime transfer: settle a SECOND tape with the frozen, calibrated
// model. Nothing here trains or recalibrates anything -- it is the purest
// out-of-distribution test available: e.g. train on the overnight session,
// evaluate on the daytime session. Records survival at settle time (model is
// final), so no features need retaining.
// ---------------------------------------------------------------------------
if (evalTapePath && operatingPoint && bestMl.trees.length > 0) {
  const transferRounds = loadTape(evalTapePath);
  if (transferRounds.length) {
    console.log(`\n  Transferencia: liquidando ${evalTapePath} (${transferRounds.length} rondas) con el modelo congelado...`);
    const transferScored: ScoredTrial[] = [];
    let nextTransferReport = Date.now() + 5000;
    for (let i = 0; i < transferRounds.length; i += 1) {
      const books = rebaseRound(transferRounds[i]);
      const byExchange = bookMap(books);
      for (const book of books) {
        for (const opportunity of engine.onOrderBook(book)) {
          if (opportunity.type !== "CROSS_EXCHANGE") continue;
          const trade = await simulator.execute(opportunity);
          const tradePnl = Number(trade.pnlUsd);
          const buyBook = opportunity.buyExchange ? byExchange.get(opportunity.buyExchange) : undefined;
          const sellBook = opportunity.sellExchange ? byExchange.get(opportunity.sellExchange) : undefined;
          if (!buyBook || !sellBook) continue;
          const features = engine.mlEdgeTensor.extractFeatures(buyBook, sellBook, d(opportunity.tradeSizeBtc), opportunity.executionStyle, d(opportunity.netSpreadPct).div(100));
          transferScored.push({
            survival: engine.mlEdgeTensor.predict(features).survivalProbability,
            label: tradePnl > 0 ? 1 : 0,
            pnlUsd: tradePnl,
            detected: opportunity.status === "DETECTED"
          });
        }
      }
      await sleep(0);
      if (Date.now() >= nextTransferReport) {
        console.log(`    transfer ${Math.round((i / transferRounds.length) * 100)}% (${transferScored.length} ensayos)`);
        nextTransferReport += 5000;
      }
    }
    if (transferScored.length >= 100) {
      const { gateBaseline, sweep, best } = buildSweep(transferScored);
      const transferBrier = transferScored.reduce((s, r) => s + (r.survival - r.label) ** 2, 0) / transferScored.length;
      const transferTakeaway = best && best.totalPnlUsd > 0
        ? `La selección transfiere de régimen: en un tape ajeno al entrenamiento (${evalTapePath}), el umbral ${best.threshold} habría tomado ${best.trades} trades con ${best.winRatePct}% ganadores (IC95 inferior ${best.winRateCi95LoPct}%) y +$${best.totalPnlUsd.toFixed(2)} contrafactuales.`
        : `En el tape de transferencia (${evalTapePath}) ningún umbral produce P&L positivo${best ? ` (mejor: $${best.totalPnlUsd.toFixed(2)} en ${best.threshold})` : ""} — la selección aprendida en la ventana nocturna NO transfiere a este régimen, y lo reportamos tal cual.`;
      operatingPoint.transfer = {
        tape: evalTapePath,
        samples: transferScored.length,
        auc: Number(aucRankSum(transferScored).toFixed(4)),
        brier: Number(transferBrier.toFixed(4)),
        gateBaseline,
        sweep,
        best,
        takeaway: transferTakeaway
      };
    } else {
      console.log(`    Transferencia omitida: solo ${transferScored.length} ensayos (<100).`);
    }
  } else {
    console.log(`\n  Transferencia omitida: tape vacio o ilegible (${evalTapePath}).`);
  }
}

const finalAuc = valSamples.length >= 40 ? auc() : 0.5;

// Held-out separation: the restored model's mean survival on real winners vs real
// losers from the validation reservoir (out-of-sample). This is what the probe was
// trying to show, but measured on the true distribution instead of a hand-built
// pair -- it can't be degenerate and tracks AUC directly.
const winPreds = valSamples.filter((s) => s.label === 1).map((s) => engine.mlEdgeTensor.predict(s.features).survivalProbability);
const lossPreds = valSamples.filter((s) => s.label === 0).map((s) => engine.mlEdgeTensor.predict(s.features).survivalProbability);
const meanWinSurvival = winPreds.length ? winPreds.reduce((a, b) => a + b, 0) / winPreds.length : 0;
const meanLossSurvival = lossPreds.length ? lossPreds.reduce((a, b) => a + b, 0) / lossPreds.length : 0;
const demoSafety = bestMl.trees.length > 0 ? demoMinWinnerSurvival() : 0; // min survival on demo winners (must clear 0.30 veto floor)
const discriminates = bestMl.trees.length > 0 && finalAuc >= 0.65 && meanWinSurvival > meanLossSurvival;

// The engine holds the restored best-AUC trees, now possibly with an attached
// Platt map -- exporting from it (rather than reusing the raw bestMl snapshot)
// is what ships the calibration alongside the trees.
const mlModel = discriminates ? engine.mlEdgeTensor.exportModel() : { ...bestMl, trees: [] };
const bundle = {
  version: 1,
  savedAt: new Date().toISOString(),
  trainedForSec: tapePath ? undefined : durationSec,
  source: tapePath ? "tape" : "generator",
  tape: tapePath ?? undefined,
  seed: rngSeed,
  signals,
  winRate: signals ? Number(((wins / signals) * 100).toFixed(1)) : 0,
  auc: Number(finalAuc.toFixed(4)),
  valSamples: valSamples.length,
  demoSafety: Number(demoSafety.toFixed(4)),
  mlValidated: discriminates,
  operatingPoint: operatingPoint ?? undefined,
  ml: mlModel,
  aet: engine.exportCalibration()
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

if (opOutPath && operatingPoint) {
  const opArtifact = {
    generatedAt: new Date().toISOString(),
    source: tapePath ? "tape" : "generator",
    tape: tapePath ?? undefined,
    trialsSettled: signals,
    detectedByGate: detectedCount,
    ...operatingPoint
  };
  mkdirSync(dirname(opOutPath), { recursive: true });
  writeFileSync(opOutPath, JSON.stringify(opArtifact, null, 2));
}

if (dumpRecordsPath && opRecords.length > 0) {
  // One JSONL line per held-out record: the exact (features, label, pnl) tuples
  // the operating-point analysis scored, so any refit experiment reproduces the
  // same eval fold without another tape replay.
  const jsonl = opRecords.map((r) => JSON.stringify(r)).join("\n");
  mkdirSync(dirname(dumpRecordsPath), { recursive: true });
  writeFileSync(dumpRecordsPath, jsonl + "\n");
  console.log(`  Registros held-out volcados: ${opRecords.length} -> ${dumpRecordsPath}`);
}

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

function printSweep(report: { gateBaseline: SweepReport["gateBaseline"]; sweep: SweepRow[] }): void {
  const g = report.gateBaseline;
  console.log(`    Gate actual (DETECTED): ${g.trades} trades, ${g.winRatePct}% ganadores (IC95 >= ${g.winRateCi95LoPct}%), $${g.totalPnlUsd.toFixed(2)}`);
  console.log("    Umbral  trades   win%  IC95lo      P&L total     P&L medio");
  for (const row of report.sweep) {
    console.log(`    ${row.threshold.toFixed(2).padStart(6)} ${String(row.trades).padStart(7)} ${`${row.winRatePct}%`.padStart(6)} ${`${row.winRateCi95LoPct}%`.padStart(7)} ${`$${row.totalPnlUsd.toFixed(2)}`.padStart(13)} ${`$${row.meanPnlUsd.toFixed(4)}`.padStart(12)}`);
  }
}

if (operatingPoint) {
  console.log(`\n  Calibración + punto de operación (split ${operatingPoint.split}; folds calib/eval disjuntos):`);
  const c = operatingPoint.calibration;
  if (c) {
    console.log(`    Brier eval: identidad ${c.brierPreCalibration.toFixed(4)} | Platt ${c.brierPlatt !== null ? c.brierPlatt.toFixed(4) : "n/a"} | isotónica ${c.brierIsotonic !== null ? c.brierIsotonic.toFixed(4) : "n/a"}`);
    console.log(`    Ganadora: ${c.method}${c.attached ? " (ADJUNTADA al modelo)" : " (no adjuntada)"}${c.platt ? ` | platt a=${c.platt.a.toFixed(3)} b=${c.platt.b.toFixed(3)}` : ""}${c.isotonicKnots ? ` | knots=${c.isotonicKnots}` : ""} | ${c.calibSamples} calib / ${c.evalSamples} eval`);
  }
  console.log(`    AUC eval (${operatingPoint.evalSamples} muestras): ${operatingPoint.aucEval.toFixed(4)}`);
  if (operatingPoint.importance && operatingPoint.importance.length) {
    console.log("    Importancia de features (caída de AUC al permutar):");
    for (const imp of operatingPoint.importance.filter((i) => i.aucDrop > 0.0005).slice(0, 12)) {
      console.log(`      ${imp.feature.padEnd(20)} ${imp.aucDrop.toFixed(4)}`);
    }
  }
  printSweep(operatingPoint);
  console.log(`\n    ${operatingPoint.takeaway}`);
  if (operatingPoint.transfer) {
    const t = operatingPoint.transfer;
    console.log(`\n  Transferencia de régimen (${t.tape}): ${t.samples} ensayos, AUC ${t.auc.toFixed(4)}, Brier ${t.brier.toFixed(4)}`);
    printSweep(t);
    console.log(`\n    ${t.takeaway}`);
  }
}
if (!tapePath) {
  console.log(`  Demo-safety (min survival en ganadores del demo): ${(demoSafety * 100).toFixed(1)}%  (> 30% = no veta el demo)`);
}
console.log("\n  Artefacto persistido:");
console.log(`    AET route calibration : ${Object.keys(bundle.aet).length} rutas (entrenado)`);
console.log(`    ML ensemble           : ${discriminates ? `${mlModel.trees.length} arboles (validado, AUC ${finalAuc.toFixed(3)})` : "vacio (no discrimina en held-out; reentrena en LIVE)"}`);
if (tapePath && signals > 0 && wins / signals < 0.05) {
  console.log("\n  Hallazgo (datos reales): a tarifas retail, TODAS las dislocaciones");
  console.log("  cross-exchange capturadas son no rentables tras fees+base+costos. El");
  console.log("  mercado es eficiente: el valor del sistema esta en RECHAZARLAS bien (lo");
  console.log("  que el AET ahora calibra con outcomes reales), no en un edge inexistente.");
}
console.log(`\n  Modelo guardado en: ${outPath}\n`);

process.exit(0);
