import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { FIRST_DRAFT, chatJson, chatMarkdown, exportFileName, exportPreview, saveExport, saveImage, type ExportDraft } from "./exportChat";
import { planImport } from "./importTranscripts";
import type { ApprovalChoice, Chat, Item } from "./model";

const AT = new Date("2026-11-02T14:05:00Z");
/** What an Approval card offered; the export doesn't show it. */
const offered = { choices: ["once", "deny"] as ApprovalChoice[], allowSession: false, allowPermanent: false };

/** A chat whose stored history has loaded on this connection. */
const chat = (items: Item[], more: Partial<Chat> = {}): Chat => ({
  id: "20261102_140500_abc123",
  runtimeId: "rt-9f8e7d",
  title: "Fix nightly backup cron",
  source: "app",
  settled: false,
  updatedAt: AT.getTime(),
  items,
  ...more,
});

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, null, md));
/** The text of every code block, as a Markdown reader sees it. */
const codeBlocks = (md: string) =>
  [...html(md).matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"),
  );

describe("A chat as Markdown", () => {
  it("has the title, then each message with who wrote it, oldest first", () => {
    const md = chatMarkdown(
      chat([
        { kind: "user", id: "h-0", text: "The nightly backup cron hasn't run since Tuesday.\n\n- check logs\n- check disk" },
        { kind: "assistant", id: "h-1", text: "Found it. The job runs `restic backup`, which **fails**." },
      ]),
      AT,
    );
    expect(md.startsWith("# Fix nightly backup cron\n")).toBe(true);
    expect(md).toContain("**You:**\n\nThe nightly backup cron hasn't run since Tuesday.\n\n- check logs\n- check disk");
    expect(md).toContain("**Hermes:**\n\nFound it. The job runs `restic backup`, which **fails**.");
    expect(md.indexOf("**You:**")).toBeLessThan(md.indexOf("**Hermes:**"));
    expect(md).toContain("2026-11-02 14:05 UTC");
  });

  it("names attachments without their contents, and says they aren't included", () => {
    const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "What's in these?", attachments: ["shot.png", "log_`1`.txt"] }]), AT);
    expect(md).toContain("_Attached, not included in this file:_ `shot.png`, ``log_`1`.txt``");
  });

  it("keeps the model's thinking, an interrupted reply and Approvals", () => {
    const md = chatMarkdown(
      chat([
        { kind: "thinking", id: "r", text: "Check the port first." },
        { kind: "approval", ...offered, id: "ap", requestId: "req-77", command: "rm -rf /tmp/restic-cache", description: "Delete a folder", answer: "once" },
        { kind: "approval", ...offered, id: "ap2", requestId: "req-78", command: "reboot", description: "Restart the server", ended: "timeout" },
        { kind: "assistant", id: "a", text: "", interrupted: true },
      ]),
      AT,
    );
    expect(md).toContain("**Hermes, thinking:**\n\n```\nCheck the port first.\n```");
    expect(md).toContain("**Approval asked:** Delete a folder\n\n```\nrm -rf /tmp/restic-cache\n```\n\n_Approved once_");
    expect(md).toContain("_No answer from here (timeout)_");
    expect(md).toContain("**Hermes:** _(stopped before it finished)_");
  });

  it("includes a tool call's output when there is one", () => {
    const md = chatMarkdown(
      chat([{ kind: "tool", id: "t", name: "terminal", args: { command: "systemctl status backup" }, status: "done", durationS: 1.2, result: "inactive (dead)" }]),
      AT,
    );
    expect(md).toContain("**Tool:** `terminal` (1.2s)");
    expect(codeBlocks(md)).toEqual(['{\n  "command": "systemctl status backup"\n}\n', "inactive (dead)\n"]);
  });

  it("says a tool call has no output instead of making one up", () => {
    const md = chatMarkdown(
      chat([
        { kind: "tool", id: "t1", name: "read_file", preview: "/etc/crontab", status: "done" },
        { kind: "tool", id: "t2", name: "terminal", status: "running" },
        { kind: "tool", id: "t3", name: "terminal", status: "stopped" },
        { kind: "tool", id: "t4", name: "patch", status: "done", result: "" },
      ]),
      AT,
    );
    expect(md).toContain("**Tool:** `read_file` `/etc/crontab`\n\n_No output: Hermes didn't keep it._");
    expect(md).toContain("_Still running when this file was saved; no output yet._");
    expect(md).toContain("_Stopped before it finished; no output._");
    expect(md).toMatch(/Hermes keeps the output of most tool calls only while the reply is running/);
    // An empty output is still an output.
    expect(codeBlocks(md)).toEqual([""]);
  });

  it("doesn't explain missing tool output when nothing is missing", () => {
    expect(chatMarkdown(chat([{ kind: "user", id: "u", text: "hi" }]), AT)).not.toMatch(/tool calls/);
  });

  describe("code fences", () => {
    it("keeps fences in a message as written", () => {
      const text = "Run this:\n\n```sh\nrestic backup /srv\n```\n\nThen check.";
      const md = chatMarkdown(chat([{ kind: "assistant", id: "a", text }]), AT);
      expect(md).toContain(text);
      expect(codeBlocks(md)).toEqual(["restic backup /srv\n"]);
    });

    it("fences tool output longer than any fence inside it, so it comes out whole", () => {
      const result = "README.md:\n```js\nconsole.log(1)\n````\n~~~\nend";
      const md = chatMarkdown(chat([{ kind: "tool", id: "t", name: "read_file", status: "done", result }]), AT);
      expect(codeBlocks(md)).toEqual([`${result}\n`]);
    });

    it("closes a fence a message left open, so it can't swallow the rest of the file", () => {
      const md = chatMarkdown(
        chat([
          { kind: "user", id: "u", text: "Here's the log:\n````\nline 1\n```\nstill log" },
          { kind: "assistant", id: "a", text: "That **log** shows the lock." },
        ]),
        AT,
      );
      expect(codeBlocks(md)).toEqual(["line 1\n```\nstill log\n"]);
      expect(html(md)).toContain("<strong>log</strong>");
    });

    it("keeps thinking and commands with fences inside whole", () => {
      const md = chatMarkdown(
        chat([
          { kind: "thinking", id: "r", text: "Maybe:\n```\nls\n```" },
          { kind: "approval", ...offered, id: "ap", requestId: "r", command: "cat <<'EOF'\n```\nEOF", description: "Write a file" },
        ]),
        AT,
      );
      expect(codeBlocks(md)).toEqual(["Maybe:\n```\nls\n```\n", "cat <<'EOF'\n```\nEOF\n"]);
    });
  });

  describe("saying how complete it is", () => {
    it("says only the history loaded in the app is included", () => {
      const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "hi" }]), AT);
      expect(md).toMatch(/Only the history loaded in Hermes Chat is included/);
      expect(md).not.toMatch(/may be missing/);
    });

    it.each([
      ["still loading", { loading: true }, []],
      ["not loaded on this connection", { runtimeId: undefined }, []],
      ["failed to load", {}, [{ kind: "error", id: "load-error", text: "Couldn't load this chat: timed out" } as Item]],
    ])("warns that earlier messages may be missing when the history is %s", (_, more, items) => {
      const md = chatMarkdown(chat([...items, { kind: "user", id: "u", text: "hi" }], more), AT);
      expect(md).toMatch(/earlier messages may be missing/);
    });

    it("says a reply was still being written", () => {
      expect(chatMarkdown(chat([], { running: true }), AT)).toMatch(/A reply was still being written/);
    });
  });

  it("warns that the content may be sensitive and that redaction can miss a secret", () => {
    const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "the password is hunter2" }]), AT);
    expect(md).toMatch(/may contain sensitive information/);
    expect(md).toMatch(/\(0 places in this file\)\. It can miss a secret written another way\./);
    expect(md).toContain("the password is hunter2");
  });

  it("leaves out session ids, the connection and the app's own error notices, and says so", () => {
    const md = chatMarkdown(
      chat([
        { kind: "user", id: "u", text: "hi" },
        { kind: "approval", ...offered, id: "ap", requestId: "req-secret-77", command: "ls", description: "List" },
        { kind: "error", id: "e-1", text: "Hermes stopped answering at http://127.0.0.1:41234/" },
      ]),
      AT,
    );
    for (const internal of ["20261102_140500_abc123", "rt-9f8e7d", "req-secret-77", "127.0.0.1", "stopped answering"]) expect(md).not.toContain(internal);
    expect(md).toMatch(/Hermes Chat's own error notices are left out/);
  });
});

