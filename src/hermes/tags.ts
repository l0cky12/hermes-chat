// Tags and Saved filters (GLOSSARY.md, ADR 0106). Hermes has nowhere to keep either: a session edit takes only its
// title and flags. So both are kept on this computer, in one versioned JSON document in the app's data folder that
// every running Hermes Chat shares (`tags.json`, swapped under a lock like project defaults: defaults_file.rs),
// separately for each connection and profile (the scope projectLinks.ts `projectScope` gives), and never sent to Hermes.
//
// A tag is known by its id, so renaming it keeps the chats it is on, and a Saved filter names tags by id too. Names
// are compared without case, after Unicode normalisation, so "Work" and "work" can't both exist. Every change reads
// the document, checks the change against it, and swaps the whole document in only if no other instance wrote
// meanwhile (trying again from what it wrote if one did). So a change is kept whole or not at all, and never undoes
// another instance's.
import { invoke } from "@tauri-apps/api/core";
import { toFilter, tidyFilter, type ChatFilter } from "./chatFilter";
import { moveScopeKeys, storageDefaultsFile, type DefaultsFile } from "./projectDefaults";
import { migrateUIPrefs as migrateDoc, type UIPrefsDoc, type UIPrefsMigrations } from "./uiPrefs";
import { errorText } from "./values";

export const TAGS_KEY = "hermes-chat.tags";
export const TAGS_VERSION = 1;
const TAGS_MIGRATIONS: UIPrefsMigrations = { 0: (doc) => doc };

export const TAG_NAME_MAX = 40;
export const FILTER_NAME_MAX = 80;
/** The most tags and Saved filters one profile keeps, and the most scopes the document keeps. */
export const TAG_LIMIT = 200;
export const FILTER_LIMIT = 100;
const SCOPE_LIMIT = 200;

export type Tag = { id: string; name: string };
export type SavedFilter = { id: string; name: string; filter: ChatFilter };
/** One connection and profile's tags: the tags, each chat's tag ids, and the Saved filters. */
export type ScopeTags = { tags: Tag[]; chats: Readonly<Record<string, string[]>>; filters: SavedFilter[] };

/** Where the document is kept: a file swapped under a lock in the app, one webview's storage in tests and a browser. */
export type TagsFile = DefaultsFile;

export const tauriTagsFile: TagsFile = {
  read: () => invoke<string | null>("tags_read"),
  swap: (expected, next) => invoke("tags_swap", { expected, next }),
};

/** The app's file, or this webview's storage outside the app. */
export const savedTagsFile: TagsFile =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriTagsFile : storageDefaultsFile(() => globalThis.localStorage, TAGS_KEY);

/** How many times a change is tried again when another instance writes between reading and swapping. */
const SWAP_TRIES = 5;

const EMPTY: ScopeTags = Object.freeze({ tags: [], chats: Object.freeze({}), filters: [] }) as ScopeTags;
const isDoc = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : undefined);

/** Whether two names are the same name: equal without case, after Unicode normalisation. */
export const sameName = (a: string, b: string) => a.normalize("NFC").localeCompare(b.normalize("NFC"), undefined, { sensitivity: "accent" }) === 0;

/** A name as the owner typed it, tidied; throws saying what is wrong with it. `taken`: the names it must differ from. */
function cleanName(raw: string, max: number, what: string, taken: string[]): string {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) throw new Error(`Give the ${what} a name.`);
  if ([...name].length > max) throw new Error(`Keep the ${what}'s name to ${max} characters.`);
  // Control characters, and the ones that reorder text around them, could make one name look like another.
  if (/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(name)) throw new Error(`That name has characters a ${what} name can't have.`);
  const clash = taken.find((t) => sameName(t, name));
  if (clash !== undefined) throw new Error(`There's already a ${what} called "${clash}".`);
  return name;
}

function toScope(v: unknown): ScopeTags | undefined {
  if (!isDoc(v)) return undefined;
  const tags: Tag[] = [];
  for (const t of Array.isArray(v.tags) ? v.tags : []) {
    if (isDoc(t) && id(t.id) && typeof t.name === "string" && t.name.trim() && !tags.some((o) => o.id === t.id || sameName(o.name, t.name as string)))
      tags.push({ id: t.id as string, name: (t.name as string).slice(0, 4 * TAG_NAME_MAX) });
  }
  const known = new Set(tags.map((t) => t.id));
  const chats: Record<string, string[]> = {};
  for (const [chat, ids] of Object.entries(isDoc(v.chats) ? v.chats : {})) {
    const of = Array.isArray(ids) ? [...new Set(ids.filter((t): t is string => known.has(t)))] : [];
    if (id(chat) && of.length) chats[chat] = of;
  }
  const filters = (Array.isArray(v.filters) ? v.filters : []).flatMap((f): SavedFilter[] =>
    isDoc(f) && id(f.id) && typeof f.name === "string" && f.name.trim() ? [{ id: f.id as string, name: f.name.slice(0, 4 * FILTER_NAME_MAX), filter: toFilter(f.filter) }] : [],
  );
  return { tags: tags.slice(0, TAG_LIMIT), chats, filters: filters.slice(0, FILTER_LIMIT) };
}

