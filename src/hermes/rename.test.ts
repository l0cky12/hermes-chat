import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { connect, RenameConflict } from "./transport";

async function listed(...rows: ReturnType<typeof row>[]) {
  const server = new FakeHermes();
  server.sessions = rows;
  const cache = memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const title = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!.title;
  const stored = (id: string) => server.sessions.find((s) => s.id === id)!;
  return { server, hermes, cache, title, stored };
}

/** Holds back the server's answers to `METHOD /path` until the returned function is called. */
function hold(server: FakeHermes, key: string) {
  const held: (() => void)[] = [];
  const answer = server.rest[key];
  server.rest[key] = (req: RestRequest) => {
    const body = answer(req);
    return new Promise((resolve) => held.push(() => resolve(body)));
  };
  return () => {
    server.rest[key] = answer;
    held.splice(0).forEach((go) => go());
  };
}

const patches = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PATCH");

describe("Renaming a chat", () => {
  it("renames a chat started in this app, which Hermes stores with a source it lets clients edit", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const id = await hermes.newChat();
    await hermes.send(id, "hello");
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Hi!", status: "complete" });
    await hermes.idle();
    await hermes.sync();

    expect(await hermes.rename(id, "Greeting", hermes.getSnapshot().chats.find((c) => c.id === id)!.title)).toBe("Greeting");
    expect(server.sessions.find((s) => s.id === id)).toMatchObject({ source: "gui", title: "Greeting" });
  });

  it("saves the title with a request id and the current revision, and shows the title the server reads back", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name", runtime_revision: 3 }));
    expect(await hermes.rename("a", "  Backup fix  ", "Old name")).toBe("Backup fix");
    const [patch] = patches(server);
    expect(editFlags(patch.body)).toEqual({ title: "Backup fix", profile: "default" });
    expect(patch.body!.expected_revision).toBe(3);
    expect(typeof patch.body!.request_id).toBe("string");
    expect(stored("a").title).toBe("Backup fix");
    expect(title("a")).toBe("Backup fix");
  });

  it("refuses an empty title without asking Hermes", async () => {
    const { server, hermes, title } = await listed(row("a", 1, { title: "Old name" }));
    await expect(hermes.rename("a", "   ", "Old name")).rejects.toThrow("A chat needs a title.");
    expect(server.restRequests.filter((r) => r.method !== "GET" || (r.path !== "/api/sessions" && !r.path.startsWith("/api/plugins/kanban/")))).toEqual([]);
    expect(title("a")).toBe("Old name");
  });

  it("sends nothing when the title is unchanged, as when the owner cancels", async () => {
    const { server, hermes } = await listed(row("a", 1, { title: "Old name" }));
    expect(await hermes.rename("a", "Old name ", "Old name")).toBe("Old name");
    expect(patches(server)).toEqual([]);
  });

  it("keeps the old title and says why when Hermes refuses the new one", async () => {
    const { hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }), row("b", 2, { title: "Taken" }));
    await expect(hermes.rename("a", "Taken", "Old name")).rejects.toThrow("already in use");
    expect(stored("a").title).toBe("Old name");
    expect(title("a")).toBe("Old name");
  });

  it("doesn't overwrite a rename made elsewhere while the owner was typing, and shows that title instead", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }));
    stored("a").title = "Renamed on the phone";
    stored("a").runtime_revision = 1;
    const conflict = await hermes.rename("a", "Backup fix", "Old name").catch((e) => e);
    expect(conflict).toBeInstanceOf(RenameConflict);
    expect(conflict.title).toBe("Renamed on the phone");
    expect(patches(server)).toEqual([]);
    expect(title("a")).toBe("Renamed on the phone");

    // Saving again, from the title now shown, is the owner's deliberate choice.
    expect(await hermes.rename("a", "Backup fix", conflict.title)).toBe("Backup fix");
    expect(stored("a").title).toBe("Backup fix");
  });

  it("stops at a revision conflict instead of sending again, and shows the server's title", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }));
    const key = "GET /api/sessions/a";
    server.rest[key] = () => {
      // Another client renames the chat just after this app has read the title, before its write.
      delete server.rest[key];
      const before = { ...stored("a") };
      Object.assign(stored("a"), { title: "Renamed on the phone", runtime_revision: 1 });
      return before;
    };
    const conflict = await hermes.rename("a", "Backup fix", "Old name").catch((e) => e);
    expect(conflict).toBeInstanceOf(RenameConflict);
    expect(conflict.title).toBe("Renamed on the phone");
    expect(patches(server)).toHaveLength(1);
    expect(stored("a").title).toBe("Renamed on the phone");
    expect(title("a")).toBe("Renamed on the phone");
  });

  it("counts a rename whose answer was lost as saved when the server reads it back", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }));
    server.rest["PATCH /api/sessions/a"] = () => {
      Object.assign(stored("a"), { title: "Backup fix", runtime_revision: 1 });
      throw new Error("error sending request: connection reset");
    };
    expect(await hermes.rename("a", "Backup fix", "Old name")).toBe("Backup fix");
    expect(title("a")).toBe("Backup fix");
  });

  it("keeps the old title when the rename was lost on the way", async () => {
    const { server, hermes, title } = await listed(row("a", 1, { title: "Old name" }));
    server.rest["PATCH /api/sessions/a"] = () => {
      throw new Error("error sending request: connection reset");
    };
    await expect(hermes.rename("a", "Backup fix", "Old name")).rejects.toThrow("connection reset");
    expect(title("a")).toBe("Old name");
  });

  it("says it can't tell whether the rename was saved when nothing can be read back, and a retry settles it", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }));
    server.rest["PATCH /api/sessions/a"] = () => {
      Object.assign(stored("a"), { title: "Backup fix", runtime_revision: 1 });
      server.rest["GET /api/sessions/a"] = () => {
        throw new Error("error sending request: connection reset");
      };
      throw new Error("error sending request: connection reset");
    };
    await expect(hermes.rename("a", "Backup fix", "Old name")).rejects.toThrow("Couldn't tell whether Hermes saved the new title");
    expect(title("a")).toBe("Old name");

    delete server.rest["PATCH /api/sessions/a"];
    delete server.rest["GET /api/sessions/a"];
    // The first try did land, so trying again finds the title already saved and doesn't write it twice.
    expect(await hermes.rename("a", "Backup fix", "Old name")).toBe("Backup fix");
    expect(patches(server)).toHaveLength(1);
    expect(title("a")).toBe("Backup fix");
  });

  it("shows the title as Hermes stored it, not as typed", async () => {
    const { server, hermes, title, stored } = await listed(row("a", 1, { title: "Old name" }));
    server.rest["PATCH /api/sessions/a"] = (req) => {
      Object.assign(stored("a"), { title: String(req.body!.title).replace(/\s+/g, " "), runtime_revision: 1 });
      return { ok: true };
    };
    expect(await hermes.rename("a", "Backup   fix", "Old name")).toBe("Backup fix");
    expect(title("a")).toBe("Backup fix");
  });

  it("keeps the new title when a list refresh read before the rename lands after it", async () => {
    const { server, hermes, title } = await listed(row("a", 1, { title: "Old name" }));
    const answer = hold(server, "GET /api/sessions");
    const syncing = hermes.sync();
    await hermes.rename("a", "Backup fix", "Old name");
    answer();
    await syncing;
    expect(title("a")).toBe("Backup fix");
    await hermes.sync();
    expect(title("a")).toBe("Backup fix");
  });

  it("shows the renamed title in search results too, even before the search index has caught up", async () => {
    const { server, hermes, stored } = await listed(row("a", 1, { title: "Old name" }));
    server.transcripts.a = [{ role: "user", text: "restic backup failing" }];
    await hermes.rename("a", "Backup fix", "Old name");
    const search = server.rest["GET /api/sessions/search"];
    server.rest["GET /api/sessions/search"] = (req) => {
      const res = search(req) as { results: { title: string }[] };
      return { results: res.results.map((r) => ({ ...r, title: "Old name" })) };
    };
    const [found] = await hermes.search("restic");
    expect(found).toMatchObject({ chatId: "a", title: "Backup fix" });
    expect(stored("a").title).toBe("Backup fix");
  });
});
