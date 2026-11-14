// Dispatched kanban work end to end (issue #287): the transport against a FakeHermes whose kanban routes and wakes
// behave as Hermes 0.22.6's do, read through `handoffOf` and `chatSections` as the chat list does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { STALLED_MS, WAKE_GRACE_MS, handoffOf, handoffs, waitingLabel, type Handoff } from "./dispatched";
import { FakeHermes, row } from "./fakeHermes";
import { KanbanWatch, NoKanbanPlugin, POLL_EVERY_MS, SCAN_EVERY_MS, canMove, moveNeeds, moveSettled, refused, taskEdits, type SeenTask, type Workflow } from "./kanban";
import { chatSections } from "./snooze";
import { LIVE_MIN_GAP_MS, connect, type Hermes } from "./transport";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  vi.useRealTimers();
});

async function signedIn(server = new FakeHermes()) {
  vi.useFakeTimers();
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const handoff = (id: string, now = Date.now()): Handoff | undefined => handoffOf(chat(id), undefined, now);
  const section = (id: string, now = Date.now()) => {
    const s = chatSections(hermes.getSnapshot().chats, {}, now, {}, {}, handoffs(hermes.getSnapshot().chats, {}, now));
    return (Object.keys(s) as (keyof typeof s)[]).find((k) => s[k].some((c) => c.id === id));
  };
  return { server, hermes, chat, handoff, section };
}

/** A chat whose reply dispatched a research task and ended; the task's id. */
async function dispatched(server: FakeHermes, hermes: Hermes, prompt = "dispatch a research task") {
  const id = await hermes.newChat();
  await hermes.send(id, prompt);
  await vi.advanceTimersByTimeAsync(0);
  const task = server.kanban.boards.default.tasks.at(-1)!;
  return { id, task };
}

const kanbanReads = (server: FakeHermes) => server.restRequests.filter((r) => r.path.startsWith("/api/plugins/kanban")).map((r) => `${r.path}${r.query.size ? `?${r.query}` : ""}`);

