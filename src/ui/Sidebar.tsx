// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A, with the profile's tools in one
// Server group and tips that show at once (ADR 0050, 0116). Server files and the Terminal live in the side panel only. The list's header is the profile switcher. Settings opens from the
// rail's foot. Right-clicking a chat opens its menu (ChatMenu.tsx).
import { memo, useCallback, useEffect, useId, useReducer, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BarChart3, Bot as BotIcon, Building2, CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileOutput, Hourglass, LockOpen, Pin, Search, Settings, SquarePen, Trash2, Webhook, FolderGit2 } from "lucide-react";
import { waitingLabel, type Handoff } from "../hermes/dispatched";
import type { Chat, CheckTimes, ConnectionStatus, OtherProfile, OtherProfiles } from "../hermes/model";
import { SOURCE_LABEL, isWaiting } from "../hermes/model";
import { CHECK_EVERY_MS, totalUnread, type CheckTimesStore } from "../hermes/otherProfiles";
import type { Route } from "../hermes/pipe";
import { RenameConflict, TitleModelUnavailable, type Snapshot } from "../hermes/transport";
import { SECTION_LABEL, chatSections, inboxSettle, settleByDrop, wakeFull, wakeLabel, type InboxSettle, type Pins, type SectionKey, type Snoozes } from "../hermes/snooze";
import { getUIPrefs, setUIPrefs, subscribe as subscribeUIPrefs } from "../hermes/uiPrefs";
import { ChatMenu, type ChatPin, type ChatProjects, type ChatSnooze, type ChatTags } from "./ChatMenu";
import { SnoozeDialog, useSnoozeClock } from "./Snooze";
import { DeleteChatDialog } from "./DeleteChat";
import { SettleAllDialog } from "./SettleAll";
import { CloneProfileDialog } from "./CloneProfile";
import type { ProfileCloneApi } from "../hermes/profileClone";
import { Age, ArchiveButton, STATUS_LABEL, SettleButton, SourceIcon, Spinner, ago, composing, routeLabel, useReturnFocus } from "./bits";
import { useLocale, type Locale } from "../i18n/locale";
import { viaLabel } from "../hermes/routes";
import { dragChat, dragChatEnd, rowDragged } from "./Tabs";
import { errorText } from "../hermes/values";



