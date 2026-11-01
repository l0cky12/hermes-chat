import { describe, expect, it } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { connect } from "./transport";

async function listed(transcript: TranscriptMessage[] = [], server = new FakeHermes()) {
  server.sessions = [row("tg", 2, { source: "telegram" })];
  server.transcripts = { tg: transcript };
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  return { server, hermes, chat: () => hermes.getSnapshot().chats.find((c) => c.id === "tg")! };
}

/** Holds back the server's answers to `session.resume` until the returned function is called. */
function holdResume(server: FakeHermes) {
  const resume = server.handlers["session.resume"];
  const held: (() => void)[] = [];
  server.handlers["session.resume"] = (r) => void held.push(() => resume(r));
  return () => held.splice(0).forEach((answer) => answer());
}

const resumes = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.resume");

describe("Opening a listed chat", () => {
  it("resumes it and shows its stored history", async () => {
    const { server, hermes, chat } = await listed([
      { role: "user", text: "How full is the NAS?", timestamp: 1 },
      { role: "assistant", text: "**82%** used.\n\n```sh\ndf -h /mnt/nas\n```", timestamp: 2 },
    ]);
    await hermes.open("tg");

    expect(resumes(server).map((r) => r.params)).toEqual([{ session_id: "tg", profile: "default", inline_images: false }]);
    expect(chat()).toMatchObject({ runtimeId: server.runtimeIdOf("tg"), loading: false, settled: true });
    expect(chat().items).toEqual([
      { kind: "user", id: "h-0", text: "How full is the NAS?" },
      { kind: "assistant", id: "h-1", text: "**82%** used.\n\n```sh\ndf -h /mnt/nas\n```" },
    ]);
  });

  it("shows stored tool calls in order, with their name, arguments and preview", async () => {
    const { hermes, chat } = await listed([
      { role: "user", text: "Fix the typo in the README" },
      { role: "assistant", text: "Let me look." },
      { role: "tool", name: "read_file", context: "README.md", tool_call_id: "c1", args: { path: "README.md" } },
      { role: "tool", name: "patch", context: "README.md", tool_call_id: "c2", args: { path: "README.md" }, content: '{"success": true}' },
      { role: "tool", name: "terminal", context: "git diff", tool_call_id: "c3", args: { command: "git diff" } },
      { role: "assistant", text: "Fixed." },
    ]);
    await hermes.open("tg");

    expect(chat().items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "tool", "assistant"]);
    expect(chat().items.slice(2, 4)).toEqual([
      { kind: "tool", id: "h-2", name: "read_file", args: { path: "README.md" }, preview: "README.md", status: "done" },
      { kind: "tool", id: "h-3", name: "patch", args: { path: "README.md" }, preview: "README.md", status: "done", result: '{"success": true}' },
    ]);
  });

  it("leaves out reasoning-only replies and timeline notes, but keeps every tool call", async () => {
    const { hermes, chat } = await listed([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "", reasoning: "Thinking about a greeting" },
      { role: "system", text: "Model switched to sonnet", display_kind: "model_switch" },
      { role: "tool", name: "todo", context: "" },
      { role: "assistant", text: "Hello!" },
    ]);
    await hermes.open("tg");
    expect(chat().items).toEqual([
      { kind: "user", id: "h-0", text: "Hi" },
      { kind: "tool", id: "h-3", name: "todo", status: "done" },
      { kind: "assistant", id: "h-4", text: "Hello!" },
    ]);
  });

  it("marks the chat as loading until the history arrives", async () => {
    const server = new FakeHermes();
    const answer = holdResume(server);
    const { hermes, chat } = await listed([{ role: "user", text: "Hi" }], server);

    const opening = hermes.open("tg");
    expect(chat()).toMatchObject({ loading: true, items: [] });
    answer();
    await opening;
    expect(chat()).toMatchObject({ loading: false, items: [{ kind: "user", text: "Hi" }] });
  });

  it("resumes a chat once per connection", async () => {
    const { server, hermes } = await listed();
    await Promise.all([hermes.open("tg"), hermes.open("tg")]);
    await hermes.open("tg");
    const id = await hermes.newChat();
    await hermes.open(id);
    expect(resumes(server)).toHaveLength(1);
  });

  it("puts a message sent while the history loads after the history, resuming only once", async () => {
    const server = new FakeHermes();
    const answer = holdResume(server);
    const { hermes, chat } = await listed(
      [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
      server,
    );

    const opening = hermes.open("tg");
    const sending = hermes.send("tg", "Follow-up");
    answer();
    await Promise.all([opening, sending]);

    expect(resumes(server)).toHaveLength(1);
    expect(chat().items.map((i) => ("text" in i ? i.text : i.kind))).toEqual(["Earlier question", "Earlier answer", "Follow-up"]);
    expect(server.last("prompt.submit")!.params).toMatchObject({ session_id: server.runtimeIdOf("tg"), text: "Follow-up" });
    // New items keep unique ids after the history.
    server.event(server.runtimeIdOf("tg")!, "message.delta", { text: "Sure" });
    expect(new Set(chat().items.map((i) => i.id)).size).toBe(4);
  });

  it("shows an error if the history can't load, and tries again on the next open", async () => {
    const { server, hermes, chat } = await listed([{ role: "user", text: "Hi" }]);
    const resume = server.handlers["session.resume"];
    server.handlers["session.resume"] = (r) => server.fail(r.id, 5000, "store busy");
    await hermes.open("tg");
    expect(chat()).toMatchObject({ loading: false, items: [{ kind: "error", text: "Couldn't load this chat: store busy" }] });
    expect(chat().runtimeId).toBeUndefined();

    server.handlers["session.resume"] = resume;
    await hermes.open("tg");
    expect(chat().items).toEqual([{ kind: "user", id: "h-0", text: "Hi" }]);
  });

  it("shows one error when a reply is sent while the history fails to load", async () => {
    const server = new FakeHermes();
    const answer = holdResume(server);
    const { hermes, chat } = await listed([], server);
    server.sessions = [];

    const opening = hermes.open("tg");
    const sending = hermes.send("tg", "Hi");
    answer();
    await Promise.all([opening, sending]);
    expect(chat().items.filter((i) => i.kind === "error")).toEqual([{ kind: "error", id: "e-1", text: "session not found: tg" }]);
  });
});
