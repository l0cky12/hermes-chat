import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import type { Chat } from "./model";
import { type ChatCache, connect } from "./transport";

function memoryCache(initial: Record<string, Chat[]> = {}): ChatCache & { saved: Record<string, Chat[]> } {
  const saved = { ...initial };
  return { saved, load: (p) => saved[p] ?? [], save: (p, chats) => void (saved[p] = chats) };
}

async function signedIn(server = new FakeHermes(), cache?: ChatCache) {
  const hermes = await connect(server.openPipe, "default", cache);
  const chats = () => hermes.getSnapshot().chats;
  return { server, hermes, chats, chat: (id: string) => chats().find((c) => c.id === id)! };
}

const ids = (chats: Chat[]) => chats.map((c) => c.id).sort();

describe("Chat list sync", () => {
  it("lists the profile's chats from the past month, most recent first, through dashboard REST", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1), row("b", 29), row("c", 31), row("d", 0.1)];
    const { hermes, chats } = await signedIn(server);
    await hermes.sync();

    const q = server.restRequests[0].query;
    expect(server.restRequests[0]).toMatchObject({ method: "GET", path: "/api/sessions" });
    expect(Object.fromEntries(q)).toMatchObject({ profile: "default", order: "recent", limit: "100", offset: "0" });
    expect(chats().map((c) => c.id)).toEqual(["d", "a", "b"]);
  });

  it("makes pinned chats Active and the rest Settled", async () => {
    const server = new FakeHermes();
    server.sessions = [row("pinned", 2, { pinned: true }), row("loose", 1)];
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    expect(chat("pinned").settled).toBe(false);
    expect(chat("loose").settled).toBe(true);
  });

  it("shows this app's and gui chats without a source, and maps the rest", async () => {
    const server = new FakeHermes();
    const sources = ["hermes-chat", "gui", "telegram", "discord", "cli", "tui", "desktop", "api_server"];
    server.sessions = sources.map((s, i) => row(s, i, { source: s }));
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    expect(sources.map((s) => chat(s).source)).toEqual(["app", "app", "telegram", "discord", "cli", "cli", "desktop", "other"]);
  });

  it("leaves out cron jobs and chats archived in Hermes", async () => {
    const server = new FakeHermes();
    server.sessions = [row("job", 1, { source: "cron" }), row("gone", 1, { archived: true, pinned: true }), row("kept", 1)];
    const { hermes, chats } = await signedIn(server);
    await hermes.sync();
    expect(server.restRequests[0].query.get("exclude_sources")).toBe("cron");
    expect(ids(chats())).toEqual(["kept"]);
  });

  it("titles a chat from its first message until Hermes names it", async () => {
    const server = new FakeHermes();
    server.sessions = [row("named", 1), row("unnamed", 1, { title: null, preview: "Check the NAS" }), row("blank", 1, { title: "", preview: "" })];
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    expect([chat("named").title, chat("unnamed").title, chat("blank").title]).toEqual(["Chat named", "Check the NAS", "Untitled chat"]);
    expect(chat("named").updatedAt).toBeCloseTo(server.sessions[0].last_active! * 1000, -1);
  });

  it("pages until the list passes a month ago, without repeating the pinned chats each page carries", async () => {
    const server = new FakeHermes();
    const recent = Array.from({ length: 150 }, (_, i) => row(`r${i}`, i * 0.1, { pinned: i % 50 === 0 }));
    const old = Array.from({ length: 300 }, (_, i) => row(`o${i}`, 40 + i));
    server.sessions = [...recent, ...old, row("old-pin", 90, { pinned: true })];
    const { hermes, chats } = await signedIn(server);
    await hermes.sync();
    expect(server.restRequests.map((r) => r.query.get("offset"))).toEqual(["0", "100"]);
    expect(ids(chats())).toEqual(recent.map((r) => r.id).sort());
  });

  it("keeps the transcript of a chat it already has when the list refreshes", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hello");
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Hi!", status: "complete" });
    server.sessions.find((s) => s.id === id)!.title = "Greeting";
    await hermes.sync();
    expect(chat(id)).toMatchObject({ title: "Greeting", runtimeId: "rt-1" });
    expect(chat(id).items.map((i) => i.kind)).toEqual(["user", "assistant"]);
  });

  it("keeps a new chat in the list before Hermes has stored it", async () => {
    const { hermes, chats } = await signedIn();
    const id = await hermes.newChat();
    await hermes.sync();
    expect(ids(chats())).toEqual([id]);
  });

  it("drops chats that left the server's list", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1), row("b", 1)];
    const { hermes, chats } = await signedIn(server);
    await hermes.sync();
    server.sessions = [row("a", 1)];
    await hermes.sync();
    expect(ids(chats())).toEqual(["a"]);
  });

  it("refreshes when Hermes says its sessions changed", async () => {
    const { server, hermes, chats } = await signedIn();
    server.sessions = [row("from-telegram", 0, { source: "telegram" })];
    server.broadcast("sessions.changed");
    await hermes.idle();
    expect(ids(chats())).toEqual(["from-telegram"]);
  });

  it("runs one more sync, not one per request, when asked while a sync is running", async () => {
    const { server, hermes } = await signedIn();
    await Promise.all([hermes.sync(), hermes.sync(), hermes.sync()]);
    expect(server.restRequests).toHaveLength(2);
  });

  it("keeps the list and reports the error when a refresh fails", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    const { hermes, chats } = await signedIn(server);
    await hermes.sync();
    server.rest["GET /api/sessions"] = () => {
      throw new Error("The dashboard answered 503: store busy");
    };
    await hermes.sync();
    expect(hermes.getSnapshot()).toMatchObject({ syncError: "Couldn't refresh the chat list: The dashboard answered 503: store busy" });
    expect(ids(chats())).toEqual(["a"]);
    server.rest["GET /api/sessions"] = () => ({ sessions: [], total: 0, limit: 100, offset: 0, storage: {} });
    await hermes.sync();
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });
});

