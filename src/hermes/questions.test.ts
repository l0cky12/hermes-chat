// @vitest-environment jsdom
// Clarify, sudo and secret questions from Hermes (#390), against a fake Hermes that speaks `tui_gateway/contracts/
// server_requests.py` at the deployed `bf0203a`: `ClarifyRequestParams`, `clarify.lock`, `SudoRequestParams`,
// `SecretRequestParams` and `ValueResult`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";
import { isQuestion, type Item } from "./model";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };
const running: Hermes[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

/** A chat with a reply under way, on a Hermes whose chats this computer keeps (`localChatCache`). */
async function replying(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  const id = await hermes.newChat();
  await hermes.send(id, "Set up the weather skill");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const card = (kind = "clarify") => chat().items.find((i) => i.kind === kind);
  const locks = () => server.requests.filter((r) => r.method === "clarify.lock").map((r) => r.params);
  return { server, hermes, id, runtime, chat, card, locks };
}

/** A card's answer from here, if it has one. */
const answerOf = (i?: Item) => (i && isQuestion(i) ? i.answer : undefined);

const WHICH_LOGS = { question: "Which logs should I clear?", choices: ["Only old ones (Recommended)", "All of them"] };
const WHEN = { question: "When should I run it?" };

describe("A clarify", () => {
  it("shows as a card with Hermes's questions, and keeps the reply running", async () => {
    const { server, runtime, chat, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "clarify" });
    const id = server.askClarify(runtime, [WHICH_LOGS, { question: "Which folders?", choices: ["/var/log", "/tmp"], multi_select: true }, WHEN]);

    expect(card()).toEqual({
      kind: "clarify",
      id,
      questions: [
        { qid: "q0", question: "Which logs should I clear?", choices: ["Only old ones (Recommended)", "All of them"], multiSelect: false },
        { qid: "q1", question: "Which folders?", choices: ["/var/log", "/tmp"], multiSelect: true },
        { qid: "q2", question: "When should I run it?", choices: [], multiSelect: false },
      ],
      locked: {},
    });
    expect(chat().items.at(-1)).toBe(card());
    expect(chat().running).toBe(true);
  });

  it("locks answers one at a time, and the last lock answers Hermes", async () => {
    const { server, hermes, id: chatId, runtime, card, locks } = await replying();
    const id = server.askClarify(runtime, [WHICH_LOGS, WHEN])!;

    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "Only old ones" });
    expect(locks()).toEqual([{ request_id: id, question_id: "q0", answer: "Only old ones" }]);
    expect(card()).toMatchObject({ locked: { q0: "Only old ones" } });
    expect(answerOf(card())).toBeUndefined();
    expect(server.openRequests.has(id)).toBe(true);

    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q1", answer: "Tonight" });
    expect(server.settled).toEqual([{ id, method: "clarify", result: { answers: { q0: "Only old ones", q1: "Tonight" }, outcome: "submitted" }, via: "clarify.lock" }]);
    expect(card()).toMatchObject({ locked: { q0: "Only old ones", q1: "Tonight" }, answer: "answered" });
  });

  it("locks each question once", async () => {
    const { server, hermes, id: chatId, runtime, locks } = await replying();
    const id = server.askClarify(runtime, [WHICH_LOGS, WHEN])!;
    await Promise.all([
      hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "All of them" }),
      hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "Only old ones" }),
    ]);
    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "nope", answer: "x" });
    expect(locks()).toEqual([{ request_id: id, question_id: "q0", answer: "All of them" }]);
  });

  it("skips the rest, and Hermes keeps the answers locked before", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const id = server.askClarify(runtime, [WHICH_LOGS, WHEN])!;
    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "All of them" });
    await hermes.answerQuestion(chatId, id, { kind: "skip" });

    // `ClarifyResult` without `answers` is cancel-all; Hermes merges the locks (`settle_batch`).
    expect(server.settled).toEqual([{ id, method: "clarify", result: { answers: { q0: "All of them" }, outcome: "cancelled" }, via: "request.answer" }]);
    expect(server.requests.find((r) => r.method === "request.answer")?.params).toEqual({ id, result: {} });
    expect(card()).toMatchObject({ answer: "skipped", locked: { q0: "All of them" } });
  });

  it("closes with Hermes's reason when Hermes stops waiting, and an answer after that does nothing", async () => {
    const { server, hermes, id: chatId, runtime, card, locks } = await replying();
    const id = server.askClarify(runtime, [WHEN])!;
    server.cancelRequest(id, "timeout");
    expect(card()).toMatchObject({ ended: "timeout" });

    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "Now" });
    await hermes.answerQuestion(chatId, id, { kind: "skip" });
    expect(locks()).toEqual([]);
    expect(server.requests.some((r) => r.method === "request.answer")).toBe(false);
    expect(card()).toMatchObject({ ended: "timeout" });
    expect(answerOf(card())).toBeUndefined();
  });

  it("says so when a lock can't go, and keeps the question open", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const id = server.askClarify(runtime, [WHEN])!;
    server.failSend = "socket closed";
    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "Now" });

    expect(card()).toMatchObject({ locked: {} });
    expect(answerOf(card())).toBeUndefined();
    expect(chat().items.at(-1)).toMatchObject({ kind: "error", text: "Couldn't answer Hermes: socket closed" });
  });
});

