// The agent office (ADR 0077): the agents at work on this connection as desks, one room per chat. Worked out from what
// the app already has, and nothing else: a chat's own reply from the inbox's entries for it (inbox.ts), and its
// subagents from its subagent tree (subagents.ts). The office reads nothing of its own, keeps nothing, and never answers,
// approves, retries or starts anything.
import type { InboxEntry, InboxKind } from "./inbox";
import type { Chat } from "./model";
import { childrenOf, type Subagent, type SubagentId, type SubagentState, type SubagentTree } from "./subagents";
import { clockTime } from "./values";

/**
 * What a desk's agent is doing. `waiting`: the chat's reply ended after handing work off, and waits for it
 * (dispatched.ts). `approval`: the chat's reply waits for the owner's answer. `uncertain`: a message the owner sent may
 * not have reached Hermes. `completed`: Hermes said the subagent finished, never guessed. `unread`: the chat has
 * something the owner hasn't read, which alone doesn't say its reply finished. `idle`: the chat's reply isn't running,
 * and nothing about it needs the owner, but its subagents are known. `unknown`: a subagent known only as the parent of
 * another, or a reply while the app isn't connected and nothing else says how it is.
 */
export type DeskState = "queued" | "running" | "handedOff" | "approval" | "failed" | "uncertain" | "completed" | "unread" | "stopped" | "ended" | "unknown" | "idle";

export type Desk = {
  key: string;
  /**
   * The chat's own reply, with the inbox entry its state comes from, or one of the chat's subagents. `dismissed`: the
   * reply has no entry left because the owner dismissed the chat's last one.
   */
  agent: { kind: "reply"; entry?: InboxEntry; dismissed?: true } | { kind: "subagent"; id: SubagentId; depth: number; parent?: SubagentId };
  name: string;
  state: DeskState;
  /** What it last did, if known, and when; `at` 0 when that isn't known. */
  doing?: { text: string; at: number };
  /** Why its state may not be current: shown as last heard. None when it is current. */
  stale?: string;
  /** What the office's card says beyond its state (ADR 0122): its goal, its model, and how long it ran, when known. */
  detail?: { goal?: string; model?: string; startedAt?: number; durationS?: number };
};

export type Room = { key: string; profile: string; chatId: string; title: string; desks: Desk[] };

const SUBAGENT_STATE: Record<SubagentState, DeskState> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  error: "failed",
  timeout: "failed",
  interrupted: "stopped",
  ended: "ended",
  unknown: "unknown",
};

/**
 * Which inbox entry a chat's reply desk shows when there are several: what needs the owner first, except that a reply
 * running (the wake turn) shows ahead of a dispatched task that needs the owner, as the chat's row does.
 */
const REPLY_ORDER: readonly ((e: InboxEntry) => boolean)[] = [
  (e) => e.kind === "approval" && !e.taskId,
  (e) => e.kind === "running" && !e.waiting,
  (e) => e.kind === "approval",
  (e) => e.kind === "running",
  (e) => e.kind === "failed",
  (e) => e.kind === "uncertain",
  (e) => e.kind === "completed",
];
// The inbox's "completed" is a chat with something unread: no event confirms that a reply finished.
const REPLY_STATE: Record<InboxKind, DeskState> = { approval: "approval", running: "running", failed: "failed", uncertain: "uncertain", completed: "unread" };

/** Live work is shown whatever the owner dismissed; what already happened goes once they dismiss it in the inbox. */
const isLive = (e: InboxEntry) => e.kind === "running" || (e.kind === "approval" && !e.ended);

const NOT_CONNECTED = "Not connected to Hermes: as last seen.";

function treeStale(tree: SubagentTree, connected: boolean): string | undefined {
  if (tree.sync.kind === "lost") return `Disconnected since ${clockTime(tree.sync.since)}: as last heard.`;
  if (tree.sync.kind === "unchecked") return `As last heard. ${tree.sync.why}`;
  return connected ? undefined : NOT_CONNECTED;
}

