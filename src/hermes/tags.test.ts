// Tags and Saved filters kept on this computer (tags.ts, ADR 0106): ids that survive renames, names compared without
// case, one compare-and-swap per change, and each connection and profile kept apart.
import { describe, expect, it } from "vitest";
import { TagsStore, previewBulk, type TagsFile } from "./tags";
import { projectScope } from "./projectLinks";

const conn = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const DEFAULT = projectScope(conn, "default");
const WORK = projectScope(conn, "work");

/**
 * The shared file, as defaults_file.rs keeps it: read, and swap only over what was read. Every call takes a turn of
 * the event loop, so changes started together interleave the way two app instances' would. `full`: writes fail.
 */
function sharedFile() {
  const f = {
    text: null as string | null,
    full: false,
    swaps: 0,
    read: async () => (await Promise.resolve(), f.text),
    swap: async (expected: string | null, next: string) => {
      await Promise.resolve();
      if (f.full) throw new Error("No space left on device");
      if (f.text !== expected) return { swapped: false, current: f.text };
      f.swaps++;
      f.text = next;
      return { swapped: true, current: next };
    },
  };
  return f satisfies TagsFile;
}

const ids = (prefix = "id") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

/** A store whose first read has landed. */
async function store(file: TagsFile, scope = DEFAULT, newId = ids()) {
  const s = new TagsStore(file, scope, newId);
  await s.reread();
  return s;
}

describe("Tags", () => {
  it("creates, renames and deletes a tag by its id, keeping the chats it is on through a rename", async () => {
    const s = await store(sharedFile());
    const tag = await s.createTag("  Work   stuff ");
    expect(tag).toEqual({ id: "id1", name: "Work stuff" });
    await s.setTag(["a", "b"], tag.id, true);

    await s.renameTag(tag.id, "Job");
    expect(s.getSnapshot().tags).toEqual([{ id: "id1", name: "Job" }]);
    expect(s.tagsOf("a")).toEqual(["id1"]);

    await s.deleteTag(tag.id);
    expect(s.getSnapshot()).toMatchObject({ tags: [], chats: {} });
  });

  it("refuses a name another tag has, whatever its case or Unicode form, but lets a tag change its own case", async () => {
    const s = await store(sharedFile());
    const ete = await s.createTag("Été");
    await expect(s.createTag("été")).rejects.toThrow('There\'s already a tag called "Été".');
    // The same letters, decomposed: E + combining acute.
    await expect(s.createTag("Été")).rejects.toThrow("already a tag");
    await expect(s.createTag("   ")).rejects.toThrow("Give the tag a name.");
    await expect(s.createTag("x".repeat(41))).rejects.toThrow("40 characters");
    await s.renameTag(ete.id, "ÉTÉ");
    expect(s.getSnapshot().tags[0].name).toBe("ÉTÉ");
    const other = await s.createTag("Ete");
    await expect(s.renameTag(other.id, "été")).rejects.toThrow("already a tag");
  });

  it("keeps emoji and other scripts, and refuses characters that reorder text", async () => {
    const s = await store(sharedFile());
    for (const name of ["🚀 launch", "👩‍💻 dev", "日本語", "Ελληνικά"]) await s.createTag(name);
    expect(s.getSnapshot().tags.map((t) => t.name)).toEqual(["🚀 launch", "👩‍💻 dev", "日本語", "Ελληνικά"]);
    await expect(s.createTag("evil‮gnp")).rejects.toThrow("can't have");
    // 40 emoji count as 40 characters, not 80 UTF-16 units.
    expect((await s.createTag("🙂".repeat(40))).name).toHaveLength(80);
  });

  it("is still there for a new store, and kept apart for each profile", async () => {
    const file = sharedFile();
    const a = await store(file);
    await a.setTag(["chat1"], (await a.createTag("Backups")).id, true);
    await a.saveFilter("Backup chats", { tags: ["id1"], text: "restic" });

    expect((await store(file)).getSnapshot()).toEqual({
      tags: [{ id: "id1", name: "Backups" }],
      chats: { chat1: ["id1"] },
      filters: [{ id: "id2", name: "Backup chats", filter: { text: "restic", tags: ["id1"] } }],
    });
    const work = await store(file, WORK, ids("w"));
    expect(work.getSnapshot()).toMatchObject({ tags: [], chats: {}, filters: [] });
    // The same name is fine in another profile, and changing that profile leaves this one alone.
    await work.createTag("Backups");
    await work.deleteTag("w1");
    expect((await store(file)).getSnapshot().tags).toEqual([{ id: "id1", name: "Backups" }]);
  });

  it("ignores a stored document it can't read, and tags a stored chat has that no longer exist", async () => {
    const file = sharedFile();
    file.text = "{not json";
    expect((await store(file)).getSnapshot().tags).toEqual([]);
    file.text = JSON.stringify({ v: 1, scopes: { [DEFAULT]: { tags: [{ id: "a", name: "A" }, { id: "b", name: "a" }], chats: { c: ["a", "gone"] } } } });
    expect((await store(file)).getSnapshot()).toEqual({ tags: [{ id: "a", name: "A" }], chats: { c: ["a"] }, filters: [] });
  });
});

