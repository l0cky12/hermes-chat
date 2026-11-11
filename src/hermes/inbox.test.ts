import { afterEach, describe, expect, it, vi } from "vitest";
import { handoffs } from "./dispatched";
import { FakeHermes, readRow, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { INBOX_PREFIX, blocksRestore, inboxAcks, inboxEntries, needsOwner, type InboxEntry, type InboxKind } from "./inbox";
import type { OutgoingItem } from "./model";
import { connect, type Hermes } from "./transport";

const nowS = () => Date.now() / 1000;
const unreadRow = (id: string, minutesAgo = 1, over = {}) => row(id, minutesAgo / 1440, { last_read_at: 0, ...over });

/** What the inbox shows for the app's snapshot now. */
const inbox = (hermes: Hermes) => {
  const s = hermes.getSnapshot();
  return inboxEntries({ profile: s.profile, chats: s.chats, connected: s.status === "connected", others: s.others, live: s.live });
};
const brief = (e: InboxEntry) => `${e.kind}${e.ended ? " (ended)" : ""} ${e.profile}/${e.chatId}${e.stale ? " stale" : ""}`;

/** Signed in to `default`, on a server that also has the `work` and `ops` profiles. */
async function signedIn(cache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [readRow("home-1", 1)];
  server.otherProfiles = {
    work: [unreadRow("work-done"), readRow("work-busy", 0), readRow("work-asks", 0)],
    ops: [readRow("ops-1", 1)],
  };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  return { server, hermes, cache };
}

/** A new chat in the shown profile with a reply under way. */
async function replying(server: FakeHermes, hermes: Hermes) {
  const id = await hermes.newChat();
  await hermes.send(id, "Clean up the logs");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  return { id, runtime };
}

function storage() {
  const items: Record<string, string> = {};
  return { items, getItem: (k: string) => items[k] ?? null, setItem: (k: string, v: string) => void (items[k] = v) };
}

afterEach(() => void vi.useRealTimers());

describe("The inbox", () => {
  it("lists a chat waiting on work it handed off as running, not finished, and a task that needs the owner as asking", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "dispatch a research task");
    await vi.advanceTimersByTimeAsync(0);
    const chats = hermes.getSnapshot().chats.map((c) => (c.id === id ? { ...c, unread: true } : c));
    const sources = (now: number) => ({ profile: "default", chats, connected: true, others: { byName: {} }, handoffs: handoffs(chats, {}, now) });
    const waiting = inboxEntries(sources(Date.now())).entries.filter((e) => e.chatId === id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ key: `running default ${id}`, kind: "running", waiting: true, summary: "Hermes is waiting on work it handed off.", stale: false });
    const task = server.kanban.boards.default.tasks.at(-1)!;
    server.kanban.move(task.id, "blocked");
    await vi.advanceTimersByTimeAsync(0);
    const stuck = hermes.getSnapshot().chats;
    const asking = inboxEntries({ profile: "default", chats: stuck, connected: true, others: { byName: {} }, handoffs: handoffs(stuck, {}, Date.now()) }).entries.filter((e) => e.chatId === id);
    expect(asking.map((e) => [e.key, e.kind, e.summary, e.itemId, e.taskId])).toEqual([[`handoff default ${id} ${task.id} blocked`, "approval", "A dispatched task is blocked.", undefined, task.id]]);
  });

  it("shows work finished and asking for approval in background profiles, each with its profile, chat and time", async () => {
    const { server, hermes } = await signedIn();
    const busyAt = nowS() - 5;
    server.liveSessions = [
      { id: "rt-x", session_key: "work-busy", status: "working", last_active: busyAt },
      { id: "rt-y", session_key: "work-asks", status: "waiting", last_active: busyAt },
      // Sitting idle isn't anything the owner needs to know.
      { id: "rt-z", session_key: "ops-1", status: "idle", last_active: busyAt },
    ];
    await hermes.checkOtherProfiles();

    const { entries, unmatched } = inbox(hermes);
    expect(entries.map(brief)).toEqual(["approval work/work-asks", "completed work/work-done", "running work/work-busy"]);
    expect(unmatched).toBe(0);
    expect(entries[0]).toMatchObject({ title: "Chat work-asks", at: busyAt * 1000, summary: expect.stringContaining("waiting for your answer") });
    expect(entries[1]).toMatchObject({ title: "Chat work-done", at: expect.any(Number) });
    expect(entries.filter(needsOwner).length).toBe(2);
    // Reading the server for the inbox resumed, answered or marked nothing.
    expect(server.requests.map((r) => r.method).filter((m) => m !== "client.capabilities")).toEqual(["subagent.roster", "session.active_list"]);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(server.approvalAnswers).toEqual([]);
  });

  it("lists every Approval waiting in one chat, and says when Hermes stops waiting on one", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const first = server.askApproval(runtime);
    const second = server.askApproval(runtime, { request_id: "apr-two", command: "shutdown now" });

    expect(inbox(hermes).entries.filter((e) => e.kind === "approval").map((e) => e.itemId)).toEqual([first.id, second.id]);
    // A reply held up by an Approval is listed as waiting, not also as running.
    expect(inbox(hermes).entries.filter((e) => e.kind === "running" || e.chatId !== id)).toEqual([]);

    server.cancelRequest(first.id!, "timeout");
    const approvals = inbox(hermes).entries.filter((e) => e.kind === "approval");
    expect(approvals.map((e) => [e.itemId, !!e.ended, needsOwner(e)])).toEqual([
      [first.id, true, false],
      [second.id, false, true],
    ]);
    // The inbox never quotes the command.
    expect(JSON.stringify(inbox(hermes).entries)).not.toMatch(/rm -rf|shutdown/);
  });

  it("shows each Approval once after reconnects replay it, and never brings back one that expired", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id: chatId, runtime } = await replying(server, hermes);
    server.transcripts[chatId] = [{ role: "user", text: "Clean up the logs" }];
    const waiting = server.askApproval(runtime);
    const expired = server.askApproval(runtime, { request_id: "apr-old" });
    const asked = server.openRequests.get(expired.id!)!;
    server.cancelRequest(expired.id!, "timeout");
    // Hermes lists the expired one again when the chat resumes.
    server.openRequests.set(expired.id!, asked);
    const keys = () => inbox(hermes).entries.filter((e) => e.kind === "approval").map((e) => `${e.key}${e.ended ? " ended" : ""}`);
    expect(keys()).toEqual([`approval default ${chatId} ${waiting.requestId}`, `approval default ${chatId} apr-old ended`]);

    for (let i = 0; i < 3; i++) {
      server.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      await hermes.idle();
    }

    // The waiting one shows once, under the same key; the expired one's card is gone, not back to waiting.
    expect(keys()).toEqual([`approval default ${chatId} ${waiting.requestId}`]);
    expect(inbox(hermes).entries.filter(needsOwner).map((e) => e.itemId)).toEqual([waiting.id]);
  });

  it("keeps a dismissal through reconnects, and shows the entry again only for something newer", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    await hermes.checkOtherProfiles();
    const acks = inboxAcks(storage(), "server");
    const shown = () => inbox(hermes).entries.filter((e) => !acks.isDismissed(e));
    for (const e of shown().filter((e) => e.kind !== "running")) acks.dismiss(e);
    expect(shown()).toEqual([]);

    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(shown().filter((e) => e.kind !== "running")).toEqual([]);

    // New activity in the chat dismissed as completed brings it back.
    server.otherProfiles.work[0].last_active = nowS() + 60;
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(shown().map(brief)).toContain("completed work/work-done");
  });

  it("dismisses the entry only: the chat stays Unread, Active or Settled, and as archived as it was", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(unreadRow("home-unread", 1, { pinned: true }));
    await hermes.sync();
    const chatBefore = hermes.getSnapshot().chats.find((c) => c.id === "home-unread");
    const acks = inboxAcks(storage(), "server");
    const entry = inbox(hermes).entries.find((e) => e.chatId === "home-unread")!;
    expect(entry).toMatchObject({ kind: "completed", profile: "default" });

    acks.dismiss(entry);
    await hermes.sync();
    expect(hermes.getSnapshot().chats.find((c) => c.id === "home-unread")).toEqual(chatBefore);
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(acks.isDismissed(inbox(hermes).entries.find((e) => e.chatId === "home-unread")!)).toBe(true);
  });

  it("tells failed messages from ones Hermes may have, in profiles not shown too", async () => {
    const cache = memoryCache();
    const failed: OutgoingItem = { kind: "user", id: "u-1", text: "hi", outgoing: { state: "failed", reason: "session busy" } };
    const unsure: OutgoingItem = { kind: "user", id: "u-2", text: "deploy", outgoing: { state: "unknown", reason: "dropped" } };
    cache.saveOutbox("work", "work-busy", [failed, unsure]);
    const { hermes } = await signedIn(cache);
    await hermes.checkOtherProfiles();

    const sends = inbox(hermes).entries.filter((e) => e.kind === "failed" || e.kind === "uncertain");
    expect(sends.map((e) => [e.kind, e.profile, e.chatId, e.title, e.itemId])).toEqual([
      ["failed", "work", "work-busy", "Chat work-busy", "u-1"],
      ["uncertain", "work", "work-busy", "Chat work-busy", "u-2"],
    ]);
    expect(sends[1].summary).toBe("A message you sent may not have reached Hermes.");
  });

  it("keeps the title of a new chat whose first message failed, after switching away", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes.send(id, "Draft the email");
    await hermes.switchProfile("work");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.find((e) => e.kind === "failed")).toMatchObject({ profile: "default", chatId: id, title: "Draft the email" });
  });

  it("marks what it last saw from Hermes while the live check fails", async () => {
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-x", session_key: "work-busy", status: "working", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    const answered = hermes.checkTimes.get().live;
    server.handlers["session.active_list"] = (r) => server.fail(r.id, 5000, "store busy");
    vi.useFakeTimers({ now: Date.now() + 20_000 });
    await hermes.checkOtherProfiles();

    expect(hermes.getSnapshot().live).toMatchObject({ error: "store busy" });
    expect(hermes.checkTimes.get().live).toBe(answered);
    expect(inbox(hermes).entries.map(brief)).toEqual(["completed work/work-done", "running work/work-busy stale"]);
  });

  it("marks what it last saw from a profile it couldn't check", async () => {
    const { server, hermes } = await signedIn();
    await hermes.checkOtherProfiles();
    const list = server.rest["GET /api/sessions"];
    server.rest["GET /api/sessions"] = (req) => {
      if (req.query.get("profile") === "work") throw new Error("The dashboard answered 503: busy");
      return list(req);
    };
    vi.useFakeTimers({ now: Date.now() + 20_000 });
    await hermes.checkOtherProfiles();

    expect(hermes.getSnapshot().others.byName.work.error).toContain("503");
    expect(inbox(hermes).entries.map(brief)).toEqual(["completed work/work-done stale"]);
  });

  it("finds the profile of a live session by its id, even one past the chats a check reads", async () => {
    const { server, hermes } = await signedIn();
    for (let i = 0; i < 60; i++) server.otherProfiles.work.push(row(`filler-${i}`, 0));
    server.otherProfiles.work.push(readRow("old-job", 20, { title: "Old job" }));
    server.liveSessions = [{ id: "rt-o", session_key: "old-job", status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();

    expect(hermes.getSnapshot().others.byName.work.chats?.some((c) => c.id === "old-job")).toBe(false);
    expect(inbox(hermes).entries.find((e) => e.chatId === "old-job")).toMatchObject({ kind: "approval", profile: "work", title: "Old job" });
    const lookups = server.restRequests.filter((r) => r.path === "/api/sessions/old-job").map((r) => r.query.get("profile"));
    expect(lookups.sort()).toEqual(["default", "ops", "work"]);
  });

  it("lists a live session no more when a copied profile has the same id, or a profile couldn't be asked", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    // An idle copy of work's chat, in a profile whose list never shows it.
    for (let i = 0; i < 60; i++) server.otherProfiles.ops.push(row(`filler-${i}`, 0));
    server.otherProfiles.ops.push(row("work-asks", 25, { title: "A copy" }));
    server.liveSessions = [{ id: "rt-y", session_key: "work-asks", status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    expect(inbox(hermes)).toMatchObject({ entries: expect.not.arrayContaining([expect.objectContaining({ chatId: "work-asks", kind: "approval" })]), unmatched: 1 });

    // A profile that answers with an error says nothing about where the session is, so it is asked again later.
    server.otherProfiles.ops = server.otherProfiles.ops.filter((r) => r.id !== "work-asks");
    server.liveSessions = [{ id: "rt-z", session_key: "work-busy", status: "working", last_active: nowS() }];
    server.rest["GET /api/sessions/work-busy"] = (req) => {
      const profile = req.query.get("profile");
      if (profile === "ops") throw new Error("The dashboard answered 503: busy");
      if (profile === "work") return server.otherProfiles.work.find((r) => r.id === "work-busy");
      throw new Error(`The dashboard answered 404: {"detail":"Session not found"}`);
    };
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).unmatched).toBe(1);

    delete server.rest["GET /api/sessions/work-busy"];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).toContain("running work/work-busy");
  });

  it("looks up every live session in turn, though the first few can't be placed yet", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    // Three chats too new to be stored yet come first, and stay unplaced.
    server.liveSessions = [
      ...["new-1", "new-2", "new-3"].map((id, i) => ({ id: `rt-${i}`, session_key: id, status: "working", last_active: nowS() })),
      { id: "rt-4", session_key: "work-busy", status: "working", last_active: nowS() },
    ];
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).not.toContain("running work/work-busy");

    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).toContain("running work/work-busy");
    expect(inbox(hermes).unmatched).toBe(3);
  });

  it("looks a chat up again when it runs again, so a profile copied since can't put it in the wrong one", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-1", session_key: "work-busy", status: "working", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).toContain("running work/work-busy");

    // work is copied, ids and all, and the copy's chat runs.
    server.otherProfiles["work-copy"] = server.otherProfiles.work.map((r) => ({ ...r }));
    server.liveSessions = [{ id: "rt-2", session_key: "work-busy", status: "working", last_active: nowS() }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).not.toContain("running work/work-busy");
    expect(inbox(hermes).unmatched).toBe(1);
  });

  it("keeps a waiting session dismissed once resuming its chat shows the Approval, until Hermes reports it active since", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-a", session_key: "work-asks", status: "waiting", last_active: nowS() - 60 }];
    server.openRequests.set("srq-a", {
      sid: "rt-a",
      stored: "work-asks",
      method: "approval",
      params: { request_id: "apr-a", command: "x", description: "y", choices: ["once", "deny"] },
    });
    await hermes.checkOtherProfiles();
    const acks = inboxAcks(storage(), "server");
    acks.dismiss(inbox(hermes).entries.find((e) => e.key === "waiting work work-asks")!);

    await hermes.switchProfile("work");
    await hermes.idle();
    await hermes.open("work-asks");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    const card = () => inbox(hermes).entries.find((e) => e.kind === "approval" && e.chatId === "work-asks")!;
    expect(card()).toMatchObject({ key: "approval work work-asks apr-a", itemId: "srq-a" });
    expect(acks.isDismissed(card())).toBe(true);
    expect(server.approvalAnswers).toEqual([]);

    // Active since the dismissal: what it waits on now may be new.
    server.liveSessions[0].last_active = nowS() + 5;
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(acks.isDismissed(card())).toBe(false);
  });

  it("keeps the Approval a dismissed waiting session showed on resume dismissed when the connection then drops", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-a", session_key: "work-asks", status: "waiting", last_active: nowS() - 60 }];
    server.openRequests.set("srq-a", {
      sid: "rt-a",
      stored: "work-asks",
      method: "approval",
      params: { request_id: "apr-a", command: "x", description: "y", choices: ["once", "deny"] },
    });
    await hermes.checkOtherProfiles();
    const acks = inboxAcks(storage(), "server");
    acks.dismiss(inbox(hermes).entries.find((e) => e.key === "waiting work work-asks")!);
    await hermes.switchProfile("work");
    await hermes.idle();
    await hermes.open("work-asks");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    // What the app does each time it works the inbox out.
    acks.keepCovered(inbox(hermes).entries);

    server.refuse = "Connection refused";
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes.getSnapshot().status).not.toBe("connected");
    const card = inbox(hermes).entries.find((e) => e.kind === "approval" && e.chatId === "work-asks")!;
    expect(card).toMatchObject({ key: "approval work work-asks apr-a", aliasAt: undefined });
    expect(acks.isDismissed(card)).toBe(true);
  });

  it("doesn't bring back an Approval that timed out when the connection then drops", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const asked = server.askApproval(runtime);
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.cancelRequest(asked.id!, "timeout");
    server.refuse = "Connection refused";
    server.drop();

    expect(inbox(hermes).entries.filter((e) => e.chatId === id && needsOwner(e))).toEqual([]);
  });

  it("keeps another Approval in the same chat after one is dismissed and the owner switches away", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const a = server.askApproval(runtime);
    const b = server.askApproval(runtime, { request_id: "apr-b" });
    const acks = inboxAcks(storage(), "server");
    const card = (itemId?: string) => inbox(hermes).entries.find((e) => e.itemId === itemId)!;
    acks.dismiss(card(a.id), inbox(hermes).entries);

    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.switchProfile("work");
    await hermes.idle();
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() - 1 }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    const waiting = () => inbox(hermes).entries.find((e) => e.key === `waiting default ${id}`)!;
    // B still waits and wasn't dismissed.
    expect(acks.isDismissed(waiting())).toBe(false);
    expect(b.id).toBeDefined();
  });

  it("puts a session this app started with its own profile by its runtime id, though a copied profile lists the same id", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.otherProfiles.ops.push(row(id, 0, { title: "A copy" }));
    await hermes.switchProfile("work");
    await hermes.idle();
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();

    expect(inbox(hermes).entries.filter((e) => e.chatId === id).map(brief)).toEqual([`approval default/${id}`]);
  });

  it("goes by the chat on screen, not by an older check, once an Approval there has expired", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const asked = server.askApproval(runtime);
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.cancelRequest(asked.id!, "timeout");

    expect(inbox(hermes).entries.filter((e) => e.chatId === id && needsOwner(e))).toEqual([]);
  });

  it("shows an Approval once while the connection is down, though a check from before says its chat waits", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.refuse = "Connection refused";
    server.drop();

    expect(inbox(hermes).entries.filter((e) => e.chatId === id).map(brief)).toEqual([`approval default/${id} stale`]);
  });

  it("keeps an Approval dismissed after switching away, when only a check says its chat waits", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    const acks = inboxAcks(storage(), "server");
    acks.dismiss(inbox(hermes).entries.find((e) => e.kind === "approval" && e.chatId === id)!);

    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.switchProfile("work");
    await hermes.idle();
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() - 1 }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    const waiting = () => inbox(hermes).entries.find((e) => e.key === `waiting default ${id}`)!;
    expect(acks.isDismissed(waiting())).toBe(true);

    // Waiting again since then shows again.
    server.liveSessions[0].last_active = nowS() + 5;
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(acks.isDismissed(waiting())).toBe(false);
  });

  it("keeps a failure seen in a profile after switching away from it, pointing at its error", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.event(runtime, "message.complete", { status: "error", failure_reason: "provider timed out", text: "" });
    const failed = inbox(hermes).entries.find((e) => e.kind === "failed")!;
    expect(failed).toMatchObject({ profile: "default", chatId: id, itemId: expect.stringMatching(/^e-/) });

    await hermes.switchProfile("work");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.find((e) => e.kind === "failed")).toMatchObject({ key: failed.key, itemId: failed.itemId });
    expect(JSON.stringify(hermes.getSnapshot().others)).not.toContain("provider timed out");
  });

  it("asks a server without session.active_list no more, and says so", async () => {
    const { server, hermes } = await signedIn();
    server.handlers["session.active_list"] = (r) => server.fail(r.id, -32601, "method not found");
    await hermes.checkOtherProfiles();
    expect(hermes.getSnapshot().live).toEqual({ sessions: [], unsupported: true });

    vi.useFakeTimers({ now: Date.now() + 60_000 });
    await hermes.checkOtherProfiles();
    expect(server.requests.filter((r) => r.method === "session.active_list")).toHaveLength(1);
  });

  it("asks Hermes at most once in 15 seconds, and drops an answer from a connection that has since dropped", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    let answer: (() => void) | undefined;
    server.handlers["session.active_list"] = (r) => (answer = () => server.respond(r.id, { sessions: [{ session_key: "work-busy", status: "working", last_active: nowS() }] }));
    const first = hermes.checkOtherProfiles();
    void hermes.checkOtherProfiles();
    expect(server.requests.filter((r) => r.method === "session.active_list")).toHaveLength(1);

    server.drop();
    answer!();
    await first;
    expect(hermes.getSnapshot().live).toBeUndefined();
  });

  it("leaves out a live session it can't put with exactly one chat, and counts it", async () => {
    const { server, hermes } = await signedIn();
    // A copied profile can hold the same stored session ids.
    server.otherProfiles.ops.push(row("work-busy", 0));
    server.liveSessions = [
      { id: "rt-1", session_key: "work-busy", status: "working", last_active: nowS() },
      { id: "rt-2", session_key: "somewhere-else", status: "waiting", last_active: nowS() },
    ];
    await hermes.checkOtherProfiles();
    const { entries, unmatched } = inbox(hermes);
    expect(entries.filter((e) => e.kind === "running" || e.kind === "approval")).toEqual([]);
    expect(unmatched).toBe(2);
  });

  it("forgets dismissals after 30 days", () => {
    let now = 1_000_000;
    const store = storage();
    const acks = inboxAcks(store, "server", () => now);
    const e = { key: "completed work a", kind: "completed", profile: "work", chatId: "a", title: "a", at: 5, summary: "" } as InboxEntry;
    acks.dismiss(e);
    expect(inboxAcks(store, "server", () => now).isDismissed(e)).toBe(true);
    // Another server's dismissals are its own.
    expect(inboxAcks(store, "other", () => now).isDismissed(e)).toBe(false);

    // Expired on load, and in the store already open, without another dismissal first.
    now += 31 * 86_400_000;
    expect(acks.isDismissed(e)).toBe(false);
    expect(inboxAcks(store, "server", () => now).isDismissed(e)).toBe(false);
  });
});

