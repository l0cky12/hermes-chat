// A stand-in Hermes dashboard for the Idle compaction screenshots (ADR 0119): sign-in, the WS ticket, `/api/ws` and
// dashboard REST, all answered by the tests' FakeHermes with synthetic chats. Loopback only. Build and run:
//   npx rolldown docs/screenshots/idle-compaction/bridge.ts --platform node -o /tmp/idle-bridge.mjs && node /tmp/idle-bridge.mjs 47876
// The chat it serves reports its context window 82% full with a compactor, as the deployed Hermes does through
// `session.info.usage`, and `session.compress` answers with Hermes's own counts. No model runs.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47876);
const server = new FakeHermes();
server.sessions = [
  row("dns", 0.2, { title: "Move the homelab DNS to two resolvers" }),
  row("nas", 1.5, { title: "Nightly NAS backup check" }),
];
server.storeMessage("dns", { role: "user", text: "Pi-hole on the old box keeps dropping queries. Can we move DNS to two resolvers?" });
server.storeMessage("dns", {
  role: "assistant",
  text: "Yes. I'd run **two Unbound resolvers** behind Pi-hole: one on `nas-01`, one on `pve-02`, each forwarding nothing and validating DNSSEC.\n\nI've written both configs and checked them with `unbound-checkconf`. Next: point DHCP at both and lower the TTL a day ahead.",
});
server.storeMessage("dns", { role: "user", text: "Do it, and keep the old box as a third fallback for a week." });
server.storeMessage("dns", {
  role: "assistant",
  text: "Done. DHCP now hands out `10.0.0.53` and `10.0.0.54`, with `10.0.0.2` third. Both resolvers answer in under 4 ms from the office VLAN, and `dig +dnssec` validates on each.\n\nI'll leave the old box in place until next Wednesday.",
});
server.storeMessage("nas", { role: "user", text: "Did last night's backup finish?" });
server.storeMessage("nas", { role: "assistant", text: "Yes: 41.2 GB added at 03:12, no errors." });
// What `session.info` carries for a long chat on a 200k-token model, with a compactor (`compressions` present).
server.sessionInfo = {
  ...(server.sessionInfo as object),
  model: "claude-opus-5-5",
  provider: "anthropic",
  usage: { model: "claude-opus-5-5", input: 151_200, output: 9_800, calls: 64, context_used: 164_380, context_max: 200_000, context_percent: 82, context_source: "provider_usage", context_estimated: false, compressions: 0 },
};
server.compressResult = {
  status: "compressed",
  removed: 51,
  before_messages: 64,
  after_messages: 13,
  before_tokens: 164_380,
  after_tokens: 23_900,
  summary: { headline: "Compressed: 64 → 13 messages", token_line: "~164,380 → ~23,900 tokens" },
};

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
