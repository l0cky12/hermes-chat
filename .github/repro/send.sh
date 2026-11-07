#!/usr/bin/env bash
# Temporary (#308). Starts the stand-in dashboard and tauri-driver (msedgedriver underneath), drives the real Windows
# app through wd.mjs: Welcome -> Setup -> signed in -> open "Nightly backup failing" -> type -> Enter. Collects
# evidence at every step into $HV_RUN/evidence, and never stops at the first failure: the point is the evidence.
set -uo pipefail
REPO=$(git rev-parse --show-toplevel)
S=$REPO/.claude/skills/verify-hermes-chat/scripts
RUN=${HV_RUN:?}
EV=$RUN/evidence
mkdir -p "$EV"
APP=$REPO/src-tauri/target/release/hermes-chat.exe
[ -f "$APP" ] || { echo "no app at $APP"; exit 1; }
BRIDGE_PORT=47991 DRIVER_PORT=4444 NATIVE_PORT=4445
URL=http://127.0.0.1:$BRIDGE_PORT
BRIDGE_PID= DRIVER_PID=

log() { echo "[$(date +%T)] $*"; }
wd() { log "\$ wd $*"; node "$S/wd.mjs" "$@"; local rc=$?; [ $rc = 0 ] || log "   -> wd exit $rc"; return $rc; }
# Everything we can read at a moment, under one prefix.
evidence() {
  wd shot "$1" || true
  wd html "$1" || true
  wd eval 'return window.__errs ?? "no buffer"' >"$EV/$1-errors.json" 2>&1 || true
  if [ -f "$RUN/session" ]; then
    local sid; sid=$(cat "$RUN/session")
    curl -s -X POST "http://127.0.0.1:$DRIVER_PORT/session/$sid/se/log" -H 'content-type: application/json' -d '{"type":"browser"}' >"$EV/$1-console.json" || true
  fi
  curl -s "$URL/__state" >"$EV/$1-server-state.json" || true
}
cleanup() {
  log "cleanup"
  wd close || true
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" 2>/dev/null
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
  # msedgedriver and the app may outlive tauri-driver.
  taskkill //F //IM msedgedriver.exe >/dev/null 2>&1 || true
  taskkill //F //IM hermes-chat.exe >/dev/null 2>&1 || true
  cp "$RUN/state.env" "$EV/" 2>/dev/null || true
  ls -la "$EV"
}
trap cleanup EXIT

# The stand-in dashboard (FakeHermes behind HTTP/WS), bundled as hv up does.
(cd "$REPO" && npx rolldown "$S/bridge.ts" --platform node -o "$RUN/bridge.mjs") || { echo "bundling the stand-in failed"; exit 1; }
node "$RUN/bridge.mjs" "$BRIDGE_PORT" "$EV/server-state.json" >"$EV/bridge.log" 2>&1 &
BRIDGE_PID=$!
for i in $(seq 1 100); do grep -q "stand-in dashboard ready" "$EV/bridge.log" 2>/dev/null && break; sleep 0.2; done
grep -q "stand-in dashboard ready" "$EV/bridge.log" || { echo "stand-in didn't start"; cat "$EV/bridge.log"; exit 1; }
log "stand-in at $URL"

# tauri-driver proxies WebDriver to msedgedriver, which launches the app and attaches to its WebView2.
export HERMES_CHAT_NEW_INSTANCE=1
tauri-driver --port "$DRIVER_PORT" --native-port "$NATIVE_PORT" --native-driver "${EDGEDRIVER:?}" >"$EV/driver.log" 2>&1 &
DRIVER_PID=$!
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$DRIVER_PORT/status" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$DRIVER_PORT/status" >/dev/null || { echo "tauri-driver didn't answer"; cat "$EV/driver.log"; exit 1; }

cat >"$RUN/state.env" <<STATE
DRIVER_PORT='$DRIVER_PORT'
EVIDENCE='$EV'
APP='$APP'
DASHBOARD_URL='$URL'
STATE

