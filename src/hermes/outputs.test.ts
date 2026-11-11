// Outputs (outputs.ts): which stored tool results count as files Hermes made, how they are kept, and how the index
// reads Hermes, against a fake Hermes whose stored rows and `/api/fs/list` answer as the deployed `bf0203a` does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import {
  ADDED_MAX,
  CHAT_MAX_BYTES,
  OUTPUTS_PER_CHAT,
  compactRows,
  MAX_CHATS_PER_RUN,
  MAX_ROWS_PER_CHAT,
  OUTPUTS_KEY,
  OUTPUTS_KEPT,
  OutputsIndex,
  checkPaths,
  outputsFromRows,
  outputsIn,
  previewable,
  producedBy,
  readScope,
  shownName,
  typeOf,
  versions,
  type OutputsIo,
  type OutputsSnapshot,
  type StoredRow,
} from "./outputs";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** A storage like localStorage, optionally refusing writes as a full one does. */
function memory(full = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException("quota", "QuotaExceededError");
      m.set(k, v);
    },
  };
}

/** A tool call and its stored result, as an assistant row and a tool row. */
function call(id: string, name: string, args: Record<string, unknown>, result: unknown, rowId: number, ts = 1_790_000_000 + rowId): TranscriptMessage[] {
  return [
    { role: "assistant", text: "", row_id: rowId, timestamp: ts, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", name, tool_call_id: id, row_id: rowId + 1, timestamp: ts, result: typeof result === "string" ? result : JSON.stringify(result) },
  ];
}

/** A page of stored rows as `OutputsIo.rows` answers it. */
const page = (rows: StoredRow[]) => ({ rows, bytes: JSON.stringify(rows).length });

const written = (path: string, bytes = 12) => ({ bytes_written: bytes, dirs_created: false, resolved_path: path, files_modified: [path] });

describe("which tool results are Outputs", () => {
  it("lists what write_file, patch, text_to_speech and image_generate say they wrote", () => {
    expect(producedBy("write_file", JSON.stringify(written("/srv/out/report.md", 2048)))).toEqual([{ path: "/srv/out/report.md", how: "written", size: 2048 }]);
    expect(producedBy("patch", JSON.stringify({ success: true, files_created: ["/srv/a.ts", "relative.ts"], files_modified: ["/srv/b.ts"] }))).toEqual([
      { path: "/srv/a.ts", how: "created" },
    ]);
    expect(producedBy("text_to_speech", JSON.stringify({ success: true, file_path: "/h/.hermes/audio/tts_1.mp3", file_paths: ["/h/.hermes/audio/tts_1.mp3", "/h/.hermes/audio/tts_2.mp3"], media_tag: "MEDIA:/h/.hermes/audio/tts_1.mp3" }))).toEqual([
      { path: "/h/.hermes/audio/tts_1.mp3", how: "speech", host: true },
      { path: "/h/.hermes/audio/tts_2.mp3", how: "speech", host: true },
    ]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "/h/.hermes/cache/images/cat.png" }))).toEqual([{ path: "/h/.hermes/cache/images/cat.png", how: "image", host: true }]);
  });

  it("lists nothing for a failed call, a provider URL, an edit of an existing file, or another tool's paths", () => {
    expect(producedBy("write_file", JSON.stringify({ error: "Refusing to write to sensitive path" }))).toEqual([]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "https://fal.media/files/cat.png" }))).toEqual([]);
    expect(producedBy("image_generate", JSON.stringify({ success: false, image: null, error: "quota" }))).toEqual([]);
    expect(producedBy("patch", JSON.stringify({ success: true, files_modified: ["/srv/b.ts"], files_created: [] }))).toEqual([]);
    const rows: StoredRow[] = [
      { id: 1, role: "assistant", content: "I saved it to /srv/out/summary.pdf and MEDIA:/srv/out/x.png" },
      { id: 2, role: "tool", tool_name: "terminal", tool_call_id: "t", content: JSON.stringify({ output: "wrote /srv/out/data.csv", exit_code: 0 }) },
      { id: 3, role: "tool", tool_name: "read_file", tool_call_id: "r", content: JSON.stringify({ path: "/srv/out/in.txt", content: "…" }) },
    ];
    expect(outputsFromRows("c", rows)).toEqual({ outputs: [], unlabelled: 0 });
  });

  it("takes an older write_file result's path from the call's arguments, and counts a producer result that says nothing", () => {
    const rows: StoredRow[] = [
      { id: 1, role: "assistant", tool_calls: JSON.stringify([{ id: "w1", function: { name: "write_file", arguments: JSON.stringify({ path: "/srv/old.txt", content: "x" }) } }]) },
      { id: 2, role: "tool", tool_name: "write_file", tool_call_id: "w1", content: JSON.stringify({ bytes_written: 1 }) },
      { id: 3, role: "tool", tool_name: "write_file", tool_call_id: "w2", content: JSON.stringify({ bytes_written: 5 }) },
      { id: 4, role: "tool", tool_name: "text_to_speech", tool_call_id: "s1", content: "Audio saved (output cut short…" },
    ];
    const { outputs, unlabelled } = outputsFromRows("c", rows);
    expect(outputs.map((o) => [o.path, o.size, o.callId, o.rowId])).toEqual([["/srv/old.txt", 1, "w1", 2]]);
    expect(unlabelled).toBe(2);
  });

  it("keys an Output by chat, call and path, so reading the chat again makes no new ones", () => {
    const rows: StoredRow[] = [{ id: 9, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify(written("/srv/a.md")) }];
    const first = outputsFromRows("c", rows).outputs;
    const again = outputsFromRows("c", [...rows, ...rows]).outputs;
    expect(again).toEqual(first);
    expect(outputsFromRows("other", rows).outputs[0].key).not.toBe(first[0].key);
  });
});

