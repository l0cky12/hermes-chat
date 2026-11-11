// A project's context files on the server (projectContextFiles.ts, ADR 0135), against a fake Hermes whose disks change
// as the managed-files and agent fs routes change them (fakeProjectContext.ts), and whose requests show what was read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import type { ContextState } from "./projectContext";
import { CONTEXT_LEDGER_KEY, ContextExistsError, contextLedger, type ContextProject } from "./projectContextFiles";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const DIR = "/srv/budget/context";
const budget: ContextProject = { id: "p_budget", name: "Budget Tracker", folders: [{ path: "/srv/budget", primary: true }] };
const bare: ContextProject = { id: "p_bare", name: "Reading list", folders: [] };

async function signedIn(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.managedFiles.nodes = { "/srv/budget": { dir: true } };
  server.serverDirs = new Set(["/srv", "/srv/budget"]);
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  return { server, hermes, files: hermes.contextFiles };
}

type Ready = Extract<ContextState, { kind: "ready" }>;
const ready = (s: ContextState): Ready => {
  if (s.kind !== "ready") throw new Error(`the card is ${s.kind}: ${JSON.stringify(s)}`);
  return s;
};
const shown = (s: ContextState) => ready(s).files.map((f) => [f.name, f.size, f.kind]);

describe("reading a project's context folder", () => {
  it("lists what is in <main folder>/context, whoever put it there, and leaves out folders and hidden files", async () => {
    const { server, files } = await signedIn((s) => {
      s.managedFiles.nodes[`${DIR}/notes.md`] = { text: "Rent is 900.\n" };
      s.managedFiles.nodes[`${DIR}/logo.png`] = { bytes: "\x89PNG\0\0", mime: "image/png" };
      s.managedFiles.nodes[`${DIR}/.DS_Store`] = { text: "x" };
      s.managedFiles.nodes[`${DIR}/drafts/old.md`] = { text: "x" };
    });
    const first = ready(await files.read("default", budget));
    expect(first.dir).toBe(DIR);
    expect(first.exists).toBe(true);
    expect(shown(first)).toEqual([
      ["logo.png", 6, "binary"],
      ["notes.md", 13, "text"],
    ]);
    expect(first.capacity).toEqual({ used: 4, limit: 100_000, mode: "full" });
    expect(first.writes).toBe("all");

    server.managedFiles.nodes[`${DIR}/plan.txt`] = { text: "Save more." };
    expect(shown(await files.read("default", budget)).map(([name]) => name)).toEqual(["logo.png", "notes.md", "plan.txt"]);
  });

  it("is ready and empty before the folder is there", async () => {
    const { files } = await signedIn();
    expect(await files.read("default", budget)).toMatchObject({ kind: "ready", dir: DIR, exists: false, files: [], gitNote: false });
  });

  it("refuses a context folder that is a link out of the main folder", async () => {
    const { server, files } = await signedIn((s) => {
      s.managedFiles.nodes[DIR] = { link: "/etc/secrets" };
      s.managedFiles.nodes["/etc/secrets/key.txt"] = { text: "hunter2" };
    });
    const state = await files.read("default", budget);
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toContain("/srv/budget/context is a link to /etc/secrets, outside the project's main folder");
    expect(server.context.reads).toEqual([]);
  });

  it("says where a project with no folder would get one, from the profile's folder as Hermes reports it", async () => {
    const { files } = await signedIn();
    expect(await files.read("default", bare)).toEqual({ kind: "noFolder", writes: "all", creates: "/home/liam/.hermes/projects/reading-list" });
  });

  it("counts a PDF's extracted text, and reads a file's text again only once the file changes", async () => {
    const { server, files } = await signedIn((s) => {
      s.managedFiles.nodes[`${DIR}/brief.pdf`] = { bytes: "%PDF-1.7\0\0", mime: "application/pdf", mtime: 1 };
      s.managedFiles.nodes[`${DIR}/scan.pdf`] = { bytes: "%PDF-1.7\0\0", mime: "application/pdf", mtime: 1 };
      s.context.extracted[`${DIR}/brief.pdf`] = "Sixteen bytes!!!";
    });
    const state = ready(await files.read("default", budget, { window: 64 }));
    expect(state.files.map((f) => [f.name, f.kind, f.tokens])).toEqual([
      ["brief.pdf", "pdf", 4],
      ["scan.pdf", "pdf", undefined],
    ]);
    expect(state.capacity).toEqual({ used: 4, limit: 32, mode: "full" });
    await files.read("default", budget);
    expect(server.context.reads).toEqual([`${DIR}/brief.pdf`, `${DIR}/scan.pdf`]);

    server.managedFiles.nodes[`${DIR}/brief.pdf`] = { bytes: "%PDF-1.7\0\0", mime: "application/pdf", mtime: 2 };
    server.context.extracted[`${DIR}/brief.pdf`] = "x".repeat(200);
    expect(ready(await files.read("default", budget, { window: 64 })).capacity).toEqual({ used: 50, limit: 32, mode: "list" });
    expect(server.context.reads).toEqual([`${DIR}/brief.pdf`, `${DIR}/scan.pdf`, `${DIR}/brief.pdf`]);
  });

  it("keeps context/ out of the main folder's Git repository once, and says so", async () => {
    const { server, files } = await signedIn((s) => {
      s.repos = [[{ path: "/srv/budget", branch: "main" }]];
      s.managedFiles.nodes[`${DIR}/notes.md`] = { text: "x" };
    });
    expect(ready(await files.read("default", budget, { git: true })).gitNote).toBe(true);
    expect(ready(await files.read("default", budget, { git: true })).gitNote).toBe(true);
    expect([...server.context.excluded]).toEqual(["/srv/budget"]);
    server.context.excluded.clear();
    await files.read("default", budget);
    expect(server.context.excluded.size).toBe(0);
  });

  it("says what the server lacks instead of listing", async () => {
    const { hermes, files } = await signedIn((s) => s.asOlderHermes());
    await hermes.sync();
    await vi.waitFor(() => expect(hermes.capabilities.get("serverFiles").state).toBe("unsupported"), 6000);
    const state = await files.read("default", budget);
    expect(state).toEqual({ kind: "unsupported", missing: [expect.stringContaining("Server files: The dashboard's managed-files routes")] });
  });

  it("turns a failed read into the card's failed state", async () => {
    const { files } = await signedIn((s) => delete s.managedFiles.nodes["/srv/budget"]);
    const state = await files.read("default", budget);
    expect(state.kind === "failed" && state.message).toContain("Couldn't open the project's main folder /srv/budget");
  });
});

