#!/usr/bin/env python3
# Runs `window.bench` expressions in WebKitGTK 4.1, the engine the Linux app runs in, as bench/run.mjs does in
# Chromium. Build the page first (`npx vite build --config bench/vite.config.ts`), then run under a display, such as
# `xvfb-run -a -s "-screen 0 1280x900x24" python3 bench/webkit.py 'bench.streamCode(10,false)' ...`.
# Each expression runs in turn in one page; each result prints as a line of JSON, with `rssMB`, the resident memory
# of the page's web process once the expression is done. The expression `settle` waits 10 s, for
# WebKit to collect garbage on its own timers (WebKitGTK 4.1 has no call to force it), then prints the memory.
import functools
import http.server
import json
import os
import sys
import threading

import gi

# On X11 even from a Wayland session, so that under xvfb-run the window opens on Xvfb, not on the desktop.
os.environ.setdefault("GDK_BACKEND", "x11")
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

# BENCH_DIST serves another build of the page, to time two builds in turn.
dist = os.environ.get("BENCH_DIST") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


handler = functools.partial(Quiet, directory=dist)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

expressions = sys.argv[1:]
window = Gtk.Window()
window.set_default_size(1280, 900)
view = WebKit2.WebView()
window.add(view)
window.show_all()
failed = False


def web_rss_mb():
    """The resident memory of the web processes this script started, in MB."""
    total = 0
    pids = [str(os.getpid())]
    while pids:
        pid = pids.pop()
        try:
            for task in os.listdir(f"/proc/{pid}/task"):
                with open(f"/proc/{pid}/task/{task}/children") as f:
                    pids += f.read().split()
            with open(f"/proc/{pid}/comm") as c:
                if not c.read().startswith("WebKitWebProces"):  # /proc keeps 15 characters of the name
                    continue
            with open(f"/proc/{pid}/status") as st:
                total += next(int(line.split()[1]) for line in st if line.startswith("VmRSS:"))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return round(total / 1024)


def settled(i):
    print(json.dumps({"expr": "settle", "rssMB": web_rss_mb()}), flush=True)
    run(i + 1)
    return False


def run(i):
    if i == len(expressions):
        Gtk.main_quit()
        return
    if expressions[i] == "settle":
        GLib.timeout_add_seconds(10, settled, i)
        return

    def done(_view, result):
        global failed
        try:
            value = view.call_async_javascript_function_finish(result)
            print(json.dumps({"expr": expressions[i], "value": json.loads(value.to_json(0)), "rssMB": web_rss_mb()}), flush=True)
        except Exception as e:
            print(json.dumps({"expr": expressions[i], "error": str(e)}), flush=True)
            failed = True
        run(i + 1)

    view.call_async_javascript_function(f"return await ({expressions[i]});", -1, None, None, None, None, done)


def wait_for_bench():
    def done(_view, result):
        if view.evaluate_javascript_finish(result).to_boolean():
            run(0)
        else:
            GLib.timeout_add(100, wait_for_bench)

    view.evaluate_javascript("!!window.bench", -1, None, None, None, done)
    return False


view.connect("load-changed", lambda _v, e: e == WebKit2.LoadEvent.FINISHED and wait_for_bench())
view.load_uri(f"http://127.0.0.1:{server.server_address[1]}/")
GLib.timeout_add_seconds(600, lambda: (print("timed out", file=sys.stderr), sys.exit(2)))
Gtk.main()
sys.exit(1 if failed else 0)
