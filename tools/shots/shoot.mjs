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
// Subagents (ADR 0072): a reply in "NAS disk usage" that started three, one of which started one of its own, with tool
// calls heard, one finished and one failed; the running one's output and roster row are on the server.
const subagents = `(async () => {
  const { hermes: h, server: s } = window.shots;
  await h.send("nas", "Find out why the tank pool lost 400 GB overnight");
  const rt = s.runtimeIdOf("nas");
  const base = { delegation_id: "dlg-1", task_count: 3, model: "claude-sonnet-5-5" };
  // The app stamps each event with the time it heard it: the clock is set back so they read as 95 seconds of work.
  const real = Date.now.bind(Date);
  const t0 = real() - 95e3;
  let at = 0;
  Date.now = () => (at === null ? real() : t0 + at * 1000);
  const ev = (type, p, when) => { if (when !== undefined) at = when; s.event(rt, type, { ...base, ...p }); };
  s.event(rt, "message.start");
  ev("subagent.start", { subagent_id: "sa-snap", goal: "List the snapshots on tank taken in the last 48 hours and their sizes", task_index: 0, depth: 0 });
  ev("subagent.start", { subagent_id: "sa-logs", goal: "Read the syslog and the zed log for anything that wrote to tank overnight", task_index: 1, depth: 0 });
  ev("subagent.start", { subagent_id: "sa-docker", goal: "Check which Docker volumes on tank grew since yesterday", task_index: 2, depth: 0 });
  const tools = [
    ["terminal", "zfs list -t snapshot -o name,used,creation -s creation tank"],
    ["terminal", "zfs get -H -o value usedbysnapshots tank"],
    ["read_file", "/etc/sanoid/sanoid.conf"],
    ["terminal", "zfs list -t snapshot -o name,used tank/media | tail -20"],
    ["search_files", "autosnap_ in /var/log/sanoid.log"],
    ["terminal", "zfs diff tank/media@autosnap_2026-11-12_00:00:01_daily tank/media"],
  ];
  const toolAt = [3, 9, 14, 31, 47, 62];
  tools.forEach(([tool_name, tool_preview], i) => ev("subagent.tool", { subagent_id: "sa-snap", task_index: 0, depth: 0, tool_name, tool_preview, tool_count: i + 1 }, toolAt[i]));
  at = 64;
  ev("subagent.start", { subagent_id: "sa-snap-diff", parent_id: "sa-snap", goal: "Sum the files zfs diff lists under tank/media by top-level folder", task_index: 0, task_count: 1, depth: 1, delegation_id: "dlg-2" });
  ev("subagent.tool", { subagent_id: "sa-snap-diff", parent_id: "sa-snap", task_index: 0, depth: 1, tool_name: "execute_code", tool_preview: "group 18,204 paths by first component", tool_count: 1 }, 70);
  // One the first started and the owner stopped, heard of only part way through: no start event.
  const media = { subagent_id: "sa-media", parent_id: "sa-snap", goal: "Walk tank/media/incoming and list every file over 10 GB with its owner and mtime", task_index: 0, task_count: 1, depth: 1, delegation_id: "dlg-3" };
  ev("subagent.tool", { ...media, tool_name: "terminal", tool_preview: "find /tank/media/incoming -size +10G -printf '%u %TY-%Tm-%Td %s %p\\\\n' | sort -k4 -n -r | awk '{ printf \\"%s %s %.1f GB %s\\\\n\\", $1, $2, $3 / 1e9, $4 }'", tool_count: 2 }, 40);
  ev("subagent.tool", { ...media, tool_name: "terminal", tool_preview: "du -sh /tank/media/incoming/*", tool_count: 3 }, 58);
  ev("subagent.complete", { ...media, status: "interrupted", duration_seconds: 52,
    summary: "Found three files over 10 GB in /tank/media/incoming, all owned by qbittorrent and written between 02:10 and 03:40 last night (Arcane.S02.2160p.mkv 162 GB, Dune.Part.Two.2160p.mkv 118 GB, Foundation.S03.2160p.mkv 96 GB). It had not yet checked whether any of them are also held by the 11-12 daily snapshot on tank/media, which would explain why deleting them doesn't give the space back." }, 72);
  ev("subagent.tool", { subagent_id: "sa-logs", task_index: 1, depth: 0, tool_name: "terminal", tool_preview: "journalctl --since yesterday -u zfs-zed", tool_count: 1 }, 4);
  ev("subagent.tool", { subagent_id: "sa-logs", task_index: 1, depth: 0, tool_name: "read_file", tool_preview: "/var/log/syslog", tool_count: 2 }, 19);
  at = 41.2;
  ev("subagent.complete", { subagent_id: "sa-logs", task_index: 1, depth: 0, status: "completed", duration_seconds: 41.2,
    summary: "Nothing unusual in the zed log. Syslog shows qBittorrent finished three downloads into /tank/media/incoming between 02:10 and 03:40, about 380 GB in all." });
  ev("subagent.tool", { subagent_id: "sa-docker", task_index: 2, depth: 0, tool_name: "terminal", tool_preview: "docker system df -v", tool_count: 1 }, 2);
  at = 4.4;
  ev("subagent.complete", { subagent_id: "sa-docker", task_index: 2, depth: 0, status: "error", duration_seconds: 3.4,
    summary: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" });
  at = null;
  const row = (id, more) => ({ subagent_id: id, owner: rt, status: "running", accepting_steer: true, started_at: Date.now() / 1000 - 95, ...base, ...more });
  s.subagents.nas = [
    row("sa-snap", { goal: "List the snapshots on tank taken in the last 48 hours and their sizes", depth: 0, tool_count: 6, last_tool: "terminal",
      tail: "Snapshots in the last 48 h (used):\\n  tank/media@autosnap_2026-11-12_00:00:01_daily   212G\\n  tank/media@autosnap_2026-11-13_00:00:02_daily   9.4G\\n  tank/home@autosnap_2026-11-13_00:00:02_daily    1.1G\\n\\nusedbysnapshots on tank: 231G. The 11-12 daily on tank/media holds most of it.\\nRunning zfs diff against it to see what changed…" }),
    row("sa-snap-diff", { parent_id: "sa-snap", goal: "Sum the files zfs diff lists under tank/media by top-level folder", depth: 1, tool_count: 1, delegation_id: "dlg-2" }),
  ];
})()`;
const openSubagents = click(".subagents-head", "Subagents");
// A click from a script leaves the focus ring a mouse click wouldn't: the shot shows what the owner sees.
const unfocus = "document.activeElement.blur()";
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
  "subagents-list": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents] },
  "subagent-details": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), unfocus] },
  "subagent-details-failed": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Docker volumes"), unfocus] },
  "subagent-details-light": { query: "?mode=light", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), unfocus] },
  "subagent-details-small": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), unfocus] },
  "subagent-details-output": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click("[role=tab]", "Output"), unfocus] },
  "subagent-details-output-small": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click("[role=tab]", "Output"), unfocus] },
  "subagent-details-kids": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click("[role=tab]", "Subagents"), unfocus] },
  // The tab strip from the keyboard: focus on the selected tab, moved with the arrow keys.
  "subagent-details-tabkeys": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), `document.querySelector(".subagent-tab[aria-selected=true]").focus()`, { press: "ArrowRight" }] },
  // A tool line the drawer cuts short, opened in full.
  "subagent-details-whole": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Walk tank/media"), click(".subagent-act-call", "find /tank"), unfocus] },
  // Stepped from the running one to the failed one with ›: the drawer keeps the taller height, so › stays put.
  "subagent-details-step": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click("button[aria-label='Next subagent']"), click("button[aria-label='Next subagent']"), unfocus] },
  // The drawer doesn't shrink back when a tab changes inside it: Activity, then Output, then the shorter Subagents tab.
  "subagent-details-hold": {
    query: "",
    ...hd,
    steps: [
      click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"),
      `window.__h = document.querySelector(".subagents").offsetHeight`, click("[role=tab]", "Output"),
      `window.__h = Math.max(window.__h, document.querySelector(".subagents").offsetHeight)`, click("[role=tab]", "Subagents"),
      `if (document.querySelector(".subagents").offsetHeight < window.__h) throw new Error("the drawer shrank from " + window.__h + " to " + document.querySelector(".subagents").offsetHeight)`,
      unfocus,
    ],
  },
  // Opened and closed again: the line is still a button (closing it mustn't drop the focus on it).
  "subagent-details-whole-closed": {
    query: "",
    width: 1100,
    height: 760,
    steps: [
      click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Walk tank/media"), click(".subagent-act-call", "find /tank"),
      click(".subagent-act-call", "find /tank"),
      `(() => { const b = [...document.querySelectorAll(".subagent-act-call")].find((e) => e.textContent.includes("find /tank"));
         if (b.disabled || b.getAttribute("aria-expanded") !== "false") throw new Error("closed line: disabled " + b.disabled + ", expanded " + b.getAttribute("aria-expanded")); })()`,
      unfocus,
    ],
  },
  "subagent-details-confirm": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click(".subagent-stop", "Stop")] },
  "subagent-details-confirm-small": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "List the snapshots"), click(".subagent-stop", "Stop")] },
  "subagent-details-done": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Read the syslog"), unfocus] },
  "subagent-details-stopped": { query: "", ...hd, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Walk tank/media"), unfocus] },
  "subagent-details-stopped-small": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Walk tank/media"), unfocus] },
  "subagent-details-failed-small": { query: "", width: 1100, height: 760, steps: [click("button", "NAS disk usage"), subagents, openSubagents, click(".subagent-row", "Docker volumes"), unfocus] },
  "automation-history-light": { query: "?mode=light", height: 1400, steps: [click("button[aria-label='Automations']"), click("button", "triage-issues"), scrollTo(".delivery-list")] },
};
// Every Settings tab at 1920 × 1080 (#568): `settings-tab-<id>`, for a redesign's before and after.
for (const [id, label] of Object.entries({ general: "General", appearance: "Appearance", keyboard: "Keyboard Shortcuts", snapshots: "Snapshots", model: "Model", providers: "Providers", voice: "Voice", toolsets: "Toolsets", mcp: "MCP servers", gateways: "Gateways", profiles: "Profiles", persona: "Persona", memory: "Memory", skills: "Skills", extensions: "Extensions", diagnostics: "Diagnostics" }))
  scenes[`settings-tab-${id}`] = { query: "?profiles=1", ...hd, steps: [openSettings, click("[role=tab]", label)] };
