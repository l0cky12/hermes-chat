// Idle compaction (ADR 0119), driven against the fake Hermes: which chats are due, once per idle stretch, one at a
// time, a send during a compaction waiting for it, and what the owner is told.
import { describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { IdleCompactor, idleCompactionNote, isDue, type IdleCompaction } from "./idleCompact";
import type { Chat } from "./model";
import { connect, type Hermes } from "./transport";
import type { IdleCompactPrefs } from "./uiPrefs";

const MIN = 60_000;
const ON: IdleCompactPrefs = { enabled: true, percent: 70, idleMinutes: 15 };
const COMPRESSED = { status: "compressed", before_messages: 40, after_messages: 9, before_tokens: 140_000, after_tokens: 21_000, summary: { headline: "Compressed: 40 → 9 messages" } };

/** `server._get_usage` as the deployed Hermes sends it, for a session with a compactor. */
const usage = (percent: number, extra: Record<string, unknown> = {}) => ({
  usage: { input: 1_000, output: 100, calls: 1, context_used: percent * 2_000, context_max: 200_000, context_percent: percent, context_estimated: false, compressions: 0, ...extra },
});

/** Two stored chats opened on a fake Hermes, each measured at `percent` full. */
async function setUp(percents: Record<string, number> = { nas: 82 }) {
  const server = new FakeHermes();
  server.compressResult = COMPRESSED;
  server.sessions = Object.keys(percents).map((id, i) => row(id, 1 - i * 0.1, { title: id.toUpperCase() }));
  for (const id of Object.keys(percents)) server.storeMessage(id, { role: "user", text: "hello" });
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  for (const [id, p] of Object.entries(percents)) {
    await hermes.open(id);
    server.event(server.runtimeIdOf(id)!, "session.usage", usage(p));
  }
  await hermes.idle();
  const reports: IdleCompaction[] = [];
  let prefs = ON;
  const compactor = new IdleCompactor(hermes, () => prefs, (c) => reports.push(c));
  const chats = () => hermes.getSnapshot().chats;
  compactor.observe(chats(), 0);
  const check = (now: number) => compactor.check(chats(), hermes.getSnapshot().status, now);
  const asked = () => server.requests.filter((r) => r.method === "session.compress").map((r) => r.params.session_id);
  /** Something happens in `id` at `at`: Hermes ends a turn there, measured at `percent`. */
  const touch = async (id: string, at: number, percent: number) => {
    server.event(server.runtimeIdOf(id)!, "message.complete", { text: "ok", ...usage(percent) });
    await hermes.idle();
    compactor.observe(chats(), at);
  };
  return { server, hermes, compactor, reports, chats, check, asked, touch, setPrefs: (p: IdleCompactPrefs) => void (prefs = p) };
}

describe("Idle compaction", () => {
  it("compacts an open chat once it has sat idle past the mark, and tells the owner what Hermes did", async () => {
    const { server, reports, check, asked } = await setUp();
    await check(14 * MIN);
    expect(asked()).toEqual([]);
    await check(15 * MIN);
    expect(asked()).toEqual([server.runtimeIdOf("nas")]);
    expect(reports).toEqual([{ chatId: "nas", title: "NAS", percent: 82, idleMinutes: 15, result: { kind: "compacted", beforeMessages: 40, afterMessages: 9, beforeTokens: 140_000, afterTokens: 21_000, headline: "Compressed: 40 → 9 messages" } }]);
    expect(idleCompactionNote(reports[0])).toBe("Compacted “NAS”, idle 15 min at 82% full: about 140,000 → 21,000 tokens, as Hermes estimates.");
  });

  it("compacts a chat once, though the meter still shows the measure from before, until a reply measures it again", async () => {
    const { server, hermes, compactor, chats, check, asked } = await setUp();
    await check(15 * MIN);
    await check(40 * MIN);
    await check(120 * MIN);
    expect(asked()).toHaveLength(1);

    // A reply: Hermes measures the chat again as it ends, and a new idle stretch starts.
    const rt = server.runtimeIdOf("nas")!;
    await hermes.send("nas", "more");
    compactor.observe(chats(), 121 * MIN);
    server.event(rt, "message.complete", { text: "ok", ...usage(76) });
    await hermes.idle();
    compactor.observe(chats(), 122 * MIN);
    await check(136 * MIN);
    expect(asked()).toHaveLength(1);
    await check(137 * MIN);
    expect(asked()).toHaveLength(2);
  });

  it("doesn't compact the same measure again when the list's sync moves the chat's last activity", async () => {
    const { compactor, chats, check, asked } = await setUp();
    await check(15 * MIN);
    expect(asked()).toHaveLength(1);
    // Hermes stored the compaction, and the next sync brought the chat's newer last activity: a new idle stretch,
    // with the meter still at the measure from before.
    const synced = () => chats().map((c) => ({ ...c, updatedAt: c.updatedAt + 60_000 }));
    compactor.observe(synced(), 16 * MIN);
    await compactor.check(synced(), "connected", 60 * MIN);
    expect(asked()).toHaveLength(1);
  });

  it("leaves alone a chat under the mark, one with a reply running, and everything while it's off", async () => {
    const low = await setUp({ nas: 69 });
    await low.check(60 * MIN);
    expect(low.asked()).toEqual([]);

    const running = await setUp();
    await running.hermes.send("nas", "go on");
    running.compactor.observe(running.chats(), 0);
    await running.check(60 * MIN);
    expect(running.asked()).toEqual([]);

    const off = await setUp();
    off.setPrefs({ ...ON, enabled: false });
    await off.check(60 * MIN);
    expect(off.asked()).toEqual([]);
  });

  it("leaves alone a chat Hermes hasn't measured, or reports no compactor for", async () => {
    const chat = (live: Chat["live"]): Chat => ({ id: "c", runtimeId: "r", title: "C", source: "app", settled: false, updatedAt: 0, items: [], live });
    expect(isDue(chat({ context: { used: 1, max: 2, percent: 90, estimated: false }, compactions: 0 }), ON, 0, 15 * MIN)).toBe(true);
    expect(isDue(chat({ compactions: 0 }), ON, 0, 15 * MIN)).toBe(false);
    expect(isDue(chat({ context: { used: 1, max: 2, percent: 90, estimated: false } }), ON, 0, 15 * MIN)).toBe(false);
    expect(isDue({ ...chat({ context: { used: 1, max: 2, percent: 90, estimated: false }, compactions: 0 }), runtimeId: undefined }, ON, 0, 15 * MIN)).toBe(false);
  });

  it("compacts one chat at a time, the one idle longest first", async () => {
    const { server, check, asked, touch } = await setUp({ nas: 80, web: 90 });
    // `web` went idle later.
    await touch("web", 5 * MIN, 90);
    let answer!: () => void;
    server.handlers["session.compress"] = (r) => void (answer = () => server.respond(r.id, COMPRESSED));
    const first = check(30 * MIN);
    await check(30 * MIN);
    expect(asked()).toEqual([server.runtimeIdOf("nas")]);
    answer();
    await first;
    server.handlers["session.compress"] = (r) => server.respond(r.id, COMPRESSED);
    await check(31 * MIN);
    expect(asked()).toEqual([server.runtimeIdOf("nas"), server.runtimeIdOf("web")]);
  });

  it("stops asking once Hermes says it can't compact, having told the owner once", async () => {
    const { server, reports, check, asked, touch } = await setUp({ nas: 80, web: 90 });
    await touch("web", 1 * MIN, 90);
    server.compressResult = undefined;
    await check(15 * MIN);
    await check(16 * MIN);
    expect(asked()).toHaveLength(1);
    expect(reports.map(idleCompactionNote)).toEqual(["Couldn't compact “NAS” while it was idle: This Hermes can't compact a chat from here."]);
  });

  it("says nothing when Hermes had nothing to compact", () => {
    const base = { chatId: "c", title: "C", percent: 80, idleMinutes: 15 };
    expect(idleCompactionNote({ ...base, result: { kind: "nothing" } })).toBeUndefined();
    expect(idleCompactionNote({ ...base, result: { kind: "busy", message: "x" } })).toBeUndefined();
    expect(idleCompactionNote({ ...base, result: { kind: "compacted", beforeMessages: 40, afterMessages: 9 } })).toBe("Compacted “C”, idle 15 min at 80% full: 40 → 9 messages.");
  });
});

describe("A compaction Hermes hasn't answered", () => {
  async function holding(): Promise<{ server: FakeHermes; hermes: Hermes; answer: () => void }> {
    const { server, hermes } = await setUp();
    let answer!: () => void;
    server.handlers["session.compress"] = (r) => void (answer = () => server.respond(r.id, COMPRESSED));
    return { server, hermes, answer: () => answer() };
  }

  it("holds a message sent meanwhile until Hermes has answered", async () => {
    const { server, hermes, answer } = await holding();
    const compacting = hermes.compact("nas");
    const sent = hermes.send("nas", "next question");
    await vi.waitFor(() => expect(server.requests.some((r) => r.method === "session.compress")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(false);
    answer();
    await compacting;
    expect((await sent).delivery).toBe("accepted");
    expect(server.requests.map((r) => r.method).filter((m) => m === "session.compress" || m === "prompt.submit")).toEqual(["session.compress", "prompt.submit"]);
  });

  it("is the only one: a second asked meanwhile is busy, and none is asked while a message is going", async () => {
    const { hermes, answer } = await holding();
    const first = hermes.compact("nas");
    expect(await hermes.compact("nas")).toEqual({ kind: "busy", message: "Hermes is already compacting this chat." });
    answer();
    expect((await first).kind).toBe("compacted");

    void hermes.send("nas", "go");
    await expect(hermes.compact("nas")).rejects.toThrow("Wait for the reply to finish");
  });
});
