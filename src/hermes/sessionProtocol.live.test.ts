// The canonical session protocol against a REAL canonical gateway (ADR 0174): skipped unless HERMES_LIVE_CANONICAL is
// set. It signs in with the dashboard's basic provider, as the app does, and checks three things. The app's own
// `connect` turns the server away and sends it nothing. Every JSON-RPC method the app sends gets the answer
// canonicalVerbs.ts records for it. And the frames an adapter would send instead (a turn, an Approval, a Clarify, Stop,
// a second window, a rename) work as ADR 0174 says, which needs the stub model: set HERMES_LIVE_STUB=1.
//
// It starts chats and a project, so run it against a throwaway gateway only. `tools/canonical-gateway.py` starts one:
//
//   HERMES_LIVE_CANONICAL=http://127.0.0.2:47552/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=… HERMES_LIVE_STUB=1 \
//   npx vitest run src/hermes/sessionProtocol.live.test.ts
import { describe, expect, it } from "vitest";
import { APP_VERBS, CANONICAL_READY, type CanonicalAnswer } from "./canonicalVerbs";
import { protocolOf } from "./capabilities";
import type { OpenPipe, Pipe } from "./pipe";
import { explainSignIn, signInError } from "./setup";
import { ProtocolMismatchError, connect, toSource } from "./transport";

declare const process: { env: Record<string, string | undefined> };
const BASE = process.env.HERMES_LIVE_CANONICAL;
const STUB = !!process.env.HERMES_LIVE_STUB;
const PROFILE = "default";

type Json = Record<string, unknown>;
type Event = { type: string; session_id?: string; payload: Json; seq?: number; replay_epoch?: string; authority_epoch?: number; execution_generation?: number; admission_id?: string };
type Answer = { result?: Json; error?: { code: number; message: string; data?: { fields?: string[]; revision?: number } | null } };

