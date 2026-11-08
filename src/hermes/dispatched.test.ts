import { describe, expect, it } from "vitest";
import {
  KANBAN_STATUSES,
  STALE_UNPICKED_MS,
  STALLED_MS,
  TASK_MEANS,
  WAKE_GRACE_MS,
  handoffOf,
  handoffs,
  nextHandoffChange,
  outstandingIds,
  parseKanbanCreate,
  parseTask,
  waitingLabel,
  type DispatchedTask,
  type KanbanStatus,
} from "./dispatched";
import type { Chat } from "./model";
import { onSubagentEvent, type SubagentTree } from "./subagents";

const NOW = Date.parse("2026-11-07T10:00:00Z");
const MINUTE = 60_000;

const task = (id: string, status: KanbanStatus, over: Partial<DispatchedTask> = {}): DispatchedTask => ({ id, board: "default", status, createdAt: NOW - MINUTE, picked: false, ...over });
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW, items: [], ...over });
const started = (tree: SubagentTree | undefined, id: string) => onSubagentEvent(tree, "subagent.start", { subagent_id: id, goal: `Goal ${id}`, depth: 0 }, NOW);
const ended = (tree: SubagentTree | undefined, id: string) => onSubagentEvent(tree, "subagent.complete", { subagent_id: id, status: "completed" }, NOW);

describe("what each task status means for the chat", () => {
  it.each(KANBAN_STATUSES)("%s", (status) => {
    const seen = (overAt: number) => handoffOf(chat("c", { tasks: [task("t", status, { overAt })] }), undefined, NOW)?.kind;
    const means = TASK_MEANS[status];
    if (means === "needsOwner") expect([seen(NOW), seen(NOW - WAKE_GRACE_MS)]).toEqual(["needsOwner", "needsOwner"]);
    else if (means === "outstanding") expect([seen(NOW), seen(NOW - WAKE_GRACE_MS)]).toEqual(["waiting", "waiting"]);
    else expect([seen(NOW), seen(NOW - WAKE_GRACE_MS)]).toEqual(["waiting", undefined]);
  });

  it("says why a task needs the owner, and lets that win over work still waiting", () => {
    const blocked = handoffOf(chat("c", { tasks: [task("a", "running"), task("b", "blocked")] }), undefined, NOW);
    expect(blocked).toEqual({ kind: "needsOwner", task: task("b", "blocked"), reason: "A dispatched task is blocked." });
    const review = handoffOf(chat("c", { tasks: [task("b", "review")], subagents: started(undefined, "s1") }), undefined, NOW);
    expect(review).toMatchObject({ kind: "needsOwner", reason: "A dispatched task is waiting for review." });
  });
});

