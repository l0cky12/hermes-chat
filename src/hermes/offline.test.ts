import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Account, WRONG_PASSWORD, launchOpen, launchSignIn } from "./account";
import { type SavedConnection, Connections } from "./connections";
import { TRANSCRIPT_LIMIT_BYTES, localChatCache } from "./chatCache";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { type MemoryCache, memoryCache } from "./memoryCache";
import type { Item } from "./model";
import type { OpenPipe } from "./pipe";
import type { SignInDetails } from "./tauriPipe";
import type { SavedSignIn } from "./account";
import { type ChatCache, type Hermes, connect, openSaved, readSaved } from "./transport";

const history: TranscriptMessage[] = [
  { role: "user", text: "How full is the NAS?" },
  { role: "tool", name: "terminal", context: "df -h", args: { command: "df -h /mnt/nas" } },
  { role: "assistant", text: "**82%** used." },
];
const historyItems: Item[] = [
  { kind: "user", id: "h-0", text: "How full is the NAS?" },
  { kind: "tool", id: "h-1", name: "terminal", args: { command: "df -h /mnt/nas" }, preview: "df -h", status: "done" },
  { kind: "assistant", id: "h-2", text: "**82%** used." },
];

/** A server holding the chat `nas` and its history, and a first launch that lists it. */
async function firstLaunch(cache: MemoryCache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [row("nas", 1, { pinned: true }), row("other", 2)];
  server.transcripts = { nas: [...history] };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  return { server, hermes, cache };
}

/** Launches again while the server can't be reached. */
function offlineLaunch(server: FakeHermes, cache: ChatCache) {
  server.refuse = "Can't reach the Hermes dashboard: network is unreachable";
  return readSaved(server.openPipe, server.refuse, cache);
}

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };

const chat = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;

