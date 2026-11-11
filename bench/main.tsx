// Renders the real ChatPane with a synthetic chat and times opening, streaming, find-in-chat and scrolling.
// `run.mjs` drives it in headless Chromium; `window.bench` can also be called by hand from devtools.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { X } from "lucide-react";
import "../src/styles.css";
import type { Chat, Item } from "../src/hermes/model";
import { ChatPane } from "../src/ui/ChatPane";
import { Split } from "../src/ui/Split";
import { PaneDrop, TabStrip } from "../src/ui/Tabs";
import { codeReply, makeChat, makeReply } from "./fixture";
import { REPLIES, hostile } from "./hostile";

const root = createRoot(document.getElementById("root")!);
let setChat: (c: Chat) => void = () => {};

function Host({ initial }: { initial: Chat }) {
  const [chat, set] = useState(initial);
  setChat = set;
  return (
    <div className="app">
      <main className="main">
        <ChatPane
          chat={chat}
          status="connected"
          draft=""
          onDraft={() => {}}
          onDraftStep={() => undefined}
          onRetry={() => {}}
          onEdit={() => {}}
          onDismiss={() => {}}
          onAttach={async () => ({ attachments: [], refused: [] })}
          onSend={() => {}}
          onStop={() => {}}
          onAnswer={() => {}}
        />
      </main>
    </div>
  );
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const painted = async () => {
  await frame();
  await frame();
  return performance.now();
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r1(q(0.5)), p95: r1(q(0.95)), max: r1(s[s.length - 1]), total: Math.round(s.reduce((a, b) => a + b, 0)) };
};
const transcript = () => document.querySelector<HTMLElement>(".transcript")!;

let current: Chat;
// A fresh key each open, so a chat opened twice mounts afresh, as App remounts ChatPane for each chat.
let opened = 0;

/** Opens a chat of `turns` turns. `commitMs`: render, commit and the layout it forces; `paintMs`: until painted. */
async function open(turns: number) {
  root.render(<></>);
  await painted();
  current = makeChat(turns);
  const t0 = performance.now();
  flushSync(() => root.render(<Host key={++opened} initial={current} />));
  const t1 = performance.now();
  const t2 = await painted();
  return { turns, items: current.items.length, chars: current.items.reduce((n, i) => n + ("text" in i ? i.text.length : 0), 0), nodes: document.getElementsByTagName("*").length, commitMs: Math.round(t1 - t0), paintMs: Math.round(t2 - t0) };
}

/**
 * Streams a reply into the open chat the way Hermes does: a user message, then `message.delta`s of a few characters,
 * one per frame, each a new Chat as `applyEvent` makes it. `updateMs`: each delta's render, commit and forced layout.
 */
