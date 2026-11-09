// @vitest-environment jsdom
// A turn Hermes starts by itself (issue #330): when work a chat dispatched comes back, Hermes's notification poller
// runs a turn with no message from the owner (`tui_gateway/session_notifications.py`). Its `message.start` carries
// only the turn's id, so the reply must start its own message rather than run onto the previous one.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const HISTORY: TranscriptMessage[] = [
  { role: "user", text: "Research the backup failures" },
  { role: "assistant", text: "Dispatched. I'll synthesize the findings when it returns." },
];

async function opened(server = new FakeHermes()) {
  server.sessions = [row("backup", 1, { title: "Backup research" })];
  server.transcripts = { backup: structuredClone(HISTORY) };
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  await hermes.open("backup");
  const runtime = server.runtimeIdOf("backup")!;
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "backup")!;
  const shown = () => chat().items.map((i) => [i.kind, "text" in i ? i.text : i.id]);
  return { server, hermes, runtime, chat, shown };
}

describe("A turn Hermes starts by itself", () => {
  it("shows its reply as a new message after the last one, with every delta in the new one", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.event(runtime, "message.start", { turn_id: "wake-1" });
    server.event(runtime, "message.delta", { text: "Results are in. " });
    server.event(runtime, "message.delta", { text: "Here is the synthesis." });
    server.event(runtime, "message.complete", { text: "Results are in. Here is the synthesis.", status: "complete" });
    await hermes.idle();
    expect(shown()).toEqual([
      ["user", "Research the backup failures"],
      ["assistant", "Dispatched. I'll synthesize the findings when it returns."],
      ["assistant", "Results are in. Here is the synthesis."],
    ]);
  });

  it("starts one new message when Hermes sends the turn's start twice, as a /loop wakeup does", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.event(runtime, "message.start");
    server.event(runtime, "message.start", { turn_id: "loop-1" });
    server.event(runtime, "message.delta", { text: "Tick." });
    server.event(runtime, "message.complete", { text: "Tick.", status: "complete" });
    await hermes.idle();
    expect(shown().slice(1)).toEqual([
      ["assistant", "Dispatched. I'll synthesize the findings when it returns."],
      ["assistant", "Tick."],
    ]);
  });

  it("shows a reply the provider didn't stream, sent whole at the turn's end", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.event(runtime, "message.start");
    server.event(runtime, "message.complete", { text: "Results are in.", status: "complete" });
    await hermes.idle();
    expect(shown().slice(1)).toEqual([
      ["assistant", "Dispatched. I'll synthesize the findings when it returns."],
      ["assistant", "Results are in."],
    ]);
  });

  it("keeps its reasoning apart from the reasoning that ended the last turn", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.event(runtime, "message.start");
    server.event(runtime, "reasoning.delta", { text: "Checking the board." });
    server.event(runtime, "message.complete", { text: "", status: "complete" });
    server.event(runtime, "message.start");
    server.event(runtime, "reasoning.delta", { text: "The task is done." });
    server.event(runtime, "message.delta", { text: "Results are in." });
    server.event(runtime, "message.complete", { text: "Results are in.", status: "complete" });
    await hermes.idle();
    expect(shown().slice(2)).toEqual([
      ["thinking", "Checking the board."],
      ["thinking", "The task is done."],
      ["assistant", "Results are in."],
    ]);
  });

  it("marks only its own reply stopped when it's stopped before it says anything", async () => {
    const { server, hermes, runtime, chat } = await opened();
    server.event(runtime, "message.start");
    server.event(runtime, "message.complete", { text: "", status: "interrupted" });
    await hermes.idle();
    expect(chat().items.slice(1)).toEqual([
      { kind: "assistant", id: "h-1", text: "Dispatched. I'll synthesize the findings when it returns." },
      { kind: "assistant", id: expect.any(String), text: "", interrupted: true },
    ]);
  });

  it("still streams the owner's own reply into one message", async () => {
    const { server, hermes, runtime, shown } = await opened();
    await hermes.send("backup", "Any news?");
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Not " });
    server.event(runtime, "message.delta", { text: "yet." });
    server.event(runtime, "message.complete", { text: "Not yet.", status: "complete" });
    await hermes.idle();
    expect(shown().slice(2)).toEqual([
      ["user", "Any news?"],
      ["assistant", "Not yet."],
    ]);
  });
});