describe("Saved copies", () => {
  it("are saved when a chat is opened, and again when a reply ends", async () => {
    const { server, hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    expect(cache.transcripts["default/nas"]).toMatchObject({ items: historyItems, savedAt: expect.any(Number) });

    await hermes.send("nas", "And the backups?");
    server.event(server.runtimeIdOf("nas")!, "message.delta", { text: "Fine." });
    server.event(server.runtimeIdOf("nas")!, "message.complete", { text: "Fine.", status: "complete" });
    expect(cache.transcripts["default/nas"].items.slice(3)).toEqual([
      { kind: "user", id: "u-3", text: "And the backups?" },
      { kind: "assistant", id: "a-4", text: "Fine." },
    ]);
    // A chat never opened has no copy.
    expect(cache.transcripts["default/other"]).toBeUndefined();
  });

  it("leave out Approvals and errors, which belong to the connection", async () => {
    const { server, hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    await hermes.send("nas", "Clean the logs");
    const runtime = server.runtimeIdOf("nas")!;
    server.event(runtime, "error", { message: "The model is overloaded." });
    server.event(runtime, "message.complete", { text: "", status: "complete" });
    expect(chat(hermes, "nas").items.map((i) => i.kind)).toContain("error");
    expect(cache.transcripts["default/nas"].items.map((i) => i.kind)).toEqual(["user", "tool", "assistant", "user"]);
  });

  it("are kept per profile", async () => {
    const { hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    expect(cache.loadTranscript("work", "nas")).toBeUndefined();
  });
});

describe("Reading offline after a restart", () => {
  it("opens the saved list and a recently opened chat's Saved copy, marked as saved, without reaching Hermes", async () => {
    const first = await firstLaunch();
    await first.hermes.open("nas");
    await first.hermes.close();
    const savedAt = first.cache.transcripts["default/nas"].savedAt;

    const hermes = offlineLaunch(first.server, first.cache)!;
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: expect.stringContaining("network is unreachable") });
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["nas", "other"]);

    await hermes.open("nas");
    expect(chat(hermes, "nas")).toMatchObject({ items: historyItems, savedAt });
    expect(chat(hermes, "nas").runtimeId).toBeUndefined();
    await hermes.close();
  });

  it("leaves a chat with no Saved copy empty", async () => {
    const first = await firstLaunch();
    const hermes = offlineLaunch(first.server, first.cache)!;
    await hermes.open("other");
    expect(chat(hermes, "other")).toMatchObject({ items: [] });
    expect(chat(hermes, "other").savedAt).toBeUndefined();
    await hermes.close();
  });

  it("has nothing to read when no chat list is saved", async () => {
    const server = new FakeHermes();
    expect(offlineLaunch(server, memoryCache())).toBeUndefined();
  });

  describe("once Hermes can be reached again", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it("connects on its own, and opening the chat swaps the Saved copy for the stored history", async () => {
      const first = await firstLaunch();
      await first.hermes.open("nas");
      await first.hermes.close();
      first.server.transcripts.nas.push({ role: "user", text: "Sent from Telegram" });

      const hermes = offlineLaunch(first.server, first.cache)!;
      await hermes.open("nas");
      first.server.refuse = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hermes.getSnapshot().status).toBe("connected");

      await hermes.open("nas");
      expect(chat(hermes, "nas").items).toEqual([...historyItems, { kind: "user", id: "h-3", text: "Sent from Telegram" }]);
      expect(chat(hermes, "nas").savedAt).toBeUndefined();
      await hermes.close();
    });
  });

  describe("after a failed launch whose quick tries ran out (#269)", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    /** A launch that couldn't connect, counting every try to. */
    async function failedLaunch() {
      const first = await firstLaunch();
      await first.hermes.close();
      const { server } = first;
      server.refuse = "Can't reach the Hermes dashboard: the sign-in didn't answer within 10s.";
      let tries = 0;
      const openPipe: OpenPipe = (...a) => (tries++, server.openPipe(...a));
      const hermes = readSaved(openPipe, server.refuse, first.cache)!;
      // The quick tries: after 1, 2, 4, 8 and 16 s.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(hermes.getSnapshot().status).toBe("offline");
      expect(tries).toBe(5);
      return { server, hermes, tries: () => tries };
    }

    it("keeps trying every 60 s, staying Offline between tries", async () => {
      const { hermes, tries } = await failedLaunch();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(tries()).toBe(5);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tries()).toBe(6);
      expect(hermes.getSnapshot().status).toBe("offline");
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(tries()).toBe(9);
      await hermes.close();
    });

    it("connects by itself once the server can be reached", async () => {
      const { server, hermes } = await failedLaunch();
      await vi.advanceTimersByTimeAsync(120_000);
      server.refuse = undefined;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hermes.getSnapshot().status).toBe("connected");
      await hermes.close();
    });

    it("stops when Hermes turns the password down", async () => {
      const { server, hermes, tries } = await failedLaunch();
      server.refuse = "Wrong username or password.";
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tries()).toBe(6);
      await vi.advanceTimersByTimeAsync(60_000 * 5);
      expect(tries()).toBe(6);
      expect(hermes.getSnapshot()).toMatchObject({ status: "offline", closedReason: "Wrong username or password." });
      await hermes.close();
    });
  });

  it("shows the Saved copy while the history is on the way, and keeps a message sent meanwhile after it", async () => {
    const first = await firstLaunch();
    await first.hermes.open("nas");
    await first.hermes.close();

    const { server } = first;
    const hermes = await connect(server.openPipe, undefined, first.cache);
    const resume = server.handlers["session.resume"];
    let answer = () => {};
    server.handlers["session.resume"] = (r) => void (answer = () => resume(r));

    const opening = hermes.open("nas");
    expect(chat(hermes, "nas")).toMatchObject({ loading: true, items: historyItems, savedAt: expect.any(Number) });
    const sending = hermes.send("nas", "Still there?");
    answer();
    await Promise.all([opening, sending]);
    expect(chat(hermes, "nas").items.map((i) => i.id)).toEqual(["h-0", "h-1", "h-2", "u-3"]);
    expect(chat(hermes, "nas").savedAt).toBeUndefined();
  });
});

describe("Signing in at launch", () => {
  const details: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "hunter2" };

  const none = { load: async () => undefined, save: async () => {}, delete: async () => {} };
  const c: SavedConnection = { id: "0b6f3c1e-2d4a-4f8b-9c7e-5a1d2e3f4a5b", name: "hermes", addedAt: 0, ...details };
  function account(server: FakeHermes, cache: ChatCache, refuse: string): Account {
    return {
      connections: new Connections({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
      secrets: () => ({ password: none, headers: none, token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }),
      connect: () => Promise.reject(new Error(refuse)),
      readSaved: (_c, _d, reason) => readSaved(server.openPipe, reason, cache),
      openSaved: () => undefined,
    };
  }

  it("opens what this computer saved when Hermes can't be reached", async () => {
    const { server, cache } = await firstLaunch();
    const hermes = await launchSignIn(c, details, account(server, cache, "SSH failed: Connection timed out"));
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: "SSH failed: Connection timed out" });
    await hermes.close();
  });

  it("asks for the password when the dashboard turns it down", async () => {
    const { server, cache } = await firstLaunch();
    await expect(launchSignIn(c, details, account(server, cache, "Wrong username or password."))).rejects.toThrow("Wrong username or password.");
  });

  it("shows the sign-in screen when nothing is saved to read", async () => {
    await expect(launchSignIn(c, details, account(new FakeHermes(), memoryCache(), "SSH failed: Connection timed out"))).rejects.toThrow(
      "SSH failed",
    );
  });
});

