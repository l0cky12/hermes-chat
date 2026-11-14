// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, the
// Saved copies of the chats opened lately, so they can be read while Hermes can't be reached, the profile shown last,
// so the next sign-in opens it, and the profiles whose older history the owner pulled. All of it is kept apart per
// connection (how the app reaches the dashboard, and as whom), never with the password.
// Each chat's outbox, the messages sent from here that Hermes hasn't confirmed, is kept beside it, per connection,
// profile and chat. It holds the owner's own words, so like a draft it isn't part of the cache. So is each chat's
// queue of messages waiting to go after its reply (ADR 0018).
// Clearing the cache deletes every connection's chat lists and Saved copies, and nothing else: never the sign-in,
// drafts, outboxes, appearance or display preferences (uiPrefs.ts).
import { type ScopeSource, connectionScope, inScope } from "./connections";
import type { Attachment, Chat, ChatQueue, Item, Outgoing, OutgoingItem, Queued, SentReference, Source } from "./model";
import type { ChatCache, SavedTranscript } from "./transport";
import { UI_PREFS_KEY } from "./uiPrefs";
import { replyUsageOf } from "./usage";
import { persist } from "./unsaved";
import { NO_BRANCHES, type BranchAttempt, type BranchLink, type BranchPoint, type BranchStore, type BranchVariant } from "./branch";
import { pickOf } from "./models";
import { optionalText } from "./values";

/** Every key prefix this module keeps a connection's data under, each followed by its scope (connections.ts). */
export const CACHE_PREFIXES = () => [LIST_PREFIX, TRANSCRIPT_PREFIX, PROFILE_PREFIX, PULLED_PREFIX, OUTBOX_PREFIX, QUEUE_PREFIX, HELD_PREFIX, BRANCH_PREFIX];
/** Each profile's chat list, by connection and profile. */
export const LIST_PREFIX = "hermes-chat.chats.";
/** A chat's Saved copy, by connection, profile and chat. */
export const TRANSCRIPT_PREFIX = "hermes-chat.transcript.";
/** The profile shown last, by connection: its value is the profile's name. */
export const PROFILE_PREFIX = "hermes-chat.profile.";
/** The profiles whose older chats were pulled, by connection: its value lists their names. */
export const PULLED_PREFIX = "hermes-chat.older-pulled.";
/** A chat's Failed and uncertain messages, by connection, profile and chat. */
export const OUTBOX_PREFIX = "hermes-chat.outbox.";
/** A chat's Queued messages, by connection, profile and chat. */
export const QUEUE_PREFIX = "hermes-chat.queue.";
/** The branches this app made, and the ones whose answer was lost, per connection and profile (ADR 0027). */
export const BRANCH_PREFIX = "hermes-chat.branches.";
/** Where drafts.ts kept a chat's sent messages Hermes didn't take, or may not have, before the outbox: moved into it. */
export const HELD_PREFIX = "hermes-chat.undelivered.";

const outboxListeners = new Set<() => void>();
// Include writes the store couldn't keep: those outboxes and queues still exist in the running transport.
const liveOutboxes = new Map<string, OutgoingItem[]>();
const liveQueues = new Map<string, ChatQueue>();
export function subscribeOutbox(fn: () => void): () => void {
  outboxListeners.add(fn);
  return () => void outboxListeners.delete(fn);
}

/** Drop failed-write outboxes/queues when a connection is removed, before screenshot retention is synchronized. */
export function forgetLiveChatData(parts: string[]) {
  for (const [prefix, rows] of [[OUTBOX_PREFIX, liveOutboxes], [QUEUE_PREFIX, liveQueues]] as const) {
    for (const key of rows.keys()) if (inScope(parts, key.slice(prefix.length))) rows.delete(key);
  }
}

/**
 * Moves or drops the failed-write outboxes and queues held in memory, by key: `move` answers a key's new key, null to
 * drop it, or undefined to keep it (profileLocalData.ts, a profile renamed or deleted).
 */
export function moveLiveChatData(move: (key: string) => string | null | undefined) {
  for (const rows of [liveOutboxes, liveQueues] as Map<string, unknown>[]) {
    for (const [key, value] of [...rows]) {
      const to = move(key);
      if (to === undefined) continue;
      rows.delete(key);
      if (to !== null) rows.set(to, value);
    }
  }
}

