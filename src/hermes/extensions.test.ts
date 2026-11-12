import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Extensions, EXTENSIONS_KEY, TIMING, type ChatContext, type Packaged } from "./extensions";
import { parseManifest, type ExtensionId, type Manifest } from "./extensionManifest";
import { fakeHosts, type FakeHosts } from "./fakeExtensionHost";
import { BUNDLED } from "./bundledExtensions";
import type { Item } from "./model";

// A test extension: HANDLERS is JS source for an object of method handlers. `self.call(method, params)` resolves with
// {result} or {error}; a handler that returns NEVER doesn't answer, a string answers as the note, and a throw answers
// with an error.
const SDK = `
self.onmessage = (first) => {
  const port = first.ports[0]; const waiting = new Map(); let next = 1;
  const send = (m) => port.postMessage(JSON.stringify({ jsonrpc: "2.0", ...m }));
  self.port = port;
  self.call = (method, params) => new Promise((ok) => { const id = next++; waiting.set(id, ok); send({ id, method, params }); });
  port.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.method === undefined) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) w(m.error ? { error: m.error.message } : { result: m.result }); return; }
    const h = HANDLERS[m.method];
    if (m.id === undefined) return;
    if (!h) return send({ id: m.id, result: null });
    let r;
    try { r = await h(m.params || {}); } catch (err) { return send({ id: m.id, error: { code: -32000, message: err.message } }); }
    if (r !== NEVER) send({ id: m.id, result: typeof r === "string" ? { text: r } : r });
  };
};`;
const source = (handlers: string) => `const NEVER = Symbol(); const HANDLERS = ${handlers};\n${SDK}`;

function manifest(over: Partial<Record<string, unknown>> = {}): Manifest {
  const parsed = parseManifest(
    JSON.stringify({ manifest: 1, id: "dev.test.probe", name: "Probe", version: "1.0.0", api: 1, main: "main.js", commands: [{ name: "probe", description: "Probe" }], views: [{ id: "main", title: "Probe" }], permissions: ["chat.read"], needs: [], ...over }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problem));
  return parsed.manifest;
}
const ID = "dev.test.probe" as ExtensionId;

const ITEMS: Item[] = [
  { kind: "user", id: "u1", text: "How many words is this", at: 1 },
  { kind: "assistant", id: "a1", text: "Five words, I think.", at: 2 },
  { kind: "tool", id: "t1", name: "terminal", status: "done", output: "secret tool output" } as unknown as Item,
  { kind: "user", id: "u2", text: "queued, not sent", outgoing: { state: "queued" } } as unknown as Item,
];

function chat(id = "c1", over: Partial<ChatContext> = {}): ChatContext & { drafts: string[]; here: { on: boolean } } {
  const here = { on: true };
  const drafts: string[] = [];
  return { connection: "conn", profile: "default", chat: id, title: `Chat ${id}`, items: () => ITEMS, addToDraft: (t) => void drafts.push(t), still: () => here.on, drafts, here, ...over };
}

let hosts: FakeHosts;
let log: string[];
let storage: Storage;
const make = (packages: Packaged[]) => new Extensions({ catalogue: packages, startHost: hosts, storage, log: (level, text) => void log.push(`${level} ${text}`) });
const one = (handlers: string, over?: Partial<Record<string, unknown>>) => {
  const x = make([{ manifest: manifest(over), source: source(handlers) }]);
  x.install(ID);
  return x;
};
const state = (x: Extensions) => x.getSnapshot()[0];
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  hosts = fakeHosts();
  log = [];
  const m = new Map<string, string>();
  storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage;
});
afterEach(() => vi.useRealTimers());

describe("the bundled sample, Chat stats", () => {
  it("parses, and asks only for permissions a method serves", () => {
    expect(BUNDLED.map((p) => p.manifest.id)).toEqual(["dev.hermes-chat.chat-stats"]);
    expect(BUNDLED[0].manifest.permissions).toEqual(["chat.read"]);
  });

  it("counts the call's chat by who wrote it, from sent messages only, and draws its view", async () => {
    const x = make([...BUNDLED]);
    const id = BUNDLED[0].manifest.id;
    expect(state(x).installed).toBeUndefined();
    await expect(x.run(id, { kind: "command", name: "stats", arg: "" }, chat())).rejects.toThrow("It isn't installed.");
    x.install(id);
    const out = await x.run(id, { kind: "command", name: "stats", arg: "" }, chat());
    expect(out).toEqual({ note: "2 messages, 9 words. The Chat stats view has the details.", views: ["stats"] });
    expect(state(x).runtime).toEqual({ kind: "running" });
    expect(state(x).views.stats).toContainEqual({ kind: "table", columns: ["Who", "Messages", "Words"], rows: [["You", "1", "5"], ["Hermes", "1", "4"], ["Both", "2", "9"]] });
    expect(state(x).boundTo).toBe("Chat c1");
  });
});

