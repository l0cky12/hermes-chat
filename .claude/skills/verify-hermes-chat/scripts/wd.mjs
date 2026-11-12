#!/usr/bin/env node
// A zero-dependency WebDriver client for the real Hermes Chat window, through tauri-driver + WebKitWebDriver.
// It reads the run's ports and session from $HV_RUN/state.env and $HV_RUN/session (written by `hv up` / `wd.mjs open`).
//
//   wd.mjs open                      launch the app under WebDriver (tauri-driver starts the binary) and save the session
//   wd.mjs close                     end the session; the app quits
//   wd.mjs wait  <css> [text] [ms]   wait until an element matching css (and containing text) is displayed
//   wd.mjs gone  <css> [text] [ms]   wait until no displayed element matches
//   wd.mjs click <css> [text]        click the first displayed match (real pointer input through WebKit automation)
//   wd.mjs wheel <css> [text] -- <dy> [below]   turn the scroll wheel by dy pixels over the match's middle, or `below`
//                                    pixels under it (negative dy: away from you, which zooms the office in toward that
//                                    point; `below` reaches the character under an office name tag)
//   wd.mjs drag <css> [text] -- <x0> <y0> <x1> <y1>   press at (x0, y0) from the match's top-left, move to (x1, y1) in
//                                    steps, and release, as WebDriver pointer input
//   wd.mjs rightclick <css> [text]   right-click the match with real X input (xdotool), which opens a context menu
//   wd.mjs fill  <css> [text] -- <value>   clear the field, then type value as key presses
//   wd.mjs select <css> [text] -- <option>   pick a native <select> option by its text (the popup itself never renders)
//   wd.mjs press <chord>             press a key chord: Control+k, Control+comma is Control+",", Escape, Shift+Tab, ArrowDown
//   wd.mjs keys  <value>             type into whatever has focus; \n is Enter, \t is Tab, \e is Escape
//   wd.mjs text  <css> [text]        print the match's visible text
//   wd.mjs count <css> [text]        print how many displayed elements match
//   wd.mjs value <css> [text]        print an input's current value
//   wd.mjs handles                   list visible buttons, links, inputs and dialogs with their accessible names
//   wd.mjs eval  <js>                run JS in the page, print the JSON result (read-only checks only; never drive with it)
//   wd.mjs shot  <name|path.png>     screenshot the webview; a bare name goes to the run's evidence folder
//   wd.mjs html  <name|path.html>    save the page's current DOM, same naming
//
// [text] matches an element whose trimmed text, aria-label, title, placeholder or <label> contains text (case-sensitive).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = process.env.HV_RUN;
if (!run || !existsSync(join(run, "state.env"))) die("HV_RUN is unset or has no state.env: run `hv up` first and export the HV_RUN it prints");
const state = Object.fromEntries(
  readFileSync(join(run, "state.env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => l.replace(/^export /, "").split(/=(.*)/s).slice(0, 2).map((s) => s.replace(/^'|'$/g, ""))),
);
const base = `http://127.0.0.1:${state.DRIVER_PORT}`;
const sessionFile = join(run, "session");
// A bare name lands in the run's evidence folder; a path is used as given.
const evidence = (name, ext) => (name.includes("/") ? name : join(state.EVIDENCE, name.endsWith(ext) ? name : name + ext));

function die(msg, code = 1) {
  console.error(`wd: ${msg}`);
  process.exit(code);
}
async function wd(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  /** @type {{ value?: any }} */
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.value?.error) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(out.value ?? out).slice(0, 400)}`);
  return out.value;
}
const sid = () => (existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() : die("no session: run `wd.mjs open`"));
const s = (p) => `/session/${sid()}${p}`;
const exec = (script, args = []) => wd("POST", s("/execute/sync"), { script, args });

// Finds displayed elements by css, optionally narrowed to ones whose text, aria-label or title contains `text`.
// Prefers the innermost match, so `click button Send` doesn't hit a wrapper.
const FIND = `
  const [css, text] = arguments;
  const shown = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const label = (e) => [e.textContent, e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("placeholder"), e.labels?.[0]?.textContent].map((v) => (v || "").trim());
  let all = [...document.querySelectorAll(css)].filter(shown);
  if (text) all = all.filter((e) => label(e).some((v) => v.includes(text)));
  return all.filter((e) => !all.some((o) => o !== e && e.contains(o)));`;
// One line per visible control: tag | role or type | aria-label or <label> | text, or an input's value or placeholder | disabled.
const HANDLES = `
  const css = "button, a[href], input, textarea, select, [role=button], [role=tab], [role=dialog], [role=menuitem], [role=alert], [role=status]";
  return [...document.querySelectorAll(css)]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })
    .map((e) => [e.tagName.toLowerCase(), e.getAttribute("role") || e.type || "", e.getAttribute("aria-label") || (e.labels?.[0]?.textContent ?? "").trim(),
      (e.matches("input, textarea") ? (e.value ? "value=" + e.value : "placeholder=" + e.placeholder) : e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60), e.disabled ? "disabled" : ""].join(" | "));`;
const find = (css, text) => exec(FIND, [css, text ?? ""]);
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const elId = (el) => el[ELEMENT];

async function waitFor(css, text, ms, want = true) {
  const until = Date.now() + ms;
  for (;;) {
    const found = await find(css, text);
    if (want ? found.length : !found.length) return found;
    if (Date.now() > until) die(`timed out after ${ms} ms waiting for ${want ? "" : "no "}${css}${text ? ` containing "${text}"` : ""}`, 2);
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function one(css, text) {
  const found = await waitFor(css, text, 10000);
  return elId(found[0]);
}
// A wait's [ms]: 15 s when omitted. Anything but a whole number of ms is an error, since NaN would never time out.
function timeoutMs(raw) {
  if (raw === undefined || raw === "") return 15000;
  if (!/^\d+$/.test(raw)) die(`timeout must be a whole number of ms, got "${raw}"`);
  return Number(raw);
}
const unescape =(v) => v.replace(/\\n/g, "").replace(/\\t/g, "").replace(/\\e/g, "");

const [cmd, ...args] = process.argv.slice(2);
const dashdash = args.indexOf("--");
const [css, text, extra] = dashdash >= 0 ? args.slice(0, dashdash) : args;
try {
  switch (cmd) {
    case "open": {
      if (existsSync(sessionFile)) die(`a session is already open (${readFileSync(sessionFile, "utf8").trim()}); run \`wd.mjs close\` first`);
      const v = await wd("POST", "/session", {
        capabilities: { alwaysMatch: { "tauri:options": { application: state.APP } } },
      });
      writeFileSync(sessionFile, v.sessionId);
      console.log(`session ${v.sessionId}`);
      break;
    }
    case "close":
      await wd("DELETE", s("")).catch((e) => console.error(String(e)));
      rmSync(sessionFile, { force: true });
      console.log("closed");
      break;
    case "wait":
      await waitFor(css, text, timeoutMs(extra));
      console.log("ok");
      break;
    case "gone":
      await waitFor(css, text, timeoutMs(extra), false);
      console.log("ok");
      break;
    case "click":
      await wd("POST", s(`/element/${await one(css, text)}/click`), {});
      console.log("clicked");
      break;
    case "wheel": {
      if (dashdash < 0) die("wheel needs `-- <dy>`");
      const middle = "const r = arguments[0].getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];";
      const [x, y] = await exec(middle, [{ [ELEMENT]: await one(css, text) }]);
      const below = Number(args[dashdash + 2] ?? 0);
      await wd("POST", s("/actions"), {
        actions: [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", origin: "viewport", x, y: y + below, deltaX: 0, deltaY: Number(args[dashdash + 1]) }] }],
      });
      await wd("DELETE", s("/actions"));
      console.log("scrolled");
      break;
    }
    case "drag": {
      if (dashdash < 0) die("drag needs `-- <x0> <y0> <x1> <y1>`");
      const [x0, y0, x1, y1] = args.slice(dashdash + 1, dashdash + 5).map(Number);
      if (![x0, y0, x1, y1].every(Number.isFinite)) die("drag needs four numbers");
      const corner = "const r = arguments[0].getBoundingClientRect(); return [r.left, r.top];";
      const [left, top] = await exec(corner, [{ [ELEMENT]: await one(css, text) }]);
      const at = (x, y) => ({ type: "pointerMove", origin: "viewport", x: Math.round(left + x), y: Math.round(top + y), duration: 50 });
      const steps = Array.from({ length: 8 }, (_, i) => at(x0 + ((x1 - x0) * (i + 1)) / 8, y0 + ((y1 - y0) * (i + 1)) / 8));
      await wd("POST", s("/actions"), {
        actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [at(x0, y0), { type: "pointerDown", button: 0 }, ...steps, { type: "pointerUp", button: 0 }] }],
      });
      await wd("DELETE", s("/actions"));
      console.log("dragged");
      break;
    }
    case "rightclick": {
      // Not WebDriver pointer actions: WebKitWebDriver releases button 2 as a mouseup of button 0 plus a click, so a
      // right-click on a link would also follow it. Real X input through `hv x` sends exactly what a mouse sends.
      const id = await one(css, text);
      const xdo = (...a) => execFileSync(join(dirname(fileURLToPath(import.meta.url)), "hv"), ["x", ...a], { env: process.env });
      await exec(`window.__wdOffset = undefined;
        addEventListener("mousemove", (e) => { window.__wdOffset = [e.screenX - e.clientX, e.screenY - e.clientY]; }, { capture: true, once: true });`);
      const win = String(xdo("getactivewindow", "getwindowgeometry", "--shell"));
      const g = Object.fromEntries(win.trim().split("\n").map((l) => l.split("=")).map(([k, v]) => [k, Number(v)]));
      xdo("mousemove", String(g.X + g.WIDTH / 2), String(g.Y + g.HEIGHT / 2));
      xdo("mousemove", String(g.X + g.WIDTH / 2 + 1), String(g.Y + g.HEIGHT / 2 + 1));
      // xdotool returns before WebKit has delivered the move.
      let off = null;
      for (let i = 0; i < 20 && !off; i++) off = await exec("return window.__wdOffset ?? null").then((v) => v ?? new Promise((r) => setTimeout(() => r(null), 100)));
      if (!off) die("rightclick: the window saw no pointer move, so its screen position is unknown");
      // Into view as WebDriver's own click does, then the middle of the first line box that hit-tests to the element, so
      // a link that wraps or sits half under a scroll edge is still hit. The listener proves the press landed on it.
      const at = await exec(`const el = arguments[0];
        el.scrollIntoView({ block: "center", inline: "nearest" });
        window.__wdHit = false;
        addEventListener("contextmenu", (e) => { window.__wdHit = el.contains(e.target); }, { capture: true, once: true });
        for (const r of el.getClientRects()) {
          const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
          if (hit && (el === hit || el.contains(hit))) return [x, y];
        }
        return null;`, [{ [ELEMENT]: id }]);
      if (!at) die(`rightclick: no visible point of ${css}${text ? ` "${text}"` : ""} is on top`);
      xdo("mousemove", String(Math.round(off[0] + at[0])), String(Math.round(off[1] + at[1])));
      xdo("mousedown", "3");
      await new Promise((r) => setTimeout(r, 120));
      xdo("mouseup", "3");
      let hit = false;
      for (let i = 0; i < 20 && !hit; i++) hit = await exec("return window.__wdHit").then((v) => v || new Promise((r) => setTimeout(() => r(false), 100)));
      if (!hit) die("rightclick: the press landed on something else");
      console.log("right-clicked");
      break;
    }
    case "fill": {
      if (dashdash < 0) die("fill needs `-- <value>`");
      const id = await one(css, text);
      await wd("POST", s(`/element/${id}/clear`), {});
      await wd("POST", s(`/element/${id}/value`), { text: unescape(args.slice(dashdash + 1).join(" ")) });
      console.log("filled");
      break;
    }
    case "select": {
      if (dashdash < 0) die("select needs `-- <option text>`");
      const want = args.slice(dashdash + 1).join(" ");
      const id = await one(css, text);
      const option = await exec("return [...arguments[0].options].find((o) => o.textContent.trim() === arguments[1]) ?? null", [{ [ELEMENT]: id }, want]);
      if (!option) die(`no option "${want}" in ${css}`);
      await wd("POST", s(`/element/${elId(option)}/click`), {});
      console.log("selected");
      break;
    }
    case "keys":
      await wd("POST", s("/actions"), {
        actions: [{ type: "key", id: "kb", actions: [...unescape(args.join(" "))].flatMap((c) => [{ type: "keyDown", value: c }, { type: "keyUp", value: c }]) }],
      });
      console.log("typed");
      break;
    case "press": {
      // A chord such as Control+k, Control+Shift+p, Escape, ArrowDown: modifiers held, the last key pressed and released.
      const names = { Control: "\uE009", Ctrl: "\uE009", Shift: "\uE008", Alt: "\uE00A", Meta: "\uE03D", Enter: "\uE007", Escape: "\uE00C", Tab: "\uE004",
        Backspace: "\uE003", Delete: "\uE017", ArrowUp: "\uE013", ArrowDown: "\uE015", ArrowLeft: "\uE012", ArrowRight: "\uE014", Home: "\uE011", End: "\uE010", Space: " " };
      const parts = (css ?? "").split("+").map((k) => names[k] ?? k);
      if (!parts[0] || parts.some((k) => [...k].length !== 1)) die(`press: unknown key in "${css}"`);
      const mods = parts.slice(0, -1), key = parts.at(-1);
      await wd("POST", s("/actions"), {
        actions: [{ type: "key", id: "kb", actions: [...mods.map((m) => ({ type: "keyDown", value: m })), { type: "keyDown", value: key }, { type: "keyUp", value: key }, ...mods.reverse().map((m) => ({ type: "keyUp", value: m }))] }],
      });
      await wd("DELETE", s("/actions"));
      console.log("pressed");
      break;
    }
    case "text":
      // innerText, not WebDriver's getText: WebKitWebDriver returns "" for some buttons (the chat tabs).
      console.log(await exec("return arguments[0].innerText", [{ [ELEMENT]: await one(css, text) }]));
      break;
    case "value":
      console.log(await exec("return arguments[0].value", [{ [ELEMENT]: await one(css, text) }]));
      break;
    case "count":
      console.log((await find(css, text)).length);
      break;
    case "handles":
      console.log((await exec(HANDLES)).join("\n"));
      break;
    case "eval":
      console.log(JSON.stringify(await exec(args.join(" ")), null, 2));
      break;
    case "shot": {
      const png = await wd("GET", s("/screenshot"));
      writeFileSync(evidence(css, ".png"), Buffer.from(png, "base64"));
      console.log(evidence(css, ".png"));
      break;
    }
    case "html":
      writeFileSync(evidence(css, ".html"), await exec("return document.documentElement.outerHTML"));
      console.log(evidence(css, ".html"));
      break;
    default:
      die("usage: wd.mjs open|close|wait|gone|click|rightclick|fill|keys|text|value|count|handles|eval|shot|html (see the header)");
  }
} catch (e) {
  die(String(e.message ?? e));
}
