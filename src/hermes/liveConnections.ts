// The live connections (ADR 0125): one `Hermes` per saved connection that is open, each with its own socket, sign-in,
// keyring entries, cache and reconnect loop, and a pointer to the one that is the composer target. The others are
// background connections: they keep their sockets and the chats they hold, and are read now and then for what runs
// and waits there. Nothing outside an instance names a chat by its id alone: a `ChatRef` names its connection too, as
// two servers can have the same profile and chat ids.
import type { SavedConnection } from "./connections";
import { blocksRestore, inboxEntries, needsOwner, type InboxAcks, type InboxEntry } from "./inbox";
import type { Handoff } from "./dispatched";
import { isWaiting, type Chat, type ConnectionStatus } from "./model";
import type { Route } from "./pipe";
import type { SignInDetails } from "./tauriPipe";
import type { Hermes } from "./transport";

/** A chat on a live connection. */
export type ChatRef = { connection: string; profile: string; chatId: string };

/** One live connection: the saved connection, its instance, and the sign-in it opened with (kept to reconnect). */
export type Member = { connection: SavedConnection; hermes: Hermes; details: SignInDetails };

/** What the overview shows for a connection. `needs-sign-in`: it was live, and has no saved password to open with. */
export type LiveStatus = ConnectionStatus | "needs-sign-in";

/** A live connection as the overview, the rail and the tray see it. */
export type LiveSummary = {
  id: string;
  name: string;
  target: boolean;
  status: LiveStatus;
  route?: Route;
  /** The newest `last_active` Hermes reports, or the last frame on the socket, Unix ms; none before either. */
  lastActivity?: number;
  waiting: number;
  running: number;
  failed: number;
  unread: number;
  /** Hermes has no `session.active_list`, so running work in other profiles can't be seen. */
  blind?: boolean;
  /** A reply runs or an Approval waits, dismissed or not: a restore waits for it (inbox.ts `blocksRestore`). */
  busy: boolean;
  /** What is under way, dismissed or not, for the question before Disconnect closes it. */
  underWay: { waiting: number; running: number };
  /** Why it needs signing in, for one that does. */
  why?: string;
  /** A background connection's inbox entries not dismissed, each carrying its server. The target's are Main's. */
  entries: InboxEntry[];
};

/** How often a background connection reads what runs and waits, and the other profiles' Unread chats (ADR 0125). */
export const BACKGROUND_LIVE_MS = 60_000;
export const BACKGROUND_UNREAD_MS = 120_000;
/** At most this many background reads run at once, across every background connection. */
export const BACKGROUND_READS_AT_ONCE = 4;

/** An inbox entry from a background connection: its key and alias carry the connection, so colliding ids stay apart. */
export function withServer(e: InboxEntry, server: { id: string; name: string }): InboxEntry {
  return { ...e, key: `${server.id}\n${e.key}`, ...(e.alias && { alias: `${server.id}\n${e.alias}` }), server };
}

/** The entry as its own connection keys it, to dismiss it there. */
export function withoutServer(e: InboxEntry): InboxEntry {
  if (!e.server) return e;
  const strip = (k: string) => k.slice(e.server!.id.length + 1);
  const { server: _, ...rest } = e;
  return { ...rest, key: strip(e.key), ...(e.alias && { alias: strip(e.alias) }) };
}

