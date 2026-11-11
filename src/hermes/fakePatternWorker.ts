// Pattern workers for tests, since jsdom has no `Worker`. Each answers a task later, as a real one does, and never
// answers a pattern that `hangs` picks, as a worker stuck backtracking never does.
import type { SpawnWorker, WorkerReply } from "./patternRunner";
import { testPattern } from "./pyRegex";

export function fakePatternWorkers(hangs: (pattern: string) => boolean = () => false) {
  const spawned: { posted: string[]; stopped: boolean }[] = [];
  const spawn: SpawnWorker = (onReply) => {
    const w = { posted: [] as string[], stopped: false };
    spawned.push(w);
    const later = (r: WorkerReply) => setTimeout(() => !w.stopped && onReply(r));
    later("ready");
    return {
      post: (job) => {
        w.posted.push(job.pattern);
        if (!hangs(job.pattern)) later(testPattern(job.pattern, job.text));
      },
      stop: () => void (w.stopped = true),
    };
  };
  return { spawn, spawned };
}
