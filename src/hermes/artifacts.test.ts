// Artifacts against a fake Hermes whose `/api/fs/read-data-url`, `POST /api/fs/write-text`, managed files and
// `llm.oneshot` answer as the deployed `bf0203a` does (ADR 0029): editing, checked saves, conflicts, kept versions and
// Hermes's proposed edits, through the real transport.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { connect, type Hermes } from "./transport";
import { ArtifactStore, artifactIo, artifactKey, isDirty, type ArtifactRef } from "./artifacts";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** Text as the fake server holds file bytes: one char per UTF-8 byte. */
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join("");
const text = (bytes: string) => new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));

async function setup(files: Record<string, string> = { "/srv/out/notes.md": utf8("# Notes\n\nFirst draft.\n") }) {
  const server = new FakeHermes();
  server.sessions = [row("report", 1, { pinned: true, title: "Quarterly report" })];
  server.otherProfiles = { work: [] };
  for (const [p, t] of Object.entries(files)) server.serverFiles[p] = t;
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const store = new ArtifactStore((ref) => artifactIo({ host: ref.host, files: hermes.files, fs: hermes.artifactFs(ref.profile) }), (o) => hermes.askForEdit(o));
  return { server, hermes, store };
}

const ref = (o: Partial<ArtifactRef> = {}): ArtifactRef => ({ scope: "ssh:liam@hermes\ndefault", profile: "default", path: "/srv/out/notes.md", host: false, ...o });

/** Opens `r` and waits until it is read. */
async function opened(store: ArtifactStore, r = ref()) {
  const key = store.open(r);
  await until(() => store.get(key)!.state !== "loading");
  return key;
}

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}

