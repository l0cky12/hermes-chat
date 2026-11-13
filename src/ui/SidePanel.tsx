// The side panel beside the chat (ADR 0039): Preview, Terminal, Files and Screen, one shown at a time, or the launcher
// that picks one (ADR 0159). Each tab is made the first time it is opened and kept from then on, so a shell or the screen
// keeps running while the owner is in another tab or the launcher, or the panel is hidden or closed. The panel is resizable from its left edge, and in a window too narrow
// for both it covers the chat until the owner goes back.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeft, Eye, FolderOpen, Monitor, Plus, SquareTerminal, X } from "lucide-react";

export type PanelTab = "preview" | "terminal" | "files" | "screen";

/** The narrowest the panel gets, and the step the arrow keys resize it by. */
export const PANE_MIN_WIDTH = 300;
const KEY_STEP = 32;

const TABS: { tab: PanelTab; label: string; title: string; Icon: typeof Eye; key: string }[] = [
  { tab: "preview", label: "Preview", title: "Pages, files and tool output", Icon: Eye, key: "P" },
  { tab: "terminal", label: "Terminal", title: "A shell on the Hermes server or on this computer", Icon: SquareTerminal, key: "T" },
  { tab: "files", label: "Files", title: "The files on the Hermes server", Icon: FolderOpen, key: "F" },
  { tab: "screen", label: "Screen", title: "Hermes's screen, where its computer use and browser run", Icon: Monitor, key: "S" },
];

export function SidePanel({
  tab,
  onTab,
  shown,
  overlay,
  compact = false,
  width,
  maxWidth,
  onResize,
  onHide,
  onClose,
  running = {},
  tabs,
}: {
  /** The tab on screen, or null for the launcher. */
  tab: PanelTab | null;
  /** The owner picked a tab, or null: the launcher (the + button). */
  onTab: (t: PanelTab | null) => void;
  /** False while the panel is closed or hidden: what runs in it keeps running. */
  shown: boolean;
  /** The window is too narrow for the panel beside the chat, so it covers the chat until `onHide`. */
  overlay: boolean;
  /** Narrower than the Server files table needs: it drops columns and shows a file below the list. */
  compact?: boolean;
  width: number;
  maxWidth: number;
  /** The owner is dragging the panel's edge; `done` once they let go. */
  onResize: (width: number, done: boolean) => void;
  onHide: () => void;
  onClose: () => void;
  /** Tabs with something running in them, marked with a dot; a string says what, for screen readers. */
  running?: Partial<Record<PanelTab, boolean | string>>;
  /** Each tab's content. `shown`: whether it is the tab on screen. */
  tabs: Record<PanelTab, (shown: boolean) => ReactNode>;
}) {
  const [made, setMade] = useState<PanelTab[]>(tab ? [tab] : []);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tab && !made.includes(tab)) setMade((m) => [...m, tab]);
  }, [tab, made]);
  // Opened or shown again, the panel takes focus, so Escape and the keys reach it, unless something in it (a terminal,
  // say) took it first. The launcher, when it shows, puts focus on its first row, so the arrows and Enter work at once.
  useEffect(() => {
    if (!shown) return;
    const first = launcherRows(root.current)[0];
    if (first && !launcherRows(root.current).includes(document.activeElement as HTMLButtonElement)) first.focus();
    else if (!root.current?.contains(document.activeElement)) root.current?.focus();
  }, [shown, tab]);
  // Covering the chat makes it inert, focus included, so focus moves in then too; a control in the panel keeps it.
  useEffect(() => {
    if (shown && !root.current?.contains(document.activeElement)) (launcherRows(root.current)[0] ?? root.current)?.focus();
  }, [overlay, shown]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return;
    // The launcher's keys: a tab's letter opens it, by its character or, for a letter outside the Latin script (a
    // Cyrillic or Greek layout), its key's position; a Latin letter (é, ś) is never taken by position. Only
    // while the launcher shows, so they never reach a terminal or field, and never with a modifier, so the app's own
    // shortcuts (Alt+Up and Alt+Down among them) still work.
    const launcher = tab === null && !e.ctrlKey && !e.altKey && !e.metaKey;
    const letter = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : /^\p{L}$/u.test(e.key) && !/^\p{Script=Latin}$/u.test(e.key) && e.code.startsWith("Key") ? e.code.slice(3) : "";
    const picked = launcher && TABS.find((t) => t.key === letter);
    if (picked) {
      e.preventDefault();
      return onTab(picked.tab);
    }
    if (launcher && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const rows = launcherRows(root.current);
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      return rows[next]?.focus();
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (overlay) onHide();
    else onClose();
  };

  return (
    <aside
      ref={root}
      tabIndex={-1}
      hidden={!shown}
      className={`preview side-panel ${overlay ? "overlay" : ""} ${compact ? "compact" : ""} ${dragging ? "dragging" : ""}`}
      style={overlay ? undefined : { width }}
      aria-label="Side panel"
      onKeyDown={onKey}
    >
      {!overlay && <ResizeHandle width={width} maxWidth={maxWidth} onResize={onResize} onDragging={setDragging} />}
      <div className="panel-tabs">
        {overlay && (
          <button className="icon-btn" title="Back to the chat" onClick={onHide}>
            <ArrowLeft size={16} />
          </button>
        )}
        {/* No tabs until one has been opened: the launcher alone offers them then. */}
        {(made.length > 0 || tab !== null) && (
          <div role="tablist" aria-label="Side panel" className="panel-tablist">
            {TABS.map((t) => (
              <button
                key={t.tab}
                role="tab"
                id={`panel-tab-${t.tab}`}
                aria-selected={tab === t.tab}
                aria-controls={`panel-${t.tab}`}
                className="panel-tab"
                title={t.title}
                onClick={() => onTab(t.tab)}
              >
                <t.Icon size={14} />
                <span className="panel-tab-label">{t.label}</span>
                {running[t.tab] && <span className="dot run-dot" role="img" aria-label={typeof running[t.tab] === "string" ? (running[t.tab] as string) : "(running)"} />}
              </button>
            ))}
          </div>
        )}
        <button className={`icon-btn panel-new ${tab === null ? "on" : ""}`} title="Open a surface" onClick={() => onTab(null)}>
          <Plus size={16} />
        </button>
        <button className="icon-btn panel-close" title="Close the side panel" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {TABS.filter((t) => made.includes(t.tab)).map((t) => (
        <div key={t.tab} role="tabpanel" id={`panel-${t.tab}`} aria-labelledby={`panel-tab-${t.tab}`} className={`panel-body panel-${t.tab}`} hidden={tab !== t.tab}>
          {tabs[t.tab](shown && tab === t.tab)}
        </div>
      ))}
      {tab === null && <Launcher onTab={onTab} />}
    </aside>
  );
}

