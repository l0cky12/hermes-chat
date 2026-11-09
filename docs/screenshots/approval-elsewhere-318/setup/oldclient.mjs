// An older Hermes app on a chat (#318): starts a chat whose turn asks for an Approval, then, once `<go file>` exists,
// denies it in a response frame, which Hermes withdraws from no other app. Stays connected until `<stop file>` exists.
// Usage: node oldclient.mjs <base url> <go file> <stop file> <log file>
import { appendFileSync, existsSync } from "node:fs";

const [base, goFile, stopFile, logFile] = process.argv.slice(2);
const log = (dir, frame) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, frame }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${base}/auth/password-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "basic", username: "verify", password: "verify-pass" }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const { ticket } = await (await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } })).json();
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`);
const frames = [];
const pending = new Map();
let next = 1;
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  log("in", f);
  frames.push(f);
  if (typeof f.id === "number" && !f.method) pending.get(f.id)?.(f), pending.delete(f.id);
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
const send = (f) => (log("out", f), ws.send(JSON.stringify(f)));
const rpc = (method, params) => new Promise((ok) => (pending.set(next, ok), send({ jsonrpc: "2.0", id: next++, method, params })));

await rpc("client.capabilities", { server_requests: true });
const created = (await rpc("session.create", { profile: "default", source: "gui" })).result;
await rpc("prompt.submit", { session_id: created.session_id, profile: "default", text: "RUNIT SLOW from an older Hermes app" });
let asked;
while (!(asked = frames.find((f) => f.method === "approval"))) await sleep(100);
console.log(`asked ${asked.id} in ${created.stored_session_id}`);
while (!existsSync(goFile)) await sleep(200);
send({ jsonrpc: "2.0", id: asked.id, result: { choice: "deny", all: false } });
console.log("answered in a response frame");
while (!existsSync(stopFile)) await sleep(500);
ws.close();
