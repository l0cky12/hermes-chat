// Runs connection changes one at a time (ADR 0112). Rust holds one connection, and a connect that finished after a
// later one would take it back, so each change starts only once the one before has finished, and a change that a
// newer one has overtaken stops at its next step (`stale()`), closing whatever it opened, before the next one runs.

export type Serial = (<T>(job: (stale: () => boolean) => Promise<T>) => Promise<T>) & {
  /**
   * Runs `job` like any change, but it can be stopped while it waits its turn: then it rejects at once with
   * `stopped()` and never starts. Unlike a plain change, it doesn't overtake the changes before it while it waits:
   * they carry on as asked, so stopping it can't leave them abandoned with nothing in their place. It claims its place
   * only when it starts, and starts already overtaken if a newer change was asked for after it. Once started,
   * stopping it is the job's own business.
   */
  stoppable<T>(signal: AbortSignal | undefined, stopped: () => Error, job: (stale: () => boolean) => Promise<T>): Promise<T>;
  /**
   * Runs `job` in its turn without overtaking anything: changes asked for before it aren't made stale by it, and it
   * isn't made stale by later ones. For work beside the changes, such as opening a background connection (ADR 0125).
   */
  after<T>(job: () => Promise<T>): Promise<T>;
};

export function serial(): Serial {
  let chain: Promise<unknown> = Promise.resolve();
  let latest = 0;
  const enqueue = <T>(start: () => Promise<T>): Promise<T> => {
    const run = chain.catch(() => {}).then(start);
    chain = run;
    return run;
  };
  const run = (<T>(job: (stale: () => boolean) => Promise<T>) => {
    const n = ++latest;
    return enqueue(() => job(() => n !== latest));
  }) as Serial;
  run.after = <T>(job: () => Promise<T>) => enqueue(job);
  run.stoppable = <T>(signal: AbortSignal | undefined, stopped: () => Error, job: (stale: () => boolean) => Promise<T>) => {
    if (signal?.aborted) return Promise.reject<T>(stopped());
    // What was asked for last when this was; anything newer by the time it starts overtakes it.
    const asked = latest;
    let started = false;
    const going = enqueue(async () => {
      if (signal?.aborted) throw stopped();
      started = true;
      if (latest !== asked) return job(() => true);
      const n = ++latest;
      return job(() => n !== latest);
    });
    if (!signal) return going;
    going.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!started) reject(stopped());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void going.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
  return run;
}
