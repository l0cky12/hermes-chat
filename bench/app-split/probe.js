// Installed in the app's page by run.sh (`wd.mjs eval`). Reads only: it observes and moves no node.
// Between `start()` and `stop()` it records every frame's interval, from one requestAnimationFrame timestamp to the
// next. It asks for the next frame first thing in each callback, since anything that runs later can land after the
// next frame has begun, and the probe would then see every other frame. `bareFrames` counts frames with a callback
// that does nothing else, and run.sh fails a sample whose `frames` falls short of it. An interval counts as changed
// when a transcript's DOM changed during it. `ghost`: the divider's guide line showed, as it does once a drag is slow.
(() => {
  if (window.__split) return "already";
  let muts = 0;
  const observer = new MutationObserver((ms) => (muts += ms.length));
  for (const t of document.querySelectorAll(".transcript")) observer.observe(t, { subtree: true, childList: true, characterData: true });
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
    return s.length ? { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1), total: Math.round(s.reduce((a, b) => a + b, 0)), over50: s.filter((x) => x > 50).length } : { n: 0 };
  };
  let run;
  const start = () => {
    const r = (run = { intervals: [], changed: 0, bare: 0, ghost: false, on: true });
    let prev;
    let seen = muts;
    const step = (t) => {
      if (!r.on) return;
      requestAnimationFrame(step);
      if (prev !== undefined) {
        r.intervals.push(t - prev);
        if (muts > seen) r.changed++;
      }
      prev = t;
      seen = muts;
      r.ghost ||= !!document.querySelector(".divider-ghost");
    };
    const bare = () => r.on && (r.bare++, requestAnimationFrame(bare));
    requestAnimationFrame(bare);
    requestAnimationFrame(step);
    return 1;
  };
  const stop = () => {
    run.on = false;
    return {
      frames: run.intervals.length + 1,
      bareFrames: run.bare,
      changed: run.changed,
      intervalMs: stats(run.intervals),
      ghost: run.ghost,
      ratio: document.querySelector(".divider")?.getAttribute("aria-valuenow"),
      nodes: document.getElementsByTagName("*").length,
    };
  };
  window.__split = { start, stop, sample: (ms) => (start(), new Promise((done) => setTimeout(() => done(stop()), ms))) };
  return "ok";
})();