describe("showing an Output", () => {
  it("makes invisible and direction-changing characters in a name visible", () => {
    expect(shownName("/srv/out/invoice‮fdp.exe")).toBe("invoice�fdp.exe");
    expect(shownName("/srv/out/a\nb.txt")).toBe("a�b.txt");
    expect(shownName("/srv/<img src=x onerror=alert(1)>.html")).toBe("<img src=x onerror=alert(1)>.html");
    expect(typeOf("/srv/x‮gnp.exe")).toBe("other");
  });

  it("sorts types and says which can be previewed", () => {
    expect([typeOf("/a/b.PNG"), typeOf("/a/b.md"), typeOf("/a/b.pdf"), typeOf("/a/b.mp3"), typeOf("/a/b.tar.gz"), typeOf("/a/Makefile")]).toEqual([
      "image",
      "text",
      "document",
      "media",
      "archive",
      "other",
    ]);
    const o = (path: string, extra = {}) => ({ key: path, path, how: "written" as const, ...extra });
    expect(previewable(o("/a/b.md")).ok).toBe(true);
    expect(previewable(o("/a/b.html")).ok).toBe(true);
    expect(previewable(o("/a/Makefile")).ok).toBe(true);
    expect(previewable(o("/a/b.pdf"))).toEqual({ ok: false, why: "The preview can't show document files." });
    expect(previewable(o("/a/b.png", { size: 40 * 1024 * 1024 })).ok).toBe(false);
    expect(previewable(o("/a/b.md", { availability: { state: "missing", checkedAt: 1 } })).ok).toBe(false);
  });

  it("numbers the versions of one path, oldest first", () => {
    const o = (key: string, path: string, at: number) => ({ key, path, how: "written" as const, at });
    const v = versions([o("1", "/a.md", 30), o("2", "/a.md", 10), o("3", "/b.md", 5), o("4", "/a.md", 20)]);
    expect(v.get("2")).toEqual({ n: 1, of: 3, latest: false });
    expect(v.get("1")).toEqual({ n: 3, of: 3, latest: true });
    expect(v.has("3")).toBe(false);
  });
});

/** A signed-in app against a fake Hermes holding these chats and transcripts. */
async function signedIn(setup: (s: FakeHermes) => void) {
  const server = new FakeHermes();
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  return { server, hermes };
}