wd open || { cat "$EV/driver.log"; exit 1; }
wd wait button "Get started" 90000 || { evidence 00-no-welcome; exit 1; }
# A buffer for everything the page throws from now on: uncaught errors (React 19 reports a render error through
# reportError, which fires `error` on window), unhandled rejections and console.error.
wd eval "window.__errs = [];
  addEventListener('error', (e) => __errs.push({ type: 'error', message: e.message, file: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack }));
  addEventListener('unhandledrejection', (e) => __errs.push({ type: 'unhandledrejection', reason: String((e.reason && e.reason.stack) || e.reason) }));
  const ce = console.error; console.error = (...a) => { __errs.push({ type: 'console.error', args: a.map((x) => (x && x.stack) || String(x)) }); ce.apply(console, a); };
  return navigator.userAgent;" | tee "$EV/user-agent.txt"
wd shot 00-welcome
wd handles >"$EV/00-handles.txt"

# Sign in (features/sign-in.md).
wd click button "Get started"
wd select select "Connect through" -- "Web address"
wd fill input "Dashboard URL" -- "$URL"
wd click button "Test the route"
wd wait '[role=status]' "Reached Hermes 0.17.0" 30000 || evidence 01-route-failed
wd shot 01-route
wd click button Next
wd fill input "Dashboard username" -- verify
wd fill input "Dashboard password" -- verify-pass
wd click button "Test connection"
wd wait '[role=status]' "At least one route works" 30000 || evidence 02-test-failed
wd click button "Save and connect"
wd wait '[role=dialog]' "Model providers" 30000 || evidence 03-no-providers-dialog
wd wait .setup-ok "You're ready to chat" 30000 || evidence 03-providers-not-ready
wd click button Skip
wd gone '[role=dialog]' 15000 || evidence 03-dialog-stayed
wd shot 04-signed-in
wd handles >"$EV/04-handles.txt"

# Send a message (features/send-message.md).
wd click button Settled
wd click '.row-open[data-chat=backup]'
wd wait .msg.assistant "restic unlock" 20000 || evidence 05-chat-not-open
evidence 05-chat-open
wd fill 'textarea[data-composer]' -- "Did the re-run finish?"
evidence 06-typed
wd press Enter
log "Enter pressed; waiting for the user message to show"
if wd wait .msg.user "Did the re-run finish?" 15000; then echo "USER_MESSAGE_SHOWN=yes" >>"$EV/result.txt"; else echo "USER_MESSAGE_SHOWN=no" >>"$EV/result.txt"; fi
evidence 07-after-send
wd eval 'return { rootChildren: document.getElementById("root")?.children.length, bodyText: document.body.innerText.slice(0, 400) }' | tee "$EV/07-root.json"
if wd wait .msg.assistant "Stand-in reply to: Did the re-run finish?" 30000; then echo "REPLY_SHOWN=yes" >>"$EV/result.txt"; else echo "REPLY_SHOWN=no" >>"$EV/result.txt"; fi
evidence 08-replied
if grep -q "Did the re-run finish" "$EV/08-replied-server-state.json" 2>/dev/null; then echo "SERVER_HAS_MESSAGE=yes" >>"$EV/result.txt"; else echo "SERVER_HAS_MESSAGE=no" >>"$EV/result.txt"; fi

# The send button too, in case Enter and the button differ.
wd fill 'textarea[data-composer]' -- "And the next one?" || true
wd click button.send || true
if wd wait .msg.user "And the next one?" 15000; then echo "BUTTON_MESSAGE_SHOWN=yes" >>"$EV/result.txt"; else echo "BUTTON_MESSAGE_SHOWN=no" >>"$EV/result.txt"; fi
evidence 09-after-button-send
echo "=== result"; cat "$EV/result.txt"
echo "=== errors after send"; cat "$EV/07-after-send-errors.json"
echo "=== bridge.log tail"; tail -40 "$EV/bridge.log"
