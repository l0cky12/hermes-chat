import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { APP_SOURCE, ProtocolMismatchError, connect } from "./transport";

async function signedIn() {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe);
  return {
    server,
    hermes,
    chat: (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!,
    runtime: (id: string) => server.runtimeIdOf(id)!,
  };
}

describe("Hermes transport", () => {
  it("connects once gateway.ready arrives", async () => {
    const { hermes } = await signedIn();
    expect(hermes.getSnapshot()).toEqual({
      profile: "default",
      chats: [],
      olderPulled: false,
      archivedListed: false,
      others: { byName: {} },
      queues: {},
      branches: { links: {}, attempts: [] },
      status: "connected",
      route: { kind: "ssh", target: "liam@hermes" },
      unsecure: false,
    });
  });

  it("refuses a server that speaks the canonical protocol", async () => {
    const server = new FakeHermes();
    server.readyPayload = { ...server.readyPayload, session_authority: true };
    await expect(connect(server.openPipe)).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(server.closed).toBe(true);
  });

  it("starts a new Active chat in the default profile, sourced from this app", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    expect(server.last("session.create")!.params).toEqual({ profile: "default", source: APP_SOURCE });
    expect(chat(id)).toMatchObject({ id: "20261031_120001_abc123", runtimeId: "rt-1", title: "New chat", source: "app", settled: false, items: [] });
  });

  it("sends a message and streams the reply into the chat", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    expect(await hermes.send(id, "What's the disk usage on the NAS?")).toEqual({ delivery: "accepted" });
    expect(server.last("prompt.submit")!.params).toEqual({ session_id: runtime(id), profile: "default", text: "What's the disk usage on the NAS?" });
    expect(chat(id)).toMatchObject({ title: "What's the disk usage on the NAS?", running: true });

    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.delta", { text: "It's at " });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: "It's at " });
    server.event(runtime(id), "message.delta", { text: "**92%**." });
    expect(chat(id).running).toBe(true);
    server.event(runtime(id), "message.complete", { text: "It's at **92%**.", status: "complete" });

    expect(chat(id).running).toBe(false);
    expect(chat(id).items.map((i) => [i.kind, "text" in i ? i.text : i.id])).toEqual([
      ["user", "What's the disk usage on the NAS?"],
      ["assistant", "It's at **92%**."],
    ]);
  });

  describe("streamed deltas (#224)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("are in the snapshot at once, every character in order, and heard of once a frame", async () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
      const { server, hermes, chat, runtime } = await signedIn();
      const id = await hermes.newChat();
      await hermes.send(id, "count to 49");
      server.event(runtime(id), "message.start");
      const text = (kind: string) => chat(id).items.filter((x) => x.kind === kind).map((x) => (x as { text: string }).text);
      const heard: string[][] = [];
      hermes.subscribe(() => heard.push(text("assistant")));
      server.event(runtime(id), "reasoning.delta", { text: "Counting." });
      let reply = "";
      for (let i = 0; i < 50; i++) {
        server.event(runtime(id), "message.delta", { text: `${i} ` });
        reply += `${i} `;
        expect(text("assistant")).toEqual([reply]);
      }
      expect(text("thinking")).toEqual(["Counting."]);
      expect(heard).toEqual([]);
      frames.splice(0).forEach((f) => f(0));
      expect(heard).toEqual([[reply]]);
      frames.splice(0).forEach((f) => f(0));
      expect(heard).toHaveLength(1);

      // Anything else is heard of at once, and brings the deltas still waiting with it.
      server.event(runtime(id), "message.delta", { text: "done." });
      server.event(runtime(id), "message.complete", { text: "", status: "complete" });
      expect(heard).toEqual([[reply], [reply + "done."]]);
      expect(chat(id).running).toBe(false);
      frames.splice(0).forEach((f) => f(0));
      expect(heard).toHaveLength(2);
    });

    it("are heard of once per batch, never by an earlier batch's timeout, and not after Hermes closes", async () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
      const { server, hermes, runtime } = await signedIn();
      const id = await hermes.newChat();
      await hermes.send(id, "hi");
      server.event(runtime(id), "message.start");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let heard = 0;
      hermes.subscribe(() => heard++);
      const runFrames = () => frames.splice(0).forEach((f) => f(0));

      server.event(runtime(id), "message.delta", { text: "a" });
      vi.advanceTimersByTime(16);
      runFrames();
      expect(heard).toBe(1);
      // A second batch starts just before the first one's timeout would have gone off: that timeout tells nobody.
      vi.advanceTimersByTime(80);
      server.event(runtime(id), "message.delta", { text: "b" });
      vi.advanceTimersByTime(10);
      expect(heard).toBe(1);
      runFrames();
      expect(heard).toBe(2);
      vi.advanceTimersByTime(200);
      expect(heard).toBe(2);

      // Heard of at once with the next change: the batch's frame and timeout then tell nobody.
      server.event(runtime(id), "message.delta", { text: "c" });
      server.event(runtime(id), "tool.start", { tool_id: "t1", name: "terminal", args: {}, preview: "ls" });
      expect(heard).toBe(3);
      runFrames();
      vi.advanceTimersByTime(200);
      expect(heard).toBe(3);

      server.event(runtime(id), "message.delta", { text: "d" });
      const closing = hermes.close();
      vi.advanceTimersByTime(200);
      await closing;
      const after = heard;
      runFrames();
      vi.advanceTimersByTime(200);
      expect(heard).toBe(after);
    });

    it("are heard of soon even in a window that draws no frames", async () => {
      vi.stubGlobal("requestAnimationFrame", () => 0);
      const { server, hermes, chat, runtime } = await signedIn();
      const id = await hermes.newChat();
      await hermes.send(id, "hi");
      server.event(runtime(id), "message.start");
      vi.useFakeTimers();
      let heard = 0;
      hermes.subscribe(() => heard++);
      server.event(runtime(id), "message.delta", { text: "Hello" });
      server.event(runtime(id), "message.delta", { text: " there" });
      vi.advanceTimersByTime(99);
      expect(heard).toBe(0);
      vi.advanceTimersByTime(1);
      expect(heard).toBe(1);
      expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello there" });
    });
  });

  it("shows a reply that arrives only in message.complete", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "Hello!", status: "complete" });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello!" });
  });

  it("shows tool calls between reply segments", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "check disk");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.delta", { text: "Checking." });
    server.event(runtime(id), "tool.start", { tool_id: "t1", name: "terminal", args: { command: "df -h" }, preview: "df -h" });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "tool", status: "running", preview: "df -h" });
    server.event(runtime(id), "tool.complete", { tool_id: "t1", name: "terminal", duration_s: 0.2, result: "92% used", summary: "1 line" });
    server.event(runtime(id), "message.delta", { text: "92% used." });
    server.event(runtime(id), "message.complete", { text: "Checking.92% used.", status: "complete" });
    expect(chat(id).items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chat(id).items[2]).toMatchObject({ status: "done", durationS: 0.2, result: "92% used", summary: "1 line" });
  });

  it("keeps each tool call apart when a provider uses the same call id again in a later turn", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    for (const [prompt, command, result] of [["check disk", "df -h", "92% used"], ["check memory", "free -h", "3 GB free"]]) {
      await hermes.send(id, prompt);
      server.event(runtime(id), "message.start");
      server.event(runtime(id), "tool.start", { tool_id: "call_0", name: "terminal", args: { command }, preview: command });
      server.event(runtime(id), "tool.complete", { tool_id: "call_0", name: "terminal", result });
      server.event(runtime(id), "message.complete", { text: "Done.", status: "complete" });
    }
    const tools = chat(id).items.filter((i) => i.kind === "tool");
    expect(new Set(chat(id).items.map((i) => i.id)).size).toBe(chat(id).items.length);
    expect(tools).toMatchObject([
      { callId: "call_0", preview: "df -h", status: "done", result: "92% used" },
      { callId: "call_0", preview: "free -h", status: "done", result: "3 GB free" },
    ]);
  });

  it("shows a failed turn as an error", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "", status: "error", error: "Provider returned 529 overloaded" });
    expect(chat(id)).toMatchObject({ running: false });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "error", text: "Provider returned 529 overloaded" });
  });

  it("marks a refused prompt failed, with Hermes's reason", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.handlers["prompt.submit"] = (r) => server.fail(r.id, 4009, "session busy");
    expect(await hermes.send(id, "hi")).toEqual({ delivery: "unsent", reason: "session busy" });
    expect(chat(id)).toMatchObject({ running: false });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "user", text: "hi", outgoing: { state: "failed", reason: "session busy" } });
  });

  it("ignores events for chats it doesn't have", async () => {
    const { server, hermes } = await signedIn();
    await hermes.newChat();
    const before = hermes.getSnapshot();
    server.event("someone-else", "message.delta", { text: "not ours" });
    expect(hermes.getSnapshot()).toBe(before);
  });

  it("starts reconnecting when the connection drops mid-reply", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.drop("closed by the server (1006 )");
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: "closed by the server (1006 )" });
    expect(chat(id).running).toBe(false);
    await expect(hermes.newChat()).rejects.toThrow("Not connected");
  });

  it("fails sign-in if the connection closes before gateway.ready", async () => {
    await expect(
      connect(async (onEvent) => {
        onEvent({ kind: "closed", reason: "closed by the server (4401 )" });
        return { route: { kind: "ssh", target: "liam@hermes" }, send: async () => {}, request: async () => "", getLimited: async () => "", statFiles: async () => [], sendFile: async () => {}, transcribe: async () => ({ text: "" }), speak: async () => ({ mime: "audio/mpeg", audio: new Uint8Array() }), voiceSetup: async () => ({ transcribe: false, speak: false }), toolsetGuards: async () => ({ noMcp: [], noMcpUnclear: [], savedLists: [], codingFocus: false, disabledEverywhere: [], disabledUnclear: false }), saveProviderKey: async () => ({ verified: true }), removeProviderKey: async () => {}, providerSignIns: async () => [], customEndpoints: async () => [], saveEndpoint: async () => ({ outcome: "saved", id: "", checked: true }), download: async () => undefined, pickUpload: async () => undefined, discardUpload: async () => {}, upload: async () => "", saveText: async () => "", fsSaveText: async () => "", cancelTransfer: async () => {}, close: async () => {} };
      }),
    ).rejects.toThrow("4401");
  });

  // Rust keeps one connection, so a reconnect's pipe closed after the app moved on would end the next connection.
  it("closes only once a reconnect under way has let go of its pipe", async () => {
    const server = new FakeHermes();
    const log: string[] = [];
    let opening: (() => void) | undefined;
    let entered!: () => void;
    const reopening = new Promise<void>((resolve) => (entered = resolve));
    const hermes = await connect(async (onEvent, profile) => {
      if (log.length) {
        entered();
        await new Promise<void>((resolve) => (opening = resolve));
      }
      const pipe = await server.openPipe(onEvent, profile);
      log.push("open");
      return { ...pipe, close: async () => void log.push("close") };
    });
    server.drop();
    void hermes.reconnect();
    await reopening;
    let closed = false;
    const closing = hermes.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(false);

    opening!();
    await closing;
    expect(log).toEqual(["open", "close", "open", "close"]);
  });

  it("leaves nothing open when closed while a dropped connection is still closing", async () => {
    const server = new FakeHermes();
    const log: string[] = [];
    let closedFirst!: () => void;
    const hermes = await connect(async (onEvent, profile) => {
      const pipe = await server.openPipe(onEvent, profile);
      const n = log.filter((l) => l.startsWith("open")).length + 1;
      log.push(`open ${n}`);
      const closing = n === 1 ? new Promise<void>((resolve) => (closedFirst = resolve)) : Promise.resolve();
      return { ...pipe, close: async () => void (await closing, log.push(`close ${n}`)) };
    });
    server.drop();
    void hermes.reconnect();
    const closing = hermes.close();
    closedFirst();
    await closing;
    expect(log.filter((l) => l.startsWith("open")).every((l) => log.includes(l.replace("open", "close")))).toBe(true);
  });

  it("stops a reconnect that never finishes opening, rather than waiting on it for good", async () => {
    const server = new FakeHermes();
    let opens = 0;
    let stopped = false;
    let entered!: () => void;
    const reopening = new Promise<void>((resolve) => (entered = resolve));
    const hermes = await connect(async (onEvent, profile, signal) => {
      if (opens++ === 0) return server.openPipe(onEvent, profile);
      entered();
      // A server that stopped answering midway: only stopping the opening ends it.
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => {
          stopped = true;
          reject(new Error("Connecting was stopped."));
        }),
      );
    });
    server.drop();
    void hermes.reconnect();
    await reopening;
    await hermes.close();
    expect(stopped).toBe(true);
  });

  // Rust sends every command on the one connection it holds, which may soon be the replacement.
  it("sends nothing once closed, so a replaced connection can't reach the one replacing it", async () => {
    const { server, hermes } = await signedIn();
    const sent = server.requests.length;
    await hermes.close();
    await expect(hermes.newChat()).rejects.toThrow("Not connected");
    await expect(hermes.modelSettings.load()).rejects.toThrow("Not connected");
    expect(server.requests.length).toBe(sent);
  });
});

