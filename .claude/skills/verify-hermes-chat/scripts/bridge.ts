// The verification stand-in Hermes dashboard: the HTTP/WebSocket boundary the Rust side talks to, answered by the
// tests' FakeHermes (src/hermes/fakeHermes.ts) with fixed synthetic chats. Loopback only. `hv up` bundles and starts it.
//   node bridge.mjs <port> <state-file>
// Sign-in: username `verify`, password `verify-pass`; anything else is 401 "Invalid credentials", as Hermes answers.
// Every prompt gets a short streamed reply that starts `Stand-in reply to:` and is stored in the chat's history, except:
//   a prompt with "delegate" in it starts two subagents, as Hermes's delegate tool reports them, and its reply runs on.
//   With "queue" in it too, a third subagent is requested and stays queued, waiting its turn.
//   a prompt with "dispatch" in it calls `kanban_create` (a task on the stand-in's board, `session_id` the chat's),
//   says "Research task dispatched (t_…)" and ends its turn. The kanban routes serve the board.
//   a prompt with "background" in it starts two background subagents and ends its turn while they run.
//   a prompt with "approval" in it asks the owner to approve a command, and its reply waits for the answer.
//   a prompt that starts with "fail" ends its reply with an error, as a provider failure does.
//   a prompt that starts with "math" gets a reply with inline and display math and a Mermaid diagram (#350), and one
//   that starts with "badmath" the same with a diagram Mermaid can't parse.
//   with HV_LONG_REPLY=<n>, a prompt that starts with `long` gets n paragraphs of markdown (code, a list, a table),
//   three words every 40 ms, so a reply keeps streaming for minutes.
//   `subagent.interrupt` (Stop in the Subagents panel) ends that subagent as `interrupted`, as Hermes reports it.
//   `session.interrupt` (the composer's Stop) ends the reply's turn with `message.complete` status `interrupted`, as
//   Hermes does, so a reply that runs on (a "delegate" prompt's) can be stopped.
//   `POST /__subagent?id=<subagent id>&status=completed|failed` ends one as Hermes reports it (a test's control).
//   `POST /__live?profile=<p>&id=<chat id>&status=working|waiting|end[&title=<t>]` runs a reply in another profile, as
//   `session.active_list` reports one: the chat is stored in that profile, listed as working or waiting, and `end`
//   takes it off the list and leaves it Unread there (a test's control). With `profile=default` it runs one in an
//   existing chat of the shown profile that this app hasn't resumed, such as a wake turn after a relaunch.
//   `POST /__signin[?session=<id>]&status=approved|denied|expired|error` settles a subscription sign-in (the pending
//   one when no session is named) as the provider would once the owner acts in the browser (a test's control).
//   `POST /__kanban?id=<task id>&status=<running|done|blocked|review|archived>` moves a task as a worker would (a test's
//   control). `done`, `blocked` and `review` send the chat a `status.update` naming the task and, 2 s later,
//   a streamed wake turn when the chat is live, subscribed, not stopped, and no turn runs, as Hermes's poller does.
//   `POST /__ask?chat=<chat id>&method=<method>` with a JSON body of params asks the app something, as a Hermes tool's
//   server request does (`preview.act`, `preview.read`), in that chat's live session (a test's control). It answers
//   the request's id; the app's answer shows in `/__state` under `answers`.
//   `POST /__changed[?n=<count>&gap=<ms>]` broadcasts `sessions.changed` n times (default 1), gap ms apart, as Hermes's
//   change watcher does when another process writes the session store (a test's control).
// HV_INBOX=1 gives the `work` profile two Unread chats for the Rail inbox: one last active 3 days ago, one an hour ago.
// HV_LIST=<n> adds n Active, read chats to `default`, one an hour apart, so its Inbox is longer than the list panel.
// HV_DELAY_MS=<ms> holds each /api/ answer that long, as a distant server's round trip would.
// HV_FAIL_PATCH=<id>,<id> answers 503 to every edit (PATCH) of those sessions, as a server that fails a write does.
// HV_MEMORY_URL=<url> is the address `default`'s Honcho gives for its documentation and its API key's "Get one" link.
// Read-only check of what the server holds (the side-effect proof): `GET /__state` returns sessions, transcripts, and
// the app's answers to what the stand-in asked it.
// The same JSON is rewritten to <state-file> after every change, so it survives the bridge being stopped.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../../src/hermes/fakeHermes";
import { HONCHO, RETAINDB } from "../../../../src/hermes/fakeMemoryProviders";
import type { Pipe } from "../../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47990);
const stateFile = process.argv[3];
const USER = "verify";
const PASSWORD = "verify-pass";
const server = new FakeHermes();
const delayMs = Number(process.env.HV_DELAY_MS ?? 0);

