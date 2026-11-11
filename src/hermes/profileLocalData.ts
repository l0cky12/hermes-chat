// Everything this computer keeps for one profile of one connection, in one list, and the two walks over it (ADR 0144):
// a rename moves it all from the old name to the new one (`renameProfileLocally`), and a delete forgets it
// (`forgetProfileLocally`). Removing a connection forgets every profile's at once (forgetConnection.ts), through the same
// list. Nothing here talks to Hermes.
//
// The data is kept in four shapes, each listed once below:
// - `PROFILE_KEYS`: one storage key per profile or per chat, a prefix and then the scope `[...connection, profile, …]`.
// - `CONNECTION_KEYS`: one key per connection whose value names profiles (the profile shown last, the profiles whose
//   older chats were pulled, the inbox's dismissals).
// - `SCOPED_DOCS`: one versioned document `{scopes: {[scope]: …}}` per kind, a scope per connection and profile. The
//   tags and project defaults files are documents of this shape too, swapped in files every window shares.
// - `uiPrefs`: the chat to reopen and the model pick, kept per profile (`prefScope`), and templates tied to a project.
// A test (profileLocalData.test.ts) reads every storage key the app's source names and fails on one that isn't listed
// here or in `NOT_PER_PROFILE`.
import { BRANCH_PREFIX, HELD_PREFIX, LIST_PREFIX, OUTBOX_PREFIX, PROFILE_PREFIX, PULLED_PREFIX, QUEUE_PREFIX, TRANSCRIPT_PREFIX, moveLiveChatData } from "./chatCache";
import { type ScopeSource, connectionScope, inScope, isPrefOf, prefScope, scopeParts } from "./connections";
import { DRAFT_PREFIX } from "./drafts";
import { IMPORTS_KEY } from "./importTranscripts";
import { INBOX_PREFIX } from "./inbox";
import { OUTPUTS_KEY } from "./outputs";
import { PERSONA_PREFIX, type PersonaStore } from "./personaStore";
import { CONTEXT_LEDGER_KEY } from "./projectContextFiles";
import { type DefaultsDoc, moveScopeKeys } from "./projectDefaults";
import { PROJECTS_KEY } from "./projectLinks";
import { CLEARED_KEY, PINS_KEY, SNOOZE_KEY, STOP_WAITING_KEY } from "./snooze";
import { moveTagScopes, type TagsFile } from "./tags";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";
import { sending, unsaved } from "./unsaved";
import { WORKTREE_CHATS_KEY } from "./worktrees";

/** Keys of one profile, or one of its chats: the prefix, then the scope as JSON, then `suffix` if it has one. */
export const PROFILE_KEYS: readonly { prefix: string; suffix?: RegExp }[] = [
  { prefix: LIST_PREFIX },
  { prefix: TRANSCRIPT_PREFIX },
  { prefix: OUTBOX_PREFIX },
  { prefix: QUEUE_PREFIX },
  { prefix: HELD_PREFIX },
  { prefix: BRANCH_PREFIX },
  { prefix: DRAFT_PREFIX },
  { prefix: PERSONA_PREFIX, suffix: /\.(draft|earlier)$/ },
];

/** Keys of one connection whose value names its profiles. `kind` says how. */
export const CONNECTION_KEYS: readonly { prefix: string; kind: "name" | "names" | "dismissals" }[] = [
  { prefix: PROFILE_PREFIX, kind: "name" },
  { prefix: PULLED_PREFIX, kind: "names" },
  { prefix: INBOX_PREFIX, kind: "dismissals" },
];

/** A rename made on the server whose move on this computer hasn't finished, by connection (`renamePending`). */
export const RENAMES_KEY = "hermes-chat.profile-renames";

/** Documents `{scopes: {[scope]: …}}` with a scope for each connection and profile. */
export const SCOPED_DOCS: readonly string[] = [
  PROJECTS_KEY,
  OUTPUTS_KEY,
  SNOOZE_KEY,
  CLEARED_KEY,
  PINS_KEY,
  STOP_WAITING_KEY,
  IMPORTS_KEY,
  WORKTREE_CHATS_KEY,
  CONTEXT_LEDGER_KEY,
];

