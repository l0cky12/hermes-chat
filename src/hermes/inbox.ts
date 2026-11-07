// The inbox: what needs the owner's attention, or finished, across the server's profiles, in one list. Everything here
// is worked out from what the app already reads; the inbox fetches nothing of its own and never answers, retries or
// resends anything. Each entry has a key that stays the same however often a reconnect or a check reports it again,
// so it shows once. Dismissing an entry is kept on this computer, per connection, and touches nothing else: not
// Unread, Active or Settled, nor Archived.
import { type ScopeSource, connectionScope } from "./connections";
import type { Handoff } from "./dispatched";
import type { Chat, Item, LiveSessions, OtherProfiles, Source } from "./model";
import { isOutgoing, isWaiting } from "./model";

/**
 * `running`: a reply is being written, or the chat waits on work it handed off (`waiting`). `approval`: Hermes waits
 * for the owner's answer, or did until it stopped waiting (`ended`), or a task the chat dispatched needs the owner.
 * `failed`: a reply failed, or a message didn't go. `uncertain`: a message Hermes may not have. `completed`: a chat
 * with something new in it the owner hasn't read.
 */
export type InboxKind = "running" | "approval" | "failed" | "uncertain" | "completed";

export type InboxEntry = {
  key: string;
  kind: InboxKind;
  profile: string;
  chatId: string;
  title: string;
  /** When it happened, Unix ms; 0 when that isn't known. A dismissed entry shows again only once this is later. */
  at: number;
  /** For an entry whose `at` isn't known: when this app first noticed it, in this run. */
  noticedAt?: number;
  /** What happened, in words that never quote a message, a command or an error from Hermes. */
  summary: string;
  /** The Approval card or message to show once the chat is open, when known. */
  itemId?: string;
  /** An Approval Hermes stopped waiting on: there is nothing left to answer. */
  ended?: boolean;
  /** Running work that is a wait on work the chat handed off (dispatched.ts), not a reply being written. */
  waiting?: boolean;
  /** The id of the dispatched task that needs the owner, for an entry about one. */
  taskId?: string;
  /** From a check that failed, or while not connected: as last seen. */
  stale?: boolean;
  /**
   * The key the same Approval goes by once its chat is no longer on this connection, and only a check says it is
   * waiting. Dismissing the entry dismisses that too, up to now.
   */
  alias?: string;
  /**
   * For an Approval card: the last activity Hermes reports for its chat's live session, if it lists one. A dismissed
   * `alias` covers the card too while this is no later than when it was dismissed: the owner dismissed the waiting
   * session before resuming the chat showed what it waits on.
   */
  aliasAt?: number;
  /** Where the chat was started, for a chat the profile's list may not hold, such as one older than a month. */
  source?: Source;
};

/** What the inbox is worked out from: the shown profile's chats, and the latest checks of the server. */
export type InboxSources = {
  profile: string;
  chats: Chat[];
  connected: boolean;
  others: OtherProfiles;
  live?: LiveSessions;
  /** When each entry was first noticed, by key, kept by the caller for as long as the app runs. */
  seen?: Map<string, number>;
  /** Each chat's dispatched work (dispatched.ts `handoffs`). */
  handoffs?: ReadonlyMap<string, Handoff>;
};

/** What a filter shows, in the order the inbox lists the kinds. */
export const INBOX_FILTERS = {
  all: ["approval", "failed", "uncertain", "completed", "running"],
  running: ["running"],
  approval: ["approval"],
  failed: ["failed", "uncertain"],
  completed: ["completed"],
} as const satisfies Record<string, readonly InboxKind[]>;
export type InboxFilter = keyof typeof INBOX_FILTERS;

/** An error item a chat shows for a chat that couldn't be loaded: not work that failed (transport.ts `LOAD_ERROR_ID`). */
const LOAD_ERROR_ID = "load-error";

export const isFailure = (i: Item): boolean => (i.kind === "error" && i.id !== LOAD_ERROR_ID) || (isOutgoing(i) && i.outgoing.state !== "sending");

/**
 * The inbox's entries, newest first within each kind, and how many live sessions couldn't be put with one chat: ones
 * outside the chats the checks read, or whose id more than one profile has.
 */