/** `server`'s pipe, opened only once `open()` is called: a connection that is slow to come up. */
function slowPipe(server: FakeHermes) {
  let open = () => {};
  const gate = new Promise<void>((done) => (open = done));
  let asked = 0;
  const openPipe: OpenPipe = async (...args) => {
    asked++;
    await gate;
    return server.openPipe(...args);
  };
  return { openPipe, open, asked: () => asked };
}

describe("Opening on the saved chats at launch (ADR 0089)", () => {
  const details: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "hunter2" };
  const none = { load: async () => undefined, save: async () => {}, delete: async () => {} };
  const c: SavedConnection = { id: "0b6f3c1e-2d4a-4f8b-9c7e-5a1d2e3f4a5b", name: "hermes", addedAt: 0, ...details };
  /** An account that signs in and opens through `openPipe`, with `cache` as what this computer saved. */
  function account(openPipe: OpenPipe, cache: ChatCache) {
    const connect_ = vi.fn((_c: SavedConnection, _d: SignInDetails) => connect(openPipe, undefined, cache));
    const a: Account = {
      connections: new Connections({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
      secrets: () => ({ password: none, headers: none, token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }),
      connect: connect_,
      readSaved: (_c, _d, reason) => readSaved(openPipe, reason, cache),
      openSaved: () => openSaved(openPipe, cache),
    };
    return { a, connect: connect_ };
  }
  /** What a first launch saved, with the server then closed, so the next launch starts from it. */
  async function saved() {
    const first = await firstLaunch();
    await first.hermes.close();
    return first;
  }
  const ids = (hermes: Hermes) => hermes.getSnapshot().chats.map((c) => c.id);

  afterEach(() => void vi.useRealTimers());

  it("shows the saved chats at once, Connecting, over a slow connection, and goes live by itself", async () => {
    const { server, cache } = await saved();
    const slow = slowPipe(server);
    const { a, connect: signIn } = account(slow.openPipe, cache);

    const { hermes, turnedDown } = await launchOpen(c, details, a);
    // Before the server has answered anything, the list is there and connecting has started, not waited a retry.
    expect(ids(hermes)).toEqual(["nas", "other"]);
    expect(hermes.getSnapshot().status).toBe("connecting");
    expect(hermes.getSnapshot().closedReason).toBeUndefined();
    expect(slow.asked()).toBe(1);
    expect(signIn).not.toHaveBeenCalled();

    slow.open();
    await expect(turnedDown).resolves.toBeUndefined();
    expect(hermes.getSnapshot().status).toBe("connected");
    await vi.waitFor(() => expect(server.opened).toBe(2));
    await hermes.close();
  });

  it("is turned down by a wrong saved password: closed, so the sign-in screen asks with its error", async () => {
    vi.useFakeTimers();
    const { server, cache } = await saved();
    server.refuse = WRONG_PASSWORD;
    let tries = 0;
    const openPipe: OpenPipe = (...args) => (tries++, server.openPipe(...args));
    const { a } = account(openPipe, cache);

    const { hermes, turnedDown } = await launchOpen(c, details, a);
    expect(ids(hermes)).toEqual(["nas", "other"]);
    await expect(turnedDown).resolves.toBe(WRONG_PASSWORD);
    // Closed: it never tries the wrong password again on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries).toBe(1);
  });

  it("is turned down by a refused saved token too", async () => {
    const { server, cache } = await saved();
    server.refuse = "Wrong token: the dashboard answered 401.";
    const { a } = account(server.openPipe, cache);
    await expect((await launchOpen(c, details, a)).turnedDown).resolves.toBe("Wrong token: the dashboard answered 401.");
  });

  it("keeps the saved chats and keeps trying when Hermes can't be reached, connecting once it can", async () => {
    vi.useFakeTimers();
    const { server, cache } = await saved();
    server.refuse = "SSH failed: Connection timed out";
    const { a } = account(server.openPipe, cache);

    const { hermes, turnedDown } = await launchOpen(c, details, a);
    await expect(turnedDown).resolves.toBeUndefined();
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: "SSH failed: Connection timed out" });
    expect(ids(hermes)).toEqual(["nas", "other"]);

    server.refuse = undefined;
    // The first try counts as one failed try, so the next comes after the second retry delay.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hermes.getSnapshot().status).toBe("connected");
    await hermes.close();
  });

  it("keeps trying every 60 s once the quick tries are spent, as after a failed launch (#269)", async () => {
    vi.useFakeTimers();
    const { server, cache } = await saved();
    server.refuse = "SSH failed: Connection timed out";
    let tries = 0;
    const openPipe: OpenPipe = (...args) => (tries++, server.openPipe(...args));
    const { a } = account(openPipe, cache);

    const { hermes, turnedDown } = await launchOpen(c, details, a);
    await expect(turnedDown).resolves.toBeUndefined();
    // The first try, then the quick tries after 2, 4, 8 and 16 s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tries).toBe(5);
    expect(hermes.getSnapshot().status).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries).toBe(6);
    expect(hermes.getSnapshot().status).toBe("offline");

    server.refuse = undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hermes.getSnapshot().status).toBe("connected");
    await hermes.close();
  });

  it("says nothing was turned down when the app closes it during the first try", async () => {
    const { server, cache } = await saved();
    const slow = slowPipe(server);
    const { a } = account(slow.openPipe, cache);
    const { hermes, turnedDown } = await launchOpen(c, details, a);
    // This pipe ignores the stop, as Rust doesn't, so it has to open before the close can finish.
    const closing = hermes.close();
    slow.open();
    await closing;
    await expect(turnedDown).resolves.toBeUndefined();
    expect(hermes.getSnapshot().status).not.toBe("connected");
  });

  describe("with no saved chats", () => {
    it("waits for signing in, as before, over a slow connection", async () => {
      const server = new FakeHermes();
      const slow = slowPipe(server);
      const { a, connect: signIn } = account(slow.openPipe, memoryCache());
      let done = false;
      const launching = launchOpen(c, details, a).then((l) => ((done = true), l));
      await vi.waitFor(() => expect(slow.asked()).toBe(1));
      expect(signIn).toHaveBeenCalledOnce();
      expect(done).toBe(false);

      slow.open();
      const { hermes, turnedDown } = await launching;
      expect(turnedDown).toBeUndefined();
      expect(hermes.getSnapshot().status).toBe("connected");
      await hermes.close();
    });

    it("rejects with a wrong password, so the sign-in screen asks", async () => {
      const server = new FakeHermes();
      server.refuse = WRONG_PASSWORD;
      await expect(launchOpen(c, details, account(server.openPipe, memoryCache()).a)).rejects.toThrow(WRONG_PASSWORD);
    });
  });
});

