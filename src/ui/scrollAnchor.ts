/**
 * Keeps what's on screen in `scroller` still when a child of `list` above the view changes height, as CSS scroll
 * anchoring would. WebKitGTK doesn't anchor, and transcript blocks change height above the view the first time they
 * lay out, since `content-visibility` skips them until they come near. `following`: the view sticks to the bottom, so
 * there's nothing to hold. Returns the cleanup.
 */
export function anchorScroll(scroller: HTMLElement, list: Element, following: () => boolean): () => void {
  const heights = new WeakMap<Element, number>();
  const ro = new ResizeObserver((entries) => {
    // A hidden pane lays its blocks out at no height; what they had stays their height for when it shows again.
    if (!scroller.clientHeight) return;
    const viewTop = scroller.getBoundingClientRect().top;
    const changed = entries.map((e) => ({ el: e.target, rect: e.target.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
    let shift = 0;
    for (const { el, rect } of changed) {
      const was = heights.get(el);
      heights.set(el, rect.height);
      // Where it was before the blocks above it changed: wholly above the view, so its change moved what's on screen.
      if (was !== undefined && rect.top - shift + was <= viewTop) shift += rect.height - was;
    }
    if (shift && !following()) scroller.scrollTop += shift;
  });
  for (const child of list.children) ro.observe(child);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => n instanceof Element && ro.observe(n));
      r.removedNodes.forEach((n) => n instanceof Element && ro.unobserve(n));
    }
  });
  mo.observe(list, { childList: true });
  return () => {
    mo.disconnect();
    ro.disconnect();
  };
}
