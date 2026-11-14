// What the transport tells path links (ADR 0163), against FakeHermes: what is at a path where tools run, and the
// folder each chat works in, which a relative path in its replies is relative to.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, readSaved, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";
import { resolvePath, type ServerPath } from "./paths";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  vi.unstubAllGlobals();
});

async function signedIn(server: FakeHermes) {
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  return hermes;
}

const at = (path: string) => resolvePath(path, undefined) as ServerPath;
const folderOf = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)?.folder;

describe("What is at a path on the server", () => {
  function server() {
    const s = new FakeHermes();
    s.serverDirs.add("/srv/app");
    s.serverFiles = { "/srv/app/main.py": "print(1)\n" };
    return s;
  }

  it("is a folder, a file or nothing, as a listing of it says", async () => {
    const s = server();
    const hermes = await signedIn(s);
    expect(await hermes.pathKind(at("/srv/app"))).toBe("folder");
    expect(await hermes.pathKind(at("/srv/app/main.py"))).toBe("file");
    expect(await hermes.pathKind(at("/srv/app/gone.py"))).toBe("missing");
    const asked = s.restRequests.filter((r) => r.path === "/api/fs/list" && r.query.get("path")?.startsWith("/srv/app"));
    expect(asked.map((r) => `${r.method} ${r.query.get("path")} ${r.query.get("profile")}`)).toEqual([
      "GET /srv/app default",
      "GET /srv/app/main.py default",
      "GET /srv/app/gone.py default",
    ]);
  });

  it("is unknown, never an error, when the server can't list or can't be reached", async () => {
    const old = server();
    old.asOlderHermes();
    expect(await (await signedIn(old)).pathKind(at("/srv/app"))).toBe("unknown");
    const hermes = await signedIn(server());
    await hermes.close();
    expect(await hermes.pathKind(at("/srv/app"))).toBe("unknown");
  });
});

describe("The folder a chat works in", () => {
  it("is the one its row in the chat list names", async () => {
    const s = new FakeHermes();
    s.sessions = [row("in-app", 1, { pinned: true, cwd: "/srv/app" }), row("nowhere", 2, { pinned: true })];
    const hermes = await signedIn(s);
    expect(folderOf(hermes, "in-app")).toBe("/srv/app");
    expect(folderOf(hermes, "nowhere")).toBeUndefined();
  });

  it("is the one Hermes starts a new chat in, and follows the chat when it is moved", async () => {
    const s = new FakeHermes();
    s.serverDirs.add("/srv/app");
    s.serverDirs.add("/srv/other");
    const hermes = await signedIn(s);
    const started = await hermes.newChat(undefined, { folder: "/srv/app" });
    expect(folderOf(hermes, started)).toBe("/srv/app");
    await hermes.setFolder(started, "/srv/other");
    expect(folderOf(hermes, started)).toBe("/srv/other");
    const plain = await hermes.newChat();
    expect(folderOf(hermes, plain)).toBe(s.hermesHome);
  });

  it("is kept in the list saved on this computer, so a relative path still links while offline", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const here = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
    const s = new FakeHermes();
    s.sessions = [row("in-app", 1, { pinned: true, cwd: "/srv/app" })];
    const hermes = await connect(s.openPipe, undefined, localChatCache(here));
    running.push(hermes);
    await hermes.sync();
    await hermes.close();
    s.refuse = "Can't reach the Hermes dashboard: network is unreachable";
    const offline = readSaved(s.openPipe, s.refuse, localChatCache(here))!;
    running.push(offline);
    expect(folderOf(offline, "in-app")).toBe("/srv/app");
  });
});
