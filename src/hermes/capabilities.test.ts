// The capability store (capabilities.ts, ADR 0044) against a scripted Hermes: what each kind of answer means, when
// checks run again, that late answers for an older connection are dropped, that nothing it sends writes, and that the
// copied report holds no secret. The answers are modelled on Hermes's own source: upstream `74b2ed6` and 0.16.0.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES,
  CapabilityStore,
  PROBE_TIMEOUT_MS,
  RECHECK_AFTER_MS,
  approvalsFailed,
  approvalsFrom,
  failureOf,
  sharesChats,
  flagsFrom,
  healthFacts,
  redact,
  reportText,
  stateOfFailure,
  statusFacts,
  type CapabilityIO,
} from "./capabilities";
import { RpcError } from "./transport";
import { RestError } from "./pipe";

afterEach(() => vi.useRealTimers());

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));

/** A Hermes as upstream `74b2ed6` answers each read the store makes. */
const NEW: Record<string, unknown> = {
  "GET api/health": { ok: true, version: "0.17.0", displayVersion: "0.17.0", commit: "74b2ed65e6", auth_required: true },
  "GET api/status": { version: "0.17.0", release_date: "2026-11-01", hermes_home: "/home/h/.hermes", install_id: "abc", auth_required: true, auth_providers: ["basic"], auth_flows: ["cookie"] },
  "RPC gateway.capabilities": { per_session_exclusive_submit: true, not_a_flag: "x" },
  "RPC projects.list": { projects: [], active_id: null },
  "RPC commands.catalog": { pairs: [] },
  "RPC session.active_list": { sessions: [] },
  "RPC subagent.roster": { sessions: [] },
  "RPC learning.detail": { ok: false, message: "skill '__hermes_chat_probe__' not found" },
  "RPC profiles.list": { profiles: [{ name: "default", is_default: true, canonical_session: null }], bot_mode_protocol: true },
  "GET api/tools/toolsets": [],
  "GET api/profiles/default/soul": { content: "", exists: false },
  "GET api/skills": [],
  "GET api/files": { path: "/", entries: [] },
  "GET api/cron/jobs": [],
  "GET api/webhooks": { enabled: true, subscriptions: [] },
  "GET api/fs/list": { path: "/", entries: [] },
};

const noRoute = () => answered(404, "Not Found");
const noMethod = (m: string) => new RpcError(-32601, `unknown method: ${m}`);

/** Hermes 0.16.0: no /api/health, no gateway.capabilities, no projects.*, learning.*, managed files or fs routes. */
const OLD: Record<string, unknown> = {
  ...NEW,
  "GET api/health": answered(404, "No such API endpoint: /api/health"),
  "GET api/status": { version: "0.16.0", release_date: "2026.6.8", auth_required: true, auth_providers: ["basic"] },
  "RPC gateway.capabilities": noMethod("gateway.capabilities"),
  "RPC projects.list": noMethod("projects.list"),
  "RPC learning.detail": noMethod("learning.detail"),
  "RPC profiles.list": noMethod("profiles.list"),
  "RPC subagent.roster": noMethod("subagent.roster"),
  "GET api/files": noRoute(),
  "GET api/fs/list": noRoute(),
};

/**
 * A scripted IO: each answer is looked up by `GET path` (no query) or `RPC method`. An Error rejects; a function is
 * called for a promise (to hold an answer back); anything else is the answer. Every call is recorded.
 */
function scripted(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const answer = (key: string): Promise<unknown> => {
    calls.push(key);
    const a = answers[key];
    if (a === undefined) return Promise.reject(noRoute());
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === "function") return (a as () => Promise<unknown>)();
    return Promise.resolve(a);
  };
  const io: CapabilityIO = {
    get: (pathAndQuery) => answer(`GET ${pathAndQuery.split("?")[0]}`).then((v) => (typeof v === "string" ? v : JSON.stringify(v))),
    rpc: (method) => answer(`RPC ${method}`),
  };
  return { io, calls, answers };
}

function store(answers: Record<string, unknown>, opts: { now?: () => number; gen?: () => number } = {}) {
  const s = scripted(answers);
  let gen = 1;
  const caps = new CapabilityStore(s.io, opts.gen ?? (() => gen), opts.now ?? Date.now, 1000, 0);
  return { ...s, caps, setGen: (g: number) => (gen = g) };
}