describe("A malformed frame from the server (#476)", () => {
  const event = (session_id: string, type: string, payload: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id, payload } });

  it.each(["null", "[]", "[1,2]", "5", '"event"', "true", '{"jsonrpc":"2.0","method":"event","params":null}', '{"jsonrpc":"2.0","method":"event","params":[1]}'])(
    "is dropped: %s",
    async (text) => {
      const { server, hermes, chat, runtime } = await signedIn();
      const id = await hermes.newChat();
      expect(() => server.raw(text)).not.toThrow();
      await hermes.send(id, "Still there?");
      server.event(runtime(id), "message.start");
      server.event(runtime(id), "message.complete", { text: "Yes.", status: "complete" });
      expect(chat(id).items.map((i) => i.kind)).toEqual(["user", "assistant"]);
      expect(chat(id).running).toBe(false);
    },
  );

  it("ends the turn on a message.complete whose payload is null", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Anything?");
    server.event(runtime(id), "message.start");
    expect(chat(id).running).toBe(true);
    expect(() => server.raw(event(runtime(id), "message.complete", null))).not.toThrow();
    expect(chat(id).running).toBe(false);
  });

  it("connects when gateway.ready's payload is null", async () => {
    const server = new FakeHermes();
    server.readyPayload = null as never;
    const hermes = await connect(server.openPipe);
    expect(hermes.getSnapshot().status).toBe("connected");
  });

  it("keeps only the tool fields of the type they should be", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "List the backups");
    server.event(runtime(id), "message.start");
    server.raw(event(runtime(id), "tool.start", { tool_id: "t1", name: { tool: "terminal" }, args: "ls", preview: 5 }));
    server.raw(event(runtime(id), "tool.complete", { tool_id: "t1", summary: { lines: 3 }, duration_s: "2.5", result: "a\nb\nc" }));
    expect(chat(id).items.at(-1)).toEqual({ kind: "tool", id: "t1", callId: "t1", name: "tool", status: "done", result: "a\nb\nc" });
  });
});

