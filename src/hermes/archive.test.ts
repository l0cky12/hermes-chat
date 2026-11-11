import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { RestError } from "./pipe";
import { connect } from "./transport";

async function listed(...rows: ReturnType<typeof row>[]) {
  const server = new FakeHermes();
  server.sessions = rows;
  const cache = memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id);
  const stored = (id: string) => server.sessions.find((s) => s.id === id)!;
  // What the list shows: chats not archived. The archived view shows the others.
  const shown = () => hermes.getSnapshot().chats.filter((c) => !c.archived).map((c) => c.id).sort();
  const archived = () => hermes.getSnapshot().chats.filter((c) => c.archived).map((c) => c.id).sort();
  return { server, hermes, cache, chat, stored, shown, archived };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const patches = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PATCH").map((r) => editFlags(r.body));
const readbacks = (server: FakeHermes, id: string) => server.restRequests.filter((r) => r.method === "GET" && r.path === `/api/sessions/${id}`);
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");

/** Holds back the server's answers to `METHOD /path` until the returned function is called. */
function hold(server: FakeHermes, key: string, answer: (req: RestRequest) => unknown) {
  const held: (() => void)[] = [];
  server.rest[key] = (req) => new Promise((resolve, reject) => held.push(() => {
    try {
      resolve(answer(req));
    } catch (e) {
      reject(e);
    }
  }));
  return () => {
    delete server.rest[key];
    held.splice(0).forEach((go) => go());
  };
}

/** The first mutation-snapshot read of `id` answers, then `meanwhile` runs, as another Hermes client's edit landing. */
function editLandsAfterRevisionRead(server: FakeHermes, id: string, meanwhile: () => void) {
  const key = `GET /api/sessions/${id}/mutation-snapshot`;
  server.rest[key] = () => {
    delete server.rest[key];
    const s = server.sessions.find((r) => r.id === id)!;
    const revision = s.runtime_revision ?? 0;
    meanwhile();
    s.runtime_revision = revision + 1;
    return { session_id: id, exists: true, runtime_revision: revision, runtime_generation: 0 };
  };
}