export function inboxEntries({ profile, chats, connected, others, live, seen, handoffs }: InboxSources): { entries: InboxEntry[]; unmatched: number } {
  const entries = new Map<string, InboxEntry>();
  const add = (e: InboxEntry) => entries.has(e.key) || entries.set(e.key, e);

  const liveAt = new Map(live?.sessions.filter((s) => s.profile === profile).map((s) => [s.chatId, s.at]));

  // The shown profile, as this connection sees it.
  for (const c of chats) {
    const base = { profile, chatId: c.id, title: c.title, stale: !connected };
    const handoff = handoffs?.get(c.id);
    // A reply held up by an Approval is listed as waiting, as a live session in another profile is.
    if (c.running && !c.items.some(isWaiting)) add({ ...base, key: `running ${profile} ${c.id}`, kind: "running", at: c.updatedAt, summary: "Hermes is working on a reply.", stale: false });
    else if (handoff?.kind === "waiting") add({ ...base, key: `running ${profile} ${c.id}`, kind: "running", at: c.updatedAt, summary: "Hermes is waiting on work it handed off.", waiting: true });
    if (handoff?.kind === "needsOwner") add({ ...base, key: `handoff ${profile} ${c.id} ${handoff.task.id} ${handoff.task.status}`, kind: "approval", at: 0, taskId: handoff.task.id, summary: handoff.reason });
    for (const i of c.items) {
      if (i.kind === "approval" && !i.answer && (i.ended || isWaiting(i))) {
        const ended = !isWaiting(i);
        add({
          ...base,
          key: `approval ${profile} ${c.id} ${i.requestId}`,
          kind: "approval",
          at: 0,
          itemId: i.id,
          ended,
          alias: `waiting ${profile} ${c.id}`,
          aliasAt: liveAt.get(c.id),
          summary: ended ? "Hermes stopped waiting for an answer. Nothing is left to approve." : "A command is waiting for your approval.",
        });
      } else if (i.kind === "error" && i.id !== LOAD_ERROR_ID) {
        add(failureEntry({ ...base, itemId: i.id, mark: failureMark(i.text) }));
      } else if (isOutgoing(i) && i.outgoing.state !== "sending") {
        add(sendEntry({ ...base, itemId: i.id, state: i.outgoing.state, at: i.at ?? 0 }));
      }
    }
    if (c.unread && !c.archived && handoff?.kind !== "waiting")
      add({ ...base, key: `completed ${profile} ${c.id}`, kind: "completed", at: c.updatedAt, summary: "Something new since you last read it." });
  }

  // The other profiles, as their latest check read them.
  for (const [name, p] of Object.entries(others.byName)) {
    // A check that couldn't list the profiles keeps each one's chats from the check before.
    const stale = !!p.error || !!others.error || !connected;
    for (const c of p.chats ?? [])
      if (c.unread)
        add({ key: `completed ${name} ${c.id}`, kind: "completed", profile: name, chatId: c.id, title: c.title, source: c.source, at: c.at, stale, summary: "Something new since you last read it." });
    for (const f of p.failures ?? []) add(failureEntry({ ...f, profile: name, stale }));
    for (const s of p.sends ?? []) {
      const title = p.chats?.find((c) => c.id === s.chatId)?.title ?? s.title ?? "Untitled chat";
      add(sendEntry({ profile: name, chatId: s.chatId, title, itemId: s.itemId, state: s.state, at: 0, stale: false }));
    }
  }

  // Sessions working or waiting in the dashboard's process, in any profile. Rows don't say their profile: the
  // transport knows it for sessions this app started or resumed, and looks the others up by id in every profile (a
  // copied profile can repeat ids). One whose profile isn't known isn't listed, and is counted.
  let unmatched = 0;
  if (live) {
    const stale = !!live.error || !connected;
    for (const s of live.sessions) {
      if (!s.profile) {
        unmatched++;
        continue;
      }
      // The shown profile's own chats say more surely whether they run or wait, once resumed or holding a waiting card.
      // While the connection is down, a check is older than what they last showed.
      const here = s.profile === profile ? chats.find((c) => c.id === s.chatId) : undefined;
      if (here && (!connected || here.runtimeId || here.items.some(isWaiting))) continue;
      const listed = s.profile === profile ? here : others.byName[s.profile]?.chats?.find((c) => c.id === s.chatId);
      const owner = { profile: s.profile, title: listed?.title ?? s.title ?? "Untitled chat", source: listed?.source ?? s.source };
      const base = { profile: owner.profile, chatId: s.chatId, title: owner.title, source: owner.source, at: s.at, stale };
      if (s.status === "working") add({ ...base, key: `running ${owner.profile} ${s.chatId}`, kind: "running", summary: "Hermes is working on a reply." });
      else add({ ...base, key: `waiting ${owner.profile} ${s.chatId}`, kind: "approval", summary: "Hermes is waiting for your answer. Open the chat to see what it asks." });
    }
  }

  const order: readonly InboxKind[] = INBOX_FILTERS.all;
  if (seen) {
    const now = Date.now();
    for (const e of entries.values()) {
      if (!seen.has(e.key)) seen.set(e.key, now);
      if (!e.at) e.noticedAt = seen.get(e.key);
    }
  }
  const list = [...entries.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (b.at || b.noticedAt || 0) - (a.at || a.noticedAt || 0));
  return { entries: list, unmatched };
}