describe("A frame field that can't be made text (#476)", () => {
  const evil = { toString: null };
  const event = (session_id: string, type: string, payload: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id, payload } });

  it.each([
    ["tool.start", { tool_id: evil, name: "terminal" }],
    ["tool.complete", { tool_id: evil }],
    ["request.cancel", { id: "a1", reason: evil }],
    ["btw.complete", { task_id: evil, text: "x" }],
    ["error", { message: evil }],
    ["message.complete", { status: "error", error: evil }],
  ])("doesn't throw: %s", async (type, payload) => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Go");
    server.event(runtime(id), "message.start");
    expect(() => server.raw(event(runtime(id), type, payload))).not.toThrow();
    server.event(runtime(id), "message.complete", { text: "Done.", status: "complete" });
    expect(chat(id).running).toBe(false);
  });

  it("keeps a tool's own `toString` fields in its arguments and result", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Go");
    server.event(runtime(id), "message.start");
    server.raw(event(runtime(id), "tool.start", { tool_id: "t1", name: "read", args: { toString: "keep me" } }));
    server.raw(event(runtime(id), "tool.complete", { tool_id: "t1", result: { toString: "keep me too", other: 1 } }));
    const tool = chat(id).items.at(-1);
    expect(tool).toMatchObject({ kind: "tool", args: { toString: "keep me" } });
    expect(tool?.kind === "tool" && tool.result).toContain("keep me too");
  });

  it("doesn't throw on an approval request whose command can't be made text", async () => {
    const { server, hermes, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Go");
    const frame = { jsonrpc: "2.0", id: "r1", method: "approval", params: { session_id: runtime(id), request_id: evil, command: evil, choices: ["once", "deny"] } };
    expect(() => server.raw(JSON.stringify(frame))).not.toThrow();
  });
});
