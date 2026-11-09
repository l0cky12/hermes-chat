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
/** The answers sent through Hermes's approval queue, which Hermes withdraws from every other app. */
const responded = (server: FakeHermes) => server.requests.filter((r) => r.method === "approval.respond").map((r) => r.params);

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

    expect(card()).toEqual({
      kind: "approval",
      id,
      requestId,
      command: "rm -rf /var/log/old",
      description: "recursive delete",
      choices: ["once", "session", "always", "deny"],
      allowSession: true,
      allowPermanent: true,
    });
    expect(chat().items.at(-1)).toBe(card());
    expect(chat().running).toBe(true);
  });

  it("keeps the choices Hermes offers and its limits on broader grants", async () => {
    const { server, runtime, card } = await replying();
    server.askApproval(runtime, {
      choices: ["once", "deny", "forever"],
      allow_session: false,
      allow_permanent: false,
    });
    // A choice this app doesn't know is dropped, not shown.
    expect(card()).toMatchObject({ choices: ["once", "deny"], allowSession: false, allowPermanent: false });
  });

  it("rules out the broader grants when Hermes doesn't say they're allowed", async () => {
    const { server, runtime, card } = await replying();
    server.askApproval(runtime, { allow_session: undefined, allow_permanent: undefined });
    expect(card()).toMatchObject({ allowSession: false, allowPermanent: false });
  });

  it("approves the command once", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "once");

    expect(responded(server)).toEqual([{ session_id: runtime, choice: "once", request_id: requestId }]);
    expect(server.responses).toEqual([]);
    expect(server.openRequests.size).toBe(0);
    // Hermes withdraws the request from every app on the chat, this one too, but the card keeps the owner's answer.
    expect(card()).toEqual(expect.objectContaining({ answer: "once" }));
    expect(card()).not.toHaveProperty("ended");
  });

  it("denies the command", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "deny");

    expect(responded(server)).toEqual([{ session_id: runtime, choice: "deny", request_id: requestId }]);
    expect(card()).toMatchObject({ answer: "deny" });
  });

  it("sends only a choice Hermes offered and allows", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    // Hermes lists every choice but rules out the broader grants.
    const { id, requestId } = server.askApproval(runtime, { allow_session: false, allow_permanent: false });
    await hermes.answerApproval(chatId, id!, "session", true);
    await hermes.answerApproval(chatId, id!, "always", true);
    expect(responded(server)).toEqual([]);
    expect(card()).not.toHaveProperty("answer");

    const second = server.askApproval(runtime, { choices: ["once", "deny"] });
    await hermes.answerApproval(chatId, second.id!, "always", true);
    expect(responded(server)).toEqual([]);

    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "once", request_id: requestId }]);
  });

  it("allows the command for the chat, or always, only once the owner confirms it", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "session");
    await hermes.answerApproval(chatId, id!, "always");
    expect(responded(server)).toEqual([]);
    expect(card()).not.toHaveProperty("answer");

    await hermes.answerApproval(chatId, id!, "always", true);
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "always", request_id: requestId }]);
    expect(card()).toMatchObject({ answer: "always" });
  });

  it("answers a card only once", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const { id } = server.askApproval(runtime);
    await hermes.answerApproval(chatId, id!, "once");
    await hermes.answerApproval(chatId, id!, "deny");
    expect(responded(server).map((p) => p.choice)).toEqual(["once"]);
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
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("sends one answer when the owner clicks again before the first has gone", async () => {
    const { server, hermes, id: chatId, runtime } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    await Promise.all([hermes.answerApproval(chatId, id!, "once"), hermes.answerApproval(chatId, id!, "once"), hermes.answerApproval(chatId, id!, "deny")]);
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "once", request_id: requestId }]);
  });

  it("never answers for the owner while Hermes waits, and closes the card when Hermes times out", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    // Longer than Hermes's own 300 s approval timeout.
    await vi.advanceTimersByTimeAsync(600_000);
    await hermes.idle();
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
    expect(card()).not.toHaveProperty("ended");

    server.cancelRequest(id!, "timeout");
    expect(card()).toMatchObject({ ended: "timeout" });
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("closes a card Hermes drops by its server request id", async () => {
    const { server, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.event(runtime, "approval.cancelled", { reason: "interrupted", cancelled_count: 1, request_ids: [id] });
    expect(card()).toMatchObject({ ended: "interrupted" });
  });

  it("closes the cards Hermes drops when it tears the session down", async () => {
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    const first = server.askApproval(runtime);
    const second = server.askApproval(runtime);
    const kept = server.askApproval(runtime);
    server.event(runtime, "approval.cancelled", {
      stored_session_id: chatId,
      reason: "interrupted",
      cancelled_count: 2,
      request_ids: [first.requestId, second.requestId],
    });
    expect(chat().items.filter((i) => i.kind === "approval").map((i) => ("ended" in i ? i.ended : undefined))).toEqual([
      "interrupted",
      "interrupted",
      undefined,
    ]);

    await hermes.answerApproval(chatId, first.id!, "once");
    expect(responded(server)).toEqual([]);
    await hermes.answerApproval(chatId, kept.id!, "once");
    expect(responded(server)).toHaveLength(1);
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
    expect(responded(server)).toEqual([]);
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
      expect.objectContaining({ kind: "approval", id, requestId, command: "rm -rf /var/log/old", description: "recursive delete" }),
    ]);
    // The stored history replaces what was shown before the drop, so the card isn't doubled.
    expect(chat().items.map((i) => i.kind)).toEqual(["user", "approval"]);
    expect(chat()).toMatchObject({ runtimeId: runtime, running: true });

    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "once", request_id: requestId }]);
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

  it("doesn't bring back a card the owner answered, though Hermes lists it again", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    const { id } = server.askApproval(runtime);
    const asked = server.openRequests.get(id!)!;
    await hermes.answerApproval(chatId, id!, "deny");
    // The answer was lost on the way, so Hermes still lists the request when the chat resumes.
    server.openRequests.set(id!, asked);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    expect(chat().items.filter((i) => i.kind === "approval" && !i.answer)).toEqual([]);
    expect(chat().items.at(-1)).toMatchObject({
      kind: "error",
      text: "Your answer to “rm -rf /var/log/old” didn't reach Hermes before the connection dropped. Hermes stops waiting on its own.",
    });
    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server).map((p) => p.choice)).toEqual(["deny"]);
  });

  it("doesn't bring back a card Hermes dropped with the session, though it lists it again", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    server.event(runtime, "approval.cancelled", { reason: "interrupted", cancelled_count: 1, request_ids: [requestId] });
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    expect(chat().items.filter((i) => i.kind === "approval" && !i.ended)).toEqual([]);
    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("doesn't bring back a card Hermes stopped waiting on, though it lists it again", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, chat } = await replying();
    const { id } = server.askApproval(runtime);
    const asked = server.openRequests.get(id!)!;
    server.cancelRequest(id!, "timeout");
    server.openRequests.set(id!, asked);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    expect(chat().items.filter((i) => i.kind === "approval" && !i.ended)).toEqual([]);
    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("doesn't answer a card from before the drop until its chat is loaded again", async () => {
    vi.useFakeTimers();
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    const resume = server.handlers["session.resume"];
    let reload = () => {};
    server.handlers["session.resume"] = (r) => (reload = () => resume(r));
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes.getSnapshot().status).toBe("connected");

    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([]);
    expect(card()).not.toHaveProperty("answer");

    reload();
    await hermes.idle();
    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "once", request_id: requestId }]);
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

