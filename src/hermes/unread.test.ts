import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { connect, type ChatCache } from "./transport";
import { RestError } from "./pipe";

async function listed(rows: ReturnType<typeof row>[], profile = "default", cache?: ChatCache) {
  const server = new FakeHermes();
  if (profile === "default") server.sessions = rows;
  else server.otherProfiles[profile] = rows;
  const hermes = await connect(server.openPipe, profile, cache);
  await hermes.sync();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const stored = (id: string) => server.store(profile)!.find((s) => s.id === id)!;
  return { server, hermes, chat, stored };
}

const readWrites = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "PATCH" && "unread" in (r.body ?? {})).map((r) => editFlags(r.body));

/** Something new happens in the stored session, as another client or platform would cause. */
const activity = (s: ReturnType<typeof row>) => void (s.last_active = Date.now() / 1000 + 1);

/** Holds back the server's answers to PATCHes of `id` until the returned function is called. */
function holdPatches(server: FakeHermes, id: string) {
  const key = `PATCH /api/sessions/${id}`;
  const held: (() => void)[] = [];
  server.rest[key] = (req: RestRequest) =>
    new Promise((resolve) =>
      held.push(() => {
        if (req.body!.unread === false) server.sessions.find((s) => s.id === id)!.last_read_at = Date.now() / 1000;
        resolve({ ok: true });
      }),
    );
  return () => {
    delete server.rest[key];
    held.splice(0).forEach((answer) => answer());
  };
}

describe("The unread dot", () => {
  it("shows on chats Hermes lists as unread", async () => {
    const { chat } = await listed([row("new", 1, { last_read_at: 0 }), row("seen", 1, { last_read_at: Date.now() / 1000 }), row("never", 1)]);
    expect(chat("new").unread).toBe(true);
    expect(chat("seen").unread).toBe(false);
    // Hermes counts a chat no client has ever opened as read.
    expect(chat("never").unread).toBe(false);
  });

  it("clears when the chat is opened, here and on the server", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 1, { last_read_at: 0 })]);
    await hermes.open("a");
    await hermes.idle();
    expect(readWrites(server)).toEqual([{ unread: false, profile: "default" }]);
    expect(chat("a").unread).toBe(false);
    await hermes.sync();
    expect(stored("a").last_read_at).toBeGreaterThan(0);
    expect(chat("a").unread).toBe(false);
  });

  it("marks the chat read in the current profile", async () => {
    const { server, hermes } = await listed([row("a", 1, { last_read_at: 0 })], "work");
    await hermes.open("a");
    await hermes.idle();
    expect(readWrites(server)).toEqual([{ unread: false, profile: "work" }]);
  });

  it("clears at once, before the server has answered", async () => {
    const { server, hermes, chat } = await listed([row("a", 1, { last_read_at: 0 })]);
    const answer = holdPatches(server, "a");
    void hermes.open("a");
    expect(chat("a").unread).toBe(false);
    answer();
    await hermes.idle();
  });

  it("marks a chat read even when no client has before, so later activity in it shows the dot", async () => {
    const { server, hermes, chat, stored } = await listed([row("tg", 1, { source: "telegram" })]);
    await hermes.open("tg");
    hermes.leave("tg");
    await hermes.idle();
    expect(readWrites(server)).toEqual([{ unread: false, profile: "default" }]);
    activity(stored("tg"));
    await hermes.sync();
    expect(chat("tg").unread).toBe(true);
  });

  it("doesn't come back from a list read before the server stored the read", async () => {
    const { server, hermes, chat } = await listed([row("a", 1, { last_read_at: 0 })]);
    const answer = holdPatches(server, "a");
    void hermes.open("a");
    hermes.leave("a");
    await hermes.sync();
    expect(chat("a").unread).toBe(false);
    answer();
    await hermes.idle();
    expect(chat("a").unread).toBe(false);
  });

  it("stays off the chat on screen, which is kept read on the server", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 })]);
    await hermes.open("a");
    await hermes.idle();
    const opened = readWrites(server).length;
    activity(stored("a"));
    await hermes.sync();
    expect(chat("a").unread).toBe(false);
    await hermes.idle();
    expect(readWrites(server).slice(opened)).toEqual([{ unread: false, profile: "default" }]);
  });

  it("marks the chat on screen read when a reply in it finishes", async () => {
    const { server, hermes, stored } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 })]);
    await hermes.open("a");
    await hermes.send("a", "hi");
    await hermes.idle();
    const opened = readWrites(server).length;
    activity(stored("a"));
    server.event(server.runtimeIdOf("a")!, "message.complete", { text: "hello", status: "complete" });
    await hermes.idle();
    expect(readWrites(server).slice(opened)).toEqual([{ unread: false, profile: "default" }]);
  });

  it("comes back for new activity once the owner has left the chat", async () => {
    const { hermes, chat, stored } = await listed([row("a", 1, { last_read_at: 0 })]);
    await hermes.open("a");
    hermes.leave("a");
    await hermes.idle();
    activity(stored("a"));
    await hermes.sync();
    expect(chat("a").unread).toBe(true);
  });

  it("comes back quietly if the server didn't store the read", async () => {
    const { server, hermes, chat } = await listed([row("a", 1, { last_read_at: 0 })]);
    server.rest["PATCH /api/sessions/a"] = () => {
      throw new RestError(500, "", "The dashboard answered 500");
    };
    await hermes.open("a");
    hermes.leave("a");
    await hermes.idle();
    await hermes.sync();
    expect(chat("a").unread).toBe(true);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("is kept with the cached list, so it shows at the next launch", async () => {
    const cache = memoryCache();
    await listed([row("a", 1, { last_read_at: 0 })], "default", cache);
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, "default", cache);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "a")?.unread).toBe(true);
  });
});