describe("Auto-dismissing finished entries", () => {
  const DAY = 86_400_000;
  const T0 = 100 * DAY;
  const entry = (id: string, at: number, kind: InboxKind = "completed"): InboxEntry => ({ key: `${kind} work ${id}`, kind, profile: "work", chatId: id, title: id, at, summary: "" });
  /** A store that counts its writes. */
  const counted = () => {
    const s = storage();
    let writes = 0;
    return { ...s, setItem: (k: string, v: string) => (writes++, s.setItem(k, v)), writes: () => writes };
  };
  const record = (s: { items: Record<string, string> }) => JSON.parse(s.items[INBOX_PREFIX + "server"] ?? "{}");

  it("dismisses a finished entry once it is older than the time picked, as a dismissal by hand would", () => {
    const now = T0;
    const store = storage();
    const acks = inboxAcks(store, "server", () => now);
    const atLimit = entry("a", now - 2 * DAY);
    const past = entry("b", now - 2 * DAY - 1);
    acks.expire([atLimit, past], 2 * DAY);
    expect(acks.isDismissed(atLimit)).toBe(false);
    expect(acks.isDismissed(past)).toBe(true);

    const reloaded = inboxAcks(store, "server", () => now);
    expect(reloaded.isDismissed(past)).toBe(true);
    expect(record(store)).toEqual({ [past.key]: [past.at, now] });
    const byHand = storage();
    inboxAcks(byHand, "server", () => now).dismiss(past);
    expect(record(store)).toEqual(record(byHand));
  });

  it("shows the chat again once it has something newer", () => {
    let now = T0;
    const acks = inboxAcks(storage(), "server", () => now);
    acks.expire([entry("a", now - 3 * DAY)], 2 * DAY);
    expect(acks.isDismissed(entry("a", now - 3 * DAY))).toBe(true);
    now += DAY;
    const newer = entry("a", now - 60_000);
    acks.expire([newer], 2 * DAY);
    expect(acks.isDismissed(newer)).toBe(false);
  });

  it("doesn't record again an entry already dismissed", () => {
    let now = T0;
    const store = counted();
    const acks = inboxAcks(store, "server", () => now);
    const e = entry("a", now - 60_000);
    acks.dismiss(e);
    const writes = store.writes();
    now += 3 * DAY;
    acks.expire([e], 2 * DAY);
    expect(store.writes()).toBe(writes);
    expect(record(store)[e.key]).toEqual([e.at, T0]);
  });

  it("never dismisses running work, Approvals, failures, uncertain sends, or an entry whose time isn't known", () => {
    const now = T0;
    const store = counted();
    const acks = inboxAcks(store, "server", () => now);
    const old = now - 30 * DAY;
    const kept = [entry("r", old, "running"), entry("p", old, "approval"), entry("f", old, "failed"), entry("u", old, "uncertain"), entry("c", 0)];
    acks.expire(kept, DAY);
    for (const e of kept) expect(acks.isDismissed(e)).toBe(false);
    expect(store.writes()).toBe(0);
  });

  it("settles when more are due than the most dismissals kept", () => {
    const now = T0;
    const store = counted();
    const acks = inboxAcks(store, "server", () => now);
    const due = Array.from({ length: 1001 }, (_, i) => entry(`c${i}`, now - 2 * DAY - i));
    acks.expire(due, DAY);
    expect(store.writes()).toBe(1);
    expect(Object.keys(record(store))).toHaveLength(1000);
    acks.expire(due, DAY);
    expect(store.writes()).toBe(1);
  });

  it("dismisses every entry given at once, in one write", () => {
    const now = T0;
    const store = counted();
    const acks = inboxAcks(store, "server", () => now);
    const es = [entry("a", now - 60_000), entry("b", now - 120_000), entry("c", now - 180_000)];
    acks.dismissAll(es, es);
    for (const e of es) expect(acks.isDismissed(e)).toBe(true);
    expect(store.writes()).toBe(1);
  });
});

describe("what a restore waits for", () => {
  const entry = (kind: InboxKind, extra: Partial<InboxEntry> = {}): InboxEntry => ({ key: `${kind} ${JSON.stringify(extra)}`, kind, profile: "default", chatId: "c", title: "c", at: 0, summary: "", ...extra });
  it("waits for a reply and an Approval, not for handed-off work or a dispatched task that needs the owner", () => {
    expect(blocksRestore(entry("running"))).toBe(true);
    expect(blocksRestore(entry("approval"))).toBe(true);
    expect(blocksRestore(entry("running", { waiting: true }))).toBe(false);
    expect(blocksRestore(entry("approval", { taskId: "t_1" }))).toBe(false);
    expect(blocksRestore(entry("approval", { ended: true }))).toBe(false);
    expect(blocksRestore(entry("completed"))).toBe(false);
  });
});