function failureEntry(f: { profile: string; chatId: string; title: string; itemId: string; mark: string; stale: boolean }): InboxEntry {
  return {
    key: `failed ${f.profile} ${f.chatId} ${f.itemId} ${f.mark}`,
    kind: "failed",
    profile: f.profile,
    chatId: f.chatId,
    title: f.title,
    at: 0,
    itemId: f.itemId,
    stale: f.stale,
    summary: "Something failed in this chat. Open it to see why.",
  };
}

function sendEntry(s: { profile: string; chatId: string; title: string; itemId: string; state: "failed" | "unknown"; at: number; stale: boolean }): InboxEntry {
  const failed = s.state === "failed";
  return {
    key: `send ${s.profile} ${s.chatId} ${s.itemId} ${s.state}`,
    kind: failed ? "failed" : "uncertain",
    profile: s.profile,
    chatId: s.chatId,
    title: s.title,
    at: s.at,
    itemId: s.itemId,
    stale: s.stale,
    summary: failed ? "A message you sent didn't reach Hermes." : "A message you sent may not have reached Hermes.",
  };
}

/** Whether an entry asks something of the owner, and counts on the inbox's badge: not running work, nor an ended Approval. */
export const needsOwner = (e: InboxEntry) => e.kind !== "running" && !e.ended;

/** Whether the owner can dismiss the entry. Running work leaves the inbox on its own once it ends. */
export const dismissable = (e: InboxEntry) => e.kind !== "running";

