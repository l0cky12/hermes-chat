// Backup and restore (backup.ts, ADR 0038): real-shaped data round-trips with its scope; damaged, cut-short and
// newer backups are refused before anything is written; places are mapped, never guessed; merge keeps this
// computer's on a conflict and replace takes the backup's; a category is written whole or not at all; and nothing
// is written without a recovery backup.
import { describe, expect, it } from "vitest";
import {
  BackupError,
  applyRestore,
  connOf,
  placesOf,
  defaultMapping,
  loadCurrent,
  makeBackup,
  planRestore,
  readBackup,
  RESTORED_PAUSE,
  restoreBlocked,
  CATEGORY_IDS,
  type BackupEnv,
  type Entry,
  type Policy,
} from "./backup";
import { draftKey, drafts } from "./drafts";
import { projectScope } from "./projectLinks";
import { sha256 } from "./importTranscripts";
import { migrateUIPrefs, readUIPrefs, UI_PREFS_VERSION } from "./uiPrefs";
import { storageDefaultsFile } from "./projectDefaults";

/** A Storage in memory. `quota`: how many more writes succeed before it is full. */
class MemStorage implements Storage {
  m = new Map<string, string>();
  quota = Infinity;
  /** The most characters, keys and values, it holds: like a browser's byte quota. */
  limit = Infinity;
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    const used = [...this.m].reduce((n, [key, val]) => n + (key === k ? 0 : key.length + val.length), 0);
    if (this.quota-- <= 0 || used + k.length + String(v).length > this.limit) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

/** A swapped file as defaults_file.rs keeps it. `race`: another instance writes just before the next swap. */
function file() {
  const f = {
    text: null as string | null,
    race: undefined as string | undefined,
    read: async () => f.text,
    swap: async (expected: string | null, next: string) => {
      if (f.race !== undefined) (f.text = f.race), (f.race = undefined);
      if (f.text !== expected) return { swapped: false, current: f.text };
      f.text = next;
      return { swapped: true, current: next };
    },
  };
  return f;
}

const conn = { mode: "ssh" as const, sshTarget: "liam@hermes.lan", url: "", username: "liam" };
const moved = { mode: "url" as const, sshTarget: "", url: "https://hermes.example.com", username: "liam" };

function env(): BackupEnv & { storage: MemStorage; tags: ReturnType<typeof file>; defaults: ReturnType<typeof file> } {
  return { storage: new MemStorage(), tags: file(), defaults: file() };
}

/** What a computer that has been used for a while keeps: two profiles, every category. */
async function populated() {
  const e = env();
  const s = e.storage;
  const d = drafts(s);
  d.set(draftKey(conn, "default", "chat-a"), "Half a question about the backup job");
  d.set(draftKey(conn, "default", null), "A new chat I haven't started");
  d.set(draftKey(conn, "work", "chat-w"), "Work draft");
  // Keyed as chatCache.ts keys them (it writes the webview's own localStorage).
  s.setItem(key("queue", "default", "chat-a"), JSON.stringify({
    items: [
      { id: "q1", text: "Then run the tests", attachments: [{ path: "/home/liam/.local/share/shot.png", name: "shot.png", size: 10, kind: "image" }] },
      { id: "q2", text: "", attachments: [{ path: "/tmp/only-a-file.txt", name: "f", size: 1, kind: "file" }] },
    ],
  }));
  s.setItem(key("branches", "default"), JSON.stringify({
    links: { "chat-b": { parentId: "chat-a", parentTitle: "Backup job", point: { role: "user", excerpt: "Half a question", rowId: 3 }, at: 1_700_000_000_000 } },
    attempts: [],
  }));
  const scope = projectScope(conn, "default");
  s.setItem("hermes-chat.projects", JSON.stringify({ v: 1, scopes: { [scope]: { selected: "proj-1", chats: { "proj-1": ["chat-a", "chat-b"] }, known: [] } } }));
  e.tags.text = JSON.stringify({
    v: 1,
    scopes: { [scope]: { tags: [{ id: "t1", name: "Urgent" }], chats: { "chat-a": ["t1"] }, filters: [{ id: "f1", name: "Urgent chats", filter: { tags: ["t1"] } }] } },
  });
  e.defaults.text = JSON.stringify({ v: 1, scopes: { [scope]: { "proj-1": { rev: 2, instructions: "Answer in British English.", folder: "/srv/proj" } } } });
  s.setItem(
    "hermes-ui-prefs",
    JSON.stringify({
      v: 1,
      theme: "dark",
      checkUpdatesOnLaunch: false,
      terminalKind: "local",
      lastOpenChat: { default: "chat-a" },
      templates: [
        { id: "tpl-1", name: "Port check", description: "", body: "Is {host}:{port=22} open?" },
        { id: "tpl-2", name: "Project note", description: "", body: "Note for {what}", project: { scope, id: "proj-1", name: "Backups" } },
      ],
    }),
  );
  s.setItem("hermes-chat.appearance", JSON.stringify({ scheme: "dark", uiSize: 15 }));
  s.setItem("hermes-chat.terminal-target", "liam@hermes.lan");
  // Not part of a backup: a sign-in, a Saved copy, and a Failed message.
  s.setItem("hermes-chat.sign-in", JSON.stringify(conn));
  s.setItem(key("transcript", "default", "chat-a"), '{"savedAt":1}');
  s.setItem(key("outbox", "default", "chat-a"), "[]");
  return e;
}

function key(kind: string, profile: string, chatId?: string, c: typeof conn | typeof moved = conn) {
  const target = c.mode === "ssh" ? c.sshTarget : c.url;
  return `hermes-chat.${kind}.${JSON.stringify([c.mode, target, c.username, profile, ...(chatId ? [chatId] : [])])}`;
}

const all = (p: Policy) => Object.fromEntries(CATEGORY_IDS.map((id) => [id, p]));
const ok = async () => "/recovery.zip";

async function restore(entries: Entry[], into: BackupEnv, target = conn, profiles = ["default", "work"], policy: Policy = "merge") {
  const backup = await readBackup(entries);
  const mapping = defaultMapping(backup, connOf(target), profiles);
  const plan = planRestore(backup, await loadCurrent(into), connOf(target), mapping, all(policy));
  return { backup, mapping, plan, report: await applyRestore(into, plan, ok) };
}

describe("a backup", () => {
  it("holds every category, with no credential, sign-in or cached chat", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    // The data files; the manifest names what's left out, in words.
    const text = entries.slice(1).map((e) => e.text).join("\n");
    expect(entries.map((e) => e.name)).toEqual([
      "manifest.json",
      "settings.json",
      "templates.json",
      "drafts.json",
      "queues.json",
      "projects.json",
      "project-defaults.json",
      "tags.json",
      "branches.json",
    ]);
    const manifest = JSON.parse(entries[0].text);
    expect(manifest).toMatchObject({ format: "hermes-chat-backup", schema: 1 });
    expect(Object.values(manifest.places)).toEqual([
      { mode: "ssh", target: "liam@hermes.lan", username: "liam", profile: "default" },
      { mode: "ssh", target: "liam@hermes.lan", username: "liam", profile: "work" },
    ]);
    expect(manifest.files.drafts).toMatchObject({ file: "drafts.json", records: 3, sha256: await sha256(entries[3].text) });
    // The queue's text goes, its files don't; a message that was only a file is left out.
    expect(text).not.toContain("shot.png");
    expect(text).not.toContain("only-a-file");
    expect(text).not.toContain("savedAt");
    expect(text).not.toContain("sign-in");
    expect(text).not.toMatch(/password/i);
    // Each profile's chat to reopen is a copy of the server's list.
    expect(text).not.toContain("lastOpenChat");
  });

  it("round-trips to a fresh computer with each draft, membership and setting in its own place", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const fresh = env();
    const { report, mapping } = await restore(entries, fresh);
    expect(Object.values(mapping)).toEqual(["default", "work"]);
    expect(report.recovery).toBe("/recovery.zip");
    expect(report.outcomes.map((o) => [o.id, o.state])).toEqual(CATEGORY_IDS.map((id) => [id, "restored"]));

    const d = drafts(fresh.storage);
    expect(d.get(draftKey(conn, "default", "chat-a"))).toBe("Half a question about the backup job");
    expect(d.get(draftKey(conn, "default", null))).toBe("A new chat I haven't started");
    expect(d.get(draftKey(conn, "work", "chat-w"))).toBe("Work draft");
    expect(d.get(draftKey(conn, "work", "chat-a"))).toBe("");

    // Paused, so nothing goes on its own once the app loads it.
    expect(JSON.parse(fresh.storage.getItem(key("queue", "default", "chat-a"))!)).toEqual({ items: [{ id: "q1", text: "Then run the tests" }], paused: RESTORED_PAUSE });
    expect([...fresh.storage.m.keys()].filter((k) => k.startsWith("hermes-chat.queue."))).toHaveLength(1);
    expect(JSON.parse(fresh.storage.getItem(key("branches", "default"))!).links["chat-b"].parentId).toBe("chat-a");
    expect(fresh.storage.getItem(key("outbox", "default", "chat-a"))).toBeNull();

    const scope = projectScope(conn, "default");
    expect(JSON.parse(fresh.storage.getItem("hermes-chat.projects")!).scopes[scope].chats).toEqual({ "proj-1": ["chat-a", "chat-b"] });
    expect(JSON.parse(fresh.tags.text!).scopes[scope].tags).toEqual([{ id: "t1", name: "Urgent" }]);
    // A new revision, so an editor open elsewhere can't save over it unseen.
    expect(JSON.parse(fresh.defaults.text!).scopes[scope]["proj-1"]).toEqual({ rev: 3, instructions: "Answer in British English.", folder: "/srv/proj" });
    const prefs = JSON.parse(fresh.storage.getItem("hermes-ui-prefs")!);
    expect(prefs).toMatchObject({ theme: "dark", checkUpdatesOnLaunch: false, terminalKind: "local" });
    expect(prefs.templates.map((t: { id: string; project?: { scope: string } }) => [t.id, t.project?.scope])).toEqual([
      ["tpl-1", undefined],
      ["tpl-2", scope],
    ]);
    expect(JSON.parse(fresh.storage.getItem("hermes-chat.appearance")!)).toMatchObject({ scheme: "dark", uiSize: 15 });
    expect(fresh.storage.getItem("hermes-chat.terminal-target")).toBe("liam@hermes.lan");
    expect(fresh.storage.getItem("hermes-chat.sign-in")).toBeNull();

    // Restoring the same backup again changes nothing.
    const again = await restore(entries, fresh);
    expect(again.report.outcomes.every((o) => o.state === "unchanged")).toBe(true);
  });

