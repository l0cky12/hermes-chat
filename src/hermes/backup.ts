// Backup and restore of what Hermes Chat keeps on this computer (GLOSSARY.md Backup, ADR 0038). Hermes keeps the
// chats, projects, memory and the rest on the server; none of that is in a backup. What is: settings, templates, and,
// for each connection and profile, drafts, queued messages, project membership and defaults, tags and Saved filters,
// and where branches came from. Never a password, an extra header's value or any other credential: those stay in the
// system keyring, and the sign-in itself isn't in a backup at all.
//
// A backup is a plain zip (written and read by src-tauri backup.rs) of JSON files: `manifest.json`, with the schema
// version, the connections and profiles the data is for ("places"), and each other file's SHA-256 and record count;
// and one file per category, a list of records. Restoring reads it all and checks it before anything is written,
// maps each place to a profile of this computer's connection (only an identical connection and profile is mapped on
// its own; anything else waits for the owner to choose), and plans each category under the owner's policy: merge
// (add what's missing, keep this computer's on a conflict) or replace (the backup's, for the places restored). A
// recovery backup of everything is saved first, and each category is then written whole or not at all, after
// checking nothing changed it since the preview. Restored queues come back paused, and nothing is ever sent.
import { invoke } from "@tauri-apps/api/core";
import { type ScopeSource, scopeParts } from "./connections";
import { sha256 } from "./importTranscripts";
import { toBranches, toQueue } from "./chatCache";
import { PROJECTS_KEY, PROJECTS_VERSION, readLinks, type ScopeLinks } from "./projectLinks";
import { savedDefaultsFile, storageDefaultsFile, toDefaults, type DefaultsFile, type ProjectDefaults } from "./projectDefaults";
import { readTags, savedTagsFile } from "./tags";
import { toTemplates, type Template } from "./templates";
import { readUIPrefs, UI_PREFS_KEY } from "./uiPrefs";
import { TERMINAL_TARGET_KEY } from "./terminal";
import { QUEUE_LIMIT, type ChatQueue } from "./model";
import { APPEARANCE_KEY, loadAppearance } from "../ui/appearance";
import { errorText, isObj } from "./values";

export const BACKUP_FORMAT = "hermes-chat-backup";
/** The schema this version writes and reads. A backup of a newer schema is refused, never half-read. */
export const BACKUP_SCHEMA = 1;
/** Turns a backup of schema `n` into one of schema `n + 1`, keyed by `n`. Schema 1 is the first, so there are none yet. */
const MIGRATIONS: Readonly<Record<number, (b: Files) => Files>> = {};

/** Why a queue that came from a backup waits: it is never sent until the owner resumes it. */
export const RESTORED_PAUSE = "Restored from a backup. Check it, then resume it to send.";
/** What a backup never holds, as the export and restore dialogs say it. */
export const LEFT_OUT = [
  "Passwords, extra request header values and any other credential: they stay in the system keyring.",
  "The sign-in itself (address and username): you set up the connection on the new computer first.",
  "Chats, projects, folders, memory, persona, skills, scheduled jobs, toolsets and models: Hermes keeps those on the server.",
  "Saved copies and cached chat lists, which come back from Hermes.",
  "Failed messages, attachments and screenshots, including the files on queued messages.",
  "An unsaved persona edit, transcript import history and inbox dismissals.",
];

/** How the app reaches the dashboard, and as whom: the part of every kept scope before the profile. */
export type Conn = { mode: "ssh" | "url"; target: string; username: string };
/** A connection and profile that data in a backup is for. */
export type Place = Conn & { profile: string };

/**
 * This computer's connection, where restored data goes: its address, and `parts`, what its kept scopes start with
 * (connections.ts `scopeParts`: its stable id, ADR 0112). `parts` stays on this computer; a backup holds the address.
 */
export type Target = Conn & { parts?: string[] };

const addressOf = (s: ScopeSource): Conn => ({ mode: s.mode, target: s.mode === "ssh" ? s.sshTarget : s.url, username: s.username });
export const connOf = (s: ScopeSource): Target => ({ ...addressOf(s), parts: scopeParts(s) });
const sameConn = (a: Conn, b: Conn) => a.mode === b.mode && a.target === b.target && a.username === b.username;
/** Where `target`'s `profile` is kept: projectLinks.ts `projectScope`, drafts.ts `draftKey` and chatCache.ts all agree. */
const scopeAt = (target: Target, profile: string) => JSON.stringify([...(target.parts ?? [target.mode, target.target, target.username]), profile]);

/**
 * Which saved connection and profile a kept scope is for: one of `list`'s connections' scope parts, then a profile.
 * Data is kept by the connection's id, so the backup names it by its address, which another computer can map.
 */
export const placesOf =
  (list: () => readonly ScopeSource[]) =>
  (scope: string): Place | undefined => {
    let a: unknown;
    try {
      a = JSON.parse(scope);
    } catch {
      return undefined;
    }
    if (!Array.isArray(a)) return undefined;
    for (const c of list()) {
      const parts = scopeParts(c);
      const profile = a[parts.length];
      if (a.length === parts.length + 1 && parts.every((p, i) => a[i] === p) && short(profile) && profile) return { ...addressOf(c), profile };
    }
    return undefined;
  };
