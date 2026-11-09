// Two clients on one Hermes chat (#318). A starts a turn that asks for an Approval; B resumes the same chat and sees
// the request too. A answers with `frame` (a response frame, as Hermes Chat did before the fix) or `respond`
// (`approval.respond`, the fix). Prints whether B was told the request is gone (`request.cancel`), what
// `session.active_list` says afterwards, and what Hermes answers when B then answers the card it still shows.
// Usage: node twoclients.mjs <base url> <frame|respond> <log file>
import { appendFileSync } from "node:fs";

const [base, mode, logFile] = process.argv.slice(2);
const log = (who, dir, frame) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), who, dir, frame }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${base}/auth/password-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "basic", username: "verify", password: "verify-pass" }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function client(who) {
  const t = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } });
  const { ticket } = await t.json();
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`);
  const frames = [];
  const pending = new Map();
  let next = 1;
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    log(who, "in", f);
    frames.push(f);
    if (typeof f.id === "number" && !f.method) pending.get(f.id)?.(f), pending.delete(f.id);
  };
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  const send = (f) => (log(who, "out", f), ws.send(JSON.stringify(f)));
  const rpc = (method, params) =>
    new Promise((ok) => {
      const id = next++;
      pending.set(id, ok);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const until = async (pred, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const f = frames.find(pred);
      if (f) return f;
    }
    return undefined;
  };
  await until((f) => f.params?.type === "gateway.ready", 10_000);
  await rpc("client.capabilities", { server_requests: true });
  return { who, ws, frames, send, rpc, until };
}

const A = await client("A");
const B = await client("B");
const created = (await A.rpc("session.create", { profile: "default", source: "hv318" })).result;
await A.rpc("prompt.submit", { session_id: created.session_id, profile: "default", text: "RUNIT please" });
const asked = await A.until((f) => f.method === "approval");
if (!asked) throw new Error("A got no approval request");
const resumed = await B.rpc("session.resume", { session_id: created.stored_session_id, profile: "default", inline_images: false });
const bSid = resumed.result?.session_id;
const bSees = (resumed.result?.open_requests ?? []).some((r) => r.id === asked.id) || !!(await B.until((f) => f.id === asked.id && f.method === "approval", 3_000));
const requestId = asked.params.request_id;

let aAnswer;
if (mode === "respond") aAnswer = (await A.rpc("approval.respond", { session_id: created.session_id, choice: "deny", request_id: requestId })).result;
else A.send({ jsonrpc: "2.0", id: asked.id, result: { choice: "deny", all: false } });

const cancelled = await B.until((f) => f.params?.type === "request.cancel" && f.params.payload?.id === asked.id, 5_000);
const live = (await B.rpc("session.active_list", {})).result?.sessions?.find((s) => s.id === bSid || s.id === created.session_id);
const stale = await B.rpc("approval.respond", { session_id: bSid, choice: "once", request_id: requestId });
console.log(
  JSON.stringify(
    {
      mode,
      sameRuntimeSession: bSid === created.session_id,
      bSawRequest: bSees,
      aAnswer: aAnswer ?? "(response frame, no reply)",
      bGotRequestCancel: cancelled ? cancelled.params.payload : null,
      activeListStatus: live?.status ?? "(not listed)",
      bLateApprovalRespond: stale.result ?? stale.error,
    },
    null,
    2,
  ),
);
A.ws.close();
B.ws.close();