/** Attachment paths in every connection/profile's outbox and queue, for local screenshot lifetime management. */
export function outboxAttachmentPaths(): string[] {
  const read = (k: string): unknown => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "null");
    } catch {
      return null; // A malformed row holds no attachment.
    }
  };
  const rows = new Map<string, OutgoingItem[]>();
  for (const k of keysOf(OUTBOX_PREFIX)) {
    const value = read(k);
    if (Array.isArray(value)) rows.set(k, value.flatMap((r) => toOutgoing(r) ?? []));
  }
  for (const [k, items] of liveOutboxes) rows.set(k, items);
  const queued = new Map<string, Queued[]>();
  for (const k of keysOf(QUEUE_PREFIX)) queued.set(k, toQueue(read(k))?.items ?? []);
  for (const [k, q] of liveQueues) queued.set(k, q.items);
  const files = [
    ...[...rows.values()].flatMap((items) => items.flatMap((r) => r.outgoing.attachments ?? [])),
    ...[...queued.values()].flatMap((items) => items.flatMap((q) => q.attachments ?? [])),
  ];
  return [...new Set(files.map((a) => a.path))];
}

/**
 * The most storage the Saved copies take. The least recently saved go first past it. WebKitGTK gives the app about
 * 5 MB of localStorage, which the chat lists and sign-in share.
 */
export const TRANSCRIPT_LIMIT_BYTES = 2 * 1024 * 1024;

/** localStorage keeps text as UTF-16: two bytes a character, key and value. */
const sizeOf = (k: string, value = localStorage.getItem(k) ?? "") => 2 * (k.length + value.length);

/** The keys starting with `prefix`. */
function keysOf(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(prefix)) keys.push(k);
  }
  return keys;
}
/**
 * Every connection's lists and Saved copies, and lists kept before they were kept per connection. Only these count
 * toward the cache or are cleared with it; the display preferences are named out so no prefix can ever take them in.
 */
const cacheKeys = () => [...keysOf(LIST_PREFIX), ...keysOf(TRANSCRIPT_PREFIX)].filter((k) => k !== UI_PREFS_KEY);

/** Deletes every connection's lists and Saved copies. */
export function clearCachedChats() {
  try {
    for (const k of cacheKeys()) localStorage.removeItem(k);
  } catch {
    // Nothing can be deleted from a store that can't be read.
  }
}