/** Connects at generation `gen` and waits for the whole check. */
async function connectAndCheck(t: ReturnType<typeof store>, gen = 1, told: Promise<unknown> = Promise.resolve({ server_requests: ["approval", "clarify"] })) {
  t.setGen(gen);
  const before = t.caps.getSnapshot().checkedAt;
  t.caps.connected(gen, "default", { skin: {}, change_events: true }, told);
  await vi.waitFor(() => {
    const snap = t.caps.getSnapshot();
    expect(snap.checking).toBe(false);
    expect(snap.checkedAt).toBeDefined();
    expect(snap.checkedAt).not.toBe(before);
  });
}

const states = (caps: CapabilityStore) => Object.fromEntries(Object.values(caps.getSnapshot().caps).map((c) => [c.id, c.state]));

describe("the capability contract", () => {
  it("starts every capability unknown, with nothing checked and no version", () => {
    const { caps } = store(NEW);
    const snap = caps.getSnapshot();
    expect(Object.values(snap.caps).every((c) => c.state === "unknown" && c.checkedAt === undefined)).toBe(true);
    expect(snap.facts).toEqual({});
    expect(snap.stale).toBe(true);
  });

  it("checks only by reading: a GET, or a JSON-RPC method that only reads", () => {
    const reads = new Set(["projects.list", "commands.catalog", "session.active_list", "learning.detail", "profiles.list", "subagent.roster"]);
    for (const c of CAPABILITIES) {
      if (!c.probe) continue;
      if (c.probe.kind === "rpc") expect(reads.has(c.probe.method), c.id).toBe(true);
      // A probe's method is never one its capability counts as a write.
      if (c.probe.kind === "rpc") expect(c.writeMethods?.test(c.probe.method) ?? false, c.id).toBe(false);
    }
  });
});

describe("a check of a new Hermes (upstream 74b2ed6)", () => {
  it("finds every feature supported, and reads the version, protocol, sign-in and flags", async () => {
    const t = store(NEW);
    await connectAndCheck(t);
    const snap = t.caps.getSnapshot();
    expect(states(t.caps)).toEqual({
      chat: "supported",
      approvals: "supported",
      projects: "supported",
      commands: "supported",
      liveSessions: "supported",
      memory: "supported",
      toolsets: "supported",
      // Only Settings → Toolsets can learn this, with its own check.
      toolsetSwitches: "unknown",
      persona: "supported",
      skills: "supported",
      serverFiles: "supported",
      scheduledJobs: "supported",
      automations: "supported",
      outputs: "supported",
      botMode: "supported",
      // Only a chat's own subagent.list can learn this.
      subagents: "unknown",
      subagentRoster: "supported",
      // Only answering an Approval can learn this.
      approvalAnswers: "unknown",
    });
    expect(snap.facts).toEqual({
      version: "0.17.0",
      build: "0.17.0",
      commit: "74b2ed65e6",
      releaseDate: "2026-11-01",
      protocol: "legacy",
      authRequired: true,
      authProviders: ["basic"],
      authFlows: ["cookie"],
      flags: ["per_session_exclusive_submit"],
      declinesNotShown: false,
    });
    expect(snap.stale).toBe(false);
    expect(snap.checking).toBe(false);
    // Nothing of /api/status past the facts is kept: no path or install id.
    expect(JSON.stringify(snap)).not.toMatch(/hermes_home|install_id|\/home\/h/);
  });

  it("sends nothing that writes", async () => {
    const t = store(NEW);
    await connectAndCheck(t);
    expect(t.calls.every((c) => c.startsWith("GET ") || /^RPC (gateway\.capabilities|projects\.list|commands\.catalog|session\.active_list|learning\.detail|profiles\.list|subagent\.roster)$/.test(c))).toBe(true);
  });
});

describe("a check of an old Hermes (0.16.0)", () => {
  it("reads the version from /api/status, and finds what it lacks unsupported", async () => {
    const t = store(OLD);
    await connectAndCheck(t, 1, Promise.reject(noMethod("client.capabilities")));
    const snap = t.caps.getSnapshot();
    expect(snap.facts.version).toBe("0.16.0");
    expect(snap.facts.commit).toBeUndefined();
    expect(snap.facts.flags).toBeUndefined();
    expect(snap.facts.flagsWhy).toMatch(/advertises no feature flags/);
    expect(states(t.caps)).toMatchObject({
      chat: "supported",
      approvals: "unsupported",
      projects: "unsupported",
      memory: "unsupported",
      serverFiles: "unsupported",
      outputs: "unsupported",
      botMode: "unsupported",
      subagentRoster: "unsupported",
      toolsets: "supported",
      scheduledJobs: "supported",
      persona: "supported",
    });
    expect(t.caps.get("projects").why).toBe("Hermes has no such method.");
    expect(t.caps.get("serverFiles").why).toMatch(/no such route \(it answered 404\)/);
    expect(t.caps.get("approvals").why).toMatch(/older than client\.capabilities/);
  });
});