// Synthetic seed data. Feature recipes in ../features/ name these titles; change both together.
server.sessions = [
  row("backup", 0.02, { title: "Nightly backup failing", message_count: 2 }),
  row("nginx", 0.5, { title: "Rotate nginx logs", message_count: 2 }),
  row("vpn", 2, { title: "Why is the VPN slow", message_count: 2 }),
  row("trip", 6, { title: "Plan a weekend in Lisbon", message_count: 2 }),
];
server.storeMessage("backup", { role: "user", text: "Why did the nightly backup fail?" });
server.storeMessage("backup", { role: "assistant", text: "The restic repository was still **locked** from a killed prune. Run `restic unlock`, then re-run the backup." });
server.storeMessage("nginx", { role: "user", text: "Keep 14 days of nginx logs." });
server.storeMessage("nginx", { role: "assistant", text: "Done: `rotate 14`, `daily`, `compress`." });
server.storeMessage("vpn", { role: "user", text: "Why is the VPN slow tonight?" });
server.storeMessage("vpn", { role: "assistant", text: "MTU 1500 on a 1420 tunnel: packets fragment. Set `MTU = 1380`." });
server.storeMessage("trip", { role: "user", text: "Plan a weekend in Lisbon." });
server.storeMessage("trip", { role: "assistant", text: "Day 1: Alfama and the castle. Day 2: Belém and the LX Factory." });

const TOPICS = ["Disk usage on /var", "Renew the TLS certificate", "Postgres vacuum schedule", "Grafana alert noise", "Rotate the API keys", "Cron job drift", "Swap usage spikes", "DNS TTL for the blog", "Upgrade Node on the build box", "Docker image cleanup", "Fail2ban bans", "Restic retention policy"];
for (let i = 0; i < Number(process.env.HV_LIST ?? 0); i++) {
  const at = (i + 1) / 24;
  const title = `${TOPICS[i % TOPICS.length]}${i >= TOPICS.length ? ` (${Math.floor(i / TOPICS.length) + 1})` : ""}`;
  server.sessions.push(row(`list${i + 1}`, at, { title, pinned: true }));
  server.storeMessage(`list${i + 1}`, { role: "user", text: `${title}?` });
  server.storeMessage(`list${i + 1}`, { role: "assistant", text: "Checked. Nothing to do for now." });
}

for (const id of (process.env.HV_FAIL_PATCH ?? "").split(",").filter(Boolean))
  server.rest[`PATCH /api/sessions/${id}`] = () => {
    throw new Error(`The dashboard answered 503: {"detail":"Stand-in refuses edits of ${id}"}`);
  };

// Settings → MCP servers (ADR 0121): a second profile, servers of each kind, one from a plugin, Test results and a catalog.
server.otherProfiles = { work: [] };
if (process.env.HV_INBOX === "1")
  server.otherProfiles.work = [
    row("brief", 3, { title: "Morning brief, Monday", last_read_at: 0 }),
    row("convert", 1 / 24, { title: "Convert 12 GB to MB", last_read_at: 0 }),
  ];
