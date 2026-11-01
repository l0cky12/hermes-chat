import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";

/** A new chat with a reply under way. */
async function replying(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "Clean up the logs");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  return { server, hermes, id, runtime, chat, card: () => chat().items.find((i) => i.kind === "approval") };
}

const received = (server: FakeHermes) => server.requests.filter((r) => r.method === "approval.received");

describe("Approvals", () => {
  afterEach(() => void vi.useRealTimers());

  it("tells Hermes on every connection that it answers Hermes's questions", async () => {
    vi.useFakeTimers();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    await hermes.idle();
    expect(server.answersRequests).toBe(true);

    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(server.requests.filter((r) => r.method === "client.capabilities").map((r) => r.params)).toEqual([
      { server_requests: true },
      { server_requests: true },
    ]);
    expect(server.answersRequests).toBe(true);
  });

  it("shows Hermes's request as a card in the chat, and keeps the reply running", async () => {
    const { server, runtime, chat, card } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal", preview: "rm -rf /var/log/old" });
    const { id, requestId } = server.askApproval(runtime, { command: "rm -rf /var/log/old", description: "recursive delete" });

    expect(card()).toEqual({ kind: "approval", id, requestId, command: "rm -rf /var/log/old", description: "recursive delete" });
    expect(chat().items.at(-1)).toBe(card());
    expect(chat().running).toBe(true);
  });

  it("approves the command once", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "once");

    expect(server.responses).toEqual([{ jsonrpc: "2.0", id, result: { choice: "once", all: false } }]);
    expect(server.openRequests.size).toBe(0);
    expect(card()).toMatchObject({ answer: "once" });
  });

  it("denies the command", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "deny");

    expect(server.responses).toEqual([{ jsonrpc: "2.0", id, result: { choice: "deny", all: false } }]);
    expect(card()).toMatchObject({ answer: "deny" });
  });

  it("answers a card only once", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const { id } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "once");
    await hermes.answerApproval(chatId, id!, "deny");
    expect(server.responses.map((r) => r.result?.choice)).toEqual(["once"]);
  });

  it("tells Hermes the card is on screen when it arrives in the chat the owner has open", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    await hermes.open(chatId);
    const { requestId } = server.askApproval(runtime);
    await hermes.idle();

    expect(received(server).map((r) => r.params)).toEqual([{ session_id: runtime, request_id: requestId }]);
    // Opening the chat again doesn't repeat it.
    hermes.leave(chatId);
    await hermes.open(chatId);
    expect(received(server)).toHaveLength(1);
  });

  it("tells Hermes once the owner opens a chat whose card arrived off screen", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const { requestId } = server.askApproval(runtime);
    await hermes.idle();
    expect(received(server)).toEqual([]);

    await hermes.open(chatId);
    await hermes.idle();
    expect(received(server).map((r) => r.params)).toEqual([{ session_id: runtime, request_id: requestId }]);
  });

  it("doesn't tell Hermes about a card the owner has already answered", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const { id } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "once");
    await hermes.open(chatId);
    await hermes.idle();
    expect(received(server)).toEqual([]);
  });

  it("stops telling a server that doesn't support it, without showing an error", async () => {
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    server.handlers["approval.received"] = (r) => server.fail(r.id, -32601, "unknown method: approval.received");
    await hermes.open(chatId);
    server.askApproval(runtime);
    await hermes.idle();
    server.askApproval(runtime);
    await hermes.idle();

    expect(received(server)).toHaveLength(1);
    expect(chat().items.filter((i) => i.kind === "error")).toEqual([]);
  });

  it("closes the card when Hermes stops waiting for an answer", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.cancelRequest(id!, "timeout");
    expect(card()).toMatchObject({ ended: "timeout" });
    expect(card()).not.toHaveProperty("answer");

    // Hermes isn't waiting any more, so a late click sends nothing.
    await hermes.answerApproval(chatId, id!, "once");
    expect(server.responses).toEqual([]);
  });

  it("closes the card when the owner stops the reply", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    server.askApproval(runtime);
    await hermes.stop(chatId);
    expect(card()).toMatchObject({ ended: "interrupted" });
  });

  it("closes a card still waiting when the turn ends", async () => {
    const { server, runtime, card } = await replying();
    server.askApproval(runtime);
    server.event(runtime, "message.complete", { text: "", status: "complete" });
    expect(card()).toMatchObject({ ended: "turn ended" });
  });

  it("turns down other questions from Hermes that it can't show", async () => {
    const { server, runtime, chat } = await replying();
    const id = server.ask(runtime, "clarify", { request_id: "c1", question: "Which logs?", choices: ["all", "old"] });
    expect(server.responses).toEqual([{ jsonrpc: "2.0", id, error: { code: -32601, message: "Hermes Chat can't answer clarify requests yet." } }]);
    expect(chat().items.some((i) => i.kind === "approval")).toBe(false);
  });

  it("says so when the answer can't go, and keeps the card waiting", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.drop();
    await hermes.answerApproval(chatId, id!, "once");
    expect(server.responses).toEqual([]);
    expect(card()).toMatchObject({ answer: undefined });
    expect(chat().items.at(-1)).toMatchObject({ kind: "error", text: "Couldn't answer Hermes: Not connected to Hermes." });
  });
});