const short = (v: unknown, max = 2000): v is string => typeof v === "string" && v.length <= max;
function toPlace(v: unknown): Place | undefined {
  const a = v as unknown[];
  if (!Array.isArray(a) || a.length !== 4 || (a[0] !== "ssh" && a[0] !== "url") || !a.slice(1).every((x) => short(x)) || !a[3]) return undefined;
  return { mode: a[0], target: a[1] as string, username: a[2] as string, profile: a[3] as string };
}
const placeOfScope = (scope: string) => {
  try {
    return toPlace(JSON.parse(scope));
  } catch {
    return undefined;
  }
};
/** The place a kept scope is for: a saved connection's (`env.place`), else one keyed by its address. */
const placeIn = (env: BackupEnv, scope: string) => env.place?.(scope) ?? placeOfScope(scope);

/** JSON with keys sorted, so equal values compare equal however their keys were ordered. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

// --- Where things are kept, and what one category is ---

/** One kept thing: its place (`""` for one kept for the whole computer), its key there, and its value. */
type Rec = { scope: string; key: string; value: unknown };
/** A category as read: its records, and `raw`, what saving checks is still there. */
type Loaded = { recs: Rec[]; raw: string };
export type BackupStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
/** Where the categories are kept: localStorage, and the files tags and project defaults are swapped in (defaults_file.rs). */
export type BackupEnv = {
  storage: BackupStorage;
  tags: DefaultsFile;
  defaults: DefaultsFile;
  /** Which saved connection and profile a kept scope is for (`placesOf`); without it, only address-keyed scopes are read. */
  place?: (scope: string) => Place | undefined;
};

type Category = {
  label: string;
  /** What it holds, as the dialogs say. */
  holds: string;
  /** Kept per connection and profile (otherwise for the whole computer). */
  scoped: boolean;
  load(env: BackupEnv): Promise<Loaded>;
  /** Writes the category's whole new contents, all or none; throws if what `before` read has changed meanwhile. */
  save(env: BackupEnv, before: Loaded, recs: Rec[]): Promise<void>;
  /** A value from a backup as this version keeps it, or undefined if it isn't a valid one. */
  check(key: string, value: unknown): unknown;
  /** Both values combined, for a merge; without it, a merge keeps this computer's. */
  merge?(mine: unknown, theirs: unknown): unknown;
  /** A value as it is written over `mine` (project defaults take a revision past both). */
  over?(mine: unknown, next: unknown): unknown;
  /** The values that survive the store's own rules, in order (templates: one per name). */
  tidy?(recs: Rec[]): Rec[];
  /** Scopes named inside a value (a template's project), as place ids in a file and back. */
  toFile?(value: unknown, place: (scope: string) => string): unknown;
  fromFile?(value: unknown, scope: (place: string) => string | null | undefined): unknown;
};

/** A write this computer's storage refused. `changed`: putting it back failed too, so the category isn't as it was. */
export class WriteError extends Error {
  constructor(
    readonly changed: boolean,
    message: string,
  ) {
    super(message);
  }
}

export class ChangedError extends Error {
  constructor() {
    super("It changed on this computer since the preview, so none of it was written. Open the backup again to see it as it is now.");
  }
}

function keysWith(s: BackupStorage, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(prefix)) out.push(k);
  }
  return out.sort();
}

/** Writes every change (null deletes the key), or puts back every key it touched and throws. */
function writeAll(s: BackupStorage, changes: Map<string, string | null>) {
  const before = new Map([...changes.keys()].map((k) => [k, s.getItem(k)]));
  // Deletions first, so the writes after them have the room they free.
  const order = [...changes].sort(([, a], [, b]) => (a === null ? 0 : 1) - (b === null ? 0 : 1));
  try {
    for (const [k, v] of order) v === null ? s.removeItem(k) : s.setItem(k, v);
  } catch (e) {
    // Undo in the order that needs no room: every key touched goes first, then each one there before comes back, so
    // the store ends exactly as big as it started.
    let lost = 0;
    for (const k of before.keys())
      try {
        s.removeItem(k);
      } catch {
        // Removing frees room; a store that refuses even that is reported below by what doesn't come back.
      }
    for (const [k, v] of before)
      try {
        if (v !== null) s.setItem(k, v);
      } catch {
        lost++;
      }
    const why = errorText(e);
    throw new WriteError(
      lost > 0,
      lost
        ? `This computer's storage refused it (${why}), and ${lost === 1 ? "one item couldn't be put back as it was. The recovery backup has it." : `${lost} items couldn't be put back as they were. The recovery backup has them.`}`
        : `This computer's storage refused it (${why}), so none of it was written.`,
    );
  }
}

/**
 * A category kept as one localStorage key per place (and per chat, with `chat`): `prefix` then the scope's parts as
 * JSON, as drafts.ts and chatCache.ts write them. A key it can't read as one is left alone.
 */
