import { describe, expect, it } from "vitest";
import { handoffs, type DispatchedTask } from "./dispatched";
import { inboxEntries, type InboxEntry } from "./inbox";
import type { Chat, OtherProfiles } from "./model";
import { officeRooms, officeTally } from "./office";
import { SUBAGENTS_MAX, onSubagentEvent, type SubagentTree } from "./subagents";

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: 1_000, items: [], ...over });
const started = (tree: SubagentTree | undefined, id: string, more: Record<string, unknown> = {}) =>
  onSubagentEvent(tree, "subagent.start", { subagent_id: id, goal: `Goal ${id}`, depth: 0, ...more }, 2_000);
const none: OtherProfiles = { byName: {} };

function rooms(chats: Chat[], { others = none, connected = true, dismissed = new Set<string>() } = {}) {
  const { entries } = inboxEntries({ profile: "default", chats, connected, others, handoffs: handoffs(chats, {}, 3_000) });
  return officeRooms({ entries, shown: (e: InboxEntry) => !dismissed.has(e.key), chats, profile: "default", connected });
}
const brief = (rs: ReturnType<typeof rooms>) => rs.map((r) => `${r.profile}/${r.chatId}: ${r.desks.map((d) => d.state).join(" ")}`);

describe("The office's rooms", () => {
  it("has a room for each chat the inbox lists, then each chat with subagents, the reply's desk first", () => {
    const tree = started(started(undefined, "a"), "b", { parent_id: "a", depth: 1 });
    const ended = onSubagentEvent(onSubagentEvent(tree, "subagent.complete", { subagent_id: "b", status: "completed" }, 2_500), "subagent.complete", { subagent_id: "a", status: "completed" }, 2_500);
    const others: OtherProfiles = { byName: { work: { chats: [{ id: "w1", title: "Deploy", at: 5_000, unread: true, source: "app" }] } } };
    expect(brief(rooms([chat("quiet", { subagents: ended, updatedAt: 2_600 }), chat("busy", { running: true })], { others }))).toEqual([
      "work/w1: unread",
      "default/busy: running",
      "default/quiet: idle completed completed",
    ]);
    expect(brief(rooms([chat("quiet", { subagents: tree }), chat("busy", { running: true })], { others }))).toEqual([
      "work/w1: unread",
      "default/quiet: handedOff running running",
      "default/busy: running",
    ]);
  });

  it("shows the reply's most pressing state: an Approval over a failure, a failure over a finished reply", () => {
    const waiting = { kind: "approval", id: "ap", requestId: "r1", command: "rm", description: "", choices: ["once", "deny"] } as unknown as Chat["items"][number];
    const failure = { kind: "error", id: "e-1", text: "Boom" } as unknown as Chat["items"][number];
    expect(brief(rooms([chat("c", { running: true, unread: true, items: [failure, waiting] })]))).toEqual(["default/c: approval"]);
    expect(brief(rooms([chat("c", { unread: true, items: [failure] })]))).toEqual(["default/c: failed"]);
  });

  it("drops what already happened once the owner dismisses it in the inbox, but never running work", () => {
    const failure = { kind: "error", id: "e-1", text: "Boom" } as unknown as Chat["items"][number];
    const chats = [chat("done", { unread: true }), chat("broke", { items: [failure] }), chat("busy", { running: true })];
    const keys = new Set(inboxEntries({ profile: "default", chats, connected: true, others: none }).entries.map((e) => e.key));
    expect(brief(rooms(chats, { dismissed: keys }))).toEqual(["default/busy: running"]);
  });

  it("says a reply's entry was dismissed when that leaves it with none, so its agent goes home, and not once there is something new", () => {
    // Its subagent finished before the chat's last update, so the reply waits on nothing handed off.
    const finished = onSubagentEvent(started(undefined, "a"), "subagent.complete", { subagent_id: "a", status: "completed" }, 2_500);
    const chats = [chat("done", { unread: true, updatedAt: 2_600, subagents: finished })];
    const keys = new Set(inboxEntries({ profile: "default", chats, connected: true, others: none }).entries.map((e) => e.key));
    expect(rooms(chats)[0].desks[0].agent).toEqual({ kind: "reply", entry: expect.objectContaining({ kind: "completed" }) });
    expect(rooms(chats, { dismissed: keys })[0].desks[0]).toMatchObject({ state: "idle", agent: { kind: "reply", dismissed: true } });
    const again = [chat("done", { unread: true, running: true, updatedAt: 2_600, subagents: finished })];
    expect(rooms(again, { dismissed: keys })[0].desks[0]).toMatchObject({ state: "running", agent: { kind: "reply", entry: expect.anything() } });
    expect(rooms([chat("quiet", { updatedAt: 2_600, subagents: finished })])[0].desks[0].agent).toEqual({ kind: "reply" });
  });

  it("never shows a reply as finished on an unread chat alone, nor counts it as work", () => {
    const stopped = { kind: "assistant", id: "m-1", text: "Half a repl", stopped: true } as unknown as Chat["items"][number];
    const rs = rooms([chat("read-later", { unread: true }), chat("cut-short", { unread: true, items: [stopped], subagents: started(undefined, "a") })]);
    expect(rs.flatMap((r) => r.desks.filter((d) => d.agent.kind === "reply").map((d) => d.state))).toEqual(["unread", "handedOff"]);
    expect(rs.flatMap((r) => r.desks).some((d) => d.state === "completed")).toBe(false);
    expect(officeTally(rs)).toEqual({ working: 2, waiting: 0, failed: 0, desks: 3 });
  });

  it("marks another profile's desks as last seen once a check can't list the profiles, keeping what the one before read", () => {
    const listed = { chats: [{ id: "w1", title: "Deploy", at: 5_000, unread: true, source: "app" as const }], checkedAt: 4_000 };
    expect(rooms([], { others: { byName: { work: listed } } })[0].desks[0].stale).toBeUndefined();
    const failed = rooms([], { others: { byName: { work: listed }, error: "Couldn't list the profiles: 502" } });
    expect(failed[0].desks[0]).toMatchObject({ state: "unread", stale: "As last seen: Hermes couldn't be checked." });
    const seen = { ...listed, failures: [{ chatId: "w1", title: "Deploy", itemId: "e-1", mark: "x" }] };
    for (const others of [{ byName: { work: seen }, error: "502" }, { byName: { work: { ...seen, error: "502" } } }])
      expect(rooms([], { others })[0].desks[0]).toMatchObject({ state: "failed", stale: "As last seen: Hermes couldn't be checked." });
  });

  it("says why every desk is as last seen while disconnected, and never calls a reply it can't see idle", () => {
    const rs = rooms([chat("c", { subagents: started(undefined, "a") })], { connected: false });
    expect(rs[0].desks.map((d) => [d.state, d.stale])).toEqual([
      ["handedOff", "Not connected to Hermes: as last seen."],
      ["running", "Not connected to Hermes: as last seen."],
    ]);
  });

  it("holds every subagent of many chats, each once, and counts them", () => {
    const chats = Array.from({ length: 30 }, (_, n) => {
      let tree: SubagentTree | undefined;
      for (let i = 0; i < SUBAGENTS_MAX; i++) tree = started(tree, `s${i}`, i % 10 ? { parent_id: `s${i - (i % 10)}`, depth: 1 } : {});
      return chat(`c${n}`, { running: true, subagents: tree });
    });
    const rs = rooms(chats);
    expect(rs).toHaveLength(30);
    expect(new Set(rs.flatMap((r) => r.desks.map((d) => d.key))).size).toBe(30 * (SUBAGENTS_MAX + 1));
    expect(officeTally(rs)).toEqual({ working: 30 * (SUBAGENTS_MAX + 1), waiting: 0, failed: 0, desks: 30 * (SUBAGENTS_MAX + 1) });
    const order = rs[0].desks.slice(1).map((d) => (d.agent.kind === "subagent" ? d.agent.id : ""));
    expect(order.slice(0, 11)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
  });
  it("shows a reply that handed work off as waiting, at work for the tally, with the subagents it waits on", () => {
    const task: DispatchedTask = { id: "t_1", board: "default", status: "ready", createdAt: 2_000, picked: false };
    const rs = rooms([chat("sent", { tasks: [task], subagents: started(undefined, "a") }), chat("stuck", { tasks: [{ ...task, status: "blocked" }] })]);
    expect(brief(rs)).toEqual(["default/stuck: approval", "default/sent: handedOff running"]);
    expect(rs[1].desks[0].doing).toEqual({ text: "Hermes is waiting on work it handed off.", at: 1_000 });
    expect(officeTally(rs)).toEqual({ working: 2, waiting: 1, failed: 0, desks: 3 });
  });

  it("shows the wake turn of a chat whose dispatched task needs the owner as running, as its row does", () => {
    const blocked: DispatchedTask = { id: "t_1", board: "default", status: "blocked", createdAt: 2_000, picked: true };
    expect(brief(rooms([chat("stuck", { tasks: [blocked], running: true })]))).toEqual(["default/stuck: running"]);
    expect(brief(rooms([chat("stuck", { tasks: [blocked] })]))).toEqual(["default/stuck: approval"]);
  });

  it("gives the card a subagent's goal, model and start, and the reply's model when the chat is on this connection", () => {
    const tree = started(undefined, "a", { model: "sub-model" });
    const [room] = rooms([chat("c", { running: true, model: { provider: "p", model: "chat-model" }, subagents: tree })]);
    expect(room.desks.map((d) => d.detail)).toEqual([{ model: "chat-model" }, { goal: "Goal a", model: "sub-model", startedAt: 2_000 }]);
  });
});