describe("artifacts", () => {
  it("opens a tool's file where the profile's tools run, saves the edit there checked and read back, and keeps the prior version", async () => {
    const { server, store } = await setup();
    const key = await opened(store, ref({ profile: "work" }));
    const s = store.get(key)!;
    expect(s.state).toBe("ready");
    expect(s.draft).toBe("# Notes\n\nFirst draft.\n");
    expect(isDirty(s)).toBe(false);
    store.type(key, "# Notes\n\nSecond draft.\n", { start: 0, end: 0 });
    expect(isDirty(store.get(key))).toBe(true);
    // Nothing reaches the server until Save.
    expect(server.fsWrites).toEqual([]);
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("# Notes\n\nFirst draft.\n");
    await store.save(key);
    const after = store.get(key)!;
    expect(after.error).toBeUndefined();
    expect(after.conflict).toBeUndefined();
    expect(isDirty(after)).toBe(false);
    expect(server.fsWrites).toEqual([{ profile: "work", path: "/srv/out/notes.md", text: "# Notes\n\nSecond draft.\n" }]);
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("# Notes\n\nSecond draft.\n");
    // What the file held before the save stays recoverable: here the version as opened, which it was.
    expect(after.versions.map((v) => [v.kind, v.text])).toEqual([
      ["opened", "# Notes\n\nFirst draft.\n"],
      ["saved", "# Notes\n\nSecond draft.\n"],
    ]);
    // The version before the save is kept, and can go back to the server.
    const prior = after.versions.find((v) => v.text === "# Notes\n\nFirst draft.\n")!;
    store.restore(key, prior.id);
    expect(store.get(key)!.draft).toBe("# Notes\n\nFirst draft.\n");
    await store.save(key);
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("# Notes\n\nFirst draft.\n");
    expect(server.fsWrites).toHaveLength(2);
  });

  it("keeps the version a save replaced among the versions, by kind", async () => {
    const { store } = await setup();
    const key = await opened(store);
    store.type(key, "changed\n", { start: 0, end: 0 });
    await store.save(key);
    expect(store.get(key)!.versions.map((v) => v.kind)).toEqual(["opened", "saved"]);
    // "opened" and "prior" are the same bytes the first time, so the prior one isn't kept twice.
    store.type(key, "changed again\n", { start: 0, end: 0 });
    await store.save(key);
    expect(store.get(key)!.versions.map((v) => [v.kind, v.text])).toEqual([
      ["opened", "# Notes\n\nFirst draft.\n"],
      ["saved", "changed\n"],
      ["saved", "changed again\n"],
    ]);
  });

  it("writes nothing when Hermes changed the file meanwhile, shows the conflict, and merges both edits", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("one\ntwo\nthree\n") });
    const key = await opened(store);
    store.type(key, "ONE\ntwo\nthree\n", { start: 0, end: 0 });
    // Hermes, in the chat, rewrites the same file with write_file.
    server.serverFiles["/srv/out/notes.md"] = utf8("one\ntwo\nTHREE\n");
    await store.save(key);
    const s = store.get(key)!;
    expect(server.fsWrites).toEqual([]);
    expect(s.conflict?.after).toBe(false);
    expect(s.draft).toBe("ONE\ntwo\nthree\n");
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("one\ntwo\nTHREE\n");
    // The server's version is kept too.
    expect(s.versions.some((v) => v.kind === "server" && v.text === "one\ntwo\nTHREE\n")).toBe(true);
    store.merge(key);
    expect(store.get(key)!.draft).toBe("ONE\ntwo\nTHREE\n");
    await store.save(key);
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("ONE\ntwo\nTHREE\n");
  });

  it("uses the server's version on request, with the edit one Undo away, or saves the edit as a copy beside it", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("mine?\n") });
    const key = await opened(store);
    store.type(key, "mine!\n", { start: 0, end: 0 });
    server.serverFiles["/srv/out/notes.md"] = utf8("theirs\n");
    await store.save(key);
    await store.saveCopy(key);
    expect(server.fsWrites).toEqual([{ profile: "default", path: "/srv/out/notes (2).md", text: "mine!\n" }]);
    expect(store.get(key)!.note).toMatch(/saved as a copy, \/srv\/out\/notes \(2\)\.md/);
    await store.save(key);
    store.reload(key);
    expect(store.get(key)!.draft).toBe("theirs\n");
    store.undo(key);
    expect(store.get(key)!.draft).toBe("mine!\n");
  });

  it("settles a lost answer by reading the file back, and keeps the edit when the server refused", async () => {
    const { server, store } = await setup();
    const key = await opened(store);
    store.type(key, "lost but landed\n", { start: 0, end: 0 });
    server.afterFsWrite = () => {
      server.afterFsWrite = undefined;
      throw new RestError(504, "Gateway Timeout");
    };
    await store.save(key);
    expect(store.get(key)!.error).toBeUndefined();
    expect(isDirty(store.get(key))).toBe(false);
    store.type(key, "refused\n", { start: 0, end: 0 });
    server.fsWriteFailure = new RestError(403, `{"detail":"File is not writable"}`);
    await store.save(key);
    const s = store.get(key)!;
    expect(s.error).toBe("The server's user isn't allowed to write this file.");
    // Full text recovery: the edit is all still in the editor.
    expect(s.draft).toBe("refused\n");
    expect(text(server.serverFiles["/srv/out/notes.md"] as string)).toBe("lost but landed\n");
  });

  it("makes one copy, not two, when a copy landed but couldn't be read back and is tried again", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("base\n") });
    const key = await opened(store);
    store.type(key, "mine\n", { start: 0, end: 0 });
    server.serverFiles["/srv/out/notes.md"] = utf8("theirs\n");
    await store.save(key);
    let failReads = 1;
    server.fsReadFailure = (path) => (path === "/srv/out/notes (2).md" && failReads-- > 0 ? new RestError(502, "Bad Gateway") : undefined);
    await store.saveCopy(key);
    expect(store.get(key)!.error).toMatch(/couldn't be read back to check/);
    await store.saveCopy(key);
    expect(store.get(key)!.error).toBeUndefined();
    expect(store.get(key)!.note).toMatch(/notes \(2\)\.md/);
    expect(server.fsWrites.map((w) => w.path)).toEqual(["/srv/out/notes (2).md"]);
    expect(Object.keys(server.serverFiles).filter((p) => p.startsWith("/srv/out/notes ("))).toEqual(["/srv/out/notes (2).md"]);
  });

  it("keeps typing done while a save runs, on top of the saved version", async () => {
    const { server, store } = await setup();
    const key = await opened(store);
    store.type(key, "saved part\n", { start: 0, end: 0 });
    let open!: () => void;
    server.fsWriteGate = new Promise((r) => (open = r));
    const saving = store.save(key);
    await until(() => server.fsWrites.length === 0 && store.get(key)!.busy === "saving");
    // The editor is read-only while saving: typing then is refused, not lost later.
    store.type(key, "typed during save\n", { start: 0, end: 0 });
    expect(store.get(key)!.draft).toBe("saved part\n");
    open();
    await saving;
    expect(store.get(key)!.draft).toBe("saved part\n");
    expect(isDirty(store.get(key))).toBe(false);
  });

  it("round-trips CRLF line ends, a byte order mark and Unicode, changing only the lines edited", async () => {
    const original = "\uFEFFTitle é 😀\r\nline 2\r\n漢字\r\n";
    const { server, store } = await setup({ "/srv/out/win.txt": utf8(original) });
    const key = await opened(store, ref({ path: "/srv/out/win.txt" }));
    const s = store.get(key)!;
    expect(s.base?.eol).toBe("\r\n");
    expect(s.base?.bom).toBe(true);
    expect(s.draft).toBe("Title é 😀\nline 2\n漢字\n");
    store.type(key, s.draft.replace("line 2", "line two 🚀"), { start: 0, end: 0 });
    await store.save(key);
    // Byte for byte: the byte order mark, the CRLFs and every character as UTF-8.
    expect(server.serverFiles["/srv/out/win.txt"]).toBe(utf8("\uFEFFTitle é 😀\r\nline two 🚀\r\n漢字\r\n"));
  });

  it("won't open what it can't write back exactly, or a credential file, and says why", async () => {
    const { store } = await setup({
      "/srv/out/mixed.txt": utf8("a\r\nb\n"),
      "/srv/out/big.md": "x".repeat(1024 * 1024 + 1),
      "/srv/out/latin1.txt": "caf\xe9\n",
      "/srv/out/blob.bin": "\x00\x01\x02",
    });
    const why = async (path: string) => store.get(await opened(store, ref({ path })))!.why;
    expect(await why("/srv/out/mixed.txt")).toMatch(/mixes Windows \(CRLF\) and Unix \(LF\)/);
    expect(await why("/srv/out/big.md")).toMatch(/grown past what the editor opens|over 1 MB/);
    expect(await why("/srv/out/latin1.txt")).toMatch(/isn't UTF-8/);
    expect(await why("/srv/out/blob.bin")).toMatch(/binary/);
    expect(await why("/srv/out/gone.md")).toMatch(/isn't on the server/);
    expect(await why("/home/me/.hermes/.env")).toMatch(/credential/);
  });

  it("proposes Hermes's edit of the selection, with no tools and no chat, and applies it only to the text it was made for", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("# Notes\n\nA long, rambling paragraph.\n\nEnd.\n") });
    const key = await opened(store);
    server.oneshotAnswer = "<selection>A short one.</selection>";
    const start = "# Notes\n\n".length;
    store.select(key, start, start + "A long, rambling paragraph.".length);
    await store.askEdit(key, "Make it shorter");
    const ask = server.requests.find((r) => r.method === "llm.oneshot")!;
    expect(ask.params.profile).toBe("default");
    expect(ask.params.session_id).toBeUndefined();
    expect(String(ask.params.input)).toContain("<selection>A long, rambling paragraph.</selection>");
    expect(String(ask.params.input)).toContain("Request: Make it shorter");
    expect(String(ask.params.instructions)).toMatch(/only the new text/);
    const p = store.get(key)!.proposal!;
    expect(p.replacement).toBe("A short one.");
    expect(p.lent).toBe(false);
    // The editor is unchanged until it's applied, and the file until it's saved.
    expect(store.get(key)!.draft).toBe("# Notes\n\nA long, rambling paragraph.\n\nEnd.\n");
    expect(store.apply(key)).toBe(true);
    expect(store.get(key)!.draft).toBe("# Notes\n\nA short one.\n\nEnd.\n");
    expect(store.get(key)!.sel).toEqual({ start: 9, end: 21 });
    expect(server.fsWrites).toEqual([]);
    store.undo(key);
    expect(store.get(key)!.draft).toBe("# Notes\n\nA long, rambling paragraph.\n\nEnd.\n");
  });

  it("rejects a proposal once the text changed, and asks again against the text as it is", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("alpha beta\n") });
    const key = await opened(store);
    server.oneshotAnswer = "ALPHA";
    store.select(key, 0, 5);
    await store.askEdit(key, "Upper-case it");
    store.type(key, "alpha beta gamma\n", { start: 16, end: 16 });
    expect(store.apply(key)).toBe(false);
    expect(store.get(key)!.rejected).toMatch(/text has changed since you asked/);
    expect(store.get(key)!.draft).toBe("alpha beta gamma\n");
    store.select(key, 0, 5);
    await store.askEdit(key, "Upper-case it");
    expect(store.apply(key)).toBe(true);
    expect(store.get(key)!.draft).toBe("ALPHA beta gamma\n");
  });

  it("asks again for the same passage where it still is, and not a guess where it changed or repeats", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("intro\nalpha beta\nend\n") });
    const key = await opened(store);
    server.oneshotAnswer = "ALPHA BETA";
    store.select(key, 6, 16);
    await store.askEdit(key, "Shout");
    // Typing before the passage moves it: it's found where it went.
    store.type(key, "new intro\nalpha beta\nend\n", { start: 9, end: 9 });
    expect(store.apply(key)).toBe(false);
    await store.askAgain(key);
    const asked = server.requests.filter((r) => r.method === "llm.oneshot");
    expect(asked).toHaveLength(2);
    expect(String(asked[1].params.input)).toContain("<selection>alpha beta</selection>");
    expect(String(asked[1].params.input)).toContain("Request: Shout");
    expect(store.apply(key)).toBe(true);
    expect(store.get(key)!.draft).toBe("new intro\nALPHA BETA\nend\n");
    // A passage now there twice isn't guessed at.
    store.select(key, 10, 20);
    await store.askEdit(key, "Lower");
    store.type(key, "ALPHA BETA\nnew intro\nALPHA BETA\nend\n", { start: 0, end: 0 });
    await store.askAgain(key);
    expect(server.requests.filter((r) => r.method === "llm.oneshot")).toHaveLength(3);
    expect(store.get(key)!.error).toMatch(/Select it again/);
    expect(store.get(key)!.proposal).toBeUndefined();
  });

  it("drops a note such as Saved once the owner types again", async () => {
    const { store } = await setup();
    const key = await opened(store);
    store.type(key, "x\n", { start: 0, end: 0 });
    await store.save(key);
    expect(store.get(key)!.note).toMatch(/^Saved/);
    store.type(key, "xy\n", { start: 0, end: 0 });
    expect(store.get(key)!.note).toBeUndefined();
  });

  it("rejects a proposal whose base version was replaced by a save meanwhile", async () => {
    const { server, store } = await setup({ "/srv/out/notes.md": utf8("alpha\n") });
    const key = await opened(store);
    server.oneshotAnswer = "omega";
    await store.askEdit(key, "Rewrite");
    // The owner saved an edit, then undid it: the same text, on another base version.
    store.type(key, "beta\n", { start: 0, end: 0 });
    await store.save(key);
    store.type(key, "alpha\n", { start: 0, end: 0 });
    expect(store.apply(key)).toBe(false);
    expect(store.get(key)!.rejected).toMatch(/file the edit was made for has changed/);
  });

  it("lends the chat's own model when the chat that made the file is live in this app", async () => {
    const { server, hermes, store } = await setup();
    await hermes.open("report");
    await hermes.idle();
    const key = await opened(store, ref({ chatId: "report" }));
    await store.askEdit(key, "Tidy");
    const ask = server.requests.filter((r) => r.method === "llm.oneshot").at(-1)!;
    expect(ask.params.session_id).toBe(hermes.getSnapshot().chats.find((c) => c.id === "report")!.runtimeId);
    expect(store.get(key)!.proposal!.lent).toBe(true);
  });

  it("says why Hermes couldn't propose an edit, and changes nothing", async () => {
    const { server, store } = await setup();
    const key = await opened(store);
    server.oneshotFailure = "Provider 'openrouter' is set in config.yaml but no API key was found";
    await store.askEdit(key, "Tidy");
    expect(store.get(key)!.error).toMatch(/^Hermes couldn't propose an edit: .*openrouter/);
    expect(store.get(key)!.proposal).toBeUndefined();
    expect(store.get(key)!.draft).toBe("# Notes\n\nFirst draft.\n");
  });

  it("drops an answer for an artifact closed meanwhile", async () => {
    const { store } = await setup();
    const key = await opened(store);
    const asking = store.askEdit(key, "Tidy");
    store.close(key);
    await asking;
    expect(store.get(key)).toBeUndefined();
    const again = await opened(store);
    expect(store.get(again)!.proposal).toBeUndefined();
  });

  it("keeps an artifact's draft, history and versions when it is opened again", async () => {
    const { store } = await setup();
    const key = await opened(store);
    store.type(key, "kept\n", { start: 5, end: 5 });
    expect(store.open(ref())).toBe(key);
    expect(store.get(key)!.draft).toBe("kept\n");
    expect(store.unsaved().map((s) => s.name)).toEqual(["notes.md"]);
    expect(store.unsaved("another scope")).toEqual([]);
    store.discard(key);
    expect(isDirty(store.get(key))).toBe(false);
    expect(store.get(key)!.versions).toHaveLength(1);
  });

  it("keeps two connections' or profiles' copies of one path apart, and a host file apart from the tools' one", () => {
    expect(artifactKey(ref())).not.toBe(artifactKey(ref({ scope: "ssh:liam@other\ndefault" })));
    expect(artifactKey(ref())).not.toBe(artifactKey(ref({ host: true })));
  });

  it("edits a file on the dashboard's machine through Server files' managed-files save", async () => {
    const { server, store } = await setup({});
    server.managedFiles.nodes = { "/srv/audio/notes.txt": { text: "host file\n" } };
    const key = await opened(store, ref({ path: "/srv/audio/notes.txt", host: true }));
    expect(store.get(key)!.draft).toBe("host file\n");
    store.type(key, "host file, edited\n", { start: 0, end: 0 });
    await store.save(key);
    expect(store.get(key)!.error).toBeUndefined();
    expect(server.managedFiles.saves).toEqual([{ path: "/srv/audio/notes.txt", text: "host file, edited\n", overwrite: true }]);
    expect(server.fsWrites).toEqual([]);
  });
});