describe("A dispatched task's wake turn, against the stand-in's kanban poller", () => {
  const until = async (hermes: Hermes, done: () => boolean) => {
    for (let n = 0; n < 50 && !done(); n++) {
      await hermes.idle();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(done()).toBe(true);
  };
  const shownIn = (hermes: Hermes, id: string) =>
    hermes
      .getSnapshot()
      .chats.find((c) => c.id === id)!
      .items.map((i) => [i.kind, "text" in i ? i.text : "name" in i ? i.name : i.id]);

  it("shows the notice that began it and its reply as their own messages, live as after a reload", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    await hermes.sync();
    const id = await hermes.newChat();
    await hermes.send(id, "dispatch a research task");
    await until(hermes, () => server.kanban.boards.default?.tasks.length === 1 && !hermes.getSnapshot().chats.find((c) => c.id === id)!.running);
    const task = server.kanban.boards.default.tasks[0];
    server.kanban.move(task.id, "done");
    await until(hermes, () => shownIn(hermes, id).some(([, text]) => String(text).startsWith("✔")));

    const live = shownIn(hermes, id);
    expect(live.slice(-2)).toEqual([
      ["user", `✔ [default] @researcher Kanban ${task.id} done — a research task`],
      ["assistant", `Results are in for ${task.id} (done): a research task. Here is the synthesis.`],
    ]);
    expect(live.filter(([kind]) => kind === "assistant")).toHaveLength(2);

    const reloaded = await connect(server.openPipe, undefined, localChatCache({ ...nas, sshTarget: "liam@reload" }));
    running.push(reloaded);
    await reloaded.sync();
    await reloaded.open(id);
    // The stand-in stores no row for the dispatching reply's tool call, so the messages are compared.
    const messages = (shown: unknown[][]) => shown.filter(([kind]) => kind === "user" || kind === "assistant");
    expect(messages(shownIn(reloaded, id))).toEqual(messages(live));
    expect(messages(live)).toHaveLength(4);
  });

  it("shows the notice of a wake turn a message from here waited on, and leaves that message's own turn its stored rows", async () => {
    const server = new FakeHermes();
    server.userRowId = 50;
    const { hermes, runtime, chat } = await opened(server);
    server.storeMessage("backup", { role: "user", text: "[IMPORTANT: Background process proc_1 completed]", display_kind: "process_complete", row_id: 40 });
    server.event(runtime, "message.start", { turn_id: "wake-1" });
    await hermes.send("backup", "Any news?");
    server.event(runtime, "message.delta", { text: "Results are in." });
    server.event(runtime, "message.complete", { text: "Results are in.", status: "complete", persisted_turn: { user_row_id: 40, final_assistant_row_id: 41 } });
    server.event(runtime, "message.start", { turn_id: "held-1" });
    server.event(runtime, "message.delta", { text: "Not since then." });
    server.event(runtime, "message.complete", { text: "Not since then.", status: "complete", persisted_turn: { user_row_id: 50, final_assistant_row_id: 51 } });
    await until(hermes, () => chat().items.some((i) => i.kind === "user" && i.rowId === 40) && chat().items.some((i) => i.kind === "assistant" && i.rowId === 51));
    expect(chat().items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && [i.text, i.rowId])).toEqual([
      ["Research the backup failures", undefined],
      ["[IMPORTANT: Background process proc_1 completed]", 40],
      ["Any news?", 50],
    ]);
  });

  it("shows the notice when an earlier message from here was turned down", async () => {
    const { server, hermes, runtime, chat } = await opened();
    server.rejectPrompt = { code: 4000, message: "nope" };
    expect(await hermes.send("backup", "Any news?")).toMatchObject({ delivery: "unsent" });
    server.rejectPrompt = undefined;
    server.storeMessage("backup", { role: "user", text: "[IMPORTANT: Background process proc_1 completed]", display_kind: "process_complete", row_id: 40 });
    server.event(runtime, "message.start", { turn_id: "wake-1" });
    server.event(runtime, "message.delta", { text: "Results are in." });
    server.event(runtime, "message.complete", { text: "Results are in.", status: "complete", persisted_turn: { user_row_id: 40 } });
    await until(hermes, () => chat().items.some((i) => i.kind === "user" && i.rowId === 40));
    expect(chat().items.slice(-2).map((i) => i.kind === "user" || i.kind === "assistant" ? i.text : i.kind)).toEqual(["[IMPORTANT: Background process proc_1 completed]", "Results are in."]);
  });

  it("puts the notice before a wake turn that calls a tool", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.storeMessage("backup", { role: "user", text: "✔ [default] Kanban t_1 done — backups", row_id: 40 });
    server.event(runtime, "message.start", { turn_id: "wake-1" });
    server.event(runtime, "tool.start", { tool_id: "c1", name: "kanban_show", args: { task_id: "t_1" } });
    server.event(runtime, "tool.complete", { tool_id: "c1", name: "kanban_show", result: "{}" });
    server.event(runtime, "message.delta", { text: "Results are in." });
    server.event(runtime, "message.complete", { text: "Results are in.", status: "complete", persisted_turn: { user_row_id: 40 } });
    await until(hermes, () => shown().some(([kind]) => kind === "user" && shown().length === 5));
    expect(shown().slice(1)).toEqual([
      ["assistant", "Dispatched. I'll synthesize the findings when it returns."],
      ["user", "✔ [default] Kanban t_1 done — backups"],
      ["tool", "c1"],
      ["assistant", "Results are in."],
    ]);
  });

  it("shows nothing for a turn whose message the history hides, such as a background process's heartbeat", async () => {
    const { server, hermes, runtime, shown } = await opened();
    server.storeMessage("backup", { role: "user", text: "[Background process proc_1 heartbeat #1 — still running]", display_kind: "hidden", row_id: 40 });
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Still running." });
    server.event(runtime, "message.complete", { text: "Still running.", status: "complete", persisted_turn: { user_row_id: 40 } });
    await until(hermes, () => server.restRequests.some((r) => r.path === "/api/sessions/backup/messages"));
    await hermes.idle();
    expect(shown().slice(1)).toEqual([
      ["assistant", "Dispatched. I'll synthesize the findings when it returns."],
      ["assistant", "Still running."],
    ]);
  });
});
