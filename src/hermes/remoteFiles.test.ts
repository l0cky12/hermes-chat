// Server files (remoteFiles.ts) against a fake Hermes whose disk answers `GET /api/files` and `GET /api/files/read` as
// the deployed `bf0203a` does (fakeServerFiles.ts).
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  EDIT_DEADLINES,
  crumbs,
  explain,
  freeName,
  protectedPath,
  looksBinary,
  parseListing,
  previewSupport,
  type RemoteEntry,
} from "./remoteFiles";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

async function signedIn(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  return { server, hermes };
}

const MiB = 1024 * 1024;
const file = (name: string, over: Partial<RemoteEntry> = {}): RemoteEntry => ({ name, path: `/srv/${name}`, kind: "file", size: 10, ...over });

function homeDisk(s: FakeHermes) {
  s.managedFiles.nodes = {
    "/home/liam/notes.md": { text: "# Notes\n\nCafé ☕\n", mtime: 1_793_000_000.5 },
    "/home/liam/projects/app/main.rs": { text: "fn main() {}\n" },
    "/home/liam/.bashrc": { text: "export PATH\n" },
    "/home/liam/.env": { text: "SECRET=1\n" },
    "/home/liam/auth.json": { text: "{}" },
    "/home/liam/latest": { link: "/home/liam/projects/app" },
    "/home/liam/readme-link": { link: "/home/liam/notes.md" },
    "/home/liam/dangling": { link: "/home/liam/gone.txt" },
    "/home/liam/Photo.png": { bytes: "\x89PNG\r\n\x1a\n" },
    "/home/liam/private": { dir: true, unreadable: true },
    "/home/liam/private/diary.txt": { text: "x" },
  };
}

describe("listing a server folder", () => {
  it("starts in the server's starting folder: folders first, credential files left out by the server", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const listing = await hermes.files.list();
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/files" });
    expect(server.restRequests.at(-1)!.query.has("path")).toBe(false);
    expect(listing.path).toBe("/home/liam");
    expect(listing.parent).toBe("/home");
    expect(listing.root).toBeUndefined();
    expect(listing.entries.map((e) => e.name)).toEqual(["latest", "private", "projects", ".bashrc", "dangling", "notes.md", "Photo.png", "readme-link"]);
  });

  it("gives each entry its size, modified time in ms and type, and tells links from what they point at", async () => {
    const { hermes } = await signedIn(homeDisk);
    const { entries } = await hermes.files.list("/home/liam");
    const by = (n: string) => entries.find((e) => e.name === n)!;
    expect(by("notes.md")).toEqual({ name: "notes.md", path: "/home/liam/notes.md", kind: "file", size: 19, modified: 1_793_000_000_500, mime: "text/markdown", linkTarget: undefined });
    expect(by("projects")).toMatchObject({ kind: "dir", size: undefined, linkTarget: undefined });
    expect(by("latest")).toMatchObject({ kind: "dir", path: "/home/liam/projects/app", linkTarget: "/home/liam/projects/app" });
    expect(by("readme-link")).toMatchObject({ kind: "file", path: "/home/liam/notes.md", linkTarget: "/home/liam/notes.md" });
    expect(by("dangling")).toEqual({ name: "dangling", path: "/home/liam/dangling", kind: "broken-link" });
  });

  it("opens a link to a folder at its target", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const latest = (await hermes.files.list()).entries.find((e) => e.name === "latest")!;
    const listing = await hermes.files.list(latest.path);
    expect(server.restRequests.at(-1)!.query.get("path")).toBe("/home/liam/projects/app");
    expect(listing.path).toBe("/home/liam/projects/app");
    expect(listing.entries.map((e) => e.name)).toEqual(["main.rs"]);
  });

  it("says why a folder can't be listed: gone, not allowed, a file, or outside a locked root", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    await expect(hermes.files.list("/home/liam/nope")).rejects.toMatchObject({ status: 404, message: "That folder isn't on the server, or is gone now." });
    await expect(hermes.files.list("/home/liam/private")).rejects.toMatchObject({ status: 403, message: "The Hermes server's user isn't allowed to open this folder." });
    await expect(hermes.files.list("/home/liam/notes.md")).rejects.toMatchObject({ status: 400, message: "That's a file, not a folder." });
    await expect(hermes.files.list("/home/liam/../etc")).rejects.toMatchObject({ status: 400, message: "Type the path without '..' in it." });
    server.managedFiles.root = "/home/liam/projects";
    await expect(hermes.files.list("/home/liam")).rejects.toMatchObject({ status: 403, message: "The server only lets you browse inside its files folder." });
  });

  it("starts at a locked root, with nothing above it", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    server.managedFiles.root = "/home/liam/projects";
    const listing = await hermes.files.list();
    expect(listing).toMatchObject({ path: "/home/liam/projects", parent: undefined, root: "/home/liam/projects" });
    expect((await hermes.files.list("/home/liam/projects/app")).parent).toBe("/home/liam/projects");
  });

  it("is refused while Hermes isn't connected, without asking the server", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    server.drop();
    const before = server.restRequests.length;
    await expect(hermes.files.list()).rejects.toMatchObject({ offline: true, message: "Hermes isn't connected. Server files can be browsed again once it is." });
    expect(server.restRequests.length).toBe(before);
  });

  it("says so when the server has no file browser, or answers with something else", async () => {
    const { server, hermes } = await signedIn();
    delete server.rest["GET /api/files"];
    await expect(hermes.files.list()).rejects.toMatchObject({ status: 404, message: expect.stringContaining("has no file browser (GET /api/files)") });
    server.rest["GET /api/files"] = () => "<html>";
    await expect(hermes.files.list()).rejects.toThrow("isn't a file list");
  });

  it("keeps every entry of a big folder", async () => {
    const { server, hermes } = await signedIn();
    for (let i = 0; i < 3000; i++) server.managedFiles.nodes[`/data/big/f${String(i).padStart(4, "0")}.txt`] = { text: "x" };
    const listing = await hermes.files.list("/data/big");
    expect(listing.entries).toHaveLength(3000);
    expect(listing.entries[2999].name).toBe("f2999.txt");
  });
});

