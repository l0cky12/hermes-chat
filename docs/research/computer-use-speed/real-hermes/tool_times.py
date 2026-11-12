"""Times Hermes's own computer_use tool on a Bot Desktop, call by call, as one agent step runs it.

Run on the server, from the hermes-agent checkout, against a throwaway HERMES_HOME whose Bot Desktop is running and
whose config has `approvals: {mode: "off"}` (so no click waits for a person) and `agent: {image_input_mode: native}`:

    HERMES_HOME=<home> DISPLAY=:<n> XAUTHORITY=<home>/bot-desktop/Xauthority venv/bin/python tool_times.py
"""
import json
import statistics
import sys
import time

sys.path.insert(0, ".")
from tools.computer_use.tool import handle_computer_use


def run(args, n):
    times, size = [], None
    for _ in range(n):
        t = time.perf_counter()
        r = handle_computer_use(dict(args), session_id="bench172")
        times.append((time.perf_counter() - t) * 1000)
        size = len(json.dumps(r)) if isinstance(r, dict) else len(r)
    return times, size


t = time.perf_counter()
handle_computer_use({"action": "list_apps"}, session_id="bench172")
print("first call (starts cua-driver):", round((time.perf_counter() - t) * 1000), "ms")
for label, args, n in [
    ("capture som", {"action": "capture", "mode": "som"}, 5),
    ("capture vision", {"action": "capture", "mode": "vision"}, 5),
    ("capture ax", {"action": "capture", "mode": "ax"}, 5),
    ("click", {"action": "click", "coordinate": [720, 450]}, 5),
    ("key", {"action": "key", "keys": "s"}, 5),
    ("click + capture_after", {"action": "click", "coordinate": [720, 450], "capture_after": True}, 5),
]:
    xs, size = run(args, n)
    print(f"{label}: n={len(xs)} p50={round(statistics.median(xs))} ms max={round(max(xs))} ms, result {size} chars")