describe("a reply that dispatches a kanban task", () => {
  it("leaves the chat in Working, waiting on the task, the moment its turn ends", async () => {
    const { server, hermes, chat, handoff, section } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    expect(chat(id).running).toBe(false);
    expect(chat(id).items.filter((i) => i.kind === "tool").map((i) => i.kind === "tool" && i.name)).toEqual(["kanban_create"]);
    expect(chat(id).tasks).toEqual([{ id: task.id, board: "default", status: "ready", title: "a research task", assignee: "researcher", createdAt: expect.any(Number), picked: false }]);
    expect(handoff(id)).toMatchObject({ kind: "waiting", tasks: [{ id: task.id }], subagents: 0, stalled: false });
    expect(section(id)).toBe("working");
    expect(kanbanReads(server).filter((p) => p.includes("/tasks/"))).toEqual([]);
  });

  it("reads the task every 30 seconds, and at once when Hermes's notice names it", async () => {
    const { server, hermes, chat } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    task.started_at = Math.floor(Date.now() / 1000);
    task.current_run_id = "run_1";
    task.status = "running";
    expect(chat(id).tasks![0]).toMatchObject({ status: "ready", picked: false });
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS - 1);
    expect(chat(id).tasks![0]).toMatchObject({ status: "ready" });
    await vi.advanceTimersByTimeAsync(1);
    expect(chat(id).tasks![0]).toMatchObject({ status: "running", picked: true });
    expect(kanbanReads(server).filter((p) => p.includes("/tasks/"))).toEqual([`/api/plugins/kanban/tasks/${task.id}?board=default`]);

    task.status = "review";
    server.event(server.runtimeIdOf(id)!, "status.update", { kind: "process", text: `👀 [default] @researcher Kanban ${task.id} review — a research task` });
    await vi.advanceTimersByTimeAsync(0);
    expect(chat(id).tasks![0]).toMatchObject({ status: "review" });
    expect(kanbanReads(server).filter((p) => p.includes("/tasks/"))).toHaveLength(2);
  });

  it("goes to the Inbox with a reason once the task is blocked or under review", async () => {
    const { server, hermes, handoff, section } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    server.kanban.move(task.id, "blocked");
    await vi.advanceTimersByTimeAsync(0);
    expect(handoff(id)).toMatchObject({ kind: "needsOwner", reason: "A dispatched task is blocked." });
    expect(section(id)).toBe("inbox");
  });

  it("keeps waiting through the wake turn, then lands in the Inbox once that turn ends", async () => {
    const { server, hermes, chat, handoff, section } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    server.kanban.wakeDelayMs = 5_000;
    server.kanban.move(task.id, "running");
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(chat(id).tasks![0]).toMatchObject({ status: "running", picked: true });

    server.kanban.move(task.id, "done");
    await vi.advanceTimersByTimeAsync(0);
    expect(chat(id).tasks![0]).toMatchObject({ status: "done", overAt: Date.now() });
    expect(handoff(id)).toMatchObject({ kind: "waiting", tasks: [{ id: task.id, status: "done" }] });
    expect(section(id)).toBe("working");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(chat(id).running).toBe(false);
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: expect.stringContaining("Results are in") });
    expect(chat(id).tasks).toBeUndefined();
    expect(handoff(id)).toBeUndefined();
    expect(section(id)).toBe("inbox");
  });

  it("dispatches again from the wake turn and stays in Working", async () => {
    const { server, hermes, handoff } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    const runtime = server.runtimeIdOf(id)!;
    server.kanban.move(task.id, "done");
    await vi.advanceTimersByTimeAsync(0);
    server.event(runtime, "message.start");
    server.event(runtime, "tool.start", { tool_id: "kc-2", name: "kanban_create", args: { title: "Follow-up", board: "ops" } });
    server.event(runtime, "tool.complete", { tool_id: "kc-2", name: "kanban_create", result: { ok: true, task_id: "t_follow", status: "ready", subscribed: true } });
    server.event(runtime, "message.complete", { text: "", status: "complete" });
    expect(handoff(id)).toEqual({ kind: "waiting", tasks: [expect.objectContaining({ id: "t_follow", board: "ops" })], subagents: 0, stalled: false });
  });

  it("lands in the Inbox after the grace when no wake turn comes: unsubscribed, or the owner pressed Stop", async () => {
    const { server, hermes, chat, handoff } = await signedIn();
    const quiet = await dispatched(server, hermes);
    quiet.task.subscribed = false;
    server.kanban.move(quiet.task.id, "done");
    await vi.advanceTimersByTimeAsync(0);
    const seenOver = Date.now();
    expect(handoff(quiet.id)).toMatchObject({ kind: "waiting" });
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(chat(quiet.id).running).toBe(false);
    expect(handoff(quiet.id)).toBeUndefined();
    expect(chat(quiet.id).tasks![0]).toMatchObject({ status: "done", overAt: seenOver });

    const stopped = await dispatched(server, hermes, "dispatch another one");
    await hermes.send(stopped.id, "and a follow-up question");
    await hermes.stop(stopped.id);
    server.event(server.runtimeIdOf(stopped.id)!, "message.complete", { status: "interrupted", text: "" });
    server.kanban.move(stopped.task.id, "done");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(chat(stopped.id).running).toBe(false);
    expect(handoff(stopped.id)).toBeUndefined();
  });

  it("says no worker has picked the task up after 10 minutes in ready", async () => {
    const { server, hermes, handoff } = await signedIn();
    const { id } = await dispatched(server, hermes);
    // The board stamps `created_at` in whole seconds, so it can read up to a second before the call completed here.
    await vi.advanceTimersByTimeAsync(STALLED_MS - 2_000);
    expect(handoff(id)).toMatchObject({ kind: "waiting", stalled: false });
    await vi.advanceTimersByTimeAsync(2_000 + POLL_EVERY_MS);
    const h = handoff(id)!;
    expect(h).toMatchObject({ kind: "waiting", stalled: true });
    expect(waitingLabel(h as Extract<Handoff, { kind: "waiting" }>)).toBe("No worker has picked this task up. Is the Hermes gateway running?");
  });

  it("stops counting a task that is gone from the board", async () => {
    const { server, hermes, handoff } = await signedIn();
    const { id, task } = await dispatched(server, hermes);
    server.kanban.remove(task.id);
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(handoff(id)).toBeUndefined();
  });

  it("reads nothing while disconnected and keeps the tasks as last seen", async () => {
    const { server, hermes, chat, handoff } = await signedIn();
    const { id } = await dispatched(server, hermes);
    const reads = kanbanReads(server).length;
    server.refuse = "Connection refused";
    server.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(hermes.getSnapshot().status).not.toBe("connected");
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS);
    expect(kanbanReads(server).slice(reads).filter((p) => p.startsWith("/api/plugins/kanban"))).toEqual([]);
    expect(chat(id).tasks).toHaveLength(1);
    expect(handoff(id)).toMatchObject({ kind: "waiting" });
  });
});

