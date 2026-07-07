// End-to-end check that the GPU-exported model (public/model/neural-edge-gpu.json)
// is a faithful drop-in: load it through the *real* TS inference class
// (NeuralEdge.predict) and recompute AUC over the held-out test set that the
// Python trainer wrote (scripts/gpu/out/val-holdout.csv). If the TS AUC matches
// the AUC Python reported in the bundle (valAuc), the weight transpose + schema
// export are correct. A mismatch means the layouts drifted.
//
//   npx tsx scripts/gpu/verifyExport.ts

import { readFileSync } from "node:fs";
import { NeuralEdge } from "../../src/lib/services/NeuralEdge";

const MODEL = "public/model/neural-edge-gpu.json";
const HOLDOUT = "scripts/gpu/out/val-holdout.csv";

const bundle = JSON.parse(readFileSync(MODEL, "utf8"));
const net = new NeuralEdge();
if (!net.importModel(bundle)) throw new Error(`could not import ${MODEL} (schema mismatch)`);

const csv = readFileSync(HOLDOUT, "utf8").trim().split("\n");
const header = csv[0].split(",");
const keys = header.slice(0, -1); // last column is y

const scored: Array<{ p: number; y: number }> = [];
for (let i = 1; i < csv.length; i += 1) {
  const cells = csv[i].split(",");
  const features: Record<string, number> = {};
  for (let j = 0; j < keys.length; j += 1) features[keys[j]] = Number(cells[j]);
  const y = Number(cells[keys.length]);
  scored.push({ p: net.predict(features), y });
}

// Rank-based AUC (Mann-Whitney), same as the trainer.
function auc(rows: Array<{ p: number; y: number }>): number {
  const pos = rows.filter((r) => r.y === 1).length;
  const neg = rows.length - pos;
  if (!pos || !neg) return 0.5;
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i].y === 1) rankSum += i + 1;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const tsAuc = auc(scored);
const pyAuc = Number(bundle.valAuc);
const delta = Math.abs(tsAuc - pyAuc);
const ok = delta < 2e-3; // small tolerance for float64 vs the TS path

process.stdout.write("\n=== NeuralEdge GPU export verification ===\n");
process.stdout.write(`  samples (test)   : ${scored.length}\n`);
process.stdout.write(`  Python test AUC  : ${pyAuc.toFixed(4)}\n`);
process.stdout.write(`  TS inference AUC : ${tsAuc.toFixed(4)}\n`);
process.stdout.write(`  |delta|          : ${delta.toFixed(5)}\n`);
process.stdout.write(`  drop-in faithful : ${ok ? "YES ✅" : "NO ❌ (weights/schema drift)"}\n\n`);
process.exit(ok ? 0 : 1);
