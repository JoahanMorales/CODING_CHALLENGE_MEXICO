#!/usr/bin/env bash
# Horizon sweep for the real-tape spread-reversion signal: does the markout horizon
# (LOOKAHEAD, in rounds) change how learnable OR how tradeable the reversion is? For
# each horizon we dump the labelled set (observeBook live), train the MLP, and run the
# tradeability backtest. Writes a per-horizon model/report/backtest so the morning read
# is a clean matrix: horizon -> AUC, gross reversion bps, net vs fees.
#
# Long-running (multiple full-tape streaming dumps + GPU trainings). Safe to leave
# unattended: NOT `set -e`, so one bad horizon doesn't abort the rest; everything is
# logged; only writes to git-ignored scripts/gpu/{data,out}.
#
#   scripts/gpu/horizon_sweep.sh
#   HORIZONS="4 16 32" TAPE=data/tape-XXXX.jsonl scripts/gpu/horizon_sweep.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"

TAPE="${TAPE:-data/tape-jetson-overnight-20260705-233226.jsonl}"
HORIZONS="${HORIZONS:-4 16 32}"
OUT=scripts/gpu/out
mkdir -p "$OUT" scripts/gpu/data
LOG="$OUT/horizon-sweep.log"

echo "=== [$(date -Is)] horizon sweep · tape=$TAPE · horizons=[$HORIZONS] ===" | tee -a "$LOG"
for H in $HORIZONS; do
  BIN="scripts/gpu/data/reversion-h${H}.f32"
  META="scripts/gpu/data/reversion-h${H}.meta.json"
  echo "--- [$(date -Is)] LOOKAHEAD=$H · [1/3] dump (observeBook, streaming) ---" | tee -a "$LOG"
  LOOKAHEAD="$H" npx tsx scripts/dumpReversionData.ts "$TAPE" "$BIN" 2>&1 | tee -a "$LOG"

  echo "--- [$(date -Is)] LOOKAHEAD=$H · [2/3] train MLP (GPU) ---" | tee -a "$LOG"
  DATA="$BIN" META="$META" OUT_MODEL="$OUT/neural-edge-reversion-h${H}.json" \
    TAG="reversion-h${H}" COMPARE_COMMITTED=0 SWEEP=small EPOCHS=120 BATCH=2048 \
    .venv/bin/python scripts/gpu/train_neural_gpu.py 2>&1 | tee -a "$LOG"

  echo "--- [$(date -Is)] LOOKAHEAD=$H · [3/3] tradeability backtest ---" | tee -a "$LOG"
  LOOKAHEAD="$H" npx tsx scripts/reversionBacktest.ts "$TAPE" "$OUT/reversion-backtest-h${H}.json" 2>&1 | tee -a "$LOG"
done

echo "=== [$(date -Is)] horizon sweep DONE. Matrix: $OUT/reversion-h*-report.json + reversion-backtest-h*.json ===" | tee -a "$LOG"