describe("after a restart", () => {
  it("rebuilds the chat's tasks from the boards, matching any segment of its lineage, and leaves old unpicked tasks alone", async () => {
    const server = new FakeHermes();
    server.sessions = [row("fresh", 0.01), row("compressed", 0.02, { _lineage_ids: ["older-segment", "compressed"] }), row("idle", 0.03)];
    server.kanban.add("default", { title: "Fresh work", session_id: "fresh", status: "running", started_at: 1 });
    server.kanban.add("default", { title: "From the first segment", session_id: "older-segment" });
    server.kanban.add("default", { title: "Someone else's", session_id: "elsewhere" });
    server.kanban.add("default", { title: "Finished long ago", session_id: "idle", status: "done" });
    server.kanban.add("default", { title: "Never picked up", session_id: "idle", created_at: Math.floor(Date.now() / 1000) - 8 * 86_400 });
    server.kanban.boards.ops = { name: "Ops", tasks: [] };
    server.kanban.add("ops", { title: "Ops work", session_id: "fresh" });
    const { hermes, chat, handoff } = await signedIn(server);
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat("fresh").tasks?.map((t) => [t.title, t.board, t.picked])).toEqual([
      ["Fresh work", "default", true],
      ["Ops work", "ops", false],
    ]);
    expect(chat("compressed").lineage).toEqual(["older-segment", "compressed"]);
    expect(chat("compressed").tasks?.map((t) => t.title)).toEqual(["From the first segment"]);
    expect(chat("idle").tasks).toBeUndefined();
    expect(handoff("idle")).toBeUndefined();
    expect(kanbanReads(server)).toEqual(["/api/plugins/kanban/boards", "/api/plugins/kanban/board?board=default", "/api/plugins/kanban/board?board=ops"]);
  });

  it("drops the tasks of a board that is gone at the next scan, and is unmoved by a server without the plugin", async () => {
    const server = new FakeHermes();
    server.sessions = [row("fresh", 0.01)];
    server.kanban.boards.ops = { name: "Ops", tasks: [] };
    server.kanban.add("ops", { title: "Ops work", session_id: "fresh" });
    const { hermes, chat } = await signedIn(server);
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat("fresh").tasks).toHaveLength(1);
    delete server.kanban.boards.ops;
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(chat("fresh").tasks).toBeUndefined();

    const bare = new FakeHermes();
    bare.sessions = [row("fresh", 0.01)];
    bare.kanban.missing = true;
    const plain = await signedIn(bare);
    await plain.hermes.idle();
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS);
    expect(plain.chat("fresh").tasks).toBeUndefined();
    expect(plain.hermes.getSnapshot().status).toBe("connected");
  });
});

