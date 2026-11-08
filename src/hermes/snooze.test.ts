import { describe, expect, it } from "vitest";
import type { Chat, Item } from "./model";
import { handoffs, type DispatchedTask } from "./dispatched";
import { AttentionClock, CLEARED_KEY, ClearedStore, PINS_KEY, PinStore, SNOOZE_KEY, STOP_WAITING_KEY, SnoozeStore, StopWaitingStore, WOKEN_KEPT_MS, chatSections, customUntil, heldClears, isWorking, lastActive, nextWake, snoozePresets, wakeLabel } from "./snooze";

/** A Storage stand-in, its document under `key` readable as `raw`. */
function memory(start?: string, key = SNOOZE_KEY) {
  const m = new Map<string, string>(start === undefined ? [] : [[key, start]]);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    get raw() {
      return JSON.parse(m.get(key) ?? "null");
    },
    get keys() {
      return [...m.keys()];
    },
  };
}

const HOUR = 3_600_000;
// Wednesday 2026-11-04, 10:30 local time.
const WED = new Date(2026, 10, 4, 10, 30).getTime();

const chat = (id: string, updatedAt: number, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt, items: [], ...extra });
const waiting: Item = { kind: "approval", id: "ap", requestId: "r", command: "rm", description: "", choices: [], allowSession: true, allowPermanent: true };

describe("SnoozeStore", () => {
  it("keeps each connection and profile's snoozes apart, and leaves the others alone", () => {
    const storage = memory();
    const a = new SnoozeStore(storage, "A", () => WED);
    const b = new SnoozeStore(storage, "B", () => WED);
    a.snooze("x", WED + HOUR);
    b.snooze("y", WED + 2 * HOUR);
    expect(storage.raw).toEqual({ v: 1, scopes: { A: { x: WED + HOUR }, B: { y: WED + 2 * HOUR } } });
    expect(new SnoozeStore(storage, "A", () => WED).getSnapshot()).toEqual({ x: WED + HOUR });
    expect(a.isSnoozed("x")).toBe(true);
    expect(a.isSnoozed("y")).toBe(false);
    a.wake("x");
    expect(storage.raw).toEqual({ v: 1, scopes: { B: { y: WED + 2 * HOUR } } });
  });

  it("tells subscribers about its own changes and, on reread, another window's", () => {
    const storage = memory();
    const here = new SnoozeStore(storage, "A", () => WED);
    const there = new SnoozeStore(storage, "A", () => WED);
    let heard = 0;
    here.subscribe(() => heard++);
    here.snooze("x", WED + HOUR);
    expect(heard).toBe(1);
    there.snooze("y", WED + HOUR);
    here.reread();
    expect(heard).toBe(2);
    expect(here.getSnapshot()).toEqual({ x: WED + HOUR, y: WED + HOUR });
    here.reread();
    expect(heard).toBe(2);
  });

  it("forgets snoozes that woke more than a week ago, and keeps fields it doesn't know", () => {
    const old = WED - WOKEN_KEPT_MS - 1;
    const storage = memory(JSON.stringify({ v: 1, later: true, scopes: { A: { old, recent: WED - HOUR, bad: "soon" }, Z: { q: 5 } } }));
    const store = new SnoozeStore(storage, "A", () => WED);
    expect(store.getSnapshot()).toEqual({ old, recent: WED - HOUR });
    store.snooze("x", WED + HOUR);
    expect(storage.raw).toEqual({ v: 1, later: true, scopes: { A: { recent: WED - HOUR, x: WED + HOUR }, Z: { q: 5 } } });
  });

  it("starts empty from an unreadable document", () => {
    expect(new SnoozeStore(memory("{nope"), "A", () => WED).getSnapshot()).toEqual({});
  });

  it("holds a change in memory when storage is full", () => {
    const store = new SnoozeStore(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      },
      "A",
      () => WED,
    );
    store.snooze("x", WED + HOUR);
    expect(store.getSnapshot()).toEqual({ x: WED + HOUR });
  });
});

