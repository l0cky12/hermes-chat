import { describe, expect, it, vi } from "vitest";
import { BRANCH_KEY_TTL_MS, fileRefs, locate, spineOf } from "./branch";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import type { Item } from "./model";
import { BranchUnconfirmed, connect } from "./transport";
import { RestError } from "./pipe";

/**
 * A chat "c1" as Hermes stores it: a hidden project instruction, a question answered with a tool call, a message sent
 * with a file, and a last exchange.
 */
async function chatWithHistory(over: { cache?: ReturnType<typeof memoryCache>; server?: FakeHermes; more?: ReturnType<typeof row>[] } = {}) {
  const server = over.server ?? new FakeHermes();
  server.sessions = [row("c1", 0.1, { title: "Disk check", pinned: true }), ...(over.more ?? [])];
  server.serverDirs.add("/srv/uploads");
  server.serverFiles["/srv/uploads/report.pdf"] = "%PDF";
  server.storeMessage("c1", { role: "user", text: 'Instructions for this chat from the project "Ops".', display_kind: "hidden" });
  server.storeMessage("c1", { role: "user", text: "How full is the NAS?" });
  server.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"df -h"}' } }] });
  server.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "call_1", context: "df -h", result: "/dev/sda1 81%" });
  server.storeMessage("c1", { role: "assistant", text: "It's 81% full." });
  server.storeMessage("c1", { role: "user", text: "@file:/srv/uploads/report.pdf @file:/srv/uploads/gone.csv\n\nCompare with these" });
  server.storeMessage("c1", { role: "assistant", text: "The report says 79% last week." });
  server.storeMessage("c1", { role: "user", text: "Clean up old snapshots" });
  server.storeMessage("c1", { role: "assistant", text: "Deleted 3 snapshots." });
  const cache = over.cache ?? memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  await hermes.open("c1");
  const chat = (id = "c1") => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const itemWith = (text: string, id = "c1") => chat(id).items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.text.includes(text))!.id;
  const branches = () => server.sessions.filter((s) => s.parent_session_id === "c1");
  return { server, hermes, cache, chat, itemWith, branches };
}

const texts = (items: Item[]) => items.flatMap((i) => (i.kind === "user" || i.kind === "assistant" ? [`${i.kind}: ${i.text}`] : []));