describe("a reply that starts background subagents", () => {
  it("keeps the chat in Working until every subagent has ended and the wake turn is due or done", async () => {
    const { server, hermes, chat, handoff, section } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "do this in the background");
    await vi.advanceTimersByTimeAsync(0);
    expect(chat(id).running).toBe(false);
    expect(handoff(id)).toMatchObject({ kind: "waiting", tasks: [], subagents: 2 });
    expect(section(id)).toBe("working");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "subagent.complete", { subagent_id: "sa-1", status: "completed" });
    expect(handoff(id)).toMatchObject({ subagents: 1 });
    server.event(runtime, "subagent.complete", { subagent_id: "sa-2", status: "failed" });
    expect(handoff(id)).toMatchObject({ kind: "waiting", subagents: 2 });
    expect(section(id)).toBe("working");
    expect(handoff(id, Date.now() + WAKE_GRACE_MS)).toBeUndefined();
    expect(section(id, Date.now() + WAKE_GRACE_MS)).toBe("inbox");
  });

  it("goes to the Inbox once the wake turn that reports on the subagents ends", async () => {
    const { server, hermes, chat, handoff, section } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "do this in the background");
    await vi.advanceTimersByTimeAsync(0);
    const runtime = server.runtimeIdOf(id)!;
    for (const sa of ["sa-1", "sa-2"]) server.event(runtime, "subagent.complete", { subagent_id: sa, status: "completed" });
    await vi.advanceTimersByTimeAsync(1_000);
    server.event(runtime, "message.start");
    expect(chat(id).running).toBe(true);
    expect(section(id)).toBe("working");
    server.event(runtime, "message.delta", { text: "Both subagents are back." });
    server.event(runtime, "message.complete", { text: "Both subagents are back.", status: "complete" });
    expect(handoff(id)).toBeUndefined();
    expect(section(id)).toBe("inbox");
  });
});

