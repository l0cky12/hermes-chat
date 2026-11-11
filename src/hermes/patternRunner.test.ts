// The pattern runner: webhook filter patterns are tested on a worker with a time limit (#490), here on fake workers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePatternWorkers } from "./fakePatternWorker";
import { PATTERN_TIME_LIMIT_MS, type SpawnWorker, patternRunner } from "./patternRunner";
import { testPattern } from "./pyRegex";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const SLOW = "(a+)+$";

describe("the pattern runner", () => {
  it("answers from the worker, tells subscribers, and asks the worker once per pattern and text", async () => {
    const workers = fakePatternWorkers();
    const runner = patternRunner(workers.spawn);
    const told = vi.fn();
    runner.subscribe(told);
    expect(runner.test("^Crash", "Crash when empty")).toBe("checking");
    expect(runner.test("^Crash", "No crash")).toBe("checking");
    await vi.runAllTimersAsync();
    expect(runner.test("^Crash", "Crash when empty")).toBe(true);
    expect(runner.test("^Crash", "No crash")).toBe(false);
    expect(told).toHaveBeenCalledTimes(2);
    expect(workers.spawned.flatMap((w) => w.posted)).toEqual(["^Crash", "^Crash"]);
  });

  it("says a pattern is too slow once its time is up, and tests the next one on a new worker", async () => {
    const workers = fakePatternWorkers((p) => p === SLOW);
    const runner = patternRunner(workers.spawn);
    expect(runner.test(SLOW, "aaaa!")).toBe("checking");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.test("^a", "aaaa!")).toBe("checking");
    await vi.advanceTimersByTimeAsync(PATTERN_TIME_LIMIT_MS - 1);
    expect(runner.test(SLOW, "aaaa!")).toBe("checking");
    expect(runner.test("^a", "aaaa!")).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.test(SLOW, "aaaa!")).toBe("too-slow");
    expect(workers.spawned[0].stopped).toBe(true);
    await vi.runAllTimersAsync();
    expect(runner.test("^a", "aaaa!")).toBe(true);
    expect(workers.spawned).toHaveLength(2);
    expect(workers.spawned[1].stopped).toBe(false);
  });

  it("times a pattern from when the worker is ready, not from when it started loading", async () => {
    const slowStart = vi.fn<SpawnWorker>((onReply) => {
      setTimeout(() => onReply("ready"), PATTERN_TIME_LIMIT_MS * 4);
      return { post: (job) => void setTimeout(() => onReply(testPattern(job.pattern, job.text))), stop: () => {} };
    });
    const runner = patternRunner(slowStart);
    expect(runner.test("^a", "abc")).toBe("checking");
    await vi.runAllTimersAsync();
    expect(runner.test("^a", "abc")).toBe(true);
    expect(slowStart).toHaveBeenCalledTimes(1);
  });

  it("tests the newest pattern first, which is the one being typed", async () => {
    const workers = fakePatternWorkers((p) => p.startsWith("(a+)+"));
    const runner = patternRunner(workers.spawn);
    runner.test("(a+)+", "aaaa!");
    await vi.advanceTimersByTimeAsync(0);
    for (const p of ["(a+)+$", "^b", "^a"]) runner.test(p, "aaaa!");
    await vi.advanceTimersByTimeAsync(PATTERN_TIME_LIMIT_MS + 10);
    expect(runner.test("^a", "aaaa!")).toBe(true);
    expect(runner.test("^b", "aaaa!")).toBe(false);
    expect(runner.test("(a+)+$", "aaaa!")).toBe("checking");
  });
});
