// A live check of the Logs screen (ADR 0033) against a real Hermes dashboard. It starts a dashboard on a throwaway
// HERMES_HOME, relays `GET /api/logs` to it signed in (as the Rust side does), writes sustained high-volume lines with
// seeded secrets and rotation into the profile's gateway.log, and drives the real app (tools/shots/main.tsx) in headless
// Chromium: follow, burst, filters, pause, a dashboard restart, and a saved support bundle. Prints what it saw and
// saves screenshots to tools/shots/out/.
//
// Usage: HERMES_DIR=~/.hermes/hermes-agent node tools/shots/logs-live.mjs
// The dashboard runs from HERMES_DIR's venv, signs in with a password set up here, and never touches ~/.hermes.
import { build, preview } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const out = fileURLToPath(new URL("./out/", import.meta.url));
const hermesDir = process.env.HERMES_DIR ?? join(homedir(), ".hermes/hermes-agent");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

// ---------- the dashboard ----------
const home = mkdtempSync(join(tmpdir(), "hermes-logs-live-"));
mkdirSync(join(home, "logs"));
const user = "tester";
const password = "logs-live-" + Math.random().toString(36).slice(2);
const hash = execFileSync(join(hermesDir, "venv/bin/python"), ["-c", `from plugins.dashboard_auth.basic import hash_password; print(hash_password(${JSON.stringify(password)}))`], { cwd: hermesDir }).toString().trim();
writeFileSync(join(home, "config.yaml"), `dashboard:\n  basic_auth:\n    username: ${user}\n    password_hash: '${hash}'\n`);
const port = 9400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.2:${port}`;
let dash;
async function startDashboard() {
  dash = spawn(join(hermesDir, "venv/bin/hermes"), ["dashboard", "--host", "127.0.0.2", "--port", String(port), "--no-open", "--skip-build"], {
    cwd: hermesDir,
    env: { ...process.env, HERMES_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const hear = (d) => ((said += d), said.includes("HERMES_DASHBOARD_READY") && resolve());
    dash.stdout.on("data", hear);
    dash.stderr.on("data", hear);
    dash.once("exit", (c) => reject(new Error(`dashboard exited ${c}:\n${said}`)));
  }));
  cookie = undefined;
  log(`dashboard up at ${base} (HERMES_HOME=${home})`);
}
async function stopDashboard() {
  const exited = new Promise((r) => dash.once("exit", r));
  dash.kill("SIGTERM");
  await exited;
  log("dashboard stopped");
}

// ---------- the relay: the Rust side's job, signed in with a cookie ----------
let cookie;
async function signIn() {
  const res = await fetch(`${base}/auth/password-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "basic", username: user, password }) });
  if (!res.ok) throw new Error(`sign-in: ${res.status}`);
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const saved = [];
const relay = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  try {
    if (req.method === "POST" && req.url.startsWith("/save?")) {
      const name = new URL(req.url, "http://x").searchParams.get("name").replace(/[^\w.-]/g, "_");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const path = join(out, name);
      writeFileSync(path, Buffer.concat(chunks));
      saved.push(path);
      return res.end(path);
    }
    if (!req.url.startsWith("/api/logs?")) return (res.statusCode = 404), res.end();
    if (!cookie) await signIn();
    let up = await fetch(base + req.url, { headers: { cookie } });
    if (up.status === 401) (await signIn(), (up = await fetch(base + req.url, { headers: { cookie } })));
    res.statusCode = up.status;
    res.end(await up.text());
  } catch (e) {
    res.statusCode = 599;
    res.end(JSON.stringify({ unreachable: `Couldn't reach the dashboard: ${e.cause?.code ?? e.message}` }));
  }
});
await /** @type {Promise<void>} */ (new Promise((r) => relay.listen(0, "127.0.0.1", r)));
const relayUrl = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (relay.address()).port}`;

// ---------- the writer: gateway.log, as a RotatingFileHandler would write it ----------
const gatewayLog = join(home, "logs/gateway.log");
let rotateAt = 96 * 1024;
const SECRETS = [
  "Authorization: Bearer live0123456789abcdefSECRET",
  "OPENAI_API_KEY=sk-proj-LiveSeededKey0123456789",
  "Cookie: hermes_session=liveCookieValue42",
  "password=hunter2-live",
  "telegram token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
];
let written = 0;
let rotations = 0;
function writeLines(n) {
  let text = "";
  for (let i = 0; i < n; i++, written++) {
    const t = new Date().toISOString().replace("T", " ").replace("Z", "").replace(".", ",");
    const k = written % 50;
    if (k === 7) text += `${t} ERROR gateway.platforms.telegram: send failed (${SECRETS[(written / 50) % SECRETS.length | 0]}) #${written}\nTraceback (most recent call last):\n  File "gateway/run.py", line 42, in send\nConnectionError: reset #${written}\n`;
    else if (k === 13) text += `${t} WARNING gateway.run: slow reply \x1b[31m4.2s\x1b[0m \x1b]0;pwned\x07 <b>not bold</b> #${written}\n`;
    else text += `${t} INFO gateway.run: heartbeat ok #${written}\n`;
  }
  appendFileSync(gatewayLog, text);
  if (statSync(gatewayLog).size > rotateAt) {
    renameSync(gatewayLog, gatewayLog + ".1");
    rotations++;
  }
}
let rate = 0;
const writer = setInterval(() => rate && writeLines(Math.round(rate / 20)), 50);