describe("Local chat list cache", () => {
  it("shows the cached list as soon as Hermes is connected", async () => {
    const cached: Chat = { id: "c1", title: "Cached", source: "telegram", settled: true, updatedAt: 1, items: [] };
    const { chats } = await signedIn(new FakeHermes(), memoryCache({ default: [cached] }));
    expect(chats()).toEqual([cached]);
  });

  it("saves the synced list for the profile, without transcripts or live state", async () => {
    const cache = memoryCache();
    const { server, hermes } = await signedIn(new FakeHermes(), cache);
    const id = await hermes.newChat();
    await hermes.send(id, "hello");
    server.sessions.push(row("t", 2, { source: "telegram", pinned: true }));
    await hermes.sync();
    expect(cache.saved.default.find((c) => c.id === "t")).toEqual({
      id: "t",
      title: "Chat t",
      source: "telegram",
      settled: false,
      updatedAt: expect.any(Number),
      unread: false,
      items: [],
    });
    expect(cache.saved.default.find((c) => c.id === id)).toEqual({
      id,
      title: "hello",
      source: "app",
      settled: false,
      updatedAt: expect.any(Number),
      unread: false,
      items: [],
    });
  });
});

describe("Active is Hermes's pinned flag", () => {
  it("pins a new chat as soon as Hermes has stored it", async () => {
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hello");
    await hermes.idle();
    const patch = server.restRequests.find((r) => r.method === "PATCH")!;
    expect(patch).toMatchObject({ path: `/api/sessions/${id}`, body: { pinned: true, profile: "default" } });
    expect(server.sessions.find((s) => s.id === id)!.pinned).toBe(true);
  });

  it("pins at the end of the turn if Hermes hadn't stored the chat yet, and keeps it Active meanwhile", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.rest[`PATCH /api/sessions/${id}`] = () => {
      throw new Error(`The dashboard answered 404: {"detail":"Session not found"}`);
    };
    await hermes.send(id, "hello");
    await hermes.sync();
    expect(chat(id).settled).toBe(false);
    expect(hermes.getSnapshot().syncError).toBeUndefined();

    delete server.rest[`PATCH /api/sessions/${id}`];
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Hi!", status: "complete" });
    await hermes.idle();
    expect(server.sessions.find((s) => s.id === id)!.pinned).toBe(true);
  });

  it("reports a pin that still fails at the end of the turn", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.rest[`PATCH /api/sessions/${id}`] = () => {
      throw new Error("The dashboard answered 503: busy");
    };
    await hermes.send(id, "hello");
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Hi!", status: "complete" });
    await hermes.idle();
    expect(hermes.getSnapshot().syncError).toBe("Couldn't keep a chat Active on the server: The dashboard answered 503: busy");
    expect(chat(id).settled).toBe(false);
  });

  it("resumes a Settled chat to reply in it, then makes it Active and pins it", async () => {
    const server = new FakeHermes();
    server.sessions = [row("tg", 3, { source: "telegram" })];
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    await hermes.send("tg", "follow up");

    expect(server.last("session.resume")!.params).toEqual({ session_id: "tg", profile: "default", inline_images: false });
    const runtimeId = server.runtimeIdOf("tg")!;
    expect(server.last("prompt.submit")!.params).toEqual({ session_id: runtimeId, profile: "default", text: "follow up" });
    expect(chat("tg")).toMatchObject({ settled: false, runtimeId, source: "telegram" });
    await hermes.idle();
    expect(server.sessions[0].pinned).toBe(true);
  });

  it("doesn't pin a chat that is already Active", async () => {
    const server = new FakeHermes();
    server.sessions = [row("p", 1, { pinned: true })];
    const { hermes } = await signedIn(server);
    await hermes.sync();
    await hermes.send("p", "more");
    server.event(server.runtimeIdOf("p")!, "message.complete", { text: "ok", status: "complete" });
    await hermes.idle();
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("shows an error if the chat can't be resumed", async () => {
    const server = new FakeHermes();
    server.sessions = [row("x", 1)];
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    server.sessions = [];
    await hermes.send("x", "hi");
    expect(chat("x")).toMatchObject({ running: false });
    expect(chat("x").items.at(-1)).toMatchObject({ kind: "error", text: "session not found: x" });
    expect(server.last("prompt.submit")).toBeUndefined();
  });
});