describe("changing a project's context files", () => {
  const local = (s: FakeHermes, name: string, bytes: string) => {
    s.files[`/home/me/${name}`] = bytes;
    return { path: `/home/me/${name}`, name, size: bytes.length };
  };

  it("makes <profile folder>/projects/<slug>/context for a project with no folder, and adds the folder to the project", async () => {
    const { server, files } = await signedIn();
    const state = await files.read("default", bare);
    if (state.kind !== "noFolder") throw new Error(state.kind);
    const added: string[] = [];
    const dir = await files.folderFor(state, async (path) => void added.push(path));
    expect(dir).toBe("/home/liam/.hermes/projects/reading-list/context");
    expect(server.context.made).toEqual([dir]);
    expect(added).toEqual(["/home/liam/.hermes/projects/reading-list"]);
  });

  it("makes the context folder in a main folder that has none", async () => {
    const { server, files } = await signedIn();
    expect(await files.folderFor(ready(await files.read("default", budget)), async () => {})).toBe(DIR);
    expect(server.context.made).toEqual([DIR]);
  });

  it("adds a file, replaces one only when told to, and removes one, on the server's disk", async () => {
    const { server, files } = await signedIn();
    const notes = local(server, "notes.md", "Rent is 900.");
    await files.upload("default", DIR, "all", notes, false);
    expect(server.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ bytes: "Rent is 900." });

    const newer = local(server, "notes.md", "Rent is 950 now.");
    await expect(files.upload("default", DIR, "all", newer, false)).rejects.toBeInstanceOf(ContextExistsError);
    expect(server.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ bytes: "Rent is 900." });
    await files.upload("default", DIR, "all", newer, true);
    expect(server.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ bytes: "Rent is 950 now." });
    expect(server.context.writes).toEqual([
      { path: `${DIR}/notes.md`, overwrite: false },
      { path: `${DIR}/notes.md`, overwrite: true },
    ]);

    const [file] = ready(await files.read("default", budget)).files;
    await files.remove("default", DIR, file);
    expect(server.managedFiles.nodes[`${DIR}/notes.md`]).toBeUndefined();
    expect(ready(await files.read("default", budget)).files).toEqual([]);
  });

  it("saves text content as a file in the folder", async () => {
    const { server, files } = await signedIn();
    await files.addText("default", DIR, "all", "Style guide.md", "Write plainly. Café.", false);
    expect(shown(await files.read("default", budget))).toEqual([["Style guide.md", 21, "text"]]);
    await expect(files.addText("default", DIR, "all", "Style guide.md", "Other", false)).rejects.toBeInstanceOf(ContextExistsError);
    expect(server.context.writes).toHaveLength(1);
  });

  it("doesn't count a file as added unless a fresh listing shows it at the size sent", async () => {
    const { server, files } = await signedIn((s) => (s.context.shortBy = 3));
    await expect(files.upload("default", DIR, "all", local(server, "notes.md", "Rent is 900."), false)).rejects.toThrow(/has it at another size/);
  });

  it("counts a file already gone as removed, and one still listed as not", async () => {
    const { server, files } = await signedIn((s) => (s.managedFiles.nodes[`${DIR}/notes.md`] = { text: "x" }));
    const [file] = ready(await files.read("default", budget)).files;
    delete server.managedFiles.nodes[`${DIR}/notes.md`];
    await expect(files.remove("default", DIR, file)).resolves.toBeUndefined();
    await expect(files.remove("default", DIR, { ...file, path: "/etc/passwd" })).rejects.toThrow(/isn't in/);
  });

  it("doesn't count a file as removed when the folder can't be listed to check", async () => {
    const { server, files } = await signedIn((s) => (s.managedFiles.nodes[`${DIR}/notes.md`] = { text: "x" }));
    const [file] = ready(await files.read("default", budget)).files;
    delete server.managedFiles.nodes[`${DIR}/notes.md`];
    server.rest["GET /api/files"] = () => {
      throw new RestError(500, "listing failed");
    };
    await expect(files.remove("default", DIR, file)).rejects.toThrow(/Couldn't remove notes.md: .*404.*, and the folder couldn't be listed to check/);
  });
});