describe("previewing a server file", () => {
  it("reads a text file as UTF-8, capped at the preview's size", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const notes = (await hermes.files.list()).entries.find((e) => e.name === "notes.md")!;
    const preview = await hermes.files.preview(notes);
    expect(preview).toEqual({ kind: "text", path: "/home/liam/notes.md", name: "notes.md", size: 19, text: "# Notes\n\nCafé ☕\n" });
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/files/read" });
    expect(server.restRequests.at(-1)!.query.get("path")).toBe("/home/liam/notes.md");
  });

  it("reads a link's target", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const link = (await hermes.files.list()).entries.find((e) => e.name === "readme-link")!;
    expect(await hermes.files.preview(link)).toMatchObject({ kind: "text", path: "/home/liam/notes.md" });
    expect(server.managedFiles.reads).toEqual(["/home/liam/notes.md"]);
  });

  it("shows an image as the data URL the server sends", async () => {
    const { hermes } = await signedIn(homeDisk);
    const photo = (await hermes.files.list()).entries.find((e) => e.name === "Photo.png")!;
    const preview = await hermes.files.preview(photo);
    expect(preview).toMatchObject({ kind: "image", mime: "image/png" });
    expect(preview.kind === "image" && preview.dataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it("refuses an image whose data URL isn't an image's", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const photo = (await hermes.files.list()).entries.find((e) => e.name === "Photo.png")!;
    server.managedFiles.nodes[photo.path] = { text: "<script>alert(1)</script>", mime: "text/html" };
    await expect(hermes.files.preview(photo)).rejects.toThrow("The server's answer isn't an image.");
  });

  it("doesn't read a file bigger than the preview takes", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.managedFiles.nodes = { "/srv/huge.log": { size: 5 * MiB }, "/srv/huge.png": { size: 40 * MiB } };
    });
    const { entries } = await hermes.files.list("/srv");
    await expect(hermes.files.preview(entries.find((e) => e.name === "huge.log")!)).rejects.toThrow("It's 5.0 MB. Previews go up to 1.0 MB.");
    await expect(hermes.files.preview(entries.find((e) => e.name === "huge.png")!)).rejects.toThrow("It's 40 MB. Previews go up to 10 MB.");
    expect(server.managedFiles.reads).toEqual([]);
  });

  it("refuses a file that grew past the limit since it was listed, without taking the whole answer", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.managedFiles.nodes = { "/srv/app.log": { text: "start\n" } };
    });
    const log = (await hermes.files.list("/srv")).entries[0];
    server.managedFiles.nodes["/srv/app.log"] = { size: 3 * MiB, mime: "text/plain" };
    await expect(hermes.files.preview(log)).rejects.toMatchObject({ status: 413, message: "The file grew past what a preview reads (1.0 MB)." });
  });

  it("tells a binary file from text", async () => {
    const { hermes } = await signedIn((s) => {
      s.managedFiles.nodes = { "/srv/blob": { bytes: "\x7fELF\0\0\x01" } };
    });
    const blob = (await hermes.files.list("/srv")).entries[0];
    expect(previewSupport(blob).kind).toBe("maybe-text");
    expect(await hermes.files.preview(blob, true)).toMatchObject({ kind: "binary", size: 7 });
  });

  it("says why the server won't send a file", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.managedFiles.nodes = { "/srv/locked.txt": { text: "x", unreadable: true }, "/srv/a.txt": { text: "a" }, "/srv/.env": { text: "KEY=1" } };
    });
    const { entries } = await hermes.files.list("/srv");
    await expect(hermes.files.preview(entries.find((e) => e.name === "locked.txt")!)).rejects.toMatchObject({ status: 403, message: "The Hermes server's user isn't allowed to read this file." });
    delete server.managedFiles.nodes["/srv/a.txt"];
    await expect(hermes.files.preview(entries.find((e) => e.name === "a.txt")!)).rejects.toMatchObject({ status: 404, message: "That file isn't on the server, or is gone now." });
    await expect(hermes.files.preview({ ...entries[0], name: ".env", path: "/srv/.env" })).rejects.toMatchObject({ status: 403, message: "Hermes doesn't show credential files, such as .env or auth.json." });
  });
});

