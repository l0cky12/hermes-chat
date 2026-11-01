import { describe, expect, it } from "vitest";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import type { Chat } from "./model";
import { type ChatCache, connect } from "./transport";

function memoryCache(profile?: string): ChatCache & { saved: Record<string, Chat[]>; profile?: string } {
  const cache = {
    saved: {} as Record<string, Chat[]>,
    profile,
    load: (p: string) => cache.saved[p] ?? [],
    save: (p: string, chats: Chat[]) => void (cache.saved[p] = chats),
    lastProfile: () => cache.profile,
    rememberProfile: (p: string) => void (cache.profile = p),
  };
  return cache;
}

/** Signed in to a server with a `work` profile beside `default`. */
async function signedIn(cache: ChatCache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [row("home-1", 1, { pinned: true })];
  server.otherProfiles = { work: [row("work-1", 1, { pinned: true }), row("work-2", 2)] };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const ids = () => hermes.getSnapshot().chats.map((c) => c.id).sort();
  return { server, hermes, ids };
}

const sessionLists = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "GET" && r.path === "/api/sessions").map((r) => r.query.get("profile"));

/** Holds back the server's answers to `GET /api/sessions` until the returned function is called. */
function holdLists(server: FakeHermes) {
  const list = server.rest["GET /api/sessions"];
  const held: (() => void)[] = [];
  server.rest["GET /api/sessions"] = (req: RestRequest) => new Promise((resolve) => held.push(() => resolve(list(req))));
  return () => {
    server.rest["GET /api/sessions"] = list;
    held.splice(0).forEach((release) => release());
  };
}

describe("Profiles", () => {
  it("lists the server's profiles through dashboard REST", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { aegis: [], work: [] };
    expect(await hermes.profiles()).toEqual(["default", "aegis", "work"]);
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/profiles" });
  });

  it("starts in the default profile the first time", async () => {
    const { server, hermes, ids } = await signedIn();
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(server.wsProfiles).toEqual(["default"]);
    expect(ids()).toEqual(["home-1"]);
  });

  it("switches to another profile's chats, over a socket opened for it", async () => {
    const { server, hermes, ids } = await signedIn();
    await hermes.switchProfile("work");
    await hermes.idle();

    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" });
    expect(server.wsProfiles).toEqual(["default", "work"]);
    expect(sessionLists(server).at(-1)).toBe("work");
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("starts, opens and replies to chats in the profile it shows", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("work");
    await hermes.idle();

    const id = await hermes.newChat();
    await hermes.send(id, "hello work");
    await hermes.open("work-2");
    await hermes.idle();
    expect(server.last("session.create")!.params).toMatchObject({ profile: "work" });
    expect(server.last("prompt.submit")!.params).toMatchObject({ profile: "work", text: "hello work" });
    expect(server.last("session.resume")!.params).toMatchObject({ session_id: "work-2", profile: "work" });
    expect(server.store("work")!.find((s) => s.id === id)?.pinned).toBe(true);
    expect(server.store("work")!.find((s) => s.id === "work-2")?.last_read_at).not.toBeNull();
  });

  it("shows the profile's last synced list at once, before the new socket is open", async () => {
    const cache = memoryCache();
    cache.saved.work = [{ id: "work-1", title: "Cached", source: "app", settled: false, updatedAt: 0, items: [] }];
    const { server, hermes } = await signedIn(cache);
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";

    const switching = hermes.switchProfile("work");
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", chats: [{ id: "work-1", title: "Cached" }] });
    await switching;
    expect(hermes.getSnapshot().status).not.toBe("connected");
    await hermes.close();
  });

  it("keeps a slow list of the old profile from replacing the new one", async () => {
    const { server, hermes, ids } = await signedIn();
    const release = holdLists(server);
    const oldSync = hermes.sync();
    await hermes.switchProfile("work");
    release();
    await oldSync;
    await hermes.idle();
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("still settles a chat in the old profile when the owner switches straight after", async () => {
    const { server, hermes } = await signedIn();
    const settling = hermes.settle("home-1");
    await hermes.switchProfile("work");
    await settling;
    await hermes.idle();
    const pins = server.restRequests.filter((r) => r.method === "PATCH" && "pinned" in (r.body ?? {}));
    expect(pins.map((r) => r.body)).toEqual([{ pinned: false, profile: "default" }]);
    expect(server.sessions[0].pinned).toBe(false);
  });

  it("does nothing when the owner picks the profile already shown", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("default");
    expect(server.opened).toBe(1);
  });

  it("switches while reconnecting, and connects to the new profile", async () => {
    const { server, hermes, ids } = await signedIn();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    server.drop();
    await hermes.reconnect();
    server.refuse = undefined;

    await hermes.switchProfile("work");
    await hermes.idle();
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" });
    expect(server.wsProfiles.at(-1)).toBe("work");
    expect(ids()).toEqual(["work-1", "work-2"]);
    await hermes.close();
  });

  it("remembers the last profile for the next sign-in", async () => {
    const cache = memoryCache();
    const first = await signedIn(cache);
    await first.hermes.switchProfile("work");
    await first.hermes.close();

    const { server, hermes, ids } = await signedIn(cache);
    expect(hermes.getSnapshot().profile).toBe("work");
    expect(server.wsProfiles).toEqual(["work"]);
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("says so when the remembered profile is gone from the server", async () => {
    const { hermes } = await signedIn(memoryCache("retired"));
    expect(hermes.getSnapshot()).toMatchObject({ profile: "retired", chats: [] });
    expect(hermes.getSnapshot().syncError).toMatch(/Couldn't refresh the chat list: .*Profile 'retired' not found/);
  });
});