server.mcp.servers.default = {
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"] },
  github: { url: "https://mcp.example.com/github", headers: { Authorization: "Bearer ${MCP_GITHUB_API_KEY}" } },
  linear: { url: "https://mcp.example.com/linear/sse", auth: "oauth" },
  weather: { command: "uvx", args: ["weather-mcp"], env: { WEATHER_API_KEY: "wk-synthetic-0123456789" }, enabled: false },
};
server.mcp.env.default = { MCP_GITHUB_API_KEY: "ghp-synthetic-token" };
server.mcp.plugins.default = { kanban: { plugin: "kanban-board", cfg: { command: "kanban-mcp", args: ["--stdio"] } } };
server.mcp.servers.work = { calendar: { command: "cal-mcp" } };
server.mcp.probes = {
  filesystem: { tools: ["read_file", "write_file", "list_directory", "search_files"].map((name) => ({ name, description: `Synthetic ${name.replace("_", " ")}` })) },
  github: { error: "HTTP 401 from POST https://mcp.example.com/github: Bearer token rejected" },
};
server.mcp.catalogEntries = [
  { name: "context7", description: "Up-to-date library docs for the model", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  { name: "brave-search", description: "Web search through the Brave Search API", transport: "stdio", command: "npx", args: ["-y", "brave-search-mcp"], env: [{ name: "BRAVE_API_KEY", prompt: "Brave Search API key" }] },
];

// Clone a profile (ADR 0074): `default` has a persona and own skills to copy.
server.souls.default = "You are Hermes, the house's ops assistant. Answer briefly and name the command to run.\n";
for (const name of ["restic-unlock", "nginx-rotate", "vpn-mtu", "trip-planner", "disk-usage", "cert-renew"])
  server.skills.add("default", { dir: `/home/liam/.hermes/skills/ops/${name}`, source: "agent", category: "ops" }, `---\nname: ${name}\ndescription: Synthetic ${name} skill.\n---\n\n## When to Use\n\nWhen asked about ${name}.\n`);

const memoryUrl = process.env.HV_MEMORY_URL;
const honcho = memoryUrl ? { ...HONCHO, docsUrl: memoryUrl, fields: HONCHO.fields.map((f) => (f.kind === "secret" ? { ...f, url: memoryUrl } : f)) } : HONCHO;
server.memoryProviders.add(honcho, { ...RETAINDB });
server.memoryProviders.active = { default: "honcho", work: "" };

// MCP servers as each profile's config holds them; the `.env` (tokens) stays out.
const dump = () =>
  JSON.stringify({ sessions: server.sessions, transcripts: server.transcripts, mcp: server.mcp.servers, kanban: server.kanban.boards, answers: server.responses }, null, 2);
const save = () => stateFile && writeFileSync(stateFile, dump());
save();

const longParagraphs = Number(process.env.HV_LONG_REPLY ?? 0);
const paragraph = (i: number) =>
  `Step ${i}: check the **restic** lock, then the prune schedule. See [the docs](https://restic.readthedocs.io/en/stable/) and run:\n\n` +
  `\`\`\`sh\nrestic -r sftp:backup@nas:/srv/restic unlock\nrestic -r sftp:backup@nas:/srv/restic check --read-data-subset=${i}/100\n\`\`\`\n\n` +
  `- keep-daily 7\n- keep-weekly 4\n- keep-monthly ${i % 12}\n\n| host | size | when |\n|---|---|---|\n| nas | ${i * 3} GiB | 02:00 |\n| web | ${i} GiB | 03:00 |\n`;

const mathReply = (broken: boolean) =>
  "The backup window is the time to read the data plus the time to send it, so with $n$ snapshots of size $s$ over a link of " +
  "bandwidth \\(b\\) it takes about $t = \\frac{n \\cdot s}{b}$. That holds while the link, not the disk, is the limit. It costs $5 and $10 a month on either plan.\n\n" +
  "$$\n\\sigma = \\sqrt{\\frac{1}{N}\\sum_{i=1}^{N} (x_i - \\mu)^2}\n$$\n\n" +
  "The prune runs after the check:\n\n" +
  (broken ? "```mermaid\nsequenceDiagram\n  cron->>restic: unlock\n  restic-->>\n```\n" : "```mermaid\nsequenceDiagram\n  cron->>restic: unlock\n  restic-->>cron: ok\n  cron->>restic: check --read-data-subset=5%\n  restic-->>cron: no errors\n  cron->>restic: forget --prune\n```\n");

function replyTo(sessionId: string, prompt: string, said?: string, persisted_turn?: Record<string, unknown>) {
  const long = longParagraphs > 0 && prompt.startsWith("long");
  const math = prompt.startsWith("math") || prompt.startsWith("badmath");
  const text =
    said ??
    (long
      ? Array.from({ length: longParagraphs }, (_, i) => paragraph(i)).join("\n")
      : math
        ? mathReply(prompt.startsWith("badmath"))
        : `Stand-in reply to: ${prompt.slice(0, 80)}`);
  server.event(sessionId, "message.start");
  const words = text.split(" ");
  let at = 0;
  const step = () => {
    const from = at;
    at = Math.min(words.length, at + 3);
    server.event(sessionId, "message.delta", { text: words.slice(from, at).join(" ") + (at < words.length ? " " : "") });
    if (at < words.length) return void setTimeout(step, long ? 40 : 120);
    const stored = server.runtime.get(sessionId);
    if (stored) server.storeMessage(stored, { role: "assistant", text });
    setTimeout(() => {
      server.event(sessionId, "message.complete", { text, status: "complete", ...(persisted_turn && { persisted_turn }) });
      save();
    }, 120);
  };
  setTimeout(step, 400);
}

server.kanban.wakeDelayMs = 2_000;
server.kanban.wakeWith = (sid, _stored, text, user_row_id) => replyTo(sid, "", text, { user_row_id });

// The subagents a "delegate" prompt started, as `subagent.start` / `subagent.complete` payloads carry them
// (`tools/delegate_tool.py` at the deployed `f0d94882`). Each is also in Hermes's registry, for `subagent.list`.
const TEAM = ["Read the auth code", "Read the tests"];
const delegated = new Map<string, { sid: string; stored: string; payload: Record<string, unknown> }>();
let started = 0;

function delegate(sid: string, queue: boolean) {
  const stored = server.runtime.get(sid);
  if (!stored) return;
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text: "Delegating to two subagents." });
  TEAM.forEach((goal, task_index) => {
    const subagent_id = `sa-${++started}`;
    const payload = { subagent_id, goal, task_index, task_count: TEAM.length, depth: 0, delegation_id: `dlg-${sid}`, model: "stand-in-model" };
    delegated.set(subagent_id, { sid, stored, payload });
    (server.subagents[stored] ??= []).push({ ...payload, owner: sid, status: "running", accepting_steer: true, started_at: Date.now() / 1000 });
    server.event(sid, "subagent.start", payload);
  });
  if (!queue) return;
  const subagent_id = `sa-${++started}`;
  const payload = { subagent_id, goal: "Write the summary", task_index: TEAM.length, task_count: TEAM.length + 1, depth: 0, delegation_id: `dlg-${sid}`, model: "stand-in-model" };
  delegated.set(subagent_id, { sid, stored, payload });
  (server.subagents[stored] ??= []).push({ ...payload, owner: sid, status: "queued", accepting_steer: false });
  server.event(sid, "subagent.spawn_requested", payload);
}

