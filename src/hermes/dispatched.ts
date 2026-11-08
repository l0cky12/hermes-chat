// Dispatched work (GLOSSARY.md "Dispatched work", issue #287): a reply that hands work to another agent, a kanban task
// through `kanban_create` or background subagents through `delegate_task`, and ends its turn. Hermes wakes the chat
// with a new turn once that work is done (`tui_gateway/session_notifications.py`), so the chat isn't finished when the
// dispatching reply ends. Until the work is over and the wake turn has ended, the chat stays in Working, waiting, or
// goes to the Inbox once a task needs the owner. Everything here is pure: the transport keeps `Chat.tasks` from
// Hermes's board (kanban.ts), and the subagents are the chat's own tree (subagents.ts).
import type { Chat } from "./model";
import { hasEnded, tally, type Subagent } from "./subagents";

export const KANBAN_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

/** A kanban task one of the chat's replies created, as the app last saw it on Hermes's board. */
export type DispatchedTask = {
  id: string;
  /** The board's slug. */
  board: string;
  status: KanbanStatus;
  title?: string;
  assignee?: string;
  /** Unix ms: the task's `created_at`, or when its `tool.complete` arrived. */
  createdAt: number;
  /** A worker has started it: `started_at`, `current_run_id`, or any run. */
  picked: boolean;
  /** Unix ms when the app first saw it done or archived. */
  overAt?: number;
};

