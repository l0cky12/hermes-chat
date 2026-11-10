/**
 * Keeps what's on screen in `scroller` still when children of `list` change height, as CSS scroll anchoring would.
 * WebKitGTK doesn't anchor, and transcript blocks change height the first time they lay out: `content-visibility`
 * skips each one, at its placeholder height, until it comes into view. `following`: the view sticks to the bottom, so
 * there's nothing to hold. Returns the cleanup.
 */
export function anchorScroll(scroller: HTMLElement, list: Element, following: () => boolean): () => void {
  const heights = new WeakMap<Element, number>();
  const ro = new ResizeObserver((entries) => {
    // A hidden pane lays its blocks out at no height; what they had stays their height for when it shows again.
    if (!scroller.clientHeight) return;
    const blocks = Array.from(list.children);
    const changes: { at: number; by: number; first: boolean }[] = [];
    for (const { target } of entries) {
      const height = target.getBoundingClientRect().height;
      const was = heights.get(target);
      heights.set(target, height);
      const at = blocks.indexOf(target);
      if (was !== undefined && height !== was && at >= 0) changes.push({ at, by: height - was, first: Math.abs(was - placeholder(target)) < 0.5 });
    }
    if (!changes.length || following()) return;
    // Where blocks were before these changes: each block, less what the blocks before it grew.
    const grewBefore = (i: number) => changes.reduce((sum, c) => (c.at < i ? sum + c.by : sum), 0);
    const top = (i: number) => blocks[i].getBoundingClientRect().top - grewBefore(i);
    const bottom = (i: number) => blocks[i].getBoundingClientRect().bottom - grewBefore(i + 1);
    const view = scroller.getBoundingClientRect();
    let inView = 0;
    for (let hi = blocks.length; inView < hi; ) {
      const mid = (inView + hi) >> 1;
      if (bottom(mid) > view.top) hi = mid;
      else inView = mid + 1;
    }
    if (inView === blocks.length) return;
    // The view holds still the first block in it that showed something already. A block laid out for the first time
    // showed nothing, so ones above that block grow upward. When every block in view is new, the first one holds.
    const firstLaidOut = (i: number) => changes.some((c) => c.at === i && c.first);
    let anchor = inView;
    while (anchor < blocks.length && firstLaidOut(anchor) && top(anchor) < view.bottom) anchor++;
    if (anchor === blocks.length || top(anchor) >= view.bottom) anchor = inView;
    const shift = grewBefore(anchor);
    if (shift) scroller.scrollTop += shift;
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

/** The height a block skipped before it was ever laid out has: its `contain-intrinsic-block-size` and its box. */
function placeholder(el: Element): number {
  const s = getComputedStyle(el);
  const px = (v: string | undefined) => parseFloat(v ?? "") || 0;
  return px(s.containIntrinsicBlockSize?.replace("auto", "")) + px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
}

/**
 * Scrolls `el`, in the transcript, into view as scrollIntoView does. WebKitGTK doesn't scroll to an element in a block
 * `content-visibility` skips, only lays the block out, and the blocks that come into view around it lay out a frame or
 * two later. So it scrolls again each frame until `el` has held still for three, for a quarter of a second at most.
 */
export function revealInTranscript(el: Element, block: ScrollLogicalPosition) {
  let last: number | undefined;
  let still = 0;
  let frames = 0;
  const step = () => {
    el.scrollIntoView?.({ block });
    const top = el.getBoundingClientRect().top;
    still = top === last ? still + 1 : 0;
    last = top;
    if (still < 3 && ++frames < 15) requestAnimationFrame(step);
  };
  step();
}