describe("A chat as JSON", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", text: "Is the backup running?", at: 1_762_092_300_000 },
    { kind: "approval", ...offered, id: "ap", requestId: "req-1", command: "systemctl restart backup", description: "Restart", answer: "once" },
    { kind: "user", id: "u2", text: "Also check the disk", at: 1_762_092_301_000, steer: true },
    { kind: "assistant", id: "a1", text: "It runs now." },
    { kind: "thinking", id: "r1", text: "Nothing more to do." },
  ];
  const parse = (text: string) => JSON.parse(text) as Record<string, unknown>[];

  it("is one Hermes session: a row without a known time has none, a steer is marked, and thinking at the end is its own row", () => {
    const usage = { input: 1200, output: 300, calls: 2, cost: { kind: "estimated" as const, usd: 0.0123 }, readAt: 0 };
    const text = chatJson(chat(items, { model: { provider: "anthropic", model: "claude-x" }, usage }), AT);
    expect(text.startsWith('[\n  {\n    "id": "20261102_140500_abc123",')).toBe(true);
    expect(text.endsWith("]\n")).toBe(true);
    const [s] = parse(text);
    expect(s).toMatchObject({ title: "Fix nightly backup cron", model: "claude-x", started_at: 1_762_092_300, input_tokens: 1200, output_tokens: 300, api_call_count: 2, estimated_cost_usd: 0.0123 });
    expect(s).not.toHaveProperty("source");
    expect(s.messages).toEqual([
      { role: "user", content: "Is the backup running?", timestamp: 1_762_092_300 },
      { role: "user", content: "Also check the disk", timestamp: 1_762_092_301, display_kind: "steer" },
      { role: "assistant", content: "It runs now." },
      { role: "assistant", content: "", reasoning: "Nothing more to do." },
    ]);
    const notes = (s.hermes_chat_export as { notes: string[] }).notes;
    expect(notes).toContain("Approvals aren't in a JSON export: Hermes's session format has no place for them.");
    expect(notes.at(-1)).toMatch(/^This file may contain sensitive information\. .* replaced with \[redacted\] \(0 places in this file\)/);
  });

  it("names a file .json from the title as the file has it, and leaves out Approvals' note when tool calls are left out", () => {
    const p = exportPreview(chat(items, { title: "Backup on db-1" }), { ...FIRST_DRAFT, picked: ["db-1"] }, AT, "json");
    expect(p.fileName).toBe("Backup on [redacted].json");
    const [s] = parse(p.text);
    expect(s.title).toBe("Backup on [redacted]");
    expect((s.hermes_chat_export as { notes: string[] }).notes.join("\n")).not.toMatch(/Approvals aren't/);
  });
});

