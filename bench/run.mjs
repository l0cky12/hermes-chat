// Builds the bench page, serves it, and runs `window.bench` in headless Chromium over the DevTools protocol: timings for
// opening, streaming, find-in-chat and scrolling per chat size, the first open cold, plus memory after each open. Then
// the same size twice side by side: opening both, two replies streaming at once, and moving the divider.
// Uses Playwright's cached headless shell (`npx playwright install chromium-headless-shell`) or $CHROME; no npm deps.
// Usage: [THROTTLE=4] node bench/run.mjs [turns...]   (default 50 200 800; THROTTLE slows the CPU that many times)
//        [THROTTLE=4] node bench/run.mjs code [blocks...]   streams a reply of N code blocks, untagged and tagged
//        (default 1 3 6 10), one 12-character delta a frame (#224)
import { build, preview } from "vite";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const code = process.argv[2] === "code";
const sizes = process.argv.slice(code ? 3 : 2).map(Number);
if (!sizes.length) sizes.push(...(code ? [1, 3, 6, 10] : [50, 200, 800]));

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  if (!dir) throw new Error("No headless Chromium: set CHROME or run `npx playwright install chromium-headless-shell`.");
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}

await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];

const profile = mkdtempSync(join(tmpdir(), "bench-chrome-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});

const target = /** @type {{ webSocketDebuggerUrl: string }} */ (await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
});
const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
async function evaluate(expression) {
  const { result, error } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (error || result.exceptionDetails) throw new Error(JSON.stringify(error ?? result.exceptionDetails, null, 2));
  return result.result.value;
}

async function memory() {
  await send("HeapProfiler.collectGarbage");
  const { result } = await send("Performance.getMetrics");
  const m = Object.fromEntries(result.metrics.map((x) => [x.name, x.value]));
  return { heapMB: Math.round(m.JSHeapUsedSize / 1e5) / 10, domNodes: m.Nodes };
}

// Runs `expression` in the page, adding the main-thread time Chromium spent in script, style and layout meanwhile.
async function timed(expression) {
  const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).result.metrics.map((x) => [x.name, x.value]));
  const before = await metrics();
  const value = await evaluate(expression);
  const after = await metrics();
  const ms = (k) => Math.round((after[k] - before[k]) * 1000);
  return { ...value, scriptMs: ms("ScriptDuration"), styleMs: ms("RecalcStyleDuration"), layoutMs: ms("LayoutDuration") };
}

// Drags the divider 30% of the width to the left and back with real mouse input, a move every 16 ms.
async function drag() {
  const { x, y, width } = await evaluate("bench.dragWatch.start()");
  const mouse = (type, px) => send("Input.dispatchMouseEvent", { type, x: px, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await mouse("mousePressed", x);
  const path = [...Array(30).keys()].map((i) => x - (width * 0.3 * (i + 1)) / 30);
  for (const px of [...path, ...path.reverse().slice(1), x - width * 0.1]) {
    await mouse("mouseMoved", px);
    await new Promise((r) => setTimeout(r, 16));
  }
  await mouse("mouseReleased", x - width * 0.1);
  return evaluate("bench.dragWatch.stop()");
}

try {
  await send("Performance.enable");
  if (Number(process.env.THROTTLE) > 1) await send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) });
  for (let i = 0; !(await evaluate("!!window.bench")); i++) {
    if (i > 100) throw new Error(`window.bench never appeared at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (code)
    for (const blocks of sizes)
      for (const tagged of [false, true]) console.log(`code x${blocks} ${tagged ? "tagged  " : "untagged"}`, await timed(`bench.streamCode(${blocks}, ${tagged})`));
  for (const turns of code ? [] : sizes) {
    console.log(`\n== ${turns} turns ==`);
    console.log("open  ", await timed(`bench.open(${turns})`), await memory());
    console.log("stream", await timed("bench.stream()"));
    console.log("find  ", await timed(`bench.find("const")`));
    console.log("scroll", await timed("bench.scroll()"));
    console.log("split open  ", await timed(`bench.splitOpen(${turns})`), await memory());
    console.log("split stream", await timed("bench.splitStream()"));
    console.log("split resize", await timed("bench.splitResize()"));
    console.log("split drag  ", await drag());
  }
} finally {
  ws.close();
  proc.kill();
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
