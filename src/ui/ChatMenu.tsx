// Right-click menus: the one a chat row opens on right-click, the Menu key or Shift+F10, and the shell the status bar's
// menu uses too. Escape or a click elsewhere closes one, and focus goes back to what had it. The arrow keys move
// between a menu's items, and an item's letter (`aria-keyshortcuts`) picks it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlarmClock, AlarmClockOff, AppWindow, Archive, ArchiveRestore, CalendarClock, Check, Columns2, Hourglass, Link2, PanelLeft, PanelRight, Pencil, Pin, PinOff, Sparkles, Tag as TagIcon, Trash2 } from "lucide-react";
import type { Chat } from "../hermes/model";
import type { Project } from "../hermes/projects";
import { snoozePresets, wakeFull } from "../hermes/snooze";
import type { Tag } from "../hermes/tags";
import { useReturnFocus } from "./bits";

/** The profile's projects, for the chat menu: which ones the chat is in, and putting it in one or taking it out. */
export type ChatProjects = {
  list: Project[];
  of: Set<string>;
  /** Projects whose change for this chat waits for Hermes, or conflicts with another computer's (ADR 0033). */
  waiting?: Set<string>;
  onToggle: (projectId: string, inProject: boolean) => void;
};

/** The profile's tags, for the chat menu: which ones the chat has, putting one on or taking it off, and the tag editor. */
export type ChatTags = { list: Tag[]; of: readonly string[]; onToggle: (tagId: string, on: boolean) => void; onManage: () => void };

/**
 * Snoozing the chat from its menu (snooze.ts): `until`, when a snoozed chat wakes; `onSnooze` snoozes it until a time,
 * `onCustom` asks when, and `onWake` wakes it now.
 */
export type ChatSnooze = { until?: number; onSnooze: (until: number) => void; onCustom: () => void; onWake: () => void };

/**
 * Settling the chat, or unsettling it (ADR 0002). Settling is also how a chat is cleared from the Inbox (ADR 0090);
 * unsettling puts it back in the Inbox.
 */
export type ChatSettle = { settled: boolean; onSettle: (settled: boolean) => void };

/** Pinning the chat to the top of the list, or unpinning it (snooze.ts `PinStore`, ADR 0085). */
export type ChatPin = { pinned: boolean; onPin: (pinned: boolean) => void };

/** Stop waiting on the work the chat handed off (dispatched.ts), on this computer only; `label` says what it waits on. */
export type ChatStopWaiting = { label: string; onStop: () => void };

/** The Pin or Unpin item of a chat's menus, which P picks while the menu is open. */
export function PinItem({ pin, onClose }: { pin: ChatPin; onClose: () => void }) {
  return (
    <button
      role="menuitem"
      className="menu-item"
      aria-keyshortcuts="P"
      title={pin.pinned ? "Put this chat back in its place in the list" : "Keep this chat at the top of the list"}
      onClick={() => {
        onClose();
        pin.onPin(!pin.pinned);
      }}
    >
      <span className="menu-icon">{pin.pinned ? <PinOff size={15} /> : <Pin size={15} />}</span>
      <span className="menu-label">{pin.pinned ? "Unpin" : "Pin"}</span>
      <kbd aria-hidden>P</kbd>
    </button>
  );
}

/**
 * The right-click menu for one chat, at the pointer, kept inside the window. `onRename` and `onRegenTitle` hand back
 * to the row. `onOpenIn` opens the chat in the left (0) or right (1) pane; with one pane (`split` false) the menu offers
 * to open it in a second pane. `onCopyLink` copies the chat's link (chatLinks.ts). `onDelete` asks before deleting the
 * chat; it's left out while a reply runs. The arrow keys move between its items.
 */