describe("A sudo or secret question", () => {
  it("shows a sudo question as a card with the command", async () => {
    const { server, runtime, card } = await replying();
    const id = server.askSudo(runtime, "sudo apt-get install -y ripgrep");
    expect(card("sudo")).toEqual({ kind: "sudo", id, command: "sudo apt-get install -y ripgrep" });
  });

  it("shows a secret question as a card with what Hermes asks for", async () => {
    const { server, runtime, card } = await replying();
    const id = server.askSecret(runtime);
    expect(card("secret")).toEqual({ kind: "secret", id, envVar: "OPENWEATHER_API_KEY", prompt: "Enter your OpenWeather API key", skill: "weather" });
  });

  it("sends the password to Hermes as `ValueResult`, and the card keeps only that it was answered", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const id = server.askSudo(runtime)!;
    await hermes.answerQuestion(chatId, id, { kind: "value", value: "hunter2" });

    expect(server.settled).toEqual([{ id, method: "sudo", result: { value: "hunter2" }, via: "request.answer" }]);
    expect(card("sudo")).toEqual({ kind: "sudo", id, command: "sudo apt-get install -y ripgrep", answer: "answered" });
    expect(JSON.stringify(chat())).not.toContain("hunter2");
  });

  it("skips with an empty value, which Hermes reads as skipped", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const id = server.askSecret(runtime)!;
    await hermes.answerQuestion(chatId, id, { kind: "skip" });
    expect(server.settled).toEqual([{ id, method: "secret", result: { value: "" }, via: "request.answer" }]);
    expect(card("secret")).toMatchObject({ answer: "skipped" });
  });

  it("refuses an empty value, which would read as a skip", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const id = server.askSudo(runtime)!;
    await hermes.answerQuestion(chatId, id, { kind: "value", value: "" });
    expect(server.settled).toEqual([]);
    expect(answerOf(card("sudo"))).toBeUndefined();
  });

  it("answers in reply to Hermes's request on a Hermes without request.answer", async () => {
    const server = new FakeHermes();
    server.handlers["request.answer"] = (r) => server.fail(r.id, -32601, "unknown method: request.answer");
    const { hermes, id: chatId, runtime, card } = await replying(server);
    const id = server.askSecret(runtime)!;
    await hermes.answerQuestion(chatId, id, { kind: "value", value: "sk-weather-1" });
    expect(server.settled).toEqual([{ id, method: "secret", result: { value: "sk-weather-1" }, via: "response" }]);
    expect(card("secret")).toMatchObject({ answer: "answered" });
  });

  it("sends one answer when the owner submits twice", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const id = server.askSudo(runtime)!;
    await Promise.all([hermes.answerQuestion(chatId, id, { kind: "value", value: "first" }), hermes.answerQuestion(chatId, id, { kind: "value", value: "second" })]);
    expect(server.settled.map((s) => s.result)).toEqual([{ value: "first" }]);
  });

  it("keeps a secret out of everything this computer saves: the chat, its Saved copy, the list, and errors", async () => {
    const SECRET = "sk-weather-7f3a9c2e";
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    const id = server.askSecret(runtime)!;
    await hermes.answerQuestion(chatId, id, { kind: "value", value: SECRET });
    // A second secret whose answer can't go: the error says why without quoting it.
    const second = server.askSecret(runtime, { env_var: "OTHER_KEY" })!;
    server.failSend = `rejected ${"x".repeat(3)}`;
    await hermes.answerQuestion(chatId, second, { kind: "value", value: `${SECRET}-2` });
    server.failSend = undefined;
    server.storeMessage(chatId, { role: "user", text: "Set up the weather skill" });
    server.storeMessage(chatId, { role: "assistant", text: "Done." });
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.sync();
    await hermes.idle();

    expect(server.settled.map((s) => s.result)).toEqual([{ value: SECRET }]);
    expect(JSON.stringify(hermes.getSnapshot())).not.toContain(SECRET);
    expect(chat().items.some((i) => i.kind === "error")).toBe(true);
    expect(localChatCache(nas).loadTranscript("default", chatId)?.items.length).toBeGreaterThan(0);
    expect(Object.keys(localStorage).length).toBeGreaterThan(0);
    expect(Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes(SECRET))).toEqual([]);
  });
});