describe("partial and malformed answers", () => {
  it("keeps what a partial /api/health gives, and fills the rest from /api/status", async () => {
    const t = store({ ...NEW, "GET api/health": { ok: true, version: "unknown", displayVersion: "git.74b2ed6" } });
    await connectAndCheck(t);
    const f = t.caps.getSnapshot().facts;
    // A git checkout says `unknown`, which is no version: /api/status's stands, and the build names the commit.
    expect(f.version).toBe("0.17.0");
    expect(f.build).toBe("git.74b2ed6");
    expect(f.commit).toBeUndefined();
  });

  it("says why there is no version when neither route gives one", async () => {
    const t = store({ ...NEW, "GET api/health": answered(500, "Internal Server Error"), "GET api/status": "not json" });
    await connectAndCheck(t);
    expect(t.caps.getSnapshot().facts.versionWhy).toMatch(/Hermes answered 500, which may pass/);
  });

  it("keeps no fact that looks like a secret", () => {
    expect(healthFacts({ version: "token=fixtureSecret123", displayVersion: "Bearer abcdefghijklmnop", commit: "74b2ed6" })).toMatchObject({ version: undefined, build: undefined, commit: "74b2ed6" });
    expect(statusFacts({ release_date: "password=hunter2", auth_providers: ["basic", "sk-ant-api03-abcdefghijklmnopqrst"] })).toMatchObject({ releaseDate: undefined, authProviders: ["basic"] });
    expect(flagsFrom({ "ghp_abcdefghijklmnopqrstuvwxyz0123": true, ok: true })).toEqual(["ok"]);
  });

  it("drops fields of the wrong type, too long, or with control characters", () => {
    expect(healthFacts({ version: "1.0\u001b[31m", displayVersion: 7, commit: "not-hex!", auth_required: "yes" })).toEqual({
      version: undefined,
      build: undefined,
      commit: undefined,
      authRequired: undefined,
    });
    expect(statusFacts({ version: "x".repeat(81), auth_providers: ["basic", "<script>", 3, "ok_1"] })).toMatchObject({ version: undefined, authProviders: ["basic", "ok_1"] });
    expect(healthFacts([])).toBeUndefined();
    expect(statusFacts("0.17")).toBeUndefined();
    expect(flagsFrom({ a: true, b: false, "bad name": true, c: "true" })).toEqual(["a"]);
    expect(flagsFrom(["a"])).toBeUndefined();
  });

  it("counts an answer of the wrong shape, or not JSON, as unknown", async () => {
    const t = store({ ...NEW, "GET api/tools/toolsets": { toolsets: [] }, "GET api/skills": "<html>", "RPC session.active_list": { sessions: "none" } });
    await connectAndCheck(t);
    expect(t.caps.get("toolsets")).toMatchObject({ state: "unknown", source: "probed", why: expect.stringMatching(/other than what this app reads/) });
    expect(t.caps.get("skills")).toMatchObject({ state: "unknown", why: "Hermes answered with something that isn't JSON." });
    expect(t.caps.get("liveSessions").state).toBe("unknown");
  });

  it("finds Bot Mode unsupported on a profiles.list whose rows don't report a Bot Chat, and unknown on another shape", async () => {
    const t = store({ ...NEW, "RPC profiles.list": { profiles: [{ name: "default", is_default: true }, { name: "ops" }] } });
    await connectAndCheck(t);
    expect(t.caps.get("botMode")).toMatchObject({ state: "unsupported", source: "probed", why: expect.stringMatching(/doesn't report their Bot Chats/) });
    const odd = store({ ...NEW, "RPC profiles.list": { roster: [] } });
    await connectAndCheck(odd);
    expect(odd.caps.get("botMode").state).toBe("unknown");
  });

  it("reads Approvals from the client.capabilities answer, whatever its shape", () => {
    expect(approvalsFrom({ server_requests: ["approval"] }).state).toBe("supported");
    expect(approvalsFrom({ server_requests: ["clarify"] }).state).toBe("unsupported");
    expect(approvalsFrom({ server_requests: "approval" }).state).toBe("unknown");
    expect(approvalsFrom(null).state).toBe("unknown");
    expect(approvalsFailed(new RpcError(4000, "bad params")).state).toBe("unknown");
    expect(approvalsFailed(new Error("Connection closed: x")).state).toBe("unreachable");
  });

  it("knows a Hermes that shares chats by declines_not_shown or by a version from 0.21.3", () => {
    expect(sharesChats({ declinesNotShown: true })).toBe(true);
    expect(sharesChats({})).toBe(false);
    expect(sharesChats({ declinesNotShown: false, version: "0.21.2" })).toBe(false);
    expect(sharesChats({ version: "0.21.3" })).toBe(true);
    expect(sharesChats({ version: "0.21.5" })).toBe(true);
    expect(sharesChats({ version: "0.22.5" })).toBe(true);
    expect(sharesChats({ version: "1.0.0" })).toBe(true);
    expect(sharesChats({ version: "0.20.9" })).toBe(false);
    expect(sharesChats({ build: "0.21.6+12.gbf0203a" })).toBe(true);
    expect(sharesChats({ version: "v0.21.2+canary.20260912T070000Z" })).toBe(false);
    expect(sharesChats({ build: "abc1234" })).toBe(false);
  });

  it("reads each kind of failure as Hermes and the Rust relay word it", () => {
    const of = (e: unknown) => stateOfFailure(failureOf(e)).state;
    expect(of(answered(404, "Not Found"))).toBe("unsupported");
    expect(of(answered(404, "No such API endpoint: /api/x"))).toBe("unsupported");
    expect(of(answered(405, "Method Not Allowed"))).toBe("unsupported");
    // The route is there and names its own reason.
    expect(of(answered(404, "Profile 'x' does not exist"))).toBe("supported");
    expect(of(answered(400, "Unknown toolset"))).toBe("supported");
    expect(of(new RestError(401, "", "The dashboard sign-in has expired. Sign in again."))).toBe("unknown");
    expect(of(answered(403, "Forbidden"))).toBe("unknown");
    expect(of(answered(502, "Bad Gateway"))).toBe("unreachable");
    expect(of(new Error("Can't reach the Hermes dashboard: connection reset"))).toBe("unreachable");
    expect(of(new Error("The app doesn't relay POST api/x"))).toBe("unknown");
    expect(of(new Error("it's 3.1 MB now, over the 2 MB limit"))).toBe("supported");
    expect(of(new RpcError(-32601, "unknown method"))).toBe("unsupported");
    expect(of(new RpcError(-32602, "invalid params"))).toBe("unknown");
    expect(of(new RpcError(4000, "contract"))).toBe("unknown");
    expect(of(new RpcError(5000, "boom"))).toBe("unreachable");
  });
});

describe("time limits", () => {
  it("counts a check that gets no answer in time as couldn't check, and finishes anyway", async () => {
    vi.useFakeTimers();
    const never = () => new Promise(() => {});
    const t = scripted({ ...NEW, "GET api/cron/jobs": never, "RPC commands.catalog": never, "GET api/health": never });
    const caps = new CapabilityStore(t.io, () => 1, Date.now, PROBE_TIMEOUT_MS, 0);
    caps.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] }));
    // The facts first, each read with its own limit, then the checks, so at most two limits pass in all.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10);
    expect(caps.getSnapshot().checking).toBe(true);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10);
    expect(caps.getSnapshot().checking).toBe(false);
    expect(caps.getSnapshot().checkedAt).toBeDefined();
    expect(caps.get("scheduledJobs")).toMatchObject({ state: "unreachable", why: "Hermes didn't answer within 8 s." });
    expect(caps.get("commands").state).toBe("unreachable");
    // /api/status still gave the version.
    expect(caps.getSnapshot().facts.version).toBe("0.17.0");
    expect(caps.get("projects").state).toBe("supported");
  });

  it("waits before its first check, so the chat list loads first", async () => {
    vi.useFakeTimers();
    const t = scripted(NEW);
    const caps = new CapabilityStore(t.io, () => 1, Date.now, 1000, 2000);
    caps.connected(1, "default", {}, Promise.resolve({}));
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls.length).toBeGreaterThan(0);
  });
});

