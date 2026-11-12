// ADR 0126, Delivery step 2: the probe again, inside the app's own page (tauri://localhost on Linux), under the app's
// own CSP, with the host frame and prelude the app ships (src/hermes/extensionHost.ts). run-app-probe.sh puts those in
// `window.__probeHost` ahead of this file and runs both with `wd.mjs eval`; read `window.__probe` afterwards.
// BEAT is a local listener that must receive nothing.
(() => {
  const { srcdoc: SRCDOC, prelude: PRELUDE } = window.__probeHost;
  const BEAT = window.__probeBeat || "http://127.0.0.9:47999/beat";
  const out = (window.__probe = { started: Date.now(), events: [] });
  const log = (k, v) => out.events.push([k, v, Date.now() - out.started]);
  const ATTEMPTS = (beat) => `
    self.onmessage = async (m) => {
      const port = m.ports[0]; const r = {};
      const t = async (k, f) => { try { r[k] = "allowed: " + String(await f()).slice(0, 80); } catch (e) { r[k] = "blocked: " + String(e).slice(0, 100); } };
      await t("fetch", () => fetch("${beat}?leak=fetch").then((x) => x.status));
      await t("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", "${beat}?leak=xhr", false); x.send(); return x.status; });
      await t("ipcFetch", () => fetch("ipc://localhost/plugin%3Aapp%7Cversion", { method: "POST" }).then((x) => x.status));
      await t("ipcHttp", () => fetch("http://ipc.localhost/plugin%3Aapp%7Cversion", { method: "POST" }).then((x) => x.status));
      await t("appOrigin", () => fetch("tauri://localhost/index.html").then((x) => x.status));
      await t("websocket", () => new Promise((ok, no) => { const w = new WebSocket("${beat.replace("http", "ws")}"); w.onopen = () => ok("open"); w.onerror = () => no("error event"); }));
      await t("importScripts", () => importScripts("${beat}?leak=import"));
      await t("eval", () => eval("1+1"));
      await t("function", () => new Function("return 2")());
      await t("indexedDB", () => new Promise((ok, no) => { const q = indexedDB.open("x"); q.onsuccess = () => ok("opened"); q.onerror = () => no(q.error); }));
      await t("caches", () => caches.open("x").then(() => "opened"));
      await t("nestedWorker", () => { new Worker(URL.createObjectURL(new Blob(["fetch('${beat}?leak=nested')"]))); return "started"; });
      await t("sharedWorker", () => { new SharedWorker("data:text/javascript,0"); return "started"; });
      await t("parent", () => typeof parent);
      await t("tauri", () => typeof self.__TAURI_INTERNALS__);
      await t("origin", () => self.origin);
      port.postMessage(JSON.stringify(r));
    };`;
  function frame(name, source) {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    f.srcdoc = SRCDOC;
    const calls = new MessageChannel();
    const control = new MessageChannel();
    calls.port1.onmessage = (e) => log(name, (() => { try { return JSON.parse(e.data); } catch { return e.data; } })());
    control.port1.onmessage = (e) => log(name + ".crash", String(e.data));
    f.addEventListener("load", () => f.contentWindow.postMessage(source, "*", [control.port2, calls.port2]), { once: true });
    document.body.append(f);
    return f;
  }
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  (async () => {
    frame("withPrelude", PRELUDE + ATTEMPTS(BEAT));
    frame("withoutPrelude", ATTEMPTS(BEAT));
    // Hoisted declarations run before the prelude: they must not turn it against something other than the global.
    frame("hoistedSelf", PRELUDE + "function self() {}\n" + ATTEMPTS(BEAT).replace("self.onmessage", "onmessage"));
    frame("hoistedObject", PRELUDE + "function Object() {} function globalThis() {}\n" + ATTEMPTS(BEAT).replace("self.onmessage", "onmessage"));
    frame("hoistedCaches", PRELUDE + "function caches() {}\n" + ATTEMPTS(BEAT).replace("self.onmessage", "onmessage"));
    await wait(2500);
    // Cache Storage across two opaque frames with the prelude: A tries to write, is removed, then B tries to read.
    const A = frame("cacheA", PRELUDE + `self.onmessage = async (m) => { const p = m.ports[0]; try { const c = await caches.open("shared"); await c.put("https://x/k", new Response("secret-from-A")); p.postMessage("wrote"); } catch (e) { p.postMessage(String(e)); } };`);
    await wait(1500);
    A.remove();
    frame("cacheB", PRELUDE + `self.onmessage = async (m) => { const p = m.ports[0]; try { const c = await caches.open("shared"); const r = await c.match("https://x/k"); p.postMessage(r ? await r.text() : "nothing"); } catch (e) { p.postMessage(String(e)); } };`);
    // The page's widest timer gap with no frame, as a baseline for the machine's load, then with a busy worker.
    const widestGap = async (ms) => {
      let prev = performance.now(), widest = 0;
      const t = setInterval(() => { const n = performance.now(); widest = Math.max(widest, n - prev); prev = n; }, 20);
      await wait(ms);
      clearInterval(t);
      return Math.round(widest);
    };
    log("baseline.pageGapMs", await widestGap(2500));
    let last = performance.now(), gap = 0;
    const tick = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; }, 20);
    const L = frame("loop", PRELUDE + `self.onmessage = (m) => { const p = m.ports[0]; let n = 0; for (;;) { const t = Date.now(); while (Date.now() - t < 200) {} p.postMessage(String(++n)); } };`);
    await wait(2500);
    clearInterval(tick);
    log("loop.pageGapMs", Math.round(gap));
    L.remove();
    // A beat already posted when the frame goes can still arrive; none should come after that.
    const beatsAtRemoval = out.events.filter((e) => e[0] === "loop").length;
    await wait(1500);
    log("loop.beatsAfterRemoval", out.events.filter((e) => e[0] === "loop").length - beatsAtRemoval);
    // A crash in the worker reaches the control port.
    frame("thrower", PRELUDE + `throw new Error("boom")`);
    await wait(800);
    out.done = true;
  })().catch((e) => {
    log("probeError", String(e));
    out.done = true;
  });
})();
