#!/usr/bin/env bash
# Real-app screenshots for #285 (rebindable keyboard shortcuts), through the verify-hermes-chat skill against its
# stand-in dashboard. Run after `hv up` and `wd.mjs open` on a fresh run:
#   HV_RUN=<run> docs/screenshots/keyboard-shortcuts-285/setup/shots.sh <out dir>
# It signs in, rebinds Search all chats to Ctrl+J on Settings → Keyboard Shortcuts, shows the Custom badge, a hint
# with the new chord, a conflict, then relaunches the app and shows Ctrl+J still opens Search. Shots land in <out dir>.
set -euo pipefail
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
OUT=${1:?out dir}
mkdir -p "$OUT"
. "$HV_RUN/state.env"
W=60000
shot() { "$S/wd.mjs" shot "$OUT/$1.png" >/dev/null; echo "shot $1"; }
wd() { "$S/wd.mjs" "$@"; }

sign_in_first() {
  wd wait button "Get started" $W
  wd click button "Get started"
  wd select select "Connect through" -- "Web address"
  wd fill input "Dashboard URL" -- "$DASHBOARD_URL"
  wd click button "Test the route"
  wd wait '[role=status]' "Reached Hermes" $W
  wd click button Next
  wd fill input "Dashboard username" -- verify
  wd fill input "Dashboard password" -- verify-pass
  wd click button "Test connection"
  wd wait '[role=status]' "At least one route works" $W
  wd click button "Save and connect"
  wd wait .setup-ok "You're ready to chat" $W
  wd click button Skip
  wd gone '[role=dialog]' $W
}

sign_in_again() {
  wd wait button Connect $W
  wd fill input "Dashboard password" -- verify-pass
  wd click button Connect
  wd wait button "Search all chats" $W
}

keyboard_page() {
  wd click button Settings
  wd wait '[role=tab]' "Keyboard Shortcuts" $W
  wd click '[role=tab]' "Keyboard Shortcuts"
  wd wait h2 Navigation $W
}

back_to_chat() {
  wd click button "Back to chat"
  wd gone '[role=tab]' $W
}

sign_in_first
keyboard_page
shot 01-keyboard-shortcuts-page

# Capture: click the chord, press Ctrl+J, Save.
wd click button "Change Search all chats (Ctrl+K)"
wd wait button "New shortcut for Search all chats" $W
wd press Control+j
wd wait ".shortcut-key.recording kbd" J $W
shot 02-capture-ctrl-j
wd click button Save
wd wait button "Change Search all chats (Ctrl+J)" $W
wd wait .badge Custom $W
shot 03-custom-badge

# Every hint reads the new chord: the New chat pane's list and the chat list's Search chats.
back_to_chat
wd press Control+n
wd wait '.empty-keys' "Search chats" $W
echo "empty-chat hint: $(wd text .empty-keys)"
shot 04-hints-name-ctrl-j

# Ctrl+K no longer opens Search; Ctrl+J does.
wd press Control+k
sleep 1
echo "dialogs after Ctrl+K: $(wd count '[role=dialog]')"
wd press Control+j
wd wait '[role=dialog]' Search $W
shot 05-search-opens-on-ctrl-j
wd press Escape
wd gone '[role=dialog]' $W

# A conflict: New chat on Ctrl+J too. Both rows warn, naming the other.
keyboard_page
wd click button "Change New chat (Ctrl+N)"
wd wait button "New shortcut for New chat" $W
wd press Control+j
wd click button Save
wd wait .key-clash "" $W
echo "warnings: $(wd eval "return [...document.querySelectorAll('.key-clash')].map((w) => w.closest('.set-row')?.querySelector('.set-name')?.textContent + ': ' + w.getAttribute('aria-label'))")"
shot 06-conflict-warning
wd click button "Reset New chat"
wd gone '.key-clash' $W
back_to_chat

# Restart: the app quits and starts again; Ctrl+J still opens Search and the page still shows Custom.
wd close
wd open
sign_in_again
wd press Control+j
wd wait '[role=dialog]' Search $W
shot 07-ctrl-j-after-restart
wd press Escape
wd gone '[role=dialog]' $W
keyboard_page
wd wait button "Change Search all chats (Ctrl+J)" $W
echo "after restart: $(wd eval "return document.querySelector('[aria-label^=\"Change Search all chats\"]').getAttribute('aria-label')")"
shot 08-custom-after-restart

# Reset all puts Ctrl+K back.
wd click button "Reset all"
wd wait button "Change Search all chats (Ctrl+K)" $W
shot 09-after-reset-all
echo done
