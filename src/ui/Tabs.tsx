// Chat tabs: each pane keeps the chats the owner opened in it as tabs, and shows one. A chat from the chat list, or a
// tab, can be dragged onto a pane: onto its tab strip to add a tab there (or move the tab along its own strip), onto one
// of its four edges to split the chat area that way. A dragged tab moves; a chat from the list opens. `tabMoves.ts`
// decides where each drop lands, and every drop has a keyboard way through the tab's menu. `null` is the New chat tab.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Spinner, slotAt } from "./bits";
import { Menu } from "./ChatMenu";
import type { DropZone, MovedChat } from "./tabMoves";

export type { DropZone } from "./tabMoves";

/** The drag data type a chat id travels under, from a chat list row or a tab. */
export const CHAT_DRAG = "application/x-hermes-chat";
/** Also on a tab's drag, with the pane it comes from: a tab moves where a list row opens. */
export const TAB_DRAG = "application/x-hermes-tab";

// What is being dragged: a tab, with its pane, or a chat list row. A drag's data can only be read on drop, but the hint
// has to know before, while it is over a pane, what the drop would do. Kept here, and each trusted only while the drag
// carries its type, so a drag that ended without a dragend (its row or tab gone mid-drag) can't pass for a later one.
let tabDrag: { pane: string; id: string | null } | null = null;
let rowDrag: string | null = null;

/** A chat list row's drag: it carries the chat's id. */
export const dragChat = (e: DragEvent, id: string) => {
  rowDrag = id;
  e.dataTransfer.setData(CHAT_DRAG, id);
  e.dataTransfer.effectAllowed = "copy";
};
export const dragChatEnd = () => void (rowDrag = null);

/** The chat a drag carries, or undefined for a drag that isn't a chat's. A row's id unknown ("", which no tab has)
 * only when its drag started outside this window. */
const movedBy = (e: DragEvent): MovedChat | undefined => {
  const types = e.dataTransfer.types;
  if (types.includes(TAB_DRAG)) return tabDrag ? { id: tabDrag.id, from: tabDrag.pane } : undefined;
  return types.includes(CHAT_DRAG) ? { id: e.dataTransfer.getData(CHAT_DRAG) || rowDrag || "" } : undefined;
};
/** A drop ends the drag here, whether or not its source sees a dragend. */
const dropped = () => {
  tabDrag = null;
  rowDrag = null;
};

/** The tabs once the pane goes from chat `from` to `to`: a chat with a tab already is switched to; otherwise it takes
 * the place of the tab it leaves, as a link followed in a browser tab does. */
export const navigateTabs = (tabs: (string | null)[], from: string | null, to: string | null) =>
  tabs.includes(to) ? tabs : tabs.includes(from) ? tabs.map((t) => (t === from ? to : t)) : [...tabs, to];

/** The tabs once `id`'s tab closes, and the tab shown next if `id`'s was the one shown: the one after it, or before. */
export const closeTabIn = (tabs: (string | null)[], id: string | null) => {
  const at = tabs.indexOf(id);
  const rest = tabs.filter((t) => t !== id);
  return { rest, next: rest[Math.min(at, rest.length - 1)] as string | null | undefined };
};

export type TabInfo = { id: string | null; title: string; running?: boolean; unread?: boolean };

/** What a drop would do, as the hint says it, or null when it would do nothing. `index`: before which tab, on a strip. */
export type DropPreview = (moved: MovedChat, zone: DropZone, index?: number) => string | null;
export type DropChat = (moved: MovedChat, zone: DropZone, index?: number) => void;
/** One item of a tab's menu, or a separator. */
export type TabAction = { label: string; icon?: ReactNode; keys?: string; run: () => void } | "sep";

/** Before which tab a drop at `x` lands. Unmeasured (as in tests): the end. */
const indexAt = (strip: HTMLElement, x: number) => slotAt([...strip.querySelectorAll(".tab")], x, "x");

/** One pane's tab strip. A chat dropped on it opens in a new tab before the tab under the pointer; a tab dragged along
 * it moves there, with a mark where it will land. `lastClosable`: closing the last tab closes the pane. `controls` sit
 * at the strip's far end: the pane's split buttons, or its close button once split. `menu`: the items of a tab's menu,
 * opened by a right-click, the Menu key or Shift+F10. */
