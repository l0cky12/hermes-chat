#!/usr/bin/env bash
# Runs app-probe.js in the real app's page through the verify-hermes-chat skill's WebDriver session, with the host
# frame and prelude from src/hermes/extensionHost.ts, and a listener on 127.0.0.9:47999 that must receive nothing.
# Needs `hv up` and `wd.mjs open` first, with HV_RUN exported. Prints the probe's events and the listener's hits.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
S=$root/.claude/skills/verify-hermes-chat/scripts
out=$(mktemp -d)
python3 -I -c '
import http.server, sys
log = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        open(log, "a").write(self.command + " " + self.path + "\n"); self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b"ok")
    do_POST = do_GET
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.9", 47999), H).serve_forever()
' "$out/hits.log" &
listener=$!
trap 'kill $listener 2>/dev/null; rm -rf "$out"' EXIT
touch "$out/hits.log"
host=$(cd "$root" && node --experimental-strip-types --no-warnings -e 'import("./src/hermes/extensionHost.ts").then((m) => console.log(JSON.stringify({ srcdoc: m.SRCDOC, prelude: m.PRELUDE })))')
"$S/wd.mjs" eval "window.__probeHost = $host; $(cat "$here/app-probe.js"); return 'started'" >/dev/null
for _ in $(seq 60); do
  [ "$("$S/wd.mjs" eval "return !!(window.__probe && window.__probe.done)")" = true ] && break
  sleep 0.5
done
"$S/wd.mjs" eval "return window.__probe" | python3 -I -c 'import json, sys; d = json.load(sys.stdin); [print(e[0], json.dumps(e[1])) for e in d["events"] if e[0] != "loop"]; print("loop beats while running:", sum(1 for e in d["events"] if e[0] == "loop")); print("done:", d.get("done"))'
echo "listener hits: $(wc -l < "$out/hits.log")"
cat "$out/hits.log"