describe("a chat this app hasn't resumed, with background subagents running (#311)", () => {
  /** After a restart: `research`'s reply started two background subagents that still run; this app never resumed it. */
  function restarted(server = new FakeHermes()) {
    // Not settled (ADR 0090), so each is in the Inbox or Working.
    server.sessions = [row("research", 0.01, { pinned: true }), row("compressed", 0.02, { pinned: true, _lineage_ids: ["first-segment", "compressed"] }), row("quiet", 0.03, { pinned: true })];
    server.subagents.research = ["sa-1", "sa-2"].map((subagent_id) => ({ subagent_id, owner: "rt-before-restart", status: "running", depth: 0 }));
    server.subagents["first-segment"] = [{ subagent_id: "sa-3", owner: "rt-older", status: "running", depth: 0 }];
    server.backgroundProcesses.quiet = 1;
    return server;
  }
  const rosterReads = (server: FakeHermes) => server.requests.filter((r) => r.method === "subagent.roster");

  it("stays in Working while the roster counts them, matching any segment of its lineage", async () => {
    const { server, hermes, chat, handoff, section } = await signedIn(restarted());
    await hermes.checkLive();
    expect(chat("research").runtimeId).toBeUndefined();
    expect(chat("research").subagents).toBeUndefined();
    expect(handoff("research")).toMatchObject({ kind: "waiting", subagents: 2 });
    expect(section("research")).toBe("working");
    expect(handoff("compressed")).toMatchObject({ kind: "waiting", subagents: 1 });
    // A background process alone doesn't hold a chat: the roster counts those that never wake it too.
    expect(handoff("quiet")).toBeUndefined();
    expect(section("quiet")).toBe("inbox");
    expect(rosterReads(server).map((r) => r.params)).toEqual([{ profile: "default" }]);
  });

  it("is found when the roster was read before the chat list loaded", async () => {
    const server = restarted();
    vi.useFakeTimers();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    await hermes.checkLive();
    expect(hermes.getSnapshot().chats).toEqual([]);
    await hermes.sync();
    expect(handoffOf(hermes.getSnapshot().chats.find((c) => c.id === "research")!, undefined, Date.now())).toMatchObject({ subagents: 2 });
  });

  it("goes to the Inbox once the subagents have ended and the wake turn that reports on them ends", async () => {
    const { server, hermes, handoff, section } = await signedIn(restarted());
    await hermes.checkLive();
    server.subagents.research = [];
    server.liveSessions = [{ id: "rt-wake", session_key: "research", status: "working", last_active: Math.floor(Date.now() / 1000) }];
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    expect(handoff("research")).toMatchObject({ kind: "waiting", subagents: 2 });
    // Long past the wake grace, the wake turn still runs.
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS * 3);
    expect(section("research")).toBe("working");
    server.liveSessions = [];
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    expect(handoff("research")).toBeUndefined();
    expect(section("research")).toBe("inbox");
  });

  it("goes to the Inbox after the wake grace when no wake turn comes", async () => {
    const { server, hermes, handoff, section } = await signedIn(restarted());
    await hermes.checkLive();
    server.subagents.research = [];
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    expect(section("research")).toBe("working");
    expect(handoff("research", Date.now() + WAKE_GRACE_MS)).toBeUndefined();
    expect(section("research", Date.now() + WAKE_GRACE_MS)).toBe("inbox");
  });

  it("checks again 15 seconds after the last check started, however often the chat list is read meanwhile", async () => {
    const { server, hermes } = await signedIn(restarted());
    await hermes.checkLive();
    const reads = rosterReads(server).length;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS / 4);
      await hermes.sync();
    }
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS / 4);
    expect(rosterReads(server).length).toBe(reads + 1);
  });

  it("reads the roster only on the app's own cadence once nothing waits on it", async () => {
    const { server, hermes } = await signedIn(restarted());
    await hermes.checkLive();
    server.subagents = {};
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS * 4);
    const reads = rosterReads(server).length;
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS * 10);
    expect(rosterReads(server).length).toBe(reads);
  });

  it("leaves a chat resumed here to its own Subagents tree", async () => {
    const { server, hermes, chat, handoff } = await signedIn(restarted());
    await hermes.open("research");
    await hermes.idle();
    expect(chat("research").subagents?.subagents).toHaveLength(2);
    server.subagents.research = server.subagents.research.map((r) => ({ ...r, status: "completed" }));
    await hermes.checkLive();
    expect(chat("research").roster).toBeUndefined();
    expect(handoff("research")).toMatchObject({ subagents: 2 });
  });

  it("doesn't hold later checks when a roster read never answers", async () => {
    const server = restarted();
    server.handlers["subagent.roster"] = () => {};
    const { hermes, chat } = await signedIn(server);
    let done = false;
    void hermes.checkLive().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    expect(done).toBe(true);
    expect(chat("research").roster).toBeUndefined();
    const lives = () => server.requests.filter((r) => r.method === "session.active_list").length;
    const before = lives();
    void hermes.checkLive();
    await vi.advanceTimersByTimeAsync(0);
    expect(lives()).toBe(before + 1);
  });

  it("is unchanged on a Hermes without subagent.roster, which is asked once", async () => {
    const server = restarted();
    server.asOlderHermes();
    const { hermes, handoff, section } = await signedIn(server);
    await hermes.checkLive();
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    await hermes.checkLive();
    expect(handoff("research")).toBeUndefined();
    expect(section("research")).toBe("inbox");
    expect(rosterReads(server)).toHaveLength(1);
    expect(hermes.getSnapshot().status).toBe("connected");
  });
});

describe("a chat waiting on background subagents across a dropped connection", () => {
  it("is resumed on reconnect, so subagents that ended meanwhile stop holding it in Working", async () => {
    const { server, hermes, handoff, section } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "do this in the background");
    await vi.advanceTimersByTimeAsync(0);
    expect(handoff(id)).toMatchObject({ kind: "waiting", subagents: 2 });
    server.drop();
    server.subagents[id] = [];
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(server.last("subagent.list")?.params).toEqual({ session_id: server.runtimeIdOf(id) });
    expect(handoff(id)).toBeUndefined();
    expect(section(id)).toBe("inbox");
  });
});

describe("a chat whose wake turn is due when the connection drops", () => {
  it("is resumed on reconnect, so the wake turn is heard and keeps it in Working", async () => {
    const { server, hermes, chat, section } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "do this in the background");
    await vi.advanceTimersByTimeAsync(0);
    const runtime = server.runtimeIdOf(id)!;
    for (const sa of ["sa-1", "sa-2"]) server.event(runtime, "subagent.complete", { subagent_id: sa, status: "completed" });
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(chat(id).runtimeId).toBe(server.runtimeIdOf(id));
    server.event(server.runtimeIdOf(id)!, "message.start");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(chat(id).running).toBe(true);
    expect(section(id)).toBe("working");
  });
});