describe("Questions after a reconnect", () => {
  it("brings back a clarify still waiting, with the answers Hermes has locked", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat, card, locks } = await replying();
    server.transcripts[chatId] = [{ role: "user", text: "Set up the weather skill" }];
    const id = server.askClarify(runtime, [WHICH_LOGS, WHEN])!;
    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "All of them" });
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    expect(chat().items.map((i) => i.kind)).toEqual(["user", "clarify"]);
    expect(card()).toMatchObject({ id, locked: { q0: "All of them" } });
    expect(answerOf(card())).toBeUndefined();

    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q1", answer: "Tonight" });
    expect(locks().map((l) => l.question_id)).toEqual(["q0", "q1"]);
    expect(server.settled[0].result).toEqual({ answers: { q0: "All of them", q1: "Tonight" }, outcome: "submitted" });
  });

  it("brings back a sudo question Hermes asked while the connection was down", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, card } = await replying();
    server.drop();
    const id = server.askSudo(runtime);
    expect(card("sudo")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(card("sudo")).toMatchObject({ id, command: "sudo apt-get install -y ripgrep" });
  });
});

describe("Questions on a chat another Hermes app also has open", () => {
  // Hermes tells no other client when one answers (`resolve_response`, `lock_answer`), so the app asks it which
  // requests it still waits on (`session.events.since` → `open_requests`) once a tool call finishes or the turn ends.
  it("closes a card the other app answered once a tool call finishes, though Hermes sends no request.cancel", async () => {
    const { server, hermes, runtime, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "clarify" });
    const id = server.askClarify(runtime, [WHEN])!;
    server.answerElsewhere(id, "response");
    await hermes.idle();
    expect(card()).not.toHaveProperty("ended");

    server.event(runtime, "tool.complete", { tool_id: "t1", result: '{"responses": []}' });
    await hermes.idle();
    expect(card()).toMatchObject({ ended: "resolved" });
    expect(server.requests.find((r) => r.method === "session.events.since")?.params).toEqual({ session_id: runtime, last_seen: Number.MAX_SAFE_INTEGER });
  });

  it("keeps a question no tool call of the chat asked while an unrelated tool call finishes, and takes its answer after", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "web_search" });
    // A background task's skill asks for its secret under the chat's session, with no tool call of the chat's own.
    const id = server.askSecret(runtime)!;
    server.event(runtime, "tool.complete", { tool_id: "t1" });
    server.event(runtime, "tool.start", { tool_id: "t2", name: "read_file" });
    server.event(runtime, "tool.complete", { tool_id: "t2" });
    await hermes.idle();
    expect(card("secret")).not.toHaveProperty("ended");

    await hermes.answerQuestion(chatId, id, { kind: "value", value: "sk-weather-1" });
    expect(server.settled).toEqual([{ id, method: "secret", result: { value: "sk-weather-1" }, via: "request.answer" }]);
    expect(card("secret")).toMatchObject({ answer: "answered" });
  });

  it.each(["message.complete", "error"])("keeps a question Hermes still waits on when the turn ends with %s, and takes its answer after", async (end) => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const id = server.askSudo(runtime)!;
    server.event(runtime, end, end === "error" ? { message: "The model failed." } : { status: "complete", text: "Done." });
    await hermes.idle();
    expect(chat().running).toBe(false);
    expect(card("sudo")).not.toHaveProperty("ended");

    await hermes.answerQuestion(chatId, id, { kind: "value", value: "hunter2" });
    expect(server.settled).toEqual([{ id, method: "sudo", result: { value: "hunter2" }, via: "request.answer" }]);
    expect(card("sudo")).toMatchObject({ answer: "answered" });
  });

  it("closes a card the other app answered when the turn ends", async () => {
    const { server, hermes, runtime, card } = await replying();
    const id = server.askSudo(runtime)!;
    server.answerElsewhere(id, "response");
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.idle();
    expect(card("sudo")).toMatchObject({ ended: "resolved" });
  });

  it("goes by what Hermes lists, not by which tool calls still run", async () => {
    const { server, hermes, runtime, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal" });
    const sudo = server.askSudo(runtime)!;
    const secret = server.askSecret(runtime)!;
    server.event(runtime, "tool.start", { tool_id: "t2", name: "web_search" });
    server.answerElsewhere(sudo, "response");
    server.event(runtime, "tool.complete", { tool_id: "t1" });
    await hermes.idle();
    // t2, started after both cards, still runs.
    expect(card("sudo")).toMatchObject({ ended: "resolved" });
    expect(card("secret")).toMatchObject({ id: secret });
    expect(card("secret")).not.toHaveProperty("ended");
  });

  it("leaves a card that arrives while Hermes is being asked", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const held: (() => void)[] = [];
    // Hermes lists what it waits on when the read reaches it; the answer reaches the app later.
    server.handlers["session.events.since"] = (r) => {
      const open_requests = server.openRequestsOf(String(r.params.session_id));
      held.push(() => server.respond(r.id, { events: [], latest_seq: 0, truncated: false, count: 0, epoch: "fake", open_requests }));
    };
    const sudo = server.askSudo(runtime)!;
    server.answerElsewhere(sudo, "response");
    server.event(runtime, "tool.complete", { tool_id: "t1" });
    const secret = server.askSecret(runtime)!;
    held.splice(0).forEach((answer) => answer());
    await hermes.idle();
    expect(card("sudo")).toMatchObject({ ended: "resolved" });
    expect(card("secret")).not.toHaveProperty("ended");

    await hermes.answerQuestion(chatId, secret, { kind: "value", value: "sk-weather-1" });
    expect(server.settled.map((s) => s.id)).toEqual([secret]);
  });

  it.each([
    ["without session.events.since", (server: FakeHermes) => (server.handlers["session.events.since"] = (r) => server.fail(r.id, -32601, "unknown method: session.events.since"))],
    ["whose session.events.since lists no open requests", (server: FakeHermes) => (server.handlers["session.events.since"] = (r) => server.respond(r.id, { events: [], latest_seq: 0, truncated: false, count: 0 }))],
  ])("never closes a card on a Hermes %s, until Hermes withdraws it", async (_, older) => {
    const { server, hermes, runtime, card } = await replying();
    older(server);
    const id = server.askSudo(runtime)!;
    server.answerElsewhere(id, "response");
    server.event(runtime, "tool.complete", { tool_id: "t1" });
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.idle();
    expect(card("sudo")).not.toHaveProperty("ended");

    const other = server.askSecret(runtime)!;
    server.cancelRequest(other, "timeout");
    expect(card("secret")).toMatchObject({ ended: "timeout" });
  });

  it("shows a question Hermes still waits on as waiting after a reconnect, though the turn that ran beside it ended", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const id = server.askSecret(runtime)!;
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.idle();
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(card("secret")).toMatchObject({ id });
    expect(card("secret")).not.toHaveProperty("ended");

    await hermes.answerQuestion(chatId, id, { kind: "value", value: "sk-weather-1" });
    expect(server.settled).toEqual([{ id, method: "secret", result: { value: "sk-weather-1" }, via: "request.answer" }]);
  });

  it("says Hermes had stopped waiting when the owner answers after the other app did", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const sudo = server.askSudo(runtime)!;
    const clarify = server.askClarify(runtime, [WHEN])!;
    server.answerElsewhere(sudo, "response");
    server.answerElsewhere(clarify, "response");

    await hermes.answerQuestion(chatId, sudo, { kind: "value", value: "hunter2" });
    await hermes.answerQuestion(chatId, clarify, { kind: "lock", qid: "q0", answer: "Now" });
    expect(card("sudo")).toMatchObject({ ended: "expired" });
    expect(answerOf(card("sudo"))).toBeUndefined();
    expect(card()).toMatchObject({ ended: "expired", locked: {} });
    expect(chat().items.some((i) => i.kind === "error")).toBe(false);
  });

  it("says Hermes had stopped waiting when its request.cancel crosses the owner's answer", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const id = server.askSudo(runtime)!;
    const answer = server.handlers["request.answer"];
    // Hermes times out just as the answer goes: its request.cancel reaches the app after the card shows the answer.
    server.handlers["request.answer"] = (r) => {
      server.cancelRequest(id, "timeout");
      answer(r);
    };
    await hermes.answerQuestion(chatId, id, { kind: "value", value: "hunter2" });
    expect(server.settled).toEqual([]);
    expect(card("sudo")).toMatchObject({ ended: "expired" });
    expect(answerOf(card("sudo"))).toBeUndefined();
    expect(chat().items.some((i) => i.kind === "error")).toBe(false);
  });
});

describe("Questions this app shows only once Hermes's request parses", () => {
  it("leaves a clarify without questions, or a secret without its env var, as an unshown question", async () => {
    const server = new FakeHermes();
    server.sessions = [row("x", 1)];
    const { runtime, chat } = await replying(server);
    const clarify = server.ask(runtime, "clarify", { questions: [] })!;
    const secret = server.ask(runtime, "secret", { prompt: "A key" })!;
    expect(chat().items.some((i) => i.kind === "clarify" || i.kind === "secret")).toBe(false);
    // Hermes 0.21.6 shares chats, so another app may still show them (#313).
    expect([...server.openRequests.keys()]).toEqual([clarify, secret]);
    expect(server.responses).toEqual([]);
  });
});
