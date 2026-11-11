// Token usage and cost through the transport (ADR 0008): each reply measured from its session's live counters, never
// twice, and each chat's totals and cost as Hermes stored them.
import { describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import type { Item } from "./model";
import { connect, type Hermes } from "./transport";
import { RestError } from "./pipe";

/** `_get_usage` as `message.complete` carries it: running totals since the session's agent was built. */
const counters = (input: number, cached: number, output: number, calls: number, model = "z-ai/glm-5.3-flash", reasoning = 0) => ({
  model,
  input,
  output,
  reasoning,
  prompt: input + cached,
  completion: output,
  total: input + cached + output,
  calls,
  // Hermes sends it only when the session has read the cache.
  ...(cached > 0 && { cache_hit_pct: Math.round((cached / (input + cached)) * 100) }),
});

/** One turn: Hermes starts it, streams `text`, and ends it with the session's counters by then. */
function turn(server: FakeHermes, rt: string, text: string, usage: unknown, extra: Record<string, unknown> = {}) {
  server.event(rt, "message.start");
  server.event(rt, "message.delta", { text });
  server.event(rt, "message.complete", { text, status: "complete", usage, ...extra });
}

const replies = (hermes: Hermes, id: string) =>
  hermes
    .getSnapshot()
    .chats.find((c) => c.id === id)!
    .items.filter((i): i is Extract<Item, { kind: "assistant" | "error" }> => i.kind === "assistant" || i.kind === "error")
    .map((i) => [i.text, i.usage] as const);

async function newChat(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  return { server, hermes, id, rt: server.runtimeIdOf(id)! };
}

describe("Usage per reply", () => {
  it("is how far the session's counters moved during each turn", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Disk usage?");
    turn(server, rt, "82% used.", counters(1200, 4000, 300, 2, undefined, 50));
    await hermes.send(id, "And the NAS?");
    turn(server, rt, "61% used.", counters(1500, 8000, 420, 3, undefined, 50));
    await hermes.idle();

    expect(replies(hermes, id)).toEqual([
      ["82% used.", { prompt: 5200, input: 1200, cache: 4000, output: 300, reasoning: 50, calls: 2, model: "z-ai/glm-5.3-flash" }],
      ["61% used.", { prompt: 4300, input: 300, cache: 4000, output: 120, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
    ]);
  });

  it("keeps a reply's input whole when Hermes can't say how much was cached, leaving its cost to the chat (#53)", async () => {
    // A new chat's first turn on OpenRouter that read nothing from the cache: Hermes sends `input` equal to `prompt`
    // and no `cache_hit_pct`, which is also what it sends for input all written to the cache. No cost on the live feed.
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [] };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.send("a", "Hi");
    // The stored row, written by the time the turn ends, splits the cache and has Hermes's estimate.
    Object.assign(server.sessions[0], {
      input_tokens: 59292,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 7,
      reasoning_tokens: 1,
      api_call_count: 1,
      estimated_cost_usd: 0.0059,
      cost_status: "estimated",
      cost_source: "provider_models_api",
    });
    turn(server, server.runtimeIdOf("a")!, "Hello!", counters(59292, 0, 7, 1, undefined, 1));
    await hermes.idle();

    expect(replies(hermes, "a")).toEqual([["Hello!", { prompt: 59292, output: 7, reasoning: 1, calls: 1, model: "z-ai/glm-5.3-flash" }]]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "a")!.usage).toMatchObject({
      input: 59292,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 1,
      cost: { kind: "estimated", usd: 0.0059, source: "provider_models_api" },
    });
  });

  it("counts only model calls after retrying a rejected send and saves its reply row before timestamps arrive", async () => {
    const server = new FakeHermes();
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, undefined, cache);
    const id = await hermes.newChat();
    const rt = server.runtimeIdOf(id)!;
    await hermes.send(id, "First");
    turn(server, rt, "First reply", counters(100, 400, 10, 1));
    server.rejectPrompt = { code: 4009, message: "session busy" };
    expect(await hermes.send(id, "Try again")).toMatchObject({ delivery: "unsent" });
    const failed = hermes.getSnapshot().chats.find((c) => c.id === id)!.items.at(-1)!;
    server.rejectPrompt = undefined;
    server.userRowId = 41;
    expect(await hermes.retry(id, failed.id)).toEqual({ delivery: "accepted" });
    turn(server, rt, "Retried reply", counters(150, 600, 30, 2), {
      persisted_turn: { complete: true, user_row_id: 41, final_assistant_row_id: 42 },
    });
    await hermes.idle();
    const usage = { prompt: 250, input: 50, cache: 200, output: 20, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" };
    expect(replies(hermes, id).at(-1)).toEqual(["Retried reply", usage]);
    expect(cache.loadTranscript("default", id)?.items.at(-1)).toMatchObject({ kind: "assistant", rowId: 42, usage });
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)!.items.filter((i) => i.kind === "user" && i.text === "Try again")).toHaveLength(1);
  });

  it("keeps the running reply's usage when an older failed message is dismissed", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "First");
    turn(server, rt, "First reply", counters(100, 400, 10, 1));
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes.send(id, "Rejected");
    const failed = hermes.getSnapshot().chats.find((c) => c.id === id)!.items.at(-1)!;
    server.rejectPrompt = undefined;
    await hermes.send(id, "Next");
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "Next reply" });
    // Edit uses the same dismissal before putting the failed text in the draft.
    hermes.dismiss(id, failed.id);
    server.event(rt, "message.complete", { text: "Next reply", status: "complete", usage: counters(150, 600, 30, 2) });
    await hermes.idle();
    expect(replies(hermes, id)).toEqual([
      ["First reply", { prompt: 500, input: 100, cache: 400, output: 10, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
      ["Next reply", { prompt: 250, input: 50, cache: 200, output: 20, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
    ]);
  });

  it("isn't counted again when Hermes repeats the end of a turn", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    turn(server, rt, "Hello!", counters(100, 0, 10, 1));
    server.event(rt, "message.complete", { text: "Hello!", status: "complete", usage: counters(100, 0, 10, 1) });
    await hermes.send(id, "Bye");
    turn(server, rt, "Bye!", counters(150, 100, 15, 2));
    await hermes.idle();

    expect(replies(hermes, id)).toEqual([
      ["Hello!", { prompt: 100, output: 10, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
      ["Bye!", { prompt: 150, output: 5, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
    ]);
  });

  it("follows a model switch between turns, naming the model of each reply", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    turn(server, rt, "Hello!", counters(100, 0, 10, 1, "claude-sonnet-4-5"));
    await hermes.setModel(id, { provider: "openai", model: "gpt-5" });
    // Hermes reports the switch with the session's counters as they stand.
    server.event(rt, "session.info", { model: "gpt-5", provider: "openai", usage: counters(100, 0, 10, 1, "gpt-5") });
    await hermes.send(id, "Again");
    turn(server, rt, "Hi again.", counters(180, 0, 30, 2, "gpt-5"));
    await hermes.idle();

    expect(replies(hermes, id).map(([, u]) => u)).toEqual([
      { prompt: 100, output: 10, reasoning: 0, calls: 1, model: "claude-sonnet-4-5" },
      { prompt: 80, output: 20, reasoning: 0, calls: 1, model: "gpt-5" },
    ]);
  });

  it("counts from zero again when Hermes rebuilt the session's agent", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    turn(server, rt, "Hello!", counters(5000, 0, 500, 4));
    await hermes.send(id, "Again");
    turn(server, rt, "Again!", counters(300, 0, 20, 1));
    await hermes.idle();

    expect(replies(hermes, id)[1][1]).toEqual({ prompt: 300, output: 20, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" });
  });

  it("measures a resumed chat from the counters Hermes resumed it with", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [{ role: "user", text: "Earlier" }, { role: "assistant", text: "Before", row_id: 2 }] };
    const resume = server.handlers["session.resume"];
    // A session still live in Hermes, its agent built: `info.usage` is where it stands.
    server.handlers["session.resume"] = (r) => {
      const respond = server.respond.bind(server);
      server.respond = (rid, result) => respond(rid, { ...(result as object), info: { usage: counters(900, 0, 90, 3) } });
      resume(r);
      server.respond = respond;
    };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("a");
    await hermes.send("a", "Now");
    turn(server, server.runtimeIdOf("a")!, "Now then.", counters(1000, 0, 100, 4));
    await hermes.idle();

    expect(replies(hermes, "a")).toEqual([
      ["Before", undefined],
      ["Now then.", { prompt: 100, output: 10, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
    ]);
  });

  it("shows none for a turn reattached part of the way through, and measures the next", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [{ role: "user", text: "Long job" }] };
    server.handlers["session.resume"] = (r) =>
      server.respond(r.id, { session_id: "rt-live", stored_session_id: "a", messages: server.transcripts.a, info: { usage: counters(400, 0, 40, 2) }, running: true });
    server.runtime.set("rt-live", "a");
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("a");
    turn(server, "rt-live", "Done.", counters(2000, 0, 200, 6));
    await hermes.send("a", "Thanks");
    turn(server, "rt-live", "Welcome.", counters(2100, 0, 205, 7));
    await hermes.idle();

    expect(replies(hermes, "a")).toEqual([
      ["Done.", undefined],
      ["Welcome.", { prompt: 100, output: 5, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }],
    ]);
  });

  it("shows none for the turn after one that failed without its counters", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    turn(server, rt, "Hello!", counters(100, 0, 10, 1));
    await hermes.send(id, "Break");
    server.event(rt, "message.start");
    server.event(rt, "error", { message: "provider timeout" });
    await hermes.send(id, "Again");
    turn(server, rt, "Back.", counters(400, 0, 30, 4));
    await hermes.send(id, "Once more");
    turn(server, rt, "Still here.", counters(450, 0, 35, 5));
    await hermes.idle();

    expect(replies(hermes, id).map(([text, u]) => [text, u && u.calls])).toEqual([
      ["Hello!", 1],
      ["provider timeout", undefined],
      ["Back.", undefined],
      ["Still here.", 1],
    ]);
  });

  it("gives a failed turn's usage to its error", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    server.event(rt, "message.start");
    server.event(rt, "message.complete", { text: "", status: "error", error: "Rate limited", usage: counters(100, 0, 0, 3) });
    await hermes.idle();

    expect(replies(hermes, id)).toEqual([["Rate limited", { prompt: 100, output: 0, reasoning: 0, calls: 3, model: "z-ai/glm-5.3-flash" }]]);
  });

  it("shows none for a turn that made no model call, or whose counters Hermes didn't send", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    turn(server, rt, "Hello!", counters(100, 0, 10, 1));
    await hermes.send(id, "/help");
    turn(server, rt, "Commands: …", counters(100, 0, 10, 1));
    await hermes.send(id, "Old server");
    server.event(rt, "message.start");
    server.event(rt, "message.complete", { text: "No usage here.", status: "complete" });
    await hermes.send(id, "Next");
    turn(server, rt, "Unmeasured.", counters(200, 0, 20, 2));
    await hermes.idle();

    expect(replies(hermes, id).map(([text, u]) => [text, !!u])).toEqual([
      ["Hello!", true],
      ["Commands: …", false],
      ["No usage here.", false],
      ["Unmeasured.", false],
    ]);
  });

  it("starts again after a reconnect, which ends the session's runtime", async () => {
    const { server, hermes, id, rt } = await newChat();
    await hermes.send(id, "Hi");
    server.event(rt, "message.start");
    server.drop();
    await hermes.reconnect();
    await hermes.idle();
    // The old runtime's end, were it to arrive, belongs to no chat; the resumed one is measured from its own start.
    const rt2 = server.runtimeIdOf(id)!;
    expect(rt2).not.toBe(rt);
    await hermes.send(id, "Again");
    turn(server, rt2, "Back.", counters(70, 0, 7, 1));
    await hermes.idle();

    expect(replies(hermes, id).at(-1)).toEqual(["Back.", { prompt: 70, output: 7, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }]);
  });

  it("keeps a measured reply's usage in its Saved copy and after the chat loads again, by stored row", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [] };
    server.rest["GET /api/sessions/a/messages"] = () => ({ messages: [] });
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, undefined, cache);
    await hermes.sync();
    server.userRowId = 41;
    await hermes.send("a", "Hi");
    turn(server, server.runtimeIdOf("a")!, "Hello!", counters(100, 0, 10, 1), { persisted_turn: { complete: true, user_row_id: 41, final_assistant_row_id: 42 } });
    await hermes.idle();
    const measured = { prompt: 100, output: 10, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" };
    expect(cache.loadTranscript("default", "a")?.items[1]).toEqual({ kind: "assistant", id: "a-1", text: "Hello!", rowId: 42, usage: measured });

    // Restarted: the Saved copy shows first, then the stored history replaces it.
    server.transcripts.a = [
      { role: "user", text: "Hi", row_id: 41 },
      { role: "assistant", text: "Hello!", row_id: 42 },
      { role: "user", text: "From Telegram", row_id: 43 },
      { role: "assistant", text: "Unmeasured here.", row_id: 44 },
    ];
    await hermes.close();
    const again = await connect(server.openPipe, undefined, cache);
    await again.sync();
    await again.open("a");

    expect(replies(again, "a")).toEqual([
      ["Hello!", measured],
      ["Unmeasured here.", undefined],
    ]);
  });
  it("keeps the stored row with the usage at once, so a reload before the reply's time is read loses neither", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    server.transcripts = { a: [] };
    let answer = () => {};
    server.rest["GET /api/sessions/a/messages"] = () => new Promise((r) => (answer = () => r({ messages: [] })));
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, undefined, cache);
    await hermes.sync();
    server.userRowId = 41;
    await hermes.send("a", "Hi");
    turn(server, server.runtimeIdOf("a")!, "Hello!", counters(100, 0, 10, 1), { persisted_turn: { complete: true, user_row_id: 41, final_assistant_row_id: 42 } });
    await vi.waitFor(() => expect(cache.loadTranscript("default", "a")?.items[1]).toMatchObject({ rowId: 42, usage: { calls: 1 } }));

    // Restarted while the time read is still out.
    server.transcripts.a = [
      { role: "user", text: "Hi", row_id: 41 },
      { role: "assistant", text: "Hello!", row_id: 42 },
    ];
    const again = await connect(server.openPipe, undefined, cache);
    await again.sync();
    await again.open("a");
    answer();
    await hermes.idle();

    expect(replies(again, "a")).toEqual([["Hello!", { prompt: 100, output: 10, reasoning: 0, calls: 1, model: "z-ai/glm-5.3-flash" }]]);
  });
});

