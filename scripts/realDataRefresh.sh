#!/bin/bash
# Real-data evidence refresh (camino 1), one command. Given a recorded tape it:
#   1. Analyzes the full session       -> public/data/tape-analysis.json
#   2. Trains the spread-reversion AUC  -> public/data/reversion-study.json
#   3. Splits the tape chronologically (70/30) and runs the walk-forward training
#      on the earlier 70% (train < calibrate < evaluate in time) while settling the
#      later 30% as a frozen cross-regime transfer test -> public/data/operating-point.json
#      (+ recalibrated AET route table in data/tape-model.json, held-out record dump
#      in data/op-records.jsonl for fast refit experiments).
#
# The committed synthetic warm-start (public/model/edge-model.json) is NOT touched:
# tape training writes its own artifacts by design, so the demo keeps the strong
# generator model while /resultados gets fresh, reproducible real-market evidence.
#
#   bash scripts/realDataRefresh.sh data/tape-jetson-XXXX.jsonl
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

TAPE="${1:?usage: realDataRefresh.sh <tape.jsonl>}"
[ -f "$TAPE" ] || { echo "tape not found: $TAPE"; exit 1; }

LINES=$(grep -c . "$TAPE")
echo "[refresh] tape=$TAPE rounds=$LINES @ $(date)"
if [ "$LINES" -lt 200 ]; then
  echo "[refresh] WARNING: only $LINES rounds; the walk-forward split needs more to populate the operating point."
fi

SPLIT=$(( LINES * 70 / 100 ))
TRAIN="${TAPE%.jsonl}-train.jsonl"
EVAL="${TAPE%.jsonl}-eval.jsonl"
head -n "$SPLIT" "$TAPE" > "$TRAIN"
tail -n +"$((SPLIT + 1))" "$TAPE" > "$EVAL"
echo "[refresh] chronological split -> train=$(grep -c . "$TRAIN") eval=$(grep -c . "$EVAL")"

echo "[refresh] 1/3 analyze:tape ..."
npm run analyze:tape -- "$TAPE" public/data/tape-analysis.json; echo "[refresh] analyze:tape exit $?"

echo "[refresh] 2/3 study:reversion ..."
npm run study:reversion -- "$TAPE" public/data/reversion-study.json; echo "[refresh] study:reversion exit $?"

echo "[refresh] 3/3 train --tape (walk-forward + cross-regime transfer) ..."
npm run train -- --tape "$TRAIN" --split temporal \
  --opOut public/data/operating-point.json \
  --evalTape "$EVAL" \
  --dumpRecords data/op-records.jsonl \
  --out data/tape-model.json; echo "[refresh] train --tape exit $?"

echo "[refresh] COMPLETE @ $(date)"
