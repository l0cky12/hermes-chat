import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row, type RestRequest } from "./fakeHermes";
import { connect } from "./transport";
import { RestError } from "./pipe";

async function listed(...rows: ReturnType<typeof row>[]) {
  const server = new FakeHermes();
  server.sessions = rows;
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const stored = (id: string) => server.sessions.find((s) => s.id === id)!;
  return { server, hermes, chat, stored };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const patches = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PATCH").map((r) => editFlags(r.body));

/** Holds back the server's answers to PATCHes of `id` until the returned function is called. */
function holdPatches(server: FakeHermes, id: string) {
  const key = `PATCH /api/sessions/${id}`;
  const held: (() => void)[] = [];
  server.rest[key] = (req: RestRequest) =>
    new Promise((resolve) =>
      held.push(() => {
        server.sessions.find((s) => s.id === id)!.pinned = req.body!.pinned as boolean;
        resolve({ ok: true });
      }),
    );
  return () => {
    delete server.rest[key];
    held.splice(0).forEach((answer) => answer());
  };
}

describe("Settling and unsettling", () => {
  it("settles an Active chat by unpinning it", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    await hermes.settle("a");
    expect(patches(server)).toEqual([{ pinned: false, profile: "default" }]);
    expect(stored("a").pinned).toBe(false);
    expect(chat("a").settled).toBe(true);
  });

  it("names the session's current revision and a new request id, as Hermes requires of every edit", async () => {
    const { server, hermes, stored } = await listed(row("a", 1, { pinned: true, runtime_revision: 4 }));
    await hermes.settle("a");
    await hermes.unsettle("a");
    const sent = server.restRequests.filter((r) => r.method === "PATCH").map((r) => r.body!);
    expect(sent.map((b) => b.expected_revision)).toEqual([4, 5]);
    expect(new Set(sent.map((b) => b.request_id)).size).toBe(2);
    expect(stored("a").runtime_revision).toBe(6);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("settles again when another edit of the chat lands between reading its revision and writing", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    const key = "GET /api/sessions/a/mutation-snapshot";
    server.rest[key] = () => {
      delete server.rest[key];
      stored("a").runtime_revision = 1;
      return { session_id: "a", exists: true, runtime_revision: 0, runtime_generation: 0 };
    };
    await hermes.settle("a");
    expect(patches(server).map((b) => b.pinned)).toEqual([false, false]);
    expect(stored("a").pinned).toBe(false);
    expect(chat("a").settled).toBe(true);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("moves a Settled chat to Active by pinning it", async () => {
    const { server, hermes, chat, stored } = await listed(row("tg", 1, { source: "telegram" }));
    await hermes.unsettle("tg");
    expect(patches(server)).toEqual([{ pinned: true, profile: "default" }]);
    expect(stored("tg").pinned).toBe(true);
    expect(chat("tg").settled).toBe(false);
  });

  it("moves the chat at once, before the server has answered", async () => {
    const { server, hermes, chat } = await listed(row("a", 1, { pinned: true }));
    const answer = holdPatches(server, "a");
    const settling = hermes.settle("a");
    expect(chat("a").settled).toBe(true);
    answer();
    await settling;
  });

  it("undoes a settle with the opposite PATCH", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    await hermes.settle("a");
    await hermes.unsettle("a");
    expect(patches(server).map((b) => b.pinned)).toEqual([false, true]);
    expect(stored("a").pinned).toBe(true);
    expect(chat("a").settled).toBe(false);
  });

  it("sends an undo after the settle it undoes, so the server ends where the owner left the chat", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    const answer = holdPatches(server, "a");
    const settling = hermes.settle("a");
    await tick();
    const undoing = hermes.unsettle("a");
    await hermes.sync();
    expect(patches(server)).toHaveLength(1);
    answer();
    await Promise.all([settling, undoing]);
    expect(patches(server).map((b) => b.pinned)).toEqual([false, true]);
    expect(stored("a").pinned).toBe(true);
    expect(chat("a").settled).toBe(false);
  });

  it("keeps the chat where the owner put it when the list refreshes before the server has answered", async () => {
    const { server, hermes, chat } = await listed(row("a", 1, { pinned: true }));
    const answer = holdPatches(server, "a");
    const settling = hermes.settle("a");
    await hermes.sync();
    expect(chat("a").settled).toBe(true);
    answer();
    await settling;
    await hermes.sync();
    expect(chat("a").settled).toBe(true);
  });

  it("keeps the chat where the owner put it when a list read before the settle arrives after it", async () => {
    const { server, hermes, chat } = await listed(row("a", 1, { pinned: true }));
    const list = server.rest["GET /api/sessions"];
    let answer!: () => void;
    server.rest["GET /api/sessions"] = (req) => {
      const stale = structuredClone(list(req));
      return new Promise((resolve) => (answer = () => resolve(stale)));
    };
    const syncing = hermes.sync();
    await tick();
    await hermes.settle("a");
    answer();
    await syncing;
    expect(chat("a").settled).toBe(true);
  });

  it("doesn't pin a Settled chat while a message to it is still on the way, in case it fails", async () => {
    const { server, hermes, chat, stored } = await listed(row("tg", 1, { source: "telegram" }));
    let fail!: () => void;
    server.handlers["prompt.submit"] = (r) => void (fail = () => server.fail(r.id, 4009, "session busy"));
    const sending = hermes.send("tg", "follow up");
    await tick();
    await hermes.sync();
    await hermes.idle();
    fail();
    await sending;
    expect(patches(server)).toEqual([]);
    expect(stored("tg").pinned).toBe(false);
    expect(chat("tg").settled).toBe(true);
  });

  it("still follows pins changed in another Hermes client", async () => {
    const { hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    await hermes.settle("a");
    stored("a").pinned = true;
    await hermes.sync();
    expect(chat("a").settled).toBe(false);
  });

  it("reports a settle the server refused, keeps the chat Settled, and tries again on the next refresh", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    server.rest["PATCH /api/sessions/a"] = () => {
      throw new RestError(503, "busy");
    };
    await hermes.settle("a");
    expect(hermes.getSnapshot().syncError).toBe("Couldn't keep a chat Settled on the server: The dashboard answered 503: busy");
    expect(chat("a").settled).toBe(true);

    delete server.rest["PATCH /api/sessions/a"];
    await hermes.sync();
    await hermes.idle();
    expect(stored("a").pinned).toBe(false);
    expect(chat("a").settled).toBe(true);
  });

  it("keeps a new chat Settled if the owner settles it before Hermes has stored it", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const id = await hermes.newChat();
    server.rest[`PATCH /api/sessions/${id}`] = () => {
      throw new RestError(404, `{"detail":"Session not found"}`);
    };
    await hermes.send(id, "hello");
    await hermes.settle(id);
    // The turn is still running, so the end of the turn tries again; no error yet.
    expect(hermes.getSnapshot().syncError).toBeUndefined();

    delete server.rest[`PATCH /api/sessions/${id}`];
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Hi!", status: "complete" });
    await hermes.idle();
    expect(server.sessions.find((s) => s.id === id)!.pinned).toBe(false);
    await hermes.sync();
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)!.settled).toBe(true);
  });

  it("makes a chat the owner settled Active again when they send in it", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }));
    await hermes.settle("a");
    await hermes.send("a", "one more thing");
    await hermes.idle();
    expect(patches(server).map((b) => b.pinned)).toEqual([false, true]);
    expect(stored("a").pinned).toBe(true);
    expect(chat("a").settled).toBe(false);
  });

  it("does nothing for a chat already where it is asked to go", async () => {
    const { server, hermes } = await listed(row("a", 1, { pinned: true }), row("b", 1));
    await hermes.unsettle("a");
    await hermes.settle("b");
    expect(patches(server)).toEqual([]);
  });
});