describe("a chat's handoff", () => {
  it("is nothing when the chat dispatched nothing, or everything it dispatched has ended", () => {
    expect(handoffOf(chat("c"), undefined, NOW)).toBeUndefined();
    expect(handoffOf(chat("c", { tasks: [] }), undefined, NOW)).toBeUndefined();
    const done = ended(started(undefined, "s1"), "s1");
    expect(handoffOf(chat("c", { subagents: done }), undefined, NOW + WAKE_GRACE_MS)).toBeUndefined();
    expect(handoffOf(chat("c", { subagents: done, updatedAt: NOW + 1 }), undefined, NOW + 1)).toBeUndefined();
  });

  it("waits out the wake grace after the last background subagent ends, unless the chat has moved on since", () => {
    const done = ended(ended(started(started(undefined, "s1"), "s2"), "s1"), "s2");
    expect(handoffOf(chat("c", { subagents: done }), undefined, NOW + WAKE_GRACE_MS - 1)).toEqual({ kind: "waiting", tasks: [], subagents: 2, stalled: false });
    expect(handoffOf(chat("c", { subagents: done }), new Set(["s1", "s2"]), NOW)).toBeUndefined();
    expect(nextHandoffChange([chat("c", { subagents: done })], {}, NOW)).toBe(NOW + WAKE_GRACE_MS);
    const oneLeft = ended(started(started(undefined, "s1"), "s2"), "s1");
    expect(handoffOf(chat("c", { subagents: oneLeft }), undefined, NOW)).toMatchObject({ subagents: 1 });
  });

  it("counts outstanding tasks and the subagents still at work", () => {
    const tree = started(started(undefined, "s1"), "s2");
    expect(handoffOf(chat("c", { tasks: [task("t", "ready")], subagents: tree }), undefined, NOW)).toEqual({ kind: "waiting", tasks: [task("t", "ready")], subagents: 2, stalled: false });
  });

  it("leaves subagents to the running reply while it runs", () => {
    expect(handoffOf(chat("c", { running: true, subagents: started(undefined, "s1") }), undefined, NOW)).toBeUndefined();
  });

  it("ignores the ids the owner stopped waiting on, and counts newer work again", () => {
    const tree = started(started(undefined, "s1"), "s2");
    const c = chat("c", { tasks: [task("t1", "ready"), task("t2", "ready")], subagents: tree });
    expect(handoffOf(c, new Set(["t1", "s1"]), NOW)).toEqual({ kind: "waiting", tasks: [task("t2", "ready")], subagents: 1, stalled: false });
    expect(handoffOf(c, new Set(["t1", "t2", "s1", "s2"]), NOW)).toBeUndefined();
    expect(handoffOf(chat("c", { tasks: [task("t1", "blocked")] }), new Set(["t1"]), NOW)).toBeUndefined();
  });

  it("drops a task nobody picked up in 7 days, and keeps one a worker has", () => {
    const old = NOW - STALE_UNPICKED_MS - 1;
    expect(handoffOf(chat("c", { tasks: [task("t", "ready", { createdAt: old })] }), undefined, NOW)).toBeUndefined();
    expect(handoffOf(chat("c", { tasks: [task("t", "running", { createdAt: old, picked: true })] }), undefined, NOW)).toMatchObject({ kind: "waiting" });
    expect(handoffOf(chat("c", { tasks: [task("t", "ready", { createdAt: NOW - STALE_UNPICKED_MS + 1 })] }), undefined, NOW)).toMatchObject({ kind: "waiting" });
  });

  it("keeps waiting on an over task only through the wake grace", () => {
    const over = (overAt?: number) => handoffOf(chat("c", { tasks: [task("t", "done", { overAt })] }), undefined, NOW);
    expect(over(NOW - WAKE_GRACE_MS + 1)).toMatchObject({ kind: "waiting", tasks: [{ id: "t" }] });
    expect(over(NOW - WAKE_GRACE_MS)).toBeUndefined();
    expect(over(undefined)).toBeUndefined();
  });

  it("says a ready task is stalled once no worker has picked it up in 10 minutes", () => {
    const fresh = handoffOf(chat("c", { tasks: [task("t", "ready", { createdAt: NOW - STALLED_MS })] }), undefined, NOW);
    expect(fresh).toMatchObject({ stalled: false });
    const stalled = handoffOf(chat("c", { tasks: [task("t", "ready", { createdAt: NOW - STALLED_MS - 1 })] }), undefined, NOW);
    expect(stalled).toMatchObject({ stalled: true });
    expect(handoffOf(chat("c", { tasks: [task("t", "running", { createdAt: NOW - STALLED_MS - 1, picked: true })] }), undefined, NOW)).toMatchObject({ stalled: false });
  });

  it("is worked out for every chat at once, by the chat's own stops", () => {
    const chats = [chat("a", { tasks: [task("t1", "ready")] }), chat("b", { tasks: [task("t2", "ready")] }), chat("quiet")];
    const map = handoffs(chats, { a: ["t1"] }, NOW);
    expect([...map.keys()]).toEqual(["b"]);
  });
});

describe("the waiting label", () => {
  const waiting = (tasks: number, subagents: number, stalled = false) => waitingLabel({ kind: "waiting", tasks: Array.from({ length: tasks }, (_, i) => task(`t${i}`, "ready")), subagents, stalled });

  it("names what the chat waits on", () => {
    expect(waiting(1, 0)).toBe("Waiting on 1 dispatched task");
    expect(waiting(2, 0)).toBe("Waiting on 2 dispatched tasks");
    expect(waiting(0, 1)).toBe("Waiting on 1 subagent");
    expect(waiting(0, 2)).toBe("Waiting on 2 subagents");
    expect(waiting(1, 1)).toBe("Waiting on 1 task and 1 subagent");
    expect(waiting(2, 3)).toBe("Waiting on 2 tasks and 3 subagents");
  });

  it("says when no worker has picked the task up", () => {
    expect(waiting(1, 0, true)).toBe("No worker has picked this task up. Is the Hermes gateway running?");
  });
});