/**
 * Storage keys the app keeps that hold nothing of one profile, each with why, so the coverage test can tell a key
 * forgotten here from one that needs no move. The tags and project defaults files are in `SCOPED_DOCS`' shape but
 * swapped in files (`files` below); their keys here are their browser stand-ins.
 */
export const NOT_PER_PROFILE: Record<string, string> = {
  "hermes-chat.appearance": "The look of the app, the same for every connection",
  "hermes-chat.connections": "The saved connections themselves",
  "hermes-chat.sign-in": "The single sign-in kept before saved connections, moved into them once",
  "hermes-chat.connection-refs": "Which connection a chat link names, per connection",
  "hermes-chat.repo-path": "The Repository screen's folder, on this computer",
  "hermes-chat.repo-recent": "The Repository screen's recent folders, on this computer",
  "hermes-chat.repo-target": "The Repository screen's SSH target, on this computer",
  "hermes-chat.terminal-target": "The terminal's SSH target, per connection",
  "hermes-chat.tags": "The tags file's stand-in outside the app: moved as a file (`files.tags`)",
  "hermes-chat.project-defaults": "The project defaults file's stand-in outside the app: moved as a file (`files.defaults`)",
  "hermes-ui-prefs": "Display preferences: its per-profile parts are moved by `movePrefs`",
  [RENAMES_KEY]: "Renames waiting to move this computer's data, per connection",
};

/** Where a scope goes: undefined keeps it, null drops it, a string moves it there. */
export type ScopeMove = (scope: string) => string | null | undefined;

/** Moves the scopes of profile `from` of the connection with these `parts` to profile `to`, or drops them (`to` null). */
export function profileMove(parts: readonly string[], from: string, to: string | null): ScopeMove {
  return (scope) => {
    let v: unknown;
    try {
      v = JSON.parse(scope);
    } catch {
      return undefined;
    }
    if (!Array.isArray(v) || v.length <= parts.length || !parts.every((p, i) => v[i] === p) || v[parts.length] !== from) return undefined;
    if (to === null) return null;
    const next = [...(v as unknown[])];
    next[parts.length] = to;
    return JSON.stringify(next);
  };
}

/** Drops every scope of the connection with these `parts`. */
export const connectionMove =
  (parts: readonly string[]): ScopeMove =>
  (scope) =>
    inScope([...parts], scope) ? null : undefined;

/** What one walk does: the scopes it moves, and for the per-connection values, which profile goes where. */
type Walk = { move: ScopeMove; parts: readonly string[]; profile?: { from: string; to: string | null } };

/** A per-profile key's new key under `walk`, null to drop it, undefined to keep it. */
function movedKey(key: string, walk: Walk): string | null | undefined {
  for (const { prefix, suffix } of PROFILE_KEYS) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const tail = (suffix && suffix.exec(rest)?.[0]) || "";
    const to = walk.move(tail ? rest.slice(0, -tail.length) : rest);
    return to === undefined || to === null ? to : prefix + to + tail;
  }
  return undefined;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(storage: Store, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return undefined;
  }
}

/** Rewrites a `{scopes: {...}}` document with its scopes moved, keeping everything else as stored. */
function moveDoc(storage: Store, key: string, move: ScopeMove) {
  const doc = readJson(storage, key);
  if (!isObj(doc) || !isObj(doc.scopes)) return;
  const scopes = moveScopeKeys(doc.scopes, move);
  if (scopes) storage.setItem(key, JSON.stringify({ ...doc, scopes }));
}

/** An inbox dismissal's key with its profile moved (`<kind> <profile> …`, or `resumed <kind> <profile> …`). */
function movedDismissal(key: string, from: string, to: string | null): string | null | undefined {
  const words = key.split(" ");
  const at = words[0] === "resumed" ? 2 : 1;
  if (words[at] !== from) return undefined;
  if (to === null) return null;
  words[at] = to;
  return words.join(" ");
}