describe("Settling many chats at once", () => {
  it("settles each chat with the row's write and resolves to none failed", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }), row("b", 2, { pinned: true }), row("c", 3, { pinned: true }));
    expect(await hermes.settleAll(["a", "b"])).toEqual([]);
    expect(patches(server).map((b) => b.pinned)).toEqual([false, false]);
    expect(["a", "b", "c"].map((id) => stored(id).pinned)).toEqual([false, false, true]);
    expect(["a", "b", "c"].map((id) => chat(id).settled)).toEqual([true, true, false]);
  });

  it("moves every chat at once, before the server has answered", async () => {
    const { server, hermes, chat } = await listed(row("a", 1, { pinned: true }), row("b", 2, { pinned: true }));
    const release = [holdPatches(server, "a"), holdPatches(server, "b")];
    const done = hermes.settleAll(["a", "b"]);
    await tick();
    expect([chat("a").settled, chat("b").settled]).toEqual([true, true]);
    release.forEach((r) => r());
    expect(await done).toEqual([]);
  });

  it("puts a chat whose write failed back in Active, names it, and doesn't write it again", async () => {
    const { server, hermes, chat, stored } = await listed(row("a", 1, { pinned: true }), row("b", 2, { pinned: true }));
    server.rest["PATCH /api/sessions/b"] = () => {
      throw new RestError(503, "busy");
    };
    expect(await hermes.settleAll(["a", "b"])).toEqual(["b"]);
    expect([chat("a").settled, chat("b").settled]).toEqual([true, false]);

    delete server.rest["PATCH /api/sessions/b"];
    const before = patches(server).length;
    await hermes.sync();
    await hermes.idle();
    expect(patches(server).length).toBe(before);
    expect(stored("b").pinned).toBe(true);
    expect(chat("b").settled).toBe(false);
  });

  it("leaves a failed chat the owner moved again meanwhile where they put it", async () => {
    const { server, hermes, chat } = await listed(row("a", 1, { pinned: true }));
    server.rest["PATCH /api/sessions/a"] = async () => {
      await tick();
      throw new RestError(503, "busy");
    };
    const done = hermes.settleAll(["a"]);
    await tick();
    void hermes.unsettle("a");
    delete server.rest["PATCH /api/sessions/a"];
    expect(await done).toEqual(["a"]);
    await hermes.idle();
    expect(chat("a").settled).toBe(false);
  });

  it("counts a chat already Settled, or gone, as settled without a write", async () => {
    const { server, hermes } = await listed(row("a", 1), row("b", 2, { pinned: true }));
    expect(await hermes.settleAll(["a", "nope"])).toEqual([]);
    expect(patches(server)).toEqual([]);
  });
});

describe("Where replies go", () => {
  it("posts replies only in Hermes clients, Telegram and Discord chats included, on the legacy protocol", async () => {
    const { hermes } = await listed(row("tg", 1, { source: "telegram" }), row("dc", 1, { source: "discord" }));
    expect(hermes.alsoPostsIn("tg")).toBeUndefined();
    expect(hermes.alsoPostsIn("dc")).toBeUndefined();
  });
});