describe("Saving an image", () => {
  it("hands the PNG and its file name to the Save dialog, and says where it went", async () => {
    const saved: string[][] = [];
    const notice = await saveImage("iVBORw0KGgo=", "Fix.png", async (png, name) => (saved.push([png, name]), "/home/liam/Fix.png"));
    expect(saved).toEqual([["iVBORw0KGgo=", "Fix.png"]]);
    expect(notice).toMatch(/^Exported to \/home\/liam\/Fix\.png\./);
    expect(await saveImage("iVBORw0KGgo=", "Fix.png", async () => null)).toBeUndefined();
  });
});

describe("The suggested file name", () => {
  it("is the title as a Markdown file name", () => {
    expect(exportFileName("Fix nightly backup cron")).toBe("Fix nightly backup cron.md");
  });

  it("drops characters a file name can't hold, and leading dots", () => {
    expect(exportFileName("../etc/passwd: a\nb?")).toBe("etc passwd a b.md");
    expect(exportFileName("  ")).toBe("Chat.md");
  });
});

describe("Saving an export", () => {
  it("hands the Markdown and file name to the Save dialog, and says where it went", async () => {
    const saved: string[][] = [];
    const notice = await saveExport("# Fix\n", "Fix.md", "markdown", async (md, name, format) => (saved.push([md, name, format]), "/home/liam/notes/Fix.md"));
    expect(saved).toEqual([["# Fix\n", "Fix.md", "markdown"]]);
    expect(notice).toMatch(/^Exported to \/home\/liam\/notes\/Fix\.md\. Read it before you share it/);
  });

  it("does nothing when the owner cancels", async () => {
    expect(await saveExport("# Fix\n", "Fix.md", "markdown", async () => null)).toBeUndefined();
  });

  it("passes a failure on to show", async () => {
    await expect(saveExport("# Fix\n", "Fix.md", "markdown", async () => Promise.reject(new Error("Permission denied (os error 13)")))).rejects.toThrow("Permission denied");
  });
});

