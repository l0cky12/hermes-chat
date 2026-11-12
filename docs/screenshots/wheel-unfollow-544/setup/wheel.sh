#!/bin/bash
# #544 in the real app, <runs> times: pane-follow-512's `drag.sh 800 wheel` (12 wheel notches up over a pane that a long
# reply streams into) with probe.js logging the pane's wheel (w<deltaY>), key (k<key>@<focus>) and scroll events
# (s<px from the bottom><u if the view moved up, else d>). Then, each from the bottom while the reply streams: one wheel
# notch up, and one ArrowUp after a click in the pane. Prints the right pane's distance from the bottom 1 s and 4 s after
# each. Needs only `hv build` first.
#   docs/screenshots/wheel-unfollow-544/setup/wheel.sh <shot prefix> <runs>
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$HERE" rev-parse --show-toplevel)"
S=$PWD/.claude/skills/verify-hermes-chat/scripts
export PATH=$HOME/.cargo/bin:$PATH
gaps() { $S/wd.mjs eval 'return [...document.querySelectorAll(".pane .transcript")].map((t) => Math.round(t.scrollHeight - t.scrollTop - t.clientHeight)).join(" ")' | tr -d '"'; }
log() { $S/wd.mjs eval 'const l = window.__log; const i = l.findIndex((x) => x[0] === "w"); const r = l.slice(i); window.__log = []; return r.join(" ")' | tr -d '"'; }
# Real wheel down first. If the streaming reply outruns it, the view is set to the bottom, and `how` says so.
bottom() {
  $S/hv x click --repeat 250 --delay 25 5 >/dev/null
  for _ in $(seq 1 25); do [ "$(gaps)" = "0 0" ] && break; sleep 0.2; done
  how=wheel
  if [ "$(gaps)" != "0 0" ]; then how=set; $S/wd.mjs eval 'const t = document.querySelectorAll(".pane .transcript")[1]; t.scrollTop = t.scrollHeight; return 1' >/dev/null; fi
  sleep 2
}
for i in $(seq 1 "$2"); do
  echo "== $1 run $i"
  out=$(KEEP=1 PROBE=$HERE/probe.js docs/screenshots/pane-follow-512/setup/drag.sh 800 wheel "$1-$i" 2>&1)
  echo "$out" | grep -E "4 s later|wheel up|failed|rror"
  export HV_RUN=$(echo "$out" | sed -n 's/^export HV_RUN=//p')
  echo "12 notches, probe: $(log | cut -c1-400)"
  bottom
  sleep 2; $S/wd.mjs eval 'window.__log = []; return 1' >/dev/null
  echo "back at bottom ($how), 2 s later still streaming: gaps $(gaps)"
  $S/hv x click 4 >/dev/null; sleep 1; a=$(gaps); sleep 3
  echo "1 notch: gaps $a, 3 s later $(gaps); probe: $(log | cut -c1-200)"
  $S/wd.mjs shot "$1-$i-5-one-notch" >/dev/null
  bottom
  echo "back at bottom ($how), 2 s later: gaps $(gaps)"
  $S/hv x click 1 >/dev/null; sleep 0.5; $S/wd.mjs eval 'window.__log = []; return 1' >/dev/null
  $S/hv x key Up >/dev/null; sleep 1; a=$(gaps); sleep 3
  echo "ArrowUp x1: gaps $a, 3 s later $(gaps); probe: $($S/wd.mjs eval 'return window.__log.slice(0, 30).join(" ")' | tr -d '"')"
  $S/hv down >/dev/null 2>&1
done
