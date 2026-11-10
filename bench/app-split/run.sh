#!/bin/bash
# The bench's split rows timed in the real app: two chats of <turns> turns from bench/fixture.ts side by side, frames
# recorded by probe.js. `stream` (bench/main.tsx splitStream): a long reply streams into each, sampled <samples> times
# for <ms> each. `drag` (bench/run.mjs drag): the divider dragged 30% of the width left and back with real X pointer
# input, a move every 16 ms, <samples> times. Starts its own `hv up` (stand-in with HV_TURNS and HV_LONG_REPLY) and
# signs in, so it needs only `hv build` first.
# `single` is `stream` with one chat and no split (bench/main.tsx stream).
#   bench/app-split/run.sh <turns> <out.jsonl> [samples] [ms per sample] [stream|drag|single]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
turns=${1:?turns} out=${2:?out.jsonl} samples=${3:-3} ms=${4:-8000} mode=${5:-stream}
run=$(HV_TURNS=$turns HV_LONG_REPLY=400 "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
trap '"$S/hv" down >/dev/null 2>&1' EXIT
"$HERE/../clone-profile/signin.sh" >/dev/null
reply() { $W eval "return [...document.querySelectorAll('.pane')].map((p) => [...p.querySelectorAll('.msg.assistant')].at(-1)?.innerText.length ?? 0)" | tr -d ' \n'; }

$W click '.row-open[data-chat=long1]' >/dev/null
$W wait '.msg.assistant' "" 60000 >/dev/null
if [ "$mode" != single ]; then
  $W press 'Control+\' >/dev/null
  $W wait .divider "" 30000 >/dev/null
  $W click '.row-open[data-chat=long2]' >/dev/null
  $W wait '.pane:last-child .msg.assistant' "" 60000 >/dev/null
fi
$W eval "$(cat "$HERE/probe.js")" >/dev/null
record() { echo "{\"turns\":$turns,\"mode\":\"$mode\",\"sample\":$1,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",$2}" >>"$out"; }

if [ "$mode" = drag ]; then
  $W eval 'window.__pt = null; addEventListener("pointermove", (e) => (window.__pt = [e.clientX, e.clientY])); return 1' >/dev/null
  read -r cx cy width < <($W eval 'const d = document.querySelector(".divider").getBoundingClientRect(); return [Math.round(d.left + d.width / 2), Math.round(d.top + d.height / 2), Math.round(document.querySelector(".panes-row").getBoundingClientRect().width)].join(" ")' | tr -d '"')
  "$S/hv" x mousemove 400 400 >/dev/null
  read -r px py < <($W eval 'return (window.__pt ?? []).join(" ")' | tr -d '"')
  [ -n "$px" ] || { echo "drag: no pointermove reached the page" >&2; exit 1; }
  win_x=$((400 - px)) win_y=$((400 - py))
  for i in $(seq 1 "$samples"); do
    path=()
    for k in $(seq 1 30); do path+=(mousemove $((win_x + cx - width * 3 * k / 300)) $((win_y + cy)) sleep 0.016); done
    for k in $(seq 29 -1 1); do path+=(mousemove $((win_x + cx - width * 3 * k / 300)) $((win_y + cy)) sleep 0.016); done
    $W eval 'return window.__split.start()' >/dev/null
    "$S/hv" x mousemove $((win_x + cx)) $((win_y + cy)) sleep 0.1 mousedown 1 sleep 0.05 "${path[@]}" mousemove $((win_x + cx - width / 10)) $((win_y + cy)) mouseup 1
    $W eval 'return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))' >/dev/null
    record "$i" "\"split\":$($W eval 'return window.__split.stop()' | tr -d '\n')"
  done
else
  panes=2
  [ "$mode" = single ] && panes=1
  for pane in $(seq 1 $panes); do
    [ $panes = 1 ] || $W press "Control+$pane" >/dev/null
    [ $panes = 1 ] && $W gone .toast "" 30000 >/dev/null && $W click 'textarea[data-composer]' >/dev/null
    $W keys "long reply, pane $pane\n" >/dev/null
  done
  for pane in $(seq 1 $panes); do
    $W wait ".pane:nth-child($((2 * pane - 1))) .msg.user" "pane $pane" 30000 >/dev/null
    $W wait ".pane:nth-child($((2 * pane - 1))) .msg.assistant" "Step 2:" 60000 >/dev/null
  done
  for i in $(seq 1 "$samples"); do
    a=$(reply)
    sample=$($W eval "return window.__split.sample($ms)" | tr -d '\n')
    record "$i" "\"replyChars\":{\"before\":$a,\"after\":$(reply)},\"split\":$sample"
  done
fi
$W shot "split-$mode-$turns" >/dev/null
tail -n "$samples" "$out"
