// Saved connections (ADR 0112): the Hermes servers this computer can sign in to, each with a name, how it is reached
// (SSH or URL), its non-secret address and username, and when it was last used. Each has a stable id that never
// changes, even when its address is edited. Its password and extra request headers are kept in the system keyring
// under that id (tauriKeyring.ts), and everything this computer keeps for it (drafts, queues, the outbox, Saved
// copies, projects, persona edits, inbox dismissals) is keyed by its scope, which comes from the id.
//
// One connection is in use at a time. `current` is the one launch signs in to; it is only ever set by the owner
// connecting to a connection, never picked by name, and nothing is picked when the current one is removed.
//
// The single sign-in kept before (`hermes-chat.sign-in`) becomes the first connection the first time this is read. It
// keeps the storage scope and keyring entries it already had (`legacy`), so its drafts, queues and saved password
// stay where they are and nothing has to move.
import type { ExtraHeader, SignInDetails } from "./tauriPipe";
import { ROUTES_MAX, ROUTE_KINDS, RouteHealth, isRouteId, routeAddress, routesOf, type RouteKind, type SavedRoute } from "./routes";
import { isObj } from "./values";

export const CONNECTIONS_KEY = "hermes-chat.connections";
/** Where the one sign-in was kept before there were saved connections. Read once, for the migration. */
export const LEGACY_SIGN_IN_KEY = "hermes-chat.sign-in";
export const CONNECTIONS_VERSION = 1;
/** The most connections kept; a document edited by hand can't grow without end. */
export const CONNECTIONS_MAX = 50;
export const NAME_MAX = 60;

/** How a connection reaches the dashboard, and as whom. Nothing here is secret. */
export type Address = { mode: "ssh" | "url"; sshTarget: string; url: string; username: string };

/**
 * How a connection signs in (ADR 0058), which isn't a secret. `method` absent: the password. `provider`: the password
 * provider Hermes listed, absent for `basic`.
 */
export type SignInWay = { method?: "token"; provider?: string };

const PROVIDER = /^[a-z0-9_-]{1,64}$/;

/** `w`'s sign-in way alone, without a field that says nothing: a token, or the password provider if not `basic`. */
export const wayOf = (w: SignInWay): SignInWay =>
  w.method === "token" ? { method: "token" } : w.provider && w.provider !== "basic" && PROVIDER.test(w.provider) ? { provider: w.provider } : {};

export type SavedConnection = Address & SignInWay & {
  /** Stable for the life of the connection: a random UUID. Keyring entries and local storage are keyed by it. */
  id: string;
  name: string;
  addedAt: number;
  /** When the owner last connected with it; undefined until then. */
  lastUsedAt?: number;
  /**
   * Only on the connection migrated from the single saved sign-in. `scope`: the storage scope its data was already
   * kept under (mode, target and username at the time). `address`: the address its old plain keyring password was
   * saved for, so that password is never sent once the address has been edited.
   */
  legacy?: { scope: string[]; address: string };
  /**
   * The ways to reach the server, tried in order (routes.ts, ADR 0120). Absent on a connection that has only ever had
   * one, whose route is its address. When present, the address above is the first route's.
   */
  routes?: SavedRoute[];
  /**
   * The server's id once a route has reported one: a hash of its Hermes install id. Every route must reach it. Kept
   * only on a connection with several routes; one with a single route connects as it always did.
   */
  server?: string;
  /** When each route last failed, by route id: nothing secret. Only on a connection with routes (`RouteHealth`). */
  routeFailedAt?: Record<string, number>;
};

type Doc = { connections: SavedConnection[]; current?: string };

export type Storage_ = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const ID = /^[a-z0-9-]{8,64}$/;
export const isConnectionId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

const str = (v: unknown, max = 2000) => (typeof v === "string" && v.length <= max ? v : undefined);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The address a secret belongs to: the mode, the target or URL as typed (trimmed), and the username. */
export function addressKey(a: Address): string {
  return JSON.stringify([a.mode, (a.mode === "ssh" ? a.sshTarget : a.url).trim(), a.username.trim()]);
}

/** The address shown beside a connection's name: its SSH target, or its URL (its first route's, with several). */
export const addressLabel = (a: Address) => (a.mode === "ssh" ? `ssh://${a.sshTarget.trim()}` : a.url.trim());