async function signedIn() {
  let cookie = "";
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const login = await rest("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
  if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);

  /** One `/api/ws` connection, opened with a fresh ticket as the Rust relay opens it. */
  const socket = async (onText?: (text: string) => void) => {
    const { ticket } = (await (await rest("POST", "api/auth/ws-ticket")).json()) as { ticket: string };
    const url = new URL(`api/ws?ticket=${encodeURIComponent(ticket)}&profile=${PROFILE}`, BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    const pending = new Map<number, (a: Answer) => void>();
    const events: Event[] = [];
    const waiting = new Set<() => void>();
    const sent: string[] = [];
    let id = 0;
    const ready = new Promise<Json>((resolve, reject) => {
      ws.onerror = () => reject(new Error("the WebSocket failed"));
      ws.onmessage = (m) => {
        onText?.(String(m.data));
        for (const line of String(m.data).split("\n").filter((l) => l.trim())) {
          const f = JSON.parse(line);
          if (f.method === "event" && f.params?.type === "gateway.ready") resolve(f.params.payload ?? {});
          else if (f.method === "event") events.push({ ...f.params, payload: f.params.payload ?? {} });
          else if (typeof f.id === "number") pending.get(f.id)?.(f);
          for (const wake of waiting) wake();
        }
      };
    });
    const payload = await ready;
    const send = (text: string) => {
      sent.push(text);
      ws.send(text);
    };
    const rpc = (method: string, params: Json) =>
      new Promise<Answer>((resolve) => {
        pending.set(++id, resolve);
        send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    /** The next event of `type` for the session, among those not yet taken. */
    const event = async (type: string, sid: string, within = 60_000): Promise<Event> => {
      const until = Date.now() + within;
      for (;;) {
        const i = events.findIndex((e) => e.type === type && e.session_id === sid);
        if (i >= 0) return events.splice(0, i + 1)[i];
        if (Date.now() > until) throw new Error(`no ${type} within ${within} ms; saw ${events.map((e) => e.type).join(", ")}`);
        await new Promise<void>((wake) => {
          const done = () => (waiting.delete(done), clearTimeout(timer), wake());
          const timer = setTimeout(done, 500);
          waiting.add(done);
        });
      }
    };
    return { ready: payload, rpc, event, send, sent, close: () => ws.close() };
  };

  /** A canonical session, started as an adapter would start it. */
  const chat = async (s: Awaited<ReturnType<typeof socket>>) => {
    const made = (await s.rpc("session.create", { source: "gui" })).result!;
    return { sid: made.session_id as string, subscription: made.subscription_id as string, made };
  };
  const submit = (s: Awaited<ReturnType<typeof socket>>, sid: string, text: string) => s.rpc("prompt.submit", { session_id: sid, text, submission_id: crypto.randomUUID() });
  return { rest, socket, chat, submit };
}

// One sign-in for the whole file: Hermes allows an address ten a minute.
let shared: ReturnType<typeof signedIn> | undefined;
const signIn = () => (shared ??= signedIn());

const answerOf = (a: Answer): CanonicalAnswer => {
  if (!a.error) return "ok";
  const fields = a.error.data?.fields;
  return { code: a.error.code, message: a.error.message, ...(Array.isArray(fields) && { fields }) };
};

describe.skipIf(!BASE)("a real canonical gateway", () => {
  it("names the canonical protocol in gateway.ready", async () => {
    const live = await signIn();
    const s = await live.socket();
    expect(s.ready.session_authority).toBe(true);
    expect(protocolOf(s.ready)).toBe("canonical");
    expect(Object.keys(s.ready).sort()).toEqual(Object.keys(CANONICAL_READY).sort());
    s.close();
  }, 60_000);

  it("is turned away by the app, which sends it nothing", async () => {
    const live = await signIn();
    let s: Awaited<ReturnType<typeof live.socket>> | undefined;
    const openPipe: OpenPipe = async (onEvent) => {
      const first: string[] = [];
      let forward: ((text: string) => void) | undefined;
      s = await live.socket((text) => (forward ? forward(text) : first.push(text)));
      const pipe: Partial<Pipe> = { route: { kind: "url", url: BASE!, addresses: [] }, send: async (frame) => s!.send(frame), close: async () => s!.close() };
      forward = (text) => onEvent({ kind: "frame", text });
      first.forEach(forward);
      return pipe as Pipe;
    };
    const failed = await connect(openPipe).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(ProtocolMismatchError);
    expect(s!.sent).toEqual([]);
    expect(explainSignIn(signInError(failed), { mode: "url", sshTarget: "", url: BASE!, username: "owner", password: "" })).toMatchObject({
      stage: "chat",
      problem: "Hermes Chat can't talk to this server yet.",
    });
  }, 60_000);

  it("answers each JSON-RPC method the app sends as canonicalVerbs.ts records", async () => {
    const live = await signIn();
    const s = await live.socket();
    const { sid } = await live.chat(s);
    const differs: { method: string; shape?: string; recorded: CanonicalAnswer; live: CanonicalAnswer }[] = [];
    for (const v of APP_VERBS.filter((v) => !v.unprobed)) {
      const got = answerOf(await s.rpc(v.method, v.params({ sid, profile: PROFILE })));
      if (JSON.stringify(got) !== JSON.stringify(v.answer)) differs.push({ method: v.method, shape: v.shape, recorded: v.answer, live: got });
    }
    expect(differs).toEqual([]);
    s.close();
  }, 300_000);

  it("refuses a session edit over REST that names no revision, and renames with session.mutate", async () => {
    const live = await signIn();
    const s = await live.socket();
    const { sid, made } = await live.chat(s);
    const patched = await live.rest("PATCH", `api/sessions/${sid}?profile=${PROFILE}`, { title: "Renamed over REST" });
    expect(patched.status).toBe(409);
    expect(((await patched.json()) as { detail: string }).detail).toMatch(/^client_upgrade_required/);
    // A title another chat has is answered "internal error" (-32603), so each run names its own.
    const title = `Renamed ${crypto.randomUUID().slice(0, 8)}`;
    const rename = (expected_revision: number) =>
      s.rpc("session.mutate", { session_id: sid, request_id: crypto.randomUUID(), expected_revision, operation: "rename", payload: { title } });
    const stale = await rename((made.revision as number) + 7);
    expect(stale.error).toMatchObject({ code: 4001, message: "revision_conflict", data: { revision: made.revision } });
    expect((await rename(made.revision as number)).result).toMatchObject({ session_id: sid, operation: "rename", title });
    expect((await s.rpc("session.detach", { session_id: sid, subscription_id: made.subscription_id })).result).toMatchObject({ detached: true });
    s.close();
  }, 60_000);
});

describe.skipIf(!BASE || !STUB)("a real canonical gateway, with the stub model", () => {
  it("runs a turn submitted with a submission id, each event stamped with its admission and generation", async () => {
    const live = await signIn();
    const s = await live.socket();
    const { sid, made } = await live.chat(s);
    expect(made).toMatchObject({ stored_session_id: sid, running: false, execution_generation: 0, pending: [], prompts: [] });
    const receipt = (await live.submit(s, sid, "hello")).result!;
    expect(receipt).toMatchObject({ status: "queued", ref: { session_id: sid } });
    const start = await s.event("message.start", sid);
    expect(start).toMatchObject({ admission_id: receipt.admission_id, execution_generation: 1, authority_epoch: made.authority_epoch, replay_epoch: made.replay_epoch });
    expect(start.seq).toBeGreaterThan(0);
    const done = await s.event("message.complete", sid);
    expect(done.payload).toMatchObject({ text: "Stub model reply.", status: "complete", outcome: "completed", admission_id: receipt.admission_id });

    const again = (await s.rpc("session.resume", { session_id: sid })).result!;
    expect(again).toMatchObject({ session_id: sid, running: false, execution_generation: 1, message_count: 2 });
    const replay = (await s.rpc("session.events.since", { session_id: sid, last_sequence: start.seq, replay_epoch: start.replay_epoch })).result!;
    expect(replay).toMatchObject({ snapshot_required: false, truncated: false });
    expect((replay.events as Event[]).map((e) => e.type)).toContain("message.complete");
    // The app's own read names no epoch, and gets no events back.
    expect((await s.rpc("session.events.since", { session_id: sid, last_seen: start.seq })).result).toMatchObject({ snapshot_required: true, events: [] });

    // Hermes files the chat as one of its own local chats, started on the desktop: the app would show it as Hermes
    // Desktop's, not as its own.
    const { sessions } = (await (await live.rest("GET", `api/sessions?profile=${PROFILE}&limit=50&order=recent`)).json()) as { sessions: { id: string; source: string; created_source: string }[] };
    const row = sessions.find((r) => r.id === sid)!;
    expect(row).toMatchObject({ source: "local", created_source: "desktop" });
    expect(toSource(row.source, row.created_source)).toBe("desktop");
    s.close();
  }, 120_000);

  it("asks for an Approval with an event, which a second window finds on resume and answers by prompt id", async () => {
    const live = await signIn();
    const first = await live.socket();
    const { sid } = await live.chat(first);
    await live.submit(first, sid, "approve-me");
    const asked = await first.event("approval.request", sid);
    expect(asked.payload).toMatchObject({ kind: "approval", execution_generation: 1, choices: expect.arrayContaining(["once", "deny"]) });

    const second = await live.socket();
    const snapshot = (await second.rpc("session.resume", { session_id: sid })).result!;
    expect(snapshot).toMatchObject({ running: true, execution_generation: 1, prompts: [{ kind: "approval", prompt_id: asked.payload.prompt_id }] });
    const respond = () => second.rpc("approval.respond", { session_id: sid, execution_generation: 1, prompt_id: asked.payload.prompt_id, choice: "deny" });
    expect((await respond()).result).toEqual({ status: "resolved", prompt_id: asked.payload.prompt_id });
    expect((await respond()).result).toEqual({ status: "already_resolved", prompt_id: asked.payload.prompt_id });
    expect((await first.event("approval.settled", sid)).payload).toMatchObject({ prompt_id: asked.payload.prompt_id });
    expect((await first.event("message.complete", sid)).payload.text).toMatch(/denied/i);
    first.close();
    second.close();
  }, 120_000);

  it("asks a Clarify with an event, answered by prompt id", async () => {
    const live = await signIn();
    const s = await live.socket();
    const { sid } = await live.chat(s);
    await live.submit(s, sid, "clarify-me");
    const asked = await s.event("clarify.request", sid);
    expect(asked.payload).toMatchObject({ kind: "clarify", question: "Tea or coffee?", execution_generation: 1 });
    const answered = await s.rpc("clarify.respond", { session_id: sid, execution_generation: 1, prompt_id: asked.payload.prompt_id, answer: "Tea" });
    expect(answered.result).toEqual({ status: "resolved", prompt_id: asked.payload.prompt_id });
    expect((await s.event("message.complete", sid)).payload.text).toMatch(/Tea/);
    s.close();
  }, 120_000);

  it("stops a turn only when Stop names the turn's generation", async () => {
    const live = await signIn();
    const s = await live.socket();
    const { sid } = await live.chat(s);
    await live.submit(s, sid, "slow");
    const delta = await s.event("message.delta", sid);
    expect((await s.rpc("session.interrupt", { session_id: sid })).error).toMatchObject({ code: 4001, message: "stale_generation" });
    expect((await s.rpc("session.interrupt", { session_id: sid, execution_generation: delta.execution_generation })).result).toMatchObject({ execution_generation: 1 });
    expect((await s.event("message.complete", sid)).payload).toMatchObject({ status: "interrupted", outcome: "cancelled" });
    s.close();
  }, 120_000);
});
