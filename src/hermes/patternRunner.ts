// Webhook filter patterns are tested on a worker with a time limit, so a pattern that backtracks on a crafted event
// can't freeze the window (#490). One pattern runs at a time, and a worker that runs out of time is replaced.
import type { PatternTest, Verdict } from "./automations";

/**
 * How long one pattern may run. Filters on an example event (whose text is cut to 2000 characters) take well under a
 * millisecond, so this leaves a wide margin, yet a slow pattern is reported while the owner is still looking at it and
 * holds up the patterns queued behind it for at most this long. It also comes before WebKit's own backtracking limit
 * (measured at 0.6 to 0.9 s), where WebKit stops and answers "no match" without finishing.
 */
export const PATTERN_TIME_LIMIT_MS = 250;
const REMEMBERED = 500;

export type PatternJob = { pattern: string; text: string };
/** A worker says "ready" once it has loaded, then answers each job in turn. */
export type WorkerReply = "ready" | boolean;
export type SpawnWorker = (onReply: (reply: WorkerReply) => void) => { post(job: PatternJob): void; stop(): void };

export type PatternRunner = {
  /** The pattern's answer on `text`: "checking" until the worker has tested it, "too-slow" if it ran out of time. */
  test: PatternTest;
  /** For `useSyncExternalStore`: `version` changes each time an answer arrives. */
  subscribe(onAnswer: () => void): () => void;
  version(): number;
};

export function patternRunner(spawn: SpawnWorker, limitMs = PATTERN_TIME_LIMIT_MS): PatternRunner {
  const answers = new Map<string, Verdict>();
  // Taken newest first: while a slow pattern runs, the one typed last is the one the owner is looking at.
  const queue: (PatternJob & { key: string })[] = [];
  let worker: (ReturnType<SpawnWorker> & { ready: boolean }) | undefined;
  let running: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let version = 0;
  const listeners = new Set<() => void>();

  const settle = (key: string, answer: Verdict) => {
    running = undefined;
    answers.set(key, answer);
    if (answers.size > REMEMBERED) answers.delete(answers.keys().next().value!);
    version++;
    for (const l of listeners) l();
    next();
  };

  const start = () => {
    const w = {
      ready: false,
      ...spawn((reply) => {
        if (w !== worker) return;
        if (reply === "ready") {
          w.ready = true;
          next();
        } else if (running) {
          clearTimeout(running.timer);
          settle(running.key, reply);
        }
      }),
    };
    return w;
  };

  const next = () => {
    if (running || !queue.length) return;
    worker ??= start();
    if (!worker.ready) return;
    const w = worker;
    const { key, pattern, text } = queue.pop()!;
    const timer = setTimeout(() => {
      w.stop();
      worker = undefined;
      settle(key, "too-slow");
    }, limitMs);
    running = { key, timer };
    w.post({ pattern, text });
  };

  return {
    test: (pattern, text) => {
      const key = JSON.stringify([pattern, text]);
      const known = answers.get(key);
      if (known !== undefined) return known;
      answers.set(key, "checking");
      queue.push({ key, pattern, text });
      next();
      return "checking";
    },
    subscribe: (onAnswer) => {
      listeners.add(onAnswer);
      return () => listeners.delete(onAnswer);
    },
    version: () => version,
  };
}

/** The app's runner. jsdom has no `Worker`, so tests replace this with a runner on a fake worker. */
export const appPatterns = patternRunner((onReply) => {
  const w = new Worker(new URL("./patternWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorkerReply>) => onReply(e.data);
  return { post: (job) => w.postMessage(job), stop: () => w.terminate() };
});