describe("a board read that was under way when a task was dispatched", () => {
  it("keeps the new task, though the board it read didn't have it yet", async () => {
    let answer!: (tasks: SeenTask[]) => void;
    const published: string[][] = [];
    const watch = new KanbanWatch({
      api: {
        boards: async () => ({ boards: [{ slug: "default", current: true, archived: false }], current: "default" }),
        board: () => new Promise<SeenTask[]>((resolve) => (answer = resolve)),
        task: async () => undefined,
      },
      sessions: () => new Set(["chat-1"]),
      publish: (by) => published.push([...by.values()].flat().map((t) => t.id)),
    });
    watch.start();
    watch.chatsListed();
    await Promise.resolve();
    watch.add({ id: "t_new", board: "default", status: "ready", createdAt: Date.now(), picked: false }, "chat-1");
    answer([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(published.at(-1)).toEqual(["t_new"]);
    watch.stop();
  });
});

describe("the board scan's schedule", () => {
  afterEach(() => void vi.useRealTimers());
  const watchWith = (boards: () => Promise<{ boards: { slug: string; current: boolean; archived: boolean }[]; current?: string }>) =>
    new KanbanWatch({ api: { boards, board: async () => [], task: async () => undefined }, sessions: () => new Set(), publish: () => {} });

  it("tries again a scan later when the board list couldn't be read", async () => {
    vi.useFakeTimers();
    let asked = 0;
    const watch = watchWith(async () => {
      asked++;
      if (asked === 2) throw new RestError(502, "Bad Gateway");
      return { boards: [{ slug: "default", current: true, archived: false }], current: "default" };
    });
    watch.start();
    watch.chatsListed();
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS);
    expect(asked).toBe(2);
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS);
    expect(asked).toBe(3);
    watch.stop();
  });

  it("scans once a period, not once for each timer that ever started one", async () => {
    vi.useFakeTimers();
    let asked = 0;
    const watch = watchWith(async () => (asked++, { boards: [], current: "default" }));
    watch.start();
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS / 2);
    watch.chatsListed();
    await vi.advanceTimersByTimeAsync(SCAN_EVERY_MS * 4);
    expect(asked).toBe(5);
    watch.stop();
  });
});