describe("indexing chats on a fake Hermes", () => {
  it("finds several files, keeps them across a reconnect with the same provenance, and makes no duplicates", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.sessions = [row("chat-a", 0, { title: "Report" })];
      s.transcripts["chat-a"] = [
        { role: "user", text: "Write the report and a chart", row_id: 1 },
        ...call("w1", "write_file", { path: "/srv/out/report.md", content: "# R" }, written("/srv/out/report.md", 3), 2),
        ...call("i1", "image_generate", { prompt: "chart" }, { success: true, image: "/srv/out/chart.png" }, 4),
        ...call("w2", "write_file", { path: "/srv/out/report.md", content: "# R2" }, written("/srv/out/report.md", 4), 6),
        { role: "assistant", text: "Done: /srv/out/report.md", row_id: 8 },
      ];
      s.serverFiles["/srv/out/report.md"] = "# R2";
      // Hermes saves images itself, on the dashboard's machine: the managed files routes list it.
      s.managedFiles.nodes = { "/srv/out/chart.png": { bytes: "\x89PNG" } };
    });
    const storage = memory();
    const index = new OutputsIndex(hermes.outputsIo("default"), storage, "scope");
    const chats = [{ id: "chat-a", updatedAt: 100 }];
    await index.index(chats);
    const found = outputsIn(index.getSnapshot());
    expect(found.map((o) => [o.path, o.how, o.callId, o.rowId]).sort()).toEqual([
      ["/srv/out/chart.png", "image", "i1", 5],
      ["/srv/out/report.md", "written", "w1", 3],
      ["/srv/out/report.md", "written", "w2", 7],
    ]);
    // Every request named the profile and asked for the newest rows, without inline images.
    const reads = server.restRequests.filter((r) => r.path.endsWith("/messages"));
    expect(reads.every((r) => r.query.get("profile") === "default" && r.query.get("order") === "latest" && r.query.get("inline_images") === "false")).toBe(true);

    await index.check(found);
    expect(outputsIn(index.getSnapshot()).map((o) => o.availability?.state)).toEqual(["available", "available", "available"]);
    expect(server.restRequests.filter((r) => r.path === "/api/files").map((r) => r.query.get("path"))).toEqual(["/srv/out"]);
    expect(server.restRequests.filter((r) => r.path === "/api/fs/list").map((r) => r.query.get("path"))).toEqual(["/srv/out"]);

    // Reconnect, then a new run with the chat changed: the same keys, and nothing twice.
    server.drop();
    await hermes.reconnect();
    expect(hermes.getSnapshot().status).toBe("connected");
    const again = new OutputsIndex(hermes.outputsIo("default"), storage, "scope");
    expect(outputsIn(again.getSnapshot())).toEqual(outputsIn(index.getSnapshot()));
    await again.index([{ id: "chat-a", updatedAt: 200 }]);
    const keys = outputsIn(again.getSnapshot()).map((o) => o.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.sort()).toEqual(found.map((o) => o.key).sort());
    // The availability already known for a path is kept.
    expect(outputsIn(again.getSnapshot()).every((o) => o.availability?.state === "available")).toBe(true);
  });

  it("doesn't read an unchanged chat again, and reads it again when forced", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.transcripts["c"] = call("w", "write_file", { path: "/a" }, written("/srv/a.txt"), 1);
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "c", updatedAt: 1 }]);
    const reads = () => server.restRequests.filter((r) => r.path.endsWith("/messages")).length;
    const n = reads();
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(reads()).toBe(n);
    await index.index([{ id: "c", updatedAt: 1 }], true);
    expect(reads()).toBeGreaterThan(n);
  });

  it("reads at most the newest rows per chat, and says older ones weren't read", async () => {
    const { hermes } = await signedIn((s) => {
      s.transcripts["long"] = Array.from({ length: MAX_ROWS_PER_CHAT + 50 }, (_, i) => ({ role: "user" as const, text: `m${i}`, row_id: i + 1 }));
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "long", updatedAt: 1 }]);
    expect(index.getSnapshot().chats.long.partial).toEqual({ olderRows: true });
  });

  it("reads a page too big in smaller pages, and skips a single row too big to read", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const { hermes } = await signedIn((s) => {
      s.transcripts["c"] = [
        ...call("w", "write_file", { path: "/a" }, written("/srv/kept.txt"), 1),
        { role: "tool", name: "read_file", tool_call_id: "r", row_id: 3, result: big },
        ...call("w2", "write_file", { path: "/b" }, written("/srv/also.txt"), 4),
      ];
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    await index.index([{ id: "c", updatedAt: 1 }]);
    const c = index.getSnapshot().chats.c;
    expect(c.outputs.map((o) => o.path).sort()).toEqual(["/srv/also.txt", "/srv/kept.txt"]);
    expect(c.partial).toEqual({ bigRows: 1 });
  });

  it("indexes the most recent chats first, at most a run's worth, and says how many wait", async () => {
    const { hermes } = await signedIn(() => {});
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "scope");
    const chats = Array.from({ length: MAX_CHATS_PER_RUN + 3 }, (_, i) => ({ id: `c${i}`, updatedAt: i }));
    await index.index(chats);
    const snap = index.getSnapshot();
    expect(Object.keys(snap.chats)).toHaveLength(MAX_CHATS_PER_RUN);
    expect(snap.chats.c0).toBeUndefined();
    expect(snap.waiting).toBe(3);
  });

  it("drops what a cancelled run reads, as when the profile changes during a fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const io: OutputsIo = {
      rows: async () => {
        await gate;
        return page([{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify(written("/srv/late.txt")) }]);
      },
      listDir: async () => ({ entries: [] }),
    };
    const storage = memory();
    const index = new OutputsIndex(io, storage, "work-profile");
    const run = index.index([{ id: "c", updatedAt: 1 }]);
    expect(index.getSnapshot().indexing).toEqual({ done: 0, total: 1 });
    index.cancel();
    release();
    await run;
    expect(index.getSnapshot().chats).toEqual({});
    expect(index.getSnapshot().indexing).toBeUndefined();
    expect(storage.m.get(OUTPUTS_KEY)).toBeUndefined();
  });

  it("says when the server has no stored-messages route", async () => {
    const { server, hermes } = await signedIn(() => {});
    server.transcripts = {};
    const io = hermes.outputsIo("default");
    const index = new OutputsIndex({ ...io, rows: () => Promise.reject(new RestError(404, '{"detail":"Not Found"}')) }, memory(), "s");
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(index.getSnapshot().unsupported).toMatch(/can't list a chat's stored messages/);
  });
});

