// Screenshots the signed-in app (main.tsx) in headless Chromium: one PNG per scene into tools/shots/out/.
// Uses Playwright's cached headless shell or $CHROME, as bench/run.mjs does. Usage: node tools/shots/shoot.mjs [scene...]
import { build, preview } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const out = fileURLToPath(new URL("./out/", import.meta.url));

// Each scene: the page's query, then a script run in the page once the chat list shows.
const click = (sel, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text ?? "")}));
     if (!el) throw new Error("no " + ${JSON.stringify(sel + " " + (text ?? ""))}); el.click(); })()`;
const scrollTo = (sel) => `document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "start" })`;
const key = (k, mods = {}) => `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(mods)} }))`;
// The chat list's sections (ADR 0036): three chats moved out of Settled, two of them snoozed (as another window would
// leave them), and a reply running in "NAS disk usage" so it shows in Working.
const sections = `(async () => {
  const h = window.shots.hermes;
  for (const id of ["caddy", "rust", "trip"]) await h.unsettle(id);
  const scope = JSON.stringify(["ssh", "liam@hermes", "liam", h.getSnapshot().profile]);
  localStorage.setItem("hermes-chat.snoozes", JSON.stringify({ v: 1, scopes: { [scope]: { trip: Date.now() + 3 * 3600e3, rust: Date.now() + 26 * 3600e3 } } }));
  window.dispatchEvent(new StorageEvent("storage", { key: "hermes-chat.snoozes" }));
  void h.send("nas", "Run a SMART check on every disk in tank");
})()`;
const menuOn = (chat) =>
  `(() => { const el = document.querySelector('.row-open[data-chat="${chat}"]'); const r = el.getBoundingClientRect();
     el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 20 })); })()`;
const hd = { width: 1920, height: 1080 };
const openSettings = key(",", { ctrlKey: true });
// Types into Settings' search box the way a person does, so React sees the change.
const typeSearch = (text) =>
  `(() => { const box = document.querySelector("input[aria-label='Search settings']");
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ${JSON.stringify(text)});
     box.dispatchEvent(new Event("input", { bubbles: true })); })()`;
// Types into the composer as the owner would: React sees an input event, and the caret is at the end.
const typeIn = (text) =>
  `(() => { const ta = document.querySelector("textarea[data-composer]"); ta.focus();
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
     ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const pickPersona = (profile) =>
  `(() => { const s = document.querySelector("select.persona-profile");
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(profile)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`;
// A computer_use capture as Hermes sends it with tool.complete (ADR 0060): its screenshot inline, as a 1440x900 PNG's
// worth of base64 (the bytes are random; only the size is real), then the tool call opened.
const capture = `(async () => {
  const { hermes: h, server: s } = window.shots;
  const bytes = new Uint8Array(445924).map(() => Math.random() * 256);
  let bin = ""; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const shot = "/home/liam/.hermes/cache/images/computer_use_76f76bd5c54f4cee.png";
  await h.send("nas", "Open the router's admin page and tell me its firmware version.");
  const rt = s.runtimeIdOf("nas");
  s.event(rt, "message.start");
  s.event(rt, "tool.start", { tool_id: "cu1", name: "computer_use", args: { action: "capture", mode: "vision" } });
  s.event(rt, "tool.complete", { tool_id: "cu1", name: "computer_use", duration_s: 0.59, result: {
    _multimodal: true,
    content: [
      { type: "text", text: "capture mode=vision 1440x900 app=Chromium-browser\\n0 interactable element(s):\\n  (shareable screenshot saved to " + shot + ")" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo" + btoa(bin) } },
    ],
    text_summary: "capture mode=vision 1440x900 app=Chromium-browser",
    meta: { mode: "vision", width: 1440, height: 900, elements: 0, png_bytes: 445924, screenshot_path: shot },
  } });
  s.event(rt, "message.complete", { text: "The router runs firmware 4.2.1.", status: "complete" });
})()`;
const scenes = {
  "sidebar-sections": { query: "", steps: [sections, click(".section-toggle", "Snoozed"), click(".section-toggle", "Settled")] },
  "sidebar-sections-light": { query: "?mode=light", steps: [sections, click(".section-toggle", "Snoozed"), click(".section-toggle", "Settled")] },
  "snooze-menu": { query: "", steps: [sections, menuOn("caddy")] },
  "snooze-custom": { query: "", steps: [sections, menuOn("caddy"), click(".menu-item", "Custom…"), click(".snooze-dialog .segmented button", "Duration")] },
  // A headless page never has focus and isn't hovered, so the actions a hover shows are shown on one top row (Settle) and
  // one Settled row (Unsettle): the same icon-only button.
  unsettle: {
    query: "",
    steps: [
      sections,
      click(".section-toggle", "Settled"),
      `(() => { const s = document.head.appendChild(document.createElement("style"));
         s.textContent = '.row:has([data-chat="backup"]) .row-action, .row:has([data-chat="zfs"]) .row-action { display: grid } .row:has([data-chat="backup"]) .row-meta, .row:has([data-chat="zfs"]) .row-meta { display: none }'; })()`,
    ],
  },
  "new-chat": { query: "", steps: [] },
  chat: { query: "", steps: [click("button", "Nightly backup")] },
  "chat-light": { query: "?mode=light", steps: [click("button", "Nightly backup")] },
  "new-chat-light": { query: "?mode=light", steps: [] },
  search: { query: "", steps: [click("button", "Nightly backup"), key("k", { ctrlKey: true })] },
  settings: { query: "", steps: [key(",", { ctrlKey: true })] },
  // Settings → General (#174), at 1920 × 1080 and at the window's 760 × 500 minimum.
  "general-connection": { query: "", ...hd, steps: [openSettings] },
  "general-launch": { query: "", ...hd, steps: [openSettings, click(".subnav-item", "Launch")] },
  "general-screenshots": { query: "", ...hd, steps: [openSettings, click(".subnav-item", "Screenshots")] },
  "general-chats": { query: "", ...hd, steps: [openSettings, click(".subnav-item", "Chats")] },
  "general-storage": { query: "", ...hd, steps: [openSettings, click(".subnav-item", "Storage")] },
  "general-search": { query: "", ...hd, steps: [openSettings, typeSearch("cache")] },
  "general-more": { query: "", ...hd, steps: [openSettings, click(".subnav-item", "Launch"), click(".set-more-btn[aria-label='About Close to tray']")] },
  "general-light": { query: "?mode=light", ...hd, steps: [openSettings, click(".subnav-item", "Storage")] },
  "general-min": { query: "", width: 760, height: 500, steps: [openSettings] },
  "general-min-launch": { query: "", width: 760, height: 500, steps: [openSettings, click(".subnav-item", "Launch")] },
  // Settings → Persona (ADR 0117): the profile picker, another profile's SOUL.md picked, and the question before
  // picking another while an edit is unsaved.
  persona: { query: "?profiles=1", steps: [key(",", { ctrlKey: true }), click("[role=tab]", "Persona")] },
  "persona-work": { query: "?profiles=1", steps: [key(",", { ctrlKey: true }), click("[role=tab]", "Persona"), pickPersona("work")] },
  "persona-ask": {
    query: "?profiles=1",
    steps: [
      key(",", { ctrlKey: true }),
      click("[role=tab]", "Persona"),
      `(() => { const t = document.querySelector("textarea.persona-text");
         Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, t.value + "\\nAlways answer in British English.\\n");
         t.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      pickPersona("research"),
    ],
  },
  // Automations (ADR 0108). Tall pages: the screenshot covers the whole screen, scrolled to the part named.
  automations: { query: "", steps: [click("button[aria-label='Automations']")] },
  "automation-editor": { query: "", height: 1700, steps: [click("button[aria-label='Automations']"), click("button", "New automation")] },
  "automation-preview": { query: "", height: 1100, steps: [click("button[aria-label='Automations']"), click("button", "New automation"), scrollTo(".automation-preview")] },
  "automation-history": { query: "", height: 1400, steps: [click("button[aria-label='Automations']"), click("button", "triage-issues"), scrollTo(".delivery-list")] },
  // Skills from the composer (issue #188): the "/" menu, the "$" menu mid-message, the note before sending, and the chat after.
  "skills-slash-menu": { query: "", steps: [click("button", "Nightly backup"), typeIn("/")] },
  "skills-dollar-menu": { query: "", steps: [click("button", "Nightly backup"), typeIn("clear the stale lock using $re")] },
  "skills-runs-with": { query: "", steps: [click("button", "Nightly backup"), typeIn("clear the stale lock using $restic-maintenance ")] },
  "skills-sent": { query: "", steps: [click("button", "Nightly backup"), typeIn("clear the stale lock using $restic-maintenance "), key("Enter")] },
  "skills-slash-menu-light": { query: "?mode=light", steps: [click("button", "Nightly backup"), typeIn("/")] },
  "computer-use-result": {
    query: "",
    steps: [click("button", "NAS disk usage"), capture, click(".tool-line", "computer_use"), `document.querySelectorAll(".tool.open pre")[1].scrollTop = 150`],
  },
  "automation-history-light": { query: "?mode=light", height: 1400, steps: [click("button[aria-label='Automations']"), click("button", "triage-issues"), scrollTo(".delivery-list")] },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}

await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];
const profile = mkdtempSync(join(tmpdir(), "shots-chrome-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
try {
  for (const name of wanted) {
    const scene = scenes[name];
    const target = /** @type {{ webSocketDebuggerUrl: string }} */ (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json());
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
      if (msg.method === "Runtime.exceptionThrown") logs.push(JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params));
    });
    const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
    const evaluate = async (expression) => {
      const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`${name}: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: scene.width ?? 1440, height: scene.height ?? 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: url + scene.query });
    for (let i = 0; !(await evaluate("!!document.querySelector('.sidebar, nav, aside') && document.body.innerText.includes('Nightly backup')")); i++) {
      if (i > 100) throw new Error(`${name}: app never showed. ${logs.join("\n")}`);
      await sleep(100);
    }
    await sleep(400);
    for (const step of scene.steps) {
      await evaluate(step);
      await sleep(500);
    }
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
    console.log(`${name}.png`, logs.length ? logs : "");
    ws.close();
  }
} finally {
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
