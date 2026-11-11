#!/bin/bash
# The real app's memory with a long chat open and after switching away (#464). Starts its own `hv up` with the bench's
# long chats (HV_TURNS) and signs in, so it needs only `hv build` first. Records the resident memory of the app's web
# process (WebKitWebProcess on the run's display), in MB, and the `.msg` count: signed in, with `long1` open for
# <settle> seconds, then with the short chat `backup` open for <settle> seconds. One JSON line per run goes to <out>.
#   bench/app-split/memory.sh <turns> <out.jsonl> [settle seconds]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
turns=${1:?turns} out=${2:?out.jsonl} settle=${3:-60}
run=$(HV_TURNS=$turns "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
trap '"$S/hv" down >/dev/null 2>&1' EXIT
. "$HV_RUN/state.env"
"$HERE/../clone-profile/signin.sh" >/dev/null
rss() {
  local p total=0
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = WebKitWebProces ] || continue
    grep -qz "^DISPLAY=$DISPLAY_NUM$" "$p/environ" 2>/dev/null || continue
    total=$((total + $(awk '/^VmRSS:/ { print $2 }' "$p/status")))
  done
  echo $((total / 1024))
}
msgs() { $W count .msg | tr -d ' \n'; }

sleep "$settle"
signed=$(rss)
$W click '.row-open[data-chat=long1]' >/dev/null
$W wait '.msg.assistant' "" 120000 >/dev/null
sleep "$settle"
open=$(rss) openMsgs=$(msgs)
$W click button Settled >/dev/null
$W click '.row-open[data-chat=backup]' >/dev/null
$W wait .msg.assistant "restic unlock" 60000 >/dev/null
sleep "$settle"
away=$(rss) awayMsgs=$(msgs)
echo "{\"turns\":$turns,\"rev\":\"$(cat "${HV_TARGET:-$HOME/.cache/hermes-verify/target}/hv-build-rev" 2>/dev/null || echo ?)\",\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"signedInMB\":$signed,\"openMB\":$open,\"openMsgs\":$openMsgs,\"awayMB\":$away,\"awayMsgs\":$awayMsgs}" | tee -a "$out"