describe("Branch from here: the boundary", () => {
  it("counts Hermes's own spine: hidden rows in, tool rows out", () => {
    const spine = spineOf([
      { id: 1, role: "user", content: "hidden instructions", display_kind: "hidden" },
      { id: 2, role: "user", content: "Q" },
      { id: 3, role: "assistant", content: "" },
      { id: 4, role: "tool", content: "out" },
      { id: 5, role: "assistant", content: "A" },
      { id: 6, role: "session_meta", content: "{}" },
    ]);
    expect(spine.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(spine[0].hidden).toBe(true);
  });

  it("finds a message by its stored row, else by its words and how many came before with the same words", () => {
    const spine = spineOf([
      { id: 1, role: "user", content: "again" },
      { id: 2, role: "assistant", content: "ok" },
      { id: 3, role: "user", content: "@file:a.txt\n\nagain" },
      { id: 4, role: "assistant", content: "ok" },
    ]);
    const items: Item[] = [
      { kind: "user", id: "u1", text: "again", rowId: 1 },
      { kind: "assistant", id: "a1", text: "ok" },
      { kind: "user", id: "u2", text: "again" },
      { kind: "assistant", id: "a2", text: "ok" },
    ];
    expect(locate(items, "u1", spine)).toEqual({ index: 0 });
    expect(locate(items, "a1", spine)).toEqual({ index: 1 });
    // The second "again" was sent with a file, which Hermes stores before the words.
    expect(locate(items, "u2", spine)).toEqual({ index: 2 });
    expect(locate(items, "a2", spine)).toEqual({ index: 3 });
  });

  it("says why when the message isn't among the stored rows", () => {
    const spine = spineOf([{ id: 1, role: "user", content: "hi" }]);
    expect(locate([{ kind: "assistant", id: "a", text: "gone", rowId: 9 }], "a", spine)).toEqual({ error: expect.stringContaining("doesn't list this message") });
    expect(locate([{ kind: "assistant", id: "a", text: "not stored yet" }], "a", spine)).toEqual({ error: expect.stringContaining("hasn't stored this message yet") });
    expect(locate([{ kind: "error", id: "e", text: "boom" }], "e", spine)).toEqual({ error: expect.stringContaining("Only a message") });
  });

  it("reads file refs the way file.attach quotes them", () => {
    expect(fileRefs("@file:/a/b.txt @file:`/x y/z.pdf` @file:\"/q r.csv\"\n\nhi")).toEqual(["/a/b.txt", "/x y/z.pdf", "/q r.csv"]);
  });
});

describe("Branch from here: preview", () => {
  it("shows the copied history, hidden rows, left-out tool results, files and the model", async () => {
    const { hermes, chat, itemWith } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("79% last week"));
    // The hidden row, both questions and three replies: Hermes counts all of them.
    expect(p.count).toBe(6);
    expect(p.hidden).toBe(1);
    expect(p.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(p.point).toEqual({ role: "assistant", excerpt: "The report says 79% last week.", rowId: 7 });
    expect(p.toolCalls).toBe(1);
    expect(p.files).toEqual([
      { path: "/srv/uploads/report.pdf", state: "there" },
      { path: "/srv/uploads/gone.csv", state: "missing" },
    ]);
    expect(p.model).toEqual(chat().model);
  });

  it("isn't offered while a reply runs, while an Approval waits, or while offline", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    const sid = chat().runtimeId!;
    server.event(sid, "message.start", {});
    await hermes.idle();
    await expect(hermes.previewBranch("c1", itemWith("81% full"))).rejects.toThrow("Wait for the reply to finish");
    server.event(sid, "message.complete", { text: "done", status: "complete" });
    await hermes.idle();
    server.askApproval(sid);
    await hermes.idle();
    await expect(hermes.previewBranch("c1", itemWith("81% full"))).rejects.toThrow("waiting for an Approval");
    server.drop();
    await hermes.idle();
    await expect(hermes.previewBranch("c1", itemWith("81% full"))).rejects.toThrow("Not connected");
  });
});