describe("snoozePresets", () => {
  it("offers 1 hour, 3 hours, tomorrow at 9 and next Monday at 9", () => {
    expect(snoozePresets(WED).map((p) => [p.label, p.until])).toEqual([
      ["1 hour", WED + HOUR],
      ["3 hours", WED + 3 * HOUR],
      ["Tomorrow", new Date(2026, 10, 5, 9).getTime()],
      ["Next week", new Date(2026, 10, 9, 9).getTime()],
    ]);
  });

  it("puts next week a week on when today is Monday, and on the coming Monday from a Sunday", () => {
    const mon = new Date(2026, 10, 9, 8).getTime();
    expect(snoozePresets(mon)[3].until).toBe(new Date(2026, 10, 16, 9).getTime());
    const sun = new Date(2026, 10, 8, 20).getTime();
    expect(snoozePresets(sun)[3].until).toBe(new Date(2026, 10, 9, 9).getTime());
  });
});

describe("customUntil", () => {
  it("reads a date and time as local time", () => {
    expect(customUntil({ at: "2026-11-06T14:15" }, WED)).toBe(new Date(2026, 10, 6, 14, 15).getTime());
  });

  it("adds a duration", () => {
    expect(customUntil({ amount: "90", unit: "minutes" }, WED)).toBe(WED + 1.5 * HOUR);
    expect(customUntil({ amount: "1.5", unit: "days" }, WED)).toBe(WED + 36 * HOUR);
    expect(customUntil({ amount: "2", unit: "weeks" }, WED)).toBe(WED + 14 * 24 * HOUR);
  });

  it("says what's wrong with a time that can't be one", () => {
    expect(customUntil({ at: "" }, WED)).toBe("Pick a date and time.");
    expect(customUntil({ at: "2026-02-30T09:00" }, WED)).toBe("That date doesn't exist.");
    expect(customUntil({ at: "2026-11-04T10:00" }, WED)).toBe("Pick a time in the future.");
    expect(customUntil({ amount: "0", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "-3", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "2", unit: "weeks" }, WED)).toBeTypeOf("number");
    expect(customUntil({ amount: "400", unit: "days" }, WED)).toBe("Snooze for a year at most.");
  });
});

