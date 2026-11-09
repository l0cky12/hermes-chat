#!/usr/bin/env bash
# Live proof for #311: a chat whose background subagents run stays in Working across an app relaunch, read from
# subagent.roster without being opened, through its wake turn, and lands in the Inbox once that turn ends.
# Run after `hv build` and `hv up`, with HV_RUN exported.
set -euo pipefail
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
. "$HV_RUN/state.env"
B="http://127.0.0.1:$BRIDGE_PORT"
sections() { $S/wd.mjs eval 'return [...document.querySelectorAll("[data-section-head]")].map(h=>h.dataset.sectionHead+":"+h.querySelector(".count").textContent).join(" ")+" | hourglass="+[...document.querySelectorAll(".row-wait")].map(w=>w.getAttribute("aria-label")).join(",")'; }
signin() { $S/wd.mjs wait button Connect 60000; $S/wd.mjs fill input "Dashboard password" -- verify-pass; $S/wd.mjs click button Connect; $S/wd.mjs wait button "Search all chats (Ctrl+K)" 60000; }

$S/wd.mjs open
$S/wd.mjs wait button "Get started" 60000
$S/wd.mjs click button "Get started"
$S/wd.mjs select select "Connect through" -- "Web address"
$S/wd.mjs fill input "Dashboard URL" -- "$DASHBOARD_URL"
$S/wd.mjs click button "Test the route"
$S/wd.mjs wait '[role=status]' "Reached Hermes 0.17.0" 60000
$S/wd.mjs click button Next
$S/wd.mjs fill input "Dashboard username" -- verify
$S/wd.mjs fill input "Dashboard password" -- verify-pass
$S/wd.mjs click button "Test connection"
$S/wd.mjs wait '[role=status]' "At least one route works" 90000
$S/wd.mjs click button "Save and connect"
$S/wd.mjs wait .setup-ok "You're ready to chat" 60000
$S/wd.mjs click button Skip
$S/wd.mjs gone '[role=dialog]' "" 30000

$S/wd.mjs click button "New chat (Ctrl+N)"
# The keyring toast (expected on the private bus) covers the composer for a while after sign-in.
for i in $(seq 1 30); do $S/wd.mjs click 'textarea[data-composer]' 2>/dev/null && break; sleep 1; done
$S/wd.mjs keys 'research the auth flow in the background\n'
$S/wd.mjs wait .msg "Two subagents are on it" 60000
$S/wd.mjs wait '.row-wait[aria-label="Waiting on 2 subagents"]' "" 30000
C=$($S/wd.mjs eval 'return document.querySelector(".row-wait").closest("[data-chat]").dataset.chat' | tr -d '"')
echo "chat $C"; echo "before relaunch: $(sections)"
$S/wd.mjs shot 01-waiting-before-relaunch

# Another chat open, so the relaunch doesn't reopen (and resume) the waiting one.
$S/wd.mjs click '[data-section-head=settled]'
$S/wd.mjs click '.row-open[data-chat=backup]'
$S/wd.mjs wait .chat-title "Nightly backup"
$S/wd.mjs close
MARK=$(wc -l < "$EVIDENCE/bridge.log")
$S/wd.mjs open
signin
$S/wd.mjs wait '.row-wait[aria-label="Waiting on 2 subagents"]' "" 30000
echo "after relaunch: $(sections)"
$S/wd.mjs shot 02-after-relaunch-still-working
echo "resumes since relaunch:"; tail -n +$((MARK + 1)) "$EVIDENCE/bridge.log" | grep "WS session.resume" || true
echo "roster reads since relaunch: $(tail -n +$((MARK + 1)) "$EVIDENCE/bridge.log" | grep -c "WS subagent.roster")"

curl -fs -X POST "$B/__subagent?id=sa-1&status=completed" >/dev/null
curl -fs -X POST "$B/__subagent?id=sa-2&status=completed" >/dev/null
curl -fs -X POST "$B/__live?profile=default&id=$C&status=working" >/dev/null
echo "$(date -u +%T) subagents ended, wake turn running"
for i in $(seq 1 12); do sleep 5; echo "$(date -u +%T) $(sections)"; done
$S/wd.mjs shot 03-subagents-ended-wake-turn-running

curl -fs -X POST "$B/__live?profile=default&id=$C&status=end" >/dev/null
echo "$(date -u +%T) wake turn ended"
$S/wd.mjs gone '.row-wait' "" 30000
echo "$(date -u +%T) $(sections)"
$S/wd.mjs shot 04-wake-turn-ended-inbox
echo "roster reads:"; grep "WS subagent.roster" "$EVIDENCE/bridge.log" | cut -c12-23 | tr '\n' ' '; echo