  it("keeps a restored Reopen last chat on launch, whatever version the preferences here were stored at", async () => {
    const from = await populated();
    const prefs = JSON.parse(from.storage.getItem("hermes-ui-prefs")!);
    from.storage.setItem("hermes-ui-prefs", JSON.stringify({ ...prefs, v: UI_PREFS_VERSION, reopenLastChat: true }));
    const entries = await makeBackup(from, CATEGORY_IDS);
    // Nothing stored yet, a document from before version 5 (ADR 0162), and one from this version.
    for (const here of [undefined, { v: 4, theme: "light", reopenLastChat: false }, { v: UI_PREFS_VERSION, theme: "light" }]) {
      const into = env();
      if (here) into.storage.setItem("hermes-ui-prefs", JSON.stringify(here));
      await restore(entries, into, conn, ["default", "work"], "replace");
      const stored = JSON.parse(into.storage.getItem("hermes-ui-prefs")!);
      expect(stored.v).toBe(UI_PREFS_VERSION);
      expect(readUIPrefs(migrateUIPrefs(stored))).toMatchObject({ theme: "dark", reopenLastChat: true });
    }
  });

  it("goes to another connection only once the owner maps each place", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const fresh = env();
    const backup = await readBackup(entries);
    const target = connOf(moved);
    const mapping = defaultMapping(backup, target, ["default", "work"]);
    // Same profile names, but another connection: not guessed.
    expect(Object.values(mapping)).toEqual([undefined, undefined]);
    const current = await loadCurrent(fresh);
    const blocked = planRestore(backup, current, target, mapping, all("merge"));
    expect(blocked.problem).toMatch(/Choose where each/);
    await expect(applyRestore(fresh, blocked, ok)).rejects.toThrow(/Choose where each/);
    expect(fresh.storage.length).toBe(0);

    const [p1, p2] = Object.keys(backup.manifest.places);
    expect(planRestore(backup, current, target, { [p1]: "default", [p2]: "default" }, all("merge")).problem).toMatch(/same profile/);
    const plan = planRestore(backup, current, target, { [p1]: "default", [p2]: null }, all("merge"));
    expect(plan.problem).toBeUndefined();
    expect(plan.categories.find((c) => c.id === "drafts")!.skipped).toEqual([{ reason: "Their connection or profile isn't being restored", n: 1 }]);
    await applyRestore(fresh, plan, ok);
    const d = drafts(fresh.storage);
    expect(d.get(draftKey(moved, "default", "chat-a"))).toBe("Half a question about the backup job");
    expect(d.get(draftKey(moved, "work", "chat-w"))).toBe("");
    const prefs = JSON.parse(fresh.storage.getItem("hermes-ui-prefs")!);
    expect(prefs.templates.find((t: { id: string }) => t.id === "tpl-2").project.scope).toBe(projectScope(moved, "default"));
  });

  it("merges without overwriting newer data here, and replaces only when asked", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const here = env();
    const d = drafts(here.storage);
    d.set(draftKey(conn, "default", "chat-a"), "A newer draft typed on this computer");
    d.set(draftKey(conn, "default", "chat-z"), "Only here");
    const scope = projectScope(conn, "default");
    here.storage.setItem("hermes-chat.projects", JSON.stringify({ v: 1, scopes: { [scope]: { chats: { "proj-1": ["chat-c"] }, known: [] } } }));
    here.storage.setItem("hermes-ui-prefs", JSON.stringify({ v: 1, templates: [{ id: "mine", name: "port check", description: "", body: "Mine" }] }));

    const merged = await restore(entries, here);
    const drafted = merged.plan.categories.find((c) => c.id === "drafts")!;
    expect([drafted.add, drafted.kept, drafted.removed]).toEqual([2, 1, 0]);
    const tpl = merged.plan.categories.find((c) => c.id === "templates")!;
    expect(tpl.skipped).toEqual([{ reason: "One of the same name is already here", n: 1 }]);
    expect(drafts(here.storage).get(draftKey(conn, "default", "chat-a"))).toBe("A newer draft typed on this computer");
    expect(drafts(here.storage).get(draftKey(conn, "default", "chat-z"))).toBe("Only here");
    // Membership is combined, not chosen between.
    expect(JSON.parse(here.storage.getItem("hermes-chat.projects")!).scopes[scope].chats["proj-1"]).toEqual(["chat-c", "chat-a", "chat-b"]);

    const replaced = await restore(entries, here, conn, ["default", "work"], "replace");
    const r = replaced.plan.categories.find((c) => c.id === "drafts")!;
    expect([r.replaced, r.removed]).toEqual([1, 1]);
    expect(drafts(here.storage).get(draftKey(conn, "default", "chat-a"))).toBe("Half a question about the backup job");
    expect(drafts(here.storage).get(draftKey(conn, "default", "chat-z"))).toBe("");
  });

  it("leaves a category as it was when its write fails part way, and restores the rest", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const here = env();
    drafts(here.storage).set(draftKey(conn, "work", "chat-w"), "Kept");
    const backup = await readBackup(entries);
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), defaultMapping(backup, connOf(conn), ["default", "work"]), {
      ...all("skip"),
      settings: "merge",
      drafts: "replace",
      tags: "merge",
    });
    const before = new Map(here.storage.m);
    // Settings take 3 writes; drafts' second write fails.
    here.storage.quota = 4;
    const report = await applyRestore(here, plan, ok);
    expect(report.outcomes.filter((o) => o.state !== "skipped").map((o) => [o.id, o.state])).toEqual([
      ["settings", "restored"],
      ["drafts", "failed"],
      ["tags", "restored"],
    ]);
    // This store refuses every write once full, so the draft deleted to make room can't come back either, and the
    // report says so rather than claiming nothing changed (the recovery backup has it).
    const failed = report.outcomes.find((o) => o.id === "drafts")!;
    expect(failed.state === "failed" && failed.reason).toMatch(/refused it .*one item couldn't be put back as it was. The recovery backup has it/);
    expect(failed.state === "failed" && failed.changed).toBe(true);
    expect([...here.storage.m.keys()].filter((k) => k.startsWith("hermes-chat.draft.") && !before.has(k))).toEqual([]);
  });

  it("writes nothing of a category that changed after the preview, or anything without a recovery backup", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const here = env();
    const backup = await readBackup(entries);
    const mapping = defaultMapping(backup, connOf(conn), ["default", "work"]);
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), mapping, all("merge"));

    const none = await applyRestore(here, plan, async () => Promise.reject(new Error("No space left on device")));
    expect(none.recoveryError).toMatch(/No space left on device.*nothing was restored/);
    expect(none.outcomes.every((o) => o.state === "skipped")).toBe(true);
    expect(here.storage.length).toBe(0);
    expect(here.tags.text).toBeNull();

    // A draft typed in another window, and another instance's tags, after the preview.
    drafts(here.storage).set(draftKey(conn, "default", "chat-a"), "Typed meanwhile");
    here.tags.race = JSON.stringify({ v: 1, scopes: {} });
    const report = await applyRestore(here, plan, ok);
    const state = Object.fromEntries(report.outcomes.map((o) => [o.id, o.state]));
    expect(state).toMatchObject({ drafts: "failed", tags: "failed", settings: "restored", queues: "restored" });
    expect(drafts(here.storage).get(draftKey(conn, "default", "chat-a"))).toBe("Typed meanwhile");
    expect(drafts(here.storage).get(draftKey(conn, "default", null))).toBe("");
    expect(here.tags.text).toBe(JSON.stringify({ v: 1, scopes: {} }));
  });

  it("restores membership into this version's projects document and keeps its sync state, but not into one Hermes keeps", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const here = env();
    const scope = projectScope(conn, "default");
    const work = projectScope(conn, "work");
    const pending = [{ opId: "op-1", projectId: "proj-1", chatId: "chat-c", member: true, base: 0, at: 5 }];
    const recovery = { at: 4, chats: { "proj-1": ["chat-old"] } };
    here.storage.setItem(
      "hermes-chat.projects",
      JSON.stringify({ v: 2, scopes: { [scope]: { chats: { "proj-1": ["chat-c"] }, known: [], postponed: 3, pending, recovery } } }),
    );
    const merged = await restore(entries, here);
    expect(merged.report.outcomes.find((o) => o.id === "projects")!.state).toBe("restored");
    const doc = JSON.parse(here.storage.getItem("hermes-chat.projects")!);
    expect(doc.v).toBe(2);
    expect(doc.scopes[scope]).toMatchObject({ selected: "proj-1", chats: { "proj-1": ["chat-c", "chat-a", "chat-b"] }, postponed: 3, pending, recovery });

    // A backup holds the owner's grouping only, never the sync's bookkeeping.
    const again = await makeBackup(here, ["projects"]);
    const file = again.find((e) => e.name === "projects.json")!;
    expect(file.text).not.toMatch(/pending|recovery|postponed/);

    // Once membership is Hermes's, its chats here are Hermes's copy: a restore can't change them.
    const synced = { synced: { v: 1, at: 6 }, revision: 3, chats: { "proj-1": ["chat-h"] }, known: [] };
    const stored = JSON.stringify({ v: 2, scopes: { [scope]: synced, [work]: { chats: {}, known: [] } } });
    here.storage.setItem("hermes-chat.projects", stored);
    const refused = await restore(entries, here);
    const p = refused.report.outcomes.find((o) => o.id === "projects")!;
    expect(p.state === "failed" && p.reason).toMatch(/Hermes keeps/);
    expect(here.storage.getItem("hermes-chat.projects")).toBe(stored);
  });

  it("leaves a document a newer app wrote alone", async () => {
    const entries = await makeBackup(await populated(), CATEGORY_IDS);
    const here = env();
    here.tags.text = JSON.stringify({ v: 9, scopes: {} });
    const { report } = await restore(entries, here);
    const tags = report.outcomes.find((o) => o.id === "tags")!;
    expect(tags.state === "failed" && tags.reason).toMatch(/newer version/);
    expect(here.tags.text).toBe(JSON.stringify({ v: 9, scopes: {} }));
  });
});