function perKey(prefix: string, chat: boolean, json: boolean): Pick<Category, "load" | "save"> {
  const parts = (env: BackupEnv, k: string): { scope: string; key: string } | undefined => {
    try {
      const a: unknown = JSON.parse(k.slice(prefix.length));
      if (!Array.isArray(a) || a.length < (chat ? 2 : 1)) return undefined;
      const scope = JSON.stringify(chat ? a.slice(0, -1) : a);
      const id = chat ? a[a.length - 1] : "";
      if (!placeIn(env, scope) || !(id === null || (typeof id === "string" && id.length <= 400))) return undefined;
      return { scope, key: id ?? "" };
    } catch {
      return undefined;
    }
  };
  const keyOf = (r: Rec) => prefix + JSON.stringify([...(JSON.parse(r.scope) as string[]), ...(chat ? [r.key === "" ? null : r.key] : [])]);
  const snapshot = (env: BackupEnv) => new Map(keysWith(env.storage, prefix).filter((k) => parts(env, k)).map((k) => [k, env.storage.getItem(k) ?? ""]));
  return {
    async load(env) {
      const now = snapshot(env);
      const recs = [...now].flatMap(([k, text]): Rec[] => {
        let value: unknown = text;
        if (json)
          try {
            value = JSON.parse(text);
          } catch {
            return [];
          }
        return [{ ...parts(env, k)!, value }];
      });
      return { recs, raw: JSON.stringify([...now]) };
    },
    async save(env, before, recs) {
      const { storage } = env;
      const now = snapshot(env);
      if (JSON.stringify([...now]) !== before.raw) throw new ChangedError();
      const read = (text: string): { value: unknown } | undefined => {
        if (!json) return { value: text };
        try {
          return { value: JSON.parse(text) };
        } catch {
          return undefined;
        }
      };
      const want = new Map(recs.map((r) => [keyOf(r), r.value]));
      const changes = new Map<string, string | null>();
      // A key whose value this version can't read was never a record: it stays as it is.
      for (const [k, text] of now) if (!want.has(k) && read(text)) changes.set(k, null);
      for (const [k, v] of want) {
        const had = now.has(k) ? read(now.get(k)!) : undefined;
        if (!had || stable(had.value) !== stable(v)) changes.set(k, json ? JSON.stringify(v) : String(v));
      }
      writeAll(storage, changes);
    },
  };
}

/**
 * A category kept as one versioned document `{v, scopes: {[scope]: …}}` in a swapped file (or localStorage, through
 * the same swap). `split` turns one scope's part into records, `join` records back. Scopes it couldn't read, and
 * fields it doesn't know, are kept as they were. A document from a newer app is read, but never written.
 */
function perDoc(
  file: (env: BackupEnv) => DefaultsFile,
  version: number,
  split: (scope: string, part: unknown) => Rec[],
  /** One scope's records as stored, given what is stored there now; undefined removes the scope. */
  join: (recs: Rec[], prior: unknown) => unknown,
): Pick<Category, "load" | "save"> {
  const parse = (raw: string | null) => {
    try {
      const doc: unknown = raw === null ? undefined : JSON.parse(raw);
      return isObj(doc) ? doc : {};
    } catch {
      return {};
    }
  };
  return {
    async load(env) {
      const raw = await file(env).read();
      const doc = parse(raw);
      const scopes = isObj(doc.scopes) ? doc.scopes : {};
      const recs = Object.entries(scopes).flatMap(([scope, part]) => (placeIn(env, scope) ? split(scope, part) : []));
      return { recs, raw: JSON.stringify(raw) };
    },
    async save(env, before, recs) {
      const raw = JSON.parse(before.raw) as string | null;
      const doc = parse(raw);
      if (Number.isSafeInteger(doc.v) && (doc.v as number) > version)
        throw new Error("A newer version of Hermes Chat wrote what this computer keeps for it, so this version didn't change it.");
      // Only the scopes whose records changed are written again; every other one keeps its stored text, fields this
      // version doesn't know included.
      const of = (list: Rec[], scope: string) => stable(list.filter((r) => r.scope === scope));
      const scopes: Record<string, unknown> = { ...(isObj(doc.scopes) ? doc.scopes : {}) };
      for (const scope of new Set([...before.recs, ...recs].map((r) => r.scope))) {
        if (of(before.recs, scope) === of(recs, scope)) continue;
        const part = join(recs.filter((r) => r.scope === scope), scopes[scope]);
        if (part === undefined) delete scopes[scope];
        else scopes[scope] = part;
      }
      const next = JSON.stringify({ ...doc, v: Math.max(Number.isSafeInteger(doc.v) ? (doc.v as number) : 0, version), scopes });
      const r = await file(env).swap(raw, next);
      if (!r.swapped) throw new ChangedError();
    },
  };
}

/** The owner's grouping in one scope of the projects document: which chats are in each project, and what the list shows. */
const grouping = (part: unknown): ScopeLinks | undefined => {
  const v = readLinks({ v: PROJECTS_VERSION, scopes: { x: part } }).x;
  return v && { ...(v.selected && { selected: v.selected }), chats: v.chats, known: v.known };
};

/** The display and startup settings a backup holds. Each profile's chat to reopen isn't: it's a copy of the server's list. */
const SETTINGS_FIELDS = ["theme", "reopenLastChat", "checkUpdatesOnLaunch", "modelPicker", "modelFavorites", "statusBar", "screenshotShortcut", "previewWidth", "terminalKind", "keybindings"];
const prefsDoc = (s: BackupStorage): Record<string, unknown> => {
  try {
    const d: unknown = JSON.parse(s.getItem(UI_PREFS_KEY) ?? "{}");
    return isObj(d) ? d : {};
  } catch {
    return {};
  }
};
const settingsRaw = (s: BackupStorage) => {
  const doc = prefsDoc(s);
  return stable([Object.fromEntries(SETTINGS_FIELDS.filter((f) => f in doc).map((f) => [f, doc[f]])), s.getItem(APPEARANCE_KEY), s.getItem(TERMINAL_TARGET_KEY)]);
};
const templatesRaw = (s: BackupStorage) => stable(prefsDoc(s).templates ?? null);