describe("late answers and connection changes", () => {
  it("drops a check's answers once the connection it went out on is gone, as on a profile switch", async () => {
    const held: ((v: unknown) => void)[] = [];
    const hold = () => new Promise((resolve) => held.push(resolve));
    const t = store({ ...NEW, "GET api/files": hold, "RPC projects.list": hold });
    t.caps.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] }));
    await vi.waitFor(() => expect(held.length).toBe(2));
    // The owner switches profile: the transport moves its generation on and tells the store.
    t.setGen(2);
    t.caps.disconnected();
    for (const r of held) r({ path: "/", entries: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.caps.get("serverFiles").state).toBe("unknown");
    expect(t.caps.get("projects").state).toBe("unknown");
    expect(t.caps.getSnapshot()).toMatchObject({ stale: true, checking: false });
  });

  it("drops answers for a connection the transport let go of, even before it says so", async () => {
    const held: ((v: unknown) => void)[] = [];
    const t = store({ ...NEW, "GET api/files": () => new Promise((r) => held.push(r)) });
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    await vi.waitFor(() => expect(held.length).toBe(1));
    t.setGen(2);
    held[0]({ path: "/", entries: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.caps.get("serverFiles").state).toBe("unknown");
    // And a screen's request from the old connection settles nothing either.
    t.caps.observe(1, { route: "api/files?path=/" });
    expect(t.caps.get("serverFiles").state).toBe("unknown");
  });

  it("keeps a newer connection's answers when an older one's arrive late", async () => {
    const held: ((v: unknown) => void)[] = [];
    let first = true;
    const t = store({
      ...NEW,
      "GET api/files": () => {
        if (!first) return Promise.resolve({ path: "/", entries: [] });
        first = false;
        return new Promise((r) => held.push(r));
      },
    });
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    await vi.waitFor(() => expect(held.length).toBe(1));
    t.caps.disconnected();
    await connectAndCheck(t, 2);
    expect(t.caps.get("serverFiles").state).toBe("supported");
    // The first connection's check now answers 404: too late to count.
    held[0](Promise.reject(noRoute()));
    await new Promise((r) => setTimeout(r, 10));
    expect(t.caps.get("serverFiles").state).toBe("supported");
  });

  it("drops the client.capabilities answer of an older connection", async () => {
    let tell!: (v: unknown) => void;
    const t = store(NEW);
    t.caps.connected(1, "default", {}, new Promise((r) => (tell = r)));
    t.caps.disconnected();
    t.setGen(2);
    tell({ server_requests: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.caps.get("approvals").state).toBe("unknown");
  });

  it("shows what it last knew while disconnected, marked stale, and checks nothing", async () => {
    const t = store(NEW);
    await connectAndCheck(t);
    t.caps.disconnected();
    const calls = t.calls.length;
    await t.caps.refresh();
    expect(t.calls.length).toBe(calls);
    expect(t.caps.getSnapshot()).toMatchObject({ stale: true });
    expect(t.caps.get("projects").state).toBe("supported");
  });
});

