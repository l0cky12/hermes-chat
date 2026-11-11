#!/usr/bin/env node
// Checks the transcript window (ADR 0138) in the real app on the bench's long chat, with real input: it opens at the
// bottom with few messages in the page; wheel steps of 150 and 400 px up move what is in view exactly that far down the
// screen, as chunks come and go and the transcript corrects its scroll position for them (#418); find counts its
// matches; the view holds still while a reply streams below it, and follows the reply again once scrolled back to the
// bottom. Starts its own `hv up` (stand-in with HV_TURNS and HV_LONG_REPLY) and signs in, so it needs only `hv build`
// first. Prints one JSON line of results; exits 1 on a failed check.
//   node bench/app-split/window.mjs [turns]
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const S = join(execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), ".claude/skills/verify-hermes-chat/scripts");
const turns = process.argv[2] ?? "1000";
const up = execFileSync(join(S, "hv"), ["up"], { encoding: "utf8", env: { ...process.env, HV_TURNS: turns, HV_LONG_REPLY: "400" }, stdio: ["ignore", "pipe", "pipe"] });
const env = { ...process.env, HV_RUN: up.match(/^export HV_RUN=(.*)$/m)[1] };
const wd = (...args) => execFileSync(join(S, "wd.mjs"), args, { encoding: "utf8", env }).trim();
const js = (body) => JSON.parse(wd("eval", body));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { turns: Number(turns), checks: {} };
const check = (name, ok, detail) => {
  results.checks[name] = { ok, ...detail };
  if (!ok) results.failed = true;
};
// The first message in view, where it is on screen, and the transcript's scroll state.
const VIEW = `const t = document.querySelector(".transcript"); const box = t.getBoundingClientRect();
  const ref = [...t.querySelectorAll(".msg[data-item]")].find((m) => m.getBoundingClientRect().bottom > box.top);
  return { scrollTop: t.scrollTop, bottomGap: t.scrollHeight - t.scrollTop - t.clientHeight, msgs: t.querySelectorAll(".msg").length,
    gaps: t.querySelectorAll(".transcript-gap").length, ref: ref?.dataset.item, refTop: ref && ref.getBoundingClientRect().top };`;
const topOf = (id) => js(`const m = document.querySelector('.transcript [data-item="${id}"]'); return m ? m.getBoundingClientRect().top : null;`);
const replyLength = () => js(`return document.querySelector(".transcript .msg.assistant:last-of-type")?.innerText.length ?? 0;`);

try {
  execFileSync(join(here, "../clone-profile/signin.sh"), { env, stdio: "ignore" });
  wd("click", ".row-open[data-chat=long1]");
  wd("wait", ".msg.assistant", "", "120000");
  await sleep(2000);
  const opened = js(VIEW);
  check("opens at the bottom, windowed", opened.bottomGap < 2 && opened.msgs < 300 && opened.gaps >= 1, opened);
  wd("shot", "window-01-open");

  for (const dy of [150, 400]) {
    const steps = [];
    for (let i = 0; i < (dy === 150 ? 40 : 25); i++) {
      const before = js(VIEW);
      wd("wheel", ".transcript", "--", String(-dy));
      await sleep(250);
      const after = js(VIEW);
      const refTop = topOf(before.ref);
      steps.push({ moved: refTop === null ? null : Math.round(refTop - before.refTop), scrollTop: Math.round(before.scrollTop - after.scrollTop), msgs: after.msgs });
    }
    // A correction for a chunk's estimated height can land half a pixel off.
    const wrong = steps.filter((s) => s.moved === null || Math.abs(s.moved - dy) > 1);
    check(`wheel ${dy}`, wrong.length === 0, { steps: steps.length, windowChanges: new Set(steps.map((s) => s.msgs)).size, wrong: wrong.slice(0, 5) });
  }
  wd("shot", "window-02-scrolled-up");

  wd("press", "Control+f");
  wd("keys", "const");
  for (let i = 0; i < 120 && !/^[1-9]/.test(wd("text", ".find-count")); i++) await sleep(500);
  results.find = wd("text", ".find-count");
  check("find counts", /^\d+ of \d+$/.test(results.find), { count: results.find });
  wd("shot", "window-03-find");
  wd("press", "Escape");
  wd("gone", ".find", "", "30000");
  for (let i = 0; i < 60 && js(VIEW).msgs > 300; i++) await sleep(500);
  await sleep(1000);

  wd("gone", ".toast", "", "30000");
  wd("click", "textarea[data-composer]");
  wd("keys", "long reply for the window check\\n"); // wd.mjs presses Enter for a backslash and n
  wd("wait", ".msg.user", "long reply for the window check", "60000");
  for (let i = 0; i < 120 && replyLength() < 400; i++) await sleep(500);
  for (let i = 0; i < 3; i++) {
    wd("wheel", ".transcript", "--", "-400");
    await sleep(250);
  }
  await sleep(500);
  const held = js(VIEW);
  const grewFrom = replyLength();
  await sleep(4000);
  const heldTop = topOf(held.ref);
  check("holds still while a reply streams below", heldTop === held.refTop && replyLength() > grewFrom, { ref: held.ref, before: held.refTop, after: heldTop });
  wd("shot", "window-04-held");

  for (let i = 0; i < 40 && js(VIEW).bottomGap > 2; i++) {
    wd("wheel", ".transcript", "--", "2000");
    await sleep(200);
  }
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    samples.push(js(VIEW).bottomGap);
  }
  check("follows the reply at the bottom", samples.every((g) => g < 2), { bottomGaps: samples.map(Math.round) });
  wd("shot", "window-05-following");
} finally {
  console.log(JSON.stringify(results));
  try {
    execFileSync(join(S, "hv"), ["down"], { env, stdio: "ignore" });
  } catch {}
}
process.exit(results.failed ? 1 : 0);
