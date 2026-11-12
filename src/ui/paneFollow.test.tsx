// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ChatPane } from "./ChatPane";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const VIEW = 600;
let width = 800;
let content = 5000;

const observers = new Set<{ run: () => void }>();
const runResizeObservers = () => act(() => observers.forEach((o) => o.run()));
const realObserver = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  const scrollTops = new WeakMap<Element, number>();
  const isScroller = (el: Element) => el.classList.contains("transcript");
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? VIEW : 0; } },
    clientWidth: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? width : 0; } },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? content : 0; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, y: number) { scrollTops.set(this, Math.max(0, Math.min(y, content - VIEW))); },
    },
  });
  globalThis.ResizeObserver = class {
    private entry: { run: () => void };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { run: () => cb([], this as unknown as ResizeObserver) };
    }
    observe() { observers.add(this.entry); }
    unobserve() {}
    disconnect() { observers.delete(this.entry); }
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  globalThis.ResizeObserver = realObserver;
});
beforeEach(() => {
  width = 800;
  content = 5000;
});
afterEach(cleanup);

function chat(turns: number): Chat {
  const items: Item[] = [];
  for (let t = 0; t < turns; t++)
    items.push({ kind: "user", id: `u-${t}`, text: `Question ${t}`, rowId: 2 * t }, { kind: "assistant", id: `a-${t}`, text: `Answer ${t}`, rowId: 2 * t + 1 });
  return { id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, running: true };
}

function pane(turns: number) {
  const view = (turns: number) => (
    <ChatPane
      chat={chat(turns)}
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
      onQuestion={() => {}}
    />
  );
  const { rerender } = render(view(turns));
  runResizeObservers();
  const scroller = document.querySelector<HTMLElement>(".transcript")!;
  return {
    scroller,
    fromBottom: () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    grow: (px: number) => {
      content += px;
      rerender(view(++turns));
      runResizeObservers();
    },
  };
}

it("stays at the bottom, following the reply, when the browser moves the view as the pane widens", () => {
  const { scroller, fromBottom, grow } = pane(10);
  expect(fromBottom()).toBe(0);

  // WebKitGTK rewraps the wider pane and leaves the view 497 px above the bottom. Its scroll event comes before the
  // ResizeObserver runs for the new size, and no input from the owner caused it.
  width = 1200;
  content = 4200;
  scroller.scrollTop = content - VIEW - 497;
  fireEvent.scroll(scroller);
  runResizeObservers();
  expect(fromBottom()).toBe(0);

  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stops following when the owner scrolls up, and follows again once they are back at the bottom", () => {
  const { scroller, fromBottom, grow } = pane(10);

  scroller.scrollTop = content - VIEW - 500;
  fireEvent.scroll(scroller);
  grow(300);
  expect(fromBottom()).toBe(800);

  scroller.scrollTop = content;
  fireEvent.scroll(scroller);
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stays where the owner scrolled to when the pane is resized after", () => {
  const { scroller, fromBottom } = pane(10);

  scroller.scrollTop = content - VIEW - 500;
  fireEvent.scroll(scroller);
  width = 1200;
  content = 4200;
  scroller.scrollTop = content - VIEW - 497;
  fireEvent.scroll(scroller);
  runResizeObservers();
  expect(fromBottom()).toBe(497);
});
