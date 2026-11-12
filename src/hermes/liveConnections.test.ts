// @vitest-environment jsdom
// The registry of live connections (ADR 0125): one instance per connection, a target pointer, background reads on
// timers bounded across connections, and inbox entries that name their server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedConnection } from "./connections";
import type { DispatchedTask, Handoff } from "./dispatched";
import type { InboxAcks, InboxEntry } from "./inbox";
import { BACKGROUND_LIVE_MS, BACKGROUND_READS_AT_ONCE, BACKGROUND_UNREAD_MS, LiveConnections, withServer, withoutServer, type Member } from "./liveConnections";
import type { Snapshot } from "./transport";
import type { SignInDetails } from "./tauriPipe";

const details = {} as SignInDetails;
const saved = (id: string): SavedConnection => ({ id: `server-${id}`, name: `Server ${id}`, mode: "url", sshTarget: "", url: `https://${id}.example.com`, username: "owner", addedAt: 0 });

/** A stand-in `Hermes`: its role, its listeners, and how many of each background read it was asked for and is running. */
function fakeHermes(snapshot: Partial<Snapshot> = {}) {
  let role: "target" | "background" = "target";
  const listeners = new Set<() => void>();
  const reads = { live: 0, unread: 0, running: 0, most: 0, finish: [] as (() => void)[] };
  const read = (kind: "live" | "unread") => () => {
    reads[kind]++;
    reads.running++;
    reads.most = Math.max(reads.most, reads.running);
    return new Promise<void>((done) => reads.finish.push(() => (reads.running--, done())));
  };
  const snap: Snapshot = { profile: "default", chats: [], status: "connected", others: { byName: {} }, queues: {}, olderPulled: false, archivedListed: false, unsecure: false, branches: {}, botPictures: {}, ...snapshot } as unknown as Snapshot;
  const hermes = {
    get roleNow() {
      return role;
    },
    setRole: (r: typeof role) => void (role = r),
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    getSnapshot: () => snap,
    lastFrameAt: 0,
    checkLive: read("live"),
    checkOtherProfiles: read("unread"),
  };
  return { hermes, reads, listeners, member: (c: SavedConnection): Member => ({ connection: c, hermes: hermes as unknown as Member["hermes"], details }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("The live connections", () => {
  it("make one the target and every other a background connection, and keep the live set with the target first", () => {
    const kept: string[][] = [];
    const live = new LiveConnections((ids) => kept.push(ids));
    const a = fakeHermes();
    const b = fakeHermes();
    live.add(a.member(saved("a")), true);
    live.add(b.member(saved("b")), false);
    expect([a.hermes.roleNow, b.hermes.roleNow]).toEqual(["target", "background"]);
    live.setTarget("server-b");
    expect([a.hermes.roleNow, b.hermes.roleNow]).toEqual(["background", "target"]);
    expect(kept.at(-1)).toEqual(["server-b", "server-a"]);
    expect(live.remove("server-b")?.hermes).toBe(b.hermes);
    expect(live.target()).toBeUndefined();
    expect(kept.at(-1)).toEqual(["server-a"]);
    live.needsSignIn(saved("c"), "No password is saved for it.");
    expect(kept.at(-1)).toEqual(["server-a", "server-c"]);
    expect(live.overview().map((s) => [s.id, s.status])).toEqual([
      ["server-a", "connected"],
      ["server-c", "needs-sign-in"],
    ]);
    live.stop();
  });

  it("read each background connection on its own timers, at most four reads at once across them, and stop for the target", async () => {
    const live = new LiveConnections();
    const target = fakeHermes();
    live.add(target.member(saved("t")), true);
    const others = Array.from({ length: 6 }, () => fakeHermes());
    others.forEach((o, i) => live.add(o.member(saved(`b${i}`)), false));

    await vi.advanceTimersByTimeAsync(BACKGROUND_UNREAD_MS);
    const started = others.reduce((n, o) => n + o.reads.live + o.reads.unread, 0);
    const running = others.reduce((n, o) => n + o.reads.running, 0);
    expect(running).toBe(BACKGROUND_READS_AT_ONCE);
    expect(started).toBe(BACKGROUND_READS_AT_ONCE);
    expect(target.reads.live + target.reads.unread).toBe(0);

    // As reads finish, the waiting ones run, still four at a time.
    for (let i = 0; i < 40; i++) {
      for (const o of others) o.reads.finish.splice(0).forEach((f) => f());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(Math.max(...others.map((o) => o.reads.most))).toBeLessThanOrEqual(BACKGROUND_READS_AT_ONCE);
    expect(others.every((o) => o.reads.live >= 1 && o.reads.unread >= 1)).toBe(true);

    // Made the target, a connection's own timers stop; Main reads it from then on.
    live.setTarget("server-b0");
    const before = others[0].reads.live;
    await vi.advanceTimersByTimeAsync(BACKGROUND_LIVE_MS * 3);
    for (const o of others) o.reads.finish.splice(0).forEach((f) => f());
    expect(others[0].reads.live).toBe(before);
    live.stop();
  });

  it("count a background connection's work and give its entries keys that its server's id keeps apart", () => {
    const chat = (id: string, over = {}) => ({ id, title: "Deploy", source: "app", settled: false, updatedAt: 1, items: [], ...over });
    const approval = { kind: "approval", id: "q1", requestId: "apr-1", command: "rm", description: "", choices: ["once"], state: "waiting" };
    const a = fakeHermes({ chats: [chat("c1", { items: [approval] }), chat("c2", { running: true })] as never, live: { sessions: [{ chatId: "c9", status: "working", at: 1_700_000_123_000 }] } });
    const b = fakeHermes({ chats: [chat("c1", { items: [approval] })] as never });
    const live = new LiveConnections();
    live.add(a.member(saved("a")), false);
    live.add(b.member(saved("b")), false);
    const [sa, sb] = live.overview();
    expect([sa.waiting, sa.running, sb.waiting]).toEqual([1, 1, 1]);
    expect(sa.lastActivity).toBe(1_700_000_120_000);
    const keys = [...sa.entries, ...sb.entries].map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sa.entries.every((e) => e.server?.name === "Server a")).toBe(true);
    live.stop();
  });
});

describe("The live connections, kept tidy", () => {
  it("leave one listener on a member made the target again, and none once it is removed", () => {
    const live = new LiveConnections();
    const a = fakeHermes();
    const member = a.member(saved("a"));
    live.add(member, true);
    live.add(member, true);
    live.add(member, true);
    expect(a.listeners.size).toBe(1);
    live.remove("server-a");
    expect(a.listeners.size).toBe(0);
    live.stop();
  });

  it("skip a read that waited its turn once its connection is the target", async () => {
    const live = new LiveConnections();
    live.add(fakeHermes().member(saved("t")), true);
    const others = Array.from({ length: 3 }, () => fakeHermes());
    others.forEach((o, i) => live.add(o.member(saved(`b${i}`)), false));
    await vi.advanceTimersByTimeAsync(BACKGROUND_UNREAD_MS);
    // Six reads asked for, four running; the last connection's wait.
    const waiting = others.filter((o) => o.reads.live + o.reads.unread < 2);
    expect(waiting.length).toBeGreaterThan(0);
    const promoted = waiting.at(-1)!;
    const asked = promoted.reads.live + promoted.reads.unread;
    live.setTarget(`server-b${others.indexOf(promoted)}`);
    for (let i = 0; i < 10; i++) {
      for (const o of others) o.reads.finish.splice(0).forEach((f) => f());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(promoted.reads.live + promoted.reads.unread).toBe(asked);
    live.stop();
  });

  it("count a waiting Approval as work a restore and Disconnect wait for even once its entry is dismissed", () => {
    const approval = { kind: "approval", id: "q1", requestId: "apr-1", command: "rm", description: "", choices: ["once"], state: "waiting" };
    const a = fakeHermes({ chats: [{ id: "c1", title: "Deploy", source: "app", settled: false, updatedAt: 1, items: [approval] }] as never });
    const dismissedAll = { isDismissed: () => true, subscribe: () => () => {}, reload: () => {} } as unknown as InboxAcks;
    const live = new LiveConnections(undefined, () => dismissedAll);
    live.add(a.member(saved("a")), false);
    const [s] = live.overview();
    expect([s.waiting, s.entries.length, s.busy]).toEqual([0, 0, true]);
    // Disconnect still asks about it.
    expect(s.underWay).toEqual({ waiting: 1, running: 0 });
    live.stop();
  });
});

describe("A background connection's dispatched work", () => {
  it("counts in its summary as it does on the target: a task that needs the owner, and work it waits on", () => {
    const chat = (id: string) => ({ id, title: "Deploy", source: "app", settled: false, updatedAt: 1, items: [] });
    const a = fakeHermes({ chats: [chat("c1"), chat("c2")] as never });
    const task = { id: "t1", status: "review" } as unknown as DispatchedTask;
    const handoffs = new Map<string, Handoff>([
      ["c1", { kind: "needsOwner", task, reason: "A task it handed off needs your review." }],
      ["c2", { kind: "waiting", tasks: [], subagents: 1, stalled: false }],
    ]);
    const asked: string[] = [];
    const live = new LiveConnections(undefined, undefined, (c, profile) => (asked.push(`${c.id} ${profile}`), { handoffs }));
    live.add(a.member(saved("a")), false);
    const [s] = live.overview();
    expect(asked.at(-1)).toBe("server-a default");
    expect([s.waiting, s.running]).toEqual([1, 1]);
    expect(s.entries.find((e) => e.taskId === "t1")?.server?.id).toBe("server-a");
    live.stop();
  });
});

describe("A background connection's dispatched work over time", () => {
  it("is worked out again when its handoffs next change with time alone, with no frame from the server", async () => {
    const chat = { id: "c1", title: "Deploy", source: "app", settled: false, updatedAt: 1, items: [] };
    const a = fakeHermes({ chats: [chat] as never });
    let waitingUntil = Date.now() + 30_000;
    const live = new LiveConnections(undefined, undefined, () => {
      const now = Date.now();
      const handoffs = new Map<string, Handoff>(now < waitingUntil ? [["c1", { kind: "waiting", tasks: [], subagents: 1, stalled: false }]] : []);
      return { handoffs, ...(now < waitingUntil && { next: waitingUntil }) };
    });
    live.add(a.member(saved("a")), false);
    expect(live.overview()[0].running).toBe(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(live.overview()[0].running).toBe(0);
    waitingUntil = 0;
    live.stop();
  });
});

describe("An entry from another connection", () => {
  it("is keyed in its own connection's dismissals as it was before it carried its server", () => {
    const e: InboxEntry = { key: "approval default c1 apr-1", alias: "waiting default c1", kind: "approval", profile: "default", chatId: "c1", title: "Deploy", at: 0, summary: "" };
    const on = withServer(e, { id: "server-a", name: "A" });
    expect(on.key).not.toBe(withServer(e, { id: "server-b", name: "B" }).key);
    expect(withoutServer(on)).toEqual(e);
  });
});