export const CATEGORIES = {
  settings: {
    label: "Settings",
    holds: "Theme, appearance and custom themes, startup and display choices, the model pick and favorites, status bar, screenshot shortcut, terminal target and which computer it opens on",
    scoped: false,
    async load({ storage }) {
      const doc = prefsDoc(storage);
      const recs: Rec[] = SETTINGS_FIELDS.filter((f) => f in doc).map((f) => ({ scope: "", key: f, value: doc[f] }));
      for (const [key, k] of [["appearance", APPEARANCE_KEY], ["terminalTarget", TERMINAL_TARGET_KEY]] as const) {
        const v = storage.getItem(k);
        if (v === null) continue;
        try {
          recs.push({ scope: "", key, value: key === "appearance" ? JSON.parse(v) : v });
        } catch {
          // An unreadable appearance is the defaults; nothing to keep.
        }
      }
      return { recs, raw: settingsRaw(storage) };
    },
    async save({ storage }, before, recs) {
      if (settingsRaw(storage) !== before.raw) throw new ChangedError();
      const doc = prefsDoc(storage);
      for (const f of SETTINGS_FIELDS) delete doc[f];
      const get = (key: string) => recs.find((r) => r.key === key)?.value;
      for (const r of recs) if (SETTINGS_FIELDS.includes(r.key)) doc[r.key] = r.value;
      const appearance = get("appearance");
      const terminal = get("terminalTarget");
      writeAll(
        storage,
        new Map([
          [UI_PREFS_KEY, JSON.stringify({ v: 1, ...doc })],
          [APPEARANCE_KEY, appearance === undefined ? null : JSON.stringify(appearance)],
          [TERMINAL_TARGET_KEY, terminal === undefined ? null : String(terminal)],
        ]),
      );
    },
    check(key, value) {
      if (key === "appearance") return isObj(value) ? loadAppearance({ getItem: () => JSON.stringify(value), setItem: () => {} }) : undefined;
      if (key === "terminalTarget") return short(value, 512) && value.trim() && !/[\0-\x1f\x7f]/.test(value) ? value : undefined;
      if (!SETTINGS_FIELDS.includes(key)) return undefined;
      // Only a value this version would keep as it is; one it would change back to the default isn't restored.
      const read = (readUIPrefs({ [key]: value }) as Record<string, unknown>)[key];
      return stable(read) === stable(value) ? read : undefined;
    },
  },
  templates: {
    label: "Templates",
    holds: "Your message templates: names, descriptions and text, and the project each is offered in",
    scoped: false,
    async load({ storage }) {
      const list = toTemplates(prefsDoc(storage).templates) ?? [];
      return { recs: list.map((t) => ({ scope: "", key: t.id, value: t })), raw: templatesRaw(storage) };
    },
    async save({ storage }, before, recs) {
      if (templatesRaw(storage) !== before.raw) throw new ChangedError();
      const doc = prefsDoc(storage);
      writeAll(storage, new Map([[UI_PREFS_KEY, JSON.stringify({ v: 1, ...doc, templates: recs.map((r) => r.value) })]]));
    },
    check(key, value) {
      const t = toTemplates([value])?.[0];
      return t && t.id === key ? t : undefined;
    },
    tidy(recs) {
      // In order, each kept only if the store would keep it beside those before it: one id and one name each.
      const kept: Rec[] = [];
      for (const r of recs) if ((toTemplates([...kept, r].map((k) => k.value))?.length ?? 0) > kept.length) kept.push(r);
      return kept;
    },
    toFile(value, place) {
      const t = value as Template;
      return t.project ? { ...t, project: { ...t.project, scope: place(t.project.scope) } } : t;
    },
    fromFile(value, scope) {
      const t = value as Template;
      if (!isObj(t) || !isObj(t.project)) return t;
      const s = scope(String(t.project.scope));
      // A template for a project whose profile isn't restored is skipped, not shown everywhere.
      return s ? { ...t, project: { ...t.project, scope: s } } : undefined;
    },
  },
  drafts: {
    label: "Drafts",
    holds: "The text you typed in each chat's composer, and in the New chat pane, and haven't sent",
    scoped: true,
    ...perKey("hermes-chat.draft.", true, false),
    // Any draft the store keeps; the archive's own size limits bound it.
    check: (_, v) => (typeof v === "string" && v.length > 0 ? v : undefined),
  },
  queues: {
    label: "Queued messages",
    holds: "Each chat's messages waiting to go after a reply, text only. They come back paused and are never sent on their own",
    scoped: true,
    ...perKey("hermes-chat.queue.", true, true),
    check(_, v) {
      const q = toQueue(v);
      const items = (q?.items ?? []).filter((i) => i.text.trim()).slice(0, QUEUE_LIMIT).map(({ id, text }) => ({ id, text }));
      return items.length ? ({ items, paused: RESTORED_PAUSE } satisfies ChatQueue) : undefined;
    },
  },
  projects: {
    label: "Project membership",
    holds: "Which chats are in each project, the project the list shows, and the projects as Hermes last listed them",
    scoped: true,
    ...perDoc(
      (env) => storageDefaultsFile(() => env.storage, PROJECTS_KEY),
      PROJECTS_VERSION,
      (scope, part) => {
        const v = grouping(part);
        return v ? [{ scope, key: "", value: v }] : [];
      },
      (recs, prior) => {
        // The membership sync's own fields (projectLinks.ts) stay as stored: they're this computer's bookkeeping with
        // Hermes, never in a backup. Once membership is Hermes's (`synced`), its chats here are Hermes's copy.
        const { selected: _s, chats, known: _k, ...sync } = isObj(prior) ? prior : {};
        const v = recs[0]?.value as ScopeLinks | undefined;
        if (sync.synced && stable(v?.chats ?? {}) !== stable(grouping(prior)?.chats ?? {}))
          throw new Error("Hermes keeps this profile's project membership now, so it wasn't changed here.");
        if (!v) return Object.keys(sync).length ? { ...sync, chats: sync.synced ? chats : {}, known: [] } : undefined;
        return { ...sync, ...v };
      },
    ),
    check: (_, v) => grouping(v),
    merge(mine, theirs) {
      const a = mine as ScopeLinks;
      const b = theirs as ScopeLinks;
      const chats = { ...b.chats };
      for (const [p, ids] of Object.entries(a.chats)) chats[p] = [...new Set([...ids, ...(b.chats[p] ?? [])])];
      return { ...((a.selected ?? b.selected) && { selected: a.selected ?? b.selected }), chats, known: a.known.length ? a.known : b.known };
    },
  },
  projectDefaults: {
    label: "Project defaults",
    holds: "Each project's instructions, model and working folder for new chats",
    scoped: true,
    ...perDoc(
      (env) => env.defaults,
      1,
      (scope, part) => (isObj(part) ? Object.entries(part).flatMap(([key, v]) => (toDefaults(v) ? [{ scope, key, value: toDefaults(v) }] : [])) : []),
      (recs) => (recs.length ? Object.fromEntries(recs.map((r) => [r.key, r.value])) : undefined),
    ),
    check: (_, v) => toDefaults(v),
    // A new revision past both, so a project's screen open in another window sees the change and doesn't save over it.
    over: (mine, next) => ({ ...(next as ProjectDefaults), rev: Math.max((mine as ProjectDefaults | undefined)?.rev ?? 0, (next as ProjectDefaults).rev) + 1 }),
  },
  tags: {
    label: "Tags and Saved filters",
    holds: "Your tags, which chats have them, and your Saved filters",
    scoped: true,
    ...perDoc(
      (env) => env.tags,
      1,
      (scope, part) => {
        const v = readTags({ v: 1, scopes: { [scope]: part } })[scope];
        return v ? [{ scope, key: "", value: v }] : [];
      },
      (recs) => recs[0]?.value,
    ),
    check: (_, v) => readTags({ v: 1, scopes: { x: v } }).x,
  },
  branches: {
    label: "Branch origins",
    holds: "Which message each branch made here came from, with a short excerpt of it",
    scoped: true,
    ...perKey("hermes-chat.branches.", false, true),
    check(_, v) {
      const links = toBranches(v).links;
      return Object.keys(links).length ? { links, attempts: [] } : undefined;
    },
    merge: (mine, theirs) => ({ ...(mine as object), links: { ...(theirs as { links: object }).links, ...(mine as { links: object }).links } }),
  },
} satisfies Record<string, Category>;

