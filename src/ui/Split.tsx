// Two chats side by side, or one above the other: the panes, the divider between them, and which pane is active. The
// divider drags, or moves with the arrow keys; a double click puts it back in the middle. Where there is no room for two
// panes, only the active one shows, with a switcher above it; the other stays mounted, hidden, so its scroll, find bar
// and attachments are as they were when it comes back.
import { createContext, useContext, Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { chordLabel, useBindings } from "./keybindings";

/** The narrowest a pane gets beside another. Narrower than two of these, the panes take turns. */
export const MIN_PANE_PX = 320;
/** The shortest a pane gets above or below another. */
export const MIN_PANE_HEIGHT_PX = 200;
const DIVIDER_PX = 6;
/** How far an arrow key moves the divider, as a share of the width. */
const KEY_STEP = 0.05;
/** A drag step whose frame takes longer than this (long chats rewrap) makes the rest of the drag move a guide line,
 * and the panes resize once, on release. */
const SLOW_STEP_MS = 50;
type Box = { start: number; len: number };

export type PaneSlot = {
  key: string;
  /** What the pane shows, for the switcher and for screen readers: the chat's title. */
  title: string;
  node: ReactNode;
};

const PaneVisibility = createContext(true);
export const usePaneVisible = () => useContext(PaneVisibility);

export const PANE_NAMES = ["Left", "Right"] as const;
export const STACKED_PANE_NAMES = ["Top", "Bottom"] as const;
/** "row": side by side; "column": one above the other. */
export type SplitDir = "row" | "column";
export const paneNames = (dir: SplitDir) => (dir === "row" ? PANE_NAMES : STACKED_PANE_NAMES);

const clamp = (r: number, min: number) => Math.min(1 - min, Math.max(min, r));

/**
 * The panes in order, one or two. `activeKey`: the pane keyboard shortcuts, the chat list and Search act on.
 * `onActivate`: the owner clicked, tabbed or switched into a pane.
 */
export function Split({ panes, activeKey, onActivate, covered = false, dir = "row" }: { panes: PaneSlot[]; activeKey: string; onActivate: (key: string) => void; covered?: boolean; dir?: SplitDir }) {
  const row = dir === "row";
  const keys = useBindings();
  const minPx = row ? MIN_PANE_PX : MIN_PANE_HEIGHT_PX;
  const names = paneNames(dir);
  const box = useRef<HTMLDivElement>(null);
  // The left pane's share of the width. Kept here, so dragging re-renders the divider and not the chats.
  const [ratio, setRatio] = useState(0.5);
  const [width, setWidth] = useState<number>();
  const [resizing, setResizing] = useState(false);
  const split = panes.length > 1;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const r = el.getBoundingClientRect();
    setWidth(row ? r.width : r.height);
    const ro = new ResizeObserver(([e]) => setWidth(row ? e.contentRect.width : e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [row]);

  // Unmeasured (as in tests), the panes are taken to fit.
  // `width` is the length along the split: the height when the panes are stacked.
  const narrow = split && width !== undefined && width < 2 * minPx + DIVIDER_PX;
  const min = width ? Math.min(0.5, minPx / (width - DIVIDER_PX)) : 0.2;
  const shown = clamp(ratio, min);

  // `box`: where the split starts and how long it is, measured once when the drag starts, so a step reads no layout.
  const dragging = useRef<{ frame?: number; x: number; slow: boolean; box?: Box } | null>(null);
  // Where the guide line is, while a slow drag is under way.
  const [ghost, setGhost] = useState<number | null>(null);
  const measure = (): Box | undefined => {
    const r = box.current?.getBoundingClientRect();
    return r && (row ? { start: r.left, len: r.width } : { start: r.top, len: r.height });
  };
  const ratioAt = (client: number, at = measure()) =>
    at?.len ? clamp((client - at.start - DIVIDER_PX / 2) / (at.len - DIVIDER_PX), Math.min(0.5, minPx / (at.len - DIVIDER_PX))) : undefined;
  // Live while the panes keep up; once a step is slow, the guide line stands in for the rest of the drag. A step is
  // timed to the next frame, since most of a slow one goes to painting the rewrapped chats after the render (#428).
  const dragTo = (d: NonNullable<typeof dragging.current>) => {
    const to = ratioAt(d.x, d.box);
    if (to === undefined) return;
    if (d.slow) return setGhost(to);
    const t0 = performance.now();
    flushSync(() => setRatio(to));
    requestAnimationFrame(() => {
      if (performance.now() - t0 > SLOW_STEP_MS) d.slow = true;
    });
  };
  const endDrag = (clientX?: number) => {
    const d = dragging.current;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    const to = clientX === undefined ? undefined : ratioAt(clientX);
    if (to !== undefined) setRatio(to);
    dragging.current = null;
    setGhost(null);
    setResizing(false);
  };
  useEffect(() => () => void (dragging.current?.frame && cancelAnimationFrame(dragging.current.frame)), []);

  return (
    <div ref={box} aria-hidden={covered || undefined} inert={covered || undefined} className={`panes ${covered ? "covered" : ""} ${split ? "split" : ""} ${row ? "" : "stacked"} ${narrow ? "narrow" : ""}`}>
      {narrow && (
        <div className="pane-switch" role="tablist" aria-label="Panes">
          {panes.map((p, i) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={p.key === activeKey}
              tabIndex={p.key === activeKey ? 0 : -1}
              className={`pane-tab ${p.key === activeKey ? "on" : ""}`}
              title={`${names[i]} pane: ${p.title} (${chordLabel(keys[i === 0 ? "focusLeft" : "focusRight"][0])})`}
              onClick={() => onActivate(p.key)}
              onKeyDown={(e) => {
                const next = e.key === "ArrowLeft" || e.key === "ArrowRight" ? 1 - i : e.key === "Home" ? 0 : e.key === "End" ? 1 : undefined;
                if (next === undefined) return;
                e.preventDefault();
                onActivate(panes[next].key);
                (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
              }}
            >
              <span className="pane-tab-side">{names[i]}</span>
              <span className="pane-tab-title">{p.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="panes-row">
        {panes.map((p, i) => {
          const active = p.key === activeKey;
          const hidden = narrow && !active;
          return (
            <Fragment key={p.key}>
              {i === 1 && !narrow && (
                <div
                  className={`divider ${resizing ? "dragging" : ""}`}
                  role="separator"
                  aria-orientation={row ? "vertical" : "horizontal"}
                  aria-label="Resize the panes"
                  aria-valuemin={Math.round(min * 100)}
                  aria-valuemax={Math.round((1 - min) * 100)}
                  aria-valuenow={Math.round(shown * 100)}
                  tabIndex={0}
                  title="Drag to resize. Double-click to make the panes equal."
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragging.current = { x: row ? e.clientX : e.clientY, slow: false, box: measure() };
                    setResizing(true);
                  }}
                  onPointerMove={(e) => {
                    const d = dragging.current;
                    if (!d) return;
                    d.x = row ? e.clientX : e.clientY;
                    // One layout per frame: a long chat reflows each time its width changes.
                    d.frame ??= requestAnimationFrame(() => {
                      d.frame = undefined;
                      dragTo(d);
                    });
                  }}
                  onPointerUp={(e) => endDrag(row ? e.clientX : e.clientY)}
                  // Cancelled, the panes stay where the last live step left them.
                  onPointerCancel={() => endDrag()}
                  onDoubleClick={() => setRatio(0.5)}
                  onKeyDown={(e) => {
                    const to =
                      e.key === (row ? "ArrowLeft" : "ArrowUp") ? shown - KEY_STEP : e.key === (row ? "ArrowRight" : "ArrowDown") ? shown + KEY_STEP : e.key === "Home" ? min : e.key === "End" ? 1 - min : undefined;
                    if (to === undefined) return;
                    e.preventDefault();
                    setRatio(clamp(to, min));
                  }}
                />
              )}
              <section
                className={`pane ${split && active ? "active" : ""} ${hidden ? "hidden" : ""}`}
                data-pane={p.key}
                aria-label={split ? `${names[i]} pane: ${p.title}${active ? " (active)" : ""}` : undefined}
                aria-hidden={hidden || undefined}
                inert={hidden || undefined}
                style={split && !narrow ? { flexGrow: i === 0 ? shown : 1 - shown } : undefined}
                // Anything done in a pane makes it the active one, so shortcuts and the chat list follow the owner.
                onPointerDownCapture={() => active || onActivate(p.key)}
                onFocusCapture={() => active || onActivate(p.key)}
              >
                <PaneVisibility value={!hidden && !covered}>{p.node}</PaneVisibility>
              </section>
            </Fragment>
          );
        })}
        {resizing && <div className="drag-shield" />}
        {ghost !== null && <div className="divider-ghost" style={{ [row ? "left" : "top"]: `calc(${ghost * 100}% - 1px)` }} />}
      </div>
    </div>
  );
}
