"""Writes src/hermes/webhookGolden.json: what Hermes's own webhook adapter makes of prompt templates, filters and
coalescing keys, for automations.test.ts.

Runs Hermes's real `WebhookAdapter._render_prompt`, `WebhookRouteProcessor.filter_matches` and
`WebhookCoalescer.group_key`, so the Automations preview is checked against the server's code. It starts no listener
and reads or writes no route store. Run it from the repo root with the Python of a Hermes checkout:

    HERMES_HOME=$(mktemp -d) ~/.hermes/hermes-agent/venv/bin/python tools/webhook-golden.py ~/.hermes/hermes-agent

An optional second argument names the Hermes version, for a checkout that isn't a git work tree (`git archive`).
Integers past 2^53 are left out: JavaScript's JSON.parse can't hold them, so the preview shows them rounded.
"""
import json
import os
import subprocess
import sys

checkout = os.path.expanduser(sys.argv[1])
sys.path.insert(0, checkout)
from gateway.config import PlatformConfig
from gateway.platforms.webhook import WebhookAdapter
from gateway.platforms.webhook_filters import WebhookRouteProcessor

adapter = WebhookAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "routes": {}}))
processor = WebhookRouteProcessor()

ISSUE = {
    "action": "opened",
    "number": 42,
    "issue": {"number": 42, "title": "Crash — “empty” list <b>ü</b>", "body": "Line 1\nLine 2\tTab", "labels": [{"name": "bug"}, {"name": "p1"}],
              "user": {"login": "octo"}, "draft": False, "score": 1.5, "tiny": 1e-07, "none": None,
              "nested": {"a": [1, 2, {"b": True}], "e": {}, "l": []}},
    "repository": {"full_name": "example/fixture"},
    "payload": {"inner": "from payload"},
    "emoji": "🎉 party",
}
FLAT = {"event_type": "alert", "level": 3, "tags": ["a", "b"], "ok": True}
PAYLOADS = {"issue": ISSUE, "flat": FLAT, "long": {"text": "x" * 4100, "list": list(range(800)), "uni": "é" * 2100}}
TEMPLATES = [
    "", "Issue #{issue.number}: {issue.title}", "{issue.labels}", "{issue.nested}", "{issue.draft} {issue.none} {issue.score}",
    "{issue.tiny}", "{missing} {issue.missing.deeper} {issue.title.length}", "{event_type} on {repository.full_name}",
    "{__raw__}", "{issue.body}", "{emoji}", "{ issue.title } {issue-title} {}", "{issue.nested.a}", "{issue.nested.e}{issue.nested.l}",
    "{payload.inner} {action}", "{level} {tags} {ok}", "{text}", "{list}", "{uni}",
]
FILTERS = [
    {"field": "action", "equals": "opened"}, {"field": "action", "not_equals": "opened"}, {"field": "issue.number", "equals": 42},
    {"field": "issue.number", "equals": 42.0}, {"field": "issue.number", "equals": "42"}, {"field": "issue.draft", "equals": 0},
    {"field": "ok", "equals": 1}, {"field": "issue.labels", "contains": {"name": "bug"}}, {"field": "issue.labels", "contains": "bug"},
    {"field": "issue.title", "contains": "empty"}, {"field": "issue.number", "contains": 4}, {"field": "issue.user", "contains": "login"},
    {"field": "issue.none", "contains": "None"}, {"field": "issue.draft", "contains": "False"}, {"field": "issue.labels.0.name", "equals": "bug"},
    {"field": "issue.labels.5.name", "exists": False}, {"field": "issue.missing", "missing": True}, {"field": "issue.title", "exists": True},
    {"field": "issue.number", "in": [41, 42]}, {"field": "issue.number", "in": "42"}, {"field": "issue.title", "regex": "^Crash"},
    {"field": "issue.number", "regex": "^4\\d$"}, {"field": "issue.labels", "regex": "\"name\": \"p1\""}, {"field": "event", "equals": "issues"},
    {"field": "event_type", "equals": "issues"}, {"field": "payload.inner", "equals": "from payload"}, {"field": "headers.X-GitHub-Event", "equals": "issues"},
    {"field": "level", "in": [1, 2, 3]}, {"field": "tags", "contains": "b"}, {"field": "payload.level", "equals": 3},
    {"all": [{"field": "action", "equals": "opened"}, {"field": "issue.number", "equals": 42}]},
    {"any": [{"field": "action", "equals": "closed"}, {"field": "issue.number", "equals": 42}]},
    {"not": {"field": "action", "equals": "opened"}}, {"field": "action"}, {"field": "", "equals": "x"}, {"field": "issue.nested.a.2.b", "equals": True},
    {"field": "issue.score", "equals": 1.5}, {"field": "issue.missing", "not_equals": "x"}, {"field": "issue.number", "regex": "("},
]
KEYS = ["issue.number", "{repository.full_name}#{issue.number}", "pull_request.number", "{issue.labels}", "level", "{event_type}-{level}"]
HEADERS = {"Content-Type": "application/json", "X-GitHub-Event": "issues", "X-GitHub-Delivery": "00000000-0000-4000-8000-000000000000", "User-Agent": "GitHub-Hookshot/example"}

out = {
    "hermes": (sys.argv[2] if len(sys.argv) > 2 else subprocess.run(["git", "-C", checkout, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=False).stdout.strip() or "unknown"),
    "payloads": PAYLOADS,
    "renders": [{"payload": p, "template": t, "event": "issues", "route": "golden", "out": adapter._render_prompt(t, PAYLOADS[p], "issues", "golden")}
                for p in PAYLOADS for t in TEMPLATES],
    "filters": [{"payload": p, "spec": f, "event": "issues", "headers": HEADERS, "out": processor.filter_matches(f, PAYLOADS[p], "issues", HEADERS)}
                for p in ("issue", "flat") for f in FILTERS],
    "keys": [{"payload": p, "key": k, "event": "issues", "route": "golden",
              "out": (lambda g: g.split("|", 1)[1] if g else None)(adapter._coalescer.group_key("golden", k, PAYLOADS[p], "issues"))}
             for p in ("issue", "flat") for k in KEYS],
}
with open("src/hermes/webhookGolden.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(out['renders'])} renders, {len(out['filters'])} filters, {len(out['keys'])} keys from Hermes {out['hermes']}")