describe("Approvals after a reconnect", () => {
  afterEach(() => void vi.useRealTimers());

  it("brings back a card still waiting, without the owner opening the chat", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    server.transcripts[chatId] = [{ role: "user", text: "Clean up the logs" }];
    const { id, requestId } = server.askApproval(runtime);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    expect(chat().items.filter((i) => i.kind === "approval")).toEqual([
      { kind: "approval", id, requestId, command: "rm -rf /var/log/old", description: "recursive delete" },
    ]);
    // The stored history replaces what was shown before the drop, so the card isn't doubled.
    expect(chat().items.map((i) => i.kind)).toEqual(["user", "approval"]);
    expect(chat()).toMatchObject({ runtimeId: runtime, running: true });

    await hermes.answerApproval(chatId, id!, "once");
    expect(server.responses).toEqual([{ jsonrpc: "2.0", id, result: { choice: "once", all: false } }]);
    expect(card()).toMatchObject({ answer: "once" });
  });

  it("brings back a card Hermes asked for while the connection was down", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, card } = await replying();
    server.drop();
    const { id } = server.askApproval(runtime);
    expect(card()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(card()).toMatchObject({ id, command: "rm -rf /var/log/old" });
  });

  it("tells Hermes again that a card is on screen only if it hadn't before", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime } = await replying();
    await hermes.open(chatId);
    server.askApproval(runtime);
    await hermes.idle();
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    // The app opens the chat on screen again once it's back.
    await hermes.open(chatId);
    await hermes.idle();
    expect(received(server)).toHaveLength(1);
  });

  it("leaves chats that weren't waiting on anything closed", async () => {
    vi.useFakeTimers();
    const server = new FakeHermes();
    server.sessions = [row("s1", 1)];
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("s1");
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(server.requests.filter((r) => r.method === "session.resume")).toHaveLength(1);
  });

  it("closes a card whose session Hermes has let go of", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, chat } = await replying();
    const { id } = server.askApproval(runtime);
    server.drop();
    // The session was reaped while the app was away, and its request with it.
    server.openRequests.delete(id!);
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(chat().items.filter((i) => i.kind === "approval")).toMatchObject([{ id, ended: "lost" }]);
  });

  it("closes a waiting card if its chat can't be loaded again", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, card } = await replying();
    server.askApproval(runtime);
    server.drop();
    server.handlers["session.resume"] = (r) => server.fail(r.id, 4007, "session no longer live; retry resume");
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(card()).toMatchObject({ ended: "lost" });
  });

  it("shows a card that arrives just before the resume that reattaches its session has answered", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, card } = await replying();
    server.drop();
    server.handlers["session.resume"] = (r) => {
      // Hermes read the open requests for its answer, then wrote a new one on the reattached socket first.
      server.runtime.set(runtime, chatId);
      server.askApproval(runtime);
      server.respond(r.id, { session_id: runtime, stored_session_id: chatId, message_count: 0, messages: [], info: {}, running: true });
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(card()).toMatchObject({ command: "rm -rf /var/log/old" });
  });
  it("shows one card for a request that arrives early and is also listed by the resume", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    server.drop();
    const resume = server.handlers["session.resume"];
    server.handlers["session.resume"] = (r) => {
      server.runtime.set(runtime, chatId);
      server.askApproval(runtime);
      resume(r);
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(chat().items.filter((i) => i.kind === "approval")).toHaveLength(1);
  });
});