// The sections a page shows one at a time, picked under it in the sidebar's tree (ADR 0160), and its narrow forms.
const tab = (label) => click("[role=tab]", label);
const sub = (label) => click(".settings-sub", label);
const narrow = { width: 760, height: 600 };
Object.assign(scenes, {
  "settings-general-chats": { query: "?profiles=1", ...hd, steps: [openSettings, sub("Chats")] },
  "settings-general-launch": { query: "?profiles=1", ...hd, steps: [openSettings, sub("Launch")] },
  "settings-general-screenshots": { query: "?profiles=1", ...hd, steps: [openSettings, sub("Screenshots")] },
  "settings-general-storage": { query: "?profiles=1", ...hd, steps: [openSettings, sub("Storage")] },
  "settings-memory-user": { query: "?profiles=1", ...hd, steps: [openSettings, tab("Memory"), sub("User profile")] },
  "settings-memory-external": { query: "?profiles=1", ...hd, steps: [openSettings, tab("Memory"), sub("External memory")] },
  "settings-gateways-discord": { query: "?profiles=1", ...hd, steps: [openSettings, tab("Gateways"), sub("Discord")] },
  "settings-diagnostics-logs": { query: "?profiles=1", ...hd, steps: [openSettings, tab("Diagnostics"), sub("Logs")] },
  "settings-model-subagents": { query: "?profiles=1", ...hd, steps: [openSettings, tab("Model"), sub("Subagents")] },
  "settings-search-cache": { query: "?profiles=1", ...hd, steps: [openSettings, typeSearch("cache")] },
  "settings-search-reasoning": { query: "?profiles=1", ...hd, steps: [openSettings, typeSearch("reasoning effort")] },
  "settings-narrow-general": { query: "?profiles=1", ...narrow, steps: [openSettings] },
  "settings-narrow-model": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-crumb"), tab("Model")] },
  "settings-narrow-memory": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-crumb"), tab("Memory")] },
  "settings-narrow-keyboard": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-crumb"), tab("Keyboard")] },
  "settings-narrow-skills": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-crumb"), tab("Skills")] },
  "settings-narrow-sheet": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-crumb"), tab("Model"), click(".settings-crumb")] },
  "settings-narrow-search": { query: "?profiles=1", ...narrow, steps: [openSettings, click(".settings-bar-search"), typeSearch("reasoning effort")] },
});
// Workstream B of the improvement report, at 1280 × 800: the rail, Diagnostics' two write-checked rows, and Skills rows
// with long descriptions and a name line full of badges.
const wsb = { width: 1280, height: 800 };
const longSkills = `(() => {
  const s = window.shots.server.skills;
  const md = (name, description) => "---\\nname: " + name + "\\ndescription: " + description + "\\n---\\n\\nThe " + name + " skill's instructions.\\n";
  s.add("default", { dir: "/home/liam/.hermes/skills/ops/zfs-scrub-and-snapshot-review", source: "hub", category: "home-lab-operations-storage-backups-and-snapshot-retention-weekly" },
    md("zfs-scrub-and-snapshot-review", "Run a scrub on every pool, read the result, then list the snapshots older than the retention policy and say which ones are safe to destroy before anything is deleted, with the space each would free."));
  s.platformDisabled.default = { tui: ["notes", "zfs-scrub-and-snapshot-review"] };
  s.add("default", { dir: "/home/liam/.hermes/skills/code-review", source: "bundled" },
    md("code-review", "Review a diff for correctness first, then for tests that prove the change, then for names and structure; quote the line, say what breaks, and suggest the smallest fix that keeps the behaviour the author meant. Check error paths, concurrency and anything that writes, and say plainly when a change is fine as it is."));
})()`;
Object.assign(scenes, {
  "wsb-rail": { query: "", ...wsb, steps: [] },
  "wsb-diagnostics": { query: "", ...wsb, steps: [openSettings, tab("Diagnostics"), `new Promise((r) => setTimeout(r, 3000))`, scrollTo("#capability-approvalAnswers")] },
  "wsb-skills": { query: "", ...wsb, steps: [longSkills, openSettings, tab("Skills")] },
  "wsb-skills-focus": {
    query: "",
    ...wsb,
    steps: [longSkills, openSettings, tab("Skills"), `document.getElementById("skill-code-review-edit").focus()`, { press: "Tab" }, `document.getElementById("skill-code-review-edit").scrollIntoView({ block: "center" })`],
  },
  // Pass 2: Settings → General → Chats, where Check spelling is (#578).
  "wsb-settings-chats": {
    query: "",
    ...wsb,
    steps: [openSettings, sub("Chats"), unfocus, `[...document.querySelectorAll("section")].find((s) => s.textContent.startsWith("Sending while Hermes replies")).scrollIntoView({ block: "start" })`],
  },
});
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
    // A headless page has no focus of its own, so a real key press would go nowhere.
    if (scene.steps.some((step) => typeof step === "object")) await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    for (const step of scene.steps) {
      // `{ press }`: a real key press from the browser, which `:focus-visible` and the app's key handlers both see.
      if (typeof step === "object") {
        const [code, keyCode] = { Tab: ["Tab", 9], ArrowRight: ["ArrowRight", 39], ArrowLeft: ["ArrowLeft", 37], Escape: ["Escape", 27] }[step.press];
        for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: step.press, code, windowsVirtualKeyCode: keyCode });
      } else await evaluate(step);
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