export function ChatMenu({
  chat,
  x,
  y,
  split = false,
  onOpenIn,
  onOpenTab,
  onRename,
  onRegenTitle,
  onCopyLink,
  projects,
  tags,
  snooze,
  settle,
  pin,
  stopWaiting,
  onDelete,
  onClose,
}: {
  chat: Chat;
  x: number;
  y: number;
  split?: boolean;
  onOpenIn?: (side: number) => void;
  /** Opens the chat in a new tab of the active pane. */
  onOpenTab?: () => void;
  onRename: () => void;
  onRegenTitle: () => void;
  onCopyLink?: () => void;
  projects?: ChatProjects;
  tags?: ChatTags;
  snooze?: ChatSnooze;
  settle?: ChatSettle;
  pin?: ChatPin;
  stopWaiting?: ChatStopWaiting;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const now = Date.now();
  const snoozedUntil = snooze?.until !== undefined && snooze.until > now ? snooze.until : undefined;
  return (
    <Menu label={`Actions for ${chat.title}`} x={x} y={y} onClose={onClose}>
      <button
        role="menuitem"
        className="menu-item"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <span className="menu-icon">
          <Pencil size={15} />
        </span>
        <span className="menu-label">Rename…</span>
      </button>
      <button
        role="menuitem"
        className="menu-item"
        title="Ask Hermes for a new title from the last five messages"
        onClick={() => {
          onClose();
          onRegenTitle();
        }}
      >
        <span className="menu-icon">
          <Sparkles size={15} />
        </span>
        <span className="menu-label">Regenerate title</span>
      </button>
      {onCopyLink && (
        <button
          role="menuitem"
          className="menu-item"
          title="Copy a link that opens this chat in Hermes Chat on this computer"
          onClick={() => {
            onClose();
            onCopyLink();
          }}
        >
          <span className="menu-icon">
            <Link2 size={15} />
          </span>
          <span className="menu-label">Copy chat link</span>
        </button>
      )}
      {onOpenTab && (
        <button
          role="menuitem"
          className="menu-item"
          onClick={() => {
            onClose();
            onOpenTab();
          }}
        >
          <span className="menu-icon">
            <AppWindow size={15} />
          </span>
          <span className="menu-label">Open in a new tab</span>
        </button>
      )}
      {onOpenIn &&
        (split
          ? [
              { side: 0, label: "Open in left pane", icon: <PanelLeft size={15} /> },
              { side: 1, label: "Open in right pane", icon: <PanelRight size={15} /> },
            ]
          : [{ side: 1, label: "Open in a second pane", icon: <Columns2 size={15} /> }]
        ).map((o) => (
          <button
            key={o.side}
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose();
              onOpenIn(o.side);
            }}
          >
            <span className="menu-icon">{o.icon}</span>
            <span className="menu-label">{o.label}</span>
          </button>
        ))}
      {pin && <PinItem pin={pin} onClose={onClose} />}
      {stopWaiting && (
        <button
          role="menuitem"
          className="menu-item"
          title={`${stopWaiting.label}. Put this chat in the Inbox without waiting; nothing on Hermes is cancelled`}
          onClick={() => {
            onClose();
            stopWaiting.onStop();
          }}
        >
          <span className="menu-icon">
            <Hourglass size={15} />
          </span>
          <span className="menu-label">Stop waiting</span>
        </button>
      )}
      {settle && (
        <button
          role="menuitem"
          className="menu-item"
          title={settle.settled ? "Move this chat back to the Inbox" : "Clear this chat from the Inbox into Settled"}
          onClick={() => {
            onClose();
            settle.onSettle(!settle.settled);
          }}
        >
          <span className="menu-icon">{settle.settled ? <ArchiveRestore size={15} /> : <Archive size={15} />}</span>
          <span className="menu-label">{settle.settled ? "Unsettle" : "Settle"}</span>
        </button>
      )}
      {snooze && (
        <div role="group" aria-label="Snooze" className="menu-group">
          <div className="menu-heading" aria-hidden>
            {snoozedUntil !== undefined ? `Snoozed until ${wakeFull(snoozedUntil)}` : "Snooze"}
          </div>
          {snoozedUntil !== undefined ? (
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onClose();
                snooze.onWake();
              }}
            >
              <span className="menu-icon">
                <AlarmClockOff size={15} />
              </span>
              <span className="menu-label">Unsnooze</span>
            </button>
          ) : (
            <>
              {snoozePresets(now).map((p) => (
                <button
                  key={p.key}
                  role="menuitem"
                  className="menu-item"
                  title={`Until ${wakeFull(p.until)}`}
                  onClick={() => {
                    onClose();
                    snooze.onSnooze(p.until);
                  }}
                >
                  <span className="menu-icon">
                    <AlarmClock size={15} />
                  </span>
                  <span className="menu-label">{p.label}</span>
                </button>
              ))}
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  onClose();
                  snooze.onCustom();
                }}
              >
                <span className="menu-icon">
                  <CalendarClock size={15} />
                </span>
                <span className="menu-label">Custom…</span>
              </button>
            </>
          )}
        </div>
      )}
      {!!projects?.list.length && (
        <div role="group" aria-label="Projects" className="menu-group">
          <div className="menu-heading" aria-hidden>
            Projects
          </div>
          {projects.list.map((p) => {
            const on = projects.of.has(p.id);
            return (
              <button
                key={p.id}
                role="menuitemcheckbox"
                aria-checked={on}
                className="menu-item"
                title={on ? `Take this chat out of ${p.name}` : `Put this chat in ${p.name}`}
                onClick={() => {
                  onClose();
                  projects.onToggle(p.id, !on);
                }}
              >
                <span className="menu-icon">{on && <Check size={15} />}</span>
                <span className="menu-label">{p.name}</span>
                {projects.waiting?.has(p.id) && <span className="menu-hint">waiting to sync</span>}
              </button>
            );
          })}
        </div>
      )}
      {tags && (
        <div role="group" aria-label="Tags" className="menu-group">
          <div className="menu-heading" aria-hidden>
            Tags
          </div>
          {tags.list.map((t) => {
            const on = tags.of.includes(t.id);
            return (
              <button
                key={t.id}
                role="menuitemcheckbox"
                aria-checked={on}
                className="menu-item"
                title={on ? `Take the tag ${t.name} off this chat` : `Tag this chat ${t.name}`}
                onClick={() => {
                  onClose();
                  tags.onToggle(t.id, !on);
                }}
              >
                <span className="menu-icon">{on && <Check size={15} />}</span>
                <span className="menu-label">{t.name}</span>
              </button>
            );
          })}
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose();
              tags.onManage();
            }}
          >
            <span className="menu-icon">
              <TagIcon size={15} />
            </span>
            <span className="menu-label">{tags.list.length ? "Edit tags…" : "Add a tag…"}</span>
          </button>
        </div>
      )}
      {onDelete && (
        <>
          <div className="menu-sep" role="separator" />
          <button
            role="menuitem"
            className="menu-item danger"
            title="Delete this chat in every Hermes client. This can't be undone."
            onClick={() => {
              onClose();
              onDelete();
            }}
          >
            <span className="menu-icon">
              <Trash2 size={15} />
            </span>
            <span className="menu-label">Delete chat…</span>
          </button>
        </>
      )}
    </Menu>
  );
}

/** A menu at the pointer, kept inside the window, its first item focused. */
export function Menu({ label, x, y, onClose, children }: { label: string; x: number; y: number; onClose: () => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useReturnFocus();

  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    menu.current!.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => menu.current?.contains(e.target as Node) || onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("wheel", away, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("wheel", away);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      // The menu sits inside what opened it, which would open another menu.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "Tab") e.preventDefault();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [...menu.current!.querySelectorAll<HTMLElement>("[role^=menuitem]")];
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const item = menu.current!.querySelector<HTMLElement>(`[role^=menuitem][aria-keyshortcuts="${CSS.escape(e.key.toUpperCase())}"]`);
          if (item) {
            e.preventDefault();
            item.click();
          }
        }
      }}
    >
      {children}
    </div>
  );
}
