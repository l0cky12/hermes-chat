// A stand-in Hermes dashboard for screenshots of Voice conversations in the real Tauri app (ADR 0111): sign-in, the WS
// ticket, `/api/ws` and dashboard REST answered by the tests' FakeHermes, plus the two audio routes the app uses.
// Everything is synthetic: chats, transcripts, replies and the reply audio (a generated chime). Loopback only.
//   npx rolldown docs/screenshots/voice-conversation/bridge.ts --platform node -o /tmp/voice-bridge.mjs
//   node /tmp/voice-bridge.mjs 47830 [silence_threshold] [recordings dir]
// Controls: `GET /__hold` keeps the next reply thinking until `GET /__release`; `GET /__fail-stt` makes the next
// transcription fail as a server without a transcriber does; `GET /__heard?text=…` sets what the next one returns.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47830);
const threshold = Number(process.argv[3] ?? 200);
const saveDir = process.argv[4];
if (saveDir) mkdirSync(saveDir, { recursive: true });
const server = new FakeHermes();

server.sessions = [
  row("backup", 0.2, { pinned: true, title: "Nightly backup" }),
  row("nas", 1, { pinned: true, title: "NAS disks" }),
  row("vpn", 3, { title: "Why is the VPN slow" }),
];
server.storeMessage("backup", { role: "user", text: "Why did last night's backup fail?" });
server.storeMessage("backup", { role: "assistant", text: "The restic repository was **locked** by a process that crashed at 02:10. I removed the stale lock." });
server.storeMessage("nas", { role: "user", text: "How full is the NAS?" });
server.storeMessage("nas", { role: "assistant", text: "Pool `tank` is at 71% (5.2 of 7.3 TB)." });
server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };

const heard = ["Is the nightly backup healthy now?", "Prune snapshots older than thirty days, please.", "Thanks, that's all for now."];
const replies = [
  "Yes. Tonight's run finished at 02:31 with no errors, and the repository check passed.",
  "Done. I pruned 14 snapshots older than 30 days and freed 212 GB.",
  "You're welcome.",
];
let turn = 0;
let nextHeard: string | undefined;
let failStt = false;
let hold = false;
let held: (() => void) | undefined;

/** A soft two-note chime as 16 kHz mono 16-bit WAV: the "speech" Hermes sends back. */
function chime(seconds = 3): Buffer {
  const rate = 16_000;
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVE", 8); out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < seconds / 2 ? 523.25 : 659.25;
    const env = Math.min(1, t * 8, (seconds - t) * 8);
    out.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * 0.15 * env * 32767), 44 + i * 2);
  }
  return out;
}

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

/** Hermes's reply to a prompt: streamed in a few pieces after a moment, unless held. */
function replyTo(sessionId: string) {
  const text = replies[Math.min(turn - 1, replies.length - 1)] ?? "Done.";
  const go = () => {
    server.event(sessionId, "message.start");
    const words = text.split(" ");
    let at = 0;
    const step = () => {
      const from = at;
      at = Math.min(words.length, at + 4);
      server.event(sessionId, "message.delta", { text: words.slice(from, at).join(" ") + (at < words.length ? " " : "") });
      if (at < words.length) setTimeout(step, 150);
      else setTimeout(() => server.event(sessionId, "message.complete", { text, status: "complete" }), 150);
    };
    setTimeout(step, 300);
  };
  if (hold) held = go;
  else setTimeout(go, 900);
}

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
  if (url.pathname === "/__hold") return (hold = true), json(200, { hold });
  if (url.pathname === "/__release") return (hold = false), held?.(), (held = undefined), json(200, { hold });
  if (url.pathname === "/__fail-stt") return (failStt = true), json(200, { failStt });
  if (url.pathname === "/__heard") return (nextHeard = url.searchParams.get("text") ?? ""), json(200, { nextHeard });
  // `POST /api/audio/transcribe` as `hermes_cli/web_routers/audio.py` answers it.
  if (url.pathname === "/api/audio/transcribe" && req.method === "POST") {
    const { data_url } = JSON.parse(body ?? "{}") as { data_url?: string };
    if (!data_url) return json(400, { detail: "Invalid audio payload" });
    const audio = Buffer.from(data_url.split(",")[1] ?? "", "base64");
    if (saveDir) writeFileSync(`${saveDir}/turn-${Date.now()}.wav`, audio);
    console.log(`transcribe: ${audio.length} bytes, ${audio.subarray(0, 4).toString()} ${audio.readUInt32LE(24)} Hz ${audio.readUInt16LE(22)} ch`);
    if (failStt) {
      failStt = false;
      return json(400, {
        detail: "No STT provider available. Install faster-whisper for free local transcription, or set GROQ_API_KEY for free Groq Whisper.",
      });
    }
    const transcript = nextHeard ?? heard[Math.min(turn, heard.length - 1)];
    nextHeard = undefined;
    return json(200, { ok: true, transcript, provider: "local" });
  }
  if (url.pathname === "/api/audio/speak" && req.method === "POST") {
    const { text } = JSON.parse(body ?? "{}") as { text?: string };
    if (!text?.trim()) return json(400, { detail: "Text is required" });
    console.log(`speak: ${text}`);
    return json(200, { ok: true, data_url: `data:audio/wav;base64,${chime().toString("base64")}`, mime_type: "audio/wav", provider: "edge" });
  }
  try {
    let text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    // The profile's voice settings, merged into the fake's own config as Hermes's `GET /api/config` would have them.
    if (url.pathname === "/api/config" && req.method === "GET") {
      const config = JSON.parse(text);
      config.stt = { ...config.stt, enabled: true, provider: "local" };
      config.tts = { ...config.tts, provider: "edge" };
      config.voice = { ...config.voice, silence_threshold: threshold, silence_duration: 1.5, max_recording_seconds: 60 };
      text = JSON.stringify(config);
    }
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
  readFrames(sock, (t) => {
    try {
      const msg = JSON.parse(t) as { method?: string; params?: { session_id?: string } };
      if (msg.method === "prompt.submit" && msg.params?.session_id) {
        turn++;
        // After the fake has answered the submit.
        setTimeout(() => replyTo(msg.params!.session_id!), 0);
      }
    } catch {
      // Not JSON: the fake answers it as it would.
    }
    void pipe!.send(t);
  });
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));