describe("what the app's own requests show", () => {
  it("keeps a missing route missing when a sibling route answers, in either order and after Check again", async () => {
    for (const order of ["read first", "list first"]) {
      const t = store(NEW);
      await connectAndCheck(t);
      const list = () => t.caps.observe(1, { route: "api/files?path=/" }, undefined, "{}");
      const read = () => t.caps.observe(1, { route: "api/files/read?path=/x" }, noRoute());
      if (order === "read first") (read(), list());
      else (list(), read());
      expect(t.caps.get("serverFiles").state, order).toBe("unsupported");
      // The check reads the list, which answers: reading a file still has no route.
      await t.caps.refresh();
      expect(t.caps.get("serverFiles").state, order).toBe("unsupported");
      expect(t.caps.refuses({ rest: "POST", path: "api/files/upload-stream" })).toBe("serverFiles");
      // Only an answer from that same route takes it back.
      t.caps.observe(1, { route: "api/files/read?path=/x" }, undefined, '{"path":"/x"}');
      expect(t.caps.get("serverFiles").state, order).toBe("supported");
    }
  });

  it("doesn't count an answer that isn't JSON, or of another shape, as support", () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.caps.observe(1, { route: "api/cron/jobs?profile=default" }, undefined, "<html>Sign in</html>");
    expect(t.caps.get("scheduledJobs").state).toBe("unknown");
    t.caps.observe(1, { route: "api/tools/toolsets?profile=default" }, undefined, '{"toolsets":[]}');
    expect(t.caps.get("toolsets").state).toBe("unknown");
    t.caps.observe(1, { method: "session.active_list" }, undefined, { sessions: "none" });
    expect(t.caps.get("liveSessions").state).toBe("unknown");
    t.caps.observe(1, { route: "api/tools/toolsets?profile=default" }, undefined, "[]");
    expect(t.caps.get("toolsets").state).toBe("supported");
  });

  it("keeps a screen's newer answer when a check that started earlier answers late, either way", async () => {
    for (const late of [() => Promise.reject(answered(502, "Bad Gateway")), () => Promise.resolve({ path: "/", entries: [] })]) {
      const held: ((v: Promise<unknown>) => void)[] = [];
      const t = store({ ...NEW, "GET api/files": () => new Promise<unknown>((r) => held.push(r)) });
      t.caps.connected(1, "default", {}, Promise.resolve({}));
      await vi.waitFor(() => expect(held.length).toBe(1));
      // The Server files screen's own read finds no route while the check is out.
      t.caps.observe(1, { route: "api/files?path=/" }, noRoute());
      expect(t.caps.refuses({ rest: "POST", path: "api/files/upload-stream" })).toBe("serverFiles");
      held[0](late());
      await vi.waitFor(() => expect(t.caps.getSnapshot().checking).toBe(false));
      expect(t.caps.get("serverFiles")).toMatchObject({ state: "unsupported", source: "observed" });
      expect(t.caps.refuses({ rest: "POST", path: "api/files/upload-stream" })).toBe("serverFiles");
    }
  });

  it("settles a capability from a screen's answer, but not from a timeout or refusal", async () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.caps.observe(1, { route: "api/cron/jobs?profile=default" }, noRoute());
    expect(t.caps.get("scheduledJobs")).toMatchObject({ state: "unsupported", source: "observed" });
    t.caps.observe(1, { route: "api/cron/jobs?profile=default" }, new Error("Can't reach the Hermes dashboard: timeout"));
    expect(t.caps.get("scheduledJobs").state).toBe("unsupported");
    t.caps.observe(1, { route: "api/cron/jobs?profile=default" }, undefined, "[]");
    expect(t.caps.get("scheduledJobs")).toMatchObject({ state: "supported", source: "observed" });
    t.caps.observe(1, { method: "projects.list" }, noMethod("projects.list"));
    expect(t.caps.get("projects").state).toBe("unsupported");
    // A route no capability names settles nothing.
    t.caps.observe(1, { route: "api/sessions?limit=1" });
    expect(t.caps.get("chat").state).toBe("supported");
  });

  it("doesn't check again what the screens settled meanwhile", async () => {
    const t = store(NEW);
    t.setGen(1);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.caps.observe(1, { route: "api/cron/jobs?profile=default" }, undefined, "[]");
    await vi.waitFor(() => expect(t.caps.getSnapshot().checkedAt).toBeDefined());
    expect(t.calls).not.toContain("GET api/cron/jobs");
    expect(t.calls).toContain("GET api/webhooks");
  });

  it("takes what Settings → Toolsets' own check found for the switches", () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.caps.report(1, "toolsetSwitches", "unsupported", "no route");
    expect(t.caps.get("toolsetSwitches")).toMatchObject({ state: "unsupported", source: "observed" });
    t.caps.report(0, "toolsetSwitches", "supported", "stale");
    expect(t.caps.get("toolsetSwitches").state).toBe("unsupported");
  });
});