describe("what can be previewed", () => {
  it("judges by type, then by name", () => {
    expect(previewSupport(file("a.png", { mime: "image/png" }))).toEqual({ kind: "image", max: IMAGE_PREVIEW_MAX_BYTES });
    expect(previewSupport(file("a.svg", { mime: "image/svg+xml" })).kind).toBe("image");
    expect(previewSupport(file("a.py", { mime: "text/x-python" }))).toEqual({ kind: "text", max: TEXT_PREVIEW_MAX_BYTES });
    expect(previewSupport(file("a.json", { mime: "application/json" })).kind).toBe("text");
    // Python's mimetypes calls TypeScript MPEG transport stream video.
    expect(previewSupport(file("app.ts", { mime: "video/mp2t" })).kind).toBe("text");
    expect(previewSupport(file("Makefile", { mime: "application/octet-stream" })).kind).toBe("text");
    expect(previewSupport(file(".gitconfig", { mime: "application/octet-stream" })).kind).toBe("text");
    expect(previewSupport(file("run", { mime: "application/octet-stream" })).kind).toBe("maybe-text");
    expect(previewSupport(file("x.bin", { mime: "application/octet-stream" })).kind).toBe("maybe-text");
    expect(previewSupport(file("a.mp4", { mime: "video/mp4" }))).toEqual({ kind: "none", why: "There's no preview for video/mp4 files." });
    expect(previewSupport(file("a.zip", { mime: "application/zip" })).kind).toBe("none");
    expect(previewSupport(file("a.tiff", { mime: "image/tiff" })).kind).toBe("none");
    // A link's type comes from its target, so its target's name counts too.
    expect(previewSupport(file("current", { path: "/srv/app.ts", linkTarget: "/srv/app.ts", mime: "video/mp2t" })).kind).toBe("text");
    expect(previewSupport(file("Dockerfile", { path: "/srv/build/blob", linkTarget: "/srv/build/blob", mime: "application/octet-stream" })).kind).toBe("text");
    expect(previewSupport(file("clip", { path: "/srv/a.mp4", linkTarget: "/srv/a.mp4", mime: "video/mp4" })).kind).toBe("none");
    expect(previewSupport({ name: "d", path: "/d", kind: "dir" }).kind).toBe("none");
    expect(previewSupport({ name: "l", path: "/l", kind: "broken-link" })).toEqual({ kind: "none", why: "It's a symbolic link to something that isn't there." });
  });

  it("calls bytes binary as the server does: a NUL, or over 12% control bytes", () => {
    const enc = new TextEncoder();
    expect(looksBinary(enc.encode("plain\ttext\r\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([104, 0, 105]))).toBe(true);
    expect(looksBinary(new Uint8Array([1, 2, 65, 66, 67, 68, 69, 70, 71, 72]))).toBe(true);
    expect(looksBinary(new Uint8Array([1, ...Array(20).fill(65)]))).toBe(false);
    expect(looksBinary(new Uint8Array())).toBe(false);
  });
});

describe("parsing", () => {
  it("drops malformed entries and reads a locked root", () => {
    const listing = parseListing(
      JSON.stringify({
        path: "/opt/data",
        parent: null,
        entries: [{ name: "ok", path: "/opt/data/ok", is_directory: true, mtime: 1 }, { name: 3 }, { path: "/x" }, null],
        root: "/opt/data",
        locked_root: "/opt/data",
        can_change_path: false,
      }),
      42,
    );
    expect(listing).toEqual({ path: "/opt/data", parent: undefined, entries: [{ name: "ok", path: "/opt/data/ok", kind: "dir", size: undefined, modified: 1000, mime: undefined, linkTarget: undefined }], root: "/opt/data", listedAt: 42 });
  });

  it("lists entries of / without a doubled slash", () => {
    const listing = parseListing(JSON.stringify({ path: "/", parent: null, entries: [{ name: "etc", path: "/etc", is_directory: true }] }), 0);
    expect(listing.entries[0].linkTarget).toBeUndefined();
  });

  it("turns transport errors into reasons", () => {
    expect(explain(new Error("The chat connection is closed."), "list")).toMatchObject({ offline: true });
    expect(explain(new RestError(401, "", "The dashboard sign-in has expired. Sign in again."), "read")).toMatchObject({ status: 401, offline: true });
    expect(explain(new RestError(500, '{"detail":"Could not read directory: [Errno 5] Input/output error"}'), "list").message).toBe(
      "The server couldn't list this folder (500): Could not read directory: [Errno 5] Input/output error",
    );
    expect(explain(new RestError(502, "Bad Gateway"), "read").message).toBe("The server couldn't read this file (502): Bad Gateway");
    expect(explain(new RestError(413, '{"detail":"File is too large"}'), "read").message).toBe("Hermes won't send files over 100 MB.");
    expect(explain(new Error("something else"), "list").message).toBe("something else");
  });
});

describe("the path trail", () => {
  it("goes from / down to the folder", () => {
    expect(crumbs("/home/liam/projects")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "liam", path: "/home/liam" },
      { label: "projects", path: "/home/liam/projects" },
    ]);
    expect(crumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("starts at a locked root", () => {
    expect(crumbs("/opt/data/logs/today", "/opt/data")).toEqual([
      { label: "/opt/data", path: "/opt/data" },
      { label: "logs", path: "/opt/data/logs" },
      { label: "today", path: "/opt/data/logs/today" },
    ]);
    expect(crumbs("/opt/data", "/opt/data/")).toEqual([{ label: "/opt/data", path: "/opt/data" }]);
    // A root that is a prefix of another folder's name isn't its parent.
    expect(crumbs("/opt/database", "/opt/data")[0]).toEqual({ label: "/", path: "/" });
  });
});

describe("downloads", () => {
  const notes: RemoteEntry = { name: "notes.md", path: "/home/liam/notes.md", kind: "file", size: 20 };

  it("says what went wrong on this computer or on the way, and saves nothing", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    for (const [error, shown] of [
      ["couldn't write it on this computer: No space left on device (os error 28)", "Couldn't write it on this computer: No space left on device (os error 28)."],
      ["Can't reach the Hermes dashboard: error decoding response body", "The download broke off: Can't reach the Hermes dashboard: error decoding response body."],
      ["the download ended early, after 10 of 20 bytes", "The download broke off: the download ended early, after 10 of 20 bytes."],
    ]) {
      server.managedFiles.transferError = error;
      await hermes.files.download(notes);
      expect(hermes.files.transfers().at(-1)).toMatchObject({ state: "failed", error: shown, dest: "/home/me/Downloads/notes.md" });
    }
    expect(server.managedFiles.local).toEqual({});
  });

  it("refuses a credential file as Hermes does, and starts nothing while disconnected", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    await hermes.files.download({ ...notes, name: ".env", path: "/home/liam/.env" });
    expect(hermes.files.transfers()[0]).toMatchObject({ state: "failed", error: "Hermes doesn't show credential files, such as .env or auth.json." });
    server.drop("closed by the server (1006 )");
    await hermes.files.download(notes);
    expect(hermes.files.transfers()[1]).toMatchObject({ state: "failed", error: "Hermes isn't connected. Server files can be browsed again once it is." });
    expect(server.managedFiles.local).toEqual({});
  });

  it("keeps a settled download settled when progress arrives late", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    server.managedFiles.lateProgress = true;
    await hermes.files.download(notes);
    server.managedFiles.transferError = "the download ended early, after 1 of 2 bytes";
    await hermes.files.download(notes);
    await new Promise((r) => setTimeout(r, 10));
    expect(hermes.files.transfers().map((t) => t.state)).toEqual(["done", "failed"]);
    const size = new TextEncoder().encode("# Notes\n\nCafé ☕\n").length;
    expect(hermes.files.transfers()[0]).toMatchObject({ done: size, total: size });
  });

  it("refuses a folder, a broken link and a file over 100 MB before asking anything", async () => {
    const { hermes } = await signedIn(homeDisk);
    for (const entry of [
      { ...notes, kind: "dir" as const },
      { ...notes, kind: "broken-link" as const },
      { ...notes, size: 100 * MiB + 1 },
    ])
      await expect(hermes.files.download(entry)).rejects.toThrow();
    expect(hermes.files.transfers()).toEqual([]);
  });
});

describe("uploads", () => {
  it("finds a free name for keeping both", () => {
    expect(freeName("notes.md", new Set(["notes.md"]))).toBe("notes (2).md");
    expect(freeName("notes.md", new Set(["notes.md", "notes (2).md"]))).toBe("notes (3).md");
    expect(freeName(".bashrc", new Set([".bashrc"]))).toBe(".bashrc (2)");
    expect(freeName("archive.tar.gz", new Set())).toBe("archive.tar (2).gz");
  });

  it("knows the credential paths Hermes hides, as the Rust side refuses them", () => {
    for (const p of ["/a/.env", "/a/.ENV", "/a/.env.prod", "/a/.envrc", "/a/Auth.json", "/h/.hermes/config.yaml", "/a/mcp-tokens/x.json", "/a/Pairing/y", "/a/.git-credentials"]) expect(protectedPath(p), p).toBe(true);
    for (const p of ["/a/env", "/a/my.env", "/a/config.yml", "/a/pairings/y", "/a/notes.md"]) expect(protectedPath(p), p).toBe(false);
  });

  it("counts an upload done only when the folder lists it at the size sent", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    server.managedFiles.openDialog = () => ({ name: "a.txt", bytes: "hello" });
    const picked = (await hermes.files.pickUpload())!;
    const listing = await hermes.files.list("/home/liam");
    // Something else on the server rewrites it as soon as Hermes has written it.
    server.managedFiles.afterWrite = (at) => (server.managedFiles.nodes[at] = { text: "something else" });
    await hermes.files.upload(listing, picked, "keep-both");
    expect(hermes.files.transfers()[0]).toMatchObject({
      state: "failed",
      error: "Hermes said it saved it, but the folder lists a.txt at 14 bytes, not 5 bytes. Something else may have changed it since.",
    });
  });

  it("reads back the size Rust sent, when the file grew after it was picked", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const file = { name: "grows.log", bytes: "abc" };
    server.managedFiles.openDialog = () => file;
    const picked = (await hermes.files.pickUpload())!;
    expect(picked.size).toBe(3);
    file.bytes = "abcdefg";
    await hermes.files.upload(await hermes.files.list("/home/liam"), picked, "keep-both");
    expect(hermes.files.transfers()[0]).toMatchObject({ state: "done", total: 7, done: 7 });
    // A pick is good for one upload.
    await hermes.files.upload(await hermes.files.list("/home/liam"), picked, "keep-both");
    expect(hermes.files.transfers()[1]).toMatchObject({ state: "failed" });
  });

  it("says when the server's user may not write there", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    server.managedFiles.nodes["/home/liam/locked"] = { dir: true, unreadable: true };
    server.managedFiles.nodes["/home/liam/locked/x"] = { text: "x" };
    server.managedFiles.openDialog = () => ({ name: "a.txt", bytes: "hello" });
    const picked = (await hermes.files.pickUpload())!;
    await hermes.files.upload({ path: "/home/liam/locked", entries: [], listedAt: 0 }, picked, "keep-both");
    expect(hermes.files.transfers()[0]).toMatchObject({ state: "failed", error: "The Hermes server's user isn't allowed to write there." });
  });
});

