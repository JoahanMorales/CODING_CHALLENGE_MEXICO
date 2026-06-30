import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExchangeId, NormalizedOrderBook, Opportunity, ScenarioKind, WalletSeed } from "../src/lib/types";

// Offline training harness for the gradient-boosted ML EdgeTensor.
//
// The live kernel only trains the ML from executed cross-exchange paper trades,
// which drain slowly through a latency-bound, EV-prioritized queue (dominated by
// higher-EV triangular fills that don't train the ML). To train a real model in
// seconds we drive the engine + simulator directly: every cross-exchange signal
// the engine produces is settled synchronously (latency cost still modeled, only
// the wall-clock wait removed) and fed back as a realized outcome. Cycling stress
// scenarios yields both winning (calm) and losing (stress) labels, so the model
// becomes genuinely discriminative rather than degenerate. The trained model +
// AET calibration are persisted for the deployed app to warm-start.
//
//   npm run train            # 45s
//   npm run train -- 90      # 90s
//   npm run train -- 60 public/model/edge-model.json

const durationSec = Number(process.argv[2] ?? 45);
const outPath = process.argv[3] ?? "public/model/edge-model.json";

// Settle paper fills with no wall-clock wait (the cost model still uses the full
// modeled latency). Must be set before the simulator module is imported.
process.env.ARBITRAI_SIM_SLEEP_SCALE = process.env.ARBITRAI_SIM_SLEEP_SCALE ?? "0";

const { ArbitrageEngine } = await import("../src/lib/services/ArbitrageEngine");
const { ExecutionSimulator } = await import("../src/lib/services/ExecutionSimulator");
const { MarketDataService } = await import("../src/lib/services/MarketDataService");
const { EventBus } = await import("../src/lib/services/EventBus");
const { RiskManager } = await import("../src/lib/services/RiskManager");
const { EXCHANGE_IDS } = await import("../src/lib/config/exchanges");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deep wallets so counterfactual settlement never runs dry during training.
const seed = Object.fromEntries(
  EXCHANGE_IDS.map((id: ExchangeId) => [id, { btc: "100000", usdt: "7000000000" }])
) as WalletSeed;

const bus = new EventBus();
const risk = new RiskManager();
const market = new MarketDataService(bus, risk);
const engine = new ArbitrageEngine();
const simulator = new ExecutionSimulator(seed, () => risk.getLatencyMultiplier());

// Train on the full evaluated cross-exchange distribution (every bid>ask signal)
// with its real settled outcome, so the model learns the edge->profitability
// frontier from order-book features. A strong, deep, fresh edge settles positive
// (label 1); a marginal one is eaten by fees/impact and settles negative
// (label 0). The discrimination probe at the end verifies the model is not
// degenerate (predicts high survival for strong edges, low for weak ones).
let pending: Opportunity[] = [];
bus.on("market:update", (book) => {
  for (const opportunity of engine.onOrderBook(book)) {
    if (opportunity.type === "CROSS_EXCHANGE") pending.push(opportunity);
  }
});

let signals = 0;
let wins = 0;
let pnl = 0;
// The demo rarely keeps class diversity in the rolling buffer, so the live
// ensemble can transiently refit to 0 trees. Keep the best (most-structured)
// snapshot seen during the run rather than whatever happens to be current.
let bestMl = engine.mlEdgeTensor.exportModel();
let bestTreeCount = engine.mlEdgeTensor.treeCount();

const phases: Array<ScenarioKind | "NONE"> = ["NONE", "LATENCY_SPIKE", "NONE", "LIQUIDITY_DRAIN", "NONE", "MARKET_CRASH"];
const phaseMs = 6000;

function header(): void {
  console.log(["  t(s)", "signals", "  win%", "  ML?", "trees", "MLobs", " Brier", "phase"].join(" "));
  console.log("-".repeat(70));
}
function reportRow(startedAt: number, phase: string): void {
  const mlCal = engine.mlEdgeTensor.calibrationSummary();
  const trained = engine.mlEdgeTensor.isTrained();
  const winRate = signals ? ((wins / signals) * 100).toFixed(1) : "0.0";
  console.log([
    ((Date.now() - startedAt) / 1000).toFixed(0).padStart(5),
    String(signals).padStart(7),
    `${winRate}%`.padStart(6),
    (trained ? "yes" : "no").padStart(5),
    String(engine.mlEdgeTensor.exportModel().trees.length).padStart(5),
    String(mlCal.observations).padStart(6),
    mlCal.brierScore.toFixed(4).padStart(7),
    phase.padEnd(15)
  ].join(" "));
}

console.log(`\nArbitrAI - entrenando el ensemble AET+ML por ${durationSec}s (motor directo + escenarios)\n`);
header();

const startedAt = Date.now();
const endAt = startedAt + durationSec * 1000;
let nextReport = startedAt + 5000;
let nextPhaseAt = startedAt + phaseMs;
let phaseIndex = 0;
let announcedTrained = false;

