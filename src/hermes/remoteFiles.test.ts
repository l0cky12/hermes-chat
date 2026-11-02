// Server files (remoteFiles.ts) against a fake Hermes whose disk answers `GET /api/files` and `GET /api/files/read` as
// the deployed `bf0203a` does (fakeServerFiles.ts).
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  crumbs,
  explain,
  looksBinary,
  parseListing,
  previewSupport,
  type RemoteEntry,
} from "./remoteFiles";

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
    expect(explain("The chat connection is closed.", "list")).toMatchObject({ offline: true });
    expect(explain("The dashboard sign-in has expired. Sign in again.", "read")).toMatchObject({ status: 401, offline: true });
    expect(explain('The dashboard answered 500: {"detail":"Could not read directory: [Errno 5] Input/output error"}', "list").message).toBe(
      "The server couldn't list this folder (500): Could not read directory: [Errno 5] Input/output error",
    );
    expect(explain("The dashboard answered 502: Bad Gateway", "read").message).toBe("The server couldn't read this file (502): Bad Gateway");
    expect(explain('The dashboard answered 413: {"detail":"File is too large"}', "read").message).toBe("Hermes won't send files over 100 MB.");
    expect(explain("something else", "list").message).toBe("something else");
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