describe("Choosing what goes in an export", () => {
  const files = { kind: "user", id: "u1", text: "Why won't these load?", attachments: ["prod.env", "dump.sql"] } as Item;
  const items: Item[] = [
    files,
    { kind: "thinking", id: "r1", text: "The env file probably has the wrong host." },
    { kind: "tool", id: "t1", name: "terminal", args: { command: "cat /srv/app/.env" }, status: "done", result: "DB_HOST=10.0.0.12" },
    { kind: "approval", ...offered, id: "ap1", requestId: "req-1", command: "systemctl restart app", description: "Restart the app", answer: "once" },
    { kind: "assistant", id: "a1", text: "The host was wrong. Fixed and restarted." },
    { kind: "user", id: "u2", text: "Thanks, unrelated: what's for lunch?" },
  ];
  const md = (draft: Partial<ExportDraft>) => exportPreview(chat(items), { ...FIRST_DRAFT, ...draft }, AT).text;

  it("leaves out tool calls, Approvals and attachment names at first, and says so", () => {
    const first = md({});
    for (const gone of ["cat /srv/app/.env", "DB_HOST=10.0.0.12", "**Tool:**", "systemctl restart app", "**Approval asked:**", "prod.env", "dump.sql", "_Attached"])
      expect(first).not.toContain(gone);
    expect(first).toContain("> Tool calls and Approvals were left out.");
    expect(first).toContain("> The names of attached files were left out.");
    expect(first).toContain("**You:**\n\nWhy won't these load?");
    expect(first).toContain("**Hermes:**\n\nThe host was wrong.");
  });

  it("puts tool calls and attachment names in when asked", () => {
    const all = md({ toolCalls: true, attachments: true });
    expect(all).toContain("DB_HOST=10.0.0.12");
    expect(all).toContain("_Approved once_");
    expect(all).toContain("_Attached, not included in this file:_ `prod.env`, `dump.sql`");
    expect(all).not.toMatch(/were left out/);
  });

  it("leaves out the messages not chosen, keeps the rest in order, and counts what was left out", () => {
    const some = md({ leftOut: new Set(["u2", "r1"]) });
    expect(some).not.toContain("lunch");
    expect(some).not.toContain("wrong host");
    expect(some.indexOf("Why won't these load?")).toBeLessThan(some.indexOf("The host was wrong."));
    expect(some).toContain("> 2 of the chat's 4 messages were left out.");
  });

  it("is still a file Import reads", async () => {
    const some = md({ leftOut: new Set(["u2"]), picked: ["10.0.0.12"], toolCalls: true });
    const p = await planImport("markdown", "Fix.md", some);
    expect(p.chats[0]).toMatchObject({ messages: 2, toolCalls: 1 });
  });
});