/** A short fingerprint of an error's text, so its key tells it from another error at the same place without keeping the text. */
export function failureMark(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** How long a dismissal is kept, and the most kept; the oldest go first. */
const ACK_KEEP_MS = 30 * 86_400_000;
const ACK_MAX = 1000;
export const INBOX_PREFIX = "hermes-chat.inbox-dismissed.";
const PREFIX = INBOX_PREFIX;

/** The storage dismissals are kept in: localStorage in the app. */
export type AckStorage = Pick<Storage, "getItem" | "setItem">;

/** Which connection a dismissal belongs to: the same server and username, in every profile. */
export function inboxScope(connection: ScopeSource): string {
  return connectionScope(connection);
}

/** Dismissed entries by key: the entry's time when dismissed, and when that was. */
type Dismissed = Record<string, [at: number, dismissedAt: number]>;

export type InboxAcks = {
  /** Dismissed, and nothing has happened since: an entry whose time is later than the dismissal's shows again. */
  isDismissed(e: InboxEntry, state?: Dismissed): boolean;
  /**
   * `entries`: the inbox's entries now. An Approval card's `alias` is dismissed with it only when no other card in its
   * chat is still waiting and not dismissed, since the alias stands for them all.
   */
  dismiss(e: InboxEntry, entries?: InboxEntry[]): void;
  /** Dismisses each of `es` as `dismiss` would, in one write. */
  dismissAll(es: InboxEntry[], entries?: InboxEntry[]): void;
  /**
   * Dismisses, as by hand, each finished (`completed`) entry in `entries` whose time is more than `olderThanMs` ago.
   * Nothing else qualifies: running work, Approvals, failures and uncertain sends all wait for the owner.
   */
  expire(entries: InboxEntry[], olderThanMs: number): void;
  /**
   * Dismisses by their own keys the cards in `entries` that a dismissed waiting session covers, so they stay dismissed
   * once Hermes no longer reports the session, as while the connection is down.
   */
  keepCovered(entries: InboxEntry[]): void;
  /** Puts back an entry dismissed by mistake. */
  restore(e: InboxEntry): void;
  subscribe(fn: () => void): () => void;
  getSnapshot(): Dismissed;
};

/**
 * Dismissals kept in `storage` for one connection (`inboxScope`). They're kept in memory once loaded, so a store that
 * is full or can't be written still keeps them until the app closes.
 */
export function inboxAcks(storage: AckStorage, scope: string, now = () => Date.now()): InboxAcks {
  const key = PREFIX + scope;
  const kept = (v: unknown): v is [number, number] => Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" && now() - v[1] < ACK_KEEP_MS;
  const pruned = (next: Record<string, unknown>): Dismissed =>
    Object.fromEntries(
      Object.entries(next)
        .filter((e): e is [string, [number, number]] => kept(e[1]))
        .sort((a, b) => b[1][1] - a[1][1])
        .slice(0, ACK_MAX),
    );
  let state: Dismissed = {};
  try {
    const read = JSON.parse(storage.getItem(key) ?? "{}");
    if (read && typeof read === "object") state = pruned(read);
  } catch {
    // A damaged record is as good as none.
  }
  const listeners = new Set<() => void>();
  const save = (next: Dismissed) => {
    state = pruned(next);
    try {
      storage.setItem(key, JSON.stringify(state));
    } catch {
      // Kept in memory.
    }
    listeners.forEach((fn) => fn());
  };
  const before = (s: Dismissed, key: string, at: number) => kept(s[key]) && s[key][0] >= at;
  const covered = (e: InboxEntry, s: Dismissed) => !!e.alias && e.aliasAt !== undefined && before(s, `resumed ${e.alias}`, e.aliasAt);
  const isDismissed = (e: InboxEntry, s = state) => before(s, e.key, e.at) || covered(e, s);
  const dismissAll = (es: InboxEntry[], entries: InboxEntry[] = []) => {
    if (!es.length) return;
    const next: Dismissed = { ...state };
    for (const e of es) {
      next[e.key] = [e.at, now()];
      // A waiting session dismissed before its chat was resumed here: the cards resuming it shows are what it waited on.
      if (e.kind === "approval" && !e.itemId) next[`resumed ${e.key}`] = [e.at, now()];
      const others = entries.filter((o) => o.key !== e.key && o.alias === e.alias && !o.ended && !(kept(next[o.key]) && next[o.key][0] >= o.at));
      if (e.alias && !others.length) next[e.alias] = [now(), now()];
    }
    save(next);
  };
  // Entries this run already dismissed on their own, by key and time. More than the most kept can be due at once, and
  // the oldest of those aren't kept: without this they'd be dismissed again on every render.
  const expired = new Set<string>();
  return {
    isDismissed,
    keepCovered: (entries) => {
      const adopt = entries.filter((e) => !before(state, e.key, e.at) && covered(e, state));
      if (adopt.length) save({ ...state, ...Object.fromEntries(adopt.map((e) => [e.key, [e.at, now()]])) });
    },
    dismiss: (e, entries) => dismissAll([e], entries),
    dismissAll,
    expire: (entries, olderThanMs) => {
      const due = entries.filter((e) => e.kind === "completed" && e.at > 0 && now() - e.at > olderThanMs && !expired.has(`${e.key} ${e.at}`) && !isDismissed(e));
      for (const e of due) expired.add(`${e.key} ${e.at}`);
      dismissAll(due, entries);
    },
    restore: (e) => {
      const { [e.key]: _gone, ...rest } = state;
      for (const k of [e.alias, e.alias && `resumed ${e.alias}`, `resumed ${e.key}`]) if (k) delete rest[k];
      save(rest);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    getSnapshot: () => state,
  };
}