export type CategoryId = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];
const cat = (id: CategoryId): Category => CATEGORIES[id];

/** The app's storage: this webview's localStorage, and the tags and project defaults files every instance shares. */
export const savedBackupEnv = (connections?: () => readonly ScopeSource[]): BackupEnv => ({
  storage: localStorage,
  tags: savedTagsFile,
  defaults: savedDefaultsFile,
  ...(connections && { place: placesOf(connections) }),
});

/** A backup the owner picked to restore (src-tauri backup.rs `PickedBackup`). */
export type PickedBackup = { name: string; path: string; bytes: number; entries: Entry[] };
/** The archive side, in Rust: the Save and Open dialogs, and the recovery folder. */
export const tauriBackup = {
  save: (entries: Entry[], fileName: string) => invoke<string | null>("backup_export", { entries, fileName }),
  pick: () => invoke<PickedBackup | null>("backup_pick"),
  saveRecovery: (entries: Entry[]) => invoke<string>("backup_save_recovery", { entries }),
};

// --- Export ---

/** One file in a backup archive (src-tauri backup.rs `Entry`). */
export type Entry = { name: string; text: string };
type FileRec = { place?: string; key: string; value: unknown };
type ManifestFile = { file: string; records: number; sha256: string };
export type Manifest = {
  format: string;
  schema: number;
  createdAt: string;
  places: Record<string, Place>;
  files: Partial<Record<CategoryId, ManifestFile>>;
  leftOut: string[];
};
/** What an export holds: each category's records, and how many places they're for. */
export type ExportSummary = { counts: Record<CategoryId, number>; places: Place[]; queueFilesLeftOut: number };

const fileName = (id: CategoryId) => `${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.json`;