describe("Usage per chat", () => {
  const stored = {
    input_tokens: 42298,
    output_tokens: 1006,
    cache_read_tokens: 60160,
    cache_write_tokens: 0,
    reasoning_tokens: 183,
    api_call_count: 3,
    estimated_cost_usd: 0.0030129068,
    actual_cost_usd: null,
    cost_status: "estimated",
    cost_source: "provider_models_api",
  };

  it("comes with the chat list, imported chats included", async () => {
    const server = new FakeHermes();
    server.sessions = [row("tg", 1, { source: "telegram", ...stored }), row("old", 2)];
    const hermes = await connect(server.openPipe);
    await hermes.sync();

    const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat("tg").usage).toMatchObject({ input: 42298, cacheRead: 60160, calls: 3, cost: { kind: "estimated", usd: 0.0030129068 } });
    // A server that sends no counts: unknown, not zero.
    expect(chat("old").usage).toBeUndefined();
  });

  it("is read again from Hermes once a turn ends, replacing what was shown", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, stored)];
    server.transcripts = { a: [] };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.send("a", "Hi");
    Object.assign(server.sessions[0], { input_tokens: 50000, output_tokens: 1200, api_call_count: 4, estimated_cost_usd: 0.0036 });
    turn(server, server.runtimeIdOf("a")!, "Hello!", counters(100, 0, 10, 1));
    await hermes.idle();

    const chat = hermes.getSnapshot().chats.find((c) => c.id === "a")!;
    expect(chat.usage).toMatchObject({ input: 50000, output: 1200, calls: 4, cost: { kind: "estimated", usd: 0.0036 } });
  });

  it("keeps the newer totals when a list read older than them arrives", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, stored)];
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    Object.assign(server.sessions[0], { api_call_count: 5, input_tokens: 60000 });
    await hermes.refreshUsage("a");
    Object.assign(server.sessions[0], { api_call_count: 3, input_tokens: 42298 });
    await hermes.sync();

    expect(hermes.getSnapshot().chats[0].usage).toMatchObject({ calls: 5, input: 60000 });
  });

  it("says why it couldn't be read, keeping what was read before; a chat not stored yet isn't a failure", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, stored)];
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    server.rest["GET /api/sessions/a"] = () => {
      throw new RestError(500, "boom");
    };
    await hermes.refreshUsage("a");
    let chat = hermes.getSnapshot().chats[0];
    expect(chat.usageError).toBe("Couldn't read usage from Hermes: The dashboard answered 500: boom");
    expect(chat.usage).toMatchObject({ calls: 3 });

    const id = await hermes.newChat();
    await hermes.refreshUsage(id);
    chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat.usage).toBeUndefined();
    expect(chat.usageError).toBeUndefined();
  });

  it("is read for a chat opened from a search, which the list didn't bring", async () => {
    const server = new FakeHermes();
    server.sessions = [row("old", 60, { title: "Old pulls", ...stored })];
    server.transcripts = { old: [{ role: "user", text: "pull the repo" }] };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    expect(hermes.getSnapshot().chats).toEqual([]);
    const [found] = await hermes.search("pull");
    hermes.reveal(found);
    await hermes.open("old");
    await hermes.idle();

    expect(hermes.getSnapshot().chats.find((c) => c.id === "old")!.usage).toMatchObject({ calls: 3, cost: { kind: "estimated" } });
  });
});
