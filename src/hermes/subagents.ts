import { nonBlankText } from "./values";
// The Subagents a chat's reply started (Hermes's `delegate_task`), as one tree per chat on this connection (ADR 0072).
// Hermes reports them two ways: `subagent.*` events on the chat's session while they run
// (`tui_gateway/contracts/events.py` SubagentEventPayload), and `subagent.list`, its live roster plus recently failed
// background delegations (`tui_gateway/methods_subagents.py`). Both go through the pure functions here, so events in any
// order, repeats, and a reconnect's roster all end in the same tree. Nothing here is kept on this computer.

export type SubagentId = string & { readonly __subagent: unique symbol };

/**
 * Hermes's own lifecycle (`SubagentStatus`), plus two of the app's. `ended`: it ended, but the app doesn't know how, as
 * when Hermes's completion named no status it defines, or it ended unheard while the app was disconnected. `unknown`: a
 * subagent the app knows only as the parent of one it heard from.
 */
export type SubagentState = "queued" | "running" | "completed" | "failed" | "error" | "timeout" | "interrupted" | "ended" | "unknown";

const HERMES_STATES = new Set<string>(["queued", "running", "completed", "failed", "error", "timeout", "interrupted"]);
const ENDED = new Set<SubagentState>(["completed", "failed", "error", "timeout", "interrupted", "ended"]);
/** It ended: no later event or roster brings it back. Only Hermes's own word on how can replace `ended`. */
export const hasEnded = (s: SubagentState) => ENDED.has(s);
export const isFailure = (s: SubagentState) => s === "failed" || s === "error" || s === "timeout";

/** One thing a subagent did. `seq`: its tool call's number, which Hermes counts per subagent. */
export type SubagentActivity =
  | { kind: "tool"; at: number; seq?: number; tool: string; preview?: string }
  | { kind: "ended"; at: number; text: string };

export type Subagent = {
  id: SubagentId;
  /** The subagent that started it; none for one the chat's own reply started. */
  parent?: SubagentId;
  depth: number;
  /** Its goal, as the agent that started it wrote it. Empty while only its own subagents have been heard from. */
  goal: string;
  model?: string;
  /** Its `delegate_task` call, shared by the subagents one call started, and its place among them. */
  delegationId?: string;
  taskIndex?: number;
  taskCount?: number;
  state: SubagentState;
  startedAt?: number;
  /**
   * When the app last heard of it doing something, and what. `seq`: how many tool calls Hermes had counted for it by
   * then (0 at its start), which orders what the events and the roster say however late each arrives.
   */
  lastActivity?: { at: number; text: string; seq?: number };
  toolCount?: number;
  /** Hermes takes a steer for it now. Only `subagent.list` says; undefined until it has. */
  acceptingSteer?: boolean;
  /** How it ended, in Hermes's words: its summary, or the error. */
  summary?: string;
  durationS?: number;
  /** What it did that the app heard of, oldest first, at most `ACTIVITY_MAX`. */
  activity: SubagentActivity[];
  /** The app heard of it only part way: what it did before isn't in `activity`. */
  partial?: boolean;
  /** Known only from Hermes's store of failed background delegations: there's no running subagent to steer or stop. */
  stored?: boolean;
  /** When an event about it last arrived. */
  heardAt?: number;
};

/**
 * Whether the tree is current. `live`: this connection hears its events, and Hermes's roster agreed. `lost`: the
 * connection dropped at `since`, so states are as last heard. `unchecked`: connected again, but Hermes couldn't say what
 * happened meanwhile (`why`).
 */
export type SubagentSync = { kind: "live" } | { kind: "lost"; since: number } | { kind: "unchecked"; why: string };

export type SubagentTree = { subagents: Subagent[]; sync: SubagentSync };

export const ACTIVITY_MAX = 200;
export const SUBAGENTS_MAX = 100;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** A Hermes time (Unix seconds) in ms. */
const secondsAt = (v: unknown) => {
  const s = num(v);
  return s !== undefined && s > 0 && s * 1000 <= 8.64e15 ? s * 1000 : undefined;
};

