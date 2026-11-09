// What this computer keeps about projects (ADR 0105): which chats are in each project, which project the chat list
// shows, and the projects as Hermes listed them last, so the list can show them before Hermes is read. Hermes keeps
// the projects themselves.
//
// Which chats are in each project (`chats`) means one of two things (ADR 0109). On a Hermes without a membership store
// it is the owner's grouping, kept only here. Once this computer's grouping has been moved to a Hermes that has one
// (`synced`), it is Hermes's links as last read, and the owner's changes not yet confirmed are `pending` operations;
// `recovery` is the grouping as it was here before the move.
//
// All of it lives in one versioned JSON document under one localStorage key, kept apart for each connection and
// profile, the way drafts are. "Clear local cache" doesn't touch it (chatCache.ts clears only chat lists and Saved
// copies): which chats are in a project is the owner's own grouping, not a copy of anything on the server.
import { type ScopeSource, connectionScope } from "./connections";
import { mergeChats, type MembershipOp } from "./membership";
import { toProject, type Project } from "./projects";
import { migrateUIPrefs as migrateDoc, type UIPrefsDoc, type UIPrefsMigrations } from "./uiPrefs";

export const PROJECTS_KEY = "hermes-chat.projects";
/** The shape the document has now. Bump it, and add a step to PROJECTS_MIGRATIONS, when a field changes meaning. */
export const PROJECTS_VERSION = 2;

export const PROJECTS_MIGRATIONS: UIPrefsMigrations = {
  // Version 0 is a document written without `v`; nothing ever wrote one, so it is read as version 1.
  0: (doc) => doc,
  // Version 2 adds `synced`, `pending` and `recovery`; a version 1 scope has none, so its `chats` stay this computer's.
  1: (doc) => doc,
};

const PENDING_LIMIT = 5_000;

/** The most connections and profiles kept, and the most chats kept in one project; a hand-edited document can't grow without end. */
const SCOPE_LIMIT = 200;
const CHATS_PER_PROJECT = 10_000;

/** This computer's grouping as it was before it was moved to Hermes, kept in case the move went wrong. */
export type Recovery = { at: number; chats: Record<string, string[]> };

/**
 * One connection and profile's part of the document. `synced`: when this computer's membership was moved to Hermes, and
 * by which version of the move; from then on `chats` is Hermes's links as last read.
 */
export type ScopeLinks = {
  selected?: string;
  chats: Record<string, string[]>;
  known: Project[];
  synced?: { v: number; at: number };
  /** Hermes's membership revision when `chats` was read. */
  revision?: number;
  /** Links Hermes answered for since `chats` was read, with each one's revision then (membership.ts `linkKey`). */
  acked?: Record<string, number>;
  /** When the owner chose Not now for the move to Hermes: it isn't offered again until they ask. */
  postponed?: number;
  /**
   * Before the move: links to projects Hermes no longer lists, taken out of `chats` but kept for the move's preview and
   * recovery copy (ADR 0109). Never shown in the list.
   */
  setAside?: Record<string, string[]>;
  pending?: MembershipOp[];
  recovery?: Recovery;
};

/** The storage the document is kept in: localStorage in the app. */
export type LinksStorage = Pick<Storage, "getItem" | "setItem">;

/** Where a connection and profile's projects are kept: the same parts as a draft's key (drafts.ts). */
export function projectScope(connection: ScopeSource, profile: string): string {
  return connectionScope(connection, profile);
}

export type ProjectLinks = {
  read(scope: string): Readonly<ScopeLinks>;
  /** `id` undefined: the list shows every chat. */
  select(scope: string, id: string | undefined): void;
  setChat(scope: string, projectId: string, chatId: string, inProject: boolean): void;
  forgetChat(scope: string, chatId: string): void;
  forgetProject(scope: string, projectId: string): void;
  /** Any other change to one scope: the membership sync's own fields (projects.ts). */
  update(scope: string, fn: (s: ScopeLinks) => ScopeLinks): void;
  /** Hermes's projects as just read. Links to a project it no longer has go; archived ones are kept. */
  remember(scope: string, projects: Project[]): void;
};

const isDoc = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, max = 400) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const EMPTY: Readonly<ScopeLinks> = Object.freeze({ chats: Object.freeze({}) as Record<string, string[]>, known: [] });

// The cache holds our normalized Project shape, rather than Hermes's is_primary wire field.
function storedProject(v: unknown): Project | undefined {
  const project = toProject(v);
  if (!project || !isDoc(v)) return project;
  return { ...project, folders: Array.isArray(v.folders) ? v.folders.flatMap((f) =>
    isDoc(f) && typeof f.path === "string" && f.path
      ? [{ path: f.path, primary: f.primary === true }]
      : [],
  ) : [] };
}

