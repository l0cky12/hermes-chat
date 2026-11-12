import { describe, expect, it } from "vitest";
import { serial } from "./serial";

/** A connect that answers when told to, and logs when it starts, finishes and is closed. */
function fakeRust() {
  const log: string[] = [];
  const pending = new Map<string, () => void>();
  let open = 0;
  let maxOpen = 0;
  const connect = (to: string) =>
    new Promise<{ to: string; close: () => void }>((done) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      log.push(`connect ${to}`);
      pending.set(to, () => {
        open--;
        log.push(`connected ${to}`);
        done({ to, close: () => log.push(`close ${to}`) });
      });
    });
  return { log, connect, answer: (to: string) => pending.get(to)!(), maxOpen: () => maxOpen };
}

const tick = () => new Promise((r) => setTimeout(r));

describe("Switching connections quickly", () => {
  it("runs one connect at a time, closes the one overtaken before the next starts, and ends on the last asked for", async () => {
    const rust = fakeRust();
    const run = serial();
    let inUse: string | undefined;
    const switchTo = (to: string) =>
      run(async (stale) => {
        if (stale()) return rust.log.push(`skip ${to}`);
        const h = await rust.connect(to);
        if (stale()) return h.close();
        inUse = h.to;
      });
    const toBravo = switchTo("bravo");
    await tick();
    // Bravo is connecting when the owner asks for charlie, then alpha.
    const toCharlie = switchTo("charlie");
    const backToAlpha = switchTo("alpha");
    await tick();
    rust.answer("bravo");
    await toBravo;
    await toCharlie;
    await tick();
    rust.answer("alpha");
    await backToAlpha;
    expect(rust.log).toEqual(["connect bravo", "connected bravo", "close bravo", "skip charlie", "connect alpha", "connected alpha"]);
    expect(rust.maxOpen()).toBe(1);
    expect(inUse).toBe("alpha");
  });

  it("skips changes overtaken before they started", async () => {
    const rust = fakeRust();
    const run = serial();
    const ran: string[] = [];
    const switchTo = (to: string) => run(async (stale) => void (stale() ? ran.push(`skip ${to}`) : ran.push(to)));
    await Promise.all([switchTo("bravo"), switchTo("charlie"), switchTo("alpha")]);
    expect(ran).toEqual(["skip bravo", "skip charlie", "alpha"]);
    expect(rust.log).toEqual([]);
  });

  it("keeps going after a change that failed", async () => {
    const run = serial();
    await expect(run(async () => Promise.reject(new Error("Wrong username or password.")))).rejects.toThrow("Wrong");
    expect(await run(async (stale) => (stale() ? "stale" : "ran"))).toBe("ran");
  });
});

describe("A change that can be stopped while it waits its turn", () => {
  const stopped = () => new Error("stopped");

  it("rejects at once when stopped while queued, and never starts", async () => {
    const run = serial();
    let letGo!: () => void;
    const busy = run(() => new Promise<void>((r) => (letGo = r)));
    const stop = new AbortController();
    let started = false;
    const queued = run.stoppable(stop.signal, stopped, async () => {
      started = true;
      return "connected";
    });
    await tick();
    stop.abort();
    await expect(queued).rejects.toThrow("stopped");
    letGo();
    await busy;
    await tick();
    expect(started).toBe(false);
  });

  it("leaves a started change to stop itself, and resolves with what it gave", async () => {
    const run = serial();
    const stop = new AbortController();
    let finish!: () => void;
    const going = run.stoppable(stop.signal, stopped, async () => {
      await new Promise<void>((r) => (finish = r));
      return "connected";
    });
    await tick();
    stop.abort();
    finish();
    await expect(going).resolves.toBe("connected");
  });

  it("never starts when stopped before it is asked for, and runs as before without a signal", async () => {
    const run = serial();
    const stop = new AbortController();
    stop.abort();
    let started = false;
    await expect(run.stoppable(stop.signal, stopped, async () => void (started = true))).rejects.toThrow("stopped");
    expect(started).toBe(false);
    await expect(run.stoppable(undefined, stopped, async () => 7)).resolves.toBe(7);
  });
});

describe("A stoppable change and the change before it", () => {
  const stopped = () => new Error("stopped");

  it("doesn't overtake the change before it while it waits, so stopping it leaves that change connected", async () => {
    const rust = fakeRust();
    const run = serial();
    let inUse: string | undefined;
    // A switch to bravo is signing in when Setup's Save and connect queues behind it, and is then stopped.
    const toBravo = run(async (stale) => {
      const h = await rust.connect("bravo");
      if (stale()) return h.close();
      inUse = h.to;
    });
    await tick();
    const stop = new AbortController();
    let started = false;
    const save = run.stoppable(stop.signal, stopped, async () => void (started = true));
    await tick();
    stop.abort();
    await expect(save).rejects.toThrow("stopped");
    rust.answer("bravo");
    await toBravo;
    expect([inUse, started, rust.log]).toEqual(["bravo", false, ["connect bravo", "connected bravo"]]);
  });

  it("starts overtaken when a newer change was asked for after it, and doesn't overtake that one", async () => {
    const run = serial();
    let letGo!: () => void;
    const busy = run(() => new Promise<void>((r) => (letGo = r)));
    const seen: string[] = [];
    const save = run.stoppable(undefined, stopped, async (stale) => void seen.push(`save stale=${stale()}`));
    const later = run(async (stale) => void seen.push(`later stale=${stale()}`));
    await tick();
    letGo();
    await Promise.all([busy, save, later]);
    expect(seen).toEqual(["save stale=true", "later stale=false"]);
  });

  it("overtakes the change before it once it starts", async () => {
    const run = serial();
    const seen: boolean[] = [];
    let letGo!: () => void;
    let checkLater!: () => void;
    const before = run(async (stale) => {
      await new Promise<void>((r) => (letGo = r));
      await new Promise<void>((r) => (checkLater = r));
      seen.push(stale());
    });
    await tick();
    const save = run.stoppable(new AbortController().signal, stopped, async (stale) => stale());
    letGo();
    await tick();
    // Still waiting its turn: the change before it isn't overtaken.
    checkLater();
    await before;
    expect(await save).toBe(false);
    expect(seen).toEqual([false]);
  });
});

describe("Work queued beside the changes", () => {
  it("runs in its turn, and makes no change asked for before it stale", async () => {
    const run = serial();
    const seen: string[] = [];
    const change = run(async (stale) => void seen.push(`switch stale=${stale()}`));
    const opens = ["b", "c", "d"].map((c) => run.after(async () => void seen.push(`open ${c}`)));
    await Promise.all([change, ...opens]);
    expect(seen).toEqual(["switch stale=false", "open b", "open c", "open d"]);
  });

  it("still runs when a change is asked for after it", async () => {
    const run = serial();
    const seen: string[] = [];
    const opens = ["b", "c"].map((c) => run.after(async () => void seen.push(`open ${c}`)));
    const later = run(async (stale) => void seen.push(`switch stale=${stale()}`));
    await Promise.all([...opens, later]);
    expect(seen).toEqual(["open b", "open c", "switch stale=false"]);
  });
});
