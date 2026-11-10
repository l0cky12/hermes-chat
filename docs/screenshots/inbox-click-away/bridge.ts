// A stand-in Hermes dashboard for the Inbox click-away and rail screenshots (ADR 0116) in the real Tauri app: sign-in,
// the WS ticket, `/api/ws` and dashboard REST, all answered by the tests' FakeHermes with synthetic chats, and Unread
// chats and a waiting Approval in a second profile so the Inbox has entries. Loopback only.
//   npx rolldown docs/screenshots/inbox-click-away/bridge.ts --platform node -o /tmp/inbox-bridge.mjs && node /tmp/inbox-bridge.mjs 47911
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47866);
const server = new FakeHermes();

// Synthetic: nothing here came from a real chat.
server.sessions = [
  row("nginx", 0.01, { title: "Rotate nginx logs", pinned: true }),
  row("nas", 1, { title: "NAS disk usage", pinned: true, last_read_at: 0 }),
  row("vpn", 2, { title: "Why is the VPN slow", pinned: true }),
  row("pg", 3, { title: "Plan the Postgres upgrade", pinned: true }),
];
const nowS = () => Date.now() / 1000;
server.otherProfiles = {
  work: [
    row("deploy", 0.02, { pinned: true, title: "Deploy plan", last_read_at: 0 }),
    row("migrate", 0, { pinned: true, title: "Migrate the wiki database", last_read_at: nowS() }),
  ],
};
server.liveSessions = [{ id: "rt-w", session_key: "migrate", status: "waiting", last_active: nowS() - 300 }];
const say = (id: string, q: string, a: string) => {
  server.storeMessage(id, { role: "user", text: q });
  server.storeMessage(id, { role: "assistant", text: a });
};
say("nginx", "Can you rotate the nginx logs and keep 14 days?", "Done. `logrotate` now keeps **14** daily archives, compressed after a day.");
say("nas", "How full is the NAS?", "The `tank` pool is at **71%**: 5.1 TB used of 7.2 TB. Snapshots take 640 GB of that.");
say("vpn", "Why is the VPN slow tonight?", "The tunnel MTU is 1500, so large packets fragment. Setting `MTU = 1420` in `wg0.conf` should fix it.");
say("pg", "Plan the Postgres 17 upgrade.", "1. Take a base backup.\n2. Run `pg_upgrade --check`.\n3. Upgrade in a maintenance window, then `ANALYZE`.");

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
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => void pipe!.send(t));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));
