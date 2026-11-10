"""OpenAI-compatible stand-in model for the #390 live check (stdlib only).

A user message with ASKCLARIFY makes the model call `clarify` with two questions; ASKSUDO, `terminal` with
`./sudo apt-get install -y ripgrep` (the stand-in `sudo` in the terminal's working folder, never the real one); ASKSECRET,
`skill_view` on a skill whose API key is missing.
With SLOW too, the reply after the tool result waits 20 s first. After a tool result the reply is
`GOT <tool>: <result>`. Anything else gets "ok". Every request is one JSON line in requests.log.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

L = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(L, "requests.log"), "a", buffering=1)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def reply_for(messages):
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    if last_user < 0:
        return {"text": "ok"}
    asked = text_of(messages[last_user].get("content"))
    tool = next((m for m in messages[last_user + 1:] if m.get("role") == "tool"), None)
    if tool is not None:
        if "SLOW" in asked:
            time.sleep(20)
        name = tool.get("name") or tool.get("tool_name") or "tool"
        return {"text": "GOT %s: %s" % (name, text_of(tool.get("content"))[:600])}
    n = last_user
    if "ASKCLARIFY" in asked:
        args = {"questions": [
            {"question": "Which logs should I clear?", "choices": ["Only old ones", "All of them"]},
            {"question": "When should I run it?"}]}
        return {"tool": {"id": "call_clarify_%d" % n, "name": "clarify", "arguments": json.dumps(args)}}
    if "ASKSUDO" in asked:
        args = {"command": "./sudo apt-get install -y ripgrep"}
        return {"tool": {"id": "call_sudo_%d" % n, "name": "terminal", "arguments": json.dumps(args)}}
    if "ASKSECRET" in asked:
        return {"tool": {"id": "call_secret_%d" % n, "name": "skill_view", "arguments": json.dumps({"name": "weather-check"})}}
    return {"text": "ok"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "fake", "object": "model", "context_length": 64000}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": "not found"})
        out = reply_for(body.get("messages") or [])
        LOG.write(json.dumps({"t": time.time(), "stream": bool(body.get("stream")), "out": out,
                              "tools": [t.get("function", {}).get("name") for t in body.get("tools") or []][:80]}) + "\n")
        created = int(time.time())
        if not body.get("stream"):
            msg = {"role": "assistant", "content": out.get("text")}
            finish = "stop"
            if "tool" in out:
                t = out["tool"]
                msg["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}}]
                finish = "tool_calls"
            return self._json(200, {"id": "c1", "object": "chat.completion", "created": created, "model": "fake",
                                    "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def chunk(delta, finish=None):
            c = {"id": "c1", "object": "chat.completion.chunk", "created": created, "model": "fake",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())

        if "tool" in out:
            t = out["tool"]
            chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": t["id"], "type": "function",
                                                         "function": {"name": t["name"], "arguments": t["arguments"]}}]})
            chunk({}, "tool_calls")
        else:
            chunk({"role": "assistant", "content": out["text"]})
            chunk({}, "stop")
        usage = {"id": "c1", "object": "chat.completion.chunk", "created": created, "model": "fake", "choices": [],
                 "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        self.wfile.write(f"data: {json.dumps(usage)}\n\ndata: [DONE]\n\n".encode())
        self.wfile.flush()


ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), Handler).serve_forever()
