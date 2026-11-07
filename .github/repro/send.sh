#!/usr/bin/env bash
# Temporary (#308). Starts the stand-in dashboard, the real Windows app with WebView2's remote debugging port on, and
# msedgedriver attached to that port (Microsoft's "attach" approach: the app sets its own WebView2 user data folder, so
# msedgedriver's "launch" approach through tauri-driver waited in vain for DevToolsActivePort in a folder of its own).
# Then drives the app through wd.mjs: Welcome -> Setup -> signed in -> open "Nightly backup failing" -> type -> Enter.
# Collects evidence at every step into $HV_RUN/evidence, and never stops at the first failure: the point is the evidence.
set -uo pipefail
REPO=$(git rev-parse --show-toplevel)
S=$REPO/.claude/skills/verify-hermes-chat/scripts
HERE=$REPO/.github/repro
RUN=${HV_RUN:?}
EV=$RUN/evidence
mkdir -p "$EV"
APP=${APP:-$REPO/src-tauri/target/release/hermes-chat.exe}
[ -f "$APP" ] || { echo "no app at $APP"; exit 1; }
BRIDGE_PORT=47991 DRIVER_PORT=4444 CDP_PORT=9333
URL=http://127.0.0.1:$BRIDGE_PORT
BRIDGE_PID= DRIVER_PID= APP_PID=

log() { echo "[$(date +%T)] $*"; }
wd() { log "\$ wd $*"; node "$S/wd.mjs" "$@"; local rc=$?; [ $rc = 0 ] || log "   -> wd exit $rc"; return $rc; }
desktop() { pwsh -NoProfile -File "$HERE/desktop.ps1" "$EV/$1-desktop.png" >/dev/null 2>&1 || log "no desktop shot"; }
# Everything we can read at a moment, under one prefix.
evidence() {
  wd shot "$1" || true
  desktop "$1"
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
  [ -f "$RUN/session" ] && wd close || true
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" 2>/dev/null
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
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

# The app, started here so its output is kept. Its WebView2 listens on the DevTools port msedgedriver attaches to:
# tauri.repro.conf.json puts --remote-debugging-port in its browser arguments, since the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
# override did nothing against the arguments wry sets (run 2). HERMES_CHAT_NEW_INSTANCE keeps it from handing over to
# another Hermes Chat.
env HERMES_CHAT_NEW_INSTANCE=1 "$APP" >"$EV/app-stdout.log" 2>"$EV/app-stderr.log" &
APP_PID=$!
log "app pid $APP_PID"
for i in $(seq 1 150); do curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >"$EV/cdp-version.json" 2>/dev/null && break; sleep 0.2; done
curl -s "http://127.0.0.1:$CDP_PORT/json/list" >"$EV/cdp-targets.json" 2>/dev/null
tasklist | grep -i "hermes-chat\|msedgewebview2\|msedgedriver" >"$EV/processes.txt" 2>&1 || true
ls -la "$LOCALAPPDATA/net.l0cky12.hermes-chat/EBWebView" >"$EV/webview-udf.txt" 2>&1 || true
desktop 00-launched
if ! [ -s "$EV/cdp-version.json" ]; then
  echo "the app's WebView2 never answered on port $CDP_PORT"
  echo "=== app-stderr.log"; cat "$EV/app-stderr.log"; echo "=== processes"; cat "$EV/processes.txt"; echo "=== udf"; cat "$EV/webview-udf.txt"
  exit 1
fi
log "WebView2 DevTools: $(cat "$EV/cdp-version.json" | tr -d '\n' | cut -c1-200)"

# msedgedriver, attached to that WebView2 (debuggerAddress; webviewOptions is for its launch mode only and is refused
# here, run 3), gives the W3C WebDriver wd.mjs speaks.
"${EDGEDRIVER:?}" --port=$DRIVER_PORT >"$EV/driver.log" 2>&1 &
DRIVER_PID=$!
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$DRIVER_PORT/status" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$DRIVER_PORT/status" >/dev/null || { echo "msedgedriver didn't answer"; cat "$EV/driver.log"; exit 1; }

cat >"$RUN/state.env" <<STATE
DRIVER_PORT='$DRIVER_PORT'
EVIDENCE='$EV'
APP='$APP'
DASHBOARD_URL='$URL'
STATE
session=$(curl -s -X POST "http://127.0.0.1:$DRIVER_PORT/session" -H 'content-type: application/json' \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"browserName\":\"webview2\",\"ms:edgeOptions\":{\"debuggerAddress\":\"localhost:$CDP_PORT\"}}}}")
echo "$session" >"$EV/session.json"
sid=$(node -e 'const v=JSON.parse(process.argv[1]).value; if(!v||!v.sessionId){console.error(process.argv[1]);process.exit(1)} console.log(v.sessionId)' "$session") || { echo "no WebDriver session"; cat "$EV/driver.log"; exit 1; }
echo -n "$sid" >"$RUN/session"
log "WebDriver session $sid"

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
echo "=== app stderr"; cat "$EV/app-stderr.log"
echo "=== bridge.log tail"; tail -40 "$EV/bridge.log"
