"""OpenAI-compatible stand-in model for the #318 live check.

A user message containing RUNIT (and SLOW: a final reply held 150 s, so the turn keeps running) gets a `terminal` tool call that Hermes counts as dangerous (a recursive delete), so
Hermes asks for an Approval. After the tool result comes back, the reply is `GOT: <tool result>`. Anything else gets "ok".
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2], "a", buffering=1)


def reply_for(messages):
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    after = messages[last_user + 1:]
    tool = next((m for m in after if m.get("role") == "tool"), None)
    asked = last_user >= 0 and "RUNIT" in json.dumps(messages[last_user].get("content"))
    if tool is not None:
        if "SLOW" in json.dumps(messages[last_user].get("content")):
            time.sleep(150)
        return {"text": "GOT: " + str(tool.get("content"))[:400]}
    if asked:
        args = {"command": "rm -rf /tmp/hv318/scratch/old"}
        return {"tool": {"id": "call_rm_%d" % last_user, "name": "terminal", "arguments": json.dumps(args)}}
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
            return self._json(200, {"object": "list", "data": [{"id": "mock", "object": "model", "context_length": 128000}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": "not found"})
        out = reply_for(body.get("messages") or [])
        LOG.write(json.dumps({"t": time.time(), "stream": bool(body.get("stream")), "out": out}) + "\n")
        created = int(time.time())
        if not body.get("stream"):
            msg = {"role": "assistant", "content": out.get("text")}
            finish = "stop"
            if "tool" in out:
                t = out["tool"]
                msg["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}}]
                finish = "tool_calls"
            return self._json(200, {"id": "c1", "object": "chat.completion", "created": created, "model": "mock",
                                    "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def chunk(delta, finish=None):
            c = {"id": "c1", "object": "chat.completion.chunk", "created": created, "model": "mock",
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
        usage = {"id": "c1", "object": "chat.completion.chunk", "created": created, "model": "mock", "choices": [],
                 "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        self.wfile.write(f"data: {json.dumps(usage)}\n\ndata: [DONE]\n\n".encode())
        self.wfile.flush()


ThreadingHTTPServer(("127.0.0.6", int(sys.argv[1])), Handler).serve_forever()