describe("Approvals on a chat another Hermes app also has open", () => {
  it("closes the card when the other app answers it", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.answerElsewhere(id!, "approval.respond");
    expect(card()).toMatchObject({ ended: "resolved" });

    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("says a card was answered in the other app when the owner answers it here after", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const { id, requestId } = server.askApproval(runtime);
    // An older app answers in reply to the request, so Hermes withdraws it from no other app.
    server.answerElsewhere(id!, "response");
    expect(card()).not.toHaveProperty("ended");

    await hermes.answerApproval(chatId, id!, "deny");
    expect(responded(server)).toEqual([{ session_id: runtime, choice: "deny", request_id: requestId }]);
    expect(card()).toMatchObject({ answer: undefined, ended: "resolved" });
    expect(chat().items.some((i) => i.kind === "error")).toBe(false);
  });

  it("closes a card the other app answered once Hermes lists the chat as not waiting", async () => {
    const { server, hermes, runtime, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.answerElsewhere(id!, "response");
    await hermes.checkLive();
    expect(card()).toMatchObject({ ended: "not waiting" });
    expect(card()).not.toHaveProperty("answer");
  });

  it("keeps a card waiting while Hermes lists its chat as waiting", async () => {
    const { server, hermes, runtime, card } = await replying();
    server.askApproval(runtime);
    await hermes.checkLive();
    expect(server.requests.some((r) => r.method === "session.active_list")).toBe(true);
    expect(card()).not.toHaveProperty("ended");
  });

  it("keeps a card that arrives while Hermes is listing what waits", async () => {
    const { server, hermes, runtime, card } = await replying();
    // Hermes lists the chat as working: the request opens after the list is made, before the app reads it.
    server.handlers["session.active_list"] = (r) => server.respond(r.id, { sessions: [{ id: runtime, session_key: "x", status: "working", last_active: 1 }] });
    const checked = hermes.checkLive();
    server.askApproval(runtime);
    await checked;
    expect(card()).not.toHaveProperty("ended");
  });

  it("answers in reply to Hermes's request on a Hermes without approval.respond, and asks it no more", async () => {
    const server = new FakeHermes();
    server.approvalRespond = false;
    const { hermes, id: chatId, runtime, chat } = await replying(server);
    const first = server.askApproval(runtime);
    const second = server.askApproval(runtime);

    await hermes.answerApproval(chatId, first.id!, "once");
    expect(responded(server)).toHaveLength(1);
    expect(server.responses).toEqual([{ jsonrpc: "2.0", id: first.id, result: { choice: "once", all: false } }]);
    expect(hermes.capabilities.get("approvalAnswers").state).toBe("unsupported");

    await hermes.answerApproval(chatId, second.id!, "deny");
    expect(responded(server)).toHaveLength(1);
    expect(server.responses.map((r) => [r.id, r.result?.choice])).toEqual([
      [first.id, "once"],
      [second.id, "deny"],
    ]);
    expect(server.openRequests.size).toBe(0);
    expect(chat().items.filter((i) => i.kind === "approval").map((i) => ("answer" in i ? i.answer : undefined))).toEqual(["once", "deny"]);
    expect(chat().items.some((i) => i.kind === "error")).toBe(false);
  });

  it("answers in reply to Hermes's request when the card has no request id", async () => {
    const { server, hermes, id: chatId, runtime, card } = await replying();
    const { id } = server.askApproval(runtime, { request_id: "" });
    await hermes.answerApproval(chatId, id!, "once");
    expect(responded(server)).toEqual([]);
    expect(server.responses).toEqual([{ jsonrpc: "2.0", id, result: { choice: "once", all: false } }]);
    expect(card()).toMatchObject({ answer: "once" });
  });

  it("says so when Hermes refuses the answer, keeps the card waiting, and doesn't answer another way", async () => {
    const { server, hermes, id: chatId, runtime, chat, card } = await replying();
    const { id } = server.askApproval(runtime);
    server.handlers["approval.respond"] = (r) => server.fail(r.id, 5004, "approval queue unavailable");
    await hermes.answerApproval(chatId, id!, "once");
    expect(server.responses).toEqual([]);
    expect(card()).toMatchObject({ answer: undefined });
    expect(card()).not.toHaveProperty("ended");
    expect(chat().items.at(-1)).toMatchObject({ kind: "error", text: "Couldn't answer Hermes: approval queue unavailable" });
  });
});
