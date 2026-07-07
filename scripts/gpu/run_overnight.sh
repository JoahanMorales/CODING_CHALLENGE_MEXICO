#!/usr/bin/env bash
# Overnight GPU run: generate the NeuralEdge dataset (CPU, once), train + sweep on
# the Orin GPU, then verify the export is a faithful TS drop-in. Safe to leave
# running unattended -- it writes only to scripts/gpu/{data,out} and
# public/model/neural-edge-gpu.json (the committed neural-edge.json is untouched).
#
#   scripts/gpu/run_overnight.sh                 # full run
#   SAMPLES=2000 EPOCHS=20 QUICK=1 scripts/gpu/run_overnight.sh   # smoke
set -euo pipefail
cd "$(dirname "$0")/../.."

SAMPLES="${SAMPLES:-150000}"
EPOCHS="${EPOCHS:-300}"
DATA_CSV="scripts/gpu/data/neural-samples.csv"
LOG="scripts/gpu/out/overnight.log"
mkdir -p scripts/gpu/out scripts/gpu/data

# Prefer local Node (Jetson: node lives in ~/.local, not the OS). tsx via npx.
export PATH="$HOME/.local/bin:$PATH"

echo "=== [$(date -Is)] NeuralEdge GPU overnight run ===" | tee -a "$LOG"
echo "SAMPLES=$SAMPLES EPOCHS=$EPOCHS QUICK=${QUICK:-0}" | tee -a "$LOG"

echo "--- [1/3] generating dataset (CPU) ---" | tee -a "$LOG"
npx tsx scripts/dumpNeuralData.ts "$SAMPLES" 2>&1 | tee -a "$LOG"

echo "--- [2/3] training + sweep (GPU) ---" | tee -a "$LOG"
EPOCHS="$EPOCHS" .venv/bin/python scripts/gpu/train_neural_gpu.py 2>&1 | tee -a "$LOG"

echo "--- [3/3] verifying export is a faithful TS drop-in ---" | tee -a "$LOG"
npx tsx scripts/gpu/verifyExport.ts 2>&1 | tee -a "$LOG"

echo "=== [$(date -Is)] done. report: scripts/gpu/out/sweep-report.md ===" | tee -a "$LOG"