/** What a backup would hold now, for the export dialog. */
export async function summarize(env: BackupEnv): Promise<ExportSummary> {
  const counts = {} as Record<CategoryId, number>;
  const scopes = new Set<string>();
  let queueFilesLeftOut = 0;
  for (const id of CATEGORY_IDS) {
    const recs = (await cat(id).load(env)).recs.filter((r) => cat(id).check(r.key, r.value) !== undefined);
    counts[id] = recs.length;
    for (const r of recs) if (r.scope) scopes.add(r.scope);
    if (id === "queues") queueFilesLeftOut = recs.reduce((n, r) => n + (toQueue(r.value)?.items ?? []).reduce((m, i) => m + (i.attachments?.length ?? 0), 0), 0);
  }
  return { counts, places: [...scopes].flatMap((s) => placeIn(env, s) ?? []), queueFilesLeftOut };
}

/**
 * A backup of the categories `ids` as they are now: the archive's files. Values go through the checks a restore uses
 * (a queued message's files are dropped), except with `raw`, for the recovery backup: that keeps every record as this
 * computer stores it, so nothing a restore replaces or removes is missing from it.
 */
export async function makeBackup(env: BackupEnv, ids: readonly CategoryId[], now = new Date(), opts: { raw?: boolean } = {}): Promise<Entry[]> {
  const places: Record<string, Place> = {};
  const placeIds = new Map<string, string>();
  const place = (scope: string) => {
    let id = placeIds.get(scope);
    if (!id) {
      // A scope no connection here has (a template's project on a removed connection) names no place, so it isn't restored.
      const p = placeIn(env, scope);
      if (!p) return "";
      id = `p${placeIds.size + 1}`;
      placeIds.set(scope, id);
      places[id] = p;
    }
    return id;
  };
  const entries: Entry[] = [];
  const files: Manifest["files"] = {};
  for (const id of ids) {
    const c = cat(id);
    const records: FileRec[] = (await c.load(env)).recs.flatMap((r): FileRec[] => {
      const value = opts.raw ? r.value : c.check(r.key, r.value);
      if (value === undefined) return [];
      return [{ ...(c.scoped && { place: place(r.scope) }), key: r.key, value: c.toFile ? c.toFile(value, place) : value }];
    });
    const text = JSON.stringify({ category: id, records });
    entries.push({ name: fileName(id), text });
    files[id] = { file: fileName(id), records: records.length, sha256: await sha256(text) };
  }
  const manifest: Manifest = { format: BACKUP_FORMAT, schema: BACKUP_SCHEMA, createdAt: now.toISOString(), places, files, leftOut: LEFT_OUT };
  return [{ name: "manifest.json", text: JSON.stringify(manifest, null, 2) }, ...entries];
}

/** The file name the Save dialog suggests. */
export const backupFileName = (now = new Date()) => `hermes-chat-backup-${now.toISOString().slice(0, 10)}.zip`;

// --- Reading a backup ---

/** Why a backup can't be restored at all; nothing was written. */
export class BackupError extends Error {}

type Files = { manifest: Record<string, unknown>; files: Map<string, string> };
/** A backup read and checked whole: its manifest, and each supported category's records. */
export type Backup = { manifest: Manifest; data: Partial<Record<CategoryId, FileRec[]>>; unsupported: string[] };

const RECORDS_MAX = 50_000;

/** Reads and checks every file of a backup: format, schema, checksums, counts and records. Throws BackupError. */
export async function readBackup(entries: readonly Entry[]): Promise<Backup> {
  const files = new Map(entries.map((e) => [e.name, e.text]));
  let manifest: unknown;
  try {
    manifest = JSON.parse(files.get("manifest.json") ?? "");
  } catch {
    throw new BackupError("It has no readable manifest.json, so it isn't a Hermes Chat backup, or it's damaged.");
  }
  if (!isObj(manifest) || manifest.format !== BACKUP_FORMAT) throw new BackupError("It isn't a Hermes Chat backup.");
  let schema = manifest.schema;
  if (!Number.isSafeInteger(schema) || (schema as number) < 1) throw new BackupError("Its manifest has no schema version this app can read.");
  if ((schema as number) > BACKUP_SCHEMA)
    throw new BackupError(`A newer Hermes Chat made it (backup schema ${schema}); this version reads schema ${BACKUP_SCHEMA}. Update Hermes Chat, then restore it.`);
  let b: Files = { manifest, files };
  while ((schema as number) < BACKUP_SCHEMA) {
    const step = MIGRATIONS[schema as number];
    if (!step) throw new BackupError(`This version can't read a backup of schema ${schema}.`);
    b = step(b);
    schema = (schema as number) + 1;
  }
  const m = b.manifest;
  const places: Record<string, Place> = {};
  for (const [id, p] of Object.entries(isObj(m.places) ? m.places : {})) {
    const place = isObj(p) ? toPlace([p.mode, p.target, p.username, p.profile]) : undefined;
    if (!place || !/^p\d{1,4}$/.test(id)) throw new BackupError("Its manifest names a connection or profile it can't read.");
    places[id] = place;
  }
  const listed = isObj(m.files) ? m.files : {};
  const data: Backup["data"] = {};
  const unsupported: string[] = [];
  for (const [id, f] of Object.entries(listed)) {
    if (!(id in CATEGORIES)) {
      unsupported.push(id);
      continue;
    }
    if (!isObj(f) || typeof f.file !== "string" || typeof f.sha256 !== "string" || !Number.isSafeInteger(f.records))
      throw new BackupError(`Its manifest's entry for ${cat(id as CategoryId).label} can't be read.`);
    const text = b.files.get(f.file);
    if (text === undefined) throw new BackupError(`It's missing ${f.file}, which its manifest lists. It may have been cut short.`);
    if ((await sha256(text)) !== f.sha256) throw new BackupError(`${f.file} doesn't match its checksum: the backup is damaged or was changed after it was made.`);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new BackupError(`${f.file} isn't readable JSON.`);
    }
    const recs = isObj(doc) && Array.isArray(doc.records) ? doc.records : undefined;
    if (!recs || recs.length !== f.records || recs.length > RECORDS_MAX) throw new BackupError(`${f.file} doesn't hold the ${f.records} records its manifest says.`);
    const scoped = cat(id as CategoryId).scoped;
    data[id as CategoryId] = recs.map((r): FileRec => {
      if (!isObj(r) || !short(r.key, 400) || (scoped ? typeof r.place !== "string" || !(r.place in places) : r.place !== undefined))
        throw new BackupError(`${f.file} holds a record it can't read.`);
      return { ...(scoped && { place: r.place as string }), key: r.key, value: r.value };
    });
  }
  const manifestOut: Manifest = {
    format: BACKUP_FORMAT,
    schema: BACKUP_SCHEMA,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    places,
    files: listed as Manifest["files"],
    leftOut: Array.isArray(m.leftOut) ? m.leftOut.filter((s): s is string => typeof s === "string") : [],
  };
  return { manifest: manifestOut, data, unsupported };
}