describe("chatSections", () => {
  const snoozes = { snoozed: WED + HOUR, woke: WED - 60_000, later: WED + 5 * HOUR };
  const chats = [
    chat("done", WED - 10 * 60_000),
    chat("working", WED - 5 * 60_000, { running: true }),
    chat("asking", WED - 20 * 60_000, { running: true, items: [waiting] }),
    chat("snoozed", WED - 1),
    chat("later", WED - 2, { running: true }),
    chat("woke", WED - 3 * HOUR),
    chat("settled", WED, { settled: true, running: true }),
    chat("settledSnoozed", WED, { settled: true }),
    chat("archived", WED, { archived: true }),
  ];

  it("puts each chat in one place: Archived, Settled, Snoozed, Working, else the Inbox", () => {
    const s = chatSections(chats, { ...snoozes, settledSnoozed: WED + HOUR }, WED);
    expect(s.inbox.map((c) => c.id)).toEqual(["woke", "done", "asking"]);
    expect(s.working.map((c) => c.id)).toEqual(["working"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["snoozed", "later"]);
    expect(s.settled.map((c) => c.id)).toEqual(["settled", "settledSnoozed"]);
    expect(s.archived.map((c) => c.id)).toEqual(["archived"]);
    expect(Object.keys(s)).toEqual(["pinned", "inbox", "snoozed", "archived", "working", "settled"]);
  });

  it("puts a pinned chat in Pinned, in the order pinned, whatever happens in it, unless it is Archived", () => {
    const pins = { settled: WED - 3 * HOUR, done: WED - 2 * HOUR, working: WED - HOUR, archived: WED - 4 * HOUR };
    const s = chatSections(chats, snoozes, WED, {}, pins);
    expect(s.pinned.map((c) => c.id)).toEqual(["settled", "done", "working"]);
    expect(s.archived.map((c) => c.id)).toEqual(["archived"]);
    expect(s.inbox.map((c) => c.id)).toEqual(["woke", "asking"]);
    expect(s.working).toEqual([]);
    // A new message in a pinned chat leaves the order; one in an unpinned chat leaves it out of Pinned.
    const newer = chatSections(chats.map((c) => (c.id === "working" || c.id === "woke" ? { ...c, updatedAt: WED + HOUR } : c)), snoozes, WED, {}, pins);
    expect(newer.pinned.map((c) => c.id)).toEqual(["settled", "done", "working"]);
    expect(newer.inbox.map((c) => c.id)).toEqual(["woke", "asking"]);
  });

  it("brings a chat back to the top once its snooze wakes, as new as when it woke", () => {
    const s = chatSections(chats, snoozes, WED + 2 * HOUR);
    expect(s.inbox.map((c) => c.id)).toEqual(["snoozed", "woke", "done", "asking"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["later"]);
  });

  it("puts a chat that stopped working first, by when it stopped, though Hermes's activity time is older", () => {
    const clock = new AttentionClock();
    const before = [chat("asks", WED - HOUR, { running: true }), chat("done", WED - 60_000)];
    clock.observe(before, WED - 30_000);
    expect(chatSections(before, {}, WED, clock.since).inbox.map((c) => c.id)).toEqual(["done"]);
    const after = [chat("asks", WED - HOUR, { running: true, items: [waiting] }), chat("done", WED - 60_000)];
    clock.observe(after, WED);
    expect(clock.since).toEqual({ asks: WED });
    expect(chatSections(after, {}, WED, clock.since).inbox.map((c) => c.id)).toEqual(["asks", "done"]);
    // Noting the same chats again changes nothing.
    clock.observe(after, WED + HOUR);
    expect(clock.since).toEqual({ asks: WED });
  });

  it("keeps a chat in Working while it waits on work it handed off, and counts it as stopped once that ends", () => {
    const task: DispatchedTask = { id: "t_1", board: "default", status: "ready", createdAt: WED - 60_000, picked: false };
    const dispatched = [chat("sent", WED - HOUR, { tasks: [task] }), chat("asked", WED - HOUR, { tasks: [task], items: [waiting] }), chat("done", WED - 60_000)];
    const h = handoffs(dispatched, {}, WED);
    expect(isWorking(dispatched[0], h.get("sent"))).toBe(true);
    expect(isWorking(dispatched[0])).toBe(false);
    expect(chatSections(dispatched, {}, WED, {}, {}, h).working.map((c) => c.id)).toEqual(["sent"]);
    expect(chatSections(dispatched, {}, WED, {}, {}, h).inbox.map((c) => c.id)).toEqual(["done", "asked"]);
    const clock = new AttentionClock();
    clock.observe(dispatched, WED - 30_000, true, h);
    expect(clock.since).toEqual({});
    const over = dispatched.map((c) => (c.id === "sent" ? { ...c, tasks: [{ ...task, status: "done" as const, overAt: WED - 60_000 }] } : c));
    clock.observe(over, WED, true, handoffs(over, {}, WED));
    expect(clock.since).toEqual({ sent: WED });
    expect(chatSections(over, {}, WED, clock.since, {}, handoffs(over, {}, WED)).inbox.map((c) => c.id)).toEqual(["sent", "done", "asked"]);
  });

  it("puts a chat whose task needs the owner in the Inbox", () => {
    const blocked: DispatchedTask = { id: "t_1", board: "default", status: "blocked", createdAt: WED - 60_000, picked: false };
    const list = [chat("stuck", WED - HOUR, { tasks: [blocked] })];
    expect(chatSections(list, {}, WED, {}, {}, handoffs(list, {}, WED)).inbox.map((c) => c.id)).toEqual(["stuck"]);
  });

  it("doesn't count a reply cut off by a dropped connection as stopped", () => {
    const clock = new AttentionClock();
    clock.observe([chat("a", WED - HOUR, { running: true })], WED - 60_000);
    clock.observe([chat("a", WED - HOUR)], WED, false);
    expect(clock.since).toEqual({});
  });

  it("stops counting a snooze that woke more than a week ago", () => {
    const old = WED - WOKEN_KEPT_MS - 1;
    const s = chatSections([chat("a", WED - 10 * 24 * HOUR), chat("b", WED - 9 * 24 * HOUR)], { a: old }, WED);
    expect(s.inbox.map((c) => c.id)).toEqual(["b", "a"]);
  });

  describe("clears from before clearing settled a chat (ADR 0090)", () => {
    const quiet = chat("quiet", WED - HOUR);

    it("finds the chats the old Unsettled section showed, so they can be settled once", () => {
      const cleared = { quiet: WED - HOUR, older: WED - 3 * HOUR };
      expect(heldClears([chat("older", WED - 3 * HOUR), quiet, chat("other", WED - 2 * HOUR)], {}, WED, {}, cleared)).toEqual(["older", "quiet"]);
    });

    it("leaves out a clear something newer ended: a message, a woken snooze, a reply that stopped", () => {
      const cleared = { quiet: WED - HOUR };
      expect(heldClears([chat("quiet", WED - HOUR + 1)], {}, WED, {}, cleared)).toEqual([]);
      expect(heldClears([quiet], { quiet: WED - 60_000 }, WED, {}, cleared)).toEqual([]);
      expect(heldClears([quiet], {}, WED, { quiet: WED - 60_000 }, cleared)).toEqual([]);
    });

    it("leaves out a chat that is unread, waiting, working, snoozed, pinned, Settled or Archived", () => {
      const cleared = Object.fromEntries(["u", "w", "r", "z", "p", "s", "a"].map((id) => [id, WED]));
      const chats = [
        chat("u", WED - HOUR, { unread: true }),
        chat("w", WED - HOUR, { items: [waiting] }),
        chat("r", WED - HOUR, { running: true }),
        chat("z", WED - HOUR),
        chat("p", WED - HOUR),
        chat("s", WED - HOUR, { settled: true }),
        chat("a", WED - HOUR, { archived: true }),
      ];
      expect(heldClears(chats, { z: WED + HOUR }, WED, {}, cleared, { p: WED })).toEqual([]);
    });

    it("keeps a fractional mark exactly, so the clear still holds", () => {
      const at = WED - HOUR + 0.25;
      const storage = memory(JSON.stringify({ v: 1, scopes: { A: { frac: at } } }), CLEARED_KEY);
      expect(heldClears([chat("frac", at)], {}, WED, {}, new ClearedStore(storage, "A").getSnapshot())).toEqual(["frac"]);
    });

    it("counts a woken snooze and a stopped reply as activity, and a snooze still asleep as none", () => {
      expect(lastActive(quiet, { quiet: WED - 60_000 }, WED)).toBe(WED - 60_000);
      expect(lastActive(quiet, { quiet: WED + HOUR }, WED)).toBe(WED - HOUR);
      expect(lastActive(quiet, {}, WED, { quiet: WED - 1 })).toBe(WED - 1);
    });
  });

  it("finds the next wake", () => {
    expect(nextWake(snoozes, WED)).toBe(WED + HOUR);
    expect(nextWake(snoozes, WED + 2 * HOUR)).toBe(WED + 5 * HOUR);
    expect(nextWake(snoozes, WED + 6 * HOUR)).toBeUndefined();
  });
});

describe("PinStore", () => {
  it("keeps each connection and profile's pins apart, under its own key, and survives a restart", () => {
    const storage = memory(undefined, PINS_KEY);
    let now = WED;
    const a = new PinStore(storage, "A", () => now);
    const b = new PinStore(storage, "B", () => now);
    a.pin("x");
    now += 1;
    b.pin("y");
    expect(storage.keys).toEqual([PINS_KEY]);
    expect(storage.raw).toEqual({ v: 1, scopes: { A: { x: WED }, B: { y: WED + 1 } } });
    expect(new PinStore(storage, "A").getSnapshot()).toEqual({ x: WED });
    a.unpin("x");
    expect(storage.raw).toEqual({ v: 1, scopes: { B: { y: WED + 1 } } });
  });

  it("pins after every earlier pin when the clock stands still or goes back", () => {
    let now = WED;
    const pins = new PinStore(memory(undefined, PINS_KEY), "A", () => now);
    pins.pin("a");
    pins.pin("b");
    now = WED - HOUR;
    pins.pin("c");
    const order = (chats: Chat[]) => chatSections(chats, {}, WED, {}, pins.getSnapshot()).pinned.map((c) => c.id);
    const list = [chat("c", WED), chat("a", WED - 2 * HOUR), chat("b", WED - HOUR)];
    expect(order(list)).toEqual(["a", "b", "c"]);
    expect(order([...list].reverse())).toEqual(["a", "b", "c"]);
  });

  it("pins after a pin another window made, though this window hasn't heard of it yet", () => {
    const storage = memory(undefined, PINS_KEY);
    const first = new PinStore(storage, "A", () => WED);
    const second = new PinStore(storage, "A", () => WED);
    first.pin("z");
    second.pin("a");
    const pins = new PinStore(storage, "A").getSnapshot();
    expect(chatSections([chat("a", WED), chat("z", WED)], {}, WED, {}, pins).pinned.map((c) => c.id)).toEqual(["z", "a"]);
    first.unpin("a");
    expect(new PinStore(storage, "A").getSnapshot()).toEqual({ z: WED });
  });

  it("orders pins stored with the same time the same way whatever order the list comes in", () => {
    const same = { x: WED, y: WED };
    const order = (chats: Chat[]) => chatSections(chats, {}, WED, {}, same).pinned.map((c) => c.id);
    expect(order([chat("y", WED), chat("x", WED)])).toEqual(order([chat("x", WED), chat("y", WED)]));
  });

  it("keeps a chat pinned again in its place, and puts back the place a pin had", () => {
    const storage = memory(undefined, PINS_KEY);
    let now = WED;
    const pins = new PinStore(storage, "A", () => now);
    pins.pin("x");
    now += HOUR;
    pins.pin("x");
    expect(pins.getSnapshot()).toEqual({ x: WED });
    pins.unpin("x");
    pins.pin("x", WED);
    expect(pins.getSnapshot()).toEqual({ x: WED });
  });
});

describe("StopWaitingStore", () => {
  it("keeps each connection and profile's stops apart, under its own key, adds to a chat's, and survives a restart", () => {
    const storage = memory(undefined, STOP_WAITING_KEY);
    const a = new StopWaitingStore(storage, "A");
    const b = new StopWaitingStore(storage, "B");
    a.stop("x", ["t_1", "sa-1"]);
    b.stop("x", ["t_9"]);
    a.stop("x", ["sa-1", "t_2"]);
    expect(storage.raw).toEqual({ v: 1, scopes: { A: { x: ["t_1", "sa-1", "t_2"] }, B: { x: ["t_9"] } } });
    expect(storage.keys).toEqual([STOP_WAITING_KEY]);
    expect(new StopWaitingStore(storage, "A").getSnapshot()).toEqual({ x: ["t_1", "sa-1", "t_2"] });
  });

  it("tells subscribers, leaves out what isn't a list of ids, and holds a change in memory when storage is full", () => {
    const storage = memory(JSON.stringify({ v: 1, scopes: { A: { x: ["t_1", 5, ""], y: "t_2", z: [] } } }), STOP_WAITING_KEY);
    const store = new StopWaitingStore(storage, "A");
    expect(store.getSnapshot()).toEqual({ x: ["t_1"] });
    let heard = 0;
    store.subscribe(() => heard++);
    store.stop("x", ["t_3"]);
    expect(heard).toBe(1);
    store.stop("x", ["t_1"]);
    expect(heard).toBe(1);
    expect(store.getSnapshot()).toEqual({ x: ["t_1", "t_3"] });
    const full = new StopWaitingStore(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      },
      "A",
    );
    full.stop("x", ["t_1"]);
    expect(full.getSnapshot()).toEqual({ x: ["t_1"] });
  });
});

describe("ClearedStore", () => {
  it("reads one connection and profile's clears, ignoring what isn't one", () => {
    const storage = memory(JSON.stringify({ v: 1, scopes: { A: { good: 5, bad: "x", neg: -1 }, B: { y: 7 } } }), CLEARED_KEY);
    expect(new ClearedStore(storage, "A").getSnapshot()).toEqual({ good: 5 });
    expect(new ClearedStore(storage, "B").getSnapshot()).toEqual({ y: 7 });
  });

  it("drops every clear of its connection and profile, and only those, for good", () => {
    const storage = memory(JSON.stringify({ v: 1, scopes: { A: { x: WED }, B: { y: WED } } }), CLEARED_KEY);
    const a = new ClearedStore(storage, "A");
    let heard = 0;
    a.subscribe(() => heard++);
    a.dropAll();
    expect(a.getSnapshot()).toEqual({});
    expect(heard).toBe(1);
    expect(storage.raw).toEqual({ v: 1, scopes: { B: { y: WED } } });
    expect(new ClearedStore(storage, "A").getSnapshot()).toEqual({});
    // Nothing left to drop changes nothing.
    a.dropAll();
    expect(heard).toBe(1);
  });
});

describe("wakeLabel", () => {
  it("gives the time today, the weekday this week, and the date further off", () => {
    expect(wakeLabel(WED + HOUR, WED)).toBe(new Date(WED + HOUR).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(wakeLabel(WED + 24 * HOUR, WED)).toMatch(/^\S+ /);
    expect(wakeLabel(WED + 30 * 24 * HOUR, WED)).toBe(new Date(WED + 30 * 24 * HOUR).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});