describe("the Work page's board (issue #595)", () => {
  const wf: Workflow = {
    columns: ["triage", "ready", "running", "blocked", "review", "done"].map((key) => ({ key, label: key, dropTarget: !["running", "review"].includes(key) })),
    manual: { ready: ["blocked", "done"], blocked: ["ready"], review: ["done", "running"] },
  };

  async function work(server = new FakeHermes()) {
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    return { server, hermes, api: hermes.kanban };
  }

  it("allows only the workflow's manual moves into columns that take a drop", () => {
    expect(canMove(wf, "ready", "done")).toBe(true);
    expect(canMove(wf, "ready", "triage")).toBe(false);
    expect(canMove(wf, "review", "running")).toBe(false);
    expect(canMove(wf, "ready", "ready")).toBe(false);
    expect(canMove(wf, "unknown", "done")).toBe(false);
  });

  it("asks for a summary to complete, unless from review, and a reason to block", () => {
    expect(moveNeeds("ready", "done")).toBe("summary");
    expect(moveNeeds("review", "done")).toBeUndefined();
    expect(moveNeeds("ready", "blocked")).toBe("reason");
    expect(moveNeeds("blocked", "ready")).toBeUndefined();
  });

  it("holds a move until the board no longer shows the task where it was", () => {
    const task = (status: string) => ({ id: "t_1", title: "x", body: "", assignee: "", status, priority: 0, comments: 0 });
    expect(moveSettled([{ name: "ready", tasks: [task("ready")] }], { id: "t_1", from: "ready" })).toBe(false);
    expect(moveSettled([{ name: "done", tasks: [task("done")] }], { id: "t_1", from: "ready" })).toBe(true);
    expect(moveSettled([], { id: "t_1", from: "ready" })).toBe(true);
  });

  it("sends only the fields an edit changed", () => {
    const t = { id: "t_1", title: "Ship", body: "", assignee: "researcher", status: "ready", priority: 1, comments: 0 };
    expect(taskEdits(t, { title: " Ship ", body: "", priority: 1, assignee: "researcher" })).toEqual({});
    expect(taskEdits(t, { title: "Ship it", body: "now", priority: 2, assignee: "" })).toEqual({ title: "Ship it", body: "now", priority: 2, assignee: "" });
  });

  it("tells a refused write from one that may have landed", () => {
    expect(refused(new RestError(409, "{}"))).toBe(true);
    expect(refused(new RestError(502, "{}"))).toBe(false);
    expect(refused(new Error("error sending request"))).toBe(false);
  });

  it("reads the current board and the workflow", async () => {
    const { server, api } = await work();
    server.kanban.add("default", { title: "Research", assignee: "researcher", body: "Look into it", priority: 2 });
    const board = await api.loadBoard();
    expect(board.assignees).toEqual(["researcher", "writer"]);
    expect(board.columns.find((c) => c.name === "ready")!.tasks).toEqual([
      { id: expect.stringMatching(/^t_/), title: "Research", body: "Look into it", assignee: "researcher", status: "ready", priority: 2, comments: 0 },
    ]);
    expect(canMove(await api.loadWorkflow(), "ready", "done")).toBe(true);
  });

  it("says the plugin is missing when the board answers 404", async () => {
    const server = new FakeHermes();
    server.kanban.missing = true;
    const { api } = await work(server);
    await expect(api.loadBoard()).rejects.toBeInstanceOf(NoKanbanPlugin);
  });

  it("blocks with a reason and leaves the BLOCKED: comment, and completes with a summary", async () => {
    const { server, api } = await work();
    const t = server.kanban.add("default", { title: "Research" });
    expect(await api.moveTask(t.id, "blocked", " waiting on keys ")).toBeUndefined();
    expect(server.kanban.writes).toEqual([`PATCH ${t.id} {"status":"blocked","block_reason":"waiting on keys"}`, `POST ${t.id}/comments {"body":"BLOCKED: waiting on keys"}`]);
    expect((await api.loadTask(t.id)).comments.map((c) => c.body)).toEqual(["BLOCKED: waiting on keys"]);
    await api.moveTask(t.id, "done", "Wrote it up");
    expect(server.kanban.writes.at(-1)).toBe(`PATCH ${t.id} {"status":"done","result":"Wrote it up","summary":"Wrote it up"}`);
    expect(server.kanban.find(t.id)!.status).toBe("done");
  });

  it("keeps a block whose comment failed, and says so", async () => {
    const { server, api } = await work();
    const t = server.kanban.add("default", { title: "Research" });
    const patch = server.kanban.route.bind(server.kanban);
    server.kanban.route = (req) => (req.path.endsWith("/comments") ? () => { throw new RestError(500, "{}"); } : patch(req));
    expect(await api.moveTask(t.id, "blocked", "why")).toMatch(/^Blocked t_\w+, but its BLOCKED: comment wasn't saved/);
    expect(server.kanban.find(t.id)!.status).toBe("blocked");
  });

  it("creates one task per idempotency key, however often it's sent", async () => {
    const { server, api } = await work();
    server.kanban.createWarning = "No dispatcher is running";
    const fields = { title: " New ", body: "", priority: 0, assignee: "writer" };
    const first = await api.createTask(fields, "k1");
    expect(first).toEqual({ id: expect.stringMatching(/^t_/), warning: "No dispatcher is running" });
    expect((await api.createTask(fields, "k1")).id).toBe(first.id);
    expect(server.kanban.boards.default.tasks.map((t) => t.title)).toEqual(["New"]);
    expect(server.kanban.writes[0]).toBe(`POST {"title":"New","assignee":"writer","priority":0,"idempotency_key":"k1"}`);
  });
});