describe("a profile whose tools run over SSH", () => {
  const ssh = (s: FakeHermes) => {
    s.terminalBackend.default = "ssh";
    s.serverDirs = new Set(["/srv", "/srv/budget", DIR]);
    s.serverFiles[`${DIR}/notes.md`] = "Rent is 900.";
    s.serverFiles[`${DIR}/logo.png`] = "\x89PNG\0\0";
  };

  it("lists the folder on the SSH machine, with the sizes Hermes reports", async () => {
    const { files } = await signedIn(ssh);
    const state = ready(await files.read("default", budget));
    expect(state.writes).toBe("text-only");
    expect(state.files.map((f) => [f.name, f.size, f.kind, f.tokens])).toEqual([
      ["logo.png", 7, "binary", undefined],
      ["notes.md", 12, "text", 3],
    ]);
  });

  it("puts a text file there, and refuses a binary one with the stated message", async () => {
    const { server, files } = await signedIn(ssh);
    server.files["/home/me/plan.md"] = "Save more.";
    server.files["/home/me/photo.jpg"] = "\xff\xd8\0\0";
    await files.upload("default", DIR, "text-only", { path: "/home/me/plan.md", name: "plan.md", size: 10 }, false);
    expect(server.serverFiles[`${DIR}/plan.md`]).toBe("Save more.");
    expect(server.context.writes).toEqual([{ path: `${DIR}/plan.md`, overwrite: false, ssh: "default" }]);
    expect(server.managedFiles.nodes[`${DIR}/plan.md`]).toBeUndefined();
    await expect(files.upload("default", DIR, "text-only", { path: "/home/me/photo.jpg", name: "photo.jpg", size: 4 }, false)).rejects.toThrow(
      "photo.jpg: can't add this file to a project on an SSH profile yet",
    );
  });

  it("counts a text file past the 512 KiB read-text sends as written, and lists it by path", async () => {
    const { server, files } = await signedIn(ssh);
    const long = "a".repeat(600 * 1024);
    server.files["/home/me/long.md"] = long;
    await files.upload("default", DIR, "text-only", { path: "/home/me/long.md", name: "long.md", size: long.length }, false);
    const state = ready(await files.read("default", budget));
    const listed = state.files.find((f) => f.name === "long.md");
    expect(listed?.size).toBe(600 * 1024);
    expect(listed && "tokens" in listed).toBe(false);
  });

  it("can't make a folder there, and says so", async () => {
    const { files } = await signedIn((s) => {
      ssh(s);
      s.serverDirs.delete(DIR);
      s.serverFiles = {};
    });
    const state = ready(await files.read("default", budget));
    expect(state.exists).toBe(false);
    await expect(files.folderFor(state, async () => {})).rejects.toThrow(/Make the folder \/srv\/budget\/context on the SSH machine first/);
    const none = await files.read("default", bare);
    expect(none).toEqual({ kind: "noFolder", writes: "text-only" });
  });
});

describe("the ledger of what each chat was told", () => {
  it("keeps each chat's entry for each project, for one connection and profile, across restarts", () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    const entry = { mode: "full" as const, files: { "/c/a.md": { version: "1:2", text: true } } };
    contextLedger(storage).set("scope", "chat", "p1", entry);
    const again = contextLedger(storage);
    expect(again.get("scope", "chat", "p1")).toEqual(entry);
    expect(again.get("scope", "chat", "p2")).toBeUndefined();
    expect(again.get("other", "chat", "p1")).toBeUndefined();
    again.forgetChat("scope", "chat");
    expect(contextLedger(storage).get("scope", "chat", "p1")).toBeUndefined();
    expect(JSON.parse(stored.get(CONTEXT_LEDGER_KEY)!).v).toBe(1);
  });

  it("reads a document it can't make sense of as empty", () => {
    const storage = { getItem: () => '{"v":1,"scopes":{"s":{"c":{"p":{"mode":"neither"}}}}}', setItem: () => {} };
    expect(contextLedger(storage).get("s", "c", "p")).toBeUndefined();
  });
});