export function Rail({
  status,
  route,
  unsecure,
  closedReason,
  onReconnect,
  onToggleList,
  onNew,
  onSearch,
  onBots,
  botsOpen = false,
  botsNeedYou = false,
  onOffice,
  officeOpen = false,
  onOutputs,
  outputsOpen = false,
  onSettings,
  settingsOpen = false,
  onJobs,
  jobsOpen = false,
  onAutomations,
  automationsOpen = false,
  onUsage,
  usageOpen = false,
  onRepo,
  repoOpen = false,
  updateWaiting = false,
  connectionsMenu,
  connectionName,
}: {
  status: ConnectionStatus;
  route?: Route;
  /** The connection in use's name, shown with the route it is using when it has several ("Home server · via Tailscale"). */
  connectionName?: string;
  unsecure: boolean;
  closedReason?: string;
  onReconnect: () => void;
  onToggleList: () => void;
  onNew: () => void;
  onSearch: () => void;
  /** Opens or closes the Bots view (Bots.tsx, ADR 0066); none when this Hermes has no Bot Mode. `botsNeedYou`: a bot waits on the owner. */
  onBots?: () => void;
  botsOpen?: boolean;
  botsNeedYou?: boolean;
  /** Opens or closes the agent office (Office.tsx, ADR 0077); none while Settings turns it off. */
  onOffice?: () => void;
  officeOpen?: boolean;
  /** Opens Outputs, the files Hermes's tools wrote (Outputs.tsx). */
  onOutputs?: () => void;
  outputsOpen?: boolean;
  onSettings: () => void;
  settingsOpen?: boolean;
  /** Opens Scheduled jobs: Hermes's jobs for the profile, which it runs on the server. */
  onJobs?: () => void;
  jobsOpen?: boolean;
  /** Opens Automations: Hermes's webhook routes for the profile, which start tasks on the server (Automations.tsx). */
  onAutomations?: () => void;
  automationsOpen?: boolean;
  /** Opens Usage analytics: tokens and recorded cost across chats, models, projects and profiles (UsageAnalytics.tsx). */
  onUsage?: () => void;
  usageOpen?: boolean;
  /** Opens or closes the Repository screen: a Git checkout on the server, through the owner's ssh (Repository.tsx). */
  onRepo?: () => void;
  repoOpen?: boolean;
  /** An update is ready to install or restart into (Settings → Updates). */
  updateWaiting?: boolean;
  /** The recent-connection picker (Connections.tsx `RailConnections`), above the connection's status. */
  connectionsMenu?: ReactNode;
}) {
  const where = routeLabel(route);
  // The connection's full wording lives only in its tip (ADR 0001).
  const connNote = [
    route?.via && [connectionName, viaLabel(route.via)].filter(Boolean).join(" · "),
    where,
    unsecure && "Unsecure: traffic to the server isn't encrypted",
    status !== "connected" && closedReason,
    // The first try at launch is still under way (ADR 0089); a click would only join it.
    status !== "connected" && status !== "connecting" && "Click to reconnect",
  ]
    .filter(Boolean)
    .join(" · ");
  const connLabel = [STATUS_LABEL[status], connNote].filter(Boolean).join(" · ");
  const { shown, bind, hide, tipProps, descriptions } = useRailTip();
  const server = [
    onOutputs && (
      <button key="outputs" className={`icon-btn ${outputsOpen ? "on" : ""}`} aria-label="Outputs" aria-pressed={outputsOpen} onClick={onOutputs} {...bind("outputs", { label: "Outputs", note: "Files Hermes made" })}>
        <FileOutput size={18} />
      </button>
    ),
    onRepo && (
      <button key="repo" className={`icon-btn ${repoOpen ? "on" : ""}`} aria-label="Repository" aria-pressed={repoOpen} onClick={onRepo} {...bind("repo", { label: "Repository", note: "Git changes on the server" })}>
        <FolderGit2 size={18} />
      </button>
    ),
    onJobs && (
      <button key="jobs" className={`icon-btn ${jobsOpen ? "on" : ""}`} aria-label="Scheduled jobs" aria-pressed={jobsOpen} onClick={onJobs} {...bind("jobs", { label: "Scheduled jobs", note: "Tasks Hermes runs on a schedule" })}>
        <CalendarClock size={18} />
      </button>
    ),
    onAutomations && (
      <button key="automations" className={`icon-btn ${automationsOpen ? "on" : ""}`} aria-label="Automations" aria-pressed={automationsOpen} onClick={onAutomations} {...bind("automations", { label: "Automations", note: "Tasks started by GitHub events" })}>
        <Webhook size={18} />
      </button>
    ),
    onUsage && (
      <button key="usage" className={`icon-btn ${usageOpen ? "on" : ""}`} aria-label="Usage" aria-pressed={usageOpen} onClick={onUsage} {...bind("usage", { label: "Usage", note: "Tokens and recorded cost" })}>
        <BarChart3 size={18} />
      </button>
    ),
  ].filter(Boolean);
  // Daily tools first, then the profile's tools in one labeled group (ADR 0050, 0116).
  const parts = (
    <>
      <div className="rail-top">
        <button className="rail-brand" aria-label="Hide or show chats" aria-keyshortcuts="Control+B" onClick={onToggleList} {...bind("brand", { label: "Hide or show chats", keys: "Ctrl+B" })}>
          H
        </button>
        <button className="icon-btn rail-primary" aria-label="New chat (Ctrl+N)" aria-keyshortcuts="Control+N" onClick={onNew} {...bind("new", { label: "New chat", keys: "Ctrl+N" })}>
          <SquarePen size={18} />
        </button>
        <button className="icon-btn rail-primary" aria-label="Search all chats (Ctrl+K)" aria-keyshortcuts="Control+K" onClick={onSearch} {...bind("search", { label: "Search all chats", keys: "Ctrl+K" })}>
          <Search size={18} />
        </button>
        {onBots && (
          <button
            className={`icon-btn rail-primary bots-btn ${botsOpen ? "on" : ""}`}
            aria-label={botsNeedYou ? "Bots, one needs you" : "Bots"}
            aria-expanded={botsOpen}
            onClick={onBots}
            {...bind("bots", { label: "Bots", note: botsNeedYou ? "A bot needs you" : "Each profile as a bot, with its Bot Chat" })}
          >
            <BotIcon size={18} />
            {botsNeedYou && <span className="dot" aria-hidden />}
          </button>
        )}
        {onOffice && (
          <button
            className={`icon-btn rail-primary office-btn ${officeOpen ? "on" : ""}`}
            aria-label="Office"
            aria-expanded={officeOpen}
            onClick={onOffice}
            {...bind("office", { label: "Office", note: "Every agent at work, in the building or a list" })}
          >
            <Building2 size={18} />
          </button>
        )}
      </div>
      <div className="rail-mid" onScroll={hide}>
        {server.length > 0 && (
          <div className="rail-group" role="group" aria-label="Server">
            <span className="rail-group-label" aria-hidden>Server</span>
            {server}
          </div>
        )}
      </div>
      <div className="rail-bottom">
        {connectionsMenu}
        <button className="conn-btn" aria-label={connLabel} onClick={() => status !== "connected" && onReconnect()} {...bind("conn", { label: STATUS_LABEL[status], note: connNote || undefined, describe: false })}>
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          {unsecure && <LockOpen className="conn-lock" size={9} strokeWidth={2.8} />}
        </button>
        <button
          className={`icon-btn settings-btn ${settingsOpen ? "on" : ""}`}
          aria-label={updateWaiting ? "Settings: an update is ready" : "Settings"}
          aria-keyshortcuts="Control+,"
          aria-pressed={settingsOpen}
          onClick={onSettings}
          {...bind("settings", { label: "Settings", keys: "Ctrl+,", note: updateWaiting ? "An update is ready" : "Import, backup and more" })}
        >
          <Settings size={18} />
          {updateWaiting && <span className="dot update-dot" />}
        </button>
      </div>
    </>
  );
  const tip = shown();
  return (
    <aside className="rail">
      {parts}
      {descriptions()}
      {/* On the page itself, so a screen the rail sits under (the Inbox) can't cover it. */}
      {tip &&
        createPortal(
          <div className="rail-tip" role="tooltip" aria-hidden style={{ top: tip.top, left: tip.left }} {...tipProps}>
            <span className="rail-tip-label">{tip.label}</span>
            {tip.keys && <kbd>{tip.keys}</kbd>}
            {tip.note && <span className="rail-tip-note">{tip.note}</span>}
          </div>,
          document.body,
        )}
    </aside>
  );
}

/** Between a rail button and its tip; the tip's `::before` bridges it (styles.css). */
const TIP_GAP = 10;

/** `describe` false: the button's own name already says what `note` does. */
type RailTip = { label: string; keys?: string; note?: string; describe?: boolean };

/**
 * The rail's one tip: it shows at once beside the button under the pointer or keyboard focus, with the button's name,
 * its shortcut and a line about it. It stays while the pointer is on the button or the tip, and goes on leaving both,
 * blurring, scrolling or Escape. Screen readers get the same from the button: its name, `aria-keyshortcuts`, and the
 * line as its description, so the tip itself is hidden from them.
 */
function useRailTip() {
  const id = useId();
  const [at, setAt] = useState<{ key: string; top: number; left: number }>();
  const tipRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const hide = useCallback(() => setAt(undefined), []);
  useEffect(() => {
    if (!at) return;
    // Captured, so a focused element that keeps its keys to itself (the Terminal) can't keep the tip up.
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", hide);
    };
  }, [at, hide]);
  /** Leaving for `into` (the tip, or its button) keeps the tip. */
  const leave = (into: () => Element | null | undefined) => (e: ReactMouseEvent) => {
    const to = e.relatedTarget;
    if (to instanceof Node && into()?.contains(to)) return;
    hide();
  };
  const tips: Record<string, RailTip> = {};
  const noteId = (key: string) => `${id}-tip-${key}`;
  const bind = (key: string, t: RailTip) => {
    tips[key] = t;
    const show = (e: { currentTarget: HTMLElement }) => {
      trigger.current = e.currentTarget;
      const r = e.currentTarget.getBoundingClientRect();
      // Beside the button's own edge, whatever size the window gives it, so the tip's bridge always reaches it.
      setAt({ key, top: r.top + r.height / 2, left: r.right + TIP_GAP });
    };
    return {
      onMouseEnter: show,
      onFocus: show,
      onMouseLeave: leave(() => tipRef.current),
      onBlur: hide,
      "aria-describedby": t.note && t.describe !== false ? noteId(key) : undefined,
    };
  };
  /** The tip showing, read after every `bind` of the render. */
  const shown = () => (at && tips[at.key] ? { ...tips[at.key], top: at.top, left: at.left } : undefined);
  /** The buttons' descriptions, out of sight; read after every `bind` of the render. */
  const descriptions = () => (
    <div hidden>
      {Object.entries(tips).map(([key, t]) => t.note && t.describe !== false && <span key={key} id={noteId(key)}>{t.note}</span>)}
    </div>
  );
  const tipProps = { ref: tipRef, onMouseLeave: leave(() => trigger.current) };
  return { shown, bind, hide, tipProps, descriptions };
}

