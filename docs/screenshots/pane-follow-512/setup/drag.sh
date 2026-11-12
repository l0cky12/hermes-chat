#!/bin/bash
# #512 in the real app: two chats of <turns> turns side by side, both at the bottom, the divider dragged from 50% to 34%
# with real X pointer input (a move every 50 ms), then released. Prints each pane's distance from the bottom after the
# release. `stream`: a long reply streams into the right pane through the drag, and the distance is read again 4 s later,
# then after the owner turns the mouse wheel up over that pane. `wheel`: `stream` without the drag. PROBE=<file> evals a probe before the drag and prints
# its `window.__log` after.
# Starts its own `hv up` and signs in, so it needs only `hv build` first. Leaves the run up when KEEP=1.
#   docs/screenshots/pane-follow-512/setup/drag.sh <turns> <idle|stream|wheel> <shot prefix>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
S=$REPO/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
turns=${1:?turns} mode=${2:?idle|stream} prefix=${3:?shot prefix}
run=$(HV_TURNS=$turns HV_LONG_REPLY=400 "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
[ "${KEEP:-}" = 1 ] && echo "export HV_RUN=$run" || trap '"$S/hv" down >/dev/null 2>&1' EXIT
"$REPO/bench/clone-profile/signin.sh" >/dev/null

gaps() {
  $W eval 'return [...document.querySelectorAll(".pane .transcript")].map((t) => Math.round(t.scrollHeight - t.scrollTop - t.clientHeight)).join(" ")' | tr -d '"'
}

$W click '.row-open[data-chat=long1]' >/dev/null
$W wait '.msg.assistant' "" 60000 >/dev/null
$W press 'Control+\' >/dev/null
$W wait .divider "" 30000 >/dev/null
$W click '.row-open[data-chat=long2]' >/dev/null
$W wait '.pane:last-child .msg.assistant' "" 60000 >/dev/null
if [ "$mode" != idle ]; then
  $W press 'Control+2' >/dev/null
  $W keys "long reply, right pane\n" >/dev/null
  $W wait '.pane:last-child .msg.assistant' "Step 2:" 60000 >/dev/null
fi
for _ in $(seq 1 50); do [ "$(gaps)" = "0 0" ] && break; sleep 0.2; done
echo "before drag: share $($W eval 'return document.querySelector(".divider").getAttribute("aria-valuenow")' | tr -d '"')%, gaps $(gaps)"
$W shot "$prefix-1-before-drag" >/dev/null

[ -n "${PROBE:-}" ] && $W eval "$(cat "$PROBE")" >/dev/null
$W eval 'window.__pt = null; addEventListener("pointermove", (e) => (window.__pt = [e.clientX, e.clientY])); return 1' >/dev/null
read -r cx cy left width < <($W eval 'const d = document.querySelector(".divider").getBoundingClientRect(); const r = document.querySelector(".panes-row").getBoundingClientRect(); return [Math.round(d.left + d.width / 2), Math.round(d.top + d.height / 2), Math.round(r.left), Math.round(r.width)].join(" ")' | tr -d '"')
"$S/hv" x mousemove 400 400 >/dev/null
read -r px py < <($W eval 'return (window.__pt ?? []).join(" ")' | tr -d '"')
[ -n "$px" ] || { echo "drag: no pointermove reached the page" >&2; exit 1; }
wx=$((400 - px)) wy=$((400 - py))
to=$((left + width * 34 / 100))
path=()
for k in $(seq 1 16); do path+=(mousemove $((wx + cx + (to - cx) * k / 16)) $((wy + cy)) sleep 0.05); done
[ "$mode" = wheel ] || "$S/hv" x mousemove $((wx + cx)) $((wy + cy)) sleep 0.1 mousedown 1 sleep 0.05 "${path[@]}" mouseup 1
sleep 2
echo "after release: share $($W eval 'return document.querySelector(".divider").getAttribute("aria-valuenow")' | tr -d '"')%, gaps $(gaps)"
$W shot "$prefix-2-after-release" >/dev/null
[ -n "${PROBE:-}" ] && $W eval 'return window.__log.join("\n")' 
if [ "$mode" != idle ]; then
  sleep 4
  echo "4 s later, reply streaming: gaps $(gaps)"
  $W shot "$prefix-3-streaming" >/dev/null
  read -r tx ty < <($W eval 'const r = document.querySelectorAll(".pane .transcript")[1].getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(" ")' | tr -d '"')
  "$S/hv" x mousemove $((wx + tx)) $((wy + ty)) sleep 0.1 click --repeat 12 --delay 30 4 >/dev/null
  sleep 1
  a=$(gaps)
  sleep 3
  echo "wheel up 12 notches over the right pane: gaps $a, 3 s later $(gaps)"
  $W shot "$prefix-4-wheel-up" >/dev/null
fi