// --- Planning a restore ---

export type Policy = "skip" | "merge" | "replace";
/** Each place's profile on this computer's connection: a name, null to leave it out, or undefined until the owner chooses. */
export type Mapping = Record<string, string | null | undefined>;
export type Skipped = { reason: string; n: number };
export type CategoryPlan = {
  id: CategoryId;
  policy: Policy;
  inBackup: number;
  /** Records new to this computer, the same here already, combined with this computer's, kept as this computer has
   * them on a conflict (merge), or taken from the backup over a different one (replace). */
  add: number;
  same: number;
  merged: number;
  kept: number;
  replaced: number;
  /** This computer's records, in the places restored, that a replace deletes. */
  removed: number;
  skipped: Skipped[];
  changes: boolean;
  result: Rec[];
  base: string;
};
export type RestorePlan = { categories: CategoryPlan[]; problem?: string };
export type Current = Record<CategoryId, Loaded>;

export async function loadCurrent(env: BackupEnv): Promise<Current> {
  const out = {} as Current;
  for (const id of CATEGORY_IDS) out[id] = await cat(id).load(env);
  return out;
}

/** Where each place goes before the owner chooses: an identical connection and a profile the server lists. */
export function defaultMapping(backup: Backup, target: Conn, profiles: readonly string[]): Mapping {
  return Object.fromEntries(
    Object.entries(backup.manifest.places).map(([id, p]) => [id, sameConn(p, target) && profiles.includes(p.profile) ? p.profile : undefined]),
  );
}

/** What restoring `backup` under `policies` and `mapping` would do to this computer's `current` data. */
export function planRestore(backup: Backup, current: Current, target: Target, mapping: Mapping, policies: Partial<Record<CategoryId, Policy>>): RestorePlan {
  const scopeOfPlace = (id: string) => {
    const profile = mapping[id];
    return profile ? scopeAt(target, profile) : profile;
  };
  const categories: CategoryPlan[] = [];
  let problem: string | undefined;
  const targets = Object.values(mapping).filter((p): p is string => !!p);
  if (Object.keys(backup.manifest.places).some((pl) => mapping[pl] === undefined)) problem = "Choose where each connection and profile in the backup goes, or leave it out.";
  else if (new Set(targets).size !== targets.length) problem = "Two connections or profiles in the backup go to the same profile here. Choose a different one, or leave one out.";
  for (const id of CATEGORY_IDS) {
    const recs = backup.data[id];
    if (!recs) continue;
    const c = cat(id);
    const policy = policies[id] ?? "merge";
    const skipped = new Map<string, number>();
    const skip = (reason: string, n = 1) => skipped.set(reason, (skipped.get(reason) ?? 0) + n);
    const p: CategoryPlan = { id, policy, inBackup: recs.length, add: 0, same: 0, merged: 0, kept: 0, replaced: 0, removed: 0, skipped: [], changes: false, result: current[id].recs, base: stable(current[id].recs) };
    categories.push(p);
    if (policy === "skip") {
      if (recs.length) skip("You chose not to restore these", recs.length);
      p.skipped = [...skipped].map(([reason, n]) => ({ reason, n }));
      continue;
    }
    const incoming: Rec[] = [];
    for (const r of recs) {
      const scope = c.scoped ? scopeOfPlace(r.place!) : "";
      if (scope === null || scope === undefined) {
        skip(scope === null ? "Their connection or profile isn't being restored" : "Waiting for you to choose where they go");
        continue;
      }
      const raw = c.fromFile ? c.fromFile(r.value, scopeOfPlace) : r.value;
      const value = raw === undefined ? undefined : c.check(r.key, raw);
      if (value === undefined) {
        skip(raw === undefined ? "Their project's profile isn't being restored" : "This version can't use them");
        continue;
      }
      if (incoming.some((o) => o.scope === scope && o.key === r.key)) skip("The backup holds them twice");
      else incoming.push({ scope, key: r.key, value });
    }
    // The places restored: every mapped one, for a scoped category; the whole computer for the others.
    const touched = c.scoped ? new Set(Object.keys(mapping).flatMap((pl) => scopeOfPlace(pl) ?? [])) : new Set([""]);
    const mine = new Map(current[id].recs.map((r) => [`${r.scope}\n${r.key}`, r]));
    const out = current[id].recs.filter((r) => !touched.has(r.scope) || (policy === "merge" && !incoming.some((i) => i.scope === r.scope && i.key === r.key)));
    if (policy === "replace") p.removed = current[id].recs.filter((r) => touched.has(r.scope) && !incoming.some((i) => i.scope === r.scope && i.key === r.key)).length;
    const added: Rec[] = [];
    for (const r of incoming) {
      const had = mine.get(`${r.scope}\n${r.key}`);
      const hadValue = had && c.check(had.key, had.value);
      if (!had) {
        p.add++;
        added.push(c.over ? { ...r, value: c.over(undefined, r.value) } : r);
      } else if (stable(hadValue) === stable(r.value)) {
        p.same++;
        out.push(had);
      } else if (policy === "replace") {
        p.replaced++;
        added.push(c.over ? { ...r, value: c.over(had.value, r.value) } : r);
      } else if (c.merge) {
        const value = c.merge(had.value, r.value);
        if (stable(value) === stable(had.value)) p.same++, out.push(had);
        else p.merged++, added.push({ ...r, value });
      } else {
        p.kept++;
        out.push(had);
      }
    }
    let result = [...out, ...added];
    if (c.tidy) {
      const tidied = c.tidy(result);
      const lost = added.filter((r) => !tidied.includes(r)).length;
      if (lost) {
        skip("One of the same name is already here", lost);
        p.add -= Math.min(p.add, lost);
      }
      result = tidied;
    }
    p.result = result;
    p.changes = p.add + p.merged + p.replaced + p.removed > 0;
    p.skipped = [...skipped].map(([reason, n]) => ({ reason, n }));
  }
  return { categories, problem };
}