/**
 * The chat's title in a text box. Enter saves it, and the box stays until Hermes has read the new title back. If
 * saving fails the typed title stays, with why; if the chat was renamed elsewhere, the list shows that title and only
 * another Enter replaces it. Escape, or clicking away before changing anything, keeps the old title.
 */
function RenameRow({
  chat,
  selected,
  hidden,
  onRename,
  onDone,
}: {
  chat: Chat;
  selected: boolean;
  hidden?: boolean;
  onRename: (title: string, from: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(chat.title);
  // The title being replaced: after a conflict, the one the server has now.
  const [from, setFrom] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    onRename(draft, from).then(onDone, (e) => {
      if (e instanceof RenameConflict) setFrom(e.title);
      setError(errorText(e));
      setSaving(false);
    });
  };
  return (
    <div className={`row renaming ${selected ? "sel" : ""}`} hidden={hidden}>
      <input
        className="row-rename"
        aria-label="Chat title"
        aria-invalid={!!error}
        autoFocus
        value={draft}
        readOnly={saving}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (composing(e)) return;
          if (e.key === "Enter") save();
          else if (e.key === "Escape" && !saving) onDone();
        }}
        onBlur={() => !saving && draft.trim() === from && onDone()}
      />
      {saving && <Spinner />}
      {error && (
        <div className="row-rename-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * One chat in the list: a button that opens it, then its Settle, Archive and Delete buttons. Right-clicking it, or the
 * Menu key or Shift+F10 on it, opens its menu. The trash button, Delete chat… in the menu, and Delete or Backspace on
 * the focused row all ask before deleting (`onAskDelete`, with what focus goes back to if the owner keeps the chat).
 * An archived chat has Restore in place of Settle and Archive. A chat with
 * a reply running can't be archived, restored or deleted. `snooze`: the chat can be snoozed from its menu. A snoozed
 * chat shows when it wakes in place of its age. `section`: where the list shows it, for styling. Regenerate title in the menu shows a spinner until the new
 * title is saved, and why underneath if it isn't. When Hermes can't use the Text generation model's provider, that
 * note says how to fix it and offers the setting.
 */
const ChatRow = memo(function ChatRow({
  chat,
  selected,
  alsoShown,
  split,
  onOpen,
  onOpenIn,
  onOpenTab,
  onSettle,
  onArchive,
  onAskDelete,
  onRename,
  onRegenTitle,
  onCopyLink,
  onTextGenerationSettings,
  projects,
  tags,
  snooze,
  pin,
  handoff,
  onStopWaiting,
  section,
  hidden,
  sleepsUntil,
  wake,
}: {
  chat: Chat;
  selected: boolean;
  /** The chat is in the pane that isn't active. */
  alsoShown: boolean;
  split: boolean;
  onOpen: () => void;
  /** Opens the chat in the left (0) or right (1) pane. */
  onOpenIn: (side: number) => void;
  /** Opens the chat in a new tab of the active pane. */
  onOpenTab: () => void;
  onSettle: (settled: boolean) => void;
  onArchive: (archived: boolean) => void;
  onAskDelete: (returnTo: HTMLElement | null) => void;
  onRename: (title: string, from: string) => Promise<unknown>;
  onRegenTitle: () => Promise<unknown>;
  /** Copies the chat's link (chatLinks.ts). */
  onCopyLink?: () => void;
  /** Opens Settings → Model at the Text generation model. */
  onTextGenerationSettings?: () => void;
  projects?: ChatProjects;
  tags?: ChatTags;
  snooze?: ChatSnooze;
  pin?: ChatPin;
  /** The work the chat handed off and waits on, or that needs the owner (dispatched.ts). */
  handoff?: Handoff;
  /** Stops waiting on that work, on this computer only. */
  onStopWaiting?: () => void;
  section?: string;
  /** In a collapsed section: kept, with its rename box or menu, but out of sight. */
  hidden?: boolean;
  sleepsUntil?: number;
  /** When the snoozed chat wakes, as the row shows it. */
  wake?: string;
}) {
  const l = useLocale();
  const [renaming, setRenaming] = useState(false);
  const waiting = !chat.running && handoff?.kind === "waiting" ? waitingLabel(handoff) : undefined;
  const [retitling, setRetitling] = useState(false);
  /** Why the title wasn't regenerated. `detail`: Hermes's own words; `settings`: the fix is the Text generation model. */
  const [retitleError, setRetitleError] = useState<{ text: string; detail?: string; settings?: boolean }>();
  const regenTitle = () => {
    if (retitling) return;
    setRetitling(true);
    setRetitleError(undefined);
    onRegenTitle()
      .catch((e) =>
        setRetitleError(
          e instanceof RenameConflict
            ? { text: `This chat was renamed in another Hermes client meanwhile, to "${e.title}". Regenerate again to replace it.` }
            : e instanceof TitleModelUnavailable
              ? { text: `Couldn't regenerate the title: ${e.message}`, detail: e.detail, settings: true }
              : { text: `Couldn't regenerate the title: ${errorText(e)}` },
        ),
      )
      .finally(() => setRetitling(false));
  };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openButton = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  // The rename box replaces the row; once it closes, focus goes back to the chat unless the owner moved it elsewhere.
  useEffect(() => {
    const now = document.activeElement;
    if (wasRenaming.current && !renaming && (!now || now === document.body)) openButton.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);
  if (renaming) return <RenameRow chat={chat} selected={selected} hidden={hidden} onRename={onRename} onDone={() => setRenaming(false)} />;
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${alsoShown ? "shown" : ""} ${chat.unread ? "unread" : ""} ${menu ? "menu-open" : ""} ${retitleError ? "retitle-failed" : ""} ${retitling ? "retitling" : ""}`}
      data-section={section}
      hidden={hidden}
      onContextMenu={(e) => {
        e.preventDefault();
        setRetitleError(undefined);
        // From the keyboard the event has no pointer position, so the menu opens under the row.
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom });
      }}
      onKeyDown={(e) => {
        // WebKitGTK sends no contextmenu event for Shift+F10.
        if ((e.key === "F10" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) || e.key === "ContextMenu") {
          e.preventDefault();
          setRetitleError(undefined);
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left + 8, y: r.bottom });
        }
      }}
    >
      <button
        ref={openButton}
        className="row-open"
        data-chat={chat.id}
        aria-current={selected || undefined}
        // Dragged onto a pane's tabs or edge, the chat opens in a new tab or a split there (Tabs.tsx).
        draggable
        onDragStart={(e) => dragChat(e, chat.id)}
        onDragEnd={dragChatEnd}
        title={`${retitling ? "Writing a new title…" : chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}${pin?.pinned ? " (pinned)" : ""}${alsoShown ? " (in the other pane)" : ""}${sleepsUntil ? ` (snoozed until ${wakeFull(sleepsUntil, l.tag)})` : ""}`}
        onClick={() => {
          setRetitleError(undefined);
          onOpen();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !chat.running) {
            e.preventDefault();
            onAskDelete(e.currentTarget);
          }
        }}
      >
        {chat.source !== "app" && <SourceIcon source={chat.source} />}
        <span className="row-title">{chat.title}</span>
        {pin?.pinned && (
          <span className="row-pin" role="img" aria-label="Pinned">
            <Pin size={12} />
          </span>
        )}
        <span className="row-meta">
          {wake && <span className="row-wake">{wake}</span>}
          {handoff?.kind === "needsOwner" && (
            <span className="row-owner" role="img" aria-label={handoff.reason} title={handoff.reason}>
              <CircleAlert size={12} />
            </span>
          )}
          {chat.running || retitling ? (
            <Spinner />
          ) : waiting ? (
            <span className="row-wait" role="img" aria-label={waiting} title={waiting}>
              <Hourglass size={12} />
            </span>
          ) : chat.unread ? (
            <span className="dot" title="Unread" />
          ) : (
            !sleepsUntil && <Age at={chat.updatedAt} />
          )}
        </span>
      </button>
      {!chat.archived && (
        <SettleButton
          settled={chat.settled}
          size={14}
          className="row-action"
          onSettle={onSettle}
        />
      )}
      {!chat.running && <ArchiveButton archived={!!chat.archived} size={14} className="row-action" onArchive={onArchive} />}
      {!chat.running && (
        <button
          className="row-action"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onAskDelete(e.currentTarget);
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
      {menu && (
        <ChatMenu
          chat={chat}
          projects={projects}
          tags={tags}
          x={menu.x}
          y={menu.y}
          split={split}
          snooze={snooze}
          settle={chat.archived ? undefined : { settled: chat.settled, onSettle }}
          pin={pin}
          stopWaiting={waiting && onStopWaiting ? { label: waiting, onStop: onStopWaiting } : undefined}
          onOpenIn={onOpenIn}
          onOpenTab={onOpenTab}
          onRename={() => setRenaming(true)}
          onRegenTitle={regenTitle}
          onCopyLink={onCopyLink}
          onDelete={chat.running ? undefined : () => onAskDelete(openButton.current)}
          onClose={closeMenu}
        />
      )}
      {retitleError && (
        <div className="row-rename-error" role="alert" title={retitleError.detail && `Hermes said: ${retitleError.detail}`}>
          {retitleError.text}
          {retitleError.settings && onTextGenerationSettings && (
            <button
              className="link-btn row-error-action"
              onClick={() => {
                setRetitleError(undefined);
                onTextGenerationSettings();
              }}
            >
              Text generation settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}, sameRowProps);

function sameRowProps(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Set) return b instanceof Set && a.size === b.size && [...a].every((x) => b.has(x));
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameRowProps(x, b[i]));
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameRowProps(a[k], b[k]));
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

const unreadCount = (p: OtherProfile) => `${p.unread}${p.more ? "+" : ""}`;
const CHECKED_EVERY = `Other profiles are checked every ${CHECK_EVERY_MS / 60_000} minutes`;

/** What the latest check of another profile found, and when; an earlier answer is kept through a failed check. */
function otherTip(l: Locale, p?: OtherProfile, checkedAt?: number): string {
  const found = (q: OtherProfile) =>
    checkedAt === undefined
      ? undefined
      : `${q.unread ? `${unreadCount(q)} unread` : "No unread chats"}${q.more ? " in its most recent chats" : ""}, checked ${ago(l, checkedAt)}`;
  if (p?.error) return [`Couldn't check: ${p.error}`, found(p) && `Earlier: ${found(p)}`].filter(Boolean).join(". ");
  return (p && found(p)) ?? "Not checked yet";
}

/** The switcher's tooltip: which other profiles have Unread chats, which couldn't be checked, and how fresh it is. */
function switcherTip(l: Locale, others: OtherProfiles, times: CheckTimes): string {
  const { withUnread, failed } = totalUnread(others);
  return [
    "Switch profile",
    withUnread.length && `Unread chats in ${withUnread.map((n) => `${n} (${unreadCount(others.byName[n])})`).join(", ")}`,
    failed.length && `Couldn't check ${failed.join(", ")}`,
    others.error,
    `${CHECKED_EVERY}${times.others ? `; last ${ago(l, times.others)}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A dot and count for another profile with Unread chats, and a mark when its latest check failed; the count beside
 * the mark is from an earlier check.
 */
function OtherBadge({ info }: { info?: OtherProfile }) {
  if (!info?.unread && !info?.error) return null;
  return (
    <span className="profile-unread">
      {!!info.unread && (
        <>
          <span className="dot" />
          {unreadCount(info)}
        </>
      )}
      {info.error && <CircleAlert size={13} className="profile-unknown" />}
    </span>
  );
}

/**
 * What the owner leaves behind in `profile` by switching away now, if anything: an Approval waiting, or a reply
 * running. Hermes keeps running the reply; an Approval waits only until Hermes stops waiting (its timeout).
 */
export function leavingNote(profile: string, chats: Chat[]): string | undefined {
  if (chats.some((c) => c.items.some(isWaiting)))
    return `An approval is waiting in ${profile}. Hermes waits for your answer only until it times out: switch back and open the chat to answer it.`;
  if (chats.some((c) => c.running)) return `A reply is still running in ${profile}. Hermes keeps it going, and it shows here when you switch back.`;
}

/**
 * The current profile's name with a ▾, which opens the server's profiles with a filter box (ADR 0001). Enter picks
 * the first match; Escape or a click outside closes it. A dot on it, and a count on each profile in the menu, show
 * Unread chats in the other profiles, as the latest poll found them. Opening the menu asks for a fresh check.
 * `leaving`: what switching away now leaves behind, which the owner is asked about first. `clone`: the menu's Clone a
 * profile, whose dialog opens the profile it made through the same question. `checkTimes`: when the others were checked.
 */
function ProfileSwitcher({
  profile,
  others,
  checkTimes,
  leaving,
  onListProfiles,
  onCheckOthers,
  onSwitch,
  clone,
}: {
  profile: string;
  others: OtherProfiles;
  checkTimes: CheckTimesStore;
  leaving?: string;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitch: (name: string) => void;
  clone?: ProfileCloneApi;
}) {
  const l = useLocale();
  const [cloning, setCloning] = useState(false);
  const [open, setOpen] = useState(false);
  // The profile the owner picked while something was left behind here, and what, until they say whether to go. Kept
  // as asked, so the question stays if the reply finishes meanwhile.
  const [asking, setAsking] = useState<{ to: string; note: string }>();
  const button = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<string[]>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  // The button is always drawn, so its tooltip reads the check times as it is about to show rather than subscribing:
  // a check that finds nothing new mustn't draw it again (#423).
  const [, freshTip] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(undefined);
    onCheckOthers();
    onListProfiles().then(
      (names) => current && setProfiles(names),
      (e) => current && setError(`Couldn't list profiles: ${errorText(e)}`),
    );
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || close();
    window.addEventListener("mousedown", onDown);
    return () => {
      current = false;
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const elsewhere = totalUnread(others).unread > 0;
  const close = () => {
    setOpen(false);
    setAsking(undefined);
  };
  // The options are gone once the question shows, so focus goes back to the switcher.
  const answer = (go: boolean) => {
    const to = asking?.to;
    close();
    button.current?.focus();
    if (go && to) onSwitch(to);
  };
  const pick = (name: string) => {
    if (name === profile) close();
    else if (leaving) setAsking({ to: name, note: leaving });
    else {
      close();
      onSwitch(name);
    }
  };

  return (
    <div className="profile-switch" ref={box}>
      <button
        ref={button}
        className="profile-btn"
        title={switcherTip(l, others, checkTimes.get())}
        aria-expanded={open}
        onPointerEnter={freshTip}
        onFocus={freshTip}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="profile-name">{profile}</span>
        {elsewhere && <span className="dot" aria-label="Unread chats in other profiles" />}
        <ChevronDown size={14} className="profile-chev" />
      </button>
      {open && asking && <LeaveProfile note={asking.note} to={asking.to} onGo={() => answer(true)} onStay={() => answer(false)} />}
      {open && !asking && (
        <ProfileMenu
          profile={profile}
          profiles={profiles}
          error={error}
          others={others}
          checkTimes={checkTimes}
          onPick={pick}
          onClose={close}
          onClone={
            clone &&
            (() => {
              close();
              setCloning(true);
            })
          }
        />
      )}
      {cloning && clone && (
        <CloneProfileDialog
          api={clone}
          current={profile}
          returnTo={button}
          onClose={() => setCloning(false)}
          onOpen={(name) => {
            setCloning(false);
            // The same question as picking it from the menu, when something would be left behind here.
            setOpen(true);
            pick(name);
          }}
        />
      )}
    </div>
  );
}

/** Asks before switching to `to` while something is left behind. Stay has focus, so a stray Enter stays. */
function LeaveProfile({ note, to, onGo, onStay }: { note: string; to: string; onGo: () => void; onStay: () => void }) {
  const noteId = useId();
  return (
    <div
      className="profile-menu"
      role="alertdialog"
      aria-label={`Switch to ${to}?`}
      aria-describedby={noteId}
      onKeyDown={(e) => e.key === "Escape" && !composing(e) && onStay()}
    >
      <div className="confirm profile-leave">
        <span id={noteId}>{note}</span>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Stay
          </button>
          <button className="btn primary" onClick={onGo}>
            Switch anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A switch of profile under way, until the new profile's list is read: connecting, then loading its chats. If that
 * fails it says why, and offers to try again or go back to the profile the owner came from.
 */
function SwitchStatus({
  profile,
  switching,
  status,
  onRetry,
  onBack,
}: {
  profile: string;
  switching: NonNullable<Snapshot["switching"]>;
  status: ConnectionStatus;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className={`switch-status ${switching.error ? "failed" : ""}`} role="status" aria-label="Switching profile">
      {switching.error ? (
        <>
          <span>
            Couldn't open {profile}: {switching.error}
          </span>
          <div className="switch-actions">
            <button className="btn" onClick={onRetry}>
              Try again
            </button>
            <button className="btn" onClick={onBack}>
              Back to {switching.from}
            </button>
          </div>
        </>
      ) : (
        <span className="switch-progress">
          <Spinner />
          {status === "connected" ? `Loading ${profile}'s chats…` : `Connecting to ${profile}…`}
        </span>
      )}
    </div>
  );
}

/** The open profile menu. Closing it puts focus back on the profile button. */
function ProfileMenu({
  profile,
  profiles,
  error,
  others,
  checkTimes,
  onPick,
  onClose,
  onClone,
}: {
  profile: string;
  profiles?: string[];
  error?: string;
  others: OtherProfiles;
  checkTimes: CheckTimesStore;
  onPick: (name: string) => void;
  onClose: () => void;
  onClone?: () => void;
}) {
  const l = useLocale();
  const times = useSyncExternalStore(checkTimes.subscribe, checkTimes.get);
  const [filter, setFilter] = useState("");
  useReturnFocus();

  const shown = (profiles ?? [profile]).filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div
      className="profile-menu"
      role="listbox"
      aria-label="Profiles"
      // Escape closes it from the filter or from an option the owner tabbed to.
      onKeyDown={(e) => e.key === "Escape" && !composing(e) && onClose()}
    >
      <input
        className="profile-filter"
        autoFocus
        placeholder="Filter profiles"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && shown[0] && onPick(shown[0])}
      />
      <div className="profile-options">
        {shown.map((p) => (
          <button
            key={p}
            role="option"
            aria-selected={p === profile}
            title={p === profile ? undefined : otherTip(l, others.byName[p], times.byProfile[p])}
            className={`profile-option ${p === profile ? "on" : ""}`}
            onClick={() => onPick(p)}
          >
            <span className="row-title">{p}</span>
            {p === profile ? <Check size={14} /> : <OtherBadge info={others.byName[p]} />}
          </button>
        ))}
        {!profiles && !error && <div className="profile-hint">Loading profiles…</div>}
        {profiles && shown.length === 0 && <div className="profile-hint">No profile matches.</div>}
        {error && <div className="profile-hint err">{error}</div>}
      </div>
      {others.error && <div className="profile-hint err">{others.error}</div>}
      {profiles && profiles.length > 1 && (
        <div className="profile-hint">
          Unread checked every {CHECK_EVERY_MS / 60_000} min{times.others ? `, last ${ago(l, times.others)}` : ""}
        </div>
      )}
      {onClone && (
        <button className="profile-option profile-clone" onClick={onClone}>
          <Copy size={13} aria-hidden />
          <span className="row-title">Clone a profile…</span>
        </button>
      )}
    </div>
  );
}

/**
 * WebKitGTK sends the Menu key's contextmenu event to the point at the focused element's bottom-left corner, which is
 * just outside its row, so the list gets it instead; it goes on to the focused row, which opens its menu under itself.
 */
function menuForFocusedRow(e: ReactMouseEvent<HTMLElement>) {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.classList.contains("row-open") || !e.currentTarget.contains(focused)) return;
  if ((e.target as Element).closest(".row")) return;
  const r = focused.getBoundingClientRect();
  if (Math.round(e.clientX) !== Math.round(r.left) || Math.round(e.clientY) !== Math.round(r.bottom)) return;
  e.preventDefault();
  focused.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/** Up and Down move focus between the chats in the list, top to bottom through its sections, without opening them. */
function moveBetweenChats(e: KeyboardEvent<HTMLElement>) {
  // Alt+arrows open the chat above or below instead (App.tsx), so they pass.
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || !(e.target as Element).classList.contains("row-open")) return;
  e.preventDefault();
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".row-open")).filter((r) => !r.closest("[hidden]"));
  rows[rows.indexOf(e.target as HTMLButtonElement) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/**
 * The chat list, in sections (snooze.ts `chatSections`, ADR 0063): Pinned, the chats the owner pinned (ADR 0085); the
 * Inbox, the chats that need the owner or are done; Snoozed; Archived; and Working, the chats Hermes is replying in, in
 * the list's scroll. Settled is a drawer at the list's foot, outside the scroll (ADR 0090): its header stays at the
 * bottom, and opens the drawer upward with its own scroll. Settling a chat is how it is cleared from the Inbox.
 * Settings → General picks the sections shown (uiPrefs.ts `chatSectionsShown`), and each one's header collapses it,
 * remembered across restarts. A row dragged onto the drawer, open or closed, settles its chat, and a Settled one dragged
 * onto the Inbox unsettles it; each is tinted while the drop would change something (ADR 0090). The scroll's sections
 * are one list of rows and headers, so a row that moves between them, as a reply starts or ends, keeps its menu, rename
 * box and focus; a collapsed section keeps its Active rows, hidden, for the same reason. The Custom snooze dialog
 * belongs to the list, not a row, for the same reason too.
 * Archived chats are in `chats` only while the Archived section is shown (App.tsx lists them then).
 * `projectSwitcher` sits under the profile's name; `chats` are only the shown project's when one is picked there.
 * `projectsOf`: the projects a chat's menu offers to put it in or take it out of.
 */
export function ChatList({
  profile,
  projectSwitcher,
  savedFilters,
  projectsOf,
  tagsOf,
  switching,
  status,
  others,
  checkTimes,
  chats,
  syncError,
  selectedId,
  alsoShownId = null,
  split = false,
  onOpen,
  onOpenIn = () => {},
  onOpenTab = () => {},
  onSettle,
  onSettleAll,
  snoozes = {},
  attentionSince,
  pins = {},
  onPin,
  handoffs,
  onStopWaiting,
  onSnooze,
  onWake,
  onArchive,
  onDelete,
  onRename,
  onRegenTitle,
  onCopyLink,
  onTextGenerationSettings,
  onListProfiles,
  onCheckOthers,
  onSwitchProfile,
  onRetrySwitch,
  profileClone,
  onNew,
  onSearch,
}: {
  profile: string;
  projectSwitcher?: ReactNode;
  /** The profile's Saved filters (Tags.tsx), under the project switcher. */
  savedFilters?: ReactNode;
  projectsOf?: (chatId: string) => ChatProjects | undefined;
  tagsOf?: (chatId: string) => ChatTags | undefined;
  switching?: Snapshot["switching"];
  status: ConnectionStatus;
  others: OtherProfiles;
  /** When the other profiles were checked (`Hermes.checkTimes`). */
  checkTimes: CheckTimesStore;
  chats: Chat[];
  syncError?: string;
  /** The chat in the active pane. */
  selectedId: string | null;
  /** The chat in the other pane, when there are two. */
  alsoShownId?: string | null;
  split?: boolean;
  onOpen: (id: string) => void;
  /** Opens a chat in the left (0) or right (1) pane, opening the right one if there is one pane. */
  onOpenIn?: (id: string, side: number) => void;
  /** Opens a chat in a new tab of the active pane. */
  onOpenTab?: (id: string) => void;
  onSettle: (id: string, settled: boolean) => void;
  /** Settles these chats at once, from the Inbox header's Settle all; without it the Inbox has no such button. */
  onSettleAll?: (ids: string[]) => void;
  /** When each snoozed chat wakes (snooze.ts). */
  snoozes?: Snoozes;
  /** When each chat last stopped working, so the top lists it as new then (snooze.ts `AttentionClock`). */
  attentionSince?: Readonly<Record<string, number>>;
  /** The pinned chats, each with when it was pinned (snooze.ts `PinStore`). */
  pins?: Pins;
  /** Pins a chat to the top of the list, or unpins it. */
  onPin?: (id: string, pinned: boolean) => void;
  /** Each chat's dispatched work (dispatched.ts `handoffs`), which keeps it in Working, waiting. */
  handoffs?: ReadonlyMap<string, Handoff>;
  /** Stops waiting on a chat's dispatched work, on this computer only (snooze.ts `StopWaitingStore`). */
  onStopWaiting?: (id: string) => void;
  onSnooze?: (id: string, until: number) => void;
  onWake?: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string, from: string) => Promise<unknown>;
  onRegenTitle: (id: string) => Promise<unknown>;
  /** Copies a chat's link (chatLinks.ts). */
  onCopyLink?: (chat: Chat) => void;
  /** Opens Settings → Model at the Text generation model, the model titles are made with. */
  onTextGenerationSettings?: () => void;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitchProfile: (name: string) => void;
  onRetrySwitch: () => void;
  /** Clone profile's calls (ADR 0074); without it the switcher offers no clone. */
  profileClone?: ProfileCloneApi;
  /** The list's own New chat and Search buttons, labeled with their keys; the rail keeps icons for both. */
  onNew?: () => void;
  onSearch?: () => void;
}) {
  const { chatSectionsShown: shown, chatSectionsCollapsed: collapsed } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const setCollapsed = (key: SectionKey, on: boolean) => {
    const now = getUIPrefs().chatSectionsCollapsed;
    if (now.includes(key) !== on) setUIPrefs({ chatSectionsCollapsed: on ? [...now, key] : now.filter((k) => k !== key) });
  };
  // The chat whose Custom snooze dialog is open.
  const [customFor, setCustomFor] = useState<Chat>();
  // The chat the Delete question is open for, and what had focus when it was asked.
  const [deleting, setDeleting] = useState<{ chat: Chat; from: HTMLElement | null }>();
  const deletingGone = !!deleting && !chats.some((c) => c.id === deleting.chat.id && !c.running);
  // Re-sorts the list when the next snooze wakes.
  const now = useSnoozeClock(snoozes);
  const sections = chatSections(chats, snoozes, now, attentionSince, pins, handoffs);
  const [askedInbox, setAskedInbox] = useState<InboxSettle>();
  const [dropOn, setDropOn] = useState<"settled" | "inbox" | null>(null);
  const dropHandlers = (on: "settled" | "inbox", isTarget: (e: DragEvent<HTMLElement>) => boolean = () => true) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (isTarget(e) && settleByDrop(chats.find((c) => c.id === rowDragged(e)), on) !== undefined) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropOn(on);
      } else setDropOn((was) => (was === on ? null : was));
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.contains(e.relatedTarget as Node) || setDropOn((was) => (was === on ? null : was)),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setDropOn((was) => (was === on ? null : was));
      const id = rowDragged(e);
      // Settling remounts the row outside this scroll, and React never delivers dragend to a detached node.
      dragChatEnd();
      const to = isTarget(e) ? settleByDrop(chats.find((c) => c.id === id), on) : undefined;
      if (id === undefined || to === undefined) return;
      e.preventDefault();
      onSettle(id, to);
    },
  });
  const overInbox = (e: DragEvent<HTMLElement>) => !!(e.target as Element).closest('[data-section="inbox"], [data-section-head="inbox"]');
  const stillInbox = askedInbox ? sections.inbox.filter((c) => askedInbox.ids.includes(c.id)).map((c) => c.id) : [];
  const askedInboxGone = !!askedInbox && !stillInbox.length;
  // The dialog closes if its chat leaves the list, or is settled or archived meanwhile (in another window or client).
  const customGone = !!customFor && !chats.some((c) => c.id === customFor.id && !c.settled && !c.archived);
  useEffect(() => {
    if (customGone) setCustomFor(undefined);
  }, [customGone]);
  useEffect(() => {
    if (deletingGone) setDeleting(undefined);
  }, [deletingGone]);
  useEffect(() => {
    if (askedInboxGone) setAskedInbox(undefined);
  }, [askedInboxGone]);
  // Opening a chat in a collapsed section, say from a search, opens the section; settling or snoozing the chat on
  // screen doesn't.
  const selectedIn = shown.find((k) => sections[k].some((c) => c.id === selectedId));
  useEffect(() => {
    if (selectedIn) setCollapsed(selectedIn, false);
  }, [selectedId]);
  const l = useLocale();
  const latest = { chats, onOpen, onOpenIn, onOpenTab, onSettle, onArchive, onRename, onRegenTitle, onCopyLink, onTextGenerationSettings, projectsOf, tagsOf, onPin, onStopWaiting, onSnooze, onWake };
  const live = useRef(latest);
  live.current = latest;
  const handlersFor = (id: string) => {
    const chat = () => live.current.chats.find((c) => c.id === id);
    return {
      open: () => live.current.onOpen(id),
      openIn: (side: number) => live.current.onOpenIn(id, side),
      openTab: () => live.current.onOpenTab(id),
      settle: (settled: boolean) => live.current.onSettle(id, settled),
      archive: (archived: boolean) => live.current.onArchive(id, archived),
      askDelete: (from: HTMLElement | null) => {
        const c = chat();
        if (c) setDeleting({ chat: c, from });
      },
      rename: (title: string, from: string) => live.current.onRename(id, title, from),
      regenTitle: () => live.current.onRegenTitle(id),
      copyLink: () => {
        const c = chat();
        if (c) live.current.onCopyLink?.(c);
      },
      textGenerationSettings: () => live.current.onTextGenerationSettings?.(),
      toggleProject: (projectId: string, on: boolean) => live.current.projectsOf?.(id)?.onToggle(projectId, on),
      toggleTag: (tagId: string, on: boolean) => live.current.tagsOf?.(id)?.onToggle(tagId, on),
      manageTags: () => live.current.tagsOf?.(id)?.onManage(),
      snooze: (until: number) => live.current.onSnooze?.(id, until),
      customSnooze: () => setCustomFor(chat()),
      wake: () => live.current.onWake?.(id),
      pin: (on: boolean) => live.current.onPin?.(id, on),
      stopWaiting: () => live.current.onStopWaiting?.(id),
    };
  };
  const handlers = useRef(new Map<string, ReturnType<typeof handlersFor>>()).current;
  const row = (c: Chat, section?: SectionKey, hidden?: boolean) => {
    let on = handlers.get(c.id);
    if (!on) handlers.set(c.id, (on = handlersFor(c.id)));
    const projects = projectsOf?.(c.id);
    const tags = tagsOf?.(c.id);
    const snooze = onSnooze && onWake && !c.settled && !c.archived ? { until: snoozes[c.id], onSnooze: on.snooze, onCustom: on.customSnooze, onWake: on.wake } : undefined;
    const sleepsUntil = snooze?.until !== undefined && snooze.until > now ? snooze.until : undefined;
    return (
      <ChatRow
        key={c.id}
        section={section}
        hidden={hidden}
        chat={c}
        selected={c.id === selectedId}
        alsoShown={c.id === alsoShownId && c.id !== selectedId}
        split={split}
        onOpen={on.open}
        onOpenIn={on.openIn}
        onOpenTab={on.openTab}
        onSettle={on.settle}
        onArchive={on.archive}
        onAskDelete={on.askDelete}
        onRename={on.rename}
        onRegenTitle={on.regenTitle}
        onCopyLink={onCopyLink && on.copyLink}
        onTextGenerationSettings={onTextGenerationSettings && on.textGenerationSettings}
        projects={projects && { ...projects, onToggle: on.toggleProject }}
        tags={tags && { ...tags, onToggle: on.toggleTag, onManage: on.manageTags }}
        snooze={snooze}
        sleepsUntil={sleepsUntil}
        wake={sleepsUntil === undefined ? undefined : wakeLabel(sleepsUntil, now, l.tag)}
        pin={onPin && !c.archived ? { pinned: pins[c.id] !== undefined, onPin: on.pin } : undefined}
        handoff={handoffs?.get(c.id)}
        onStopWaiting={onStopWaiting && on.stopWaiting}
      />
    );
  };
  // Archived can hold every chat the profile has ever had, so a collapsed one draws no rows (Settled, the drawer, neither).
  const keepsHidden = (k: SectionKey) => k !== "archived";
  // Pinned, Working and Snoozed come and go with what the owner and Hermes do; the others keep their header when empty.
  const drawnEmpty = (k: SectionKey) => k !== "pinned" && k !== "working" && k !== "snoozed";
  const busy = sections.working.length + sections.snoozed.length > 0;
  const header = (k: SectionKey, list: Chat[], open: boolean) => {
    const unread = list.filter((c) => c.unread).length;
    const toggle = (
      <button key={`section-${k}`} className="section-toggle" data-section-head={k} aria-expanded={open} onClick={() => setCollapsed(k, open)}>
        <ChevronRight size={14} className={`chev ${open ? "open" : ""}`} />
        {SECTION_LABEL[k]}
        <span className="count">{list.length}</span>
        {unread > 0 && !open && <span className="dot" title={`${unread} unread`} />}
      </button>
    );
    if (k !== "inbox" || !onSettleAll || !list.length) return toggle;
    return (
      <div key={`section-${k}`} className="section-head" data-section="inbox">
        {toggle}
        <button className="section-action" data-settle-all onClick={() => setAskedInbox(inboxSettle(list))}>
          Settle all
        </button>
      </div>
    );
  };
  const settledOpen = !collapsed.includes("settled");
  return (
    <aside className="sidebar" onKeyDown={moveBetweenChats} onContextMenu={menuForFocusedRow}>
      <div className="sb-head">
        <ProfileSwitcher
          profile={profile}
          others={others}
          checkTimes={checkTimes}
          leaving={leavingNote(profile, chats)}
          onListProfiles={onListProfiles}
          onCheckOthers={onCheckOthers}
          onSwitch={onSwitchProfile}
          clone={profileClone}
        />
      </div>
      {(onNew || onSearch) && (
        <div className="sb-actions">
          {onNew && (
            <button className="sb-action primary" onClick={onNew}>
              <SquarePen size={15} />
              <span>New chat</span>
              <kbd aria-hidden>Ctrl N</kbd>
            </button>
          )}
          {onSearch && (
            <button className="sb-action" onClick={onSearch}>
              <Search size={15} />
              <span>Search chats</span>
              <kbd aria-hidden>Ctrl K</kbd>
            </button>
          )}
        </div>
      )}
      {projectSwitcher && <div className="sb-project">{projectSwitcher}</div>}
      <div className="sb-scroll" data-drop={dropOn === "inbox" ? "inbox" : undefined} {...dropHandlers("inbox", overInbox)}>
        {switching && (
          <SwitchStatus profile={profile} switching={switching} status={status} onRetry={onRetrySwitch} onBack={() => onSwitchProfile(switching.from)} />
        )}
        {savedFilters}
        {syncError && !switching?.error && (
          <div className="sync-error" role="status">
            {syncError}
          </div>
        )}
        {
          // One keyed array, so React keeps a row that moves from one section to another.
          shown.flatMap((k) => {
            if (k === "settled") return [];
            const list = sections[k];
            if (!list.length && !drawnEmpty(k)) return [];
            const open = !collapsed.includes(k);
            return [
              header(k, list, open),
              ...(open || keepsHidden(k) ? list.map((c) => row(c, k, !open)) : []),
              open && !list.length && (
                <div key={`empty-${k}`} className="empty-hint" data-section={k === "inbox" ? "inbox" : undefined}>
                  {k === "inbox" ? (busy ? "Nothing needs you right now." : "Nothing needs you. Start a new chat.") : `No ${SECTION_LABEL[k].toLowerCase()} chats.`}
                </div>
              ),
            ];
          })
        }
      </div>
      {shown.includes("settled") && (
        // The drawer at the list's foot (ADR 0090): its header stays at the bottom however long the scroll above is.
        <div className={`settled-drawer ${settledOpen ? "open" : ""} ${dropOn === "settled" ? "drop" : ""}`} {...dropHandlers("settled")}>
          {header("settled", sections.settled, settledOpen)}
          {settledOpen && (
            <div className="settled-list">
              {sections.settled.map((c) => row(c, "settled"))}
              {!sections.settled.length && <div className="empty-hint">No settled chats.</div>}
            </div>
          )}
        </div>
      )}
      {customFor && !customGone && (
        <SnoozeDialog
          title={customFor.title}
          returnTo={{
            get current() {
              return document.querySelector<HTMLElement>(`.row-open[data-chat="${CSS.escape(customFor.id)}"]`);
            },
          }}
          onClose={() => setCustomFor(undefined)}
          onSnooze={(until) => {
            setCustomFor(undefined);
            onSnooze?.(customFor.id, until);
          }}
        />
      )}
      {askedInbox && !askedInboxGone && (
        <SettleAllDialog
          inbox={askedInbox}
          returnTo={{
            get current() {
              return document.querySelector<HTMLElement>("[data-settle-all]") ?? document.querySelector<HTMLElement>('[data-section-head="inbox"]');
            },
          }}
          onClose={() => setAskedInbox(undefined)}
          onSettle={() => {
            setAskedInbox(undefined);
            onSettleAll?.(stillInbox);
          }}
        />
      )}
      {deleting && !deletingGone && (
        <DeleteChatDialog
          title={deleting.chat.title}
          returnTo={{
            get current() {
              return deleting.from?.isConnected ? deleting.from : document.querySelector<HTMLElement>(`.row-open[data-chat="${CSS.escape(deleting.chat.id)}"]`);
            },
          }}
          onClose={() => setDeleting(undefined)}
          onDelete={() => {
            setDeleting(undefined);
            onDelete(deleting.chat.id);
          }}
        />
      )}
    </aside>
  );
}