describe("Flagging likely secrets in an export", () => {
  const key = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";
  const items: Item[] = [
    { kind: "user", id: "u", text: `My key is ${key}, and the db is postgres://app:Pa55w0rd!@db.internal:5432/app` },
    { kind: "assistant", id: "a", text: `Don't paste ${key} in chats. Set it as ANTHROPIC_API_KEY instead.` },
    { kind: "user", id: "u2", text: `Here's the deploy key:\n\n${pem}` },
  ];
  const preview = (draft: Partial<ExportDraft> = {}) => exportPreview(chat(items), { ...FIRST_DRAFT, ...draft }, AT);

  it("flags each different secret once, with its kind and how often it's there, and redacts all of them at first", () => {
    const p = preview();
    expect(p.secrets).toEqual([
      { text: key, kind: "API key", times: 2, redacted: true },
      { text: "Pa55w0rd!", kind: "password in a link", times: 1, redacted: true },
      { text: pem, kind: "private key", times: 1, redacted: true },
    ]);
    for (const s of [key, "Pa55w0rd!", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "BEGIN OPENSSH"]) expect(p.text).not.toContain(s);
    expect(p.text).toContain("My key is [redacted], and the db is postgres://app:[redacted]@db.internal:5432/app");
    expect(p.text).toContain("(4 places in this file)");
  });

  it("keeps a flagged text the owner says isn't secret", () => {
    const p = preview({ kept: new Set(["Pa55w0rd!"]) });
    expect(p.text).toContain("postgres://app:Pa55w0rd!@db.internal");
    expect(p.secrets.find((s) => s.text === "Pa55w0rd!")!.redacted).toBe(false);
    expect(p.text).not.toContain(key);
  });

  it("only flags what the file would hold", () => {
    expect(preview({ leftOut: new Set(["u2"]) }).secrets.map((s) => s.kind)).toEqual(["API key", "password in a link"]);
  });

  it("finds a secret in a tool call's arguments once tool calls go in", () => {
    const withTool = [...items, { kind: "tool", id: "t", name: "terminal", args: { command: "curl -H 'Authorization: Bearer 7f3a9c2e8b1d4f6a0e5c'" }, status: "done", result: "ok" } as Item];
    expect(exportPreview(chat(withTool), FIRST_DRAFT, AT).secrets.some((s) => s.kind === "bearer token")).toBe(false);
    const p = exportPreview(chat(withTool), { ...FIRST_DRAFT, toolCalls: true }, AT);
    expect(p.secrets.find((s) => s.kind === "bearer token")!.text).toBe("7f3a9c2e8b1d4f6a0e5c");
    expect(p.text).not.toContain("7f3a9c2e8b1d4f6a0e5c");
  });

  it("redacts all of a quoted password with an escaped quote or backslash in it", async () => {
    const withTool: Item[] = [
      { kind: "tool", id: "t", name: "login", args: { password: 'Mov3rs!2026"SecretTail', command: 'PASSWORD="C:\\kv0lt\\Vault9!" ./deploy.sh' }, status: "done", result: "ok" },
    ];
    const p = exportPreview(chat(withTool), { ...FIRST_DRAFT, toolCalls: true }, AT);
    let bytes = "";
    await saveExport(p.text, p.fileName, "markdown", async (md) => ((bytes = md), "/tmp/x.md"));
    for (const gone of ["Mov3rs", "SecretTail", "kv0lt", "Vault9"]) expect(bytes).not.toContain(gone);
    expect(bytes).toContain("./deploy.sh");
  });

  it("finds a quoted password in a tool call's command, where JSON escapes the quotes", async () => {
    const withTool: Item[] = [{ kind: "tool", id: "t", name: "terminal", args: { command: 'PASSWORD="Mov3rs!2026" ./deploy.sh' }, status: "done", result: "ok" }];
    const p = exportPreview(chat(withTool), { ...FIRST_DRAFT, toolCalls: true }, AT);
    expect(p.secrets.map((s) => [s.kind, s.text])).toEqual([["password or key", "Mov3rs!2026"]]);
    let bytes = "";
    await saveExport(p.text, p.fileName, "markdown", async (md) => ((bytes = md), "/tmp/x.md"));
    expect(bytes).toContain("./deploy.sh");
    expect(bytes).not.toContain("Mov3rs");
  });
});

