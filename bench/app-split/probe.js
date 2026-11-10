// Installed in the app's page by run.sh (`wd.mjs eval`). Reads only: it observes and moves no node.
// Between `start()` and `stop()` it records every frame: the interval since the one before, and the frame's work, from
// the frame's requestAnimationFrame timestamp, which every callback in it shares, to a message posted from this probe's
// callback, which runs once the frame's rendering step is done. A frame counts as changed when a transcript's DOM
// changed since the frame before was drawn. `ghost`: the divider's guide line showed, as it does once a drag is slow.
(() => {
  if (window.__split) return "already";
  let muts = 0;
  new MutationObserver((ms) => (muts += ms.length)).observe(document.querySelector(".panes-row") ?? document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
    return s.length ? { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1), total: Math.round(s.reduce((a, b) => a + b, 0)), over50: s.filter((x) => x > 50).length } : { n: 0 };
  };
  let run;
  const start = () => {
    const r = (run = { frames: [], ghost: false, prev: undefined, seen: muts, on: true });
    const step = (t) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        r.frames.push({ interval: r.prev === undefined ? undefined : t - r.prev, work: performance.now() - t, changed: muts > r.seen });
        r.seen = muts;
        r.prev = t;
        r.ghost ||= !!document.querySelector(".divider-ghost");
        if (r.on) requestAnimationFrame(step);
      };
      ch.port2.postMessage(0);
    };
    requestAnimationFrame(step);
    return 1;
  };
  const stop = () => {
    run.on = false;
    const changed = run.frames.filter((f) => f.changed);
    return {
      frames: run.frames.length,
      changed: changed.length,
      intervalMs: stats(run.frames.filter((f) => f.interval !== undefined).map((f) => f.interval)),
      workMs: stats(run.frames.map((f) => f.work)),
      changedWorkMs: stats(changed.map((f) => f.work)),
      ghost: run.ghost,
      ratio: document.querySelector(".divider")?.getAttribute("aria-valuenow"),
      nodes: document.getElementsByTagName("*").length,
    };
  };
  window.__split = { start, stop, sample: (ms) => (start(), new Promise((done) => setTimeout(() => done(stop()), ms))) };
  return "ok";
})();
