import { describe, expect, it } from "vitest";
import { chatJson, chatMarkdown } from "./exportChat";
import { FakeHermes, row } from "./fakeHermes";
import { IMPORTS_KEY, IMPORT_LIMITS, ImportFileError, ImportRefusedError, importLedger, planImport, type ImportPlan } from "./importTranscripts";
import { memoryCache } from "./memoryCache";
import type { Chat } from "./model";
import { connect } from "./transport";
import { RestError } from "./pipe";

const EXPORTED = new Date(Date.UTC(2026, 10, 2, 9, 30));

const chat: Chat = {
  id: "s1",
  title: "Deploy notes",
  source: "app",
  settled: false,
  updatedAt: 0,
  runtimeId: "rt",
  items: [
    { kind: "user", id: "u1", text: "Check the logs", attachments: ["../../../etc/passwd", "shot `1`.png"] },
    { kind: "thinking", id: "t1", text: "Look at journalctl.\n```\nnested fence\n```" },
    { kind: "tool", id: "c1", name: "terminal", args: { command: "journalctl -n 5" }, preview: "journalctl", status: "done", result: "line 1\nline 2", durationS: 2 },
    { kind: "tool", id: "c2", name: "read_file", status: "done" },
    { kind: "assistant", id: "a1", text: "Here they are:\n\n```sh\nls\n```\n\n**You:** not a header, it isn't after a blank line" },
    { kind: "approval", id: "p1", requestId: "r", command: "rm -rf /tmp/x", description: "delete", choices: ["once", "deny"], allowSession: true, allowPermanent: true, answer: "once" },
    { kind: "user", id: "u2", text: "Thanks" },
    { kind: "assistant", id: "a2", text: "Stopped", interrupted: true },
  ],
};

const plan = (format: "markdown" | "jsonl", text: string, name = "file") => planImport(format, name, text);
const rows = (p: ImportPlan, i = 0) => p.chats[i].session.messages as Record<string, unknown>[];