/** When a Saved copy was saved, read off the front of its JSON so the rest isn't parsed. */
const savedAtOf = (k: string) => Number(/^\{"savedAt":(\d+)/.exec(localStorage.getItem(k) ?? "")?.[1] ?? 0);

const SOURCES: Source[] = ["app", "telegram", "discord", "desktop", "cli", "import", "other"];
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A saved list row as a Chat, or undefined if it isn't one. The transcript is never in the list. */
function toChat(v: unknown): Chat | undefined {
  const c = v as Record<string, unknown> | null;
  if (typeof c?.id !== "string" || typeof c.title !== "string") return undefined;
  return {
    id: c.id,
    title: c.title,
    source: SOURCES.includes(c.source as Source) ? (c.source as Source) : "other",
    settled: typeof c.settled === "boolean" ? c.settled : true,
    ...(c.settledHere === true && { settledHere: true }),
    updatedAt: num(c.updatedAt) ?? 0,
    ...(typeof c.unread === "boolean" && { unread: c.unread }),
    ...(c.archived === true && { archived: true }),
    items: [],
  };
}

/**
 * A saved transcript item, rebuilt from the fields its kind has, or undefined if it isn't one a Saved copy holds.
 * Only what Hermes stores comes back: never an Approval, which could otherwise be answered, or an error.
 */
function toItem(v: unknown): Item | undefined {
  const i = v as Record<string, unknown> | null;
  const id = optionalText(i?.id);
  if (!i || id === undefined) return undefined;
  const text = optionalText(i.text);
  const at = num(i.at);
  switch (i.kind) {
    case "user": {
      const attachments = Array.isArray(i.attachments) ? i.attachments.filter((a): a is string => typeof a === "string") : undefined;
      const references = Array.isArray(i.references) ? i.references.filter((a): a is string => typeof a === "string") : undefined;
      const rowId = Number.isSafeInteger(i.rowId) ? (i.rowId as number) : undefined;
      return text === undefined
        ? undefined
        : {
            kind: "user",
            id,
            text,
            ...(attachments?.length && { attachments }),
            ...(references?.length && { references }),
            ...(at !== undefined && { at }),
            ...(rowId !== undefined && { rowId }),
            ...(i.steer === true && { steer: true }),
          };
    }
    case "assistant": {
      const rowId = Number.isSafeInteger(i.rowId) ? (i.rowId as number) : undefined;
      const usage = replyUsageOf(i.usage);
      return text === undefined
        ? undefined
        : {
            kind: "assistant",
            id,
            text,
            ...(i.interrupted === true && { interrupted: true }),
            ...(at !== undefined && { at }),
            ...(rowId !== undefined && { rowId }),
            ...(usage && { usage }),
          };
    }
    case "thinking":
      return text === undefined ? undefined : { kind: "thinking", id, text };
    case "tool": {
      const name = optionalText(i.name);
      if (name === undefined || (i.status !== "done" && i.status !== "stopped")) return undefined;
      const args = i.args && typeof i.args === "object" && !Array.isArray(i.args) ? (i.args as Record<string, unknown>) : undefined;
      const [preview, result, summary, durationS] = [optionalText(i.preview), optionalText(i.result), optionalText(i.summary), num(i.durationS)];
      return {
        kind: "tool",
        id,
        name,
        status: i.status,
        ...(args && { args }),
        ...(preview !== undefined && { preview }),
        ...(result !== undefined && { result }),
        ...(summary !== undefined && { summary }),
        ...(durationS !== undefined && { durationS }),
      };
    }
    default:
      return undefined;
  }
}

const isAttachment = (a: unknown): a is Attachment => {
  const f = a as Attachment | null;
  return typeof f?.path === "string" && typeof f.name === "string" && typeof f.size === "number" && (f.kind === "image" || f.kind === "file");
};

const isSentReference = (r: unknown): r is SentReference => {
  const s = r as SentReference | null;
  return typeof s?.chatId === "string" && typeof s.title === "string" && typeof s.summary === "string";
};

/** A kept outbox row, rebuilt from its fields, or undefined if it isn't one. */
function toOutgoing(v: unknown): OutgoingItem | undefined {
  const item = toItem(v);
  const o = (v as { outgoing?: Record<string, unknown> } | null)?.outgoing;
  if (item?.kind !== "user" || !o || (o.state !== "sending" && o.state !== "failed" && o.state !== "unknown")) return undefined;
  const sent = o.sent as Record<string, unknown> | undefined;
  const skill = o.skill as Record<string, unknown> | undefined;
  const attachments = Array.isArray(o.attachments) ? o.attachments.filter(isAttachment) : [];
  const references = Array.isArray(o.references) ? o.references.filter(isSentReference) : [];
  const outgoing: Outgoing = {
    state: o.state,
    ...(optionalText(o.reason) !== undefined && { reason: optionalText(o.reason) }),
    ...(attachments.length && { attachments }),
    ...(typeof sent?.prompt === "string" && { sent: { prompt: sent.prompt, ...(num(sent.after) !== undefined && { after: num(sent.after) }) } }),
    ...(skill && typeof skill.name === "string" && skill.name && typeof skill.arg === "string" && { skill: { name: skill.name, arg: skill.arg } }),
    ...(references.length && { references: references.map(({ chatId, title, summary }) => ({ chatId, title, summary })) }),
  };
  return { ...item, outgoing };
}

/** A kept queue, rebuilt from its fields, or undefined if it isn't one. Messages that aren't one are left out. */
export function toQueue(v: unknown): ChatQueue | undefined {
  const q = v as { items?: unknown; paused?: unknown } | null;
  if (!q || !Array.isArray(q.items)) return undefined;
  const items = q.items.flatMap((i): Queued[] => {
    const r = i as Record<string, unknown> | null;
    if (typeof r?.id !== "string" || typeof r.text !== "string") return [];
    const attachments = Array.isArray(r.attachments) ? r.attachments.filter(isAttachment) : [];
    return [{ id: r.id, text: r.text, ...(attachments.length && { attachments }) }];
  });
  return { items, ...(typeof q.paused === "string" && { paused: q.paused }) };
}

/** A kept branch store, rebuilt from its fields; links and attempts that aren't one are left out. */
export function toBranches(v: unknown): BranchStore {
  const o = v as { links?: unknown; attempts?: unknown } | null;
  if (!o || typeof o !== "object") return NO_BRANCHES;
  const point = (p: unknown): BranchPoint | undefined => {
    const q = p as { role?: unknown; excerpt?: unknown } | null;
    const rowId = Number.isSafeInteger((q as { rowId?: unknown } | null)?.rowId) ? ((q as { rowId: number }).rowId) : undefined;
    return q && (q.role === "user" || q.role === "assistant") && typeof q.excerpt === "string" ? { role: q.role, excerpt: q.excerpt, ...(rowId !== undefined && { rowId }) } : undefined;
  };
  const variant = (v: unknown): BranchVariant | undefined => {
    const q = v as Record<string, unknown> | null;
    if (!q || typeof q !== "object" || (q.kind !== "edit" && q.kind !== "regenerate") || !optionalText(q.rootId) || !Number.isSafeInteger(q.turn) || (q.turn as number) < 0) return undefined;
    const model = pickOf(q.model);
    const pending = q.pending as Record<string, unknown> | null | undefined;
    const kept =
      pending && typeof pending.text === "string" && optionalText(pending.prefix) && optionalText(pending.through)
        ? { text: pending.text, prefix: optionalText(pending.prefix)!, through: optionalText(pending.through)! }
        : undefined;
    return { kind: q.kind, rootId: optionalText(q.rootId)!, turn: q.turn as number, ...(model && { model }), ...(kept && { pending: kept }) };
  };
  const links: Record<string, BranchLink> = {};
  for (const [id, l] of Object.entries(o.links && typeof o.links === "object" ? o.links : {})) {
    const r = l as Record<string, unknown>;
    const p = point(r?.point);
    const v = variant(r?.variant);
    if (p && optionalText(r.parentId) && optionalText(r.parentTitle) !== undefined && num(r.at) !== undefined)
      links[id] = { parentId: optionalText(r.parentId)!, parentTitle: optionalText(r.parentTitle)!, point: p, at: num(r.at)!, ...(v && { variant: v }) };
  }
  const attempts = (Array.isArray(o.attempts) ? o.attempts : []).flatMap((a): BranchAttempt[] => {
    const r = a as Record<string, unknown>;
    const p = point(r?.point);
    const count = num(r?.count);
    const startedAt = num(r?.startedAt);
    if (!p || !optionalText(r.key) || !optionalText(r.parentId) || !optionalText(r.fingerprint) || count === undefined || startedAt === undefined || !Array.isArray(r.before)) return [];
    const model = pickOf(r.model);
    const v = variant(r.variant);
    return [
      {
        key: optionalText(r.key)!,
        parentId: optionalText(r.parentId)!,
        parentTitle: optionalText(r.parentTitle) ?? "",
        point: p,
        count,
        fingerprint: optionalText(r.fingerprint)!,
        before: r.before.filter((b): b is string => typeof b === "string"),
        startedAt,
        ...(optionalText(r.title) && { title: optionalText(r.title) }),
        ...(model && { model }),
        ...(v && { variant: v }),
      },
    ];
  });
  return { links, attempts };
}

/** A message drafts.ts held, as an outbox row. One Hermes may have got is found in the history by its words alone. */
function fromHeld(v: unknown): OutgoingItem | undefined {
  const h = v as { id?: unknown; text?: unknown; delivery?: unknown; reason?: unknown } | null;
  if (typeof h?.id !== "string" || typeof h.text !== "string" || (h.delivery !== "unsent" && h.delivery !== "unknown")) return undefined;
  const unknown = h.delivery === "unknown";
  const reason = typeof h.reason === "string" ? h.reason : undefined;
  return { kind: "user", id: `u-held-${h.id}`, text: h.text, outgoing: { state: unknown ? "unknown" : "failed", reason, ...(unknown && { sent: { prompt: h.text } }) } };
}

/** The cache for one connection. `connection` may carry a password; it never goes into a key or value. */
export function localChatCache(connection: ScopeSource): ChatCache {
  const scope = (...rest: string[]) => connectionScope(connection, ...rest);
  const listKey = (profile: string) => LIST_PREFIX + scope(profile);
  const transcriptKey = (profile: string, chatId: string) => TRANSCRIPT_PREFIX + scope(profile, chatId);
  const profileKey = PROFILE_PREFIX + scope();
  const pulledKey = PULLED_PREFIX + scope();
  const outboxKey = (profile: string, chatId: string) => OUTBOX_PREFIX + scope(profile, chatId);
  const queueKey = (profile: string, chatId: string) => QUEUE_PREFIX + scope(profile, chatId);
  const branchKey = (profile: string) => BRANCH_PREFIX + scope(profile);
  /** The chat ids of the profile's keys under `prefix`: the key's scope with the chat id last. */
  const chatsUnder = (prefix: string, profile: string, keys = keysOf(prefix + scope(profile).slice(0, -1) + ",")) =>
    keys.filter((k) => k.startsWith(prefix + scope(profile).slice(0, -1) + ",")).flatMap((k) => {
      try {
        const id: unknown = (JSON.parse(k.slice(prefix.length)) as unknown[]).at(-1);
        return typeof id === "string" ? [{ k, id }] : [];
      } catch {
        return [];
      }
    });
  const readJson = (k: string): unknown[] => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(k) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  // A failed write keeps the outbox in memory, here and for an update's restart (unsaved.ts).
  const writeOutbox = (profile: string, chatId: string, items: OutgoingItem[]) => {
    const key = outboxKey(profile, chatId);
    liveOutboxes.set(key, items);
    const kept = persist(() => localStorage, key, items.length ? JSON.stringify(items) : null);
    if (kept) liveOutboxes.delete(key);
    for (const fn of outboxListeners) fn();
    return kept;
  };

  const pulledProfiles = (): string[] => {
    try {
      const profiles: unknown = JSON.parse(localStorage.getItem(pulledKey) ?? "[]");
      return Array.isArray(profiles) ? profiles.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  };

  return {
    load(profile) {
      try {
        const chats: unknown = JSON.parse(localStorage.getItem(listKey(profile)) ?? "[]");
        return Array.isArray(chats) ? chats.flatMap((c) => toChat(c) ?? []) : [];
      } catch {
        return [];
      }
    },
    save(profile, chats) {
      try {
        localStorage.setItem(listKey(profile), JSON.stringify(chats));
      } catch {
        // A full or unavailable store only costs the instant list at next sign-in.
      }
    },
    loadTranscript(profile, chatId) {
      try {
        const saved: Partial<SavedTranscript> | null = JSON.parse(localStorage.getItem(transcriptKey(profile, chatId)) ?? "null");
        const savedAt = num(saved?.savedAt);
        if (savedAt === undefined || !Array.isArray(saved?.items)) return undefined;
        return { savedAt, items: saved.items.flatMap((i) => toItem(i) ?? []) };
      } catch {
        return undefined;
      }
    },
    saveTranscript(profile, chatId, items) {
      try {
        const k = transcriptKey(profile, chatId);
        const value = JSON.stringify({ savedAt: Date.now(), items });
        localStorage.removeItem(k);
        // A copy bigger than the limit isn't kept; the chat loads from Hermes when it can.
        let used = sizeOf(k, value);
        if (used > TRANSCRIPT_LIMIT_BYTES) return;
        // The limit covers every connection's copies together.
        const newestFirst = keysOf(TRANSCRIPT_PREFIX)
          .map((other) => ({ other, savedAt: savedAtOf(other) }))
          .sort((a, b) => b.savedAt - a.savedAt);
        for (const { other } of newestFirst) {
          used += sizeOf(other);
          if (used > TRANSCRIPT_LIMIT_BYTES) localStorage.removeItem(other);
        }
        localStorage.setItem(k, value);
      } catch {
        // A full or unavailable store only costs reading this chat offline.
      }
    },
    deleteTranscript(profile, chatId) {
      try {
        localStorage.removeItem(transcriptKey(profile, chatId));
      } catch {
        // Nothing can be deleted from a store that can't be used; nothing can be read from it either.
      }
    },
    lastProfile() {
      try {
        return localStorage.getItem(profileKey) || undefined;
      } catch {
        return undefined;
      }
    },
    rememberProfile(profile) {
      try {
        localStorage.setItem(profileKey, profile);
      } catch {
        // The next sign-in opens the default profile instead.
      }
    },
    bytes() {
      try {
        return cacheKeys().reduce((n, k) => n + sizeOf(k), 0);
      } catch {
        return 0;
      }
    },
    clear() {
      clearCachedChats();
    },
    olderPulled(profile) {
      return pulledProfiles().includes(profile);
    },
    loadOutbox(profile) {
      try {
        // Messages drafts.ts held move into the outbox the first time it is read.
        for (const { k, id } of chatsUnder(HELD_PREFIX, profile)) {
          const held = readJson(k).flatMap((h) => fromHeld(h) ?? []);
          writeOutbox(profile, id, [...readJson(outboxKey(profile, id)).flatMap((r) => toOutgoing(r) ?? []), ...held]);
          localStorage.removeItem(k);
        }
        const outboxes = Object.fromEntries(chatsUnder(OUTBOX_PREFIX, profile).map(({ k, id }) => [id, readJson(k).flatMap((r) => toOutgoing(r) ?? [])]));
        // One storage refused is kept in memory instead, and is the latest.
        for (const { k, id } of chatsUnder(OUTBOX_PREFIX, profile, [...liveOutboxes.keys()])) outboxes[id] = liveOutboxes.get(k)!;
        return Object.fromEntries(Object.entries(outboxes).filter(([, rows]) => rows.length));
      } catch {
        return {};
      }
    },
    saveOutbox: writeOutbox,
    loadQueues(profile) {
      try {
        const queues: Record<string, ChatQueue> = {};
        for (const { k, id } of chatsUnder(QUEUE_PREFIX, profile)) {
          try {
            const q = toQueue(JSON.parse(localStorage.getItem(k) ?? "null"));
            if (q?.items.length) queues[id] = q;
          } catch {
            // A malformed queue holds nothing to send.
          }
        }
        // One storage refused is kept in memory instead, and is the latest.
        for (const { k, id } of chatsUnder(QUEUE_PREFIX, profile, [...liveQueues.keys()])) {
          const q = liveQueues.get(k)!;
          if (q.items.length) queues[id] = { ...q, unsaved: true };
          else delete queues[id];
        }
        return queues;
      } catch {
        return {};
      }
    },
    saveQueue(profile, chatId, q) {
      // A failed write keeps the queue in memory, here and for an update's restart (unsaved.ts), as for an outbox.
      const key = queueKey(profile, chatId);
      const kept = { items: q?.items ?? [], ...(q?.paused !== undefined && { paused: q.paused }) };
      liveQueues.set(key, kept);
      const ok = persist(() => localStorage, key, kept.items.length ? JSON.stringify(kept) : null);
      if (ok) liveQueues.delete(key);
      for (const fn of outboxListeners) fn();
      return ok;
    },
    loadBranches(profile) {
      try {
        return toBranches(JSON.parse(localStorage.getItem(branchKey(profile)) ?? "null"));
      } catch {
        return NO_BRANCHES;
      }
    },
    saveBranches(profile, store) {
      const empty = !Object.keys(store.links).length && !store.attempts.length;
      return persist(() => localStorage, branchKey(profile), empty ? null : JSON.stringify(store));
    },
    rememberOlderPulled(profile) {
      try {
        const pulled = pulledProfiles();
        if (!pulled.includes(profile)) localStorage.setItem(pulledKey, JSON.stringify([...pulled, profile]));
      } catch {
        // The next launch shows the past month only, until the owner pulls again.
      }
    },
  };
}