describe("editing", () => {
  const notes: RemoteEntry = { name: "notes.md", path: "/home/liam/notes.md", kind: "file", size: 20 };
  const text = (s: FakeHermes, p: string) => {
    const n = s.managedFiles.nodes[p] as { text?: string; bytes?: string };
    return n.text ?? new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(n.bytes!, (c) => c.charCodeAt(0)));
  };

  it("saves only over the revision it started from, and says saved once read back", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    expect(base.text).toBe("# Notes\n\nCafé ☕\n");
    const got = await hermes.files.saveEdit(base, "# Notes\n\nCafé ☕ and tea\n");
    expect(got.kind).toBe("saved");
    expect(text(server, "/home/liam/notes.md")).toBe("# Notes\n\nCafé ☕ and tea\n");
    expect(server.managedFiles.saves).toMatchObject([{ path: "/home/liam/notes.md", overwrite: true }]);
    // The saved file is the new base: saving again from it works.
    const again = await hermes.files.saveEdit((got as { base: typeof base }).base, "x\n");
    expect(again.kind).toBe("saved");
  });

  it("writes nothing when the file changed on the server since it was opened, and shows what it has now", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    server.managedFiles.nodes["/home/liam/notes.md"] = { text: "# Notes\n\nedited elsewhere\n" };
    const got = await hermes.files.saveEdit(base, "mine\n");
    expect(got).toMatchObject({ kind: "conflict", after: false, theirs: { text: "# Notes\n\nedited elsewhere\n" } });
    expect(server.managedFiles.saves).toEqual([]);
    expect(text(server, "/home/liam/notes.md")).toBe("# Notes\n\nedited elsewhere\n");
    server.managedFiles.nodes["/home/liam/notes.md"] = { dir: true };
    delete server.managedFiles.nodes["/home/liam/notes.md"];
    expect(await hermes.files.saveEdit(base, "mine\n")).toMatchObject({ kind: "conflict", theirs: { gone: true } });
  });

  it("reports a change that landed while the save ran, instead of saying saved", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    server.managedFiles.afterWrite = (at) => (server.managedFiles.nodes[at] = { text: "someone else, just after\n" });
    expect(await hermes.files.saveEdit(base, "mine\n")).toMatchObject({ kind: "conflict", after: true, theirs: { text: "someone else, just after\n" } });
  });

  it("settles a lost answer by reading the file back", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    let base = await hermes.files.openForEdit(notes);
    server.managedFiles.saveLost = { message: "Can't reach the Hermes dashboard: connection reset", landed: true };
    const got = await hermes.files.saveEdit(base, "landed\n");
    expect(got.kind).toBe("saved");
    base = (got as { base: typeof base }).base;
    server.managedFiles.saveLost = { message: "Can't reach the Hermes dashboard: connection reset", landed: false };
    await expect(hermes.files.saveEdit(base, "lost\n")).rejects.toThrow(/^It wasn't saved: .* The server still has the file you started from\.$/);
    expect(text(server, "/home/liam/notes.md")).toBe("landed\n");
  });

  it("reads back after a gateway's 502, and stops waiting on a save that gets no answer", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    let base = await hermes.files.openForEdit(notes);
    server.managedFiles.saveLost = { message: new RestError(502, `<html>Bad Gateway</html>`), landed: true };
    const got = await hermes.files.saveEdit(base, "via a gateway\n");
    expect(got.kind).toBe("saved");
    base = (got as { base: typeof base }).base;
    server.managedFiles.saveLost = undefined;
    server.managedFiles.saveGate = new Promise(() => {});
    const was = EDIT_DEADLINES.writeMs;
    EDIT_DEADLINES.writeMs = 50;
    try {
      await expect(hermes.files.saveEdit(base, "never answered\n")).rejects.toThrow("It wasn't saved: Hermes didn't answer within 0.05 s. The server still has the file you started from.");
    } finally {
      EDIT_DEADLINES.writeMs = was;
    }
  });

  it("offers a copy when the file became a folder, and keeps copies within the editor's limit", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    delete server.managedFiles.nodes["/home/liam/notes.md"];
    server.managedFiles.nodes["/home/liam/notes.md/inner"] = { text: "x" };
    expect(await hermes.files.saveEdit(base, "mine\n")).toMatchObject({ kind: "conflict", after: false, theirs: { why: "That isn't a regular file." } });
    await expect(hermes.files.saveCopy(base, "x".repeat(MiB + 1))).rejects.toThrow(/saves files up to 1.0 MB/);
    expect(await hermes.files.saveCopy(base, "mine\n")).toBe("/home/liam/notes (2).md");
  });

  it("settles a copy whose answer was lost by reading it back, so a retry makes no second copy", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    server.managedFiles.saveLost = { message: "Can't reach the Hermes dashboard: connection reset", landed: true };
    expect(await hermes.files.saveCopy(base, "copy\n")).toBe("/home/liam/notes (2).md");
    expect(server.managedFiles.saves).toHaveLength(1);
  });

  it("reads back after a 500 Hermes sends once it has written, instead of saying nothing was saved", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    let base = await hermes.files.openForEdit(notes);
    // Even when the post-write error names a file that reads like a pre-write refusal.
    for (const detail of ["Could not stat path: [Errno 2]", "Could not stat path: [Errno 2] '/x/Could not write file: y'"]) {
      server.managedFiles.saveLost = { message: new RestError(500, JSON.stringify({ detail })), landed: true };
      const got = await hermes.files.saveEdit(base, `landed ${detail.length}\n`);
      expect(got.kind).toBe("saved");
      base = (got as { base: typeof base }).base;
    }
  });

  it("never takes a link to the original for a copy whose outcome wasn't known", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    server.managedFiles.saveLost = { message: "Can't reach the Hermes dashboard: connection reset", landed: false };
    server.managedFiles.readError = "Can't reach the Hermes dashboard: connection reset";
    await expect(hermes.files.saveCopy(base, "# Notes\n\nCafé ☕\n")).rejects.toThrow(/couldn't be read back/);
    server.managedFiles.saveLost = undefined;
    server.managedFiles.readError = undefined;
    // Meanwhile the copy's name became a link to the original, which holds the same text.
    server.managedFiles.nodes["/home/liam/notes (2).md"] = { link: "/home/liam/notes.md" };
    expect(await hermes.files.saveCopy(base, "# Notes\n\nCafé ☕\n")).toBe("/home/liam/notes (3).md");
    expect(server.managedFiles.saves).toMatchObject([{ path: "/home/liam/notes (3).md" }]);
  });

  it("checks a copy whose outcome wasn't known before making another", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    server.managedFiles.saveLost = { message: "Can't reach the Hermes dashboard: connection reset", landed: true };
    server.managedFiles.afterWrite = () => (server.managedFiles.readError = "Can't reach the Hermes dashboard: connection reset");
    await expect(hermes.files.saveCopy(base, "copy\n")).rejects.toThrow(/couldn't be read back to check/);
    // Still unreadable: no second copy is made.
    server.managedFiles.saveLost = undefined;
    server.managedFiles.afterWrite = undefined;
    await expect(hermes.files.saveCopy(base, "copy\n")).rejects.toThrow(/may have been saved, and still can't be read/);
    server.managedFiles.readError = undefined;
    expect(await hermes.files.saveCopy(base, "copy\n")).toBe("/home/liam/notes (2).md");
    expect(server.managedFiles.saves).toHaveLength(1);
  });

  it("keeps a file's CRLF line ends and byte order mark", async () => {
    const { server, hermes } = await signedIn((s) => {
      homeDisk(s);
      s.managedFiles.nodes["/home/liam/win.txt"] = { text: "﻿one\r\ntwo\r\n" };
    });
    const base = await hermes.files.openForEdit({ ...notes, name: "win.txt", path: "/home/liam/win.txt" });
    expect(base).toMatchObject({ text: "one\ntwo\n", eol: "\r\n", bom: true });
    await hermes.files.saveEdit(base, "one\ntwo\nthree\n");
    expect(text(server, "/home/liam/win.txt")).toBe("﻿one\r\ntwo\r\nthree\r\n");
  });

  it("refuses what it can't edit, and says why Hermes refused a save", async () => {
    const { server, hermes } = await signedIn((s) => {
      homeDisk(s);
      s.managedFiles.nodes["/home/liam/latin1.txt"] = { bytes: "caf\xe9\n" };
    });
    await expect(hermes.files.openForEdit({ ...notes, name: "latin1.txt", path: "/home/liam/latin1.txt" })).rejects.toThrow(/isn't UTF-8/);
    await expect(hermes.files.openForEdit({ ...notes, size: 2 * MiB })).rejects.toThrow(/up to 1.0 MB/);
    const base = await hermes.files.openForEdit(notes);
    await expect(hermes.files.saveEdit(base, "x".repeat(MiB + 1))).rejects.toThrow(/saves files up to 1.0 MB/);
    server.managedFiles.beforeWrite = () => {
      throw new RestError(403, `{"detail":"File is not writable"}`);
    };
    await expect(hermes.files.saveEdit(base, "x\n")).rejects.toThrow("The Hermes server's user isn't allowed to write this file.");
    expect(server.managedFiles.saves).toEqual([]);
  });

  it("saves an edit as a copy beside the file, never over another", async () => {
    const { server, hermes } = await signedIn(homeDisk);
    const base = await hermes.files.openForEdit(notes);
    expect(await hermes.files.saveCopy(base, "my copy\n")).toBe("/home/liam/notes (2).md");
    expect(server.managedFiles.saves.at(-1)).toMatchObject({ path: "/home/liam/notes (2).md", overwrite: false });
    expect(text(server, "/home/liam/notes.md")).toBe("# Notes\n\nCafé ☕\n");
  });
});