/** Every scope the stored document holds, checked; anything that isn't valid is left out. */
export function readTags(raw: unknown): Record<string, ScopeTags> {
  const doc = migrateDoc(raw, TAGS_MIGRATIONS, TAGS_VERSION);
  const out: Record<string, ScopeTags> = {};
  for (const [scope, v] of Object.entries(isDoc(doc.scopes) ? doc.scopes : {}).slice(0, SCOPE_LIMIT)) {
    const s = toScope(v);
    if (s) out[scope] = s;
  }
  return out;
}

/** What a bulk tag edit would change: the chats it would add the tag to or take it from, and those already so. */
export type BulkPreview = { tag: Tag; add: boolean; change: string[]; unchanged: string[] };

/** The changes to one scope; each returns the scope as it would be, or throws saying why it can't be. */
export const edit = {
  createTag(s: ScopeTags, name: string, tagId: string): ScopeTags {
    if (s.tags.length >= TAG_LIMIT) throw new Error(`A profile keeps at most ${TAG_LIMIT} tags.`);
    const clean = cleanName(name, TAG_NAME_MAX, "tag", s.tags.map((t) => t.name));
    return { ...s, tags: [...s.tags, { id: tagId, name: clean }] };
  },
  renameTag(s: ScopeTags, tagId: string, name: string): ScopeTags {
    if (!s.tags.some((t) => t.id === tagId)) throw new Error("That tag was deleted.");
    const clean = cleanName(name, TAG_NAME_MAX, "tag", s.tags.filter((t) => t.id !== tagId).map((t) => t.name));
    return { ...s, tags: s.tags.map((t) => (t.id === tagId ? { ...t, name: clean } : t)) };
  },
  /** Takes the tag off every chat. Saved filters naming it keep it, and say it was deleted. */
  deleteTag(s: ScopeTags, tagId: string): ScopeTags {
    const chats = Object.fromEntries(Object.entries(s.chats).flatMap(([c, of]) => {
      const left = of.filter((t) => t !== tagId);
      return left.length ? [[c, left]] : [];
    }));
    return { ...s, tags: s.tags.filter((t) => t.id !== tagId), chats };
  },
  /** Puts the tag on every chat in `chatIds`, or takes it off them. */
  setTag(s: ScopeTags, chatIds: readonly string[], tagId: string, on: boolean): ScopeTags {
    if (!s.tags.some((t) => t.id === tagId)) throw new Error("That tag was deleted.");
    const chats = { ...s.chats };
    for (const c of chatIds) {
      const of = (chats[c] ?? []).filter((t) => t !== tagId);
      if (on) of.push(tagId);
      if (of.length) chats[c] = of;
      else delete chats[c];
    }
    return { ...s, chats };
  },
  forgetChat(s: ScopeTags, chatId: string): ScopeTags {
    const { [chatId]: _, ...chats } = s.chats;
    return { ...s, chats };
  },
  saveFilter(s: ScopeTags, name: string, filter: ChatFilter, filterId: string): ScopeTags {
    if (s.filters.length >= FILTER_LIMIT) throw new Error(`A profile keeps at most ${FILTER_LIMIT} saved filters.`);
    const clean = cleanName(name, FILTER_NAME_MAX, "saved filter", s.filters.map((f) => f.name));
    return { ...s, filters: [...s.filters, { id: filterId, name: clean, filter: tidyFilter(filter) }] };
  },
  deleteFilter(s: ScopeTags, filterId: string): ScopeTags {
    return { ...s, filters: s.filters.filter((f) => f.id !== filterId) };
  },
};

/** What adding (or removing) `tagId` on `chatIds` would change, for the owner to confirm first. */
export function previewBulk(s: ScopeTags, chatIds: readonly string[], tagId: string, add: boolean): BulkPreview {
  const tag = s.tags.find((t) => t.id === tagId);
  if (!tag) throw new Error("That tag was deleted.");
  const has = (c: string) => (s.chats[c] ?? []).includes(tagId);
  const ids = [...new Set(chatIds)];
  return { tag, add, change: ids.filter((c) => has(c) !== add), unchanged: ids.filter((c) => has(c) === add) };
}

/**
 * One connection and profile's tags and Saved filters, as the shared document has them. It starts empty and reads the
 * document at once (`reread`). Each change reads the document afresh, so a change another window or instance made
 * meanwhile is kept, and swaps it in whole. If it can't be written, it rejects and nothing changes.
 */
export class TagsStore {
  private snap: ScopeTags = EMPTY;
  private listeners = new Set<() => void>();
  /**
   * Reads and changes run one at a time, each shown before the next starts, so what is shown is always the latest
   * read or change, never an older answer that arrived late.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  constructor(
    private file: TagsFile,
    readonly scope: string,
    private newId: () => string = () => crypto.randomUUID(),
  ) {
    void this.reread();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  /** Reads the document again, after another window or instance may have changed it. A failed read keeps what is shown. */
  reread(): Promise<void> {
    return this.enqueue(async () => {
      let raw: string | null;
      try {
        raw = await this.file.read();
      } catch {
        return;
      }
      this.set(readTags(parse(raw))[this.scope] ?? EMPTY);
    });
  }

