import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";

/** A new chat with a reply under way. */
async function replying(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "Clean up the logs");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  return { server, hermes, id, runtime, chat: () => hermes.getSnapshot().chats.find((c) => c.id === id)! };
}

/** Holds back the server's answers to `method` until the returned function is called. */
function hold(server: FakeHermes, method: string) {
  const handler = server.handlers[method];
  const held: (() => void)[] = [];
  server.handlers[method] = (r) => void held.push(() => handler(r));
  return () => held.splice(0).forEach((answer) => answer());
}

const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");

describe("Stopping a reply", () => {
  it("interrupts the chat's session, and marks the reply as interrupted when the turn ends", async () => {
    const { server, hermes, id, runtime, chat } = await replying();
    server.event(runtime, "message.delta", { text: "Deleting old" });
    await hermes.stop(id);

    expect(interrupts(server).map((r) => r.params)).toEqual([{ session_id: runtime }]);
    // Hermes answers before the agent has stopped, so the reply keeps running until the turn ends.
    expect(chat()).toMatchObject({ running: true, stopping: true });
    server.event(runtime, "message.delta", { text: " logs" });

    server.event(runtime, "message.complete", { text: "Deleting old logs", status: "interrupted" });
    expect(chat()).toMatchObject({ running: false, stopping: false });
    expect(chat().items.slice(1)).toEqual([{ kind: "assistant", id: "a-1", text: "Deleting old logs", interrupted: true }]);
  });

  it("marks running tool calls as stopped, and leaves finished ones alone", async () => {
    const { server, hermes, id, runtime, chat } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal", preview: "du -sh /var/log" });
    server.event(runtime, "tool.complete", { tool_id: "t1", name: "terminal", result: "4.1G" });
    server.event(runtime, "tool.start", { tool_id: "t2", name: "terminal", preview: "rm -rf /var/log/old" });
    await hermes.stop(id);
    server.event(runtime, "message.complete", { text: "", status: "interrupted" });

    expect(chat().items.map((i) => (i.kind === "tool" ? i.status : i.kind))).toEqual(["user", "done", "stopped", "assistant"]);
    // A reply stopped before it said anything still shows that it was interrupted.
    expect(chat().items.at(-1)).toEqual({ kind: "assistant", id: "a-3", text: "", interrupted: true });
  });

  it("marks a reply stopped from another Hermes client the same way", async () => {
    const { server, runtime, chat } = await replying();
    server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal", preview: "du -sh /var/log" });
    server.event(runtime, "message.complete", { text: "I was checking the size", status: "interrupted", partial: true });

    expect(chat().running).toBe(false);
    expect(chat().items.slice(1)).toEqual([
      { kind: "tool", id: "t1", name: "terminal", preview: "du -sh /var/log", args: undefined, status: "stopped" },
      { kind: "assistant", id: "a-2", text: "I was checking the size", interrupted: true },
    ]);
  });

  it("leaves a reply that finished before the stop reached Hermes as it is", async () => {
    const { server, hermes, id, runtime, chat } = await replying();
    const answer = hold(server, "session.interrupt");
    server.event(runtime, "message.delta", { text: "All done." });

    const stopping = hermes.stop(id);
    server.event(runtime, "message.complete", { text: "All done.", status: "complete" });
    answer();
    await stopping;

    expect(chat()).toMatchObject({ running: false, stopping: false });
    expect(chat().items.at(-1)).toEqual({ kind: "assistant", id: "a-1", text: "All done." });
  });

  it("asks Hermes once while the reply is stopping", async () => {
    const { server, hermes, id } = await replying();
    await Promise.all([hermes.stop(id), hermes.stop(id)]);
    await hermes.stop(id);
    expect(interrupts(server)).toHaveLength(1);
  });

  it("waits until Hermes has accepted the message before interrupting", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const id = await hermes.newChat();
    const accept = hold(server, "prompt.submit");

    const sending = hermes.send(id, "Clean up the logs");
    const stopping = hermes.stop(id);
    await Promise.resolve();
    expect(interrupts(server)).toHaveLength(0);

    accept();
    await Promise.all([sending, stopping]);
    expect(server.requests.map((r) => r.method).slice(-2)).toEqual(["prompt.submit", "session.interrupt"]);
  });

  it("keeps the reply running and shows an error if Hermes can't stop it", async () => {
    const { server, hermes, id, chat } = await replying();
    server.handlers["session.interrupt"] = (r) => server.fail(r.id, 4001, "session not found");
    await hermes.stop(id);

    expect(chat()).toMatchObject({ running: true, stopping: false });
    expect(chat().items.at(-1)).toEqual({ kind: "error", id: "e-1", text: "Couldn't stop the reply: session not found" });
  });

  it("ends a stopping reply without an extra error when the connection drops", async () => {
    const { server, hermes, id, chat } = await replying();
    const answer = hold(server, "session.interrupt");
    const stopping = hermes.stop(id);
    server.drop();
    answer();
    await stopping;

    expect(chat()).toMatchObject({ running: false, stopping: false });
    expect(chat().items.map((i) => i.kind)).toEqual(["user"]);
  });

  it("does nothing for a chat with no reply under way", async () => {
    const { server, hermes, id, runtime } = await replying();
    server.event(runtime, "message.complete", { text: "Done.", status: "complete" });
    await hermes.stop(id);
    expect(interrupts(server)).toHaveLength(0);
  });
});
