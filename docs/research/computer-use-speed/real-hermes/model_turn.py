"""Times one computer-use model turn on OpenRouter: the request Hermes would send after N screenshots.

Each request has the real `computer_use` schema, a short task, and N earlier tool results carrying the same real Bot
Desktop capture. `images` varies N and the screenshot's size; `effort` varies the reasoning effort at N=3.
The key comes from OPENROUTER_API_KEY in ~/.hermes/.env and is never printed.

    venv/bin/python model_turn.py <model> <capture.png> images|effort
"""
import base64
import io
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, ".")
from PIL import Image
from tools.computer_use.schema import COMPUTER_USE_SCHEMA as SCHEMA

model, capture, experiment = sys.argv[1:4]
key = next(line.split("=", 1)[1].strip().strip('"') for line in open(os.path.expanduser("~/.hermes/.env")) if line.startswith("OPENROUTER_API_KEY="))
img = Image.open(capture).convert("RGB")


def encoded(width, quality):
    im = img if width >= img.width else img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), len(buf.getvalue())


def turn(n_images, width, quality, effort=None):
    url, size = encoded(width, quality)
    msgs = [{"role": "system", "content": "You drive a Linux desktop with the computer_use tool. Act, don't explain."},
            {"role": "user", "content": "Scroll the article down until Section 30 is visible, then click its heading."}]
    for i in range(n_images):
        call = {"action": "capture", "mode": "vision"} if i % 2 == 0 else {"action": "key", "keys": "s"}
        msgs.append({"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{i}", "type": "function", "function": {"name": "computer_use", "arguments": json.dumps(call)}}]})
        msgs.append({"role": "tool", "tool_call_id": f"call_{i}", "content": [{"type": "text", "text": "Captured the screen."}, {"type": "image_url", "image_url": {"url": url}}]})
    body = {"model": model, "messages": msgs, "max_tokens": 8000, "usage": {"include": True},
            "tools": [{"type": "function", "function": {"name": "computer_use", "description": SCHEMA["description"], "parameters": SCHEMA["parameters"]}}]}
    if effort:
        body["reasoning"] = {"effort": effort}
    data = json.dumps(body).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=data, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=180) as r:
        out = json.load(r)
    ms = (time.perf_counter() - t) * 1000
    usage, msg = out.get("usage", {}), out["choices"][0]["message"]
    did = msg["tool_calls"][0]["function"]["arguments"][:60] if msg.get("tool_calls") else (msg.get("content") or "")[:60]
    return f"{ms:.0f} ms, request {len(data) // 1024} kB, prompt {usage.get('prompt_tokens')} tok, out {usage.get('completion_tokens')} tok ({size // 1024} kB each) -> {did!r}"


runs = ([(1, 1440, 85, None), (1, 1440, 85, None), (5, 1440, 85, None), (10, 1440, 85, None), (20, 1440, 85, None), (1, 1024, 70, None), (1, 1024, 70, None), (10, 1024, 70, None)]
        if experiment == "images" else [(3, 1440, 85, e) for e in ["high", "high", "high", "medium", "medium", "low", "low"]])
for n, width, quality, effort in runs:
    label = f"images={n} {width}px q{quality}" + (f" effort={effort}" if effort else "")
    try:
        print(f"{model} {label}: {turn(n, width, quality, effort)}", flush=True)
    except Exception as e:  # noqa: BLE001 - one failed request shouldn't end the series
        print(f"{model} {label}: failed {e}", flush=True)