/**
 * The id an event names it by. An older Hermes sends no `subagent_id`; its subagents are told apart by their
 * `delegate_task` call and place in it, and can't be steered or stopped, since Hermes has no id to take.
 */
function idOf(p: Record<string, unknown>): SubagentId | undefined {
  const id = nonBlankText(p.subagent_id);
  if (id) return id as SubagentId;
  const index = int(p.task_index);
  return index === undefined ? undefined : (`task:${nonBlankText(p.delegation_id) ?? ""}:${index}` as SubagentId);
}
export const isSteerable = (s: Subagent) => !s.stored && !s.id.startsWith("task:");

/** Hermes's `status`, as this app's state; `fallback` for a status Hermes doesn't define. */
function stateOf(v: unknown, fallback: SubagentState): SubagentState {
  const s = nonBlankText(v)?.toLowerCase();
  return s && HERMES_STATES.has(s) ? (s as SubagentState) : fallback;
}

/** What an event or roster row says about a subagent, before it meets the tree. */
type Report = Partial<Omit<Subagent, "id" | "activity">> & { id: SubagentId; activity?: SubagentActivity };

function identity(p: Record<string, unknown>, id: SubagentId): Report {
  const parent = nonBlankText(p.parent_id);
  return {
    id,
    ...(parent && { parent: parent as SubagentId }),
    ...(int(p.depth) !== undefined && { depth: int(p.depth) }),
    ...(nonBlankText(p.goal) && { goal: nonBlankText(p.goal)!.trim() }),
    ...(nonBlankText(p.model) && { model: nonBlankText(p.model) }),
    ...(nonBlankText(p.delegation_id) && { delegationId: nonBlankText(p.delegation_id) }),
    ...(int(p.task_index) !== undefined && { taskIndex: int(p.task_index) }),
    ...(int(p.task_count) !== undefined && { taskCount: int(p.task_count) }),
    ...(int(p.tool_count) !== undefined && { toolCount: int(p.tool_count) }),
  };
}

/** One `subagent.*` event as a report, or none for one this app doesn't follow or can't place. */
function eventReport(type: string, payload: unknown, at: number): Report | undefined {
  const p = obj(payload);
  const id = p && idOf(p);
  if (!p || !id) return undefined;
  const base = identity(p, id);
  switch (type) {
    case "subagent.spawn_requested":
      return { ...base, state: "queued", partial: false };
    case "subagent.start":
      return { ...base, state: "running", partial: false, startedAt: at, lastActivity: { at, text: "Started", seq: 0 } };
    // Batched tool names, which `subagent.tool` has already reported one by one.
    case "subagent.progress":
      return { ...base, state: "running" };
    case "subagent.tool": {
      const tool = nonBlankText(p.tool_name) ?? "tool";
      const preview = nonBlankText(p.tool_preview) ?? nonBlankText(p.text);
      const seq = int(p.tool_count);
      return {
        ...base,
        state: "running",
        lastActivity: { at, text: preview ? `${tool}: ${preview}` : tool, ...(seq !== undefined && { seq }) },
        activity: { kind: "tool", at, tool, ...(seq !== undefined && { seq }), ...(preview && { preview }) },
      };
    }
    // Hermes's spinner lines and the child's reasoning, which can't be told apart, so only that it runs. Its live
    // transcript (`subagent.tail`) has the reasoning.
    case "subagent.thinking":
      return { ...base, state: "running" };
    case "subagent.complete": {
      // A completion without a status Hermes defines says it ended, not how.
      const reported = stateOf(p.status, "ended");
      const state = hasEnded(reported) ? reported : "ended";
      const summary = nonBlankText(p.summary)?.trim();
      return {
        ...base,
        state,
        ...(summary && { summary }),
        ...(num(p.duration_seconds) !== undefined && { durationS: num(p.duration_seconds) }),
        lastActivity: { at, text: ENDED_TEXT[state] ?? "Ended" },
        activity: { kind: "ended", at, text: ENDED_TEXT[state] ?? "Ended" },
      };
    }
    default:
      return undefined;
  }
}