describe("The unread dot with two panes", () => {
  it("stays off both chats on screen side by side", async () => {
    const { hermes, chat, stored } = await listed([row("a", 1, { last_read_at: 0 }), row("b", 1, { last_read_at: 0 })]);
    await hermes.open("a", "left");
    await hermes.open("b", "right");
    await hermes.idle();
    activity(stored("a"));
    activity(stored("b"));
    await hermes.sync();
    expect(chat("a").unread).toBe(false);
    expect(chat("b").unread).toBe(false);
  });

  it("comes back for a chat once neither pane shows it", async () => {
    const { hermes, chat, stored } = await listed([row("a", 1, { last_read_at: 0 }), row("b", 1, { last_read_at: 0 })]);
    await hermes.open("a", "left");
    await hermes.open("a", "right");
    hermes.leave("a", "left");
    await hermes.idle();
    activity(stored("a"));
    await hermes.sync();
    // The right pane still has it on screen.
    expect(chat("a").unread).toBe(false);
    // The right pane moves on to another chat, which takes the place of the first.
    await hermes.open("b", "right");
    await hermes.idle();
    activity(stored("a"));
    await hermes.sync();
    expect(chat("a").unread).toBe(true);
    expect(chat("b").unread).toBe(false);
  });

  it("marks both chats on screen read once the window is back in focus", async () => {
    const { server, hermes, stored } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 }), row("b", 1, { last_read_at: Date.now() / 1000 })]);
    await hermes.open("a", "left");
    await hermes.open("b", "right");
    await hermes.idle();
    const opened = readWrites(server).length;
    hermes.setFocused(false);
    activity(stored("a"));
    activity(stored("b"));
    await hermes.sync();
    await hermes.idle();
    expect(readWrites(server).length).toBe(opened);
    hermes.setFocused(true);
    await hermes.idle();
    expect(server.restRequests.filter((r) => r.method === "PATCH" && r.body?.unread === false).slice(-2).map((r) => r.path).sort()).toEqual([
      "/api/sessions/a",
      "/api/sessions/b",
    ]);
  });

  it("isn't marked read when the window comes back after the pane has left the chat", async () => {
    const { server, hermes, stored } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 }), row("b", 1, { last_read_at: Date.now() / 1000 })]);
    await hermes.open("a", "left");
    await hermes.open("b", "right");
    await hermes.idle();
    hermes.setFocused(false);
    activity(stored("a"));
    await hermes.sync();
    hermes.leave("a", "left");
    const before = readWrites(server).length;
    hermes.setFocused(true);
    await hermes.idle();
    expect(readWrites(server).length).toBe(before);
  });
});