describe("Saved copies in localStorage", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map([["hermes-chat.sign-in", '{"username":"liam"}']]);
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const cache = localChatCache(nas);

  /** A transcript whose copy takes about `bytes` of storage. */
  const sized = (bytes: number): Item[] => [{ kind: "assistant", id: "a-0", text: "x".repeat(bytes / 2 - 100) }];

  it("load back as saved, with when they were saved", () => {
    vi.setSystemTime(1_700_000_000_000);
    cache.saveTranscript("work", "a/b", historyItems);
    expect(cache.loadTranscript("work", "a/b")).toEqual({ items: historyItems, savedAt: 1_700_000_000_000 });
    expect(cache.loadTranscript("default", "a/b")).toBeUndefined();
  });

  it("let go of the least recently saved copies past the storage limit", () => {
    const quarter = TRANSCRIPT_LIMIT_BYTES / 4;
    for (const [i, id] of ["a", "b", "c", "d"].entries()) {
      vi.setSystemTime(1_000 + i);
      cache.saveTranscript("default", id, sized(quarter - 200));
    }
    // Saving `a` again makes it the newest; `b` is now the oldest and goes when `e` needs room.
    vi.setSystemTime(2_000);
    cache.saveTranscript("default", "a", sized(quarter - 200));
    vi.setSystemTime(2_001);
    cache.saveTranscript("default", "e", sized(quarter - 200));

    const kept = ["a", "b", "c", "d", "e"].filter((id) => cache.loadTranscript("default", id));
    expect(kept).toEqual(["a", "c", "d", "e"]);
    expect(cache.bytes()).toBeLessThanOrEqual(TRANSCRIPT_LIMIT_BYTES);
  });

  it("keep which listed chats are archived", () => {
    const listed = { title: "NAS", source: "app" as const, settled: false, updatedAt: 5, items: [] };
    cache.save("default", [
      { id: "kept", ...listed, archived: true },
      { id: "active", ...listed },
    ]);
    expect(cache.load("default").map((c) => [c.id, c.archived])).toEqual([
      ["kept", true],
      ["active", undefined],
    ]);
  });

  it("keep when Hermes stored each message", () => {
    const timed: Item[] = [
      { kind: "user", id: "h-0", text: "How full is the NAS?", at: 1_700_000_000_000 },
      { kind: "assistant", id: "h-2", text: "**82%** used.", at: 1_700_000_005_000 },
    ];
    cache.saveTranscript("default", "nas", timed);
    expect(cache.loadTranscript("default", "nas")?.items).toEqual(timed);
  });

  it("don't keep a copy bigger than the limit", () => {
    cache.saveTranscript("default", "small", sized(1_000));
    cache.saveTranscript("default", "huge", sized(TRANSCRIPT_LIMIT_BYTES * 2));
    expect(cache.loadTranscript("default", "huge")).toBeUndefined();
    expect(cache.loadTranscript("default", "small")).toBeDefined();
  });

  it("are counted and cleared with the chat lists, leaving the sign-in", () => {
    cache.save("default", []);
    cache.saveTranscript("default", "nas", historyItems);
    expect(cache.bytes()).toBe(
      [...store].filter(([k]) => k !== "hermes-chat.sign-in").reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0),
    );
    cache.clear();
    expect(cache.bytes()).toBe(0);
    expect([...store.keys()]).toEqual(["hermes-chat.sign-in"]);
  });
});