const ENDED_TEXT: Partial<Record<SubagentState, string>> = {
  completed: "Finished",
  failed: "Failed",
  error: "Failed with an error",
  timeout: "Timed out",
  interrupted: "Stopped",
  ended: "Ended",
};

const UNHEARD = "Ended while the app wasn't listening";

const blank = (id: SubagentId): Subagent => ({ id, depth: 0, goal: "", state: "unknown", activity: [] });

/**
 * Keeps the activity in order, once each: a tool call Hermes numbered goes in its place, a repeat is dropped, and
 * the end stays last, since anything heard after it happened before it.
 */
function withActivity(log: SubagentActivity[], a: SubagentActivity): SubagentActivity[] {
  const end = log.findIndex((x) => x.kind === "ended");
  if (a.kind === "ended") return end >= 0 ? log : [...log, a].slice(-ACTIVITY_MAX);
  if (a.kind === "tool" && a.seq !== undefined && log.some((x) => x.kind === "tool" && x.seq === a.seq)) return log;
  const later = a.kind === "tool" && a.seq !== undefined ? log.findIndex((x) => x.kind === "tool" && x.seq !== undefined && x.seq > a.seq!) : -1;
  const at = later >= 0 ? later : end >= 0 ? end : log.length;
  return [...log.slice(0, at), a, ...log.slice(at)].slice(-ACTIVITY_MAX);
}

/**
 * The state after a report. Once Hermes has said how it ended, nothing later changes it, so a late event from before
 * the end can't bring it back. Queued is the earliest state, so a request heard after the start doesn't undo it.
 */
function nextState(was: SubagentState, reported?: SubagentState): SubagentState {
  if (!reported) return was;
  if (hasEnded(was)) return was === "ended" && hasEnded(reported) ? reported : was;
  if (reported === "queued") return was === "unknown" ? "queued" : was;
  return reported;
}

/**
 * A subagent with a report applied. What it last did only moves forward: once it ended, its end stays its last
 * activity, and what Hermes had counted fewer tool calls for than the last activity known is old news, such as a late
 * start or a tool call the roster has already counted past. Its tool count never goes down.
 */
function merged(s: Subagent, r: Report): Subagent {
  const { activity, state, lastActivity, toolCount, ...fields } = r;
  const next = nextState(s.state, state);
  const endsNow = hasEnded(next) && next !== s.state;
  const seq = lastActivity?.seq;
  const fresh = endsNow || (!hasEnded(s.state) && (seq === undefined || seq >= (s.lastActivity?.seq ?? -1)));
  // A known outcome replaces the "ended" the app had put in its place.
  const log = endsNow && s.state === "ended" ? s.activity.filter((a) => a.kind !== "ended") : s.activity;
  return {
    ...s,
    ...fields,
    // The first word of when it started stands: its start event as heard, or the roster's time, whichever came first.
    ...(s.startedAt !== undefined && { startedAt: s.startedAt }),
    state: next,
    toolCount: toolCount === undefined ? s.toolCount : Math.max(toolCount, s.toolCount ?? 0),
    lastActivity: lastActivity && (!s.lastActivity || fresh) ? lastActivity : s.lastActivity,
    activity: activity ? withActivity(log, activity) : log,
  };
}