async function stream(chunk = 4) {
  const reply = makeReply();
  let items: Item[] = [...current.items, { kind: "user", id: "u-live", text: "Stream something." }];
  flushSync(() => setChat({ ...current, items, running: true }));
  await painted();
  const update: number[] = [];
  const frames: number[] = [];
  let last = performance.now();
  for (let i = 0; i < reply.length; i += chunk) {
    const prev = items[items.length - 1];
    const text = reply.slice(i, i + chunk);
    items = [...items];
    if (prev.kind === "assistant") items[items.length - 1] = { ...prev, text: prev.text + text };
    else items.push({ kind: "assistant", id: "a-live", text });
    const t0 = performance.now();
    flushSync(() => setChat({ ...current, items, running: true }));
    update.push(performance.now() - t0);
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  const bottom = transcript().scrollHeight - transcript().scrollTop - transcript().clientHeight;
  flushSync(() => setChat({ ...current, items, running: false }));
  await painted();
  return { deltas: update.length, updateMs: stats(update), frameMs: stats(frames), stuckToBottom: bottom < 2 };
}

/**
 * Streams the reply #224 measured into a short chat: a sentence and a 40-line code block, `blocks` times, tagged `ts`
 * or untagged, `chunk` characters a delta and one delta a frame. `frameMs`: frame to frame, so what the owner sees;
 * `lastMs`: the mean update of the last 20 deltas, when the reply is longest.
 */
async function streamCode(blocks: number, tagged: boolean, chunk = 12) {
  return { blocks, tagged, ...(await streamReply((salt) => codeReply(blocks, tagged, salt), chunk)) };
}

/** Streams the reply `make` returns into a short chat, `chunk` characters a delta and one delta a frame. */
async function streamReply(make: (salt: string) => string, chunk: number) {
  root.render(<></>);
  await painted();
  current = makeChat(4);
  flushSync(() => root.render(<Host key={++opened} initial={current} />));
  await painted();
  const reply = make(String(opened));
  const before: Item[] = [...current.items, { kind: "user", id: "u-live", text: "Stream something." }];
  flushSync(() => setChat({ ...current, items: before, running: true }));
  await painted();
  const update: number[] = [];
  const frames: number[] = [];
  let last = performance.now();
  for (let i = chunk; i < reply.length + chunk; i += chunk) {
    const items: Item[] = [...before, { kind: "assistant", id: "a-live", text: reply.slice(0, i) }];
    const t0 = performance.now();
    flushSync(() => setChat({ ...current, items, running: true }));
    update.push(performance.now() - t0);
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  const t0 = performance.now();
  flushSync(() => setChat({ ...current, items: [...before, { kind: "assistant", id: "a-live", text: reply }], running: false }));
  const endMs = Math.round(performance.now() - t0);
  await painted();
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const tail = update.slice(-20);
  return {
    deltas: update.length,
    updateMs: stats(update),
    lastMs: r1(tail.reduce((a, b) => a + b, 0) / tail.length),
    frameMs: stats(frames),
    over16ms: frames.filter((f) => f > 17).length,
    endMs,
    highlighted: document.querySelectorAll(`[data-item="a-live"] pre code:has([class^="hljs-"])`).length,
  };
}

/** Opens a short chat whose last reply is hostile reply `name` (hostile.ts) at size `n`. `commitMs` as in `open`. */
async function hostileOpen(name: string, n: number) {
  root.render(<></>);
  await painted();
  current = makeChat(4);
  current = { ...current, items: [...current.items, { kind: "assistant", id: "a-hostile", text: REPLIES[name](n) }] };
  const t0 = performance.now();
  flushSync(() => root.render(<Host key={++opened} initial={current} />));
  const t1 = performance.now();
  const t2 = await painted();
  return { name, n, commitMs: Math.round(t1 - t0), paintMs: Math.round(t2 - t0) };
}

/** Streams hostile reply `name` at size `n`, as `streamCode` streams code. */
async function hostileStream(name: string, n: number, chunk = 12) {
  return { name, n, ...(await streamReply(() => REPLIES[name](n), chunk)) };
}

/**
 * Types `query` into the find bar a key every 150 ms. `keyMs`: from each keystroke to the next frame, so how long typing
 * is held up. `resultsMs`: from the last keystroke until its marks and count are on screen. Then steps to the next match.
 */
async function find(query: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
  await painted();
  const input = document.querySelector<HTMLInputElement>(".find input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const keyMs: number[] = [];
  let t0 = 0;
  for (let i = 1; i <= query.length; i++) {
    t0 = performance.now();
    setValue.call(input, query.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    keyMs.push(Math.round((await frame()) - t0));
    if (i < query.length) while (performance.now() - t0 < 150) await frame();
  }
  const shown = () => {
    const marks = [...document.querySelectorAll(".transcript mark.hit")];
    return marks.length > 0 && marks.every((m) => m.textContent!.toLowerCase() === query) && document.querySelector(".find-count")!.textContent!.endsWith(`of ${marks.length}`);
  };
  while (!shown() && performance.now() - t0 < 30_000) await frame();
  const resultsMs = Math.round(performance.now() - t0);
  const count = document.querySelector(".find-count")!.textContent;
  const t2 = performance.now();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await painted();
  const stepMs = Math.round(performance.now() - t2);
  const after = document.querySelector(".find-count")!.textContent;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await painted();
  return { query, count, after, keyMs, resultsMs, stepMs };
}

/** Scrolls from the top to the bottom, `px` per frame, up to 400 frames. */
async function scroll(px = 120) {
  const el = transcript();
  el.scrollTop = 0;
  await painted();
  const frames: number[] = [];
  let last = performance.now();
  for (let i = 0; i < 400 && el.scrollTop + el.clientHeight < el.scrollHeight - 1; i++) {
    el.scrollTop += px;
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  el.scrollTop = el.scrollHeight;
  return { frameMs: stats(frames), over20ms: frames.filter((f) => f > 20).length };
}

let setPair: (p: [Chat, Chat]) => void = () => {};
let pair: [Chat, Chat];

function SplitHost({ initial }: { initial: [Chat, Chat] }) {
  const [chats, set] = useState(initial);
  setPair = set;
  const pane = (chat: Chat, active: boolean) => (
    <>
      <TabStrip
        pane={chat.id}
        tabs={[{ id: chat.id, title: chat.title, running: chat.running }]}
        current={chat.id}
        onPick={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        preview={() => null}
        onDropChat={() => {}}
        menu={() => []}
        lastClosable
        controls={
          <button className="icon-btn" aria-label="Close the pane">
            <X size={16} />
          </button>
        }
      />
      <PaneDrop preview={() => null} onDropChat={() => {}}>
        <ChatPane
          key={chat.id}
          chat={chat}
          status="connected"
          draft=""
          onDraft={() => {}}
          onDraftStep={() => undefined}
          onRetry={() => {}}
          onEdit={() => {}}
          onDismiss={() => {}}
          onAttach={async () => ({ attachments: [], refused: [] })}
          onSend={() => {}}
          onStop={() => {}}
          onAnswer={() => {}}
          active={active}
          split
        />
      </PaneDrop>
    </>
  );
  return (
    <div className="app">
      <main className="main">
        <div className="main-chat">
          <Split
            activeKey="b"
            onActivate={() => {}}
            panes={[
              { key: "a", title: chats[0].title, node: pane(chats[0], false) },
              { key: "b", title: chats[1].title, node: pane(chats[1], true) },
            ]}
          />
        </div>
      </main>
    </div>
  );
}

/** Opens two chats of `turns` turns side by side. */
async function splitOpen(turns: number) {
  root.render(<></>);
  await painted();
  pair = [{ ...makeChat(turns, 1), id: "left" }, { ...makeChat(turns, 2), id: "right" }];
  const t0 = performance.now();
  flushSync(() => root.render(<SplitHost key={++opened} initial={pair} />));
  const t1 = performance.now();
  const t2 = await painted();
  return { turns, panes: 2, nodes: document.getElementsByTagName("*").length, commitMs: Math.round(t1 - t0), paintMs: Math.round(t2 - t0) };
}

/**
 * Streams a reply into both panes at once, as two replies running together: each frame one delta lands in each chat,
 * and both are committed together. `updateMs`: each frame's render, commit and forced layout.
 */
async function splitStream(chunk = 4) {
  const reply = makeReply();
  const items: [Item[], Item[]] = [
    [...pair[0].items, { kind: "user", id: "u-live", text: "Stream something." }],
    [...pair[1].items, { kind: "user", id: "u-live", text: "Stream something too." }],
  ];
  let chats: [Chat, Chat] = [
    { ...pair[0], items: items[0], running: true },
    { ...pair[1], items: items[1], running: true },
  ];
  flushSync(() => setPair(chats));
  await painted();
  const update: number[] = [];
  const frames: number[] = [];
  let last = performance.now();
  for (let i = 0; i < reply.length; i += chunk) {
    const text = reply.slice(i, i + chunk);
    chats = chats.map((chat) => {
      const list = [...chat.items];
      const prev = list[list.length - 1];
      if (prev.kind === "assistant") list[list.length - 1] = { ...prev, text: prev.text + text };
      else list.push({ kind: "assistant", id: "a-live", text });
      return { ...chat, items: list };
    }) as [Chat, Chat];
    const t0 = performance.now();
    flushSync(() => setPair(chats));
    update.push(performance.now() - t0);
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  const bottoms = [...document.querySelectorAll<HTMLElement>(".transcript")].map((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 2);
  flushSync(() => setPair([{ ...chats[0], running: false }, { ...chats[1], running: false }]));
  await painted();
  return { deltas: update.length, updateMs: stats(update), frameMs: stats(frames), stuckToBottom: bottoms };
}

/** Moves the divider by keyboard, 5% a step, 12 steps there and back, timing each step until painted. */
async function splitResize() {
  const divider = document.querySelector<HTMLElement>(".divider")!;
  divider.focus();
  const steps: number[] = [];
  for (const key of [...Array(6).fill("ArrowRight"), ...Array(12).fill("ArrowLeft"), ...Array(6).fill("ArrowRight")]) {
    const t0 = performance.now();
    flushSync(() => divider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    steps.push((await painted()) - t0);
  }
  const bottoms = [...document.querySelectorAll<HTMLElement>(".transcript")].map((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 2);
  return { stepMs: stats(steps), stuckToBottom: bottoms };
}

/** Records frame times while `run.mjs` drags the divider with real pointer input, and whether the guide line showed. */
const dragWatch = {
  frames: [] as number[],
  ghost: false,
  running: false,
  start() {
    this.frames = [];
    this.ghost = false;
    this.running = true;
    let last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.frames.push(now - last);
      last = now;
      this.ghost ||= !!document.querySelector(".divider-ghost");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const r = document.querySelector(".divider")!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: document.querySelector(".panes-row")!.getBoundingClientRect().width };
  },
  async stop() {
    await painted();
    this.running = false;
    const bottoms = [...document.querySelectorAll<HTMLElement>(".transcript")].map((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 2);
    return {
      frameMs: stats(this.frames),
      over50ms: this.frames.filter((f) => f > 50).length,
      guideLine: this.ghost,
      ratio: document.querySelector(".divider")!.getAttribute("aria-valuenow"),
      stuckToBottom: bottoms,
    };
  },
};

Object.assign(window, { bench: { open, stream, streamCode, hostile, hostileOpen, hostileStream, find, scroll, splitOpen, splitStream, splitResize, dragWatch } });