describe("Redacting by hand", () => {
  const items: Item[] = [
    { kind: "user", id: "u", text: "My home address is 14 Larch Lane, Duluth. Ship it to 14 Larch Lane." },
    { kind: "assistant", id: "a", text: "Noted: 14 Larch Lane, Duluth." },
  ];

  it("replaces picked text everywhere it appears, so the saved bytes don't hold it", async () => {
    const p = exportPreview(chat(items, { title: "Shipping to 14 Larch Lane" }), { ...FIRST_DRAFT, picked: ["14 Larch Lane"] }, AT);
    expect(p.picked).toEqual([{ text: "14 Larch Lane", times: 4 }]);
    let written = new Uint8Array();
    await saveExport(p.text, p.fileName, "markdown", async (markdown, name) => ((written = new TextEncoder().encode(markdown)), `/tmp/${name}`));
    const bytes = new TextDecoder().decode(written);
    expect(bytes).toBe(p.text);
    expect(bytes).not.toContain("Larch");
    expect(bytes).toContain("# Shipping to [redacted]");
    expect(bytes).toContain("Noted: [redacted], Duluth.");
    expect(p.fileName).toBe("Shipping to [redacted].md");
  });

  it("redacts the whole title line, in the file and its name, however the title was spaced", () => {
    const p = exportPreview(chat(items, { title: "  Client\n Alpha  " }), { ...FIRST_DRAFT, picked: ["# Client Alpha"] }, AT);
    expect(p.text.split("\n")[0]).toBe("[redacted]");
    expect(p.fileName).toBe("[redacted].md");
    expect(exportPreview(chat(items, { title: "Client  Alpha" }), { ...FIRST_DRAFT, picked: ["Client Alpha"] }, AT).fileName).toBe("[redacted].md");
  });

  it("keeps overlapping redactions whole in any order, and after one of them is taken back", () => {
    const both = ["14 Larch Lane", "address is 14 Larch"];
    const first = exportPreview(chat(items), { ...FIRST_DRAFT, picked: both }, AT).text;
    expect(first).toContain("My home [redacted], Duluth.");
    expect(exportPreview(chat(items), { ...FIRST_DRAFT, picked: [...both].reverse() }, AT).text).toBe(first);
    const second = exportPreview(chat(items), { ...FIRST_DRAFT, picked: [both[1]] }, AT).text;
    expect(second).toContain("My home [redacted] Lane, Duluth.");
    expect(second).not.toContain("address is");
  });

  it("leaves nothing of a flagged secret when part of it was picked too", () => {
    const key = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
    const keyed: Item[] = [{ kind: "user", id: "u", text: `key ${key} here` }];
    for (const kept of [new Set<string>(), new Set([key])]) {
      const md = exportPreview(chat(keyed), { ...FIRST_DRAFT, kept, picked: ["Zx8Kq2"] }, AT).text;
      expect(md).not.toContain("Zx8Kq2");
      if (!kept.size) expect(md).toContain("key [redacted] here");
    }
  });

  it("says when a picked text isn't in what's chosen any more", () => {
    const p = exportPreview(chat(items), { ...FIRST_DRAFT, leftOut: new Set(["u", "a"]), picked: ["14 Larch Lane"] }, AT);
    expect(p.picked).toEqual([{ text: "14 Larch Lane", times: 0 }]);
  });
});