/** The tree with `reports` applied, in the order the app first heard of each subagent, at most `SUBAGENTS_MAX`. */
function applied(tree: SubagentTree | undefined, reports: Report[], fresh: (r: Report) => Partial<Subagent> = () => ({})): SubagentTree {
  const subagents = [...(tree?.subagents ?? [])];
  const at = new Map(subagents.map((s, i) => [s.id, i]));
  const place = (id: SubagentId, make: () => Subagent) => {
    if (!at.has(id)) {
      at.set(id, subagents.length);
      subagents.push(make());
    }
    return at.get(id)!;
  };
  for (const r of reports) {
    // A subagent heard from before the one that started it: the parent shows, undescribed, until it is.
    if (r.parent) place(r.parent, () => ({ ...blank(r.parent!), depth: Math.max(0, (r.depth ?? 1) - 1), partial: true }));
    const i = place(r.id, () => ({ ...blank(r.id), ...fresh(r) }));
    subagents[i] = merged(subagents[i], r);
  }
  return { subagents: bounded(subagents), sync: tree?.sync ?? { kind: "live" } };
}

/** Lets go of the subagents first heard of longest ago that have ended, past `SUBAGENTS_MAX`, and their ended children. */
function bounded(subagents: Subagent[]): Subagent[] {
  let extra = subagents.length - SUBAGENTS_MAX;
  if (extra <= 0) return subagents;
  const drop = new Set<SubagentId>();
  for (const s of subagents) {
    if (extra <= 0) break;
    if (hasEnded(s.state) && !subagents.some((c) => c.parent === s.id && !hasEnded(c.state) && !drop.has(c.id))) {
      drop.add(s.id);
      extra--;
    }
  }
  return subagents.filter((s) => !drop.has(s.id));
}

/** The tree with one `subagent.*` event applied; the tree as it was for an event this app doesn't follow. */
export function onSubagentEvent(tree: SubagentTree | undefined, type: string, payload: unknown, at: number): SubagentTree | undefined {
  const r = eventReport(type, payload, at);
  // One first heard of after it started has done things the app didn't hear, until its start turns up.
  return r ? applied(tree, [{ ...r, heardAt: at }], () => ({ partial: true })) : tree;
}

/**
 * The tree with Hermes's roster (`subagent.list`) applied, now `live`. Hermes lists the subagents still running, and
 * background delegations that failed lately. After a drop, a running or queued subagent the roster leaves out has ended
 * without the app hearing how, so it's `ended`, unless an event about it arrived after the roster was asked for
 * (`askedAt`). The roster is also how the app hears of a nested subagent's tools: Hermes relays only
 * its start and end (`delegate_tool_progress._normalize_event` drops the rest). Undefined when there's no tree and
 * nothing listed.
 */
export function onRoster(tree: SubagentTree | undefined, result: unknown, at: number, askedAt = at): SubagentTree | undefined {
  const res = obj(result);
  const rows = Array.isArray(res?.subagents) ? res.subagents.map(obj).filter((r) => !!r) : [];
  const failed = Array.isArray(res?.delegations) ? res.delegations.map(obj).filter((r) => !!r) : [];
  const listed: Report[] = [];
  for (const row of rows) {
    const id = nonBlankText(row.subagent_id);
    if (!id) continue;
    const last = nonBlankText(row.last_tool);
    const was = tree?.subagents.find((s) => s.id === id);
    // Only the tool's name: it replaces what the events said only when it is news, by Hermes's count of its tools.
    const newer = !was?.lastActivity || (int(row.tool_count) ?? 0) > (was.toolCount ?? 0);
    listed.push({
      ...identity(row, id as SubagentId),
      state: stateOf(row.status, "running"),
      ...(secondsAt(row.started_at) !== undefined && { startedAt: secondsAt(row.started_at) }),
      ...(typeof row.accepting_steer === "boolean" && { acceptingSteer: row.accepting_steer }),
      ...(last && newer && { lastActivity: { at, text: last, ...(int(row.tool_count) !== undefined && { seq: int(row.tool_count) }) } }),
    });
  }
  const known = tree?.subagents ?? [];
  const failures: Report[] = [];
  for (const row of failed) {
    const index = int(row.task_index);
    const delegationId = nonBlankText(row.delegation_id);
    // The live subagent this failure was, when both name its place in the call; otherwise it stands on its own. The
    // roster's live rows carry no task index, so a subagent known only from them never matches.
    const match = delegationId && index !== undefined && known.find((s) => s.delegationId === delegationId && s.taskIndex === index);
    const error = nonBlankText(row.error)?.trim();
    const ended = secondsAt(row.completed_at) ?? at;
    failures.push({
      ...(match ? { id: match.id } : { ...identity(row, `task:${delegationId ?? ""}:${index ?? 0}` as SubagentId), stored: true }),
      state: stateOf(row.status, "failed"),
      ...(error && { summary: error }),
      ...(!match && secondsAt(row.dispatched_at) !== undefined && { startedAt: secondsAt(row.dispatched_at) }),
      lastActivity: { at: ended, text: "Failed" },
      activity: { kind: "ended", at: ended, text: "Failed" },
    });
  }
  if (!tree && !listed.length && !failures.length) return undefined;
  const ids = new Set([...listed, ...failures].map((r) => r.id));
  // Only after a drop is a missing one news: while connected throughout, its end comes as an event, and a roster read
  // just before it started (or, queued, before Hermes registers it) leaves it out without meaning anything.
  const recovering = tree?.sync.kind !== "live";
  const gone: Report[] = recovering
    ? known
        .filter((s) => (s.state === "running" || s.state === "queued") && !ids.has(s.id) && (s.heardAt ?? 0) < askedAt)
        .map((s): Report => ({ id: s.id, state: "ended", lastActivity: { at, text: UNHEARD }, activity: { kind: "ended", at, text: UNHEARD } }))
    : [];
  // One the roster brings that the app hadn't heard of was running before the app could hear it.
  const next = applied(tree, [...listed, ...failures, ...gone], (r) => (r.stored ? {} : { partial: true }));
  return { ...next, sync: { kind: "live" } };
}

