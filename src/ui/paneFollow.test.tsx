// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ChatPane } from "./ChatPane";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

let VIEW = 600;
let width = 800;
let content = 5000;

const observers = new Set<{ run: () => void }>();
const runResizeObservers = () => act(() => observers.forEach((o) => o.run()));
const realObserver = globalThis.ResizeObserver;
// As in a browser, a scroller whose view moved gets one scroll event, at the next frame.
const moved = new Set<HTMLElement>();
const frame = () => {
  const els = [...moved];
  moved.clear();
  els.forEach((el) => fireEvent.scroll(el));
};

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
      set(this: HTMLElement, y: number) {
        const top = Math.max(0, Math.min(y, content - VIEW));
        if (top === (scrollTops.get(this) ?? 0)) return;
        scrollTops.set(this, top);
        moved.add(this);
      },
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
  moved.clear();
  VIEW = 600;
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
  frame();
  return {
    scroller,
    frame,
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

it("stops following when the owner turns the wheel up while a reply streams, though each scroll lands within 40 px of the bottom", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  // WebKit's smooth scroll moves the view a few pixels a frame, and the reply grows between frames (#544).
  fireEvent.wheel(scroller, { deltaY: -87 });
  for (const step of [3, 1, 32, 20]) {
    scroller.scrollTop -= step;
    frame();
    grow(5);
  }
  expect(fromBottom()).toBe(76);

  grow(300);
  expect(fromBottom()).toBe(376);
});

it("keeps following when the reply gets shorter and the browser pulls the view up to the new bottom", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  content -= 200;
  scroller.scrollTop = content - VIEW;
  frame();
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stops following on the wheel itself, before the view has moved and while the last pin's scroll event is pending", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.wheel(scroller, { deltaY: -87 });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following after a wheel up over a transcript too short to scroll", () => {
  content = 500;
  const { scroller, fromBottom, grow } = pane(1);

  fireEvent.wheel(scroller, { deltaY: -87 });
  grow(4500);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up after the owner clicked in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.pointerDown(scroller);
  fireEvent.keyDown(document.body, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following on a key that scrolls up after the owner clicked somewhere else", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  fireEvent.pointerDown(scroller);
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up from a button in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.keyDown(scroller.querySelector("button")!, { key: "ArrowUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following when the wheel turns up over a box in the transcript that scrolls up itself", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);
  const box = document.createElement("pre");
  scroller.querySelector(".msg.assistant")!.append(box);
  Object.defineProperty(box, "scrollTop", { configurable: true, value: 120 });

  fireEvent.wheel(box, { deltaY: -87 });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following when the first frame of a wheel scroll moves the view up less than a pixel", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  fireEvent.wheel(scroller, { deltaY: -87 });
  scroller.scrollTop -= 0.5;
  frame();
  grow(5);
  expect(fromBottom()).toBe(5.5);
});

it("follows again when the view grows taller and lands at the bottom, after the ResizeObserver has run", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  scroller.scrollTop = content - VIEW - 100;
  frame();
  VIEW += 200;
  scroller.scrollTop = content - VIEW;
  runResizeObservers();
  frame();
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("keeps following when Shift turns the wheel sideways", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.wheel(scroller, { deltaY: -87, shiftKey: true });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up from a checkbox in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);
  const box = document.createElement("input");
  box.type = "checkbox";
  scroller.querySelector(".msg.assistant")!.append(box);

  grow(5);
  fireEvent.keyDown(box, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});
