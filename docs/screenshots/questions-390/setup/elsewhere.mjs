// Another Hermes client on the app's chat (#390): resumes stored session <id>, finds the open request in open_requests,
// and answers it first (clarify: clarify.lock per question; sudo and secret: request.answer). Prints what it did.
// Usage: node elsewhere.mjs <base url> <password file> <stored session id>
import { readFileSync } from "node:fs";

const [base, passwordFile, stored] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const login = await fetch(`${base}/auth/password-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "basic", username: "owner", password }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const { ticket } = await (await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } })).json();
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`);
const pending = new Map();
let next = 1;
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (typeof f.id === "number" && !f.method) pending.get(f.id)?.(f), pending.delete(f.id);
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
const rpc = (method, params) => new Promise((ok) => {
  const id = next++;
  pending.set(id, ok);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});
await rpc("client.capabilities", { server_requests: true });
const resumed = (await rpc("session.resume", { session_id: stored, profile: "default", inline_images: false })).result;
const open = resumed?.open_requests ?? [];
const out = [];
for (const r of open) {
  if (r.method === "clarify")
    for (const q of r.params.questions) out.push({ id: r.id, lock: q.qid, said: (await rpc("clarify.lock", { request_id: r.id, question_id: q.qid, answer: `From the other app (${q.qid})` })).result });
  else out.push({ id: r.id, method: r.method, said: (await rpc("request.answer", { id: r.id, result: { value: "other-app-value" } })).result });
}
console.log(JSON.stringify({ stored, open: open.map((r) => ({ id: r.id, method: r.method })), answered: out }, null, 1));
await new Promise((r) => setTimeout(r, 1500));
ws.close();