describe("Saved copies stay apart, private and inert", () => {
  let store: Map<string, string>;
  const fakeStorage = () => ({
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterEach(() => void vi.unstubAllGlobals());

  const others: SavedSignIn[] = [
    { ...nas, sshTarget: "liam@backup" },
    { ...nas, username: "admin" },
    { mode: "url", sshTarget: "liam@hermes", url: "http://10.0.0.5:9119", username: "liam" },
  ];

  it("are kept apart per connection, profile and chat", async () => {
    const mine = localChatCache(nas);
    mine.save("default", [{ id: "nas", title: "NAS", source: "app", settled: false, updatedAt: 1, items: [] }]);
    mine.rememberProfile("work");
    mine.saveTranscript("default", "nas", historyItems);
    for (const other of others.map(localChatCache)) {
      expect(other.load("default")).toEqual([]);
      expect(other.lastProfile()).toBeUndefined();
      expect(other.loadTranscript("default", "nas")).toBeUndefined();
      expect(readSaved(new FakeHermes().openPipe, "unreachable", other)).toBeUndefined();
    }
    expect(mine.loadTranscript("work", "nas")).toBeUndefined();
    expect(mine.loadTranscript("default", "other")).toBeUndefined();
    expect(mine.loadTranscript("default", "nas")?.items).toEqual(historyItems);
  });

  it("never hold the password", async () => {
    const details: SignInDetails = { ...nas, password: "hunter2-secret" };
    const cache = localChatCache(details);
    const { server, hermes } = await firstLaunch(cache as MemoryCache);
    await hermes.open("nas");
    await hermes.send("nas", "Clean the logs");
    server.event(server.runtimeIdOf("nas")!, "message.complete", { text: "Done.", status: "complete" });
    expect(cache.loadTranscript("default", "nas")?.items.length).toBeGreaterThan(0);
    for (const [k, v] of store) expect(k + v).not.toContain("hunter2-secret");
    await hermes.close();
  });

  it("load nothing actionable: no Approval cards, errors or malformed items", async () => {
    const mine = localChatCache(nas);
    mine.saveTranscript("default", "nas", historyItems);
    const [k] = [...store.keys()].filter((k) => k.includes("transcript"));
    const saved = JSON.parse(store.get(k)!);
    saved.items.push(
      { kind: "approval", id: "srq-1", requestId: "apr-1", command: "rm -rf /", description: "recursive delete" },
      { kind: "error", id: "e-9", text: "old error" },
      { kind: "user", id: "u-9" },
      { kind: "tool", id: "t-9", name: "terminal", status: "exploded" },
      null,
      "junk",
    );
    store.set(k, JSON.stringify(saved));
    expect(mine.loadTranscript("default", "nas")?.items).toEqual(historyItems);

    // Even a card that reached the screen offline can't be answered from a Saved copy.
    const server = new FakeHermes();
    server.sessions = [row("nas", 1, { pinned: true })];
    mine.save("default", [{ id: "nas", title: "NAS", source: "app", settled: false, updatedAt: 1, items: [] }]);
    const hermes = readSaved(server.openPipe, "unreachable", mine)!;
    await hermes.open("nas");
    expect(chat(hermes, "nas").items.some((i) => i.kind === "approval")).toBe(false);
    await hermes.answerApproval("nas", "srq-1", "once");
    expect(server.approvalAnswers).toEqual([]);
    await hermes.close();
  });

  it("survive corrupt entries without crashing", async () => {
    const mine = localChatCache(nas);
    mine.save("default", []);
    mine.saveTranscript("default", "nas", historyItems);
    for (const k of store.keys()) store.set(k, k.includes("transcript") ? '{"savedAt":"soon","items":{}}' : "[{\"id\":\"nas\",\"title\":\"NAS\"},{\"id\":3},null");
    expect(mine.loadTranscript("default", "nas")).toBeUndefined();
    expect(mine.load("default")).toEqual([]);

    for (const k of store.keys()) store.set(k, k.includes("transcript") ? '{"savedAt":5,"items":[]}' : '[{"id":"nas","title":"NAS"},{"id":3},null]');
    expect(mine.load("default")).toEqual([{ id: "nas", title: "NAS", source: "other", settled: true, updatedAt: 0, items: [] }]);
    const hermes = readSaved(new FakeHermes().openPipe, "unreachable", mine)!;
    await expect(hermes.open("nas")).resolves.toBeUndefined();
    expect(chat(hermes, "nas").items).toEqual([]);
    await hermes.close();
  });

  it("survive storage that can't be used at all", async () => {
    const broken = () => {
      throw new Error("SecurityError: localStorage is disabled");
    };
    vi.stubGlobal("localStorage", { get length() { return broken(); }, key: broken, getItem: broken, setItem: broken, removeItem: broken });
    const mine = localChatCache(nas);
    const { server, hermes } = await firstLaunch(mine as MemoryCache);
    await hermes.open("nas");
    server.event(server.runtimeIdOf("nas")!, "message.complete", { text: "Done.", status: "complete" });
    expect(mine.bytes()).toBe(0);
    expect(() => mine.clear()).not.toThrow();
    expect(readSaved(server.openPipe, "unreachable", mine)).toBeUndefined();
    await hermes.close();
  });

  it("clearing deletes every connection's lists and Saved copies, and nothing else", () => {
    store.set("hermes-chat.sign-in", '{"username":"liam"}');
    store.set("hermes-chat.draft.x", "half a thought");
    store.set("other-app", "x");
    for (const c of [nas, ...others].map(localChatCache)) {
      c.save("default", []);
      c.saveTranscript("default", "nas", historyItems);
      c.rememberProfile("default");
    }
    localChatCache(nas).clear();
    expect([...store.keys()].filter((k) => k.includes("chats") || k.includes("transcript"))).toEqual([]);
    expect(store.get("hermes-chat.sign-in")).toBe('{"username":"liam"}');
    expect(store.get("hermes-chat.draft.x")).toBe("half a thought");
    expect(store.get("other-app")).toBe("x");
  });
});

describe("Deleting a chat", () => {
  it("deletes its Saved copy too", async () => {
    const { hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    expect(cache.loadTranscript("default", "nas")).toBeDefined();
    hermes.leave("nas");
    expect(await hermes.delete("nas")).toBe(true);
    expect(cache.loadTranscript("default", "nas")).toBeUndefined();
  });
});

describe("Saved copies keep the agent's thinking", () => {
  it("as Hermes stores it", async () => {
    const { server, hermes, cache } = await firstLaunch();
    server.transcripts.nas[2] = { ...history[2], reasoning: "Check the mount first." };
    await hermes.open("nas");
    expect(cache.loadTranscript("default", "nas")?.items.map((i) => i.kind)).toEqual(["user", "tool", "thinking", "assistant"]);
  });
});