describe("Archiving a chat", () => {
  it("sets only Hermes's archived flag, for the chat's profile, and takes the chat off the list", async () => {
    const { server, hermes, stored, shown, archived } = await listed(row("a", 1, { pinned: true }), row("b", 2));
    expect(await hermes.archive("a")).toBe(true);
    expect(patches(server)).toEqual([{ archived: true, profile: "default" }]);
    expect(stored("a")).toMatchObject({ archived: true, pinned: true });
    expect(shown()).toEqual(["b"]);
    expect(archived()).toEqual(["a"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("keeps the chat's history on the server", async () => {
    const { server, hermes } = await listed(row("a", 1));
    server.transcripts.a = [{ role: "user", text: "Keep this" }];
    await hermes.archive("a");
    expect(server.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(server.transcripts.a).toEqual([{ role: "user", text: "Keep this" }]);
    expect(server.restRequests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("confirms the write by reading the chat back from Hermes", async () => {
    const { server, hermes } = await listed(row("a", 1));
    await hermes.archive("a");
    const patchAt = server.restRequests.findIndex((r) => r.method === "PATCH");
    const read = readbacks(server, "a");
    expect(read).toHaveLength(1);
    expect(server.restRequests.indexOf(read[0])).toBeGreaterThan(patchAt);
    expect(read[0].query.get("profile")).toBe("default");
  });

  it("takes the chat off the list at once, and a list read before the write doesn't bring it back", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    const answer = hold(server, "PATCH /api/sessions/a", () => {
      stored("a").archived = true;
      return { ok: true };
    });
    const archiving = hermes.archive("a");
    expect(shown()).toEqual(["b"]);
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
    answer();
    expect(await archiving).toBe(true);
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
  });

  it("stays off the list though Hermes lists an archived chat that is pinned", async () => {
    const { hermes, chat, shown } = await listed(row("a", 1, { pinned: true }), row("b", 2));
    await hermes.archive("a");
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
    expect(chat("a")?.archived ?? true).toBe(true);
  });

  it("keeps the chat out of the list saved for the next start", async () => {
    const { hermes, cache } = await listed(row("a", 1), row("b", 2));
    await hermes.archive("a");
    expect(cache.saved.default.filter((c) => !c.archived).map((c) => c.id)).toEqual(["b"]);
  });

  it("doesn't change whether the chat is Active or Settled, and Settle doesn't archive", async () => {
    const { server, hermes, stored } = await listed(row("a", 1, { pinned: true }), row("b", 2));
    await hermes.settle("b");
    await hermes.unsettle("b");
    expect(stored("b").archived).toBe(false);
    await hermes.archive("a");
    expect(patches(server).filter((p) => "archived" in p)).toEqual([{ archived: true, profile: "default" }]);
    expect(stored("a").pinned).toBe(true);
  });

  it("goes to the chat's own profile when the owner switches away meanwhile", async () => {
    const { server, hermes, stored } = await listed(row("a", 1), row("b", 2));
    server.otherProfiles = { work: [row("w", 1)] };
    const answer = hold(server, "PATCH /api/sessions/a", (req) => {
      stored("a").archived = req.body!.archived as boolean;
      return { ok: true };
    });
    const archiving = hermes.archive("a");
    await hermes.switchProfile("work");
    answer();
    expect(await archiving).toBe(true);
    expect(server.restRequests.find((r) => r.method === "PATCH")!.body!.profile).toBe("default");
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["w"]);
  });
});

describe("The archived view", () => {
  it("lists the profile's archived chats, however old, alongside the list", async () => {
    const { server, hermes, shown, archived } = await listed(
      row("a", 1),
      row("x", 3, { archived: true }),
      row("old", 90, { archived: true }),
      row("pin", 2, { pinned: true }),
    );
    await hermes.listArchived(true);
    expect(server.restRequests.some((r) => r.path === "/api/sessions" && r.query.get("archived") === "only")).toBe(true);
    expect(archived()).toEqual(["old", "x"]);
    expect(shown()).toEqual(["a", "pin"]);
    expect(hermes.getSnapshot().archivedListed).toBe(true);
  });

  it("stops reading archived chats when it closes", async () => {
    const { server, hermes, archived } = await listed(row("a", 1), row("x", 3, { archived: true }));
    await hermes.listArchived(true);
    await hermes.listArchived(false);
    const before = server.restRequests.length;
    await hermes.sync();
    expect(server.restRequests.slice(before).some((r) => r.query.get("archived") === "only")).toBe(false);
    expect(archived()).toEqual([]);
  });

  it("shows a chat archived in another Hermes client once the list refreshes", async () => {
    const { hermes, stored, shown, archived } = await listed(row("a", 1), row("b", 2));
    await hermes.listArchived(true);
    stored("a").archived = true;
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
    expect(archived()).toEqual(["a"]);
  });
});

describe("Restoring a chat", () => {
  it("clears the archived flag and puts the chat back in the list where it was", async () => {
    const { server, hermes, chat, stored, shown } = await listed(row("a", 1, { archived: true, pinned: true }), row("b", 2));
    await hermes.listArchived(true);
    expect(await hermes.restore("a")).toBe(true);
    expect(patches(server)).toEqual([{ archived: false, profile: "default" }]);
    expect(stored("a")).toMatchObject({ archived: false, pinned: true });
    expect(shown()).toEqual(["a", "b"]);
    expect(chat("a")!.settled).toBe(false);
    await hermes.listArchived(false);
    expect(shown()).toEqual(["a", "b"]);
  });

  it("keeps a restored chat older than a month in the list", async () => {
    const { hermes, shown } = await listed(row("old", 90, { archived: true }));
    await hermes.listArchived(true);
    await hermes.restore("old");
    await hermes.listArchived(false);
    expect(shown()).toEqual(["old"]);
  });

  it("can be undone straight after archiving, before the archive is written", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    const answer = hold(server, "PATCH /api/sessions/a", (req) => {
      stored("a").archived = req.body!.archived as boolean;
      stored("a").runtime_revision = (stored("a").runtime_revision ?? 0) + 1;
      return { ok: true };
    });
    const archiving = hermes.archive("a");
    await tick();
    const restoring = hermes.restore("a");
    expect(shown()).toEqual(["a", "b"]);
    answer();
    await Promise.all([archiving, restoring]);
    expect(patches(server).map((p) => p.archived)).toEqual([true, false]);
    expect(stored("a").archived).toBe(false);
    expect(shown()).toEqual(["a", "b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });
});

describe("Searching archived chats", () => {
  async function withArchived() {
    const ctx = await listed(row("a", 1, { title: "Backups" }), row("x", 3, { archived: true, title: "Old backups" }));
    ctx.server.transcripts = { a: [{ role: "user", text: "backup now" }], x: [{ role: "user", text: "backup then" }] };
    return ctx;
  }

  it("leaves archived chats out unless the owner asks for them", async () => {
    const { hermes } = await withArchived();
    expect((await hermes.search("backup")).map((f) => f.chatId)).toEqual(["a"]);
    const found = await hermes.search("backup", { archived: true });
    expect(found.map((f) => [f.chatId, !!f.archived])).toEqual([
      ["a", false],
      ["x", true],
    ]);
  });

  it("opens an archived chat found by search without putting it back in the list", async () => {
    const { server, hermes, chat, shown } = await withArchived();
    const [, x] = await hermes.search("backup", { archived: true });
    hermes.reveal(x);
    await hermes.open("x");
    expect(chat("x")!.items.map((i) => i.kind)).toEqual(["user"]);
    expect(chat("x")!.archived).toBe(true);
    expect(shown()).toEqual(["a"]);
    expect(patches(server).some((p) => "archived" in p)).toBe(false);
  });
});

describe("Archiving when another edit lands first", () => {
  it("writes again when another client changed something else, keeping that change", async () => {
    const { server, hermes, stored } = await listed(row("a", 1));
    editLandsAfterRevisionRead(server, "a", () => (stored("a").pinned = true));
    expect(await hermes.archive("a")).toBe(true);
    expect(patches(server).map((p) => p.archived)).toEqual([true, true]);
    expect(stored("a")).toMatchObject({ archived: true, pinned: true });
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("doesn't write again when another client archived it first", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    editLandsAfterRevisionRead(server, "a", () => (stored("a").archived = true));
    expect(await hermes.archive("a")).toBe(true);
    expect(patches(server)).toHaveLength(1);
    expect(shown()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("doesn't overwrite an archive another client made after the owner's restore went in", async () => {
    // The owner restores here; another client archives the chat again straight after. That newer change stands.
    const { server, hermes, stored, shown, archived } = await listed(row("a", 1, { archived: true }));
    await hermes.listArchived(true);
    server.rest["PATCH /api/sessions/a"] = () => {
      delete server.rest["PATCH /api/sessions/a"];
      stored("a").archived = false;
      stored("a").archived = true; // the other client's archive, after this one
      return { ok: true };
    };
    expect(await hermes.restore("a")).toBe(false);
    expect(stored("a").archived).toBe(true);
    expect(patches(server)).toHaveLength(1);
    expect(archived()).toEqual(["a"]);
    expect(shown()).toEqual([]);
    expect(hermes.getSnapshot().syncError).toMatch(/^Couldn't restore "Chat a": another Hermes client changed it\. It's shown as Hermes has it now\.$/);
  });

  it("shows the chat as Hermes has it, and why, when edits keep landing first", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    // Every revision read is overtaken by another client's rename before the write lands.
    server.rest["GET /api/sessions/a/mutation-snapshot"] = () => {
      const revision = stored("a").runtime_revision ?? 0;
      stored("a").runtime_revision = revision + 1;
      stored("a").title = "Renamed elsewhere";
      return { session_id: "a", exists: true, runtime_revision: revision, runtime_generation: 0 };
    };
    expect(await hermes.archive("a")).toBe(false);
    expect(stored("a").archived).toBe(false);
    expect(shown()).toEqual(["a", "b"]);
    expect(patches(server)).toHaveLength(2);
    expect(hermes.getSnapshot().syncError).toBe(
      'Couldn\'t archive "Chat a": The dashboard answered 409: {"detail":"revision_conflict"}. It\'s shown as Hermes has it now.',
    );
  });

  it("drops the chat when another client deleted it meanwhile", async () => {
    const { server, hermes, chat } = await listed(row("a", 1), row("b", 2));
    editLandsAfterRevisionRead(server, "a", () => (server.sessions = server.sessions.filter((s) => s.id !== "a")));
    expect(await hermes.archive("a")).toBe(false);
    expect(chat("a")).toBeUndefined();
    expect(hermes.getSnapshot().syncError).toBe('"Chat a" is no longer in Hermes: another Hermes client deleted it.');
  });
});

describe("Archiving when Hermes answers 404 (#486)", () => {
  it("keeps the chat, and says nothing of a delete, when a gateway in front of Hermes answers 404", async () => {
    const { server, hermes, chat } = await listed(row("a", 1), row("b", 2));
    const gateway = () => {
      throw new RestError(404, '{"detail":"Not Found"}');
    };
    server.rest["PATCH /api/sessions/a"] = gateway;
    server.rest["GET /api/sessions/a"] = gateway;
    expect(await hermes.archive("a")).toBe(false);
    expect(chat("a")).toBeDefined();
    expect(hermes.getSnapshot().syncError).not.toContain("deleted");
  });

  it("keeps a chat started here that Hermes hasn't stored yet", async () => {
    const { server, hermes, chat } = await listed(row("b", 2));
    const id = await hermes.newChat();
    expect(server.sessions.some((s) => s.id === id)).toBe(false);
    expect(await hermes.archive(id)).toBe(false);
    expect(chat(id)).toBeDefined();
    expect(hermes.getSnapshot().syncError).not.toContain("deleted");
  });
});

describe("Archiving when the outcome is uncertain", () => {
  it("counts an archive that went in though its answer was lost", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    server.rest["PATCH /api/sessions/a"] = () => {
      stored("a").archived = true;
      throw new Error("Connection closed: closed by the server (1006 )");
    };
    expect(await hermes.archive("a")).toBe(true);
    expect(shown()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("puts the chat back, with the reason, when the read-back shows the archive didn't go in", async () => {
    const { server, hermes, shown } = await listed(row("a", 1), row("b", 2));
    server.rest["PATCH /api/sessions/a"] = () => {
      throw new Error("Connection closed: closed by the server (1006 )");
    };
    expect(await hermes.archive("a")).toBe(false);
    expect(shown()).toEqual(["a", "b"]);
    expect(hermes.getSnapshot().syncError).toBe(
      'Couldn\'t archive "Chat a": Connection closed: closed by the server (1006 ). It\'s shown as Hermes has it now.',
    );
  });

  it("claims neither success nor rollback until the chat can be read back, then shows Hermes's answer", async () => {
    const { server, hermes, shown } = await listed(row("a", 1), row("b", 2));
    server.rest["PATCH /api/sessions/a"] = () => {
      throw new Error("Connection closed: closed by the server (1006 )");
    };
    server.rest["GET /api/sessions/a"] = () => {
      throw new Error("Not connected to Hermes.");
    };
    expect(await hermes.archive("a")).toBe(false);
    expect(shown()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBe(
      'Couldn\'t tell whether "Chat a" was archived: Not connected to Hermes. It\'s checked again on the next refresh.',
    );
    // Still unknown: a list read can't settle it, and the chat stays where the owner put it.
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
    delete server.rest["PATCH /api/sessions/a"];
    delete server.rest["GET /api/sessions/a"];
    await hermes.sync();
    expect(shown()).toEqual(["a", "b"]);
    expect(patches(server)).toHaveLength(1);
  });

  it("keeps an uncertain archive that did go in once the refresh reads it back", async () => {
    const { server, hermes, stored, shown } = await listed(row("a", 1), row("b", 2));
    server.rest["PATCH /api/sessions/a"] = () => {
      stored("a").archived = true;
      throw new Error("Connection closed: closed by the server (1006 )");
    };
    server.rest["GET /api/sessions/a"] = () => {
      throw new Error("Not connected to Hermes.");
    };
    await hermes.archive("a");
    delete server.rest["GET /api/sessions/a"];
    await hermes.sync();
    expect(shown()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });
});

describe("Archiving and running replies", () => {
  async function running() {
    const ctx = await listed(row("b", 2));
    const id = await ctx.hermes.newChat();
    await ctx.hermes.send(id, "Clean up the logs");
    ctx.server.event(ctx.server.runtimeIdOf(id)!, "message.start");
    return { ...ctx, id };
  }

  it("doesn't archive a chat while its reply is running, and doesn't stop the reply", async () => {
    const { server, hermes, chat, shown, id } = await running();
    expect(await hermes.archive(id)).toBe(false);
    expect(patches(server).some((p) => "archived" in p)).toBe(false);
    expect(interrupts(server)).toEqual([]);
    expect(chat(id)!.running).toBe(true);
    expect(shown()).toContain(id);
  });

  it("leaves another chat's reply running while one is archived", async () => {
    const { server, hermes, chat, id } = await running();
    expect(await hermes.archive("b")).toBe(true);
    server.event(server.runtimeIdOf(id)!, "message.delta", { text: "Done." });
    expect(interrupts(server)).toEqual([]);
    expect(chat(id)!.running).toBe(true);
    expect(chat(id)!.items.at(-1)).toMatchObject({ kind: "assistant", text: "Done." });
  });

  it("keeps a running chat on screen when another client archives it", async () => {
    const { server, hermes, chat, stored, id } = await running();
    stored(id).archived = true;
    await hermes.sync();
    server.event(server.runtimeIdOf(id)!, "message.delta", { text: "Still going." });
    expect(chat(id)!.running).toBe(true);
    expect(chat(id)!.items.at(-1)).toMatchObject({ kind: "assistant", text: "Still going." });
    expect(interrupts(server)).toEqual([]);
  });

  it("doesn't restore a chat while its reply is running", async () => {
    const { server, hermes, id } = await running();
    const sid = server.runtimeIdOf(id)!;
    server.event(sid, "message.complete", { text: "ok" });
    await hermes.archive(id);
    // Another client starts a turn in the archived chat, which this connection still has resumed.
    server.event(sid, "message.start");
    expect(await hermes.restore(id)).toBe(false);
    expect(patches(server).some((p) => p.archived === false)).toBe(false);
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)!.archived).toBe(true);
  });
});