function subagentDesks(tree: SubagentTree, chatKey: string, stale: string | undefined): Desk[] {
  const out: Desk[] = [];
  const walk = (parent?: SubagentId) => {
    for (const s of childrenOf(tree, parent)) {
      out.push(subagentDesk(s, chatKey, stale));
      walk(s.id);
    }
  };
  walk();
  return out;
}

function subagentDesk(s: Subagent, chatKey: string, stale: string | undefined): Desk {
  return {
    key: `${chatKey} ${s.id}`,
    agent: { kind: "subagent", id: s.id, depth: s.depth, ...(s.parent && { parent: s.parent }) },
    name: s.goal || "A subagent Hermes hasn't described yet",
    state: SUBAGENT_STATE[s.state],
    ...(s.lastActivity && { doing: { text: s.lastActivity.text, at: s.lastActivity.at } }),
    ...(stale && { stale }),
    detail: { ...(s.goal && { goal: s.goal }), ...(s.model && { model: s.model }), ...(s.startedAt && { startedAt: s.startedAt }), ...(s.durationS !== undefined && { durationS: s.durationS }) },
  };
}

/**
 * The office's rooms: one for each chat the inbox lists, in the inbox's order, then each chat of the shown profile
 * whose subagents this connection has heard of. `entries`: all the inbox's entries; `shown`: whether the owner left an
 * entry in the inbox (not dismissed). A room's first desk is the chat's own reply; its subagents follow, each after
 * the one that started it.
 */
export function officeRooms({
  entries,
  shown,
  chats,
  profile,
  connected,
}: {
  entries: readonly InboxEntry[];
  shown: (e: InboxEntry) => boolean;
  chats: readonly Chat[];
  profile: string;
  connected: boolean;
}): Room[] {
  const rooms = new Map<string, { profile: string; chatId: string; title: string; entries: InboxEntry[] }>();
  const room = (p: string, chatId: string, title: string) => {
    const key = `${p} ${chatId}`;
    if (!rooms.has(key)) rooms.set(key, { profile: p, chatId, title, entries: [] });
    return rooms.get(key)!;
  };
  const dismissed = new Set<string>();
  for (const e of entries)
    if (isLive(e) || (!e.ended && shown(e))) room(e.profile, e.chatId, e.title).entries.push(e);
    else if (!e.ended) dismissed.add(`${e.profile} ${e.chatId}`);
  for (const c of chats) if (c.subagents?.subagents.length) room(profile, c.id, c.title);

  return [...rooms.entries()].map(([key, r]) => {
    const entry = REPLY_ORDER.map((is) => r.entries.find(is)).find((e) => !!e);
    const stale = !connected ? NOT_CONNECTED : entry?.stale ? "As last seen: Hermes couldn't be checked." : undefined;
    const chat = r.profile === profile ? chats.find((c) => c.id === r.chatId) : undefined;
    const reply: Desk = {
      key: `${key} reply`,
      agent: { kind: "reply", ...(entry ? { entry } : dismissed.has(key) && { dismissed: true as const }) },
      name: "The chat's reply",
      // A drop ends the app's word on whether the reply runs; it's resumed and known again once connected.
      state: entry ? (entry.waiting ? "handedOff" : REPLY_STATE[entry.kind]) : connected ? "idle" : "unknown",
      ...(entry && { doing: { text: entry.summary, at: entry.at || entry.noticedAt || 0 } }),
      ...(stale && { stale }),
      ...(chat?.model && { detail: { model: chat.model.model } }),
    };
    const tree = chat?.subagents;
    return {
      key,
      profile: r.profile,
      chatId: r.chatId,
      title: r.title,
      desks: [reply, ...(tree ? subagentDesks(tree, key, treeStale(tree, connected)) : [])],
    };
  });
}

/** How many desks are at work, wait for the owner, or failed, for the office's heading. */
export function officeTally(rooms: readonly Room[]): { working: number; waiting: number; failed: number; desks: number } {
  let working = 0;
  let waiting = 0;
  let failed = 0;
  let desks = 0;
  for (const r of rooms)
    for (const d of r.desks) {
      desks++;
      if (d.state === "running" || d.state === "queued" || d.state === "handedOff") working++;
      else if (d.state === "approval") waiting++;
      else if (d.state === "failed") failed++;
    }
  return { working, waiting, failed, desks };
}
