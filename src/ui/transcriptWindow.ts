// Which of a long transcript's chunks are in the DOM: the ones near the view (ADR 0138).
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** The flex gap of `.transcript-inner`, which a spacer makes up for between the chunks it stands in for. */
const GAP = 22;
/** A block's height before any chunk has been measured. */
const BLOCK_HEIGHT = 120;
/** A chat of this many chunks or fewer renders whole. */
const FEW_CHUNKS = 4;

/** The chunks rendered, `from` to `to`, and the heights of the spacers standing in for the ones before and after. */
export type Shown = { from: number; to: number; before: number; after: number };

/**
 * `tail`: the last chunks, before the scroller has been measured. `all`: the scroller has no height (a test without
 * layout, a pane mounted hidden), so nothing says what is near the view.
 */
type Window = Shown | "tail" | "all";

type Chunk = { id: string }[];

/** The height standing in for chunks `from` up to `to`, without the gap to the chunk rendered next to them. */
function span(heights: number[], from: number, to: number) {
  let h = 0;
  for (let i = from; i < to; i++) h += heights[i];
  return to > from ? h + (to - from - 1) * GAP : 0;
}

const shown = (heights: number[], from: number, to: number): Shown => ({
  from,
  to,
  before: span(heights, 0, from),
  after: span(heights, to + 1, heights.length),
});

const around = (heights: number[], i: number) => shown(heights, Math.max(0, i - 1), Math.min(heights.length - 1, i + 1));

const chunkEls = (scroller: HTMLElement) => [...scroller.querySelectorAll<HTMLElement>(".transcript-chunk")];

/**
 * The part of `chunks` to render in `scroller`, the transcript's scrolling element: the chunks in view and a view's
 * height of them on each side. The caller renders a `.transcript-gap` of height `before` in place of the chunks
 * before `from`, and one of `after` for those past `to`, and gives each `.transcript-chunk` its key as `data-chunk`.
 *
 * `all`: render every chunk. `stuck`: the view follows the bottom, whatever its scroll position says. `target`: a
 * chunk that must be rendered, as long as it is given; the window stays around it. `reveal` renders a chunk at once,
 * for a DOM lookup that follows.
 */
export function useTranscriptWindow({
  scroller,
  chunks,
  all,
  stuck,
  target,
}: {
  scroller: RefObject<HTMLElement | null>;
  chunks: Chunk[];
  all: boolean;
  stuck: RefObject<boolean>;
  target?: number;
}): Shown & { reveal: (chunk: number) => void } {
  let [win, setWin] = useState<Window>("tail");
  /** Each chunk's height when it was last in the DOM, by key. */
  const measured = useRef(new Map<string, number>());
  const perBlock = useRef(BLOCK_HEIGHT);
  const heights = useCallback((chunks: Chunk[]) => chunks.map((c) => measured.current.get(c[0].id) ?? c.length * perBlock.current), []);
  const width = useRef(0);
  const sized = useRef(false);
  /** A chunk in view and where it was before the window changed, to put it back there afterwards. */
  const anchor = useRef<{ key: string; at: number }>(undefined);

  if (target !== undefined && win !== "all" && (win === "tail" || target < win.from || target > win.to)) {
    win = around(heights(chunks), target);
    setWin(win);
  }
  const latest = useRef({ chunks, target, win });
  latest.current = { chunks, target, win };

  const place = useCallback(() => {
    const el = scroller.current;
    const { chunks, target, win } = latest.current;
    if (!el || !chunks.length) return;
    const view = el.clientHeight;
    if (!view) {
      if (!sized.current) setWin("all");
      return;
    }
    sized.current = true;
    if (target !== undefined) return;
    // Chunks wrap again at a new width, so what was measured at the old one says little.
    if (el.clientWidth !== width.current) measured.current.clear();
    width.current = el.clientWidth;
    const box = el.getBoundingClientRect();
    const offset = (node: Element) => node.getBoundingClientRect().top - box.top + el.scrollTop;
    const mounted = chunkEls(el);
    for (const m of mounted) measured.current.set(m.dataset.chunk!, m.getBoundingClientRect().height);
    const base = mounted.length ? chunks.findIndex((c) => c[0].id === mounted[0].dataset.chunk) : -1;
    if (base < 0) return;

    // Where each chunk is, counted from one that is in the DOM, so a wrong guess for a chunk far away moves nothing.
    const hs = heights(chunks);
    const tops = [offset(mounted[0])];
    for (let i = base; i > 0; i--) tops.unshift(tops[0] - GAP - hs[i - 1]);
    for (let i = base + 1; i < hs.length; i++) tops.push(tops[i - 1] + hs[i - 1] + GAP);
    const last = hs.length - 1;
    const viewTop = stuck.current ? tops[last] + hs[last] - view : el.scrollTop;
    const lo = viewTop - view;
    const hi = stuck.current ? Infinity : viewTop + 2 * view;
    let from = last;
    let to = 0;
    hs.forEach((h, i) => {
      if (tops[i] + h > lo) from = Math.min(from, i);
      if (tops[i] < hi) to = i;
    });
    to = Math.max(from, to);
    // A streaming chunk's height changes every frame, so the estimate is taken again only when the window moves.
    if (typeof win === "string" || win.from !== from || win.to !== to) {
      let height = 0;
      let blocks = 0;
      for (const c of chunks) {
        const h = measured.current.get(c[0].id);
        if (h === undefined) continue;
        height += h;
        blocks += c.length;
      }
      if (blocks) perBlock.current = height / blocks;
    }
    const next = shown(heights(chunks), from, to);
    if (typeof win !== "string" && win.from === next.from && win.to === next.to && win.before === next.before && win.after === next.after) return;
    const inView = stuck.current ? undefined : mounted.find((m) => m.getBoundingClientRect().bottom > box.top);
    anchor.current = inView && { key: inView.dataset.chunk!, at: offset(inView) };
    setWin(next);
  }, [scroller, stuck, heights]);

  // WebKitGTK 2.54 doesn't anchor this scroller (#418), so a chunk that isn't the height it was taken for would move
  // what is on screen.
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = anchor.current;
    anchor.current = undefined;
    if (!el || !was || stuck.current) return;
    const node = chunkEls(el).find((m) => m.dataset.chunk === was.key);
    if (!node) return;
    const moved = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - was.at;
    if (Math.abs(moved) >= 0.5) el.scrollTop += moved;
  }, [win, scroller, stuck]);

  useLayoutEffect(place, [place, chunks, all]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const soon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    el.addEventListener("scroll", soon, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", soon);
      ro?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [place, scroller]);

  const reveal = useCallback((chunk: number) => {
    const { chunks, win } = latest.current;
    if (chunk < 0 || typeof win === "string" || (chunk >= win.from && chunk <= win.to)) return;
    flushSync(() => setWin(around(heights(chunks), chunk)));
  }, [heights]);

  const last = chunks.length - 1;
  if (all || chunks.length <= FEW_CHUNKS || win === "all") return { from: 0, to: last, before: 0, after: 0, reveal };
  if (win === "tail") return { ...shown(heights(chunks), Math.max(0, last - 1), last), reveal };
  // The chunks may have changed since the window was placed; it is placed again in this commit.
  const to = Math.min(win.to, last);
  return { ...win, from: Math.min(win.from, to), to, reveal };
}
