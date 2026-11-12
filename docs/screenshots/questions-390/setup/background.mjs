// Another Hermes client on the app's chat (#390) starts a background turn there, as the official app's /background does:
// it resumes stored session <id> and sends `prompt.background` with <text>. The background agent's tool calls don't show
// in the chat, so a secret its skill asks for reaches the chat with no tool call of the chat's own. This client answers
// nothing. Every 2 s it asks Hermes which requests it still waits on (`session.events.since`), and it prints each change,
// each request it sees, and the background turn's answer, until that answer or <seconds> (default 300).
// Usage: node background.mjs <base url> <password file> <stored session id> <text> [seconds]
import { readFileSync } from "node:fs";

const [base, passwordFile, stored, text, seconds = "300"] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const say = (what) => console.log(JSON.stringify({ t: new Date().toISOString(), ...what }));
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
let done;
const finished = new Promise((r) => (done = r));
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (typeof f.id === "number" && !f.method) return pending.get(f.id)?.(f), pending.delete(f.id);
  if (typeof f.id === "string" && f.method) say({ request: f.method, id: f.id, session_id: f.params?.session_id });
  const type = f.params?.type;
  if (type === "background.complete") say({ event: type, text: String(f.params.payload?.text ?? "").slice(0, 300) }), done();
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
const rpc = (method, params) => new Promise((ok) => {
  const id = next++;
  pending.set(id, ok);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});
await rpc("client.capabilities", { server_requests: true });
const resumed = (await rpc("session.resume", { session_id: stored, profile: "default", inline_images: false })).result;
const sid = resumed?.session_id;
say({ resumed: stored, live: sid });
say({ background: (await rpc("prompt.background", { session_id: sid, text })).result ?? "refused" });
let last = "";
const poll = setInterval(async () => {
  const res = (await rpc("session.events.since", { session_id: sid, last_seen: Number.MAX_SAFE_INTEGER })).result;
  const open = JSON.stringify((res?.open_requests ?? []).map((r) => `${r.method} ${r.id}`));
  if (open !== last) say({ open_requests: JSON.parse(open), events: res?.count }), (last = open);
}, 2000);
await Promise.race([finished, new Promise((r) => setTimeout(r, Number(seconds) * 1000))]);
clearInterval(poll);
ws.close();
process.exit(0);
