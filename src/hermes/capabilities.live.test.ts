// Connection diagnostics against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set. It signs in with
// the dashboard's basic provider, opens /api/ws, and runs the same CapabilityStore the app does, with failures worded as
// the Rust relay words them. Every check reads, but for the two write checks Check again sends for what can't exist (a
// toolset no toolset is, an Approval no session has, ADR 0165), so any dashboard will do; it prints the redacted
// report. Run it against a throwaway dashboard, for example:
//
//   HERMES_LIVE_DASHBOARD=http://127.0.0.1:9361/ HERMES_LIVE_USER=fixture HERMES_LIVE_PASSWORD=… \
//   npx vitest run src/hermes/capabilities.live.test.ts
//
// HERMES_LIVE_EXPECT, when set, is a comma-separated list of `id=state` the run must find, such as
// `projects=unsupported,toolsets=supported`.
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CapabilityStore, reportText, type CapabilityIO } from "./capabilities";
import { RpcError } from "./transport";
import { RestError } from "./pipe";

declare const process: { env: Record<string, string | undefined> };
const BASE = process.env.HERMES_LIVE_DASHBOARD;

async function signedIn() {
  let cookie = "";
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const login = await send("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
  if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);
  const { ticket } = (await (await send("POST", "api/auth/ws-ticket")).json()) as { ticket: string };
  const url = new URL(`api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`, BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.onerror = () => reject(new Error("the WebSocket failed"));
    ws.onmessage = (m) => {
      for (const line of String(m.data).split("\n").filter((l) => l.trim())) {
        const f = JSON.parse(line);
        if (f.method === "event" && f.params?.type === "gateway.ready") resolve(f.params.payload ?? {});
        const p = typeof f.id === "number" ? pending.get(f.id) : undefined;
        if (!p) continue;
        pending.delete(f.id);
        if (f.error) p.reject(new RpcError(f.error.code, f.error.message));
        else p.resolve(f.result);
      }
    };
  });
  let id = 0;
  const sent: string[] = [];
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      sent.push(`RPC ${method}`);
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  // As the Rust relay words a failure (src-tauri/src/transport.rs `TransportError`).
  const io: CapabilityIO = {
    get: async (path, maxBytes) => {
      sent.push(`GET ${path.split("?")[0]}`);
      const res = await send("GET", path);
      const text = await res.text();
      if (res.status === 401) throw new RestError(401, "", "The dashboard sign-in has expired. Sign in again.");
      if (!res.ok) throw new RestError(res.status, text.slice(0, 300));
      if (maxBytes !== undefined && text.length > maxBytes) throw new Error(`it's ${(text.length / 2 ** 20).toFixed(1)} MB now, over the ${Math.floor(maxBytes / 2 ** 20)} MB limit`);
      return text;
    },
    rpc,
    put: async (path, body) => {
      sent.push(`PUT ${path.split("?")[0]}`);
      const res = await send("PUT", path, body);
      const text = await res.text();
      if (!res.ok) throw new RestError(res.status, text.slice(0, 300));
      return text;
    },
  };
  return { io, ready: await ready, rpc, sent, close: () => ws.close() };
}

describe.skipIf(!BASE)("diagnostics against a real dashboard", () => {
  it("reads what the server is and checks every feature, by reading and the two write checks", async () => {
    const live = await signedIn();
    const store = new CapabilityStore(live.io, () => 1, Date.now, 15_000, 0);
    store.connected(1, "default", live.ready, live.rpc("client.capabilities", { server_requests: true }));
    await store.refresh();
    const snap = store.getSnapshot();
    console.log(reportText(snap, { app: "Hermes Chat (live test)", server: BASE, signIn: "Dashboard username and password, at the dashboard's URL", headers: 0, unsecure: true, profile: "default" }));
    console.log(`Sent: ${[...new Set(live.sent)].sort().join(", ")}`);
    expect(snap.checking).toBe(false);
    expect(snap.facts.protocol).toBe("legacy");
    expect(snap.facts.version ?? snap.facts.build ?? snap.facts.commit).toBeTruthy();
    // Only reads went out, and the two write checks: GETs, the JSON-RPC methods the contract names as reads, a PUT for
    // the toolset no toolset is, and approval.respond for an Approval no session has.
    const reads = /^RPC (client\.capabilities|gateway\.capabilities|projects\.list|commands\.catalog|session\.active_list|learning\.detail|profiles\.list|subagent\.roster)$/;
    const writeChecks = new Set(["PUT api/tools/toolsets/__hermes_chat_probe__", "RPC approval.respond"]);
    expect(live.sent.filter((s) => !s.startsWith("GET ") && !reads.test(s) && !writeChecks.has(s))).toEqual([]);
    for (const c of CAPABILITIES) expect(["supported", "unsupported", "unknown", "unreachable"]).toContain(snap.caps[c.id].state);
    for (const pair of (process.env.HERMES_LIVE_EXPECT ?? "").split(",").filter(Boolean)) {
      const [id, state] = pair.split("=");
      expect(snap.caps[id as keyof typeof snap.caps]?.state, id).toBe(state);
    }
    store.disconnected();
    live.close();
  }, 120_000);
});
