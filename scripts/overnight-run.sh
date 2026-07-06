#!/bin/bash
set -uo pipefail
# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/overnight-logs

echo "[$(date)] Starting overnight pipeline"
echo "[$(date)]   Job 1: record:ws 21600s (6h real multi-venue tape) -> data/tape-ws-overnight.jsonl"
echo "[$(date)]   Job 2: study:triangular 21600s (6h real live maker-EV capture) -> public/data/triangular-study-overnight.json"
echo "[$(date)]   Job 3: train:search 30 seeds x 180s (~90min, promotes only if it beats current baseline)"

(npm run record:ws -- 21600 data/tape-ws-overnight.jsonl > data/overnight-logs/record.log 2>&1; echo "[$(date)] record:ws exited $?") &
PID1=$!

(npm run study:triangular -- 21600 public/data/triangular-study-overnight.json > data/overnight-logs/triangular.log 2>&1; echo "[$(date)] study:triangular exited $?") &
PID2=$!

# The seed search is internally parallel now; cap it so it leaves cores for the two
# capture jobs above (record:ws + study:triangular) instead of grabbing all 6.
(SEED_SEARCH_CONCURRENCY=4 npm run train:search -- 30 180 > data/overnight-logs/seedsearch.log 2>&1; echo "[$(date)] train:search exited $?") &
PID3=$!

wait $PID1
wait $PID2
wait $PID3

echo "[$(date)] All parallel jobs finished. Starting post-processing on the real tape."

if [ -f data/tape-ws-overnight.jsonl ]; then
  npm run analyze:tape -- data/tape-ws-overnight.jsonl > data/overnight-logs/analyze.log 2>&1
  echo "[$(date)] analyze:tape exited $?"

  npm run study:reversion -- data/tape-ws-overnight.jsonl > data/overnight-logs/reversion.log 2>&1
  echo "[$(date)] study:reversion exited $?"

  npm run train -- --tape data/tape-ws-overnight.jsonl --out data/tape-model-overnight.json > data/overnight-logs/train-tape.log 2>&1
  echo "[$(date)] train --tape exited $?"
else
  echo "[$(date)] WARNING: data/tape-ws-overnight.jsonl not found, skipping tape post-processing"
fi

echo "[$(date)] OVERNIGHT PIPELINE COMPLETE"