describe("Branch from here: making it", () => {
  it("forks an old message into a new Active chat of this app's, and leaves the original as it was", async () => {
    const { server, hermes, chat, itemWith, branches } = await chatWithHistory();
    const before = JSON.stringify(server.transcripts.c1);
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    const { chatId, warnings } = await hermes.branch(p);
    expect(warnings).toEqual([]);

    const call = server.requests.find((r) => r.method === "session.branch")!;
    expect(call.params).toEqual({ session_id: chat().runtimeId, count: 4, idempotency_key: expect.stringMatching(/^branch-/) });
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
    expect(branches()).toHaveLength(1);
    // Hermes copies the hidden row too, but no tool row.
    expect(server.transcripts[chatId].map((m) => m.role)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(texts(chat(chatId).items)).toEqual(["user: How full is the NAS?", "assistant: Let me look.", "assistant: It's 81% full."]);
    expect(chat(chatId)).toMatchObject({ source: "app", settled: false, title: "Disk check #2" });
    expect(hermes.getSnapshot().branches.links[chatId]).toMatchObject({ parentId: "c1", parentTitle: "Disk check", point: { role: "assistant", excerpt: "It's 81% full." } });

    // Hermes stores it as `tui`, but it was made here, and stays Active after the list is read again.
    await hermes.idle();
    await hermes.sync();
    expect(chat(chatId)).toMatchObject({ source: "app", settled: false });
    expect(server.sessions.find((s) => s.id === chatId)).toMatchObject({ pinned: true });
    // New messages go to the branch only.
    await hermes.send(chatId, "Now check the other NAS");
    expect(server.transcripts[chatId].at(-1)).toMatchObject({ role: "user", text: "Now check the other NAS" });
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
  });

  it("switches the branch to the parent's model and saves the owner's title", async () => {
    const { server, hermes, itemWith, chat } = await chatWithHistory();
    await hermes.setModel("c1", { provider: "openrouter", model: "deepseek/deepseek-v4", effort: "high" });
    const p = await hermes.previewBranch("c1", itemWith("Deleted 3"));
    const { chatId, warnings } = await hermes.branch(p, "  Snapshot cleanup, take 2 ");
    expect(warnings).toEqual([]);
    const sets = server.requests.filter((r) => r.method === "config.set" && r.params.session_id === chat(chatId).runtimeId);
    expect(sets.map((r) => r.params.key)).toEqual(["model", "reasoning"]);
    expect(chat(chatId).model).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4", effort: "high" });
    expect(server.sessions.find((s) => s.id === chatId)!.title).toBe("Snapshot cleanup, take 2");
    expect(chat(chatId).title).toBe("Snapshot cleanup, take 2");
  });

  it("says this Hermes can't branch, and makes nothing, on a server without session.branch", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    server.branchMethod = false;
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    await expect(hermes.branch(p)).rejects.toThrow("can't branch chats: it has no session.branch");
    expect(branches()).toEqual([]);
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
  });

  it("refuses when the chat changed since the preview", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    // Another client deleted the reply's row meanwhile, so the same message now ends a shorter spine.
    server.transcripts.c1.splice(2, 1);
    await expect(hermes.branch(p)).rejects.toThrow("changed since the preview");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("refuses when an earlier message changed since the preview, though the point is the same row", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.transcripts.c1[1] = { ...server.transcripts.c1[1], text: "How full is the old NAS?" };
    await expect(hermes.branch(p)).rejects.toThrow("changed since the preview");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("deletes a branch whose copy differs from the preview after its first words", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    // A Hermes that copies the last row with other words, the same for 40 characters and more.
    server.handlers["session.branch"] = ((orig) => (r) => {
      orig(r);
      const child = server.sessions.find((x) => x.parent_session_id === "c1")!.id;
      const rows = server.transcripts[child];
      rows[rows.length - 1] = { ...rows[rows.length - 1], text: "It's 81% full. Also, I deleted your old snapshots." };
    })(server.handlers["session.branch"]);
    await expect(hermes.branch(p)).rejects.toThrow("deleted that branch again");
    expect(branches()).toEqual([]);
  });

  it("deletes a branch that doesn't end where the preview said", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    // A Hermes that counts its spine differently copies one row fewer.
    server.handlers["session.branch"] = ((orig) => (r) => orig({ ...r, params: { ...r.params, count: 3 } }))(server.handlers["session.branch"]);
    await expect(hermes.branch(p)).rejects.toThrow("deleted that branch again");
    expect(branches()).toEqual([]);
  });

  it("keeps a branch Hermes stored before failing, and says what Hermes said", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    server.branchError = { code: 5000, message: "agent init failed on branch: boom" };
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    const { chatId, warnings } = await hermes.branch(p);
    expect(branches().map((b) => b.id)).toEqual([chatId]);
    expect(warnings).toEqual([expect.stringContaining("agent init failed")]);
    expect(hermes.getSnapshot().branches.links[chatId]).toBeDefined();
  });
});

