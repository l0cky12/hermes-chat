// @vitest-environment jsdom
// Clarify, sudo and secret questions from Hermes (#390), against a fake Hermes that speaks `tui_gateway/contracts/
// server_requests.py` at the deployed `bf0203a`: `ClarifyRequestParams`, `clarify.lock`, `SudoRequestParams`,
// `SecretRequestParams` and `ValueResult`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";

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
    expect(card()).not.toHaveProperty("answer");
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
    expect(card()).not.toHaveProperty("answer");
  });

  it("says so when a lock can't go, and keeps the question open", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const id = server.askClarify(runtime, [WHEN])!;
    server.failSend = "socket closed";
    await hermes.answerQuestion(chatId, id, { kind: "lock", qid: "q0", answer: "Now" });

    expect(card()).toMatchObject({ locked: {} });
    expect(card()).not.toHaveProperty("answer");
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
    expect(card("sudo")).not.toHaveProperty("answer");
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
    expect(card()).not.toHaveProperty("answer");

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
  it("closes a clarify the other app answered once the clarify tool finishes, as Hermes sends no request.cancel", async () => {
    const { server, runtime, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "clarify" });
    const id = server.askClarify(runtime, [WHEN])!;
    server.answerElsewhere(id, "response");
    expect(card()).not.toHaveProperty("ended");

    server.event(runtime, "tool.complete", { tool_id: "t1", result: '{"responses": []}' });
    expect(card()).toMatchObject({ ended: "resolved" });
  });

  it("keeps a sudo question waiting while another tool call that was already running finishes", async () => {
    const { server, runtime, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "web_search" });
    server.event(runtime, "tool.start", { tool_id: "t2", name: "terminal" });
    const id = server.askSudo(runtime)!;
    server.event(runtime, "tool.complete", { tool_id: "t1" });
    expect(card("sudo")).not.toHaveProperty("ended");

    server.answerElsewhere(id, "response");
    server.event(runtime, "tool.complete", { tool_id: "t2" });
    expect(card("sudo")).toMatchObject({ ended: "resolved" });
  });

  it("keeps a question waiting when a tool call started after it finishes", async () => {
    const { server, runtime, card } = await replying();
    server.askSudo(runtime);
    server.event(runtime, "tool.start", { tool_id: "t3", name: "read_file" });
    server.event(runtime, "tool.complete", { tool_id: "t3" });
    expect(card("sudo")).not.toHaveProperty("ended");
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
    expect(card("sudo")).not.toHaveProperty("answer");
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
    expect(card("sudo")).not.toHaveProperty("answer");
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
