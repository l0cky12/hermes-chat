// A web page for the Preview that tries to reach the app's commands (#466). GET /p?mode=fetch|pm&hop=<host> serves
// the page. It tries the app's commands where it loaded, then moves its frame to the same port on `hop`. There WebView2
// serves the app's own index.html, whose scripts load from this server: every /assets/*.js is the same probe, which
// tries again from an origin Tauri counts as the app's. mode=pm breaks fetch first, so Tauri's IPC falls back to
// window.ipc.postMessage, and calls tray_set_close_to_tray, whose effect the app's own page can read back.
// Every result comes back as GET /report and is printed as one REPORT line.
import http from "node:http";
import fs from "node:fs";

const [port, logFile] = [Number(process.argv[2]), process.argv[3]];
const probe = `(() => {
const q = new URLSearchParams(location.search), mode = q.get("mode"), hop = q.get("hop");
const where = location.hostname === hop ? "at-hop" : "before-hop";
const realFetch = window.fetch.bind(window);
const report = (k, v) => realFetch("/report?" + new URLSearchParams({ mode, hop, where, origin: location.origin, k, v: String(v).slice(0, 300) })).catch(() => {});
report("env", "internals=" + typeof window.__TAURI_INTERNALS__ + " ipc=" + typeof window.ipc + " chromeWebview=" + typeof (window.chrome && window.chrome.webview) + " origin=" + origin);
try { localStorage.setItem("k", "v"); report("storage", "localStorage works"); } catch (e) { report("storage", "localStorage threw " + e.name); }
const tryInvoke = (label, cmd, args, opts) => {
  let done = false;
  setTimeout(() => done || report(label, "PENDING after 8s"), 8000);
  try {
    window.__TAURI_INTERNALS__.invoke(cmd, args, opts).then((r) => { done = true; report(label, "OK " + JSON.stringify(r)); }, (e) => { done = true; report(label, "REFUSED " + String(e)); });
  } catch (e) { done = true; report(label, "THREW " + String(e)); }
};
if (window.__TAURI_INTERNALS__) {
  if (mode === "pm") {
    window.fetch = () => Promise.reject(new Error("fetch broken by the probe"));
    tryInvoke("tray_set_close_to_tray", "tray_set_close_to_tray", { on: true });
  } else {
    tryInvoke("tray_status", "tray_status", {});
    tryInvoke("channel_fetch", "plugin:__TAURI_CHANNEL__|fetch", null, { headers: { "Tauri-Channel-Id": "0" } });
  }
}
if (where === "before-hop") setTimeout(() => { location = "http://" + hop + ":" + location.port + "/p?mode=" + mode + "&hop=" + hop; }, 9000);
})();`;

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/report") {
      const q = Object.fromEntries(u.searchParams);
      const line = `REPORT mode=${q.mode} hop=${q.hop} where=${q.where} origin=${q.origin} ${q.k}: ${q.v}`;
      console.log(line);
      fs.appendFileSync(logFile, line + "\n");
      return res.writeHead(204, { "access-control-allow-origin": "*" }).end();
    }
    fs.appendFileSync(logFile, `SERVED host=${req.headers.host} ${req.url}\n`);
    // An opaque-origin page loads the app's module scripts in CORS mode, so a hostile server allows any origin.
    res.setHeader("access-control-allow-origin", "*");
    if (u.pathname === "/p") res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset=utf-8><title>ipc probe</title><script>${probe}</script>`);
    else if (u.pathname.endsWith(".js")) res.writeHead(200, { "content-type": "text/javascript" }).end(probe);
    else if (u.pathname.endsWith(".css")) res.writeHead(200, { "content-type": "text/css" }).end("");
    else res.writeHead(404).end();
  })
  .listen(port, "127.0.0.1", () => console.log(`ipc probe on ${port}`));