describe("refusing writes Hermes can't take", () => {
  it("learns from a change Hermes has no route or method for, and sends the next one nowhere", () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    // The catalog answered, so the commands look supported, until running one finds no method.
    t.caps.observe(1, { method: "commands.catalog" }, undefined, { pairs: [] });
    expect(t.caps.get("commands").state).toBe("supported");
    t.caps.observeWrite(1, { method: "command.dispatch" }, noMethod("command.dispatch"));
    expect(t.caps.get("commands")).toMatchObject({ state: "unsupported", why: expect.stringMatching(/no such method, for a change this app sends \(command\.dispatch\)/) });
    expect(t.caps.refuses({ rpc: "command.dispatch" })).toBe("commands");
    // A read that answers again doesn't take it back: only the method that was missing can.
    t.caps.observe(1, { method: "commands.catalog" }, undefined, { pairs: [] });
    expect(t.caps.get("commands").state).toBe("unsupported");
    // A REST write's own refusal, such as a job that is gone, says nothing about the route.
    t.caps.observeWrite(1, { route: "api/cron/jobs/j1?profile=default" }, answered(404, "Job not found"));
    expect(t.caps.get("scheduledJobs").state).toBe("unknown");
    t.caps.observeWrite(1, { route: "api/cron/jobs?profile=default" }, noRoute());
    expect(t.caps.refuses({ rest: "POST", path: "api/cron/jobs?profile=default" })).toBe("scheduledJobs");
    // Membership's missing store is expected, and isn't counted against Projects.
    t.caps.observeWrite(1, { method: "projects.membership.apply" }, noMethod("projects.membership.apply"));
    expect(t.caps.get("projects").state).toBe("unknown");
  });

  it("ignores a write failure from a connection since gone", () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.setGen(2);
    t.caps.observeWrite(1, { method: "command.dispatch" }, noMethod("command.dispatch"));
    expect(t.caps.get("commands").state).toBe("unknown");
  });

  it("refuses a write only while its capability is unsupported, and never a read", async () => {
    const t = store(OLD);
    await connectAndCheck(t, 1, Promise.reject(noMethod("client.capabilities")));
    expect(t.caps.refuses({ rpc: "projects.create" })).toBe("projects");
    // Membership is a store no Hermes has yet (ADR 0109): its absence is expected, so it isn't Projects' write.
    expect(t.caps.refuses({ rpc: "projects.membership.apply" })).toBeUndefined();
    expect(t.caps.refuses({ rpc: "learning.edit" })).toBe("memory");
    expect(t.caps.refuses({ rpc: "learning.delete" })).toBe("memory");
    expect(t.caps.refuses({ rest: "POST", path: "api/files/upload-stream" })).toBe("serverFiles");
    // Reads still go, so an answer can show the feature is there after all.
    expect(t.caps.refuses({ rpc: "projects.list" })).toBeUndefined();
    expect(t.caps.refuses({ rest: "GET", path: "api/files?path=/" })).toBeUndefined();
    // Supported features write as before.
    expect(t.caps.refuses({ rest: "PUT", path: "api/profiles/default/soul" })).toBeUndefined();
    expect(t.caps.refuses({ rest: "POST", path: "api/cron/jobs?profile=default" })).toBeUndefined();
    // Chat traffic belongs to no guarded capability.
    expect(t.caps.refuses({ rpc: "prompt.submit" })).toBeUndefined();
  });

  it("refuses a toolset switch once Settings → Toolsets found no route for it, but not its write check", () => {
    const t = store(NEW);
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    expect(t.caps.refuses({ rest: "PUT", path: "api/tools/toolsets/web?profile=default" })).toBeUndefined();
    t.caps.report(1, "toolsetSwitches", "unsupported", "no route");
    expect(t.caps.refuses({ rest: "PUT", path: "api/tools/toolsets/web?profile=default" })).toBe("toolsetSwitches");
    expect(t.caps.refuses({ rest: "PUT", path: "api/tools/toolsets/__hermes_chat_probe__?profile=default" })).toBeUndefined();
    // The list is still there, so reading it isn't refused either.
    expect(t.caps.refuses({ rest: "GET", path: "api/tools/toolsets?profile=default" })).toBeUndefined();
  });

  it("doesn't refuse while a capability is only unknown or couldn't be checked", () => {
    const t = store(NEW);
    expect(t.caps.refuses({ rest: "PUT", path: "api/skills/toggle" })).toBeUndefined();
    t.caps.connected(1, "default", {}, Promise.resolve({}));
    t.caps.observe(1, { route: "api/skills" }, answered(503, "down"));
    expect(t.caps.refuses({ rest: "PUT", path: "api/skills/toggle" })).toBeUndefined();
    t.caps.observe(1, { route: "api/skills" }, noRoute());
    expect(t.caps.refuses({ rest: "PUT", path: "api/skills/toggle?profile=default" })).toBe("skills");
  });
});