// ---------- the browser ----------
function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}

await startDashboard();
await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];
const profileDir = mkdtempSync(join(tmpdir(), "logs-live-chrome-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const cdpPort = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});
mkdirSync(out, { recursive: true });

const results = [];
const check = (what, ok, detail = "") => (results.push({ what, ok }), log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`));

try {
  const target = /** @type {{ webSocketDebuggerUrl: string }} */ (await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? "");
  });
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expr, what, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evaluate(expr)) return true;
    throw new Error(`timed out waiting for ${what}`);
  };
  const shot = async (name) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
    log(`screenshot ${name}.png`);
  };
  // Picks an option in the labelled select, as a person would.
  const choose = (label, value) =>
    evaluate(`(() => { const l = [...document.querySelectorAll(".logs-filters label")].find(l => l.textContent.startsWith(${JSON.stringify(label)}));
      const s = l.querySelector("select, input"); const set = Object.getOwnPropertyDescriptor(s.constructor.prototype, "value").set;
      set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event(s.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()`);
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.includes(${JSON.stringify(text)}) || b.getAttribute("aria-label") === ${JSON.stringify(text)}); if (!b) throw new Error("no button " + ${JSON.stringify(text)}); b.click(); })()`);
  const view = () =>
    evaluate(`(() => { const l = document.querySelector(".logs-list"); const rows = [...l.querySelectorAll(".log-text")].map(e => e.textContent);
      return { rows: rows.length, first: rows[0], last: rows.at(-1), marks: [...l.querySelectorAll(".log-mark .log-text")].map(e => e.textContent),
        top: l.scrollTop, atBottom: l.scrollHeight - l.scrollTop - l.clientHeight < 4, status: document.querySelector(".logs-status")?.textContent,
        html: l.innerHTML.includes("<b>not bold</b>") }; })()`);

  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${url}?relay=${encodeURIComponent(relayUrl)}` });
  await until("!!document.body?.innerText.includes('Nightly backup')", "the app");
  // Main-thread stalls while it streams, to show it doesn't freeze.
  await evaluate(`window.__long = []; new PerformanceObserver(l => window.__long.push(...l.getEntries().map(e => e.duration))).observe({ type: "longtask", buffered: true })`);

  // 1. Follow sustained volume: 150 lines/s, ~300 between reads, with rotation every ~1,300 lines.
  rate = 150;
  await sleep(1500);
  await click("Logs");
  await until("!!document.querySelector('.logs-list')", "Logs");
  await choose("Source", "gateway");
  await sleep(20_000);
  let v = await view();
  log(`after 20 s at 150 lines/s: ${written} written, ${rotations} rotations; screen: ${v.status}`);
  check("follows the newest line", v.atBottom, `last row: ${v.last}`);
  check("rotation is noted", v.marks.some((m) => m.startsWith("The log file was rotated")), JSON.stringify(v.marks.slice(0, 3)));
  check("no lines missed at 150 lines/s", !v.marks.some((m) => m.startsWith("More than")), `${v.marks.length} notes`);
  check("secrets redacted on screen", !(await evaluate(`document.querySelector(".logs-list").textContent.match(/live0123456789|LiveSeededKey|liveCookieValue|hunter2-live|AAHdqTcv/)`)));
  check("escapes shown, markup not rendered", !v.html && (await evaluate(`document.querySelector(".logs-list").textContent.includes("\\\\x1b]0;pwned\\\\x07 <b>not bold</b>")`)));
  await shot("logs-follow");

  // 2. A burst Hermes can't keep up with: 1,500 lines/s, so more than 500 come between two reads. No rotation meanwhile,
  // or a read could find a fresh file and (rightly) call it rotated instead.
  rotateAt = Infinity;
  rate = 1500;
  await sleep(5000);
  rate = 150;
  rotateAt = 96 * 1024;
  await sleep(2500);
  v = await view();
  const longest = await evaluate("Math.max(0, ...window.__long)");
  check("a burst over 500 lines between reads is noted as missed", v.marks.some((m) => m.startsWith("More than 500 lines")));
  check("the buffer stays bounded", /lines? kept/.test(v.status) && v.rows <= 5000 + 50, `${v.rows} rows; ${v.status.match(/[\d,]+ lines? kept[^.]*/)?.[0]}`);
  check("the page doesn't freeze", longest < 1000, `longest main-thread task ${Math.round(longest)} ms`);

  // 3. Filters.
  await choose("Level", "ERROR");
  await choose("Containing", "telegram");
  await sleep(600);
  await shot("logs-filters");
  v = await view();
  check("filters show only matching ERROR records", v.rows > 0 && (await evaluate(`[...document.querySelectorAll(".logs-list .log-row:not(.log-mark) .log-text")].every(e => /ERROR .*telegram/.test(e.textContent))`)), `${v.rows} rows`);
  await choose("Level", "");
  await choose("Containing", "");
  await sleep(500);

  // 4. Pause: scroll up to read, and nothing moves while lines keep coming.
  await evaluate(`(() => { const l = document.querySelector(".logs-list"); l.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true })); l.scrollTop = l.scrollHeight / 2; })()`);
  await sleep(300);
  const before = await view();
  await sleep(6000);
  const after = await view();
  const waiting = await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Follow ("))?.textContent.trim()`);
  check("paused: the rows and scroll position stay put", before.first === after.first && before.last === after.last && before.top === after.top, `top ${before.top} → ${after.top}`);
  check("paused: new lines are counted", !!waiting, waiting);
  await shot("logs-paused");
  await click("Follow new lines");
  await sleep(400);
  v = await view();
  check("following again jumps to the newest lines", v.atBottom && v.last !== after.last, v.last);

  // 5. The dashboard goes away and comes back.
  await stopDashboard();
  await sleep(5000);
  const alert = await evaluate(`document.querySelector(".logs-problem")?.textContent`);
  check("a lost dashboard is reported", /Couldn't read the Hermes gateway log: Couldn't reach the dashboard/.test(alert ?? ""), alert);
  await startDashboard();
  await sleep(4000);
  v = await view();
  const gapNote = v.marks.find((m) => m.startsWith("Not read from"));
  check("the reconnect gap is noted where reading resumed", !!gapNote, gapNote);
  await evaluate(`(() => { const l = document.querySelector(".logs-list"); const m = [...l.querySelectorAll(".log-mark")].reverse().find(e => e.querySelector(".log-text").textContent.startsWith("Not read from")); l.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); m.scrollIntoView({ block: "center" }); })()`);
  await sleep(300);
  await shot("logs-reconnect");
  await click("Follow new lines");

  // 6. A support bundle with the agent log too, saved through the app's Save.
  rate = 0;
  await choose("Source", "agent");
  await sleep(3000);
  await click("Support bundle");
  await until("!!document.querySelector('.logs-bundle')", "the bundle preview");
  await sleep(300);
  await shot("logs-bundle");
  const summary = await evaluate(`document.querySelector(".logs-bundle").innerText.split("\\n").slice(0, 12).join("\\n")`);
  log("bundle preview says:\n" + summary);
  await evaluate(`[...document.querySelectorAll(".logs-bundle button")].find(b => b.textContent.includes("Save")).click()`);
  await until(`!document.querySelector(".logs-bundle")`, "the save");
  const file = saved.at(-1);
  const text = readFileSync(file, "utf8");
  log(`saved ${file} (${text.length} bytes); head:\n${text.split("\n").slice(0, 14).join("\n")}`);
  check("the saved bundle has no seeded secret", !/live0123456789|LiveSeededKey|liveCookieValue|hunter2-live|AAHdqTcv/.test(text));
  check("the saved bundle names its sources", /===== Hermes gateway \(gateway\.log\) =====/.test(text) && /===== Hermes agent \(agent\.log\) =====/.test(text) && /===== This app =====/.test(text));
  if (errors.length) log("page errors:", errors);
} finally {
  clearInterval(writer);
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await exited;
  await server.close();
  relay.close();
  if (dash?.exitCode === null) await stopDashboard();
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed; ${written} lines written, ${rotations} rotations.`);
process.exit(failed.length ? 1 : 0);