describe("a Hermes Chat Markdown export", () => {
  it("comes back with the same words, roles, thinking and tool calls, dated when it was exported", async () => {
    const p = await plan("markdown", chatMarkdown(chat, EXPORTED));
    const c = p.chats[0];
    expect(c).toMatchObject({ title: `Deploy notes (imported ${c.id})`, messages: 4, toolCalls: 2, attachments: 2, startedAt: EXPORTED.getTime() / 1000 });
    expect(c.id).toMatch(/^20261102_093000_[0-9a-f]{12}$/);
    expect(c.session).toMatchObject({ id: c.id, source: "import", title: c.title, started_at: EXPORTED.getTime() / 1000 });
    const r = rows(p);
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "user", "assistant"]);
    expect(r.every((m) => m.timestamp === EXPORTED.getTime() / 1000)).toBe(true);
    // The attachment names stay in the message's words; nothing they name is read.
    expect(r[0].content).toBe("Check the logs\n\n_Attached, not included in this file:_ `../../../etc/passwd`, ``shot `1`.png``");
    // The thinking goes with the next row Hermes says something in: here, the first tool call.
    expect(r[1]).toMatchObject({ reasoning: "Look at journalctl.\n```\nnested fence\n```", tool_calls: [{ function: { name: "terminal", arguments: '{"command":"journalctl -n 5"}' } }] });
    expect(r[2]).toMatchObject({ role: "tool", tool_name: "terminal", content: "line 1\nline 2", tool_call_id: (r[1].tool_calls as { id: string }[])[0].id });
    expect(r[4]).toMatchObject({ role: "tool", tool_name: "read_file", content: "" });
    expect(r[5].content).toBe(chat.items[4].kind === "assistant" ? chat.items[4].text : "");
    expect(r[7].content).toBe("Stopped");
    expect(p.warnings.join("\n")).toMatch(/every message is dated when the file was exported, 2026-11-02 09:30 UTC/);
    expect(p.warnings.join("\n")).toMatch(/2 attachments are named in the file but not in it/);
    expect(p.warnings.join("\n")).toMatch(/1 Approval isn't imported/);
    expect(p.warnings.join("\n")).toMatch(/1 reply was stopped/);
    expect(p.warnings.join("\n")).toMatch(/The export says: Hermes keeps the output of most tool calls/);
  });

  it("exported again from Hermes, reads the same as the first time", async () => {
    const first = await plan("markdown", chatMarkdown(chat, EXPORTED));
    // What Hermes keeps of the import, as the app shows it after opening the chat.
    const r = rows(first);
    const shown: Chat = {
      ...chat,
      items: r.flatMap((m, i): Chat["items"] => {
        const thought = m.reasoning ? [{ kind: "thinking" as const, id: `r${i}`, text: String(m.reasoning) }] : [];
        if (m.role === "tool") {
          const call = (r[i - 1].tool_calls as { function: { name: string; arguments: string } }[])[0].function;
          return [{ kind: "tool", id: `t${i}`, name: call.name, args: JSON.parse(call.arguments), status: "done", result: String(m.content) || undefined }];
        }
        if (!String(m.content)) return thought;
        return [...thought, { kind: m.role as "user" | "assistant", id: `m${i}`, text: String(m.content) }];
      }),
    };
    const again = await plan("markdown", chatMarkdown(shown, EXPORTED));
    expect(rows(again).map((m) => [m.role, m.content, m.reasoning])).toEqual(r.map((m) => [m.role, m.content, m.reasoning]));
  });

  it("reads a tool call whose output holds lines like its own labels", async () => {
    const tricky: Chat = { ...chat, items: [{ kind: "tool", id: "x", name: "terminal", status: "done", result: "Arguments:\nhello\nOutput:\n```\nx" }] };
    const r = rows(await plan("markdown", chatMarkdown(tricky, EXPORTED)));
    expect(r[0].tool_calls).toMatchObject([{ function: { arguments: "{}" } }]);
    expect(r[1].content).toBe("Arguments:\nhello\nOutput:\n```\nx");
  });

  it("has the same id each time it is read, and another file has another", async () => {
    const md = chatMarkdown(chat, EXPORTED);
    expect((await plan("markdown", md)).chats[0].id).toBe((await plan("markdown", md)).chats[0].id);
    expect((await plan("markdown", md + "\n")).chats[0].id).not.toBe((await plan("markdown", md)).chats[0].id);
  });

  it.each([
    ["no title", "Hello\n", /Line 1: a Hermes Chat export starts with the chat's title/],
    ["no export note", "# Chat\n\n**You:**\n\nhi\n", /its note doesn't say when Hermes Chat exported it/],
    ["a cut-short file", chatMarkdown(chat, EXPORTED).split("nested fence")[0] + "\n", /a code block opens here and never closes/],
    ["text before the first message", "# Chat\n\n> Exported from Hermes Chat on 2026-11-02 09:30 UTC.\n\nstray words\n", /Line 5: expected a message/],
    ["bad tool arguments", chatMarkdown(chat, EXPORTED).replace('"command": "journalctl -n 5"', '"command": '), /arguments of the terminal tool call aren't valid JSON/],
    ["no messages", "# Chat\n\n> Exported from Hermes Chat on 2026-11-02 09:30 UTC.\n", /has no messages/],
    ["a date that isn't one", "# Chat\n\n> Exported from Hermes Chat on 2026-13-40 09:30 UTC.\n\n**You:**\n\nhi\n", /isn't a real date/],
    ["a JSONL file", '{"id":"a","messages":[]}\n', /Line 1: a Hermes Chat export starts/],
    ["a cut at a tool call's header", chatMarkdown(chat, EXPORTED).split("Arguments:")[0], /the terminal tool call has no output and no note saying why/],
    ["a cut mid-line", chatMarkdown(chat, EXPORTED).slice(0, -3), /stops in the middle of a line/],
    ["a cut inside an Approval", chatMarkdown(chat, EXPORTED).split("_Approved once_")[0], /an Approval without its command or its outcome/],
  ])("is refused, naming where, when it has %s", async (_, text, why) => {
    await expect(plan("markdown", text)).rejects.toThrow(ImportFileError);
    await expect(plan("markdown", text)).rejects.toThrow(why);
  });
});

/** One line of `hermes sessions export` at the deployed `bf0203a` (`export_all`): the session row and its messages. */
const exported = (over: Record<string, unknown> = {}) => ({
  id: "20261020_101500_a1b2c3",
  source: "cli",
  user_id: null,
  model: "anthropic/claude-x",
  model_config: '{"max_iterations": 90}',
  system_prompt: "You are Hermes.",
  parent_session_id: null,
  started_at: 1_760_955_300.25,
  ended_at: 1_760_955_900,
  end_reason: "cli_close",
  message_count: 4,
  tool_call_count: 1,
  input_tokens: 1200,
  output_tokens: 300,
  cwd: "/home/me/project",
  title: "Fix the build",
  estimated_cost_usd: 0.04,
  messages: [
    { id: 1, session_id: "x", role: "user", content: "Why does it fail?", timestamp: 1_760_955_301, platform_message_id: "9" },
    {
      id: 2,
      role: "assistant",
      content: "",
      reasoning: "Run the tests.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }],
      timestamp: 1_760_955_302,
      token_count: 40,
      finish_reason: "tool_calls",
    },
    { id: 3, role: "tool", content: "1 failed", tool_call_id: "call_1", tool_name: "terminal", timestamp: 1_760_955_310 },
    { id: 4, role: "assistant", content: "A missing import.", timestamp: 1_760_955_320, finish_reason: "stop" },
    { id: 5, role: "user", content: [{ type: "text", text: "Here:" }, { type: "image_url", image_url: { url: "file:///home/me/secret.png" } }] },
  ],
  ...over,
});
const jsonl = (...sessions: unknown[]) => sessions.map((s) => JSON.stringify(s)).join("\n") + "\n";

describe("a Hermes Chat JSON export", () => {
  const timed: Chat = {
    ...chat,
    id: "20261102_093000_abc123",
    items: [
      { kind: "user", id: "u1", text: "Check the logs", at: 1_762_075_800_000, attachments: ["shot.png"] },
      { kind: "thinking", id: "t1", text: "Look at journalctl." },
      { kind: "tool", id: "c1", callId: "call_7", name: "terminal", args: { command: "journalctl -n 5" }, status: "done", result: "line 1\nline 2" },
      { kind: "assistant", id: "a1", text: "Here they are.", at: 1_762_075_812_250 },
    ],
  };

  it("comes back as the same chat, with its id, each message's time, its thinking and its tool calls", async () => {
    const p = await plan("jsonl", chatJson(timed, EXPORTED), "Deploy notes.json");
    const c = p.chats[0];
    expect(c).toMatchObject({ id: "20261102_093000_abc123", messages: 2, toolCalls: 1, startedAt: 1_762_075_800 });
    expect(rows(p)).toEqual([
      { role: "user", content: "Check the logs", timestamp: 1_762_075_800 },
      {
        role: "assistant",
        content: "",
        reasoning: "Look at journalctl.",
        tool_calls: [{ id: "call_7", type: "function", function: { name: "terminal", arguments: '{"command":"journalctl -n 5"}' } }],
        timestamp: 1_762_075_800,
      },
      { role: "tool", tool_call_id: "call_7", tool_name: "terminal", content: "line 1\nline 2", timestamp: 1_762_075_800 },
      { role: "assistant", content: "Here they are.", timestamp: 1_762_075_812.25 },
    ]);
    expect(p.warnings.join("\n")).toMatch(/attachment names aren't imported/i);
  });
});

describe("a Hermes session export (JSONL)", () => {
  it("keeps its ids, times, roles, model and tool calls, and leaves out the rest, saying what", async () => {
    const p = await plan("jsonl", jsonl(exported(), exported({ id: "20261021_080000_d4e5f6", title: null, source: "telegram" })));
    expect(p.chats.map((c) => [c.id, c.title, c.from, c.messages, c.toolCalls, c.attachments])).toEqual([
      ["20261020_101500_a1b2c3", "Fix the build (imported 20261020_101500_a1b2c3)", "cli", 3, 1, 1],
      ["20261021_080000_d4e5f6", "Untitled chat (imported 20261021_080000_d4e5f6)", "telegram", 3, 1, 1],
    ]);
    const s = p.chats[0].session;
    expect(Object.keys(s).sort()).toEqual(["end_reason", "ended_at", "id", "messages", "model", "source", "started_at", "title"]);
    expect(s).toMatchObject({ source: "import", model: "anthropic/claude-x", started_at: 1_760_955_300.25, ended_at: 1_760_955_900 });
    const r = rows(p);
    expect(r[1]).toEqual({
      role: "assistant",
      content: "",
      reasoning: "Run the tests.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }],
      timestamp: 1_760_955_302,
      finish_reason: "tool_calls",
    });
    expect(r[2]).toEqual({ role: "tool", content: "1 failed", tool_call_id: "call_1", tool_name: "terminal", timestamp: 1_760_955_310 });
    // No time in the file: the one before it, never "now".
    expect(r[4].timestamp).toBe(1_760_955_320);
    // The image part names a path on another computer; it comes in as it was, and nothing reads it.
    expect(r[4].content).toEqual(exported().messages[4].content);
    const w = p.warnings.join("\n");
    expect(w).toMatch(/Not imported: the model settings, the system prompt, token and cost totals, the working folder\./);
    expect(w).toMatch(/2 messages have no time in the file/);
    expect(w).toMatch(/No file it names is read/);
  });

  it("gives chats that share a title and the end of their ids different titles, file after file", async () => {
    const { server, hermes } = await connected();
    for (const id of ["alpha_abcdef", "beta_abcdef"]) {
      const p = await plan("jsonl", jsonl(exported({ id, title: "Same" })));
      expect(p.chats[0].title).toBe(`Same (imported ${id})`);
      expect((await hermes.imports.send("default", p.chats)).imported).toEqual([id]);
    }
    expect(server.sessions.map((s) => s.title)).toEqual(["Same (imported alpha_abcdef)", "Same (imported beta_abcdef)"]);
  });

  it("takes a JSON array of sessions too", async () => {
    expect((await plan("jsonl", JSON.stringify([exported()]))).chats).toHaveLength(1);
  });

  it.each([
    ["a line that isn't JSON", jsonl(exported()) + "{oops\n", /Line 2 isn't valid JSON/],
    ["a session without messages", jsonl({ id: "a" }), /Line 1 isn't a session: it has no "messages" list/],
    ["a user-prompts export", jsonl({ session_id: "a", prompt: "hi" }), /user-prompts export/],
    ["an id that is a path", jsonl(exported({ id: "../../etc/passwd" })), /session id "..\/..\/etc\/passwd" isn't one Hermes Chat imports/],
    ["no id", jsonl(exported({ id: undefined })), /session id undefined isn't one/],
    ["the same session twice", jsonl(exported(), exported()), /Line 2: session 20261020_101500_a1b2c3 is in the file twice/],
    ["a message without a role", jsonl(exported({ messages: [{ content: "x" }] })), /Line 1, message 1: it has no role/],
    ["a time Hermes can't use", jsonl(exported({ messages: [{ role: "user", content: "x", timestamp: -5 }] })), /its time isn't one Hermes can use/],
    ["a bad array", "[1, 2", /The file isn't valid JSON/],
    ["only blank lines", "\n\n", /The file is empty/],
  ])("is refused whole when it has %s", async (_, text, why) => {
    await expect(plan("jsonl", text)).rejects.toThrow(why);
  });

  it("is refused before anything is sent when it is larger than Hermes imports at once", async () => {
    const many = jsonl(...Array.from({ length: IMPORT_LIMITS.sessions + 1 }, (_, i) => exported({ id: `s${i}` })));
    await expect(plan("jsonl", many)).rejects.toThrow(/501 chats; Hermes imports at most 500 at once/);
    const long = jsonl(exported({ messages: Array.from({ length: IMPORT_LIMITS.messagesPerSession + 1 }, () => ({ role: "user", content: "x" })) }));
    await expect(plan("jsonl", long)).rejects.toThrow(/10001 messages; Hermes imports at most 10000 in one chat/);
    const big = jsonl(exported({ messages: [{ role: "user", content: "x".repeat(IMPORT_LIMITS.sessionBytes) }] }));
    await expect(plan("jsonl", big)).rejects.toThrow(/over 5 MB, more than Hermes imports in one chat/);
    await expect(plan("jsonl", "x".repeat(IMPORT_LIMITS.fileBytes + 1))).rejects.toThrow(/over 25 MB/);
  });
});

async function connected(...sessions: ReturnType<typeof row>[]) {
  const server = new FakeHermes();
  server.sessions = sessions;
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  await hermes.sync();
  const imports = () => server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/sessions/import");
  return { server, hermes, imports };
}

describe("sending an import", () => {
  it("writes the chats in one fenced request, reads them back, and skips them when the file comes again", async () => {
    const { server, hermes, imports } = await connected();
    const p = await plan("markdown", chatMarkdown(chat, EXPORTED));
    const first = await hermes.imports.send("default", p.chats);
    expect(first).toEqual({ imported: [p.chats[0].id], skipped: [], unconfirmed: [] });
    expect(imports()[0].body).toMatchObject({ profile: "default", expected_revision: 0, sessions: [{ id: p.chats[0].id, source: "import" }] });
    expect(typeof imports()[0].body!.request_id).toBe("string");
    expect(server.sessions.filter((s) => s.source === "import")).toHaveLength(1);
    // Read back from Hermes, not taken on its word.
    expect(server.restRequests.some((r) => r.method === "GET" && r.path === `/api/sessions/${p.chats[0].id}`)).toBe(true);

    const again = await hermes.imports.send("default", p.chats);
    expect(again).toEqual({ imported: [], skipped: [p.chats[0].id], unconfirmed: [] });
    // The second import names the revision the first one left.
    expect(imports()[1].body!.expected_revision).toBe(1);
    expect(server.sessions.filter((s) => s.source === "import")).toHaveLength(1);
  });

  it("imports a chat beside the one it was exported from, whose title Hermes won't let it share", async () => {
    // Found live: `sessions.title` is UNIQUE in a profile, and a clash fails the whole import as 503.
    const { server, hermes } = await connected(row("20261102_000000_aaaaaa", 1, { title: "Deploy notes" }));
    const p = await plan("markdown", chatMarkdown(chat, EXPORTED));
    expect(await hermes.imports.send("default", p.chats)).toMatchObject({ imported: [p.chats[0].id] });
    expect(server.sessions.map((s) => s.title)).toEqual(["Deploy notes", p.chats[0].title]);
    expect(p.warnings.join("\n")).toMatch(/title gets "\(imported <its id>\)" added/);
  });

  it("says nothing was imported when Hermes fails without writing, and offers to try again", async () => {
    const { server, hermes } = await connected();
    const p = await plan("jsonl", jsonl(exported()));
    server.rest["POST /api/sessions/import"] = () => {
      throw new RestError(503, `{"detail":"storage_unavailable"}`);
    };
    const out = await hermes.imports.send("default", p.chats);
    expect(out.imported).toEqual([]);
    expect(out.interrupted).toMatch(/^Nothing was imported: .*storage_unavailable.*Reading back found none of them\. Try again/);
    expect(server.sessions).toHaveLength(0);
  });

  it("skips a session Hermes already has from where it was exported, and imports the rest", async () => {
    const { server, hermes } = await connected(row("20261020_101500_a1b2c3", 3, { source: "cli" }));
    const p = await plan("jsonl", jsonl(exported(), exported({ id: "20261021_080000_d4e5f6" })));
    expect(await hermes.imports.onServer("default", p.chats.map((c) => c.id))).toEqual(
      new Map([
        ["20261020_101500_a1b2c3", "cli"],
        ["20261021_080000_d4e5f6", null],
      ]),
    );
    expect(await hermes.imports.send("default", p.chats)).toEqual({ imported: ["20261021_080000_d4e5f6"], skipped: ["20261020_101500_a1b2c3"], unconfirmed: [] });
    expect(server.sessions.find((s) => s.id === "20261020_101500_a1b2c3")!.source).toBe("cli");
  });

  it("writes nothing when Hermes refuses any of it, and says why", async () => {
    const { server, hermes } = await connected();
    const p = await plan("jsonl", jsonl(exported()));
    const bad = { ...p.chats[0], session: { ...p.chats[0].session, messages: [{ content: "no role" }] } };
    const sent = hermes.imports.send("default", [p.chats[0], { ...bad, id: "b2", session: { ...bad.session, id: "b2" } }]);
    await expect(sent).rejects.toThrow(ImportRefusedError);
    await expect(hermes.imports.send("default", [{ ...bad, id: "b2", session: { ...bad.session, id: "b2" } }])).rejects.toThrow(
      /imported nothing: b2: messages\[0\]\.role must be a non-empty string/,
    );
    expect(server.sessions).toHaveLength(0);
  });

  it("after a lost answer, asks for the receipt with the same request, so it knows what it made and what it skipped", async () => {
    const { server, hermes, imports } = await connected();
    const first = await plan("jsonl", jsonl(exported()));
    await hermes.imports.send("default", first.chats);
    const p = await plan("jsonl", jsonl(exported(), exported({ id: "20261021_080000_d4e5f6" })));
    server.loseImportAnswer = true;
    expect(await hermes.imports.send("default", p.chats)).toEqual({ imported: ["20261021_080000_d4e5f6"], skipped: ["20261020_101500_a1b2c3"], unconfirmed: [] });
    const [, sent, again] = imports().map((r) => r.body!);
    expect(again.request_id).toBe(sent.request_id);
    expect(server.sessions).toHaveLength(2);
  });

  it("after two lost answers, says what Hermes has without counting any as made, and a retry adds nothing twice", async () => {
    const { server, hermes } = await connected();
    const p = await plan("jsonl", jsonl(exported(), exported({ id: "20261021_080000_d4e5f6" })));
    server.loseImportAnswer = 2;
    const lost = await hermes.imports.send("default", p.chats);
    expect(lost.interrupted).toMatch(/The answer from Hermes was lost .* Hermes has 2 of the 2 chats\. Import the file again/);
    expect(lost.imported).toEqual([]);
    const retry = await hermes.imports.send("default", p.chats);
    expect(retry).toEqual({ imported: [], skipped: p.chats.map((c) => c.id), unconfirmed: [] });
    expect(server.sessions).toHaveLength(2);
  });

  it("doesn't take a failed read-back for a refusal: what Hermes has stays unknown, and a retry adds nothing twice", async () => {
    const { server, hermes } = await connected();
    const p = await plan("jsonl", jsonl(exported()));
    const key = "GET /api/sessions/20261020_101500_a1b2c3";
    server.rest[key] = () => {
      throw new Error("The connection to Hermes closed before it answered.");
    };
    const out = await hermes.imports.send("default", p.chats);
    expect(out).toMatchObject({ imported: [], skipped: [], unconfirmed: ["20261020_101500_a1b2c3"] });
    expect(out.interrupted).toMatch(/^Hermes answered, but reading the chats back failed .* Import the file again/);
    delete server.rest[key];
    expect(await hermes.imports.send("default", p.chats)).toEqual({ imported: [], skipped: ["20261020_101500_a1b2c3"], unconfirmed: [] });
    expect(server.sessions).toHaveLength(1);
  });

  it("reads the first chat's revision again once when another write got there first", async () => {
    const { server, hermes, imports } = await connected();
    const p = await plan("jsonl", jsonl(exported()));
    const key = "GET /api/sessions/20261020_101500_a1b2c3/mutation-snapshot";
    server.rest[key] = () => {
      delete server.rest[key];
      return { exists: false, runtime_revision: 7 };
    };
    expect((await hermes.imports.send("default", p.chats)).imported).toEqual(["20261020_101500_a1b2c3"]);
    expect(imports().map((r) => r.body!.expected_revision)).toEqual([7, 0]);
  });

  it("imports into a profile that has never had a chat, whose session store Hermes hasn't made yet", async () => {
    const { server, hermes } = await connected();
    // Found live: reads answer 503 until a write makes the store.
    const unmade = (req: { path: string; method: string }) => req.method === "GET" && /^\/api\/sessions\//.test(req.path) && !server.sessions.length;
    for (const id of ["20261020_101500_a1b2c3"])
      server.rest[`GET /api/sessions/${id}/mutation-snapshot`] = (req) => {
        if (unmade(req)) throw new RestError(503, `{"detail":"Session store is not initialized. Start this profile's gateway to initialize it."}`);
        return { exists: true, runtime_revision: 1 };
      };
    const p = await plan("jsonl", jsonl(exported()));
    expect(await hermes.imports.onServer("default", ["20261020_101500_a1b2c3"])).toEqual(new Map([["20261020_101500_a1b2c3", null]]));
    expect(await hermes.imports.send("default", p.chats)).toEqual({ imported: ["20261020_101500_a1b2c3"], skipped: [], unconfirmed: [] });
  });

  it("goes to the profile it names, and not over a closed connection", async () => {
    const { server, hermes } = await connected();
    server.otherProfiles.work = [];
    const p = await plan("jsonl", jsonl(exported()));
    await hermes.imports.send("work", p.chats);
    expect(server.otherProfiles.work.map((s) => s.id)).toEqual(["20261020_101500_a1b2c3"]);
    expect(server.sessions).toHaveLength(0);
    await hermes.close();
    await expect(hermes.imports.send("default", p.chats)).rejects.toThrow(/Not connected/);
  });

  it("shows imported chats in the list as Settled and read-only transcripts, however old", async () => {
    const { hermes } = await connected();
    const p = await plan("jsonl", jsonl(exported()));
    await hermes.imports.send("default", p.chats);
    hermes.revealImported("default", p.chats);
    hermes.revealImported("work", [{ ...p.chats[0], id: "elsewhere" }]);
    await hermes.sync();
    const listed = hermes.getSnapshot().chats;
    expect(listed.find((c) => c.id === "20261020_101500_a1b2c3")).toMatchObject({ source: "import", settled: true, title: "Fix the build (imported 20261020_101500_a1b2c3)" });
    expect(listed.some((c) => c.id === "elsewhere")).toBe(false);
  });
});

describe("the imports this computer remembers", () => {
  it("keeps each file's import per connection and profile, and survives storage that fails", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const ledger = importLedger(storage);
    ledger.put("a", "d1", { fileName: "f.md", format: "markdown", at: 1, state: "started", ids: ["x"] });
    expect(ledger.get("a", "d1")?.state).toBe("started");
    expect(ledger.get("b", "d1")).toBeUndefined();
    data.set(IMPORTS_KEY, "{not json");
    expect(ledger.get("a", "d1")).toBeUndefined();
    const full = importLedger({ getItem: () => null, setItem: () => { throw new Error("full"); } });
    expect(() => full.put("a", "d", { fileName: "f", format: "jsonl", at: 1, state: "done", ids: [] })).not.toThrow();
  });
});