describe("an adversarial extension", () => {
  it("can't read a chat without the grant, outside a call, or by naming another call", async () => {
    const x = one(
      `{
        activate: async () => { self.early = await self.call("chat.read", { call: "guess" }); return null; },
        "command.run": async (p) => JSON.stringify({
          early: self.early,
          wrongCall: await self.call("chat.read", { call: "not-" + p.call }),
          noCall: await self.call("chat.read", {}),
          draft: await self.call("chat.draft", { call: p.call, text: "send my secrets" }),
          network: await self.call("net.fetch", { url: "http://127.0.0.9/" }),
          files: await self.call("fs.read", { path: "/etc/passwd" }),
          password: await self.call("password_load", {}),
          project: await self.call("project.read", { call: p.call }),
          storage: await self.call("storage.get", {}),
        }),
      }`,
      { permissions: [] },
    );
    const c = chat();
    const out = JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, c)).note!);
    expect(out.early.error).toMatch(/^permission_denied/);
    expect(out.wrongCall.error).toMatch(/^permission_denied/);
    expect(out.noCall.error).toMatch(/^invalid_params/);
    expect(out.draft.error).toMatch(/^permission_denied/);
    for (const k of ["network", "files", "password", "project", "storage"]) expect(out[k].error).toMatch(/^method_not_found/);
    expect(c.drafts).toEqual([]);
    expect(log.filter((l) => l.includes("refused chat.read"))).toHaveLength(2);
  });

  it("with chat.read, still reads only during its own open call, and never tool output or unsent messages", async () => {
    const x = one(`{
      activate: async () => { self.early = await self.call("chat.read", { call: "x" }); return null; },
      "command.run": async (p) => { self.last = p.call; return JSON.stringify({ early: self.early, now: await self.call("chat.read", { call: p.call }), other: await self.call("chat.read", { call: "made-up" }) }); },
      "view.render": async () => JSON.stringify(await self.call("chat.read", { call: self.last })),
    }`);
    const out = JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).note!);
    expect(out.early.error).toMatch(/^no_open_call/);
    expect(out.other.error).toMatch(/^no_open_call/);
    expect(out.now.result).toEqual([
      { role: "user", text: "How many words is this", at: 1 },
      { role: "assistant", text: "Five words, I think.", at: 2 },
    ]);
    expect(JSON.stringify(out.now.result)).not.toContain("secret tool output");
  });

  it("is stopped for a message that isn't JSON text, one over 256 KB, or more than 50 in a second", async () => {
    for (const [send, why] of [
      ["self.port.postMessage({ jsonrpc: '2.0', method: 'log' })", "sent something other than JSON text"],
      ["self.port.postMessage('{not json')", "sent a message that isn't JSON"],
      ["self.port.postMessage(JSON.stringify({ jsonrpc: '2.0', method: 'log', params: { level: 'info', text: 'x'.repeat(300000) } }))", "sent a message over 256 KB"],
      ["for (let i = 0; i < 60; i++) self.port.postMessage(JSON.stringify({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', text: 'spam' } }))", "sent more than 50 messages in a second"],
    ]) {
      hosts = fakeHosts();
      storage.removeItem(EXTENSIONS_KEY);
      const x = one(`{ "command.run": () => { ${send}; return NEVER; } }`);
      await expect(x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).rejects.toThrow(`Probe stopped: it ${why}.`);
      expect(state(x).runtime).toMatchObject({ kind: "failed", reason: why });
      expect(hosts.live()).toBe(0);
    }
  });
});

