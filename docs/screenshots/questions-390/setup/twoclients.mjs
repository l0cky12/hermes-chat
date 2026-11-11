// Two clients on one real Hermes chat (#390). A starts a turn whose model asks `kind` (clarify, sudo or secret); B
// resumes the same chat and sees the request in open_requests. B answers (clarify: clarify.lock per question; sudo and
// secret: request.answer). Prints whether A then gets a request.cancel, what A sees next for the turn, and what Hermes
// says when A answers after B (clarify.lock / request.answer status).
// Usage: node twoclients.mjs <base url> <password file> <clarify|sudo|secret> <log file>
import { appendFileSync, readFileSync } from "node:fs";

const [base, passwordFile, kind, logFile] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const log = (who, dir, frame) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), who, dir, frame }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${base}/auth/password-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "basic", username: "owner", password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function client(who) {
  const { ticket } = await (await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } })).json();
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`);
  const frames = [];
  const pending = new Map();
  let next = 1;
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    // The password never reaches a log: only the request frames carry the asked questions.
    log(who, "in", f);
    frames.push(f);
    if (typeof f.id === "number" && !f.method) pending.get(f.id)?.(f), pending.delete(f.id);
  };
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  const send = (f) => (log(who, "out", f.method === "request.answer" ? { ...f, params: { ...f.params, result: "(redacted)" } } : f), ws.send(JSON.stringify(f)));
  const rpc = (method, params) => new Promise((ok) => {
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
  const caps = await rpc("client.capabilities", { server_requests: true });
  return { who, ws, frames, send, rpc, until, caps: caps.result };
}

const A = await client("A");
const B = await client("B");
const created = (await A.rpc("session.create", { profile: "default", source: "gui" })).result;
const word = { clarify: "ASKCLARIFY", sudo: "ASKSUDO", secret: "ASKSECRET" }[kind];
await A.rpc("prompt.submit", { session_id: created.session_id, profile: "default", text: `${word} SLOW please` });
const asked = await A.until((f) => f.method === kind);
if (!asked) throw new Error(`A got no ${kind} request`);
const resumed = await B.rpc("session.resume", { session_id: created.stored_session_id, profile: "default", inline_images: false });
const bListed = (resumed.result?.open_requests ?? []).find((r) => r.id === asked.id);

let bAnswer;
if (kind === "clarify") {
  bAnswer = [];
  for (const q of asked.params.questions) bAnswer.push((await B.rpc("clarify.lock", { request_id: asked.id, question_id: q.qid, answer: `B answers ${q.qid}` })).result);
} else {
  bAnswer = (await B.rpc("request.answer", { id: asked.id, result: { value: "b-test-value-123" } })).result;
}
const cancelled = await A.until((f) => f.params?.type === "request.cancel" && f.params.payload?.id === asked.id, 8_000);
const aToolDone = await A.until((f) => f.params?.type === "tool.complete", 30_000);
const aLate =
  kind === "clarify"
    ? (await A.rpc("clarify.lock", { request_id: asked.id, question_id: asked.params.questions[0].qid, answer: "A late" })).result
    : (await A.rpc("request.answer", { id: asked.id, result: { value: "a-late-value" } })).result;
const aDone = await A.until((f) => f.params?.type === "message.complete", 60_000);
console.log(JSON.stringify({
  kind,
  capabilities: A.caps,
  requestToA: { id: asked.id, method: asked.method, params: asked.params },
  bSawItInOpenRequests: !!bListed,
  bAnswer,
  aGotRequestCancel: cancelled ? cancelled.params.payload : null,
  aEventsBetweenAskAndToolComplete: A.frames.slice(A.frames.indexOf(asked) + 1, A.frames.indexOf(aToolDone) + 1).map((f) => f.method ?? f.params?.type ?? (typeof f.id === "number" ? "rpc-reply" : "?")).filter((t) => t !== "event"),
  aToolComplete: aToolDone ? { name: aToolDone.params.payload?.name, tool_id: aToolDone.params.payload?.tool_id, result: String(aToolDone.params.payload?.result ?? "").slice(0, 400) } : null,
  aLateAnswer: aLate,
  aReply: aDone?.params?.payload?.text?.slice(0, 400) ?? null,
}, null, 2));
A.ws.close();
B.ws.close();
