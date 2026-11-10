// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorScroll } from "./scrollAnchor";

// jsdom has no layout: each block gets a top and height here, and `resize` delivers what a ResizeObserver would.
let observers: { cb: ResizeObserverCallback; watched: Set<Element> }[] = [];
class FakeResizeObserver {
  watched = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    observers.push({ cb, watched: this.watched });
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
}
const resize = (els: Element[]) => {
  for (const o of observers) {
    const hit = els.filter((el) => o.watched.has(el));
    if (hit.length) o.cb(hit.map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
  }
};
const box = (el: Element, top: number, height: number) => {
  el.getBoundingClientRect = () => ({ top, height, bottom: top + height }) as DOMRect;
};

/** A scroller whose view starts at 100, with blocks laid out from `tops` and `heights`, all seen once. */
function transcript(heights: number[], scrollTop = 1000) {
  const scroller = document.createElement("div");
  const list = scroller.appendChild(document.createElement("div"));
  const blocks = heights.map(() => list.appendChild(document.createElement("div")));
  Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
  box(scroller, 100, 600);
  scroller.scrollTop = scrollTop;
  const lay = (hs: number[]) => {
    let y = 100 - scrollTop;
    blocks.forEach((b, i) => {
      box(b, y, hs[i]);
      y += hs[i];
    });
  };
  lay(heights);
  return { scroller, list, blocks, lay };
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe("anchorScroll", () => {
  it("keeps the view still when a block above it grows or shrinks", () => {
    const t = transcript([400, 400, 400, 400]);
    anchorScroll(t.scroller, t.list, () => false);
    resize(t.blocks);
    t.lay([400, 650, 400, 400]);
    resize([t.blocks[1]]);
    expect(t.scroller.scrollTop).toBe(1250);
    t.lay([300, 650, 400, 400]);
    resize([t.blocks[0]]);
    expect(t.scroller.scrollTop).toBe(1150);
  });

  it("adds up several blocks above that change in one pass, in any order", () => {
    const t = transcript([160, 160, 160, 160, 160, 160, 160, 160]);
    anchorScroll(t.scroller, t.list, () => false);
    resize(t.blocks);
    t.lay([160, 160, 300, 500, 160, 160, 160, 160]);
    resize([t.blocks[3], t.blocks[2]]);
    expect(t.scroller.scrollTop).toBe(1000 + 140 + 340);
  });

  it("leaves the view alone for a block on screen or below it", () => {
    const t = transcript([400, 400, 400, 400]);
    anchorScroll(t.scroller, t.list, () => false);
    resize(t.blocks);
    // Block 2 runs from 800 to 1200, across the view's top at 1000: what grows is under the part on screen.
    t.lay([400, 400, 700, 900]);
    resize([t.blocks[2], t.blocks[3]]);
    expect(t.scroller.scrollTop).toBe(1000);
  });

  it("leaves a view that follows the bottom to the code that follows it", () => {
    const t = transcript([400, 400, 400]);
    anchorScroll(t.scroller, t.list, () => true);
    resize(t.blocks);
    t.lay([700, 400, 400]);
    resize([t.blocks[0]]);
    expect(t.scroller.scrollTop).toBe(1000);
  });

  it("doesn't move a hidden pane's view, or move it when the pane shows again", () => {
    const t = transcript([400, 400, 400]);
    anchorScroll(t.scroller, t.list, () => false);
    resize(t.blocks);
    Object.defineProperty(t.scroller, "clientHeight", { value: 0, configurable: true });
    t.lay([0, 0, 0]);
    resize(t.blocks);
    Object.defineProperty(t.scroller, "clientHeight", { value: 600, configurable: true });
    t.lay([400, 400, 400]);
    resize(t.blocks);
    expect(t.scroller.scrollTop).toBe(1000);
  });

  it("watches blocks added later, and stops when cleaned up", async () => {
    const t = transcript([400, 400]);
    const stop = anchorScroll(t.scroller, t.list, () => false);
    const added = t.list.insertBefore(document.createElement("div"), t.blocks[0]);
    await Promise.resolve();
    box(added, -1300, 160);
    resize([added]);
    box(added, -1300, 360);
    resize([added]);
    expect(t.scroller.scrollTop).toBe(1200);
    stop();
    box(added, -1300, 500);
    resize([added]);
    expect(t.scroller.scrollTop).toBe(1200);
  });
});