  tagsOf = (chatId: string): readonly string[] => this.snap.chats[chatId] ?? [];
  exists = (tagId: string) => this.snap.tags.some((t) => t.id === tagId);

  async createTag(name: string): Promise<Tag> {
    const tagId = this.newId();
    await this.change((s) => edit.createTag(s, name, tagId));
    return this.snap.tags.find((t) => t.id === tagId)!;
  }
  renameTag(tagId: string, name: string) {
    return this.change((s) => edit.renameTag(s, tagId, name));
  }
  deleteTag(tagId: string) {
    return this.change((s) => edit.deleteTag(s, tagId));
  }
  setTag(chatIds: readonly string[], tagId: string, on: boolean) {
    return this.change((s) => edit.setTag(s, chatIds, tagId, on));
  }
  /**
   * Applies a bulk edit the owner confirmed, as previewed: only the chats it would change, in one swap, so it is kept
   * whole or not at all. Rejects if the tag was deleted meanwhile.
   */
  applyBulk(p: BulkPreview) {
    return this.change((s) => edit.setTag(s, p.change, p.tag.id, p.add));
  }
  async forgetChat(chatId: string) {
    if (this.snap.chats[chatId]) await this.change((s) => edit.forgetChat(s, chatId));
  }
  async saveFilter(name: string, filter: ChatFilter): Promise<SavedFilter> {
    const filterId = this.newId();
    await this.change((s) => edit.saveFilter(s, name, filter, filterId));
    return this.snap.filters.find((f) => f.id === filterId)!;
  }
  deleteFilter(filterId: string) {
    return this.change((s) => edit.deleteFilter(s, filterId));
  }

  /** Reads, checks `fn` against what was read, and swaps the result in; reads and checks again if another wrote first. */
  private change(fn: (s: ScopeTags) => ScopeTags): Promise<void> {
    return this.enqueue(() => this.swapIn(fn));
  }

  private async swapIn(fn: (s: ScopeTags) => ScopeTags): Promise<void> {
    const failed = (e: unknown) => new Error(`Couldn't save on this computer, so nothing changed: ${errorText(e)}`);
    let raw: string | null;
    try {
      raw = await this.file.read();
    } catch (e) {
      throw failed(e);
    }
    for (let i = 0; i < SWAP_TRIES; i++) {
      const doc = parse(raw);
      const scopes = isDoc(doc.scopes) ? doc.scopes : {};
      const before = toScope(scopes[this.scope]) ?? EMPTY;
      let after: ScopeTags;
      try {
        after = fn(before);
      } catch (e) {
        // Refused, perhaps because another window changed the tags: show them as they are now.
        this.set(before);
        throw e;
      }
      // Fields a newer version of the app keeps here are kept; other scopes are written back as they were.
      const prior = isDoc(scopes[this.scope]) ? (scopes[this.scope] as Record<string, unknown>) : {};
      const next = JSON.stringify({ ...doc, v: Math.max(TAGS_VERSION, Number(doc.v) || 0), scopes: { ...scopes, [this.scope]: { ...prior, ...after } } });
      let res: { swapped: boolean; current: string | null };
      try {
        res = await this.file.swap(raw, next);
      } catch (e) {
        throw failed(e);
      }
      if (res.swapped) return this.set(after);
      raw = res.current;
    }
    throw new Error("Another Hermes Chat kept changing the tags, so nothing changed. Try again.");
  }

  private set(s: ScopeTags) {
    this.snap = s;
    for (const fn of [...this.listeners]) fn();
  }
}

/** The stored document, brought up to this version; anything unreadable is an empty one. */
function parse(raw: string | null): UIPrefsDoc {
  let parsed: unknown;
  try {
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    // Unreadable: start empty.
  }
  return migrateDoc(parsed, TAGS_MIGRATIONS, TAGS_VERSION);
}

/**
 * Forgets every scope `match` picks, after the owner removed their connection (forgetConnection.ts, ADR 0112). Other
 * scopes, and fields a newer app wrote, are kept as stored.
 */
/**
 * Moves each scope of the tags file to where `move` says (null drops it; undefined keeps it), after a profile was
 * renamed or deleted (profileLocalData.ts). A moved scope replaces any already there.
 */
export async function moveTagScopes(file: TagsFile, move: (scope: string) => string | null | undefined): Promise<void> {
  let raw = await file.read();
  for (let i = 0; i < SWAP_TRIES; i++) {
    const doc = parse(raw);
    const scopes = moveScopeKeys(isDoc(doc.scopes) ? doc.scopes : {}, move);
    if (!scopes) return;
    const res = await file.swap(raw, JSON.stringify({ ...doc, scopes }));
    if (res.swapped) return;
    raw = res.current;
  }
  throw new Error("Another Hermes Chat kept changing the tags; they weren't moved. Try again.");
}

