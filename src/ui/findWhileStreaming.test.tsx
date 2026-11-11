// @vitest-environment jsdom
// Find in chat on React's own scheduler, as the app runs it, with a reply streaming in. Testing Library's act()
// finishes background renders at once, which hides how a background render behaves when every delta interrupts it.
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ChatPane } from "./ChatPane";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnv: boolean | undefined;
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

let root: Root;
let host: HTMLElement;
let streaming: ReturnType<typeof setInterval> | undefined;
beforeEach(() => {
  actEnv = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  clearInterval(streaming);
  root.unmount();
  host.remove();
  current = undefined!;
  env.IS_REACT_ACT_ENVIRONMENT = actEnv;
});

/** 120 turns, each reply naming the lock once, and a reply still streaming at the end. */
const history: Item[] = Array.from({ length: 120 }, (_, i): Item[] => [
  { kind: "user", id: `u-${i}`, text: `Question ${i}?` },
  { kind: "assistant", id: `a-${i}`, text: `Turn ${i}: the **lock** in \`/var/lib/${i}\` is stale, so remove it and run the backup again.` },
]).flat();
const chatOf = (reply: string): Chat => ({
  id: "c",
  runtimeId: "rt",
  title: "Long",
  source: "app",
  settled: false,
  running: true,
  updatedAt: 0,
  items: [...history, { kind: "assistant", id: "live", text: reply }],
});

/** The chat as App keeps it: in a store the pane reads with useSyncExternalStore, so each change renders at once. */
let current: Chat;
const listeners = new Set<() => void>();
const store = {
  subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
  get: () => current,
};
function Pane() {
  const chat = useSyncExternalStore(store.subscribe, store.get);
  return (
    <ChatPane
      chat={chat}
      status="connected"
      draft=""
      draftKey="draft"
      screenshots={new ScreenshotDesk(noScreenshots)}
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
  );
}
function show(chat: Chat) {
  const first = !current;
  current = chat;
  if (first) root.render(<Pane />);
  else for (const fn of listeners) fn();
}

/** A delta every few milliseconds, as Hermes streams them; none of them names the lock. */
function stream() {
  let reply = "Working";
  streaming = setInterval(() => show(chatOf((reply += " on it"))), 2);
}

const until = async (done: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
  return done();
};
const count = () => host.querySelector(".find-count")?.textContent;
const marks = () => host.querySelectorAll("mark.hit").length;
const input = () => host.querySelector<HTMLInputElement>(".find input")!;
function type(value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
/** React renders a click or key press in a microtask after it, still in the same task, before anything is painted. */
const rendered = () => new Promise<void>((r) => queueMicrotask(r));
async function openFind() {
  host.querySelector<HTMLButtonElement>('button[aria-label="Find in chat"]')!.click();
  await rendered();
}
async function escape() {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await rendered();
}

it("counts and marks a query while every delta of a streaming reply renders the pane (#435)", async () => {
  show(chatOf("Working"));
  expect(await until(() => !!host.querySelector('[data-item="live"]'), 5000)).toBe(true);
  stream();
  await openFind();
  type("lock");
  expect(await until(() => count() === "1 of 120", 15_000)).toBe(true);
  expect(marks()).toBe(120);
}, 20_000);

it("clears the marks as find closes, though a reply is streaming (#435)", async () => {
  show(chatOf("Working"));
  expect(await until(() => !!host.querySelector('[data-item="live"]'), 5000)).toBe(true);
  await openFind();
  type("lock");
  expect(await until(() => count() === "1 of 120", 15_000)).toBe(true);
  stream();
  await escape();
  expect(host.querySelector(".find")).toBeNull();
  expect(marks()).toBe(0);
}, 20_000);

it("says it is still finding, not 0 of 0, when find opens again on its last query, then counts it (#434)", async () => {
  show(chatOf("Working"));
  expect(await until(() => !!host.querySelector('[data-item="live"]'), 5000)).toBe(true);
  await openFind();
  type("lock");
  expect(await until(() => count() === "1 of 120", 15_000)).toBe(true);
  await escape();
  expect(await until(() => marks() === 0, 15_000)).toBe(true);
  stream();
  await openFind();
  expect(input().value).toBe("lock");
  expect(count()).not.toBe("0 of 0");
  expect(await until(() => count() === "1 of 120", 15_000)).toBe(true);
  expect(marks()).toBe(120);
}, 20_000);
