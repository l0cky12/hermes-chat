import { describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { connect } from "./transport";
import { RestError } from "./pipe";

/** A stored time, Unix seconds, as Hermes keeps it. */
const T = 1_793_620_000;

async function listed(transcript: TranscriptMessage[] = [], server = new FakeHermes()) {
  server.sessions = [row("a", 1)];
  server.transcripts = { a: transcript };
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  return { server, hermes, items: () => hermes.getSnapshot().chats.find((c) => c.id === "a")!.items };
}

/** Answers dashboard REST `GET /api/sessions/a/messages` with these stored rows. */
function storedRows(server: FakeHermes, rows: { id: number; role: string; content: string; timestamp: number | null }[]) {
  server.rest["GET /api/sessions/a/messages"] = () => ({ session_id: "a", profile: "default", messages: rows, pagination: {} });
}

const messageReads = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/sessions/a/messages");

/** The end of a turn whose stored rows Hermes names (`persisted_turn`). */
const completed = (text: string, turn: Record<string, unknown>) => ({ text, status: "complete", persisted_turn: { complete: true, ...turn } });

describe("Times on stored history", () => {
  it("shows each message and reply with the time of its own stored row", async () => {
    const { hermes, items } = await listed([
      { role: "user", text: "How full is the NAS?", timestamp: T, row_id: 1 },
      { role: "assistant", text: "Let me look.", reasoning: "Check df", timestamp: T + 2, row_id: 2 },
      { role: "tool", name: "terminal", context: "df -h", tool_call_id: "c1", timestamp: T + 3 },
      { role: "assistant", text: "82% used.", timestamp: T + 9, row_id: 4 },
    ]);
    await hermes.open("a");

    expect(items()).toEqual([
      { kind: "user", id: "h-0", text: "How full is the NAS?", at: T * 1000, rowId: 1 },
      { kind: "thinking", id: "h-1-r", text: "Check df" },
      { kind: "assistant", id: "h-1", text: "Let me look.", at: (T + 2) * 1000, rowId: 2 },
      { kind: "tool", id: "h-2", callId: "c1", name: "terminal", preview: "df -h", status: "done" },
      { kind: "assistant", id: "h-3", text: "82% used.", at: (T + 9) * 1000, rowId: 4 },
    ]);
  });

  it("leaves the time off a row stored without a usable one", async () => {
    const { hermes, items } = await listed([
      { role: "user", text: "no time" },
      { role: "assistant", text: "zero", timestamp: 0 },
      { role: "user", text: "negative", timestamp: -5 },
      { role: "assistant", text: "past year 275760", timestamp: 1e13 },
      { role: "user", text: "fine", timestamp: T },
    ]);
    await hermes.open("a");

    expect(items().map((i) => (i.kind === "user" || i.kind === "assistant" ? i.at : "other"))).toEqual([undefined, undefined, undefined, undefined, T * 1000]);
    expect(items().filter((i) => "at" in i)).toHaveLength(1);
  });

  it("keeps each time with its own message when the chat is opened again after a reconnect", async () => {
    const { server, hermes, items } = await listed([
      { role: "user", text: "First", timestamp: T },
      { role: "assistant", text: "One", timestamp: T + 1 },
    ]);
    await hermes.open("a");
    server.transcripts.a = [
      ...server.transcripts.a,
      { role: "user", text: "Second", timestamp: T + 60 },
      { role: "assistant", text: "Two", timestamp: T + 61 },
    ];

    server.drop();
    await hermes.reconnect();
    await hermes.open("a");

    expect(items().map((i) => [i.kind === "user" || i.kind === "assistant" ? i.text : i.kind, "at" in i ? i.at : undefined])).toEqual([
      ["First", T * 1000],
      ["One", (T + 1) * 1000],
      ["Second", (T + 60) * 1000],
      ["Two", (T + 61) * 1000],
    ]);
  });
});

describe("Times on a turn sent from here", () => {
  it("shows the message and its final reply with the times of the rows Hermes names, not of rows with the same words", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      // The same words, sent earlier: a different row.
      { id: 7, role: "user", content: "Disk usage?", timestamp: T - 3600 },
      { id: 8, role: "assistant", content: "82% used.", timestamp: T - 3590 },
      { id: 41, role: "user", content: "Disk usage?", timestamp: T },
      { id: 42, role: "assistant", content: "Let me look.", timestamp: T + 2 },
      { id: 43, role: "tool", content: "...", timestamp: T + 3 },
      { id: 44, role: "assistant", content: "82% used.", timestamp: T + 9 },
    ]);
    await hermes.send("a", "Disk usage?");
    const rt = server.runtimeIdOf("a")!;
    // No time while the turn runs.
    expect(items()).toEqual([{ kind: "user", id: "u-0", text: "Disk usage?" }]);
    server.event(rt, "message.delta", { text: "Let me look." });
    server.event(rt, "tool.start", { tool_id: "c1", name: "terminal" });
    server.event(rt, "tool.complete", { tool_id: "c1" });
    server.event(rt, "message.delta", { text: "82% used." });
    server.event(rt, "message.complete", completed("82% used.", { row_ids: [41, 42, 43, 44], user_row_id: 41, final_assistant_row_id: 44 }));
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Disk usage?", at: T * 1000 },
      { kind: "assistant", id: "a-1", text: "Let me look." },
      expect.objectContaining({ kind: "tool", id: "c1" }),
      { kind: "assistant", id: "a-3", text: "82% used.", at: (T + 9) * 1000, rowId: 44 },
    ]);
    expect(Object.fromEntries(messageReads(server)[0].query)).toEqual({ profile: "default", order: "latest", limit: "100", inline_images: "false" });
  });

  it("keeps the times in the chat's Saved copy", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [] };
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, undefined, cache);
    await hermes.sync();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Disk usage?", timestamp: T },
      { id: 42, role: "assistant", content: "82% used.", timestamp: T + 9 },
    ]);
    await hermes.send("a", "Disk usage?");
    const rt = server.runtimeIdOf("a")!;
    server.event(rt, "message.delta", { text: "82% used." });
    server.event(rt, "message.complete", completed("82% used.", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();

    expect(cache.loadTranscript("default", "a")?.items).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Disk usage?", at: T * 1000 },
      { kind: "assistant", id: "a-1", text: "82% used.", at: (T + 9) * 1000, rowId: 42 },
    ]);
  });

  it("leaves the times off when the named rows aren't on the stored page, even if rows with the same words are", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 7, role: "user", content: "Hi", timestamp: T - 3600 },
      { id: 8, role: "assistant", content: "Hello!", timestamp: T - 3590 },
    ]);
    await hermes.send("a", "Hi");
    const rt = server.runtimeIdOf("a")!;
    server.event(rt, "message.delta", { text: "Hello!" });
    server.event(rt, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Hi" },
      { kind: "assistant", id: "a-1", text: "Hello!", rowId: 42 },
    ]);
  });

  it("times only the message when the turn's receipt names another message", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Hi", timestamp: T },
      { id: 50, role: "user", content: "Other", timestamp: T + 5 },
      { id: 51, role: "assistant", content: "Hello!", timestamp: T + 6 },
    ]);
    await hermes.send("a", "Hi");
    const rt = server.runtimeIdOf("a")!;
    server.event(rt, "message.delta", { text: "Hello!" });
    server.event(rt, "message.complete", completed("Hello!", { row_ids: [50, 51], user_row_id: 50, final_assistant_row_id: 51 }));
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Hi", at: T * 1000 },
      { kind: "assistant", id: "a-1", text: "Hello!" },
    ]);
  });

  it("times only the message of a stopped turn, which has no stored final reply", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Write an essay", timestamp: T },
      { id: 42, role: "assistant", content: "Once", timestamp: T + 4 },
    ]);
    await hermes.send("a", "Write an essay");
    const rt = server.runtimeIdOf("a")!;
    server.event(rt, "message.delta", { text: "Once" });
    server.event(rt, "message.complete", { text: "Once", status: "interrupted", persisted_turn: { row_ids: [41, 42], complete: false, user_row_id: 41 } });
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Write an essay", at: T * 1000 },
      { kind: "assistant", id: "a-1", text: "Once", interrupted: true },
    ]);
  });

  it("reads no times when Hermes didn't say which row holds the message", async () => {
    const { server, hermes, items } = await listed();
    storedRows(server, [{ id: 41, role: "user", content: "Hi", timestamp: T }]);
    await hermes.send("a", "Hi");
    server.event(server.runtimeIdOf("a")!, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();

    expect(messageReads(server)).toHaveLength(0);
    expect(items().some((i) => "at" in i)).toBe(false);
  });

  it("leaves the time off a named row stored without one", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Hi", timestamp: null },
      { id: 42, role: "assistant", content: "Hello!", timestamp: 0 },
    ]);
    await hermes.send("a", "Hi");
    server.event(server.runtimeIdOf("a")!, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Hi" },
      { kind: "assistant", id: "a-1", text: "Hello!", rowId: 42 },
    ]);
  });

  it("shows no times, and no error, when the stored rows can't be read", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    server.rest["GET /api/sessions/a/messages"] = () => {
      throw new RestError(500, "", "The dashboard answered 500");
    };
    await hermes.send("a", "Hi");
    server.event(server.runtimeIdOf("a")!, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Hi" },
      { kind: "assistant", id: "a-1", text: "Hello!", rowId: 42 },
    ]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("still times the turn when it ends before Hermes has answered the send", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Hi", timestamp: T },
      { id: 42, role: "assistant", content: "Hello!", timestamp: T + 1 },
    ]);
    const submit = server.handlers["prompt.submit"];
    let answer = () => {};
    server.handlers["prompt.submit"] = (r) => void (answer = () => submit(r));
    const sending = hermes.send("a", "Hi");
    await vi.waitFor(() => expect(server.last("prompt.submit")).toBeDefined());
    server.event(server.runtimeIdOf("a")!, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    answer();
    await sending;
    await hermes.idle();

    expect(items()).toEqual([
      { kind: "user", id: "u-0", rowId: 41, text: "Hi", at: T * 1000 },
      { kind: "assistant", id: "a-1", text: "Hello!", at: (T + 1) * 1000, rowId: 42 },
    ]);
  });

  it("shows the stored times from history once the chat is opened again after a reconnect", async () => {
    const { server, hermes, items } = await listed();
    server.userRowId = 41;
    storedRows(server, [
      { id: 41, role: "user", content: "Hi", timestamp: T },
      { id: 42, role: "assistant", content: "Hello!", timestamp: T + 1 },
    ]);
    await hermes.send("a", "Hi");
    server.event(server.runtimeIdOf("a")!, "message.delta", { text: "Hello!" });
    server.event(server.runtimeIdOf("a")!, "message.complete", completed("Hello!", { row_ids: [41, 42], user_row_id: 41, final_assistant_row_id: 42 }));
    await hermes.idle();
    server.transcripts.a = [
      { role: "user", text: "Hi", timestamp: T, row_id: 41 },
      { role: "assistant", text: "Hello!", timestamp: T + 1, row_id: 42 },
    ];

    server.drop();
    await hermes.reconnect();
    await hermes.open("a");

    expect(items()).toEqual([
      { kind: "user", id: "h-0", rowId: 41, text: "Hi", at: T * 1000 },
      { kind: "assistant", id: "h-1", text: "Hello!", at: (T + 1) * 1000, rowId: 42 },
    ]);
  });
});