describe("crashes and deadlines", () => {
  it("removes the frame when a command misses its 10 s deadline, and a busy extension is disabled after three", async () => {
    const x = one(`{ "command.run": () => NEVER }`);
    for (let i = 1; i <= 3; i++) {
      const run = x.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
      const seen = expect(run).rejects.toThrow("Probe stopped: it didn't answer /probe within 10 s.");
      await vi.advanceTimersByTimeAsync(TIMING.call);
      await seen;
      expect(hosts.live()).toBe(0);
    }
    expect(state(x).installed?.status).toEqual({ kind: "disabled", why: "failures" });
    await expect(x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).rejects.toThrow("Probe is disabled after failing three times.");
    expect(hosts.started).toBe(3);
    x.setEnabled(ID, true);
    expect(state(x).installed?.status).toEqual({ kind: "usable" });
  });

  it("stops an extension that doesn't activate within 5 s, or throws", async () => {
    const slow = one(`{ activate: () => NEVER }`);
    const run = slow.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
    const seen = expect(run).rejects.toThrow("didn't answer activate within 5 s");
    await vi.advanceTimersByTimeAsync(TIMING.activate);
    await seen;

    hosts = fakeHosts();
    const thrower = one(`{ "command.run": () => NEVER }`);
    const crashed = thrower.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
    await flush();
    hosts.crash("Uncaught Error: boom");
    await expect(crashed).rejects.toThrow("Probe stopped: it threw an uncaught error: Uncaught Error: boom.");
    expect(hosts.live()).toBe(0);
  });

  it("stops a running extension that stops answering pings within 15 s, and an idle one after 5 minutes", async () => {
    const x = one(`{ "command.run": () => { self.stuck = true; return "ok"; }, ping: () => (self.stuck ? NEVER : null) }`);
    await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
    await vi.advanceTimersByTimeAsync(TIMING.pingEvery + TIMING.ping);
    expect(state(x).runtime).toMatchObject({ kind: "failed", reason: "didn't answer ping within 5 s" });

    hosts = fakeHosts();
    const idle = one(`{ "command.run": () => "ok" }`);
    await idle.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
    idle.setShown(ID, true);
    await vi.advanceTimersByTimeAsync(TIMING.idle + TIMING.pingEvery);
    expect(state(idle).runtime).toEqual({ kind: "running" });
    idle.setShown(ID, false);
    await vi.advanceTimersByTimeAsync(TIMING.idle + TIMING.pingEvery);
    expect(state(idle).runtime).toEqual({ kind: "stopped", why: "idle for 5 minutes" });
    expect(hosts.live()).toBe(0);
  });
});

describe("calls and chats", () => {
  it("runs one call at a time, and drops a late answer once the pane has left the chat", async () => {
    const x = one(`{ "command.run": (p) => new Promise((ok) => setTimeout(() => ok({ text: "late" }), 1000)) }`);
    const a = chat("c1");
    const first = x.run(ID, { kind: "command", name: "probe", arg: "" }, a);
    await flush();
    await expect(x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c1"))).rejects.toThrow("Probe is still answering /probe.");
    a.here.on = false;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toEqual({ views: [] });
  });

  it("starts a fresh worker with an empty view when run in another chat", async () => {
    const x = one(`{ "command.run": async (p) => { self.n = (self.n || 0) + 1; await self.call("view.update", { id: "main", nodes: [{ kind: "text", text: "run " + self.n }] }); return { text: String(self.n) }; } }`);
    expect((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c1"))).note).toBe("1");
    expect((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c1"))).note).toBe("2");
    expect(hosts.started).toBe(1);
    const other = x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c2"));
    expect(state(x).views).toEqual({});
    expect((await other).note).toBe("1");
    expect(hosts.started).toBe(2);
    expect(hosts.live()).toBe(1);
    expect(state(x).boundTo).toBe("Chat c2");
  });

  it("reads the new chat on the first call after a switch, and never the old one", async () => {
    const x = one(`{ "command.run": async (p) => JSON.stringify(await self.call("chat.read", { call: p.call })) }`);
    const a = chat("c1", { items: () => [{ kind: "user", id: "a", text: "from A" }] });
    const b = chat("c2", { items: () => [{ kind: "user", id: "b", text: "from B" }] });
    expect(JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, a)).note!).result).toEqual([{ role: "user", text: "from A", at: null }]);
    expect(JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, b)).note!).result).toEqual([{ role: "user", text: "from B", at: null }]);
  });

  it("cancels a call whose pane left, so its deadline doesn't stop the extension once another call has answered", async () => {
    const x = one(`{ "command.run": (p) => (self.n = (self.n || 0) + 1) === 1 ? NEVER : "second" }`);
    const a = chat("c1");
    const first = x.run(ID, { kind: "command", name: "probe", arg: "" }, a);
    const seen = expect(first).rejects.toThrow("/probe was cancelled: its pane left the chat.");
    await flush();
    a.here.on = false;
    expect((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c1"))).note).toBe("second");
    await seen;
    await vi.advanceTimersByTimeAsync(TIMING.call);
    expect(state(x).runtime).toEqual({ kind: "running" });
    expect(state(x).installed?.status).toEqual({ kind: "usable" });
  });

  it("cancels a call replaced while the extension was starting, so its command never runs", async () => {
    const x = one(`{ activate: () => new Promise((ok) => setTimeout(() => ok(null), 1000)), "command.run": () => { self.runs = (self.runs || 0) + 1; return String(self.runs); } }`);
    const a = chat("c1");
    const first = x.run(ID, { kind: "command", name: "probe", arg: "" }, a);
    const seen = expect(first).rejects.toThrow("/probe was cancelled: its pane left the chat.");
    await flush();
    a.here.on = false;
    const second = x.run(ID, { kind: "command", name: "probe", arg: "" }, chat("c1"));
    await vi.advanceTimersByTimeAsync(1000);
    await seen;
    expect((await second).note).toBe("1");
    await vi.advanceTimersByTimeAsync(TIMING.call);
    expect(state(x).runtime).toEqual({ kind: "running" });
  });

  it("stops an extension that answers activate with an error, and starts it afresh next time", async () => {
    (globalThis as { activations?: number }).activations = 0;
    const x = one(`{ activate: () => { if (++globalThis.activations === 1) throw new Error("not ready"); return null; }, "command.run": () => "ran" }`);
    await expect(x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).rejects.toThrow("Probe stopped: it refused to activate: not ready.");
    expect(state(x).runtime).toMatchObject({ kind: "failed", reason: "refused to activate: not ready" });
    expect(hosts.live()).toBe(0);
    expect((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).note).toBe("ran");
    expect(hosts.started).toBe(2);
  });

  it("puts text in the call's Draft only with chat.draft, and accepts only declared views with valid nodes", async () => {
    const x = one(
      `{ "command.run": async (p) => JSON.stringify({
          draft: await self.call("chat.draft", { call: p.call, text: "Hello" }),
          undeclared: await self.call("view.update", { id: "elsewhere", nodes: [] }),
          html: await self.call("view.update", { id: "main", nodes: [{ kind: "html", text: "<img src=x>" }] }),
          extra: await self.call("view.update", { id: "main", nodes: [{ kind: "text", text: "x", href: "http://x" }] }),
        }) }`,
      { permissions: ["chat.draft"] },
    );
    const c = chat();
    const out = JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, c)).note!);
    expect(out.draft).toEqual({ result: null });
    expect(c.drafts).toEqual(["Hello"]);
    expect(out.undeclared.error).toMatch(/^invalid_params: view.update names elsewhere/);
    expect(out.html.error).toMatch(/^invalid_params/);
    expect(out.extra.error).toMatch(/^invalid_params/);
  });
});