describe("Branch from here: a dropped connection", () => {
  it("finds the branch Hermes made after the connection dropped, without making another", async () => {
    const cache = memoryCache();
    const { server, hermes, itemWith, branches, chat } = await chatWithHistory({ cache });
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "stored";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    // Kept on this computer before it went, so a restart can settle it too.
    expect(cache.branches.default.attempts).toHaveLength(1);

    await hermes.reconnect();
    await hermes.idle();
    expect(branches()).toHaveLength(1);
    const id = branches()[0].id;
    expect(chat(id)).toMatchObject({ source: "app", settled: false });
    expect(hermes.getSnapshot().branches).toMatchObject({ attempts: [], links: { [id]: { parentId: "c1" } } });
    expect(hermes.getSnapshot().branchNews).toMatchObject({ chatId: id, text: expect.stringContaining("made the branch") });
    expect(server.requests.filter((r) => r.method === "session.branch")).toHaveLength(1);
  });

  it("asks again with the same key when branching from the same message again, and gets the same branch", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "lost";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    await hermes.reconnect();
    await hermes.open("c1");
    await hermes.idle();
    // Not listed, and Hermes may still know the key: nothing is said yet.
    expect(hermes.getSnapshot().branches.attempts).toHaveLength(1);
    const again = await hermes.previewBranch("c1", itemWith("81% full"));
    const { chatId } = await hermes.branch(again);
    const keys = server.requests.filter((r) => r.method === "session.branch").map((r) => r.params.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(branches().map((b) => b.id)).toEqual([chatId]);
  });

  it("says a branch wasn't made once Hermes has forgotten its key and lists none", async () => {
    const cache = memoryCache();
    cache.branches.default = {
      links: {},
      attempts: [{ key: "branch-old", parentId: "c1", parentTitle: "Disk check", point: { role: "assistant", excerpt: "x" }, count: 2, fingerprint: "2-0", before: [], startedAt: Date.now() - BRANCH_KEY_TTL_MS - 1000 }],
    };
    const { hermes } = await chatWithHistory({ cache });
    await hermes.idle();
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
    expect(hermes.getSnapshot().branchNews?.text).toContain("didn't make the branch");
    expect(cache.branches.default.attempts).toEqual([]);
  });

  it("doesn't take another client's branch of the same chat for the one whose answer was lost", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "lost";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    // Meanwhile another Hermes client branches the same chat from a different message.
    server.sessions.push(row("other-client", 0, { source: "desktop", parent_session_id: "c1", title: "Disk check #2", message_count: 2 }));
    server.storeMessage("other-client", { role: "user", text: "How full is the NAS?" });
    server.storeMessage("other-client", { role: "assistant", text: "Let me look." });
    await hermes.reconnect();
    await hermes.idle();
    expect(hermes.getSnapshot().branches.links).toEqual({});
    expect(hermes.getSnapshot().branches.attempts).toHaveLength(1);
    expect(server.sessions.find((r) => r.id === "other-client")!.title).toBe("Disk check #2");
    expect(branches().map((b) => b.id)).toEqual(["other-client"]);
  });

  it("doesn't ask Hermes when a reply starts while the branch is being prepared", async () => {
    const { server, hermes, chat, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    // The reply starts after the boundary was read, while the list of the chat's branches is being read.
    const list = server.rest["GET /api/sessions"];
    let calls = 0;
    server.rest["GET /api/sessions"] = (req) => {
      if (++calls === 1) server.event(chat().runtimeId!, "message.start", {});
      return list(req);
    };
    await expect(hermes.branch(p)).rejects.toThrow("Wait for the reply to finish");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
    expect(branches()).toEqual([]);
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
  });

  it("sends nothing when the connection changed while the branch was being prepared", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    const list = server.rest["GET /api/sessions"];
    let reconnecting: Promise<void> | undefined;
    server.rest["GET /api/sessions"] = (req) => {
      if (!reconnecting) {
        server.rest["GET /api/sessions"] = list;
        server.drop();
        reconnecting = hermes.reconnect();
      }
      return list(req);
    };
    await expect(hermes.branch(p)).rejects.toThrow(/connection to Hermes changed|Not connected/);
    await reconnecting;
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
    expect(branches()).toEqual([]);
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
  });

  it("keeps a branch made while the owner switched profile with the profile it was made in", async () => {
    const cache = memoryCache();
    const server = new FakeHermes();
    server.otherProfiles.work = [row("w1", 0.2, { title: "Work chat" })];
    const { hermes, itemWith } = await chatWithHistory({ cache, server });
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    const branchCall = server.handlers["session.branch"];
    let answer: (() => void) | undefined;
    server.handlers["session.branch"] = (r) => void (answer = () => branchCall(r));
    const making = hermes.branch(p).catch((e) => e as Error);
    await vi.waitFor(() => expect(answer).toBeDefined());
    const switching = hermes.switchProfile("work");
    answer!();
    await switching;
    await making;
    await hermes.idle();
    const made = server.sessions.find((r) => r.parent_session_id === "c1")!;
    // Nothing of the default profile's branch lands in the work profile.
    expect(cache.loadBranches("work")).toEqual({ links: {}, attempts: [] });
    expect(hermes.getSnapshot().branches).toEqual({ links: {}, attempts: [] });
    expect(hermes.getSnapshot().chats.some((c) => c.id === made.id)).toBe(false);
    // Back in the default profile, the branch is its own, made here.
    await hermes.switchProfile("default");
    await hermes.idle();
    expect(Object.keys(cache.loadBranches("default").links)).toEqual([made.id]);
    expect(cache.loadBranches("default").attempts).toEqual([]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === made.id)).toMatchObject({ source: "app" });
  });

  it("finds a branch whose answer was lost though it was archived meanwhile, after Hermes forgot the key", async () => {
    const cache = memoryCache();
    const { server, hermes, itemWith, branches, chat } = await chatWithHistory({ cache });
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "stored";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    branches()[0].archived = true;
    // Long after: the key is forgotten, and the branch is listed only among the archived chats.
    cache.branches.default.attempts[0].startedAt -= BRANCH_KEY_TTL_MS + 1000;
    await hermes.reconnect();
    await hermes.idle();
    const id = branches()[0].id;
    expect(hermes.getSnapshot().branches.links[id]).toBeDefined();
    expect(hermes.getSnapshot().branchNews?.text).toContain("made the branch");
    expect(chat("c1")).toBeDefined();
  });

  it("says it can't tell, rather than that Hermes didn't, when the list can't be read back far enough", async () => {
    const cache = memoryCache();
    cache.branches.default = {
      links: {},
      attempts: [{ key: "k", parentId: "c1", parentTitle: "Disk check", point: { role: "assistant", excerpt: "x" }, count: 2, fingerprint: "2-0", before: [], startedAt: Date.now() - BRANCH_KEY_TTL_MS - 1000 }],
    };
    // More than ten pages of chats made since, so the search stops before it reaches back to the attempt.
    const more = Array.from({ length: 1100 }, (_, i) => row(`n${i}`, 0));
    const { hermes } = await chatWithHistory({ cache, more });
    await hermes.idle();
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
    expect(hermes.getSnapshot().branchNews?.text).toContain("couldn't tell whether Hermes made the branch");
  });

  it("leaves it unsettled when another client's longer branch shares the rows asked for", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "lost";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    // Another client branches the same chat from a later message: the same first rows, and more.
    server.sessions.push(row("longer", 0, { source: "desktop", parent_session_id: "c1", title: "Other branch", message_count: 6 }));
    for (const m of server.transcripts.c1.filter((m) => m.role !== "tool").slice(0, 6)) server.storeMessage("longer", { role: m.role, text: m.text, ...(m.display_kind && { display_kind: m.display_kind }) });
    await hermes.reconnect();
    await hermes.idle();
    expect(hermes.getSnapshot().branches.links).toEqual({});
    expect(hermes.getSnapshot().branches.attempts).toHaveLength(1);
    expect(server.sessions.find((r) => r.id === "longer")).toMatchObject({ title: "Other branch", pinned: false });
  });

  it("doesn't take a lone match for the branch when the list couldn't be read back far enough", async () => {
    const cache = memoryCache();
    const more = Array.from({ length: 1100 }, (_, i) => row(`n${i}`, 0));
    const { server, hermes, itemWith, branches } = await chatWithHistory({ cache, more });
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    server.dropOnBranch = "stored";
    await expect(hermes.branch(p)).rejects.toBeInstanceOf(BranchUnconfirmed);
    await hermes.reconnect();
    await hermes.idle();
    expect(branches()).toHaveLength(1);
    expect(hermes.getSnapshot().branches.links).toEqual({});
    expect(hermes.getSnapshot().branches.attempts).toHaveLength(1);
  });

  it("branches from the message picked, not from an earlier one whose answer was lost, and keeps that attempt", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    server.dropOnBranch = "lost";
    await expect(hermes.branch(await hermes.previewBranch("c1", itemWith("Let me look")))).rejects.toBeInstanceOf(BranchUnconfirmed);
    await hermes.reconnect();
    await hermes.open("c1");
    await hermes.idle();
    const [pending] = hermes.getSnapshot().branches.attempts;
    expect(pending).toMatchObject({ count: 3 });
    const { chatId } = await hermes.branch(await hermes.previewBranch("c1", itemWith("Deleted 3")));
    expect(server.transcripts[chatId].at(-1)).toMatchObject({ text: "Deleted 3 snapshots." });
    expect(branches().map((r) => r.id)).toEqual([chatId]);
    const keys = server.requests.filter((r) => r.method === "session.branch").map((r) => r.params.idempotency_key);
    expect(keys[1]).not.toBe(keys[0]);
    // The earlier attempt waits to be settled by the list, as before.
    expect(hermes.getSnapshot().branches.attempts).toEqual([pending]);
  });

  it("keeps an attempt Hermes refused after storing it when the branch can't be read back, and makes no second one", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    server.branchError = { code: 5000, message: "agent init failed on branch: boom" };
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    const list = server.rest["GET /api/sessions"];
    const branchCall = server.handlers["session.branch"];
    // The list can't be read once Hermes has answered.
    server.handlers["session.branch"] = (r) => {
      server.rest["GET /api/sessions"] = () => {
        throw new RestError(502, "", "The dashboard answered 502");
      };
      branchCall(r);
    };
    await expect(hermes.branch(p)).rejects.toThrow("couldn't tell whether it made the branch");
    expect(hermes.getSnapshot().branches.attempts).toHaveLength(1);
    server.rest["GET /api/sessions"] = list;
    server.handlers["session.branch"] = branchCall;
    server.branchError = undefined;
    const { chatId } = await hermes.branch(await hermes.previewBranch("c1", itemWith("81% full")));
    expect(branches().map((b) => b.id)).toEqual([chatId]);
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
  });

  it("opens a branch afresh when the connection changed while it was read back", async () => {
    const { server, hermes, itemWith, chat } = await chatWithHistory();
    const p = await hermes.previewBranch("c1", itemWith("81% full"));
    // The answer is in; the connection drops while the app reads the branch back.
    server.rest["GET /api/sessions/c1-b1/messages"] = () => {
      server.drop();
      return { messages: server.transcripts["c1-b1"].map((m) => ({ id: m.row_id, role: m.role, content: m.text, display_kind: m.display_kind ?? null })) };
    };
    const { chatId } = await hermes.branch(p);
    expect(chatId).toBe("c1-b1");
    delete server.rest["GET /api/sessions/c1-b1/messages"];
    await hermes.reconnect();
    await hermes.idle();
    expect(chat(chatId).runtimeId).toBeUndefined();
    await hermes.open(chatId);
    expect(chat(chatId).runtimeId).toMatch(/^rt-r/);
    expect(await hermes.send(chatId, "and now?")).toEqual({ delivery: "accepted" });
  });

  it("keeps a branch's link when Hermes refuses to delete it", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const { chatId } = await hermes.branch(await hermes.previewBranch("c1", itemWith("81% full")));
    await hermes.idle();
    server.rest[`DELETE /api/sessions/${chatId}`] = () => {
      throw new RestError(500, "", "The dashboard answered 500");
    };
    expect(await hermes.delete(chatId)).toBe(false);
    expect(hermes.getSnapshot().branches.links[chatId]).toMatchObject({ parentId: "c1" });
  });

  it("keeps each profile's branches apart", async () => {
    const cache = memoryCache();
    const { hermes, itemWith } = await chatWithHistory({ cache });
    const { chatId } = await hermes.branch(await hermes.previewBranch("c1", itemWith("81% full")));
    expect(Object.keys(cache.branches.default.links)).toEqual([chatId]);
    expect(cache.loadBranches("work")).toEqual({ links: {}, attempts: [] });
  });

  it("forgets a branch's link when the branch is deleted", async () => {
    const { hermes, itemWith } = await chatWithHistory();
    const { chatId } = await hermes.branch(await hermes.previewBranch("c1", itemWith("81% full")));
    await hermes.idle();
    expect(await hermes.delete(chatId)).toBe(true);
    expect(hermes.getSnapshot().branches.links).toEqual({});
  });
});