describe("checking again", () => {
  it("keeps what it knew on a reconnect to the same build checked lately", async () => {
    let now = 1_000_000;
    const t = store(NEW, { now: () => now });
    await connectAndCheck(t, 1);
    t.caps.disconnected();
    now += 60_000;
    const before = t.calls.length;
    await connectAndCheck(t, 2);
    const again = t.calls.slice(before);
    // Only the facts, to see whether the build changed.
    expect(again.sort()).toEqual(["GET api/health", "GET api/status", "RPC gateway.capabilities"]);
    expect(t.caps.getSnapshot().checkedAt).toBe(now);
  });

  it("checks again once each capability's own check is old, however often it reconnects", async () => {
    let now = 1_000_000;
    const t = store(NEW, { now: () => now });
    await connectAndCheck(t, 1);
    // Reconnecting every ten minutes reads the facts each time, which renews no capability.
    for (let gen = 2; gen <= 4; gen++) {
      t.caps.disconnected();
      now += 10 * 60_000;
      const before = t.calls.length;
      await connectAndCheck(t, gen);
      if (gen === 2) expect(t.calls.slice(before)).not.toContain("GET api/files");
      if (gen === 3) expect(t.calls.slice(before)).toContain("GET api/files");
    }
  });

  it("checks everything again once the last check is old", async () => {
    let now = 1_000_000;
    const t = store(NEW, { now: () => now });
    await connectAndCheck(t, 1);
    t.caps.disconnected();
    now += RECHECK_AFTER_MS + 1;
    const before = t.calls.length;
    await connectAndCheck(t, 2);
    expect(t.calls.slice(before)).toContain("GET api/files");
  });

  it("forgets what it found for another build, and checks it all again", async () => {
    let now = 1_000_000;
    const t = store(OLD, { now: () => now });
    await connectAndCheck(t, 1, Promise.reject(noMethod("client.capabilities")));
    expect(t.caps.get("serverFiles").state).toBe("unsupported");
    t.caps.disconnected();
    // Hermes was updated on the server meanwhile.
    Object.assign(t.answers, NEW);
    now += 1000;
    await connectAndCheck(t, 2);
    expect(t.caps.getSnapshot().facts.version).toBe("0.17.0");
    expect(t.caps.get("serverFiles").state).toBe("supported");
    expect(t.caps.get("projects").state).toBe("supported");
    expect(t.caps.get("approvals").state).toBe("supported");
  });

  it("checks again what was left in doubt, even on the same build", async () => {
    let now = 1_000_000;
    const t = store({ ...NEW, "GET api/webhooks": answered(502, "Bad Gateway") }, { now: () => now });
    await connectAndCheck(t, 1);
    expect(t.caps.get("automations").state).toBe("unreachable");
    t.caps.disconnected();
    t.answers["GET api/webhooks"] = { subscriptions: [] };
    now += 1000;
    const before = t.calls.length;
    await connectAndCheck(t, 2);
    expect(t.calls.slice(before)).toContain("GET api/webhooks");
    expect(t.calls.slice(before)).not.toContain("GET api/files");
    expect(t.caps.get("automations").state).toBe("supported");
  });

  it("forgets on Check again what only a screen can check, so it checks it afresh", async () => {
    const t = store(NEW);
    await connectAndCheck(t);
    t.caps.report(1, "toolsetSwitches", "unsupported", "no route");
    expect(t.caps.refuses({ rest: "PUT", path: "api/tools/toolsets/web" })).toBe("toolsetSwitches");
    await t.caps.refresh();
    expect(t.caps.get("toolsetSwitches").state).toBe("unknown");
    expect(t.caps.get("chat").state).toBe("supported");
  });

  it("checks everything when asked, from diagnostics", async () => {
    const t = store(NEW);
    await connectAndCheck(t);
    const before = t.calls.length;
    await t.caps.refresh();
    expect(t.calls.slice(before)).toEqual(expect.arrayContaining(["GET api/files", "RPC projects.list", "GET api/webhooks"]));
  });
});

