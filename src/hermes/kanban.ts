// Hermes's kanban board, as far as the chat list needs it (issue #287): the tasks a chat's replies created, read over
// the dashboard's kanban plugin REST (`plugins/kanban/dashboard/plugin_api.py` at Hermes 0.22.6), under
// `api/plugins/kanban/`, with the dashboard's own sign-in and nothing more. `KanbanApi` makes the reads; `KanbanWatch`
// decides when, keeps what was read, and hands the transport each session's tasks. The task's status on the board
// decides everything; a `status.update` only says which task to read. The Work page (issue #595, ADR 0171) reads and
// changes the current board through the same `KanbanApi`, as the official desktop app's Kanban view does.
import { CapabilityUnsupportedError, RouteMissingError } from "./capabilities";
import { TASK_MEANS, isStale, parseTask, sameTask, type DispatchedTask } from "./dispatched";
import { RefusedError, statusOf, type RestMethod } from "./pipe";
import { isObj, textOrEmpty } from "./values";

export type RestFn = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** A board as `GET boards` lists it. `current`: the one Hermes creates on when a call names none. */
export type KanbanBoard = { slug: string; current: boolean; archived: boolean };

/** A task as read from Hermes, with the session its creating reply ran in (`tasks.session_id`). */
export type SeenTask = { task: DispatchedTask; sessionId?: string };

const BASE = "api/plugins/kanban";

/** A task as the Work page shows it. `body` and `assignee` are empty for none. */
export type BoardTask = {
  id: string;
  title: string;
  body: string;
  assignee: string;
  status: string;
  priority: number;
  tenant?: string;
  /** The latest run's summary: for a blocked task, usually why. The board cuts it to 200 characters; `loadTask` doesn't. */
  summary?: string;
  comments: number;
};
export type BoardColumn = { name: string; tasks: BoardTask[] };
/** The current board, one column per status. `assignees`: the profiles a task can be given to. */
export type Board = { columns: BoardColumn[]; assignees: string[] };
/** The plugin's column catalog: which columns take a drop, and which moves a person may make from each status. */
export type Workflow = { columns: { key: string; label: string; dropTarget: boolean }[]; manual: Record<string, string[]> };
/** `at`: Unix ms. */
export type TaskComment = { id: number; author: string; body: string; at: number };
/** A task's editable fields, for New task and the task sheet's Edit. */
export type TaskFields = { title: string; body: string; priority: number; assignee: string };
/** A move the board may not show yet: the task and the status it left. */
export type PendingMove = { id: string; from: string };

