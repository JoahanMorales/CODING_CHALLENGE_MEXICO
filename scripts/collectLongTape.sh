#!/bin/bash
# Robust long-horizon real-tape collector for the Jetson. `npm run record` exits
# early (~10-12min, Node exit 13) so this wrapper re-invokes it in a loop, always
# APPENDING to the same tape file (createWriteStream flags:"a"), until the target
# duration elapses. Runs detached so it survives an ended agent session.
#
#   bash scripts/collectLongTape.sh 12 data/tape-jetson-overnight.jsonl   # ~12h
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$PATH"

DUR_HOURS="${1:-12}"
OUT="${2:-data/tape-jetson-overnight-$(date +%Y%m%d-%H%M%S).jsonl}"
mkdir -p data/overnight-logs
LOG="data/overnight-logs/collect-$(date +%Y%m%d-%H%M%S).log"
END=$(( $(date +%s) + $(printf '%.0f' "$(echo "$DUR_HOURS * 3600" | bc 2>/dev/null || echo $((DUR_HOURS*3600)))") ))

echo "[collect] start $(date) target=${DUR_HOURS}h out=$OUT" | tee -a "$LOG"
seg=0
while [ "$(date +%s)" -lt "$END" ]; do
  seg=$((seg + 1))
  echo "[collect] segment $seg start $(date) rounds=$(grep -c . "$OUT" 2>/dev/null || echo 0)" | tee -a "$LOG"
  npm run record -- 1800 "$OUT" >> "$LOG" 2>&1
  echo "[collect] segment $seg exit $? $(date)" | tee -a "$LOG"
  sleep 3
done
echo "[collect] DONE $(date) rounds=$(grep -c . "$OUT" 2>/dev/null)" | tee -a "$LOG"