/** What each status means for the chat: the issue's table, as a table. */
export const TASK_MEANS: Record<KanbanStatus, "outstanding" | "needsOwner" | "over"> = {
  triage: "outstanding",
  todo: "outstanding",
  scheduled: "outstanding",
  ready: "outstanding",
  running: "outstanding",
  blocked: "needsOwner",
  review: "needsOwner",
  done: "over",
  archived: "over",
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * An over task keeps the chat waiting this long after the app saw it over: Hermes's poller wakes the chat within about
 * 5 s, and the chat would otherwise flicker through the Inbox when a poll sees `done` before the wake turn starts.
 */
export const WAKE_GRACE_MS = 20_000;
/** A `ready` task no worker has picked up after this long is stalled: the gateway that dispatches is likely down. */
export const STALLED_MS = 10 * MINUTE;
/** A task never picked up after this long is stale and doesn't count: the board holds months-old ones. */
export const STALE_UNPICKED_MS = 7 * DAY;

/** Where a chat stands on work it handed off. Derived, never stored. */
export type Handoff =
  | { kind: "waiting"; tasks: DispatchedTask[]; subagents: number; stalled: boolean }
  | { kind: "needsOwner"; task: DispatchedTask; reason: string };

/** The ids of the work the owner stopped waiting on, per chat (snooze.ts `StopWaitingStore`). Newer work has new ids. */
export type StopWaiting = Readonly<Record<string, readonly string[]>>;

export const isStale = (t: DispatchedTask, now: number) => TASK_MEANS[t.status] === "outstanding" && !t.picked && now - t.createdAt > STALE_UNPICKED_MS;

/** Whether the task keeps its chat waiting at `now`: outstanding and not stale, or over inside the wake grace. */
function holds(t: DispatchedTask, now: number): boolean {
  const means = TASK_MEANS[t.status];
  if (means === "over") return t.overAt !== undefined && now - t.overAt < WAKE_GRACE_MS;
  return means === "outstanding" && !isStale(t, now);
}

/**
 * A subagent that ended after the chat last moved (no turn started or ended since), inside the wake grace: Hermes is
 * about to start the turn that reports on it, as with an over task.
 */
function justEnded(s: Subagent, c: Chat, now: number): boolean {
  const at = endedAt(s);
  return at !== undefined && at >= c.updatedAt && now - at < WAKE_GRACE_MS;
}

/** When Hermes said the subagent ended; none while it runs, or when it ended unheard (`ended`, as a roster finds it). */
function endedAt(s: Subagent): number | undefined {
  if (!hasEnded(s.state) || s.state === "ended") return undefined;
  return [...s.activity].reverse().find((a) => a.kind === "ended")?.at;
}

/** Subagents still queued or running, else those just ended with the wake turn to come, less those in `ignored`. */
function subagentsLeft(c: Chat, ignored: ReadonlySet<string> | undefined, now: number): number {
  if (!c.subagents) return 0;
  const counted = c.subagents.subagents.filter((s) => !ignored?.has(s.id));
  return tally({ ...c.subagents, subagents: counted }).running || counted.filter((s) => justEnded(s, c, now)).length;
}

/**
 * The chat's handoff at `now`, or none when nothing it dispatched is still counted. A task that needs the owner wins
 * over waiting. `ignored`: the ids the owner stopped waiting on.
 */
export function handoffOf(c: Chat, ignored: ReadonlySet<string> | undefined, now: number): Handoff | undefined {
  const tasks = (c.tasks ?? []).filter((t) => !ignored?.has(t.id));
  const needs = tasks.find((t) => TASK_MEANS[t.status] === "needsOwner");
  if (needs) return { kind: "needsOwner", task: needs, reason: needs.status === "blocked" ? "A dispatched task is blocked." : "A dispatched task is waiting for review." };
  const held = tasks.filter((t) => holds(t, now));
  const subagents = c.running ? 0 : subagentsLeft(c, ignored, now);
  if (!held.length && !subagents) return undefined;
  const stalled = held.some((t) => t.status === "ready" && !t.picked && now - t.createdAt > STALLED_MS);
  return { kind: "waiting", tasks: held, subagents, stalled };
}

/** Each chat's handoff, by chat id, for the chats that have one. */
export function handoffs(chats: readonly Chat[], stops: StopWaiting, now: number): ReadonlyMap<string, Handoff> {
  const out = new Map<string, Handoff>();
  for (const c of chats) {
    const ignored = stops[c.id];
    const h = handoffOf(c, ignored ? new Set(ignored) : undefined, now);
    if (h) out.set(c.id, h);
  }
  return out;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the waiting icon says it waits on. */
export function waitingLabel(h: Extract<Handoff, { kind: "waiting" }>): string {
  if (h.stalled) return "No worker has picked this task up. Is the Hermes gateway running?";
  const tasks = h.tasks.length;
  if (tasks && h.subagents) return `Waiting on ${count(tasks, "task")} and ${count(h.subagents, "subagent")}`;
  if (tasks) return `Waiting on ${count(tasks, "dispatched task")}`;
  return `Waiting on ${count(h.subagents, "subagent")}`;
}

/** The ids of the chat's work as it stands, for Stop waiting: every task it has, and each subagent still at work. */
export function outstandingIds(c: Chat): string[] {
  const tasks = (c.tasks ?? []).map((t) => t.id);
  const subagents = (c.subagents?.subagents ?? []).filter((s) => s.state === "queued" || s.state === "running").map((s) => s.id);
  return [...tasks, ...subagents];
}

/**
 * The next time a chat's handoff changes with nothing else happening: an over task's or ended subagent's grace ending, a `ready` task
 * becoming stalled, or an unpicked task going stale. None when no chat has one.
 */
export function nextHandoffChange(chats: readonly Chat[], stops: StopWaiting, now: number): number | undefined {
  let next: number | undefined;
  const consider = (at: number) => {
    if (at > now && (next === undefined || at < next)) next = at;
  };
  for (const c of chats) {
    const ignored = new Set(stops[c.id] ?? []);
    for (const s of c.subagents?.subagents ?? []) if (!ignored.has(s.id) && justEnded(s, c, now)) consider(endedAt(s)! + WAKE_GRACE_MS);
    for (const t of c.tasks ?? []) {
      if (ignored.has(t.id)) continue;
      if (TASK_MEANS[t.status] === "over" && t.overAt !== undefined) consider(t.overAt + WAKE_GRACE_MS);
      if (TASK_MEANS[t.status] === "outstanding" && !t.picked) {
        if (t.status === "ready") consider(t.createdAt + STALLED_MS);
        consider(t.createdAt + STALE_UNPICKED_MS);
      }
    }
  }
  return next;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const isStatus = (v: unknown): v is KanbanStatus => typeof v === "string" && (KANBAN_STATUSES as readonly string[]).includes(v);

/**
 * The task a `kanban_create` call made, from the call's `args` and its raw `result` (`tools/kanban_tools.py`: a JSON
 * object, or that as text), or none when the call didn't make one (`ok` not true, no `task_id`). The board is the
 * call's, else `currentBoard`, else Hermes's default.
 */
export function parseKanbanCreate(args: unknown, result: unknown, now: number, currentBoard?: string): DispatchedTask | undefined {
  let r = result;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return undefined;
    }
  }
  if (!isObj(r) || r.ok !== true) return undefined;
  const id = str(r.task_id);
  if (!id) return undefined;
  const a = isObj(args) ? args : {};
  return {
    id,
    board: str(a.board) ?? currentBoard ?? "default",
    status: isStatus(r.status) ? r.status : "ready",
    ...(str(a.title) && { title: str(a.title) }),
    ...(str(a.assignee) && { assignee: str(a.assignee) }),
    createdAt: now,
    picked: false,
  };
}

/** A task as the board or the task route lists it, with the session it was created from; none if it isn't one. */
export function parseTask(v: unknown, board: string, now: number): { task: DispatchedTask; sessionId?: string } | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id);
  if (!id || !isStatus(v.status)) return undefined;
  const createdAt = typeof v.created_at === "number" && v.created_at > 0 ? v.created_at * 1000 : now;
  const picked = (typeof v.started_at === "number" && v.started_at > 0) || !!str(v.current_run_id) || (Array.isArray(v.runs) && v.runs.length > 0);
  return {
    task: { id, board, status: v.status, ...(str(v.title) && { title: str(v.title) }), ...(str(v.assignee) && { assignee: str(v.assignee) }), createdAt, picked },
    sessionId: str(v.session_id),
  };
}

/** Whether two tasks are the same as the chat sees them, so an unchanged read keeps the chat's objects. */
export const sameTask = (a: DispatchedTask, b: DispatchedTask) =>
  a.id === b.id && a.board === b.board && a.status === b.status && a.title === b.title && a.assignee === b.assignee && a.createdAt === b.createdAt && a.picked === b.picked && a.overAt === b.overAt;