/** The board answered 404: the dashboard has no kanban plugin. */
export class NoKanbanPlugin extends Error {
  constructor() {
    super("The Hermes dashboard has no Kanban plugin. Enable it on the host to see the board here.");
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseBoardTask(v: unknown, column: string): BoardTask[] {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return [];
  return [
    {
      id: v.id,
      title: textOrEmpty(v.title),
      body: textOrEmpty(v.body),
      assignee: textOrEmpty(v.assignee),
      status: typeof v.status === "string" && v.status ? v.status : column,
      priority: typeof v.priority === "number" && Number.isFinite(v.priority) ? v.priority : 0,
      ...(typeof v.tenant === "string" && v.tenant && { tenant: v.tenant }),
      ...(typeof v.latest_summary === "string" && v.latest_summary && { summary: v.latest_summary }),
      comments: typeof v.comment_count === "number" ? v.comment_count : 0,
    },
  ];
}

const parseBoard = (res: unknown): Board => ({
  columns: (isObj(res) && Array.isArray(res.columns) ? res.columns : []).flatMap((c): BoardColumn[] =>
    isObj(c) && typeof c.name === "string" ? [{ name: c.name, tasks: (Array.isArray(c.tasks) ? c.tasks : []).flatMap((t) => parseBoardTask(t, c.name as string)) }] : [],
  ),
  assignees: isObj(res) ? strings(res.assignees) : [],
});

function parseWorkflow(res: unknown): Workflow {
  const columns = (isObj(res) && Array.isArray(res.columns) ? res.columns : []).flatMap((c): Workflow["columns"] =>
    isObj(c) && typeof c.key === "string" ? [{ key: c.key, label: typeof c.label === "string" && c.label ? c.label : c.key, dropTarget: c.drag_target === true }] : [],
  );
  const manual = isObj(res) && isObj(res.manual) ? Object.fromEntries(Object.entries(res.manual).map(([from, to]) => [from, strings(to)])) : {};
  return { columns, manual };
}

const parseComment = (c: unknown): TaskComment[] =>
  isObj(c) && typeof c.id === "number" && typeof c.body === "string"
    ? [{ id: c.id, author: textOrEmpty(c.author), body: c.body, at: typeof c.created_at === "number" ? c.created_at * 1000 : 0 }]
    : [];

const taskPath = (id: string) => `${BASE}/tasks/${encodeURIComponent(id)}`;

/** Whether `wf` lets a person move a task from `from` to `to`. Running is the dispatcher's to set, so it's never offered. */
export const canMove = (wf: Workflow, from: string, to: string) =>
  from !== to && !!wf.columns.find((c) => c.key === to)?.dropTarget && !!wf.manual[from]?.includes(to);

/** What a move must say first: completing needs a summary unless the task comes from review, and blocking needs a reason. */
export const moveNeeds = (from: string, to: string): "summary" | "reason" | undefined =>
  to === "done" && from !== "review" ? "summary" : to === "blocked" ? "reason" : undefined;

/**
 * Whether the board shows `p` done: the task is no longer in the status it left. The dashboard coalesces concurrent
 * board reads, so a read right after a move can still be the old one.
 */
export const moveSettled = (columns: readonly BoardColumn[], p: PendingMove) => !columns.some((c) => c.tasks.some((t) => t.id === p.id && t.status === p.from));

/** Whether a write certainly didn't happen: Hermes refused it (under 500), or it was never sent. Anything else may have landed. */
export const refused = (e: unknown) => {
  const status = statusOf(e);
  return status !== undefined ? status < 500 : e instanceof RefusedError || e instanceof CapabilityUnsupportedError || e instanceof RouteMissingError;
};

/** The fields an edit changes, as the PATCH takes them: an empty assignee unassigns. The title is sent trimmed. */
export function taskEdits(t: BoardTask, f: TaskFields): Partial<TaskFields> {
  const out: Partial<TaskFields> = {};
  if (f.title.trim() !== t.title) out.title = f.title.trim();
  if (f.body !== t.body) out.body = f.body;
  if (f.priority !== t.priority) out.priority = f.priority;
  if (f.assignee !== t.assignee) out.assignee = f.assignee;
  return out;
}

export class KanbanApi {
  constructor(private rest: RestFn) {}

  /** The current board, for the Work page. Archived tasks are left out by the plugin. */
  async loadBoard(): Promise<Board> {
    try {
      return parseBoard(await this.rest("GET", `${BASE}/board`));
    } catch (e) {
      if (statusOf(e) === 404) throw new NoKanbanPlugin();
      throw e;
    }
  }

  async loadWorkflow(): Promise<Workflow> {
    return parseWorkflow(await this.rest("GET", `${BASE}/workflow`));
  }

  /** The full task (the board cuts its summary short) and its comments, oldest first. */
  async loadTask(id: string): Promise<{ task: BoardTask; comments: TaskComment[] }> {
    const res = await this.rest("GET", taskPath(id));
    const task = isObj(res) ? parseBoardTask(res.task, "")[0] : undefined;
    if (!task) throw new Error(`Hermes answered task ${id} with something this app doesn't read.`);
    const comments = (isObj(res) && Array.isArray(res.comments) ? res.comments : []).flatMap(parseComment).sort((a, b) => a.at - b.at || a.id - b.id);
    return { task, comments };
  }

  /**
   * Creates a task; the server picks its column. `key` makes a retry after a lost answer return the same task instead
   * of a second one. `warning`: Hermes's word that nothing will run it, such as no dispatcher.
   */
  async createTask(f: TaskFields, key: string): Promise<{ id?: string; warning?: string }> {
    const body = { title: f.title.trim(), ...(f.body && { body: f.body }), ...(f.assignee && { assignee: f.assignee }), priority: f.priority, idempotency_key: key };
    const res = await this.rest("POST", `${BASE}/tasks`, body);
    const id = isObj(res) && isObj(res.task) && typeof res.task.id === "string" ? res.task.id : undefined;
    const warning = isObj(res) && typeof res.warning === "string" && res.warning ? res.warning : undefined;
    return { id, warning };
  }

  /** Changes only `changes`, and answers the task as saved, when Hermes says. */
  async editTask(id: string, changes: Partial<TaskFields>): Promise<BoardTask | undefined> {
    const res = await this.rest("PATCH", taskPath(id), changes);
    return isObj(res) ? parseBoardTask(res.task, "")[0] : undefined;
  }

  async addComment(id: string, body: string): Promise<void> {
    await this.rest("POST", `${taskPath(id)}/comments`, { body });
  }

  /**
   * Moves a task to another column. A block also leaves a `BLOCKED: <reason>` comment, as the CLI does, once the block
   * is accepted. If that comment fails the move still stands, so it comes back as a warning.
   */
  async moveTask(id: string, to: string, text = ""): Promise<string | undefined> {
    const said = text.trim();
    const body = to === "done" && said ? { status: to, result: said, summary: said } : to === "blocked" && said ? { status: to, block_reason: said } : { status: to };
    await this.rest("PATCH", taskPath(id), body);
    if (to !== "blocked" || !said) return undefined;
    try {
      await this.addComment(id, `BLOCKED: ${said}`);
      return undefined;
    } catch (e) {
      return `Blocked ${id}, but its BLOCKED: comment wasn't saved: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async boards(): Promise<{ boards: KanbanBoard[]; current?: string }> {
    const res = await this.rest("GET", `${BASE}/boards`);
    const rows = isObj(res) && Array.isArray(res.boards) ? res.boards : [];
    const boards = rows.flatMap((b): KanbanBoard[] => (isObj(b) && typeof b.slug === "string" && b.slug ? [{ slug: b.slug, current: b.is_current === true, archived: b.archived === true }] : []));
    const current = isObj(res) && typeof res.current === "string" && res.current ? res.current : boards.find((b) => b.current)?.slug;
    return { boards, current };
  }

  /** Every task on the board, or undefined when the board is gone. */
  async board(slug: string, now: number): Promise<SeenTask[] | undefined> {
    let res: unknown;
    try {
      res = await this.rest("GET", `${BASE}/board?${new URLSearchParams({ board: slug })}`);
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
    const columns = isObj(res) && Array.isArray(res.columns) ? res.columns : [];
    return columns.flatMap((col) => (isObj(col) && Array.isArray(col.tasks) ? col.tasks : [])).flatMap((t) => parseTask(t, slug, now) ?? []);
  }

  /** One task, or undefined when it is gone. */
  async task(slug: string, id: string, now: number): Promise<SeenTask | undefined> {
    let res: unknown;
    try {
      res = await this.rest("GET", `${BASE}/tasks/${encodeURIComponent(id)}?${new URLSearchParams({ board: slug })}`);
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
    // The detail carries the runs beside the task.
    return isObj(res) && isObj(res.task) ? parseTask({ runs: res.runs, ...res.task }, slug, now) : undefined;
  }
}

/** Boards are read this often: the default board is hundreds of kilobytes. */
export const SCAN_EVERY_MS = 5 * 60_000;
/** Each tracked task not over is read this often. */
export const POLL_EVERY_MS = 30_000;
/** An over task is forgotten this long after the app saw it over, if no turn started in its chat before then. */
const OVER_KEPT_MS = 5 * 60_000;

export type KanbanWatchDeps = {
  api: Pick<KanbanApi, "boards" | "board" | "task">;
  /** The shown profile's chat ids and lineage segment ids, which a task's `session_id` is matched against. */
  sessions: () => ReadonlySet<string>;
  /** Each session's tasks, every time they change. */
  publish: (bySession: ReadonlyMap<string, readonly DispatchedTask[]>) => void;
  now?: () => number;
};

/**
 * Keeps the dispatched tasks of the shown profile's chats, by reading Hermes's boards and tasks while connected:
 * every board once the chat list has loaded and then every `SCAN_EVERY_MS`, each tracked task not over every
 * `POLL_EVERY_MS`, and a task at once when a `status.update` names it. A task that is gone (404, or its board is) is
 * dropped. Any other failed read keeps what was last seen. Between `stop` and the next `start` nothing is read and
 * the tasks are kept, so the chat list shows them as last seen.
 */
export class KanbanWatch {
  private tracked = new Map<string, SeenTask>();
  private current?: string;
  private running = false;
  /** Bumped by `stop` and `reset`, so a read that started before doesn't land after. */
  private epoch = 0;
  private scanned = false;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private readonly now: () => number;

  constructor(private deps: KanbanWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The board Hermes creates on when a `kanban_create` names none, as last read. */
  currentBoard(): string | undefined {
    return this.current;
  }

  /** Connected: reads begin. The boards are read once `chatsListed` says the chat list is in. */
  start() {
    if (this.running) return;
    this.running = true;
    this.scanned = false;
    this.schedule();
  }

  /** Disconnected: no more reads; the tasks stay as last seen. */
  stop() {
    this.running = false;
    this.epoch++;
    clearTimeout(this.scanTimer);
    clearTimeout(this.pollTimer);
    this.scanTimer = this.pollTimer = undefined;
  }

  /** Another profile's chats are shown: nothing read so far applies. */
  reset() {
    this.stop();
    this.tracked.clear();
    this.current = undefined;
    this.publish();
  }

  /** The chat list has loaded, so the boards can be matched against it: the first time after `start`, they are read. */
  chatsListed() {
    if (!this.running) return;
    if (!this.scanned) void this.scan();
    else this.publish();
  }

  /** A `kanban_create` in `sessionId`'s chat made `task`: tracked from now, before any read. */
  add(task: DispatchedTask, sessionId: string) {
    this.tracked.set(task.id, { task, sessionId });
    this.publish();
  }

  /** A `status.update` of kind `process`: one naming a tracked task (`Kanban t_…`) has it read now. */
  nudge(text: string) {
    const id = /\bKanban (t_[\w-]+)/.exec(text)?.[1];
    if (id && this.running && this.tracked.has(id)) void this.read(id);
  }

  /** A turn started in a chat with these session ids: the wake turn took over from its over tasks. */
  turnStarted(sessionIds: readonly string[]) {
    let dropped = false;
    for (const [id, { task, sessionId }] of this.tracked)
      if (sessionId && sessionIds.includes(sessionId) && TASK_MEANS[task.status] === "over") {
        this.tracked.delete(id);
        dropped = true;
      }
    if (dropped) this.publish();
  }

  private schedule() {
    clearTimeout(this.pollTimer);
    this.armScan();
    this.pollTimer = setTimeout(() => void this.poll(), POLL_EVERY_MS);
  }

  /** The next board scan, `SCAN_EVERY_MS` from now, in place of any already due. */
  private armScan() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => void this.scan(), SCAN_EVERY_MS);
  }

  private scan(): Promise<void> {
    if (!this.running) return Promise.resolve();
    const epoch = this.epoch;
    return (this.scanning ??= this.scanOnce(epoch).finally(() => {
      this.scanning = undefined;
      if (epoch === this.epoch && this.running) this.armScan();
    }));
  }

  private async scanOnce(epoch: number) {
    this.scanned = true;
    const trackedBeforeScan = new Set(this.tracked.keys());
    let boards: KanbanBoard[];
    try {
      const read = await this.deps.api.boards();
      if (epoch !== this.epoch) return;
      boards = read.boards.filter((b) => !b.archived);
      this.current = read.current;
    } catch {
      return;
    }
    const now = this.now();
    const seen = new Map<string, SeenTask>();
    const readBoards = new Set<string>();
    for (const b of boards) {
      let tasks: SeenTask[] | undefined;
      try {
        tasks = await this.deps.api.board(b.slug, now);
      } catch {
        continue;
      }
      if (epoch !== this.epoch) return;
      if (!tasks) continue;
      readBoards.add(b.slug);
      for (const t of tasks) seen.set(t.task.id, t);
    }
    const sessions = this.deps.sessions();
    let changed = false;
    for (const [id, was] of this.tracked) {
      const is = seen.get(id);
      if (is) changed = this.merge(was, is, now) || changed;
      else if (!trackedBeforeScan.has(id)) continue;
      else if (readBoards.has(was.task.board) || !boards.some((b) => b.slug === was.task.board)) {
        this.tracked.delete(id);
        changed = true;
      }
    }
    for (const [id, t] of seen)
      if (!this.tracked.has(id) && t.sessionId && sessions.has(t.sessionId) && TASK_MEANS[t.task.status] !== "over" && !isStale(t.task, now)) {
        this.tracked.set(id, t);
        changed = true;
      }
    if (changed) this.publish();
  }

  private async poll() {
    const epoch = this.epoch;
    const now = this.now();
    let changed = false;
    for (const [id, { task }] of [...this.tracked]) {
      if (TASK_MEANS[task.status] === "over") {
        if (task.overAt !== undefined && now - task.overAt > OVER_KEPT_MS) {
          this.tracked.delete(id);
          changed = true;
        }
        continue;
      }
      if (!this.running) return;
      changed = (await this.read(id, false)) || changed;
    }
    if (changed) this.publish();
    if (epoch === this.epoch && this.running) this.pollTimer = setTimeout(() => void this.poll(), POLL_EVERY_MS);
  }

  /** Reads one tracked task. Resolves to whether it changed, having published it when `publish`. */
  private async read(id: string, publish = true): Promise<boolean> {
    const was = this.tracked.get(id);
    if (!was) return false;
    const epoch = this.epoch;
    let is: SeenTask | undefined;
    try {
      is = await this.deps.api.task(was.task.board, id, this.now());
    } catch {
      return false;
    }
    if (epoch !== this.epoch || this.tracked.get(id) !== was) return false;
    let changed: boolean;
    if (is) changed = this.merge(was, is, this.now());
    else {
      this.tracked.delete(id);
      changed = true;
    }
    if (changed && publish) this.publish();
    return changed;
  }

  /** Takes what a read says about a tracked task, keeping its session and stamping when it was first seen over. */
  private merge(was: SeenTask, is: SeenTask, now: number): boolean {
    const over = TASK_MEANS[is.task.status] === "over";
    const task: DispatchedTask = { ...is.task, ...(over && { overAt: was.task.overAt ?? now }) };
    if (sameTask(was.task, task) && (is.sessionId ?? was.sessionId) === was.sessionId) return false;
    this.tracked.set(task.id, { task, sessionId: is.sessionId ?? was.sessionId });
    return true;
  }

  private publish() {
    const by = new Map<string, DispatchedTask[]>();
    for (const { task, sessionId } of this.tracked.values()) if (sessionId) by.set(sessionId, [...(by.get(sessionId) ?? []), task]);
    for (const tasks of by.values()) tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    this.deps.publish(by);
  }
}