/** The connection dropped: the tree stays as last heard until Hermes's roster can be read again. */
export function onLost(tree: SubagentTree | undefined, since: number): SubagentTree | undefined {
  if (!tree || tree.sync.kind === "lost") return tree;
  return { ...tree, sync: { kind: "lost", since } };
}

/** Connected again, but Hermes's roster couldn't be read: the tree's states are as last heard, for `why`. */
export function onUnchecked(tree: SubagentTree | undefined, why: string): SubagentTree | undefined {
  return tree && { ...tree, sync: { kind: "unchecked", why } };
}

/** The subagents `parent` started, or those the chat's reply started for none, in the order first heard of. */
export function childrenOf(tree: SubagentTree, parent?: SubagentId): Subagent[] {
  const ids = new Set(tree.subagents.map((s) => s.id));
  // One whose parent isn't in the tree (let go past the limit) shows at the top rather than not at all.
  return tree.subagents.filter((s) => (parent === undefined ? !s.parent || !ids.has(s.parent) : s.parent === parent));
}

/** Every subagent under `id`, at any depth. */
export function descendantsOf(tree: SubagentTree, id: SubagentId): Subagent[] {
  const out: Subagent[] = [];
  const seen = new Set<SubagentId>([id]);
  for (const parents = [id]; parents.length; ) {
    const p = parents.shift();
    for (const c of tree.subagents)
      if (c.parent === p && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
        parents.push(c.id);
      }
  }
  return out;
}

/** How many are queued or running, and how many failed. */
export function tally(tree: SubagentTree): { running: number; failed: number; total: number } {
  let running = 0;
  let failed = 0;
  for (const s of tree.subagents) {
    if (s.state === "running" || s.state === "queued") running++;
    if (isFailure(s.state)) failed++;
  }
  return { running, failed, total: tree.subagents.length };
}

/** `subagent.tail`: the end of the subagent's live transcript, which Hermes shares only for one it runs for this connection. */
export type SubagentOutput = { available: true; text: string; truncated: boolean } | { available: false };

export function parseOutput(result: unknown): SubagentOutput {
  const r = obj(result);
  if (r?.available !== true || typeof r.text !== "string") return { available: false };
  return { available: true, text: r.text, truncated: r.truncated === true };
}
