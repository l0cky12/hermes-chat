import { describe, expect, it } from "vitest";
import { createPacer, type Clock } from "./pacer";

/**
 * A display refreshing at 60 Hz, and a timer, that run only when told to: `run(ms)` steps that long, frame by frame.
 * `asked`: animation frames and timers waiting now; `requests`: animation frames asked for in all.
 */
function display() {
  let now = 0;
  let next = 1;
  let requests = 0;
  const queued = new Map<number, () => void>();
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    request: (fn) => (requests++, queued.set(next, fn), next++),
    cancel: (id) => void queued.delete(id),
    wait: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
  };
  const run = (ms: number) => {
    for (const end = now + ms; now < end; ) {
      now += 1000 / 60;
      for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.fn());
      const due = [...queued.values()];
      queued.clear();
      due.forEach((fn) => fn());
    }
  };
  return { clock, run, asked: () => queued.size + timers.size, requests: () => requests };
}

function setup() {
  const d = display();
  let drawn = 0;
  const pacer = createPacer({ draw: () => drawn++, clock: d.clock });
  return { ...d, pacer, drawn: () => drawn };
}

describe("The office's frame pacer", () => {
  it("draws once on waking, then nothing, and asks for no animation frame while nothing changes", () => {
    const { pacer, run, drawn, asked } = setup();
    run(500);
    expect(drawn()).toBe(0);
    pacer.setAwake(true);
    run(5_000);
    expect(drawn()).toBe(1);
    expect(asked()).toBe(0);
  });

  it("draws one frame for any number of changes between frames", () => {
    const { pacer, run, drawn } = setup();
    pacer.setAwake(true);
    run(100);
    for (let i = 0; i < 10; i++) pacer.invalidate();
    run(1_000);
    expect(drawn()).toBe(2);
  });

  it("draws at most 30 frames a second while something moves, and stops when it stops", () => {
    const { pacer, run, drawn, asked } = setup();
    pacer.setAwake(true);
    run(100);
    pacer.animating("typing", true);
    pacer.animating("camera", true);
    run(2_000);
    expect(drawn() - 1).toBeGreaterThanOrEqual(58);
    expect(drawn() - 1).toBeLessThanOrEqual(61);
    pacer.animating("typing", false);
    const before = drawn();
    run(500);
    expect(drawn()).toBeGreaterThan(before);
    pacer.animating("camera", false);
    run(100);
    const stopped = drawn();
    run(2_000);
    expect(drawn()).toBe(stopped);
    expect(asked()).toBe(0);
  });

  it("draws as often as the fastest mover asks, so slow typing doesn't cost camera-speed frames", () => {
    const { pacer, run, drawn, requests } = setup();
    pacer.setAwake(true);
    run(100);
    pacer.animating("typing", true, 6);
    const start = drawn();
    const asked = requests();
    run(2_000);
    expect(drawn() - start).toBeGreaterThanOrEqual(11);
    expect(drawn() - start).toBeLessThanOrEqual(13);
    // Between beats it waits on a timer: about one animation frame asked for per frame drawn, not one per refresh.
    expect(requests() - asked).toBeLessThanOrEqual(2 * (drawn() - start) + 2);
    // A change between beats, as when the camera turns, draws at once rather than at the next beat.
    const before = drawn();
    pacer.invalidate();
    run(40);
    expect(drawn()).toBe(before + 1);
    pacer.animating("camera", true, 30);
    const fast = drawn();
    run(1_000);
    expect(drawn() - fast).toBeGreaterThanOrEqual(29);
    pacer.animating("camera", false);
    const slow = drawn();
    run(1_000);
    expect(drawn() - slow).toBeLessThanOrEqual(7);
  });

  it("changes its most frames a second while running, and mixed movers follow it", () => {
    const { pacer, run, drawn } = setup();
    pacer.setAwake(true);
    run(100);
    pacer.animating("camera", true);
    const rate = (ms: number) => {
      const from = drawn();
      run(ms);
      return ((drawn() - from) * 1000) / ms;
    };
    expect(rate(2_000)).toBeGreaterThanOrEqual(28);
    pacer.setMaxFps(15);
    run(200);
    const low = rate(2_000);
    expect(low).toBeGreaterThanOrEqual(14);
    expect(low).toBeLessThanOrEqual(16);
    pacer.animating("typing", true, 6);
    expect(rate(2_000)).toBeLessThanOrEqual(16);
    pacer.setMaxFps(30);
    run(200);
    const high = rate(2_000);
    expect(high).toBeGreaterThanOrEqual(28);
    expect(high).toBeLessThanOrEqual(31);
  });

  it("draws nothing while asleep, even while something moves or changes, and catches up once on waking", () => {
    const { pacer, run, drawn, asked } = setup();
    pacer.setAwake(true);
    pacer.animating("typing", true);
    run(500);
    pacer.setAwake(false);
    const slept = drawn();
    pacer.invalidate();
    run(3_000);
    expect(drawn()).toBe(slept);
    expect(asked()).toBe(0);
    pacer.animating("typing", false);
    pacer.setAwake(true);
    run(1_000);
    expect(drawn()).toBe(slept + 1);
  });

  it("counts every frame, and draws none once disposed", () => {
    const { pacer, run, drawn } = setup();
    pacer.setAwake(true);
    run(100);
    expect(pacer.frames).toBe(drawn());
    pacer.dispose();
    pacer.invalidate();
    run(1_000);
    expect(pacer.frames).toBe(1);
  });
});
