// A stand-in Hermes dashboard for screenshots of project membership sync (ADR 0109) in the real Tauri app: sign-in, the
// WS ticket, `/api/ws` and dashboard REST, answered by the tests' FakeHermes with synthetic chats. Loopback only. The
// membership store it can switch on is FakeHermes's version of the contract ADR 0109 proposes; no Hermes has it yet.
//   npx rolldown docs/screenshots/project-membership/bridge.ts --platform node -o /tmp/membership-bridge.mjs && node /tmp/membership-bridge.mjs 47820
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47820);
const server = new FakeHermes();
let offline = false;
const live = new Set<Socket>();

// Synthetic data: nothing here came from a real chat.
const TITLES = [
  ["backup", "Nightly backup failing"], ["nas", "NAS disk usage"], ["caddy", "Caddy reverse proxy config"], ["grafana", "Grafana dashboard for UPS"],
  ["zfs", "ZFS scrub schedule"], ["vpn", "Why is the VPN slow"], ["certs", "Check certificate expiry"], ["ansible", "Tidy the Ansible inventory"],
];
server.sessions = TITLES.map(([id, title], i) => row(id, 0.05 + i * 0.4, { title, pinned: i < 6 }));
server.serverDirs = new Set(["/srv/homelab", "/srv/docs"]);
const project = (id: string, name: string, path: string) => ({ id, slug: id, name, primary_path: path, archived: false, created_at: 1, folders: [{ path, label: null, is_primary: true, added_at: 1 }] });
server.projects.default = [project("p_homelab", "Home lab", "/srv/homelab"), project("p_docs", "Docs", "/srv/docs")];
// Put there earlier by "another computer", seen only once the store is on.
server.membership.default = [{ project_id: "p_homelab", session_id: "grafana", added_at: 1 }, { project_id: "p_homelab", session_id: "nas", added_at: 1 }];
server.storeMessage("backup", { role: "user", text: "Why did the nightly backup fail?" });
server.storeMessage("backup", { role: "assistant", text: "The restic repository was still locked from a run that was killed mid-prune." });

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

// The smallest WebSocket server the Rust client needs: text frames, client frames masked, no extensions.
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2);
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
      let len = buf[1] & 127, off = 2;
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
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString() || undefined;
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(v));
  };
  if (offline) return void res.socket?.destroy();
  if (url.pathname === "/auth/password-login") return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  try {
    const text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(text);
  } catch (e) {
    const m = /answered (\d+): (.*)$/s.exec((e as Error).message);
    res.writeHead(m ? Number(m[1]) : 500, { "content-type": "application/json" });
    res.end(m ? m[2] : JSON.stringify({ detail: (e as Error).message }));
  }
});
http.on("upgrade", async (req, sock: Socket) => {
  if (offline) return void sock.destroy();
  live.add(sock);
  sock.on("close", () => live.delete(sock));
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => void pipe!.send(t));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));

// Controls, on their own port so they work while the dashboard is "offline":
//   /store/on, /store/off   the membership store ADR 0109 proposes (off: "method not found", as every Hermes today)
//   /offline/on, /offline/off   drop every connection and refuse new ones, as a dropped network does
//   /links   the links the server has now
createServer((req, res) => {
  const [, what, how] = (req.url ?? "").split("/");
  if (what === "store") server.membershipStore = how === "on";
  if (what === "offline") {
    offline = how === "on";
    if (offline) for (const s of live) s.destroy();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ store: server.membershipStore, offline, links: server.membership.default ?? [] }, null, 1));
}).listen(port + 1, "127.0.0.1");
