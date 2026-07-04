import { readFileSync } from "node:fs";

// Fast feature-bagging diagnostic. Reads a held-out record dump produced by
//   npm run train -- --tape <overnight> --split temporal --dumpRecords <file>
// and re-fits the boosted ensemble under several configs IN SECONDS (no tape
// replay), so we can see whether stochastic column subsampling ("feature
// bagging") pulls in features beyond the dominant netEdgeBps and whether that
// helps, hurts, or leaves out-of-sample discrimination and P&L unchanged.
//
// The comparison is fair by construction: every config runs the SAME clean
// walk-forward split (train < calib < eval in time) and the SAME procedure.
// Absolute numbers may differ from the full online run (this trains on the 1/5
// stride-sampled detected records, not the full stream), but the baseline vs
// bagged DELTA is apples-to-apples.

const { MlEdgeTensor, fitPlattScaling } = await import("../src/lib/services/MlEdgeTensor");

const recordsPath = process.argv[2] ?? "data/records-overnight.jsonl";
type Rec = { features: Record<string, number>; label: number; pnlUsd: number; detected: boolean };

const records: Rec[] = readFileSync(recordsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Rec);

if (records.length < 500) {
  console.error(`Too few records (${records.length}) in ${recordsPath}`);
  process.exit(1);
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// Tie-corrected Mann-Whitney rank-sum AUC, O(n log n).
function aucRankSum(rows: Array<{ score: number; label: number }>): number {
  const pos = rows.filter((r) => r.label === 1).length;
  const neg = rows.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j += 1;
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) if (sorted[k].label === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

const SWEEP = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];

type Config = {
  name: string;
  boosting?: { featureSampleRatio?: number; stopRmse?: number; minStopTrees?: number; maxTrees?: number; seed?: number };
};

const CONFIGS: Config[] = [
  { name: "baseline (greedy, all 24 feats)" },
  { name: "bag 0.50 / >=8 trees", boosting: { featureSampleRatio: 0.5, minStopTrees: 8, stopRmse: 0.005, maxTrees: 16, seed: 2654435769 } },
  { name: "bag 0.35 / >=10 trees", boosting: { featureSampleRatio: 0.35, minStopTrees: 10, stopRmse: 0.003, maxTrees: 20, seed: 2654435769 } },
  { name: "bag 0.70 / >=6 trees", boosting: { featureSampleRatio: 0.7, minStopTrees: 6, stopRmse: 0.008, maxTrees: 12, seed: 2654435769 } }
];

// Clean walk-forward: train strictly before calib strictly before eval.
const trainEnd = Math.floor(records.length * 0.6);
const calibEnd = Math.floor(records.length * 0.8);
const trainDetected = records.slice(0, trainEnd).filter((r) => r.detected);
const calibFold = records.slice(trainEnd, calibEnd);
const evalFold = records.slice(calibEnd);

console.log(`Records: ${records.length} | detected: ${records.filter((r) => r.detected).length}`);
console.log(`Walk-forward: train=${trainDetected.length} detected | calib=${calibFold.length} | eval=${evalFold.length}\n`);
console.log("config                          trees  feats  evalAUC   bestPnl$    win%   gate$");
console.log("------------------------------  -----  -----  -------  ----------  -----  ----------");

const gateEval = evalFold.filter((r) => r.detected);
const gatePnl = gateEval.reduce((s, r) => s + r.pnlUsd, 0);

for (const cfg of CONFIGS) {
  const ml = new MlEdgeTensor();
  if (cfg.boosting) ml.configureBoosting(cfg.boosting);
  for (const r of trainDetected) ml.train("r", r.features as never, r.label, 1);

  const model = ml.exportModel();
  const feats = new Set(model.trees.map((t) => t.featureIndex)).size;

  // Fit Platt on the calib fold's margins, apply, then score eval.
  const calibPts = calibFold
    .map((r) => ({ margin: ml.rawMargin(r.features as never), label: r.label }))
    .filter((p): p is { margin: number; label: number } => p.margin !== null && Number.isFinite(p.margin));
  const platt = fitPlattScaling(calibPts);
  const surv = (m: number): number => (platt ? sigmoid(platt.a * m + platt.b) : sigmoid(m));

  const scored = evalFold
    .map((r) => ({ margin: ml.rawMargin(r.features as never), label: r.label, pnlUsd: r.pnlUsd }))
    .filter((r): r is { margin: number; label: number; pnlUsd: number } => r.margin !== null && Number.isFinite(r.margin))
    .map((r) => ({ survival: surv(r.margin), margin: r.margin, label: r.label, pnlUsd: r.pnlUsd }));

  const auc = aucRankSum(scored.map((r) => ({ score: r.margin, label: r.label })));

  let best = { pnl: -Infinity, win: 0, trades: 0 };
  const bySurv = [...scored].sort((a, b) => b.survival - a.survival);
  for (const t of SWEEP) {
    let pnl = 0, wins = 0, trades = 0;
    for (const r of bySurv) {
      if (r.survival < t) break;
      pnl += r.pnlUsd; wins += r.label; trades += 1;
    }
    if (trades >= 30 && pnl > best.pnl) best = { pnl, win: trades ? (wins / trades) * 100 : 0, trades };
  }

  const name = cfg.name.padEnd(30);
  const bestPnlStr = best.pnl === -Infinity ? "     n/a" : best.pnl.toFixed(0).padStart(10);
  const winStr = best.pnl === -Infinity ? "  -  " : best.win.toFixed(1).padStart(5);
  console.log(`${name}  ${String(model.trees.length).padStart(5)}  ${String(feats).padStart(5)}  ${auc.toFixed(4)}  ${bestPnlStr}  ${winStr}  ${gatePnl.toFixed(0).padStart(10)}`);
}

console.log("\nRead: if bagged rows raise evalAUC/bestPnl vs baseline -> other features carry signal (bagging wins).");
console.log("If AUC/P&L hold with more feats used -> diversified at no cost. If they drop -> parsimony confirmed.");