describe("review round 1 regressions", () => {
  it("puts every original back when a write runs out of room, even after deleting one to make room", async () => {
    const theirs = env();
    drafts(theirs.storage).set(draftKey(conn, "default", "y"), "y".repeat(400));
    drafts(theirs.storage).set(draftKey(conn, "default", "z"), "z".repeat(400));
    const backup = await readBackup(await makeBackup(theirs, ["drafts"]));
    const here = env();
    drafts(here.storage).set(draftKey(conn, "default", "x"), "x".repeat(700));
    const before = new Map(here.storage.m);
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), defaultMapping(backup, connOf(conn), ["default"]), { drafts: "replace" });
    // Room for the original, or for one of the backup's drafts after deleting it, but not for both of the backup's.
    here.storage.limit = [...before].reduce((n, [k, v]) => n + k.length + v.length, 0) + 100;
    const report = await applyRestore(here, plan, ok);
    const drafted = report.outcomes.find((o) => o.id === "drafts")!;
    expect(drafted.state === "failed" && drafted.reason).toMatch(/none of it was written/);
    expect(here.storage.m).toEqual(before);
  });

  it("puts back values that swapped sizes, whatever order the write failed in", async () => {
    const theirs = env();
    drafts(theirs.storage).set(draftKey(conn, "default", "a"), "a".repeat(10));
    drafts(theirs.storage).set(draftKey(conn, "default", "b"), "b".repeat(700));
    drafts(theirs.storage).set(draftKey(conn, "default", "c"), "c".repeat(400));
    const backup = await readBackup(await makeBackup(theirs, ["drafts"]));
    const here = env();
    drafts(here.storage).set(draftKey(conn, "default", "a"), "A".repeat(700));
    drafts(here.storage).set(draftKey(conn, "default", "b"), "B".repeat(10));
    const before = new Map(here.storage.m);
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), defaultMapping(backup, connOf(conn), ["default"]), { drafts: "replace" });
    here.storage.limit = [...before].reduce((n, [k, v]) => n + k.length + v.length, 0) + 100;
    const report = await applyRestore(here, plan, ok);
    const drafted = report.outcomes.find((o) => o.id === "drafts")!;
    expect(drafted.state === "failed" && [drafted.reason, drafted.changed]).toEqual([expect.stringMatching(/none of it was written/), undefined]);
    expect(here.storage.m).toEqual(before);
  });

  it("backs up a long draft whole, and the recovery backup keeps what an export would drop", async () => {
    const here = env();
    drafts(here.storage).set(draftKey(conn, "default", "long"), "a".repeat(250_000));
    here.storage.setItem(key("queue", "default", "files-only"), JSON.stringify({ items: [{ id: "q", text: "", attachments: [{ path: "/tmp/f", name: "f", size: 1, kind: "file" }] }] }));
    const exported = await readBackup(await makeBackup(here, CATEGORY_IDS));
    expect((exported.data.drafts![0].value as string).length).toBe(250_000);
    expect(exported.data.queues).toEqual([]);
    let recovery: Entry[] = [];
    const backup = await readBackup(await makeBackup(env(), ["queues", "drafts"]));
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), defaultMapping(backup, connOf(conn), ["default"]), all("replace"));
    await applyRestore(here, plan, async (e) => ((recovery = e), "/r.zip"));
    const saved = await readBackup(recovery);
    expect(saved.data.queues![0].value).toEqual({ items: [{ id: "q", text: "", attachments: [{ path: "/tmp/f", name: "f", size: 1, kind: "file" }] }] });
  });

  it("leaves places it doesn't restore exactly as stored, and values it can't read alone", async () => {
    const theirs = env();
    theirs.tags.text = JSON.stringify({ v: 1, scopes: { [projectScope(conn, "default")]: { tags: [{ id: "t", name: "New" }], chats: {}, filters: [] } } });
    const backup = await readBackup(await makeBackup(theirs, ["tags", "queues"]));
    const here = env();
    const work = projectScope(conn, "work");
    const workPart = { tags: [{ id: "w", name: "Work", colour: "from a newer app" }], chats: {}, filters: [], extra: 1 };
    here.tags.text = JSON.stringify({ v: 1, scopes: { [work]: workPart } });
    here.storage.setItem(key("queue", "default", "broken"), "{not json");
    const plan = planRestore(backup, await loadCurrent(here), connOf(conn), defaultMapping(backup, connOf(conn), ["default", "work"]), all("replace"));
    await applyRestore(here, plan, ok);
    const doc = JSON.parse(here.tags.text!);
    expect(doc.scopes[work]).toEqual(workPart);
    expect(doc.scopes[projectScope(conn, "default")].tags).toEqual([{ id: "t", name: "New" }]);
    expect(here.storage.getItem(key("queue", "default", "broken"))).toBe("{not json");
  });

  it("waits for a message still being sent", () => {
    expect(restoreBlocked({ working: false, unsaved: 0, sending: 0 })).toBeUndefined();
    expect(restoreBlocked({ working: false, unsaved: 0, sending: 1 })).toMatch(/still being sent/);
    expect(restoreBlocked({ working: true, unsaved: 0, sending: 0 })).toMatch(/reply is running/);
    expect(restoreBlocked({ working: false, unsaved: 2, sending: 0 })).toMatch(/couldn't save/);
  });
});

