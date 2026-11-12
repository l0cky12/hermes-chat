// Where the Preview's own page view goes (ADR 0081). The view is a native widget drawn over the whole app, so it
// follows its box in the pane, and leaves bare the parts that the app's floating layers (menus, dialogs, toasts,
// drawers) cover, so those still show and take the pointer.
import { useEffect, type RefObject } from "react";
import type { NativePage, Placement, Rect } from "./tauriPreview";

/** The most often the page's place is worked out again, while the app keeps changing (a reply streaming, say). */
const CHECK_MS = 200;

/**
 * A selector for the app's floating layers: every `position: fixed` rule in its stylesheets, which float over
 * everything, the Preview included, so a new one is covered with no list to keep; and its separators, which sit on a
 * pane's edge, over the edge of the Preview's box.
 */
export function floatingLayers(sheets: Iterable<CSSStyleSheet> = document.styleSheets): string {
  const found = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (rule.style.position === "fixed") found.add(rule.selectorText);
      } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(sheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Another origin's sheet can't be read; the app has none.
    }
  }
  const probe = document.createDocumentFragment();
  return ["[role=separator]", ...found]
    .filter((selector) => {
      try {
        probe.querySelector(selector);
        return true;
      } catch {
        // A selector the stylesheet keeps but this engine can't query would break the whole list.
        return false;
      }
    })
    .join(", ");
}

const intersect = (a: Rect, b: Rect): Rect | undefined => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/**
 * Whether `layer` is drawn over `box` in `r`, where both are: it comes before the box among the elements painted at
 * the middle of `r`, whatever else (a toast over a menu) is painted there too.
 */
function drawnOver(layer: Element, box: Element, r: Rect): boolean {
  const painted = box.ownerDocument.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  const over = painted.findIndex((e) => layer.contains(e));
  const under = painted.findIndex((e) => box.contains(e));
  return over >= 0 && (under < 0 || over < under);
}

/**
 * Where the page goes: `box`'s rectangle in the window, less the layers drawn over it. A layer across a whole side of
 * the box (the pane's resize handle, a dialog's backdrop) moves that side in. Any other makes a hole, which only X11
 * can cut, so it is best kept for small layers such as a menu or a toast. A layer counts only where it is drawn over
 * the box, so one beneath the Preview when it covers the chat counts for nothing. All in CSS pixels, with the window's
 * CSS size as `viewport`, from which Rust finds how far WebKit zooms the app. `null`: the box has no size, or layers cover it.
 */
export function placementOf(box: Element, layers: string): Placement | null {
  const r = box.getBoundingClientRect();
  let rect: Rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const over: Rect[] = [];
  if (layers)
    for (const layer of Array.from(box.ownerDocument.querySelectorAll(layers))) {
      if (layer.contains(box)) continue;
      const hole = intersect(rect, layer.getBoundingClientRect());
      if (hole && drawnOver(layer, box, hole)) over.push(hole);
    }
  const holes: Rect[] = [];
  for (const h of over) {
    const [left, right] = [rect.x, rect.x + rect.width];
    const [top, bottom] = [rect.y, rect.y + rect.height];
    const tall = h.y <= top && h.y + h.height >= bottom;
    const wide = h.x <= left && h.x + h.width >= right;
    if (tall && h.x <= left) rect = { ...rect, x: h.x + h.width, width: right - (h.x + h.width) };
    else if (tall && h.x + h.width >= right) rect = { ...rect, width: h.x - left };
    else if (wide && h.y <= top) rect = { ...rect, y: h.y + h.height, height: bottom - (h.y + h.height) };
    else if (wide && h.y + h.height >= bottom) rect = { ...rect, height: h.y - top };
    else holes.push(h);
  }
  if (rect.width < 1 || rect.height < 1) return null;
  // The visual viewport's size keeps its fraction (853.33 at 1.5 times), where innerWidth rounds it off.
  const view = box.ownerDocument.defaultView;
  const viewport = { width: view?.visualViewport?.width ?? view?.innerWidth ?? 0, height: view?.visualViewport?.height ?? view?.innerHeight ?? 0 };
  return { rect, holes: holes.flatMap((h) => intersect(rect, h) ?? []), viewport };
}

/** Keeps `page` placed over `box` while both are there, and hides it when either goes. */
export function usePlacement(box: RefObject<HTMLElement | null>, page: NativePage | undefined) {
  useEffect(() => {
    const el = box.current;
    if (!page || !el) return;
    const layers = floatingLayers();
    let last = "";
    let pending: ReturnType<typeof setTimeout> | undefined;
    let checked = 0;
    const measure = () => {
      pending = undefined;
      checked = performance.now();
      const placement = placementOf(el, layers);
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      page.place(placement);
    };
    // Anything that can move the box or open a layer over it: the box resizing, the window resizing, the app's DOM
    // changing (a menu, a dialog, a toast), the owner's input, and a layer's opening animation ending. A timer rather
    // than an animation frame, which would have the webview draw every time though nothing changed.
    const soon = () => {
      pending ??= setTimeout(measure, Math.max(0, checked + CHECK_MS - performance.now()));
    };
    const resized = new ResizeObserver(soon);
    resized.observe(el);
    const changed = new MutationObserver(soon);
    changed.observe(el.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
    const events = ["resize", "pointerup", "keyup", "contextmenu", "animationend", "transitionend"] as const;
    for (const e of events) addEventListener(e, soon, true);
    measure();
    return () => {
      resized.disconnect();
      changed.disconnect();
      clearTimeout(pending);
      for (const e of events) removeEventListener(e, soon, true);
      page.place(null);
    };
  }, [box, page]);
}
