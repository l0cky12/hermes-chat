// Installed in the app's page by run.sh (`wd.mjs eval`). Reads only: it observes and moves no node.
// `sample(ms)` records every frame for that long: the interval since the one before, and the frame's work, from the
// frame's requestAnimationFrame timestamp, which every callback in it shares, to a message posted from this probe's
// callback, which runs once the frame's rendering step is done. A frame counts as changed when a transcript's DOM
// changed since the frame before was drawn.
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
    return s.length ? { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) } : { n: 0 };
  };
  window.__split = {
    sample: (ms) =>
      new Promise((done) => {
        const frames = [];
        let prev;
        let seen = muts;
        const t0 = performance.now();
        const step = (t) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => {
            frames.push({ interval: prev === undefined ? undefined : t - prev, work: performance.now() - t, changed: muts > seen });
            seen = muts;
            prev = t;
            if (t - t0 < ms) return requestAnimationFrame(step);
            const changed = frames.filter((f) => f.changed);
            done({
              frames: frames.length,
              changed: changed.length,
              intervalMs: stats(frames.filter((f) => f.interval !== undefined).map((f) => f.interval)),
              changedWorkMs: stats(changed.map((f) => f.work)),
              nodes: document.getElementsByTagName("*").length,
            });
          };
          ch.port2.postMessage(0);
        };
        requestAnimationFrame(step);
      }),
  };
  return "ok";
})();
