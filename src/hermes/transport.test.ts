import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { APP_SOURCE, ProtocolMismatchError, connect } from "./transport";

async function signedIn() {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe);
  return {
    server,
    hermes,
    chat: (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!,
    runtime: (id: string) => server.runtimeIdOf(id)!,
  };
}

describe("Hermes transport", () => {
  it("connects once gateway.ready arrives", async () => {
    const { hermes } = await signedIn();
    expect(hermes.getSnapshot()).toEqual({ chats: [], status: "connected" });
  });

  it("refuses a server that speaks the canonical protocol", async () => {
    const server = new FakeHermes();
    server.readyPayload = { ...server.readyPayload, session_authority: true };
    await expect(connect(server.openPipe)).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(server.closed).toBe(true);
  });

  it("starts a new Active chat in the default profile, sourced from this app", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    expect(server.last("session.create")!.params).toEqual({ profile: "default", source: APP_SOURCE });
    expect(chat(id)).toMatchObject({ id: "20261031_120001_abc123", runtimeId: "rt-1", title: "New chat", source: "app", settled: false, items: [] });
  });

  it("sends a message and streams the reply into the chat", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "What's the disk usage on the NAS?");
    expect(server.last("prompt.submit")!.params).toEqual({ session_id: runtime(id), profile: "default", text: "What's the disk usage on the NAS?" });
    expect(chat(id)).toMatchObject({ title: "What's the disk usage on the NAS?", running: true });

    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.delta", { text: "It's at " });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: "It's at " });
    server.event(runtime(id), "message.delta", { text: "**92%**." });
    expect(chat(id).running).toBe(true);
    server.event(runtime(id), "message.complete", { text: "It's at **92%**.", status: "complete" });

    expect(chat(id).running).toBe(false);
    expect(chat(id).items.map((i) => [i.kind, "text" in i ? i.text : i.id])).toEqual([
      ["user", "What's the disk usage on the NAS?"],
      ["assistant", "It's at **92%**."],
    ]);
  });

  it("shows a reply that arrives only in message.complete", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "Hello!", status: "complete" });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello!" });
  });

  it("shows tool calls between reply segments", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "check disk");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.delta", { text: "Checking." });
    server.event(runtime(id), "tool.start", { tool_id: "t1", name: "terminal", args: { command: "df -h" }, preview: "df -h" });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "tool", status: "running", preview: "df -h" });
    server.event(runtime(id), "tool.complete", { tool_id: "t1", name: "terminal", duration_s: 0.2, result: "92% used", summary: "1 line" });
    server.event(runtime(id), "message.delta", { text: "92% used." });
    server.event(runtime(id), "message.complete", { text: "Checking.92% used.", status: "complete" });
    expect(chat(id).items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chat(id).items[2]).toMatchObject({ status: "done", durationS: 0.2, result: "92% used", summary: "1 line" });
  });

  it("shows a failed turn as an error", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "", status: "error", error: "Provider returned 529 overloaded" });
    expect(chat(id)).toMatchObject({ running: false });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "error", text: "Provider returned 529 overloaded" });
  });

  it("shows a refused prompt as an error", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.handlers["prompt.submit"] = (r) => server.fail(r.id, 4009, "session busy");
    await hermes.send(id, "hi");
    expect(chat(id)).toMatchObject({ running: false });
    expect(chat(id).items.at(-1)).toMatchObject({ kind: "error", text: "session busy" });
  });

  it("ignores events for chats it doesn't have", async () => {
    const { server, hermes } = await signedIn();
    await hermes.newChat();
    const before = hermes.getSnapshot();
    server.event("someone-else", "message.delta", { text: "not ours" });
    expect(hermes.getSnapshot()).toBe(before);
  });

  it("goes offline when the connection drops mid-reply", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.drop("closed by the server (1006 )");
    expect(hermes.getSnapshot()).toMatchObject({ status: "offline", closedReason: "closed by the server (1006 )" });
    expect(chat(id).running).toBe(false);
    await expect(hermes.newChat()).rejects.toThrow("Not connected");
  });

  it("fails sign-in if the connection closes before gateway.ready", async () => {
    await expect(
      connect(async (onEvent) => {
        onEvent({ kind: "closed", reason: "closed by the server (4401 )" });
        return { send: async () => {}, request: async () => "", close: async () => {} };
      }),
    ).rejects.toThrow("4401");
  });
});
