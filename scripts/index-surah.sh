#!/bin/bash
#
# Index one surah (or a few) and check the result.
#
# The aligner's own summary line has reported success while dropping verses,
# so this never leaves you reading that line alone - it runs the audit straight
# afterwards and tells you plainly whether the surah is usable.
#
#   npm run index -- 47           one surah, then audit it
#   npm run index -- 47 55 78     several, in the order given
#   FORCE=1 npm run index -- 47   redo one that is already indexed
#   npm run index -- --todo       what is still missing
#   npm run check                 audit everything already indexed
#   npm run check -- 47           audit one surah without re-running it
#
set -u
cd "$(dirname "$0")/.." || exit 1

if [ $# -eq 0 ] || [ "${1:-}" = "--help" ]; then
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit 0
fi
if [ "${1:-}" = "--todo" ]; then exec python3 scripts/check_index.py --todo; fi

# Four aligners on four physical cores run each surah at roughly 4x realtime
# instead of 1.3x, so a "quick" surah is not quick while a batch is going.
busy=$(pgrep -fc "python3 scripts/align_tamil.py" || true)
if [ "${busy:-0}" -gt 0 ]; then
  echo "note: $busy aligner(s) already running - this will be several times slower"
  echo
fi

for s in "$@"; do
  n=$(printf "%03d" "$s")
  src="data/$n.mp3"
  if [ ! -f "$src" ]; then echo "surah $n: no audio at $src"; continue; fi

  secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
  echo "=== surah $n ==="
  awk -v d="$secs" -v b="${busy:-0}" 'BEGIN {
    r = (b > 0 ? 4.2 : 1.3)
    printf "  %.1f min audio, expect roughly %.0f min\n", d/60, d*r/60 }'

  start=$(date +%s)
  FORCE="${FORCE:-}" python3 scripts/align_tamil.py "$s"
  echo "  took $(( ($(date +%s) - start) / 60 )) min"

  echo "  --- audit ---"
  python3 scripts/check_index.py "$s"
  echo
done