describe("the copied report", () => {
  it("holds what diagnostics shows and no secret", async () => {
    const t = store({
      ...NEW,
      // Hermes puts a secret in a reason: the report still mustn't carry it.
      "GET api/webhooks": answered(500, "boom: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 at https://user:hunter2@gw.example/api?ticket=tkt-123&x=1"),
      "GET api/skills": answered(503, "api_key=sk-live-123456 cookie: session=abc"),
    });
    await connectAndCheck(t);
    const text = reportText(t.caps.getSnapshot(), {
      app: "Hermes Chat",
      server: "https://owner:pa55word@hermes.example:9119",
      signIn: "Dashboard username and password",
      headers: 2,
      unsecure: false,
      profile: "default",
    });
    expect(text).toMatch(/^Hermes Chat connection diagnostics/);
    expect(text).toMatch(/Hermes version: 0\.17\.0/);
    expect(text).toMatch(/Protocol: Legacy session protocol/);
    expect(text).toMatch(/Feature flags: per_session_exclusive_submit/);
    expect(text).toMatch(/Extra request headers: 2 \(values never shown\)/);
    expect(text).toMatch(/Automations: Couldn't check/);
    for (const secret of ["sk-ant-api03", "hunter2", "pa55word", "tkt-123", "sk-live-123456", "session=abc"]) expect(text).not.toContain(secret);
  });

  it("redacts what the Logs screen redacts, and tickets in URLs", () => {
    expect(redact("wss://h/api/ws?ticket=abc.def&profile=x")).toBe("wss://h/api/ws?ticket=[redacted]&profile=x");
    expect(redact("password: hunter2")).not.toContain("hunter2");
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).not.toContain("eyJzdWIiOiIxIn0");
  });

  it("redacts a token in a URL's user name, with or without a password, and an auth= query value", () => {
    expect(redact("Server: https://sk_abcdef123456@hermes.example/")).toBe("Server: https://[redacted]@hermes.example/");
    expect(redact("GET https://hermes.example/api?auth=abc123&profile=x")).toBe("GET https://hermes.example/api?auth=[redacted]&profile=x");
  });

  it("keeps secrets out of the why it shows, too", async () => {
    const t = store({ ...NEW, "GET api/files": answered(502, "token=abcd1234secret") });
    await connectAndCheck(t);
    expect(t.caps.get("serverFiles").why).not.toContain("abcd1234secret");
  });
});