/** The per-connection keys whose values name profiles, with the profile moved or dropped. */
function moveConnectionValues(storage: Store, parts: readonly string[], from: string, to: string | null) {
  // The connection's own scope, as `connectionScope` writes it.
  const scope = JSON.stringify([...parts]);
  for (const { prefix, kind } of CONNECTION_KEYS) {
    const key = prefix + scope;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    if (kind === "name") {
      if (raw !== from) continue;
      if (to === null) storage.removeItem(key);
      else storage.setItem(key, to);
    } else if (kind === "names") {
      const names = readJson(storage, key);
      if (!Array.isArray(names) || !names.includes(from)) continue;
      const next = [...new Set(names.flatMap((n) => (n === from ? (to === null ? [] : [to]) : [n])))];
      storage.setItem(key, JSON.stringify(next));
    } else {
      const doc = readJson(storage, key);
      if (!isObj(doc)) continue;
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(doc)) {
        const moved = movedDismissal(k, from, to);
        if (moved === undefined) next[k] = v;
        else {
          changed = true;
          if (moved !== null) next[moved] = v;
        }
      }
      if (changed) storage.setItem(key, JSON.stringify(next));
    }
  }
}

/** The display preferences kept per profile (`prefScope`), and templates tied to a project, moved or dropped. */
function movePrefs(c: ScopeSource, walk: Walk) {
  const { lastOpenChat, modelPicker, modelPicks, templates } = getUIPrefs();
  const prefMove = (k: string): string | null | undefined => {
    if (!isPrefOf(c, k)) return undefined;
    if (!walk.profile) return null;
    if (k !== prefScope(c, walk.profile.from)) return undefined;
    return walk.profile.to === null ? null : prefScope(c, walk.profile.to);
  };
  const open = moveScopeKeys(lastOpenChat, prefMove);
  const picks = moveScopeKeys(modelPicks, prefMove);
  const pickTo = modelPicker?.profile === undefined ? undefined : prefMove(modelPicker.profile);
  const nextTemplates = templates.flatMap((t) => {
    const to = t.project ? walk.move(t.project.scope) : undefined;
    if (to === undefined) return [t];
    return to === null ? [] : [{ ...t, project: { ...t.project!, scope: to } }];
  });
  const templatesMoved = nextTemplates.length !== templates.length || nextTemplates.some((t, i) => t !== templates[i]);
  if (!open && !picks && pickTo === undefined && !templatesMoved) return;
  setUIPrefs({
    ...(open && { lastOpenChat: open }),
    ...(picks && { modelPicks: picks }),
    ...(pickTo !== undefined && { modelPicker: pickTo === null || !modelPicker ? null : { ...modelPicker, profile: pickTo } }),
    ...(templatesMoved && { templates: nextTemplates }),
  });
}

/** The stores a walk moves besides this webview's storage: the swapped files every window shares, and in-memory copies. */
export type LocalStores = { storage?: Store; defaults?: DefaultsDoc; tags?: TagsFile; persona?: PersonaStore };

/** One walk over every kind of per-profile data, in storage, in memory and in the shared files. */
async function walkAll(c: ScopeSource, walk: Walk, { storage = localStorage as Store, defaults, tags, persona }: LocalStores) {
  const keyMove = (k: string) => movedKey(k, walk);
  await persona?.move(keyMove);
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && keyMove(k) !== undefined) keys.push(k);
  }
  for (const k of keys) {
    const to = keyMove(k)!;
    const value = storage.getItem(k);
    storage.removeItem(k);
    if (to !== null && value !== null) storage.setItem(to, value);
  }
  for (const [k, v] of [...unsaved]) {
    const to = keyMove(k);
    if (to === undefined) continue;
    unsaved.delete(k);
    if (to !== null) unsaved.set(to, v);
  }
  for (const item of [...sending]) {
    const to = keyMove(item.key);
    if (to === undefined) continue;
    if (to === null) {
      item.captured = true;
      sending.delete(item);
    } else item.key = to;
  }
  moveLiveChatData(keyMove);
  for (const key of SCOPED_DOCS) moveDoc(storage, key, walk.move);
  if (walk.profile) moveConnectionValues(storage, walk.parts, walk.profile.from, walk.profile.to);
  else for (const { prefix } of CONNECTION_KEYS) storage.removeItem(prefix + JSON.stringify([...walk.parts]));
  movePrefs(c, walk);
  await defaults?.moveScopes(walk.move);
  if (tags) await moveTagScopes(tags, walk.move);
}