describe("Stop waiting's ids", () => {
  it("are every task and subagent the chat has, so a subagent inside its wake grace stops holding it too", () => {
    const tree = ended(started(started(undefined, "s1"), "s2"), "s1");
    expect(outstandingIds(chat("c", { tasks: [task("t1", "ready"), task("t2", "done")], subagents: tree }))).toEqual(["t1", "t2", "s1", "s2"]);
    expect(outstandingIds(chat("c"))).toEqual([]);
    const allEnded = chat("c", { subagents: ended(tree, "s2") });
    expect(handoffOf(allEnded, undefined, NOW)).toMatchObject({ kind: "waiting" });
    expect(handoffOf(allEnded, new Set(outstandingIds(allEnded)), NOW)).toBeUndefined();
  });
});

describe("the next change with nothing else happening", () => {
  it("is the earliest grace end, stall or staleness still ahead, and none without tasks", () => {
    const chats = [
      chat("a", { tasks: [task("t1", "done", { overAt: NOW - 5_000 }), task("t2", "ready", { createdAt: NOW - MINUTE })] }),
      chat("b", { tasks: [task("t3", "ready", { createdAt: NOW - STALLED_MS - MINUTE })] }),
    ];
    expect(nextHandoffChange(chats, {}, NOW)).toBe(NOW - 5_000 + WAKE_GRACE_MS);
    expect(nextHandoffChange(chats, { a: ["t1"] }, NOW)).toBe(NOW - MINUTE + STALLED_MS);
    expect(nextHandoffChange([chats[1]], {}, NOW)).toBe(NOW - STALLED_MS - MINUTE + STALE_UNPICKED_MS);
    expect(nextHandoffChange([chat("quiet")], {}, NOW)).toBeUndefined();
  });
});

describe("parsing a kanban_create result", () => {
  const result = { ok: true, task_id: "t_19dd4ea0", status: "ready", workspace_kind: "project", workspace_path: "/srv/x", project_id: "p1", gated: false, subscribed: true };
  const args = { title: "Research workflows", assignee: "researcher" };

  it("reads the task from an object result, or the same as JSON text", () => {
    const want: DispatchedTask = { id: "t_19dd4ea0", board: "ops", status: "ready", title: "Research workflows", assignee: "researcher", createdAt: NOW, picked: false };
    expect(parseKanbanCreate(args, result, NOW, "ops")).toEqual(want);
    expect(parseKanbanCreate(args, JSON.stringify(result), NOW, "ops")).toEqual(want);
  });

  it("takes the board from the call, else the current board, else Hermes's default", () => {
    expect(parseKanbanCreate({ ...args, board: "research" }, result, NOW, "ops")?.board).toBe("research");
    expect(parseKanbanCreate(args, result, NOW, "ops")?.board).toBe("ops");
    expect(parseKanbanCreate(args, result, NOW)?.board).toBe("default");
  });

  it("makes nothing of a refused call, a result without a task id, or text that isn't JSON", () => {
    expect(parseKanbanCreate(args, { ...result, ok: false }, NOW)).toBeUndefined();
    expect(parseKanbanCreate(args, { ok: true }, NOW)).toBeUndefined();
    expect(parseKanbanCreate(args, "Error: board 'x' does not exist", NOW)).toBeUndefined();
    expect(parseKanbanCreate(args, undefined, NOW)).toBeUndefined();
  });

  it("falls back to ready for a status it doesn't know", () => {
    expect(parseKanbanCreate(args, { ...result, status: "queued" }, NOW)?.status).toBe("ready");
  });
});

describe("parsing a task row", () => {
  it("reads the task and the session it came from, and whether a worker picked it up", () => {
    const row = { id: "t_1", status: "running", title: "T", assignee: "researcher", session_id: "s_1", created_at: 1_762_500_000, started_at: 1_762_500_100, current_run_id: "r1" };
    expect(parseTask(row, "default", NOW)).toEqual({ task: { id: "t_1", board: "default", status: "running", title: "T", assignee: "researcher", createdAt: 1_762_500_000_000, picked: true }, sessionId: "s_1" });
    expect(parseTask({ id: "t_2", status: "ready", created_at: 1_762_500_000, started_at: null, current_run_id: null }, "default", NOW)?.task.picked).toBe(false);
    expect(parseTask({ id: "t_3", status: "ready", runs: [{ id: "r" }] }, "default", NOW)?.task).toMatchObject({ picked: true, createdAt: NOW });
  });

  it("is nothing for a row without an id or with a status it doesn't know", () => {
    expect(parseTask({ status: "ready" }, "default", NOW)).toBeUndefined();
    expect(parseTask({ id: "t", status: "paused" }, "default", NOW)).toBeUndefined();
    expect(parseTask("t", "default", NOW)).toBeUndefined();
  });
});