while (Date.now() < endAt) {
  market.stepDemo();
  // Settle every cross-exchange signal this tick produced and learn from it.
  while (pending.length) {
    const opportunity = pending.shift() as Opportunity;
    const trade = await simulator.execute(opportunity);
    const tradePnl = Number(trade.pnlUsd);
    engine.recordExecutionOutcome(opportunity, tradePnl);
    signals += 1;
    if (tradePnl > 0) wins += 1;
    pnl += tradePnl;
    if (engine.mlEdgeTensor.treeCount() > bestTreeCount) {
      bestTreeCount = engine.mlEdgeTensor.treeCount();
      bestMl = engine.mlEdgeTensor.exportModel();
    }
  }
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

reportRow(startedAt, "final");

// Validate the best snapshot before persisting: only keep the trained trees if
// they actually discriminate a strong edge from a weak one. On the clean demo
// the trees usually collapse to a near-constant (too few profitable samples), in
// which case we persist an EMPTY ML model and let the live pipeline retrain on
// real data — the AET route calibration is always persisted and is genuinely
// trained here.
if (bestTreeCount > 0) engine.mlEdgeTensor.importModel(bestMl);

const { d } = await import("../src/lib/math/decimal");
const strongFeat = engine.mlEdgeTensor.extractFeatures(probeBook("kraken", 69999, 70000, "6"), probeBook("binance", 70300, 70301, "6"), d("0.05"), "INSTANT_TAKER", d("0.0035"));
const weakFeat = engine.mlEdgeTensor.extractFeatures(probeBook("kraken", 69990, 70000, "0.02"), probeBook("binance", 70008, 70010, "0.02"), d("0.05"), "INSTANT_TAKER", d("-0.0008"));
const strongSurvival = engine.mlEdgeTensor.predict(strongFeat).survivalProbability;
const weakSurvival = engine.mlEdgeTensor.predict(weakFeat).survivalProbability;
const discriminates = bestTreeCount > 0 && strongSurvival - weakSurvival > 0.12 && strongSurvival > 0.55;

const mlModel = discriminates ? bestMl : { ...bestMl, trees: [] };
const bundle = {
  version: 1,
  savedAt: new Date().toISOString(),
  trainedForSec: durationSec,
  signals,
  mlValidated: discriminates,
  ml: mlModel,
  aet: engine.exportCalibration()
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

// Discrimination probe: does the trained model rank a strong, deep, fresh edge
// above a thin, marginal one? This is the result that matters — a healthy model
// predicts high survival for real edges (so it won't veto them) and low for weak
// ones (so it discounts their Expected Value).
function probeBook(exchange: ExchangeId, bid: number, ask: number, size: string): NormalizedOrderBook {
  return {
    exchange,
    symbol: "BTC/USDT",
    sourceSymbol: "BTC/USDT",
    quoteAsset: "USDT",
    quoteToUsdRate: "1.00000000",
    quoteBasisBps: "0.000",
    bids: Array.from({ length: 5 }, (_, i) => ({ price: String(bid - i), size })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: String(ask + i), size })),
    receivedAt: Date.now(),
    exchangeTimestamp: Date.now(),
    processingLatencyMs: 0.2,
    integrity: { status: "VERIFIED", gapCount: 0, resyncCount: 0, checksumValidated: true, reason: "probe" }
  };
}
const mlCal = engine.mlEdgeTensor.calibrationSummary();
console.log("\n=== Resultado del entrenamiento ===");
console.log(`  Señales cross-exchange evaluadas  : ${signals}`);
console.log(`  Tasa base de rentabilidad         : ${signals ? ((wins / signals) * 100).toFixed(1) : "0.0"}%  (la mayoría no sobrevive fees+impacto)`);
console.log(`  Brier score (ML)                  : ${mlCal.brierScore.toFixed(4)}  (menor = mejor calibrado)`);
console.log("\n  Probe de discriminación (edge fuerte vs débil):");
console.log(`    edge fuerte (deep, fresco, +35bps) -> survival ${(strongSurvival * 100).toFixed(1)}%`);
console.log(`    edge débil  (thin, -8bps)          -> survival ${(weakSurvival * 100).toFixed(1)}%`);
console.log("\n  Artefacto persistido:");
console.log(`    AET route calibration : ${Object.keys(bundle.aet).length} rutas (entrenado)`);
console.log(`    ML ensemble           : ${discriminates ? `${mlModel.trees.length} arboles (validado, discrimina)` : "vacio (el demo no da diversidad suficiente; reentrena en LIVE)"}`);
console.log(`\n  Modelo guardado en: ${outPath}`);
console.log("  Nota: el harness liquida cada señal counterfactualmente para generar datos;");
console.log("        el P&L conservador real se mide en la terminal, no aqui.\n");

process.exit(0);