/**
 * Moves everything this computer keeps for profile `from` of connection `c` to profile `to`: drafts, queued and
 * Failed messages, the chat list and Saved copies, branches, persona edits and versions, project membership and
 * defaults, tags and Saved filters, pins, snoozes, inbox dismissals, Outputs, imports, worktree chats, which profile
 * was shown, and the chat to reopen and the model pick. Run only after Hermes renamed it. Another connection's
 * profile of the same name is left alone.
 */
export async function renameProfileLocally(c: ScopeSource, from: string, to: string, stores: LocalStores = {}): Promise<void> {
  if (from === to) return;
  const parts = scopeParts(c);
  await walkAll(c, { move: profileMove(parts, from, to), parts, profile: { from, to } }, stores);
}

/** Forgets everything this computer keeps for profile `profile` of connection `c`, after Hermes deleted it. */
export async function forgetProfileLocally(c: ScopeSource, profile: string, stores: LocalStores = {}): Promise<void> {
  const parts = scopeParts(c);
  await walkAll(c, { move: profileMove(parts, profile, null), parts, profile: { from: profile, to: null } }, stores);
}

/** Forgets every profile's data of connection `c`, and the connection's own (forgetConnection.ts). */
export async function forgetConnectionLocally(c: ScopeSource, stores: LocalStores = {}): Promise<void> {
  const parts = scopeParts(c);
  const storage = stores.storage ?? (localStorage as Store);
  await walkAll(c, { move: connectionMove(parts), parts }, { ...stores, storage });
  dropRename(storage, c);
}

/** A rename Hermes made whose move here may not have finished: the app closed between them. */
export type PendingRename = { from: string; to: string };

function renames(storage: Pick<Storage, "getItem">): Record<string, PendingRename> {
  const doc = (() => {
    try {
      return JSON.parse(storage.getItem(RENAMES_KEY) ?? "null") as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!isObj(doc)) return {};
  return Object.fromEntries(
    Object.entries(doc).filter((e): e is [string, PendingRename] => isObj(e[1]) && typeof e[1].from === "string" && typeof e[1].to === "string"),
  );
}

function dropRename(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, c: ScopeSource) {
  const all = renames(storage);
  const scope = connectionScope(c);
  if (!(scope in all)) return;
  delete all[scope];
  if (Object.keys(all).length) storage.setItem(RENAMES_KEY, JSON.stringify(all));
  else storage.removeItem(RENAMES_KEY);
}

/**
 * Notes, before the rename is sent, that `from` is being renamed to `to` on connection `c`. Cleared once this
 * computer's data has moved, or Hermes refused. A note left behind means the app closed in between
 * (`renamePending`).
 */
export function noteRename(c: ScopeSource, from: string, to: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  try {
    storage.setItem(RENAMES_KEY, JSON.stringify({ ...renames(storage), [connectionScope(c)]: { from, to } }));
  } catch {
    // Without the note, an app closed mid-rename can't offer to move the data afterwards.
  }
}

/** Clears connection `c`'s rename note. */
export function clearRename(c: ScopeSource, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage) {
  try {
    dropRename(storage, c);
  } catch {
    // Left: offered once more on the next list read.
  }
}

/** Connection `c`'s rename note, if a rename's move here may not have finished. */
export function renamePending(c: ScopeSource, storage: Pick<Storage, "getItem"> = localStorage): PendingRename | undefined {
  try {
    return renames(storage)[connectionScope(c)];
  } catch {
    return undefined;
  }
}