function askApproval(sid: string) {
  server.event(sid, "message.start");
  server.askApproval(sid);
}

function failReply(sid: string) {
  server.event(sid, "message.start");
  setTimeout(() => server.event(sid, "error", { message: "Stand-in provider error: the model is overloaded." }), 200);
}

function endSubagent(id: string, status: string) {
  const d = delegated.get(id) ?? backgroundSubagent(id);
  if (!d) return false;
  delegated.delete(id);
  server.subagents[d.stored] = (server.subagents[d.stored] ?? []).filter((r) => r.subagent_id !== id);
  server.event(d.sid, "subagent.complete", { ...d.payload, status, summary: `Stand-in subagent ${status}.` });
  return true;
}

function backgroundSubagent(id: string) {
  for (const [stored, rows] of Object.entries(server.subagents)) {
    const { owner, tail: _, ...payload } = rows.find((r) => r.subagent_id === id) ?? {};
    if (typeof owner === "string") return { sid: owner, stored, payload };
  }
  return undefined;
}

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

// The smallest WebSocket server the Rust client needs: text frames, client frames masked, no extensions.
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(body.length), 2);
            return h;
          })();
  return Buffer.concat([head, body]);
}
function readFrames(sock: Socket, onText: (t: string) => void) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127,
        off = 2;
      if (buf.length < (len === 126 ? 4 : len === 127 ? 10 : 2)) return;
      if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
      else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if (op === 1) onText(data.toString());
      else if (op === 8) sock.end();
      else if (op === 9) sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
    }
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  console.log(new Date().toISOString(), req.method, url.pathname + url.search);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString() || undefined;
  if (delayMs && url.pathname.startsWith("/api/")) await new Promise((r) => setTimeout(r, delayMs));
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof v === "string" ? v : JSON.stringify(v));
  };
  if (url.pathname === "/__state") return json(200, dump());
  if (url.pathname === "/__subagent" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    return endSubagent(id, url.searchParams.get("status") ?? "completed") ? json(200, { ok: true }) : json(404, { detail: `No running stand-in subagent ${id}` });
  }
  if (url.pathname === "/__live" && req.method === "POST") {
    const [profile, id, status] = ["profile", "id", "status"].map((k) => url.searchParams.get(k) ?? "");
    const shown = profile === "default";
    if (!(shown || profile in server.otherProfiles) || !id || !["working", "waiting", "end"].includes(status)) return json(400, { detail: "Needs profile, id and status working|waiting|end" });
    const t = Date.now() / 1000;
    const list = server.store(profile)!;
    if (shown && !list.some((r) => r.id === id)) return json(404, { detail: `No chat ${id} in default` });
    const stored = list.find((r) => r.id === id) ?? (list.push(row(id, 0, { title: url.searchParams.get("title") ?? `Chat ${id}`, last_read_at: 0 })), list[list.length - 1]);
    stored.last_active = t;
    server.liveSessions = server.liveSessions.filter((l) => l.session_key !== id);
    if (status !== "end") server.liveSessions.push({ id: `rt-${id}`, session_key: id, status, last_active: t, started_at: t, title: stored.title ?? "" });
    save();
    return json(200, { ok: true, live: server.liveSessions.length });
  }
  if (url.pathname === "/__signin" && req.method === "POST") {
    const status = url.searchParams.get("status") ?? "approved";
    const session = url.searchParams.get("session") || [...server.accounts.sessions.values()].find((s) => s.status === "pending")?.id;
    if (!session || !["approved", "denied", "expired", "error"].includes(status)) return json(400, { detail: "No pending sign-in, or status isn't approved|denied|expired|error" });
    server.accounts.settle(session, status as "approved", status === "error" ? "Token exchange failed." : undefined);
    return json(200, { ok: true, session });
  }
  if (url.pathname === "/__kanban" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    const moved = server.kanban.move(id, url.searchParams.get("status") ?? "done");
    save();
    return moved ? json(200, { ok: true, task: server.kanban.find(id) }) : json(404, { detail: `No stand-in task ${id}` });
  }
  if (url.pathname === "/__changed" && req.method === "POST") {
    const n = Number(url.searchParams.get("n") ?? 1);
    const gap = Number(url.searchParams.get("gap") ?? 0);
    for (let i = 0; i < n; i++) {
      if (i && gap) await new Promise((r) => setTimeout(r, gap));
      server.broadcast("sessions.changed");
    }
    return json(200, { ok: true, sent: n });
  }
  if (url.pathname === "/__ask" && req.method === "POST") {
    const runtime = server.runtimeIdOf(url.searchParams.get("chat") ?? "");
    const method = url.searchParams.get("method") ?? "";
    if (!runtime || !method) return json(400, { detail: "Needs chat (a chat open in the app) and method" });
    const id = server.ask(runtime, method, JSON.parse(body ?? "{}"));
    setTimeout(save, 500);
    return id ? json(200, { id }) : json(409, { detail: "The app didn't say it answers server requests" });
  }
  if (url.pathname === "/auth/password-login") {
    const b = JSON.parse(body ?? "{}");
    if (b.username !== USER || b.password !== PASSWORD) return json(401, { detail: "Invalid credentials" });
    return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  }
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  try {
    const text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    json(200, text);
    if (req.method !== "GET") save();
  } catch (e) {
    const m = /answered (\d+): (.*)$/s.exec((e as Error).message);
    json(m ? Number(m[1]) : 500, m ? m[2] : { detail: (e as Error).message });
  }
});
http.on("upgrade", async (req, sock: Socket) => {
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => {
    try {
      const msg = JSON.parse(t) as { method?: string; params?: { session_id?: string; text?: string; subagent_id?: string } };
      if (msg.method && msg.method !== "gateway.ping") console.log(new Date().toISOString(), "WS", msg.method, msg.params?.session_id ?? "");
      if (msg.method === "prompt.submit" && msg.params?.session_id) {
        const { session_id, text } = msg.params;
        const prompt = String(text ?? "");
        setTimeout(() => {
          save();
          if (/delegate/i.test(prompt)) delegate(session_id, /queue/i.test(prompt));
          else if (/approval/i.test(prompt)) askApproval(session_id);
          else if (/^fail/i.test(prompt)) failReply(session_id);
          else if (/dispatch|background/i.test(prompt)) setTimeout(save, 500);
          else replyTo(session_id, prompt);
        }, 0);
      }
      const stop = msg.method === "subagent.interrupt" ? delegated.get(String(msg.params?.subagent_id)) : undefined;
      if (stop && stop.sid === msg.params?.session_id) setTimeout(() => endSubagent(String(msg.params!.subagent_id), "interrupted"), 50);
      if (msg.method === "session.interrupt" && server.runtime.has(String(msg.params?.session_id)))
        setTimeout(() => server.event(String(msg.params!.session_id), "message.complete", { status: "interrupted", text: "" }), 50);
    } catch {
      // Not JSON: FakeHermes answers it as it would.
    }
    void pipe!.send(t);
  });
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`stand-in dashboard ready on http://127.0.0.1:${port}`));