function toChats(v: unknown): Record<string, string[]> {
  if (!isDoc(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [project, chats] of Object.entries(v)) {
    if (!id(project) || !Array.isArray(chats)) continue;
    const ids = [...new Set(chats.filter((c): c is string => id(c) !== undefined))].slice(0, CHATS_PER_PROJECT);
    if (ids.length) out[project] = ids;
  }
  return out;
}

function toOp(v: unknown): MembershipOp | undefined {
  if (!isDoc(v)) return undefined;
  const opId = id(v.opId, 200);
  const projectId = id(v.projectId);
  const chatId = id(v.chatId);
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  const base = num(v.base);
  if (!opId || !projectId || !chatId || typeof v.member !== "boolean" || base === undefined) return undefined;
  const c = isDoc(v.conflict) ? v.conflict : undefined;
  const rev = num(c?.rev);
  const conflict = c && typeof c.serverMember === "boolean" && rev !== undefined ? { serverMember: c.serverMember, rev } : undefined;
  return { opId, projectId, chatId, member: v.member, base, at: num(v.at) ?? 0, ...(v.sent === true && { sent: true as const }), ...(conflict && { conflict }) };
}

/** One scope's links as stored; anything that isn't valid is left out. */
export function toScope(v: unknown): ScopeLinks | undefined {
  if (!isDoc(v)) return undefined;
  const known = Array.isArray(v.known) ? v.known.map(storedProject).filter((p): p is Project => !!p) : [];
  const selected = id(v.selected);
  const synced = isDoc(v.synced) && Number.isInteger(v.synced.v) && typeof v.synced.at === "number" ? { v: v.synced.v as number, at: v.synced.at } : undefined;
  const pending = Array.isArray(v.pending) ? v.pending.slice(0, PENDING_LIMIT).map(toOp).filter((o): o is MembershipOp => !!o) : [];
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  const revision = count(v.revision);
  const postponed = count(v.postponed);
  const acked = isDoc(v.acked)
    ? Object.fromEntries(Object.entries(v.acked).flatMap(([k, n]) => (k.length <= 900 && count(n) !== undefined ? [[k, n as number]] : [])).slice(0, PENDING_LIMIT))
    : {};
  const setAside = toChats(v.setAside);
  const recovery = isDoc(v.recovery) && typeof v.recovery.at === "number" ? { at: v.recovery.at, chats: toChats(v.recovery.chats) } : undefined;
  return {
    ...(selected && { selected }),
    chats: toChats(v.chats),
    known,
    ...(synced && { synced }),
    ...(revision !== undefined && { revision }),
    ...(Object.keys(acked).length && { acked }),
    ...(postponed !== undefined && { postponed }),
    ...(Object.keys(setAside).length && { setAside }),
    ...(pending.length && { pending }),
    ...(recovery && { recovery }),
  };
}

/** Every scope a document holds, checked; a document from a newer app is read for the fields this one knows. */
export function readLinks(raw: unknown): Record<string, ScopeLinks> {
  const doc: UIPrefsDoc = migrateDoc(raw, PROJECTS_MIGRATIONS, PROJECTS_VERSION);
  const scopes = isDoc(doc.scopes) ? doc.scopes : {};
  const out: Record<string, ScopeLinks> = {};
  for (const [scope, v] of Object.entries(scopes).slice(0, SCOPE_LIMIT)) {
    const s = id(scope, 2000) && toScope(v);
    if (s) out[scope] = s;
  }
  return out;
}

const isEmpty = (s: ScopeLinks) =>
  !s.selected && !Object.keys(s.chats).length && !s.known.length && !s.synced && !s.pending?.length && !s.recovery && s.postponed === undefined && !Object.keys(s.setAside ?? {}).length;

/** `s` without the empty `pending` list, so a scope with nothing waiting is stored as before. */
const tidy = ({ pending, ...s }: ScopeLinks): ScopeLinks => (pending?.length ? { ...s, pending } : s);

/**
 * The links kept in `storage`. They're read again only when the stored document changes, so a change that couldn't be
 * stored (the storage is full) is held in memory until the app closes or another window writes.
 */
export function projectLinks(storage: LinksStorage): ProjectLinks {
  let cachedRaw: string | null | undefined;
  let doc: UIPrefsDoc = { v: PROJECTS_VERSION };
  let scopes: Record<string, ScopeLinks> = {};

  const current = () => {
    let raw: string | null = null;
    try {
      raw = storage.getItem(PROJECTS_KEY);
    } catch {
      return scopes;
    }
    if (raw === cachedRaw) return scopes;
    cachedRaw = raw;
    let parsed: unknown;
    try {
      parsed = raw === null ? undefined : JSON.parse(raw);
    } catch {
      // Unreadable: start empty.
    }
    doc = migrateDoc(parsed, PROJECTS_MIGRATIONS, PROJECTS_VERSION);
    scopes = readLinks(parsed);
    return scopes;
  };

  const change = (scope: string, fn: (s: ScopeLinks) => ScopeLinks) => {
    const before = current()[scope] ?? EMPTY;
    const after = tidy(fn({ ...before, chats: { ...before.chats } }));
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    scopes = { ...scopes };
    if (isEmpty(after)) delete scopes[scope];
    else scopes[scope] = after;
    // Update this scope's known fields only. Preserve newer fields here and leave other scopes untouched,
    // including scopes this version couldn't parse. Explicitly drop selected when the owner picks All chats.
    const storedScopes = isDoc(doc.scopes) ? { ...doc.scopes } : {};
    const prior = isDoc(storedScopes[scope]) ? storedScopes[scope] : {};
    const { selected: _selected, chats: _chats, known: _known, synced: _synced, revision: _revision, acked: _acked, postponed: _postponed, setAside: _setAside, pending: _pending, recovery: _recovery, ...extra } = prior;
    if (isEmpty(after) && !Object.keys(extra).length) delete storedScopes[scope];
    else storedScopes[scope] = { ...extra, ...after };
    doc = { ...doc, v: Math.max(PROJECTS_VERSION, Number(doc.v) || 0), scopes: storedScopes };
    const raw = JSON.stringify(doc);
    try {
      storage.setItem(PROJECTS_KEY, raw);
      cachedRaw = raw;
    } catch {
      // Not kept: memory holds the change while the stored document is still the one last read.
    }
  };

  const withoutChat = (chats: Record<string, string[]>, chatId: string) =>
    Object.fromEntries(Object.entries(chats).flatMap(([p, ids]) => {
      const left = ids.filter((c) => c !== chatId);
      return left.length ? [[p, left]] : [];
    }));

  return {
    read: (scope) => current()[scope] ?? EMPTY,
    select: (scope, projectId) =>
      change(scope, ({ selected: _, ...s }) => (projectId ? { ...s, selected: projectId } : s)),
    setChat: (scope, projectId, chatId, inProject) =>
      change(scope, (s) => {
        const ids = (s.chats[projectId] ?? []).filter((c) => c !== chatId);
        const next = inProject ? [chatId, ...ids].slice(0, CHATS_PER_PROJECT) : ids;
        const chats = { ...s.chats, [projectId]: next };
        if (!next.length) delete chats[projectId];
        return { ...s, chats };
      }),
    forgetChat: (scope, chatId) =>
      change(scope, (s) => ({
        ...s,
        chats: withoutChat(s.chats, chatId),
        ...(s.setAside && { setAside: withoutChat(s.setAside, chatId) }),
        pending: s.pending?.filter((o) => o.chatId !== chatId),
      })),
    forgetProject: (scope, projectId) =>
      change(scope, ({ selected, ...s }) => {
        const { [projectId]: _, ...chats } = s.chats;
        return {
          ...s,
          ...(selected && selected !== projectId && { selected }),
          chats,
          known: s.known.filter((p) => p.id !== projectId),
          pending: s.pending?.filter((o) => o.projectId !== projectId),
        };
      }),
    update: change,
    // A change waiting for a project Hermes no longer lists goes too: Hermes would refuse it. Before the move to Hermes,
    // the links to such a project are set aside rather than dropped, for the move's preview and recovery copy.
    remember: (scope, projects) =>
      change(scope, ({ selected, ...s }) => {
        const ids = new Set(projects.map((p) => p.id));
        const chats = Object.fromEntries(Object.entries(s.chats).filter(([p]) => ids.has(p)));
        const gone = Object.fromEntries(Object.entries(s.chats).filter(([p]) => !ids.has(p)));
        const setAside = s.synced ? s.setAside : mergeChats(s.setAside ?? {}, gone);
        const pending = s.pending?.filter((o) => ids.has(o.projectId));
        return { ...s, ...(selected && ids.has(selected) && { selected }), chats, known: projects, pending, ...(setAside && Object.keys(setAside).length && { setAside }) };
      }),
  };
}