describe("Two instances changing tags at once", () => {
  it("keeps both instances' new tags, in this profile and another", async () => {
    const file = sharedFile();
    const one = await store(file, DEFAULT, ids("a"));
    const two = await store(file, DEFAULT, ids("b"));
    const work = await store(file, WORK, ids("w"));
    await Promise.all([one.createTag("One"), two.createTag("Two"), work.createTag("Work")]);
    expect((await store(file)).getSnapshot().tags.map((t) => t.name).sort()).toEqual(["One", "Two"]);
    expect((await store(file, WORK)).getSnapshot().tags.map((t) => t.name)).toEqual(["Work"]);
  });

  it("refuses a duplicate name another instance took between reading and writing", async () => {
    const file = sharedFile();
    const one = await store(file, DEFAULT, ids("a"));
    const two = await store(file, DEFAULT, ids("b"));
    const results = await Promise.allSettled([one.createTag("Infra"), two.createTag("infra")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await store(file)).getSnapshot().tags).toHaveLength(1);
  });

  it("doesn't bring back a tag another instance deleted while a bulk edit was being applied", async () => {
    const file = sharedFile();
    const one = await store(file);
    const tag = await one.createTag("Infra");
    const preview = previewBulk(one.getSnapshot(), ["a", "b"], tag.id, true);
    const two = await store(file);
    const [bulk] = await Promise.allSettled([one.applyBulk(preview), two.deleteTag(tag.id)]);
    const after = (await store(file)).getSnapshot();
    expect(after.tags).toEqual([]);
    expect(after.chats).toEqual({});
    // Either the bulk edit went first and the delete took the tag off both chats, or it was refused.
    if (bulk.status === "rejected") expect(String(bulk.reason)).toContain("That tag was deleted.");
  });
});

describe("What one window shows", () => {
  it("shows the latest change, even when an earlier change's answer arrives late", async () => {
    const file = sharedFile();
    const s = await store(file);
    const swap = file.swap;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reads = 0;
    const read = file.read;
    file.read = async () => (reads++, read());
    // The first change is written, but its answer waits.
    file.swap = async (expected, next) => {
      const res = await swap(expected, next);
      file.swap = swap;
      await held;
      return res;
    };
    const one = s.createTag("One");
    const two = s.createTag("Two");
    await new Promise((r) => setTimeout(r, 5));
    // The second hasn't read yet: it waits for the first to be shown.
    expect(reads).toBe(1);
    release();
    await Promise.all([one, two]);
    expect(s.getSnapshot().tags.map((t) => t.name)).toEqual(["One", "Two"]);
  });

  it("shows the newest of two reads, whichever answers first", async () => {
    const file = sharedFile();
    const s = await store(file);
    file.text = JSON.stringify({ v: 1, scopes: { [DEFAULT]: { tags: [{ id: "o", name: "Old" }] } } });
    const read = file.read;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // The first read takes the file as it is now, and answers last.
    file.read = async () => {
      file.read = read;
      const text = file.text;
      await held;
      return text;
    };
    const first = s.reread();
    file.text = JSON.stringify({ v: 1, scopes: { [DEFAULT]: { tags: [{ id: "o", name: "Old" }, { id: "n", name: "New" }] } } });
    const second = s.reread();
    release();
    await Promise.all([first, second]);
    expect(s.getSnapshot().tags.map((t) => t.name)).toEqual(["Old", "New"]);
  });
});

describe("A bulk tag edit", () => {
  it("previews which chats change, and applies only those, in one write", async () => {
    const file = sharedFile();
    const s = await store(file);
    const tag = await s.createTag("Infra");
    await s.setTag(["b"], tag.id, true);

    const add = previewBulk(s.getSnapshot(), ["a", "b", "c", "a"], tag.id, true);
    expect(add).toMatchObject({ change: ["a", "c"], unchanged: ["b"] });
    const before = file.swaps;
    await s.applyBulk(add);
    expect(file.swaps).toBe(before + 1);
    expect(["a", "b", "c"].map(s.tagsOf)).toEqual([[tag.id], [tag.id], [tag.id]]);

    const remove = previewBulk(s.getSnapshot(), ["a", "z"], tag.id, false);
    expect(remove).toMatchObject({ change: ["a"], unchanged: ["z"] });
    await s.applyBulk(remove);
    expect(s.getSnapshot().chats).toEqual({ b: [tag.id], c: [tag.id] });
  });

  it("changes nothing when it can't be saved, rather than some of the chats", async () => {
    const file = sharedFile();
    const s = await store(file);
    const tag = await s.createTag("Infra");
    const stored = file.text;
    const snapshot = s.getSnapshot();

    file.full = true;
    await expect(s.applyBulk(previewBulk(snapshot, ["a", "b", "c"], tag.id, true))).rejects.toThrow(
      "Couldn't save on this computer, so nothing changed: No space left on device",
    );
    expect(s.getSnapshot()).toBe(snapshot);
    expect(file.text).toBe(stored);
  });

  it("is refused if the tag was deleted after the preview, and then shows the tags as they are", async () => {
    const file = sharedFile();
    const s = await store(file);
    const tag = await s.createTag("Infra");
    const preview = previewBulk(s.getSnapshot(), ["a"], tag.id, true);
    await (await store(file)).deleteTag(tag.id);
    await expect(s.applyBulk(preview)).rejects.toThrow("That tag was deleted.");
    expect(s.getSnapshot()).toMatchObject({ tags: [], chats: {} });
  });
});

describe("Saved filters", () => {
  it("refuses a name another saved filter has, and keeps a deleted tag's id so the filter can say so", async () => {
    const s = await store(sharedFile());
    const tag = await s.createTag("Infra");
    await s.saveFilter("Infra this month", { tags: [tag.id], from: "2026-10-01", text: "  " });
    await expect(s.saveFilter("INFRA THIS MONTH", {})).rejects.toThrow('already a saved filter called "Infra this month"');
    await s.deleteTag(tag.id);
    expect(s.getSnapshot().filters[0].filter).toEqual({ tags: [tag.id], from: "2026-10-01" });
    await s.deleteFilter("id2");
    expect(s.getSnapshot().filters).toEqual([]);
  });
});