describe("reading a backup", () => {
  const made = async () => makeBackup(await populated(), CATEGORY_IDS);
  const edit = (entries: Entry[], name: string, fn: (text: string) => string) => entries.map((e) => (e.name === name ? { ...e, text: fn(e.text) } : e));

  it("refuses one that isn't a backup, or is damaged or cut short", async () => {
    const entries = await made();
    await expect(readBackup(entries.slice(1))).rejects.toThrow(/no readable manifest/);
    await expect(readBackup(edit(entries, "manifest.json", (t) => t.slice(0, 40)))).rejects.toThrow(BackupError);
    await expect(readBackup(edit(entries, "manifest.json", (t) => t.replace("hermes-chat-backup", "something-else")))).rejects.toThrow(/isn't a Hermes Chat backup/);
    await expect(readBackup(edit(entries, "drafts.json", (t) => t.replace("Work draft", "Work draff")))).rejects.toThrow(/drafts.json doesn't match its checksum/);
    await expect(readBackup(entries.filter((e) => e.name !== "tags.json"))).rejects.toThrow(/missing tags.json/);
    const manifest = JSON.parse(entries[0].text);
    manifest.files.drafts.records = 99;
    await expect(readBackup(edit(entries, "manifest.json", () => JSON.stringify(manifest)))).rejects.toThrow(/doesn't hold the 99 records/);
  });

  it("refuses a newer schema whole, saying to update", async () => {
    const entries = edit(await made(), "manifest.json", (t) => t.replace('"schema": 1', '"schema": 2'));
    await expect(readBackup(entries)).rejects.toThrow("A newer Hermes Chat made it (backup schema 2); this version reads schema 1. Update Hermes Chat, then restore it.");
  });

  it("skips a category it doesn't know, and values it can't use, without failing the rest", async () => {
    let entries = await made();
    const text = JSON.stringify({ category: "drafts", records: [{ place: "p1", key: "chat-x", value: 42 }, { place: "p1", key: "chat-y", value: "Fine" }] });
    const manifest = JSON.parse(entries[0].text);
    manifest.files.drafts = { file: "drafts.json", records: 2, sha256: await sha256(text) };
    manifest.files.reminders = { file: "reminders.json", records: 0, sha256: "x" };
    entries = edit(edit(entries, "drafts.json", () => text), "manifest.json", () => JSON.stringify(manifest));
    const backup = await readBackup(entries);
    expect(backup.unsupported).toEqual(["reminders"]);
    const plan = planRestore(backup, await loadCurrent(env()), connOf(conn), defaultMapping(backup, connOf(conn), ["default", "work"]), {});
    const d = plan.categories.find((c) => c.id === "drafts")!;
    expect([d.add, d.skipped]).toEqual([1, [{ reason: "This version can't use them", n: 1 }]]);
  });

  it("refuses a record for a place the manifest doesn't name", async () => {
    let entries = await made();
    const text = JSON.stringify({ category: "drafts", records: [{ place: "p9", key: "chat-x", value: "x" }] });
    const manifest = JSON.parse(entries[0].text);
    manifest.files.drafts = { file: "drafts.json", records: 1, sha256: await sha256(text) };
    entries = edit(edit(entries, "drafts.json", () => text), "manifest.json", () => JSON.stringify(manifest));
    await expect(readBackup(entries)).rejects.toThrow(/record it can't read/);
  });

  it("works with the stores' own storage stand-ins", async () => {
    // The browser stand-in the app uses outside Tauri keeps tags and defaults in localStorage too.
    const s = new MemStorage();
    const e: BackupEnv = { storage: s, tags: storageDefaultsFile(() => s, "hermes-chat.tags"), defaults: storageDefaultsFile(() => s) };
    drafts(s).set(draftKey(conn, "default", "c"), "x");
    const entries = await makeBackup(e, CATEGORY_IDS);
    expect((await readBackup(entries)).data.drafts).toHaveLength(1);
  });

  it("backs up a saved connection's data, kept by its id, by its address, and restores it under the id of the connection here", async () => {
    // Saved connections keep their data by a stable id (connections.ts, ADR 0112); the backup names the address.
    const here = { ...conn, id: "aaaaaaaa-0000-4000-8000-000000000001" };
    const there = { ...conn, id: "bbbbbbbb-0000-4000-8000-000000000002" };
    const from = env();
    from.place = placesOf(() => [here]);
    drafts(from.storage).set(draftKey(here, "default", "chat-a"), "Kept by id");
    const scope = projectScope(here, "default");
    from.storage.setItem("hermes-ui-prefs", JSON.stringify({ v: 1, templates: [{ id: "t", name: "N", description: "", body: "b", project: { scope, id: "p", name: "P" } }] }));
    const entries = await makeBackup(from, CATEGORY_IDS);
    const backup = await readBackup(entries);
    expect(Object.values(backup.manifest.places)).toEqual([{ mode: "ssh", target: "liam@hermes.lan", username: "liam", profile: "default" }]);
    expect(entries.map((e) => e.text).join("")).not.toContain(here.id);

    const into = env();
    into.place = placesOf(() => [there]);
    const mapping = defaultMapping(backup, connOf(there), ["default"]);
    const plan = planRestore(backup, await loadCurrent(into), connOf(there), mapping, all("merge"));
    await applyRestore(into, plan, ok);
    expect(drafts(into.storage).get(draftKey(there, "default", "chat-a"))).toBe("Kept by id");
    expect(JSON.parse(into.storage.getItem("hermes-ui-prefs")!).templates[0].project.scope).toBe(projectScope(there, "default"));
    // Read back as this computer's own, for the next backup.
    expect((await makeBackup(into, ["drafts"]))[1].text).toContain("Kept by id");
  });

  it("leaves out data kept for a connection id no saved connection has", async () => {
    const e = env();
    e.place = placesOf(() => []);
    drafts(e.storage).set(draftKey({ ...conn, id: "cccccccc-0000-4000-8000-000000000003" }, "default", "c"), "orphan");
    expect((await readBackup(await makeBackup(e, ["drafts"]))).data.drafts).toEqual([]);
  });
});
