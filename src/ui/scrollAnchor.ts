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
    const viewTop = scroller.getBoundingClientRect().top;
    const changed = entries.map((e) => ({ el: e.target, rect: e.target.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
    let shift = 0;
    for (const { el, rect } of changed) {
      const was = heights.get(el);
      heights.set(el, rect.height);
      if (was === undefined) continue;
      // Where it was before the blocks above it in this pass changed.
      const top = rect.top - shift;
      // A block laid out for the first time showed nothing yet, so one reaching above the view grows upward, holding
      // the blocks under it. Any other change holds only when the whole block was above, so nothing on screen moves.
      if (Math.abs(was - placeholder(el)) < 0.5 ? top < viewTop : top + was <= viewTop) shift += rect.height - was;
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