/** Why a restore can't run now, or undefined. It reloads the app on what it wrote, so nothing may be under way. */
export function restoreBlocked(o: {
  /** A reply running or an Approval waiting, in the profile shown or another the inbox sees. */
  working: boolean;
  /** Drafts or queues this computer's storage refused (unsaved.ts `unsaved`). */
  unsaved: number;
  /** Messages on their way that no outbox holds yet (unsaved.ts `sending`). */
  sending: number;
}): string | undefined {
  if (o.working) return "A reply is running or an Approval is waiting. Restore once it has finished, or after stopping the reply.";
  if (o.sending) return "A message is still being sent. Restore once it has gone.";
  if (o.unsaved) return "This computer couldn't save some drafts or queued messages. Free some space or restart Hermes Chat before restoring.";
  return undefined;
}

// --- Applying it ---

export type CategoryOutcome =
  | { id: CategoryId; state: "restored"; plan: CategoryPlan }
  | { id: CategoryId; state: "unchanged" | "skipped"; plan: CategoryPlan }
  /** `changed`: the write failed part way and couldn't all be undone, so this category isn't as it was. */
  | { id: CategoryId; state: "failed"; plan: CategoryPlan; reason: string; changed?: boolean };
export type RestoreReport = { recovery?: string; recoveryError?: string; outcomes: CategoryOutcome[] };

/** Whether a restore changed anything this computer keeps, so the app must reload to read it. */
export const restoreWrote = (r: RestoreReport) => r.outcomes.some((o) => o.state === "restored" || (o.state === "failed" && o.changed));

/**
 * Saves a recovery backup of everything (`saveRecovery` answers where), then writes each category the plan changes,
 * whole or not at all. Without a recovery backup nothing is written. A category that fails leaves the others written,
 * and itself as it was.
 */
export async function applyRestore(env: BackupEnv, plan: RestorePlan, saveRecovery: (entries: Entry[]) => Promise<string>): Promise<RestoreReport> {
  if (plan.problem) throw new Error(plan.problem);
  let recovery: string;
  try {
    recovery = await saveRecovery(await makeBackup(env, CATEGORY_IDS, new Date(), { raw: true }));
  } catch (e) {
    const why = errorText(e);
    return { recoveryError: `Couldn't save a recovery backup first (${why}), so nothing was restored.`, outcomes: plan.categories.map((p) => ({ id: p.id, state: "skipped", plan: p })) };
  }
  const outcomes: CategoryOutcome[] = [];
  for (const p of plan.categories) {
    if (p.policy === "skip") outcomes.push({ id: p.id, state: "skipped", plan: p });
    else if (!p.changes) outcomes.push({ id: p.id, state: "unchanged", plan: p });
    else
      try {
        const before = await cat(p.id).load(env);
        if (stable(before.recs) !== p.base) throw new ChangedError();
        await cat(p.id).save(env, before, p.result);
        outcomes.push({ id: p.id, state: "restored", plan: p });
      } catch (e) {
        outcomes.push({ id: p.id, state: "failed", plan: p, reason: errorText(e), ...(e instanceof WriteError && e.changed && { changed: true }) });
      }
  }
  return { recovery, outcomes };
}