/** A connection's routes in a few words: "LAN, Tailscale and SSH". */
export function routesSummary(c: Address & { routes?: SavedRoute[] }): string {
  const names = routesOf(c).map((r) => ({ lan: "LAN", tailscale: "Tailscale", web: "web address", ssh: "SSH" })[r.kind] + (r.off ? " (off)" : ""));
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const SERVER_ID = /^[0-9a-f]{32}$/;

function toRoutes(v: unknown): SavedRoute[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const routes = v
    .map((r): SavedRoute | undefined => {
      if (!isObj(r) || !isRouteId(r.id) || seen.has(r.id) || !ROUTE_KINDS.includes(r.kind as RouteKind)) return undefined;
      const target = str(r.target);
      if (target === undefined) return undefined;
      seen.add(r.id);
      return { id: r.id, kind: r.kind as RouteKind, target, ...(r.off === true && { off: true }) };
    })
    .filter((r): r is SavedRoute => !!r)
    .slice(0, ROUTES_MAX);
  return routes.length ? routes : undefined;
}

/** The failure times kept for `routes`: one per route it still has, a time and nothing else. */
function toFailedAt(v: unknown, routes: SavedRoute[] | undefined): Record<string, number> | undefined {
  if (!isObj(v) || !routes) return undefined;
  const kept = Object.entries(v).filter((e): e is [string, number] => routes.some((r) => r.id === e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] >= 0);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** `c` with its address made its first route's, when it has a list of routes. */
export function withFirstRoute(c: SavedConnection): SavedConnection {
  const first = c.routes?.[0];
  if (!first) return c;
  const { sshTarget, url, mode } = routeAddress(first, c.username);
  return { ...c, mode, sshTarget, url };
}

/** A name for a connection the owner didn't name: the SSH host, or the URL's host. */
export function defaultName(a: Address): string {
  if (a.mode === "ssh") return a.sshTarget.trim().split("@").pop() || "Hermes server";
  try {
    return new URL(a.url.trim()).host || a.url.trim() || "Hermes server";
  } catch {
    return a.url.trim() || "Hermes server";
  }
}

export const cleanName = (name: string, a: Address) => name.trim().slice(0, NAME_MAX) || defaultName(a);

/** Where a connection's local data is kept. A connection without an id (a bare sign-in, in tests) is keyed by its address. */
export type ScopeSource = Address & { id?: string; legacy?: { scope: string[] } };

/** The parts every per-connection storage key starts with. */
export function scopeParts(c: ScopeSource): string[] {
  if (c.legacy) return c.legacy.scope;
  if (c.id) return ["connection", c.id];
  return [c.mode, c.mode === "ssh" ? c.sshTarget : c.url, c.username];
}

/** A per-connection key's JSON scope: the connection's parts, then `rest` (profile, chat). */
export const connectionScope = (c: ScopeSource, ...rest: string[]) => JSON.stringify([...scopeParts(c), ...rest]);

/** Whether `scope`, a JSON array as `connectionScope` makes, belongs to the connection with these parts. */
export function inScope(parts: string[], scope: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(scope);
  } catch {
    return false;
  }
  return Array.isArray(v) && v.length >= parts.length && parts.every((p, i) => v[i] === p);
}

/**
 * The key a display preference that is kept per profile (the chat to reopen, the model pick) uses for a profile of
 * this connection. The migrated connection keeps the bare profile name it used before.
 */
export const prefScope = (c: ScopeSource, profile: string) => (c.legacy || !c.id ? profile : `${c.id}\n${profile}`);

/** Whether a `prefScope` key is this connection's. */
export const isPrefOf = (c: ScopeSource, key: string) => (c.legacy || !c.id ? !key.includes("\n") : key.startsWith(`${c.id}\n`));

function toConnection(v: unknown): SavedConnection | undefined {
  if (!isObj(v) || !isConnectionId(v.id)) return undefined;
  const mode = v.mode === "url" ? "url" : v.mode === "ssh" ? "ssh" : undefined;
  const name = str(v.name, NAME_MAX);
  if (!mode || name === undefined) return undefined;
  const a: Address = { mode, sshTarget: str(v.sshTarget) ?? "", url: str(v.url) ?? "", username: str(v.username, 400) ?? "" };
  const lastUsedAt = time(v.lastUsedAt);
  const legacy = isObj(v.legacy) && Array.isArray(v.legacy.scope) && v.legacy.scope.every((p) => typeof p === "string") && typeof v.legacy.address === "string"
    ? { scope: v.legacy.scope as string[], address: v.legacy.address }
    : undefined;
  const routes = toRoutes(v.routes);
  const server = typeof v.server === "string" && SERVER_ID.test(v.server) ? v.server : undefined;
  const routeFailedAt = toFailedAt(v.routeFailedAt, routes);
  return withFirstRoute({
    id: v.id,
    name: name.trim() || defaultName(a),
    ...a,
    addedAt: time(v.addedAt) ?? 0,
    ...(lastUsedAt !== undefined && { lastUsedAt }),
    ...(legacy && { legacy }),
    ...(routes && { routes }),
    ...(server && { server }),
    ...(routeFailedAt && { routeFailedAt }),
    ...wayOf({ method: v.method === "token" ? "token" : undefined, provider: str(v.provider, 64) }),
  });
}

/** The single sign-in kept before, if one is set up there (setup.ts `isSetUp`). */
function readLegacy(storage: Storage_): Address | undefined {
  let v: unknown;
  try {
    v = JSON.parse(storage.getItem(LEGACY_SIGN_IN_KEY) ?? "null");
  } catch {
    return undefined;
  }
  if (!isObj(v)) return undefined;
  const a: Address = { mode: v.mode === "url" ? "url" : "ssh", sshTarget: str(v.sshTarget) ?? "", url: str(v.url) ?? "", username: str(v.username, 400) ?? "" };
  return a.sshTarget.trim() || a.url.trim() || a.username.trim() ? a : undefined;
}

export const newConnectionId = () => globalThis.crypto.randomUUID();

/** The details a connection signs in with, apart from its secrets. */
export const addressOf = (d: Address): Address => ({ mode: d.mode, sshTarget: d.sshTarget, url: d.url, username: d.username });

/** The sign-in details for a connection, with the password and headers given, and the way it signs in. */
export const detailsOf = (c: Address & SignInWay, password = "", headers: ExtraHeader[] = []): SignInDetails => ({ ...addressOf(c), ...wayOf(c), password, headers });

/**
 * The saved connections, in one versioned document in local storage. Reads go through memory, so a store that can't
 * be written still holds the change until the app closes; another window's change is picked up by its storage event.
 */
export class Connections {
  private doc: Doc;
  private raw: string | null | undefined;
  private listeners = new Set<() => void>();
  /** Set once a write was refused, so the owner can be told the change lasts only until the app closes. */
  unsaved = false;

  constructor(
    private storage: Storage_,
    private now: () => number = Date.now,
    private makeId: () => string = newConnectionId,
  ) {
    this.doc = this.load();
  }

  /** Reads the document, migrating the old single sign-in into it the first time. */
  private load(): Doc {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(CONNECTIONS_KEY);
    } catch {
      // Unreadable: nothing saved.
    }
    this.raw = raw;
    if (raw !== null) {
      let v: unknown;
      try {
        v = JSON.parse(raw);
      } catch {
        v = undefined;
      }
      if (isObj(v) && Array.isArray(v.connections)) {
        const seen = new Set<string>();
        const connections = v.connections.map(toConnection).filter((c): c is SavedConnection => !!c && !seen.has(c.id) && !!seen.add(c.id)).slice(0, CONNECTIONS_MAX);
        const current = isConnectionId(v.current) && connections.some((c) => c.id === v.current) ? v.current : undefined;
        return { connections, ...(current && { current }) };
      }
    }
    // Nothing saved yet, or a document that can't be read: start from the single sign-in kept before, if any.
    const legacy = readLegacy(this.storage);
    if (!legacy) return { connections: [] };
    const c: SavedConnection = {
      id: this.makeId(),
      name: defaultName(legacy),
      ...legacy,
      addedAt: this.now(),
      legacy: { scope: [legacy.mode, legacy.mode === "ssh" ? legacy.sshTarget : legacy.url, legacy.username], address: addressKey(legacy) },
    };
    const doc = { connections: [c], current: c.id };
    this.write(doc);
    return doc;
  }

  private write(doc: Doc) {
    this.doc = doc;
    const raw = JSON.stringify({ v: CONNECTIONS_VERSION, ...doc });
    try {
      this.storage.setItem(CONNECTIONS_KEY, raw);
      this.raw = raw;
      this.unsaved = false;
    } catch {
      this.unsaved = true;
    }
    this.listeners.forEach((fn) => fn());
  }

  /** Another window changed the document: read it again. */
  reread = () => {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(CONNECTIONS_KEY);
    } catch {
      return;
    }
    if (raw === this.raw) return;
    this.doc = this.load();
    this.listeners.forEach((fn) => fn());
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.doc;

  /** Every connection, the most recently used first; ones never used, newest added first. */
  recent(): SavedConnection[] {
    return [...this.doc.connections].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) || b.addedAt - a.addedAt);
  }

  get(id: string | undefined): SavedConnection | undefined {
    return id === undefined ? undefined : this.doc.connections.find((c) => c.id === id);
  }

  /** The connection launch signs in to, if the owner has connected to one and not removed it since. */
  current(): SavedConnection | undefined {
    return this.get(this.doc.current);
  }

  /** A new connection, not saved until `save`: it gets its id now, so a sign-in can be keyed by it before it is kept. */
  draft(a: Address, name = ""): SavedConnection {
    return { id: this.makeId(), name: cleanName(name, a), ...addressOf(a), addedAt: this.now() };
  }

  /** Adds `c`, or replaces the saved connection with its id. With routes, its address is made its first route's. */
  save(saving: SavedConnection) {
    const c = withFirstRoute(saving);
    const at = this.doc.connections.findIndex((x) => x.id === c.id);
    if (at < 0 && this.doc.connections.length >= CONNECTIONS_MAX) throw new Error(`Hermes Chat keeps at most ${CONNECTIONS_MAX} connections. Remove one first.`);
    const connections = [...this.doc.connections];
    if (at < 0) connections.push(c);
    else connections[at] = c;
    this.write({ ...this.doc, connections });
  }

  /** Keeps the server id a route reported for `id`, the first time one does (ADR 0120). */
  setServer(id: string, server: string) {
    const c = this.get(id);
    if (c && !c.server && SERVER_ID.test(server)) this.save({ ...c, server });
  }

  /** Keeps when each of `id`'s routes last failed (`RouteHealth`, #269). Only a connection with routes keeps any. */
  setRouteFailedAt(id: string, failedAt: Record<string, number>) {
    const c = this.get(id);
    if (!c?.routes) return;
    const { routeFailedAt: before, ...rest } = c;
    const kept = toFailedAt(failedAt, c.routes);
    if (JSON.stringify(kept) !== JSON.stringify(before)) this.save({ ...rest, ...(kept && { routeFailedAt: kept }) });
  }

  rename(id: string, name: string) {
    const c = this.get(id);
    if (c) this.save({ ...c, name: cleanName(name, c) });
  }

  /** The owner connected with `id`: it is the one launch signs in to, and the most recently used. */
  use(id: string) {
    const c = this.get(id);
    if (!c) return;
    const connections = this.doc.connections.map((x) => (x.id === id ? { ...x, lastUsedAt: this.now() } : x));
    this.write({ connections, current: id });
  }

  /** Forgets `id`. If it was the one in use, none is: nothing else is picked in its place. */
  remove(id: string) {
    const connections = this.doc.connections.filter((c) => c.id !== id);
    const removed = this.get(id);
    this.write({ connections, ...(this.doc.current !== id && this.doc.current && { current: this.doc.current }) });
    // The single sign-in it came from is never read again; leaving it would only keep the old address around.
    if (removed?.legacy) {
      try {
        this.storage.removeItem(LEGACY_SIGN_IN_KEY);
      } catch {
        // Harmless: the document exists now, so it is never migrated again.
      }
    }
  }
}

/** How `id`'s routes did lately, kept with the connection, so a route that failed is tried last after a restart too. */
export function keptRouteHealth(connections: Connections, id: string, now: () => number = Date.now): RouteHealth {
  return new RouteHealth(now, undefined, { failedAt: connections.get(id)?.routeFailedAt, save: (failedAt) => connections.setRouteFailedAt(id, failedAt) });
}
