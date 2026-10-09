#!/bin/sh
# sh bench/fuzz/parity_sweep.sh CASEDIR -> VLC script vs browser engine on every valid-UTF-8 .srt fuzz case, all modes.
# (Files that aren't valid UTF-8 only ever reach the VLC script, so they're left out.) Prints differing cases.
d=$1; same=0; diff=0
for f in "$d"/*.srt; do
  iconv -f utf-8 -t utf-8 "$f" >/dev/null 2>&1 || continue
  for mode in word chunk off; do
    lua5.1 vlc/test/parity.lua "$f" /tmp/sp_pl.ass $mode 300 >/dev/null 2>&1
    node vlc/test/parity.js "$f" /tmp/sp_pj.ass $mode 300 >/dev/null 2>&1
    # no lines at all: the VLC script returns nothing, the engine an empty .ass - the same result
    if [ ! -s /tmp/sp_pl.ass ] && ! grep -q '^Dialogue' /tmp/sp_pj.ass 2>/dev/null; then same=$((same+1))
    elif cmp -s /tmp/sp_pl.ass /tmp/sp_pj.ass; then same=$((same+1)); else diff=$((diff+1)); echo "  differs: $(basename "$f") ($mode)"; fi
    rm -f /tmp/sp_pl.ass /tmp/sp_pj.ass
  done
done
echo "parity sweep: $same same, $diff different"
[ $diff -eq 0 ]
