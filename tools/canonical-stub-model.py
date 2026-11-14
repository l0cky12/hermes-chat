"""A stub OpenAI-compatible model for sessionProtocol.live.test.ts (stdlib only): `canonical-stub-model.py HOST PORT`.

It answers by the last user message:

- with "approve-me": a `terminal` call for a command Hermes asks approval for, then "Tool said: …" with its result.
- with "clarify-me": a `clarify` call ("Tea or coffee?"), then "You said: …" with the answer.
- with "slow": forty words, one every quarter second, so a Stop lands mid-reply.
- anything else: "Stub model reply."
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def call(name, args):
    function = {"name": name, "arguments": json.dumps(args)}
    return {"role": "assistant", "content": None, "tool_calls": [{"id": "call_%d" % int(time.time() * 1000), "type": "function", "function": function}]}


def answer(req):
    """The reply to `req`, and the pause after each word of it."""
    msgs = req.get("messages") or []
    last_user_at = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
    question = text_of(msgs[last_user_at].get("content")).lower() if last_user_at >= 0 else ""
    results = [text_of(m.get("content")) for m in msgs[last_user_at + 1:] if m.get("role") == "tool"]
    tools = [t.get("function", {}).get("name", "") for t in req.get("tools") or []]
    if "approve-me" in question and "terminal" in tools:
        if results:
            return {"role": "assistant", "content": "Tool said: " + results[-1][:200]}, 0.05
        return call("terminal", {"command": "rm -rf /tmp/hermes-chat-canonical-probe-no-such-dir"}), 0.05
    if "clarify-me" in question and "clarify" in tools:
        if results:
            return {"role": "assistant", "content": "You said: " + results[-1][:200]}, 0.05
        return call("clarify", {"questions": [{"question": "Tea or coffee?", "choices": ["Tea", "Coffee"]}]}), 0.05
    if "slow" in question:
        return {"role": "assistant", "content": " ".join("word%d" % i for i in range(40))}, 0.25
    return {"role": "assistant", "content": "Stub model reply."}, 0.05


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json({"object": "list", "data": [{"id": "fake", "object": "model", "owned_by": "me", "context_length": 64000}]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        msg, pause = answer(req)
        finish = "tool_calls" if msg.get("tool_calls") else "stop"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not req.get("stream"):
            choice = {"index": 0, "message": msg, "finish_reason": finish}
            return self._json({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": "fake", "choices": [choice], "usage": usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def send(delta, reason=None, extra=None):
            choice = {"index": 0, "delta": delta, "finish_reason": reason}
            chunk = {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": "fake", "choices": [choice], **(extra or {})}
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
            self.wfile.flush()

        try:
            if msg.get("tool_calls"):
                send({"role": "assistant", "content": None, "tool_calls": [dict(c, index=i) for i, c in enumerate(msg["tool_calls"])]})
            else:
                words = msg["content"].split(" ")
                for i, word in enumerate(words):
                    piece = word + (" " if i + 1 < len(words) else "")
                    send({"role": "assistant", "content": piece} if i == 0 else {"content": piece})
                    time.sleep(pause)
            send({}, finish, {"usage": usage})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Hermes hung up: the turn was stopped.


ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), Handler).serve_forever()