/** Reads run `max` at a time; the rest wait their turn. */
function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (read: () => Promise<unknown>) => {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      await read();
    } catch {
      // A read that fails says so in the snapshot it was for.
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/**
 * The live connections and the composer target. Adding or removing one never opens or closes it: the caller does,
 * one connection's changes at a time. Each background connection is read on its own timers, offset from the others'.
 * `keep` is told the live ids, the target first, whenever they change, so launch can open them again.
 */
export class LiveConnections {
  private members = new Map<string, Member>();
  private needing = new Map<string, { connection: SavedConnection; why: string }>();
  private targetId?: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private unsubscribe = new Map<string, () => void>();
  private summaries = new Map<string, LiveSummary>();
  /** When each connection's handoffs next change with time alone. */
  private rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private read = limiter(BACKGROUND_READS_AT_ONCE);

  constructor(
    private keep: (ids: string[]) => void = () => {},
    /** Each connection's inbox dismissals, so a background connection's summary counts what the owner hasn't dismissed. */
    private acksOf: (c: SavedConnection) => InboxAcks | undefined = () => undefined,
    /**
     * A connection's dispatched work in a profile (dispatched.ts `handoffs`), with its own Stop waiting choices, and when
     * it next changes with time alone (`nextHandoffChange`), so the summary is worked out again then.
     */
    private handoffsOf?: (c: SavedConnection, profile: string, chats: Chat[]) => { handoffs: ReadonlyMap<string, Handoff>; next?: number },
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.version;

  private changed() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  get(id: string | undefined): Member | undefined {
    return id === undefined ? undefined : this.members.get(id);
  }

  has(id: string): boolean {
    return this.members.has(id);
  }

  /** The live connections, the target first, then in the order they opened. */
  list(): Member[] {
    const t = this.target();
    return [...(t ? [t] : []), ...[...this.members.values()].filter((m) => m !== t)];
  }

  get size(): number {
    return this.members.size;
  }

  target(): Member | undefined {
    return this.get(this.targetId);
  }

  /** The connection a chat is on, if it is live. */
  resolve(ref: ChatRef): Member | undefined {
    return this.get(ref.connection);
  }

  /** Adds an opened connection, as the target or in the background. One already live under the same id is replaced. */
  add(m: Member, asTarget: boolean) {
    this.stopWatching(m.connection.id);
    // Made the target again, or opened anew: the listeners on what was held before go first.
    this.unsubscribe.get(m.connection.id)?.();
    this.members.set(m.connection.id, m);
    this.needing.delete(m.connection.id);
    const unheard = m.hermes.subscribe(() => this.summarize(m.connection.id));
    const undismissed = this.acksOf(m.connection)?.subscribe(() => this.summarize(m.connection.id));
    this.unsubscribe.set(m.connection.id, () => (unheard(), undismissed?.()));
    if (asTarget) this.setTarget(m.connection.id);
    else {
      m.hermes.setRole("background");
      this.watch(m.connection.id);
      this.summarize(m.connection.id, true);
      this.kept();
    }
  }

  /** Takes a connection out, without closing it: the caller closes what it returns. */
  remove(id: string): Member | undefined {
    const m = this.members.get(id);
    this.needing.delete(id);
    if (!m) return this.kept(), undefined;
    this.stopWatching(id);
    this.unsubscribe.get(id)?.();
    this.unsubscribe.delete(id);
    this.members.delete(id);
    this.summaries.delete(id);
    clearTimeout(this.rechecks.get(id));
    this.rechecks.delete(id);
    if (this.targetId === id) this.targetId = undefined;
    this.kept();
    return m;
  }

  /** Makes `id` the composer target and every other live connection a background one. Nothing closes or reconnects. */
  setTarget(id: string | undefined) {
    this.targetId = id !== undefined && this.members.has(id) ? id : undefined;
    for (const [mid, m] of this.members) {
      const target = mid === this.targetId;
      const was = m.hermes.roleNow;
      m.hermes.setRole(target ? "target" : "background");
      if (target) this.stopWatching(mid);
      else if (!this.timers.has(mid)) this.watch(mid);
      // The main screen kept this connection's dismissals while it was the target: read what it wrote.
      if (!target && was === "target") this.acksOf(m.connection)?.reload();
      this.summarize(mid, true);
    }
    this.kept();
  }

  /** A connection that was live and has no saved password to open with: listed, never opened by itself. */
  needsSignIn(connection: SavedConnection, why: string) {
    if (this.members.has(connection.id)) return;
    this.needing.set(connection.id, { connection, why });
    this.kept();
  }

  /** Every live connection's summary, the target first, then those that need signing in. */
  overview(): LiveSummary[] {
    const open = this.list().flatMap((m) => this.summaries.get(m.connection.id) ?? []);
    const needing = [...this.needing.values()].map(
      ({ connection, why }): LiveSummary => ({ id: connection.id, name: connection.name, target: false, status: "needs-sign-in", why, waiting: 0, running: 0, failed: 0, unread: 0, busy: false, underWay: { waiting: 0, running: 0 }, entries: [] }),
    );
    return [...open, ...needing];
  }

  /** Stops every background timer. Closing the instances is the caller's. */
  stop() {
    for (const id of [...this.timers.keys()]) this.stopWatching(id);
    for (const t of this.rechecks.values()) clearTimeout(t);
    this.rechecks.clear();
  }

  private kept() {
    this.keep([...this.list().map((m) => m.connection.id), ...this.needing.keys()]);
    this.changed();
  }

  /** Works out `id`'s summary from its snapshot, and tells listeners only when it changed. */
  private summarize(id: string, force = false) {
    const m = this.members.get(id);
    if (!m) return;
    const snap = m.hermes.getSnapshot();
    const work = this.handoffsOf?.(m.connection, snap.profile, snap.chats);
    clearTimeout(this.rechecks.get(id));
    this.rechecks.delete(id);
    if (work?.next !== undefined) this.rechecks.set(id, setTimeout(() => this.summarize(id), Math.max(0, work.next - Date.now())));
    const next = summarize(m, this.targetId === id, this.acksOf(m.connection), work?.handoffs);
    const was = this.summaries.get(id);
    this.summaries.set(id, next);
    if (force || !was || !sameSummary(was, next)) this.changed();
  }

  /**
   * Reads what runs and waits on a background connection every `BACKGROUND_LIVE_MS`, and its other profiles every
   * `BACKGROUND_UNREAD_MS`, starting at an offset so connections don't all read at once. A read on a connection
   * that isn't connected does nothing (transport.ts `checkLive`).
   */
  private watch(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    const index = [...this.members.keys()].indexOf(id);
    const offset = (index * BACKGROUND_LIVE_MS) / (BACKGROUND_READS_AT_ONCE * 2);
    const timers: ReturnType<typeof setTimeout>[] = [];
    this.timers.set(id, timers);
    // A read waiting its turn checks again when it starts: the connection may be the target or closed by then.
    const watched = () => this.timers.get(id) === timers;
    const every = (ms: number, read: () => Promise<unknown>) => {
      const queued = () => void this.read(() => (watched() ? read() : Promise.resolve()));
      timers.push(
        setTimeout(() => {
          if (!watched()) return;
          queued();
          timers.push(setInterval(queued, ms));
        }, offset % ms),
      );
    };
    every(BACKGROUND_LIVE_MS, () => m.hermes.checkLive());
    every(BACKGROUND_UNREAD_MS, () => m.hermes.checkOtherProfiles());
  }

  private stopWatching(id: string) {
    for (const t of this.timers.get(id) ?? []) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.delete(id);
  }
}

/** A live connection's summary: its status and route, its counts, and, in the background, its inbox entries. */
export function summarize(m: Member, target: boolean, acks?: InboxAcks, handoffs?: ReadonlyMap<string, Handoff>): LiveSummary {
  const snap = m.hermes.getSnapshot();
  const { entries } = inboxEntries({ profile: snap.profile, chats: snap.chats, connected: snap.status === "connected", others: snap.others, live: snap.live, handoffs });
  const shown = acks ? entries.filter((e) => !acks.isDismissed(e)) : entries;
  const server = { id: m.connection.id, name: m.connection.name };
  const reported = Math.max(0, ...(snap.live?.sessions ?? []).map((s) => s.at));
  // Kept to 10 seconds, so a reply streaming in the background doesn't change the summary with every frame.
  const lastActivity = Math.floor(Math.max(reported, m.hermes.lastFrameAt) / 10_000) * 10_000 || undefined;
  // A chat whose reply waits on an Approval counts as waiting, not running, as the inbox lists it.
  const waitingChats = new Set(snap.chats.filter((c) => c.items.some(isWaiting)).map((c) => c.id));
  return {
    id: m.connection.id,
    name: m.connection.name,
    target,
    status: snap.status,
    ...(snap.route && { route: snap.route }),
    ...(lastActivity && { lastActivity }),
    waiting: shown.filter((e) => e.kind === "approval" && !e.ended).length,
    running: shown.filter((e) => e.kind === "running" && !waitingChats.has(e.chatId)).length,
    failed: shown.filter((e) => e.kind === "failed" || e.kind === "uncertain").length,
    unread: shown.filter((e) => e.kind === "completed").length,
    ...(snap.live?.unsupported && { blind: true }),
    busy: entries.some(blocksRestore),
    underWay: { waiting: entries.filter((e) => e.kind === "approval" && !e.ended).length, running: entries.filter((e) => e.kind === "running" && !waitingChats.has(e.chatId)).length },
    entries: target ? [] : shown.map((e) => withServer(e, server)),
  };
}

/** How many of a summary's entries ask something of the owner: what the rail and the tray count. */
export const attention = (s: LiveSummary) => s.entries.filter(needsOwner).length;

function sameSummary(a: LiveSummary, b: LiveSummary): boolean {
  const { entries: ea, ...ra } = a;
  const { entries: eb, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb) && ea.length === eb.length && ea.every((e, i) => e.key === eb[i].key && e.ended === eb[i].ended && e.summary === eb[i].summary);
}
