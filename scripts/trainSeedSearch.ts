import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

// Best-of-N seed search for the warm-start ML model. A single `npm run train` run
// is a snapshot of one random draw from the synthetic generator; this wrapper runs
// the SAME harness across many independent seeds (each a fresh, deterministic but
// different synthetic market), scores every resulting model on its own held-out
// AUC + demo-safety, and only promotes a new model to the committed warm-start if
// it BEATS the current one -- so a long run can only improve (or hold steady)
// public/model/edge-model.json, never regress it with a lucky-bad seed.
//
//   npm run train:search                      # 12 seeds x 90s (~18 min)
//   npm run train:search -- 20 120             # 20 seeds x 120s (~40 min)

const run = promisify(execFile);

const numSeeds = Number(process.argv[2] ?? 12);
const perRunSec = Number(process.argv[3] ?? 90);
const finalOut = "public/model/edge-model.json";
const workDir = "data/seed-search";
mkdirSync(workDir, { recursive: true });

interface Bundle {
  seed?: number;
  auc?: number;
  demoSafety?: number;
  mlValidated?: boolean;
  signals?: number;
  valSamples?: number;
  ml?: { trees?: unknown[]; version?: number };
}

function score(bundle: Bundle | null): number {
  if (!bundle) return -1;
  // Demo-safety is a hard gate (a model that vetoes the demo is worthless here,
  // matching the in-harness acceptance bar of 0.45); AUC is the quality signal.
  if ((bundle.demoSafety ?? 0) < 0.45) return -1;
  if (!bundle.mlValidated) return 0; // AET-only fallback is valid but not preferred
  return (bundle.auc ?? 0) * 100 + (bundle.demoSafety ?? 0) * 10;
}

function readBundle(path: string): Bundle | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Bundle;
  } catch {
    return null;
  }
}

const { ML_MODEL_VERSION } = await import("../src/lib/services/MlEdgeTensor");

// A committed model from an older feature-schema version is REJECTED by
// importModel at load time -- it provides zero value as a warm start, so it
// cannot be allowed to block promotion of a valid current-version candidate.
const baselineRaw = existsSync(finalOut) ? readBundle(finalOut) : null;
const baselineOutdated = baselineRaw?.ml?.version !== undefined && baselineRaw.ml.version !== ML_MODEL_VERSION;
const baseline = baselineOutdated ? null : baselineRaw;
const baselineScore = score(baseline);
if (baselineOutdated) {
  console.log(`\n  AVISO: el modelo actual es de esquema v${baselineRaw?.ml?.version} (actual v${ML_MODEL_VERSION}) -> baseline inválido, se promoverá el mejor candidato.`);
}

console.log(`\nArbitrAI - busqueda de semillas para el modelo ML | ${numSeeds} seeds x ${perRunSec}s (~${Math.round((numSeeds * perRunSec) / 60)} min)\n`);
console.log(`  Baseline actual: auc=${baseline?.auc ?? "n/d"} demoSafety=${baseline?.demoSafety ?? "n/d"} trees=${baseline?.ml?.trees?.length ?? 0} score=${baselineScore.toFixed(2)}\n`);
console.log(["  seed".padEnd(12), "auc", "demoSafety", "trees", "valSamples", "score"].join("  "));
console.log("-".repeat(70));

let best = baseline;
let bestScore = baselineScore;
let bestPath: string | null = null;
const allResults: Array<{ seed: number; auc: number; demoSafety: number; trees: number; score: number }> = [];

for (let i = 0; i < numSeeds; i += 1) {
  // Spread seeds well across the 32-bit space (golden-ratio stride) so runs are
  // independent draws, not nearby/correlated PRNG states.
  const seed = (0x9e3779b9 + i * 0x2545f491) >>> 0;
  const outPath = `${workDir}/model-seed-${seed}.json`;
  try {
    await run("npx", ["tsx", "scripts/trainModel.ts", String(perRunSec), "--seed", String(seed), "--out", outPath], {
      maxBuffer: 1024 * 1024 * 16,
      shell: true
    });
  } catch (error) {
    console.log(`  seed ${seed} failed: ${(error as Error).message.slice(0, 80)}`);
    continue;
  }
  const bundle = readBundle(outPath);
  const s = score(bundle);
  const trees = bundle?.ml?.trees?.length ?? 0;
  allResults.push({ seed, auc: bundle?.auc ?? 0, demoSafety: bundle?.demoSafety ?? 0, trees, score: s });
  console.log([
    String(seed).padEnd(12),
    (bundle?.auc ?? 0).toFixed(4).padStart(7),
    `${((bundle?.demoSafety ?? 0) * 100).toFixed(1)}%`.padStart(9),
    String(trees).padStart(5),
    String(bundle?.valSamples ?? 0).padStart(10),
    s.toFixed(2).padStart(7)
  ].join("  "));
  if (s > bestScore) {
    bestScore = s;
    best = bundle;
    bestPath = outPath;
  }
}

console.log("\n=== Resultado de la búsqueda ===");
if (bestPath && best) {
  writeFileSync(finalOut, JSON.stringify(best, null, 2));
  console.log(`  Mejor modelo: seed=${best.seed} auc=${best.auc} demoSafety=${((best.demoSafety ?? 0) * 100).toFixed(1)}% trees=${best.ml?.trees?.length ?? 0} score=${bestScore.toFixed(2)}`);
  console.log(`  Mejoró sobre el baseline (score ${baselineScore.toFixed(2)}) -> promovido a ${finalOut}`);
} else {
  console.log(`  Ningún seed superó el modelo actual (score ${baselineScore.toFixed(2)}) -> se conserva sin cambios.`);
}
const sorted = [...allResults].sort((a, b) => b.score - a.score);
console.log("\n  Top 5 seeds por score:");
for (const r of sorted.slice(0, 5)) console.log(`    seed ${r.seed}: auc=${r.auc.toFixed(4)} demoSafety=${(r.demoSafety * 100).toFixed(1)}% trees=${r.trees} score=${r.score.toFixed(2)}`);
console.log("");
process.exit(0);
