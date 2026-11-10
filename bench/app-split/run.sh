#!/bin/bash
# The bench's split stream (bench/main.tsx splitStream) timed in the real app: two chats of <turns> turns from
# bench/fixture.ts side by side, a long reply streaming into each, frames sampled by probe.js. Starts its own
# `hv up` (stand-in with HV_TURNS and HV_LONG_REPLY) and signs in, so it needs only `hv build` first.
#   bench/app-split/run.sh <turns> <out.jsonl> [samples] [ms per sample]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
turns=${1:?turns} out=${2:?out.jsonl} samples=${3:-3} ms=${4:-8000}
run=$(HV_TURNS=$turns HV_LONG_REPLY=400 "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
trap '"$S/hv" down >/dev/null 2>&1' EXIT
"$HERE/../clone-profile/signin.sh" >/dev/null
reply() { $W eval "return [...document.querySelectorAll('.pane')].map((p) => [...p.querySelectorAll('.msg.assistant')].at(-1)?.innerText.length ?? 0)" | tr -d ' \n'; }

$W click '.row-open[data-chat=long1]' >/dev/null
$W wait '.msg.assistant' "" 60000 >/dev/null
$W press 'Control+\' >/dev/null
$W wait .divider "" 30000 >/dev/null
$W click '.row-open[data-chat=long2]' >/dev/null
$W wait '.pane:last-child .msg.assistant' "" 60000 >/dev/null
for pane in 1 2; do
  $W press "Control+$pane" >/dev/null
  $W keys "long reply, pane $pane\n" >/dev/null
done
$W wait '.pane:first-child .msg.user' "pane 1" 30000 >/dev/null
$W wait '.pane:last-child .msg.user' "pane 2" 30000 >/dev/null
$W wait '.pane:first-child .msg.assistant' "Step 2:" 60000 >/dev/null
$W wait '.pane:last-child .msg.assistant' "Step 2:" 60000 >/dev/null
$W eval "$(cat "$HERE/probe.js")" >/dev/null
for i in $(seq 1 "$samples"); do
  a=$(reply)
  sample=$($W eval "return window.__split.sample($ms)" | tr -d '\n')
  b=$(reply)
  echo "{\"turns\":$turns,\"sample\":$i,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"replyChars\":{\"before\":$a,\"after\":$b},\"split\":$sample}" >>"$out"
done
$W shot "split-$turns" >/dev/null
tail -n "$samples" "$out"
