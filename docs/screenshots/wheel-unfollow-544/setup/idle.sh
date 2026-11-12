#!/bin/bash
# Two chats of 800 turns side by side and no reply streaming: 5 wheel notches up, 80 ms apart, over the right pane.
# Prints each pane's distance from the bottom 2 s later. Needs only `hv build` first.
#   docs/screenshots/wheel-unfollow-544/setup/idle.sh
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$HERE" rev-parse --show-toplevel)"
S=$PWD/.claude/skills/verify-hermes-chat/scripts; W=$S/wd.mjs
export PATH=$HOME/.cargo/bin:$PATH
export HV_RUN=$(HV_TURNS=800 HV_LONG_REPLY=400 "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
trap '"$S/hv" down >/dev/null 2>&1' EXIT
bench/clone-profile/signin.sh >/dev/null
gaps() { $W eval 'return [...document.querySelectorAll(".pane .transcript")].map((t) => Math.round(t.scrollHeight - t.scrollTop - t.clientHeight)).join(" ")' | tr -d '"'; }
$W click '.row-open[data-chat=long1]' >/dev/null; $W wait '.msg.assistant' "" 60000 >/dev/null
$W press 'Control+\' >/dev/null; $W wait .divider "" 30000 >/dev/null
$W click '.row-open[data-chat=long2]' >/dev/null; $W wait '.pane:last-child .msg.assistant' "" 60000 >/dev/null
for _ in $(seq 1 50); do [ "$(gaps)" = "0 0" ] && break; sleep 0.2; done
$W eval 'window.__pt = null; addEventListener("pointermove", (e) => (window.__pt = [e.clientX, e.clientY])); return 1' >/dev/null
"$S/hv" x mousemove 400 400 >/dev/null
read -r px py < <($W eval 'return (window.__pt ?? []).join(" ")' | tr -d '"')
read -r tx ty < <($W eval 'const r = document.querySelectorAll(".pane .transcript")[1].getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(" ")' | tr -d '"')
echo "before: gaps $(gaps)"
"$S/hv" x mousemove $((400 - px + tx)) $((400 - py + ty)) sleep 0.1 click --repeat 5 --delay 80 4 >/dev/null
sleep 2; echo "5 notches up, no reply streaming: gaps $(gaps)"