export function TabStrip({
  pane,
  tabs,
  current,
  onPick,
  onClose,
  onNew,
  preview,
  onDropChat,
  menu,
  lastClosable = false,
  controls,
}: {
  pane: string;
  tabs: TabInfo[];
  current: string | null;
  onPick: (id: string | null) => void;
  onClose: (id: string | null) => void;
  onNew: () => void;
  preview: DropPreview;
  onDropChat: DropChat;
  menu: (id: string | null) => TabAction[];
  lastClosable?: boolean;
  controls?: ReactNode;
}) {
  // While a drop would land here: before which tab (undefined: at the end, unmeasured).
  const [over, setOver] = useState<{ index?: number } | null>(null);
  const [menuAt, setMenuAt] = useState<{ id: string | null; x: number; y: number } | null>(null);
  // The tab shown is scrolled into sight when the strip is wider than the pane. A block body: scrollIntoView returns a
  // Promise on WebView2 (Chromium 156+), and an effect that returned it gave React a cleanup that isn't a function, so
  // the next tab change threw and React dropped the whole tree (#308).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current, tabs.length]);
  const actions = menuAt ? menu(menuAt.id) : [];
  return (
    <div
      className={`tab-strip ${over ? "drop" : ""}`}
      onDragOver={(e) => {
        const moved = movedBy(e);
        if (!moved) return;
        e.stopPropagation();
        const index = list.current ? indexAt(list.current, e.clientX) : undefined;
        if (preview(moved, "tab", index) === null) return setOver(null);
        e.preventDefault();
        e.dataTransfer.dropEffect = moved.from === undefined ? "copy" : "move";
        if (over?.index !== index || !over) setOver({ index });
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(null)}
      onDrop={(e) => {
        setOver(null);
        const moved = movedBy(e);
        dropped();
        if (!moved || (moved.from === undefined && !moved.id)) return;
        e.preventDefault();
        e.stopPropagation();
        onDropChat(moved, "tab", list.current ? indexAt(list.current, e.clientX) : undefined);
      }}
    >
      <div ref={list} className="tabs" role="tablist" aria-label="Chat tabs">
        {tabs.map((t, i) => {
          const on = t.id === current;
          const mark = over?.index === i ? "insert-before" : over?.index === tabs.length && i === tabs.length - 1 ? "insert-after" : "";
          return (
            <div key={t.id ?? "new"} className={`tab ${on ? "on" : ""} ${mark}`}>
              <button
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className="tab-open"
                title={t.title}
                draggable
                onDragStart={(e) => {
                  tabDrag = { pane, id: t.id };
                  e.dataTransfer.setData(TAB_DRAG, pane);
                  if (t.id !== null) e.dataTransfer.setData(CHAT_DRAG, t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  tabDrag = null;
                  setOver(null);
                }}
                onClick={() => on || onPick(t.id)}
                // A middle click closes the tab, as in a browser.
                onAuxClick={(e) => e.button === 1 && onClose(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // From the keyboard the event has no pointer position, so the menu opens under the tab.
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuAt({ id: t.id, ...(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom }) });
                }}
                onKeyDown={(e) => {
                  const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : undefined;
                  if (e.key === "Delete") return onClose(t.id);
                  if (to === undefined || !tabs[to] || e.ctrlKey || e.altKey || e.metaKey) return;
                  e.preventDefault();
                  // Home on the first tab, or End on the last, stays put: picking the tab shown again would count as
                  // the owner moving, and drop a chat still starting there.
                  if (tabs[to].id !== current) onPick(tabs[to].id);
                  // React clears `currentTarget` once the handler returns.
                  const strip = e.currentTarget.closest(".tabs");
                  requestAnimationFrame(() => strip?.querySelectorAll<HTMLElement>(".tab-open")[to]?.focus());
                }}
              >
                {t.running ? <Spinner /> : t.unread ? <span className="dot" title="Unread" /> : null}
                <span className="tab-title">{t.title}</span>
              </button>
              {(tabs.length > 1 || lastClosable) && (
                <button className="tab-close" tabIndex={-1} title="Close tab" aria-label={`Close the tab ${t.title}`} onClick={() => onClose(t.id)}>
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="icon-btn tab-new" title="New chat in a new tab" aria-label="New tab" onClick={onNew}>
        <Plus size={15} />
      </button>
      {controls && <div className="tab-strip-end">{controls}</div>}
      {menuAt && (
        <Menu label={`Actions for the tab ${tabs.find((t) => t.id === menuAt.id)?.title ?? ""}`} x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>
          {actions.map((a, i) =>
            a === "sep" ? (
              <div key={`sep-${i}`} className="menu-sep" role="separator" />
            ) : (
              <button
                key={a.label}
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuAt(null);
                  a.run();
                }}
              >
                <span className="menu-icon">{a.icon}</span>
                <span className="menu-label">{a.label}</span>
                {a.keys && <kbd>{a.keys}</kbd>}
              </button>
            ),
          )}
        </Menu>
      )}
    </div>
  );
}

/** Where over a pane a dragged chat would land: the edge it is within a quarter of, the nearest at a corner, else the
 * middle, which adds a tab. */
export const zoneAt = (x: number, y: number): DropZone => {
  const near: [DropZone, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [edge, d] = near.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < 0.25 ? edge : "tab";
};

const zoneOf = (e: DragEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return zoneAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
};

/** A pane's body as a drop target for chats, with a hint over the part of it where a dragged chat would land and what
 * it would do there. */
export function PaneDrop({ children, preview, onDropChat }: { children: ReactNode; preview: DropPreview; onDropChat: DropChat }) {
  const [hint, setHint] = useState<{ zone: DropZone; label: string } | null>(null);
  return (
    <div
      className="pane-drop"
      onDragOver={(e) => {
        const moved = movedBy(e);
        if (!moved) return;
        const zone = zoneOf(e);
        const label = preview(moved, zone);
        if (label === null) return setHint(null);
        e.preventDefault();
        e.dataTransfer.dropEffect = moved.from === undefined ? "copy" : "move";
        if (hint?.zone !== zone || hint.label !== label) setHint({ zone, label });
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setHint(null)}
      onDrop={(e) => {
        setHint(null);
        const moved = movedBy(e);
        dropped();
        if (!moved || (moved.from === undefined && !moved.id)) return;
        e.preventDefault();
        onDropChat(moved, zoneOf(e));
      }}
    >
      {children}
      {hint && (
        <div className="drop-hint" data-zone={hint.zone} aria-hidden>
          <span>{hint.label}</span>
        </div>
      )}
    </div>
  );
}