describe("checking where files are", () => {
  it("tells available, missing, renamed, a folder now, a gone folder and a forbidden one apart, one listing per folder", async () => {
    const { server, hermes } = await signedIn((s) => {
      s.serverFiles["/srv/out/kept.txt"] = "k";
      s.serverFiles["/srv/out/renamed-to.txt"] = "r";
      s.serverDirs.add("/srv/out/dir.txt");
      s.serverDirs.add("/srv/out");
    });
    const io = hermes.outputsIo("default");
    server.rest["GET /api/fs/list"] = ((list) => (req) => (req.query.get("path") === "/locked" ? { entries: [], error: "EACCES" } : list(req)))(server.rest["GET /api/fs/list"]);
    const paths = ["/srv/out/kept.txt", "/srv/out/renamed-from.txt", "/srv/out/dir.txt", "/srv/gone/x.txt", "/locked/x.txt"];
    const found = await checkPaths(io, paths.map((path) => ({ path })), 5);
    expect(Object.fromEntries([...found].map(([p, a]) => [p, a.state]))).toEqual({
      "tools:/srv/out/kept.txt": "available",
      "tools:/srv/out/renamed-from.txt": "missing",
      "tools:/srv/out/dir.txt": "folder",
      "tools:/srv/gone/x.txt": "missing",
      "tools:/locked/x.txt": "forbidden",
    });
    expect(server.restRequests.filter((r) => r.path === "/api/fs/list").map((r) => r.query.get("path"))).toEqual(["/srv/out", "/srv/gone", "/locked"]);
  });

  it("checks after reading, and a refresh replaced meanwhile doesn't check or cancel the newer one's check (#223)", async () => {
    const gates = new Map<string, () => void>();
    const listed: string[] = [];
    const io: OutputsIo = {
      rows: (chatId) =>
        new Promise((resolve) =>
          gates.set(chatId, () => resolve(page([{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: chatId, content: JSON.stringify(written(`/srv/${chatId}/gone.sh`)) }]))),
        ),
      listDir: (path) => (listed.push(path), new Promise((resolve) => gates.set(path, () => resolve({ entries: [] })))),
    };
    const index = new OutputsIndex(io, memory(), "s");
    const shown = (chat: string) => (s: OutputsSnapshot) => outputsIn(s, new Set([chat]));
    const old = index.refresh([{ id: "a", updatedAt: 1 }], false, shown("a"));
    const now = index.refresh([{ id: "b", updatedAt: 1 }], false, shown("b"));
    // The newer refresh is checking its folder when the one it replaced finishes reading.
    gates.get("b")!();
    await vi.waitFor(() => expect(gates.has("/srv/b")).toBe(true));
    gates.get("a")!();
    await old;
    gates.get("/srv/b")!();
    await now;
    expect(listed).toEqual(["/srv/b"]);
    expect(outputsIn(index.getSnapshot(), new Set(["b"]))[0].availability?.state).toBe("missing");
  });

  it("keeps a failed read's error on screen and doesn't check after it (#223)", async () => {
    const listed: string[] = [];
    const io: OutputsIo = { rows: () => Promise.reject(new RestError(500, '{"detail":"boom"}')), listDir: async (p) => (listed.push(p), { entries: [] }) };
    const index = new OutputsIndex(io, memory(), "s");
    await index.refresh([{ id: "c", updatedAt: 1 }], false, (s) => outputsIn(s));
    expect(index.getSnapshot().error).toMatch(/Couldn't read a chat's messages.*500/);
    expect(listed).toEqual([]);
  });

  it("reports a refused listing as forbidden and another failure as unknown", async () => {
    const io = (err: Error): OutputsIo => ({ rows: async () => page([]), listDir: () => Promise.reject(err) });
    expect((await checkPaths(io(new RestError(403, '{"detail":"Access denied"}')), [{ path: "/a/b" }])).get("tools:/a/b")?.state).toBe("forbidden");
    expect((await checkPaths(io(new Error("Can't reach the Hermes dashboard")), [{ path: "/a/b" }])).get("tools:/a/b")).toMatchObject({ state: "unknown", why: "Can't reach the Hermes dashboard" });
  });

  it("adds a Server file the owner names only once it is there", async () => {
    const { hermes } = await signedIn((s) => {
      s.serverFiles["/srv/hand/picked.csv"] = "a,b";
      s.serverDirs.add("/srv/hand/sub");
    });
    const index = new OutputsIndex(hermes.outputsIo("default"), memory(), "s");
    await expect(index.add("relative.csv")).rejects.toThrow(/full path/);
    await expect(index.add("/srv/hand/nope.csv")).rejects.toThrow(/deleted, moved or renamed|isn't on the server/);
    await expect(index.add("/srv/hand/sub")).rejects.toThrow(/folder/);
    const added = await index.add(" /srv/hand/picked.csv ", "chat-1");
    expect(added).toMatchObject({ path: "/srv/hand/picked.csv", how: "added", chatId: "chat-1", availability: { state: "available" } });
    await expect(index.add("/srv/hand/picked.csv", "chat-1")).rejects.toThrow(/already/);
    expect(outputsIn(index.getSnapshot(), new Set(["chat-1"]))).toHaveLength(1);
    expect(outputsIn(index.getSnapshot(), new Set(["chat-2"]))).toHaveLength(0);
    index.remove(added.key);
    expect(index.getSnapshot().added).toEqual([]);
  });
});

describe("what this computer keeps", () => {
  it("keeps each connection and profile apart, holds metadata only, and survives a hand-edited document", async () => {
    const storage = memory();
    const io: OutputsIo = {
      rows: async () => page([{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: "w", content: JSON.stringify({ ...written("/srv/a.md"), content: "SECRET BODY" }) }]),
      listDir: async () => ({ entries: [] }),
    };
    await new OutputsIndex(io, storage, "conn|default").index([{ id: "c", updatedAt: 1 }]);
    expect(readScope(storage, "conn|work").chats).toEqual({});
    expect(Object.keys(readScope(storage, "conn|default").chats)).toEqual(["c"]);
    expect(storage.m.get(OUTPUTS_KEY)).not.toContain("SECRET BODY");

    storage.m.set(OUTPUTS_KEY, JSON.stringify({ v: 2, scopes: { s: { chats: { c: { updatedAt: 1, outputs: [{ key: "k", path: "relative", how: "written" }, { key: "k2", path: "/ok", how: "nope" }] } } } } }));
    expect(readScope(storage, "s").chats.c.outputs).toEqual([]);
    storage.m.set(OUTPUTS_KEY, "{not json");
    expect(readScope(storage, "s")).toMatchObject({ chats: {}, added: [] });
  });

  it("drops the chats indexed longest ago past the limit, and says when storage refuses", async () => {
    const storage = memory();
    let t = 0;
    const perChat = 1000;
    const io: OutputsIo = {
      rows: async (chatId, offset) =>
        page(offset ? [] : Array.from({ length: perChat }, (_, i) => ({ id: i + 1, role: "tool", tool_name: "write_file", tool_call_id: `${chatId}-${i}`, content: JSON.stringify(written(`/srv/${chatId}/${i}.txt`)) }))),
      listDir: async () => ({ entries: [] }),
    };
    const index = new OutputsIndex(io, storage, "s", () => ++t);
    await index.index([{ id: "old", updatedAt: 3 }, { id: "mid", updatedAt: 2 }, { id: "new", updatedAt: 1 }, { id: "newest", updatedAt: 0 }]);
    const kept = readScope(storage, "s");
    const total = Object.values(kept.chats).reduce((n, c) => n + c.outputs.length, 0);
    expect(total).toBeLessThanOrEqual(OUTPUTS_KEPT);
    // The oldest-read chat keeps its entry, without its Outputs, so it isn't read again round and round.
    expect(kept.chats.old).toMatchObject({ outputs: [], partial: { evicted: true } });

    const full = new OutputsIndex(io, memory(true), "s");
    await full.index([{ id: "c", updatedAt: 1 }]);
    expect(full.getSnapshot().notSaved).toBe(true);
    expect(outputsIn(full.getSnapshot())).toHaveLength(perChat);
  });
});

describe("the review's cases", () => {
  it("keeps the files a patch created before it failed part-way", () => {
    expect(producedBy("patch", JSON.stringify({ success: false, error: "hunk 2 failed", files_created: ["/srv/new.ts"], files_modified: [] }))).toEqual([
      { path: "/srv/new.ts", how: "created" },
    ]);
  });

  it("puts text_to_speech audio and a local image on the dashboard's machine, and a workspace image where the tools run", () => {
    expect(producedBy("text_to_speech", JSON.stringify({ success: true, file_path: "/h/.hermes/audio/a.mp3" }))).toEqual([{ path: "/h/.hermes/audio/a.mp3", how: "speech", host: true }]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "/h/.hermes/cache/images/c.png" }))).toEqual([{ path: "/h/.hermes/cache/images/c.png", how: "image", host: true }]);
    expect(producedBy("image_generate", JSON.stringify({ success: true, image: "/h/.hermes/cache/images/c.png", host_image: "/h/.hermes/cache/images/c.png", agent_visible_image: "~/.hermes/cache/images/c.png" }))).toEqual([
      { path: "~/.hermes/cache/images/c.png", how: "image" },
    ]);
  });

  it("checks a file on the dashboard's machine with that machine's listing", async () => {
    const calls: [string, boolean | undefined][] = [];
    const io: OutputsIo = {
      rows: async () => page([]),
      listDir: async (path, host) => {
        calls.push([path, host]);
        return { entries: host ? [{ name: "a.mp3", isDirectory: false }] : [] };
      },
    };
    const found = await checkPaths(io, [{ path: "/h/audio/a.mp3", host: true }, { path: "/h/audio/a.mp3" }]);
    expect(calls).toEqual([["/h/audio", true], ["/h/audio", false]]);
    expect(found.get("host:/h/audio/a.mp3")?.state).toBe("available");
    expect(found.get("tools:/h/audio/a.mp3")?.state).toBe("missing");
  });

  it("holds only the fields it needs from each page, not a patch's diff or a written file's contents", () => {
    const rows = compactRows([
      { id: 1, role: "assistant", tool_calls: JSON.stringify([{ id: "w", function: { name: "write_file", arguments: JSON.stringify({ path: "/srv/a", content: "BODY".repeat(1000) }) } }, { id: "t", function: { name: "terminal", arguments: "{}" } }]) },
      { id: 2, role: "tool", tool_name: "patch", tool_call_id: "p", content: JSON.stringify({ success: true, diff: "DIFF".repeat(1000), files_created: ["/srv/b"] }) },
      { id: 3, role: "tool", tool_name: "read_file", tool_call_id: "r", content: "CONTENTS".repeat(1000) },
      { id: 4, role: "user", content: "hello" },
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/BODY|DIFF|CONTENTS|hello|terminal/);
    expect(outputsFromRows("c", rows).outputs.map((o) => o.path)).toEqual(["/srv/b"]);
  });

  it("stops reading a chat once its byte budget is spent, and says older rows weren't read", async () => {
    let reads = 0;
    const io: OutputsIo = {
      rows: async (_c, _o, limit) => {
        reads++;
        return { rows: Array.from({ length: limit }, (_, i) => ({ id: i, role: "user" })), bytes: 3.9 * 1024 * 1024 };
      },
      listDir: async () => ({ entries: [] }),
    };
    const index = new OutputsIndex(io, memory(), "s");
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(reads).toBeLessThanOrEqual(Math.ceil(CHAT_MAX_BYTES / (3.9 * 1024 * 1024)));
    expect(index.getSnapshot().chats.c.partial).toMatchObject({ olderRows: true });
  });

  it("keeps the newest Outputs of a chat that made too many, and bounds what is shown as well as what is kept", async () => {
    const many = (chatId: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, role: "tool", tool_name: "write_file", tool_call_id: `${chatId}-${i}`, content: JSON.stringify(written(`/srv/${chatId}/${i}.txt`)) }));
    const io: OutputsIo = { rows: async (chatId, offset) => page(offset ? [] : many(chatId, OUTPUTS_PER_CHAT + 5)), listDir: async () => ({ entries: [] }) };
    let t = 0;
    const index = new OutputsIndex(io, memory(), "s", () => ++t);
    await index.index(Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, updatedAt: i })));
    const snap = index.getSnapshot();
    expect(outputsIn(snap).length).toBeLessThanOrEqual(OUTPUTS_KEPT);
    const kept = Object.values(snap.chats).find((c) => c.outputs.length)!;
    expect(kept.outputs).toHaveLength(OUTPUTS_PER_CHAT);
    expect(kept.partial).toMatchObject({ tooMany: true });
    expect(kept.outputs.some((o) => o.rowId === OUTPUTS_PER_CHAT + 5)).toBe(true);
  });

  it("refuses more added files than it keeps", async () => {
    const io: OutputsIo = { rows: async () => page([]), listDir: async () => ({ entries: Array.from({ length: ADDED_MAX + 1 }, (_, i) => ({ name: `f${i}`, isDirectory: false })) }) };
    const index = new OutputsIndex(io, memory(), "s");
    for (let i = 0; i < ADDED_MAX; i++) await index.add(`/srv/f${i}`);
    await expect(index.add(`/srv/f${ADDED_MAX}`)).rejects.toThrow(/up to 200/);
    expect(index.getSnapshot().added).toHaveLength(ADDED_MAX);
  });

  it("never lets an index left behind overwrite what a newer one for the same profile kept", async () => {
    const storage = memory();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: OutputsIo = {
      rows: async () => page([]),
      listDir: async () => {
        await gate;
        return { entries: [{ name: "old.txt", isDirectory: false }, { name: "new.txt", isDirectory: false }] };
      },
    };
    const old = new OutputsIndex(slow, storage, "s");
    const adding = old.add("/srv/old.txt");
    const refreshing = old.check([{ key: "k", path: "/srv/old.txt", how: "written" }]);
    old.cancel();
    const fresh = new OutputsIndex({ ...slow, listDir: async () => ({ entries: [{ name: "new.txt", isDirectory: false }] }) }, storage, "s");
    await fresh.add("/srv/new.txt");
    release();
    await expect(adding).rejects.toThrow(/another profile/);
    await refreshing;
    // A cancelled index starts nothing new either, as a Refresh's check after its run.
    await old.check([{ key: "k", path: "/srv/old.txt", how: "written" }]);
    await old.index([{ id: "c", updatedAt: 1 }]);
    expect(readScope(storage, "s").added.map((o) => o.path)).toEqual(["/srv/new.txt"]);
  });

  it("finishes reading every chat even when their Outputs don't all fit, and reads a dropped chat again when it is opened", async () => {
    let reads = 0;
    const io: OutputsIo = {
      rows: async (chatId, offset) => {
        if (!offset) reads++;
        return page(offset ? [] : Array.from({ length: OUTPUTS_PER_CHAT }, (_, i) => ({ id: i + 1, role: "tool", tool_name: "write_file", tool_call_id: `${chatId}-${i}`, content: JSON.stringify(written(`/srv/${chatId}/${i}.txt`)) })));
      },
      listDir: async () => ({ entries: [] }),
    };
    let t = 0;
    const index = new OutputsIndex(io, memory(), "s", () => ++t);
    const chats = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, updatedAt: i }));
    await index.index(chats);
    expect(reads).toBe(6);
    await index.index(chats);
    await index.index(chats);
    expect(reads).toBe(6);
    expect(Object.keys(index.getSnapshot().chats)).toHaveLength(6);
    const dropped = Object.entries(index.getSnapshot().chats).find(([, c]) => c.partial?.evicted)![0];
    await index.index([chats.find((c) => c.id === dropped)!], false, true);
    expect(reads).toBe(7);
    expect(index.getSnapshot().chats[dropped].outputs).toHaveLength(OUTPUTS_PER_CHAT);
  });

  it("reads a version 1 document's chats again, since it kept no machine, and keeps the files the owner added", () => {
    const storage = memory();
    const image = { key: "k", chatId: "c", path: "/h/cat.png", how: "image", availability: { state: "missing", checkedAt: 1 } };
    const added = { key: "a", path: "/srv/x.csv", how: "added" };
    storage.m.set(OUTPUTS_KEY, JSON.stringify({ v: 1, scopes: { s: { chats: { c: { updatedAt: 5, indexedAt: 1, outputs: [image] } }, added: [added], usedAt: 1 } } }));
    const read = readScope(storage, "s");
    expect(read.chats).toEqual({});
    expect(read.added.map((o) => o.path)).toEqual(["/srv/x.csv"]);
  });

  it("spends the byte budget on pages it was refused, so an endless run of oversized rows stops", async () => {
    let calls = 0;
    const io: OutputsIo = {
      rows: async () => {
        calls++;
        throw new Error("it's 5.0 MB now, over the 4 MB limit");
      },
      listDir: async () => ({ entries: [] }),
    };
    const index = new OutputsIndex(io, memory(), "s");
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(calls).toBeLessThanOrEqual(CHAT_MAX_BYTES / (4 * 1024 * 1024));
    expect(index.getSnapshot().chats.c.partial).toMatchObject({ olderRows: true });
  });

  it("doesn't call files on two machines two versions of one", () => {
    const v = versions([
      { key: "1", path: "/tmp/chart.png", how: "image", host: true, at: 1 },
      { key: "2", path: "/tmp/chart.png", how: "written", at: 2 },
    ]);
    expect(v.size).toBe(0);
  });

  it("doesn't add a file whose check began before the index was let go, even once it is taken up again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const storage = memory();
    const index = new OutputsIndex({ rows: async () => page([]), listDir: async () => (await gate, { entries: [{ name: "x.csv", isDirectory: false }] }) }, storage, "s");
    const adding = index.add("/srv/x.csv");
    index.cancel();
    index.resume();
    release();
    await expect(adding).rejects.toThrow(/another profile/);
    expect(index.getSnapshot().added).toEqual([]);
  });

  it("reads every chat of a long list once, a run at a time, with Outputs or without, and never one twice", async () => {
    const reads = new Map<string, number>();
    const io: OutputsIo = {
      rows: async (chatId, offset) => {
        if (!offset) reads.set(chatId, (reads.get(chatId) ?? 0) + 1);
        // Every third chat made a file; the rest made none.
        const n = Number(chatId.slice(1));
        return page(offset || n % 3 ? [] : [{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: chatId, content: JSON.stringify(written(`/srv/${chatId}.txt`)) }]);
      },
      listDir: async () => ({ entries: [] }),
    };
    let t = 0;
    const index = new OutputsIndex(io, memory(), "s", () => ++t);
    const chats = Array.from({ length: 2030 }, (_, i) => ({ id: `c${i}`, updatedAt: 2030 - i }));
    const runs = Math.ceil(chats.length / MAX_CHATS_PER_RUN);
    for (let run = 0; run < runs + 3; run++) await index.index(chats);
    expect(reads.size).toBe(chats.length);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
    expect(index.getSnapshot().waiting).toBe(0);
    // Records go only with the chats themselves.
    index.keepOnly(new Set(chats.slice(0, 100).map((c) => c.id)));
    expect(Object.keys(index.getSnapshot().chats)).toHaveLength(100);
    // Indexing 2,030 chats takes 4–7 s on a busy runner, past the 5 s default.
  }, 30_000);

  it("forgets chats no longer in the profile's list, and keeps the files the owner added", async () => {
    const io: OutputsIo = {
      rows: async (chatId) => page([{ id: 1, role: "tool", tool_name: "write_file", tool_call_id: chatId, content: JSON.stringify(written(`/srv/${chatId}.txt`)) }]),
      listDir: async () => ({ entries: [{ name: "kept.csv", isDirectory: false }] }),
    };
    const storage = memory();
    const index = new OutputsIndex(io, storage, "s");
    await index.index([{ id: "a", updatedAt: 1 }, { id: "deleted", updatedAt: 1 }]);
    await index.add("/srv/kept.csv");
    index.keepOnly(new Set(["a"]));
    expect(Object.keys(index.getSnapshot().chats)).toEqual(["a"]);
    expect(Object.keys(readScope(storage, "s").chats)).toEqual(["a"]);
    expect(index.getSnapshot().added).toHaveLength(1);
  });

  it("tries a smaller page with what is left of the budget instead of stopping at the first refusal", async () => {
    const limits: number[] = [];
    const io: OutputsIo = {
      rows: async (_c, offset, limit, max) => {
        limits.push(max);
        // 14 pages of 4 MiB and one of 2 MiB spend 58 MiB. The next 100-row page is refused, leaving 2 MiB, and a
        // smaller page holding a file fits in it.
        if (offset < 1500) return { rows: Array.from({ length: limit }, (_, i) => ({ id: offset + i, role: "user" })), bytes: (offset < 1400 ? 4 : 2) * 1024 * 1024 };
        if (limit > 20) throw new Error("it's 4.0 MB now, over the 4 MB limit");
        return page([{ id: 9999, role: "tool", tool_name: "write_file", tool_call_id: "late", content: JSON.stringify(written("/srv/late.txt")) }]);
      },
      listDir: async () => ({ entries: [] }),
    };
    const index = new OutputsIndex(io, memory(), "s");
    await index.index([{ id: "c", updatedAt: 1 }]);
    expect(index.getSnapshot().chats.c.outputs.map((o) => o.path)).toEqual(["/srv/late.txt"]);
    expect(Math.min(...limits)).toBeGreaterThan(0);
  });
});
