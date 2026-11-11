// Hermes's kanban board, as far as the chat list needs it (issue #287): the tasks a chat's replies created, read over
// the dashboard's kanban plugin REST (`plugins/kanban/dashboard/plugin_api.py` at Hermes 0.22.6), under
// `api/plugins/kanban/`, with the dashboard's own sign-in and nothing more. `KanbanApi` makes the reads; `KanbanWatch`
// decides when, keeps what was read, and hands the transport each session's tasks. The task's status on the board
// decides everything; a `status.update` only says which task to read.
import { TASK_MEANS, isStale, parseTask, sameTask, type DispatchedTask } from "./dispatched";
import { statusOf, type RestMethod } from "./pipe";
import { isObj } from "./values";

export type RestFn = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** A board as `GET boards` lists it. `current`: the one Hermes creates on when a call names none. */
export type KanbanBoard = { slug: string; current: boolean; archived: boolean };

/** A task as read from Hermes, with the session its creating reply ran in (`tasks.session_id`). */
export type SeenTask = { task: DispatchedTask; sessionId?: string };

const BASE = "api/plugins/kanban";

export class KanbanApi {
  constructor(private rest: RestFn) {}

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