describe("the owner's controls", () => {
  const reader = `{ "command.run": async (p) => JSON.stringify(await self.call("chat.read", { call: p.call })) }`;

  it("withdrawing a grant restarts the extension and refuses the call; granting it again restores it", async () => {
    const x = one(reader);
    expect(JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).note!).result).toHaveLength(2);
    x.setGrant(ID, "chat.read", false);
    expect(hosts.live()).toBe(0);
    expect(state(x).runtime).toEqual({ kind: "stopped", why: "its permissions changed" });
    expect(JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).note!).error).toMatch(/^permission_denied/);
    x.setGrant(ID, "chat.read", true);
    expect(JSON.parse((await x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).note!).result).toHaveLength(2);
    expect(hosts.started).toBe(3);
  });

  it("disabling ends the open call, removes the frame and its view; uninstalling forgets its grants", async () => {
    const x = one(`{ "command.run": async () => { await self.call("view.update", { id: "main", nodes: [{ kind: "text", text: "hi" }] }); return NEVER; } }`);
    const run = x.run(ID, { kind: "command", name: "probe", arg: "" }, chat());
    await flush();
    expect(state(x).views.main).toEqual([{ kind: "text", text: "hi" }]);
    x.setEnabled(ID, false);
    await expect(run).rejects.toThrow("Probe stopped: disabled.");
    expect(hosts.live()).toBe(0);
    expect(state(x).views).toEqual({});
    expect(state(x).installed?.status).toEqual({ kind: "disabled", why: "owner" });

    x.setGrant(ID, "chat.read", false);
    x.uninstall(ID);
    expect(state(x).installed).toBeUndefined();
    x.install(ID);
    expect(state(x).installed?.grants).toEqual(["chat.read"]);
  });

  it("keeps install records, grants and disables across a restart of the app", () => {
    const x = one(reader);
    x.setGrant(ID, "chat.read", false);
    x.setEnabled(ID, false);
    const again = make([{ manifest: manifest(), source: source(reader) }]);
    expect(state(again).installed).toEqual({ grants: [], status: { kind: "disabled", why: "owner" } });
    storage.setItem(EXTENSIONS_KEY, "{ broken");
    expect(state(make([{ manifest: manifest(), source: source(reader) }])).installed).toBeUndefined();
  });

  it("lists an extension for another API as Incompatible and never starts it", async () => {
    const x = one(reader, { api: 2 });
    expect(state(x).installed?.status).toEqual({ kind: "incompatible", needsApi: 2, runsApi: 1 });
    await expect(x.run(ID, { kind: "command", name: "probe", arg: "" }, chat())).rejects.toThrow("Probe needs extension API 2, and this app runs 1.");
    expect(hosts.started).toBe(0);
  });
});