const launcherRows = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLButtonElement>(".panel-launcher-row") ?? [])];

/** What the panel shows before a tab is picked, and after +: each tab as a row with its key. */
function Launcher({ onTab }: { onTab: (t: PanelTab) => void }) {
  return (
    <div className="panel-body panel-launcher">
      <h2 id="panel-launcher-title">Open a surface</h2>
      <ul aria-labelledby="panel-launcher-title">
        {TABS.map((t) => (
          <li key={t.tab}>
            <button className="panel-launcher-row" title={t.title} aria-keyshortcuts={t.key} onClick={() => onTab(t.tab)}>
              <t.Icon size={18} />
              <span>{t.label}</span>
              <kbd aria-hidden>{t.key}</kbd>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The panel's left edge: drag it, or focus it and use the arrow keys, to make the panel wider or narrower. */
function ResizeHandle({
  width,
  maxWidth,
  onResize,
  onDragging,
}: {
  width: number;
  maxWidth: number;
  onResize: (width: number, done: boolean) => void;
  onDragging: (on: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, PANE_MIN_WIDTH), Math.max(PANE_MIN_WIDTH, maxWidth)));
  const move = (e: ReactPointerEvent, done: boolean) => {
    if (!start.current) return;
    // The panel is on the right, so dragging its edge left makes it wider.
    onResize(clamp(start.current.width + start.current.x - e.clientX), done);
    if (done) {
      start.current = null;
      onDragging(false);
    }
  };
  return (
    <div
      className="preview-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={Math.max(PANE_MIN_WIDTH, maxWidth)}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width };
        onDragging(true);
      }}
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => move(e, true)}
      onPointerCancel={(e) => move(e, true)}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowLeft"
            ? width + KEY_STEP
            : e.key === "ArrowRight"
              ? width - KEY_STEP
              : e.key === "Home"
                ? maxWidth
                : e.key === "End"
                  ? PANE_MIN_WIDTH
                  : undefined;
        if (next === undefined) return;
        e.preventDefault();
        onResize(clamp(next), true);
      }}
    />
  );
}
