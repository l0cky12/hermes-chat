// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A. The list's header is the
// profile switcher. Settings opens from the rail's foot. Right-clicking a chat opens its menu (ChatMenu.tsx).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert, EyeOff, LockOpen, Search, Settings, SquarePen, Trash2 } from "lucide-react";
import type { Chat, ConnectionStatus, OtherProfile, OtherProfiles } from "../hermes/model";
import { SOURCE_LABEL, isWaiting } from "../hermes/model";
import { CHECK_EVERY_MS, totalUnread } from "../hermes/otherProfiles";
import type { Route } from "../hermes/pipe";
import { RenameConflict, type Snapshot } from "../hermes/transport";
import { ChatMenu, type ChatProjects } from "./ChatMenu";
import { ArchiveButton, STATUS_LABEL, SettleButton, SourceIcon, Spinner, composing, relTime, routeLabel, useReturnFocus } from "./bits";

const byRecent = (a: Chat, b: Chat) => b.updatedAt - a.updatedAt;


export function Rail({
  status,
  route,
  unsecure,
  closedReason,
  onReconnect,
  onToggleList,
  onNew,
  onSearch,
  onSettings,
  onJobs,
  jobsOpen = false,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  onReconnect: () => void;
  onToggleList: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
  /** Opens Scheduled jobs: Hermes's jobs for the profile, which it runs on the server. */
  onJobs?: () => void;
  jobsOpen?: boolean;
}) {
  const where = routeLabel(route);
  // The full wording lives only in the tooltip (ADR 0001).
  const tip = [
    STATUS_LABEL[status],
    where,
    unsecure && "Unsecure: traffic to the server isn't encrypted",
    status !== "connected" && closedReason,
    status !== "connected" && "Click to reconnect",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <aside className="rail">
      <div className="rail-top">
        <button className="rail-brand" title="Hide or show chats (Ctrl+B)" onClick={onToggleList}>
          H
        </button>
        <button className="icon-btn" title="New chat (Ctrl+N)" onClick={onNew}>
          <SquarePen size={18} />
        </button>
        <button className="icon-btn" title="Search all chats (Ctrl+K)" onClick={onSearch}>
          <Search size={18} />
        </button>
        {onJobs && (
          <button className={`icon-btn ${jobsOpen ? "on" : ""}`} title="Scheduled jobs" aria-label="Scheduled jobs" aria-pressed={jobsOpen} onClick={onJobs}>
            <CalendarClock size={18} />
          </button>
        )}
      </div>
      <div className="rail-bottom">
        <button className="conn-btn" title={tip} aria-label={tip} onClick={() => status !== "connected" && onReconnect()}>
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          {unsecure && <LockOpen className="conn-lock" size={9} strokeWidth={2.8} />}
        </button>
        <button className="icon-btn" title="Settings" onClick={onSettings}>
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

/**
 * The chat's title in a text box. Enter saves it, and the box stays until Hermes has read the new title back. If
 * saving fails the typed title stays, with why; if the chat was renamed elsewhere, the list shows that title and only
 * another Enter replaces it. Escape, or clicking away before changing anything, keeps the old title.
 */
function RenameRow({
  chat,
  selected,
  onRename,
  onDone,
}: {
  chat: Chat;
  selected: boolean;
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
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    });
  };
  return (
    <div className={`row renaming ${selected ? "sel" : ""}`}>
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
 * Menu key or Shift+F10 on it, opens its menu. The trash button asks before deleting, in the row itself: Escape,
 * Cancel or clicking away keeps the chat. Cancel and the trash button share a key, so React keeps the one button, and
 * focus with it, when the row goes back. An archived chat has Restore in place of Settle and Archive. A chat with
 * a reply running can't be archived, restored or deleted. Regenerate title in the menu shows a spinner until the new
 * title is saved, and why underneath if it isn't.
 */
function ChatRow({
  chat,
  selected,
  alsoShown,
  split,
  onOpen,
  onOpenIn,
  onSettle,
  onArchive,
  onDelete,
  onRename,
  onRegenTitle,
  projects,
}: {
  chat: Chat;
  selected: boolean;
  /** The chat is in the pane that isn't active. */
  alsoShown: boolean;
  split: boolean;
  onOpen: () => void;
  /** Opens the chat in the left (0) or right (1) pane. */
  onOpenIn: (side: number) => void;
  onSettle: (settled: boolean) => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
  onRename: (title: string, from: string) => Promise<unknown>;
  onRegenTitle: () => Promise<unknown>;
  projects?: ChatProjects;
}) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [retitling, setRetitling] = useState(false);
  const [retitleError, setRetitleError] = useState<string>();
  const regenTitle = () => {
    if (retitling) return;
    setRetitling(true);
    setRetitleError(undefined);
    onRegenTitle()
      .catch((e) =>
        setRetitleError(
          e instanceof RenameConflict
            ? `This chat was renamed in another Hermes client meanwhile, to "${e.title}". Regenerate again to replace it.`
            : `Couldn't regenerate the title: ${e instanceof Error ? e.message : String(e)}`,
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
  if (renaming) return <RenameRow chat={chat} selected={selected} onRename={onRename} onDone={() => setRenaming(false)} />;
  if (confirming)
    return (
      <div
        className={`row confirming ${selected ? "sel" : ""}`}
        onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
        onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setConfirming(false)}
      >
        <span className="row-title">{chat.title}</span>
        <button className="row-confirm danger" title="Delete this chat in every Hermes client. This can't be undone." onClick={onDelete}>
          Delete
        </button>
        <button key="trash" className="row-confirm" autoFocus onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    );
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${alsoShown ? "shown" : ""} ${chat.unread ? "unread" : ""} ${menu ? "menu-open" : ""} ${retitleError ? "retitle-failed" : ""} ${retitling ? "retitling" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setRetitleError(undefined);
        // From the keyboard the event has no pointer position, so the menu opens under the row.
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom });
      }}
    >
      <button
        ref={openButton}
        className="row-open"
        aria-current={selected || undefined}
        title={`${retitling ? "Writing a new title…" : chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}${alsoShown ? " (in the other pane)" : ""}`}
        onClick={() => {
          setRetitleError(undefined);
          onOpen();
        }}
      >
        {chat.source !== "app" && <SourceIcon source={chat.source} />}
        <span className="row-title">{chat.title}</span>
        <span className="row-meta">
          {chat.running || retitling ? <Spinner /> : chat.unread ? <span className="dot" title="Unread" /> : relTime(chat.updatedAt)}
        </span>
      </button>
      {!chat.archived && <SettleButton settled={chat.settled} size={14} className="row-action" onSettle={onSettle} />}
      {!chat.running && <ArchiveButton archived={!!chat.archived} size={14} className="row-action" onArchive={onArchive} />}
      {!chat.running && (
        <button
          key="trash"
          className="row-action"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
      {menu && (
        <ChatMenu
          chat={chat}
          projects={projects}
          x={menu.x}
          y={menu.y}
          split={split}
          onOpenIn={onOpenIn}
          onRename={() => setRenaming(true)}
          onRegenTitle={regenTitle}
          onClose={closeMenu}
        />
      )}
      {retitleError && (
        <div className="row-rename-error" role="alert">
          {retitleError}
        </div>
      )}
    </div>
  );
}

const ago = (ts: number) => (relTime(ts) === "now" ? "just now" : `${relTime(ts)} ago`);
const unreadCount = (p: OtherProfile) => `${p.unread}${p.more ? "+" : ""}`;
const CHECKED_EVERY = `Other profiles are checked every ${CHECK_EVERY_MS / 60_000} minutes`;

/** What the latest check of another profile found, and when; an earlier answer is kept through a failed check. */
function otherTip(p?: OtherProfile): string {
  const found = (q: OtherProfile) =>
    q.checkedAt === undefined
      ? undefined
      : `${q.unread ? `${unreadCount(q)} unread` : "No unread chats"}${q.more ? " in its most recent chats" : ""}, checked ${ago(q.checkedAt)}`;
  if (p?.error) return [`Couldn't check: ${p.error}`, found(p) && `Earlier: ${found(p)}`].filter(Boolean).join(". ");
  return (p && found(p)) ?? "Not checked yet";
}

/** The switcher's tooltip: which other profiles have Unread chats, which couldn't be checked, and how fresh it is. */
function switcherTip(others: OtherProfiles): string {
  const { withUnread, failed } = totalUnread(others);
  return [
    "Switch profile",
    withUnread.length && `Unread chats in ${withUnread.map((n) => `${n} (${unreadCount(others.byName[n])})`).join(", ")}`,
    failed.length && `Couldn't check ${failed.join(", ")}`,
    others.error,
    `${CHECKED_EVERY}${others.checkedAt ? `; last ${ago(others.checkedAt)}` : ""}`,
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
function leavingNote(profile: string, chats: Chat[]): string | undefined {
  if (chats.some((c) => c.items.some(isWaiting)))
    return `An approval is waiting in ${profile}. Hermes waits for your answer only until it times out: switch back and open the chat to answer it.`;
  if (chats.some((c) => c.running)) return `A reply is still running in ${profile}. Hermes keeps it going, and it shows here when you switch back.`;
}

/**
 * The current profile's name with a ▾, which opens the server's profiles with a filter box (ADR 0001). Enter picks
 * the first match; Escape or a click outside closes it. A dot on it, and a count on each profile in the menu, show
 * Unread chats in the other profiles, as the latest poll found them. Opening the menu asks for a fresh check.
 * `leaving`: what switching away now leaves behind, which the owner is asked about first.
 */
function ProfileSwitcher({
  profile,
  others,
  leaving,
  onListProfiles,
  onCheckOthers,
  onSwitch,
}: {
  profile: string;
  others: OtherProfiles;
  leaving?: string;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The profile the owner picked while something was left behind here, and what, until they say whether to go. Kept
  // as asked, so the question stays if the reply finishes meanwhile.
  const [asking, setAsking] = useState<{ to: string; note: string }>();
  const button = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<string[]>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(undefined);
    onCheckOthers();
    onListProfiles().then(
      (names) => current && setProfiles(names),
      (e) => current && setError(`Couldn't list profiles: ${e instanceof Error ? e.message : String(e)}`),
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
      <button ref={button} className="profile-btn" title={switcherTip(others)} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="profile-name">{profile}</span>
        {elsewhere && <span className="dot" aria-label="Unread chats in other profiles" />}
        <ChevronDown size={14} className="profile-chev" />
      </button>
      {open && asking && <LeaveProfile note={asking.note} to={asking.to} onGo={() => answer(true)} onStay={() => answer(false)} />}
      {open && !asking && <ProfileMenu profile={profile} profiles={profiles} error={error} others={others} onPick={pick} onClose={close} />}
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
  onPick,
  onClose,
}: {
  profile: string;
  profiles?: string[];
  error?: string;
  others: OtherProfiles;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
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
            title={p === profile ? undefined : otherTip(others.byName[p])}
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
          Unread checked every {CHECK_EVERY_MS / 60_000} min{others.checkedAt ? `, last ${ago(others.checkedAt)}` : ""}
        </div>
      )}
    </div>
  );
}

/** Up and Down move focus between the chats in the list, Active then Settled, without opening them. */
function moveBetweenChats(e: KeyboardEvent<HTMLElement>) {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !(e.target as Element).classList.contains("row-open")) return;
  e.preventDefault();
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".row-open"));
  rows[rows.indexOf(e.target as HTMLButtonElement) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/**
 * The chat list. `archivedListed`: it shows the profile's archived chats instead of the Active and Settled ones.
 * `projectSwitcher` sits under the profile's name; `chats` are only the shown project's when one is picked there.
 * `projectsOf`: the projects a chat's menu offers to put it in or take it out of.
 */
export function ChatList({
  profile,
  projectSwitcher,
  projectsOf,
  switching,
  status,
  others,
  chats,
  archivedListed,
  syncError,
  selectedId,
  alsoShownId = null,
  split = false,
  onOpen,
  onOpenIn = () => {},
  onSettle,
  onArchive,
  onListArchived,
  onDelete,
  onRename,
  onRegenTitle,
  onListProfiles,
  onCheckOthers,
  onSwitchProfile,
  onRetrySwitch,
}: {
  profile: string;
  projectSwitcher?: ReactNode;
  projectsOf?: (chatId: string) => ChatProjects | undefined;
  switching?: Snapshot["switching"];
  status: ConnectionStatus;
  others: OtherProfiles;
  chats: Chat[];
  archivedListed: boolean;
  syncError?: string;
  /** The chat in the active pane. */
  selectedId: string | null;
  /** The chat in the other pane, when there are two. */
  alsoShownId?: string | null;
  split?: boolean;
  onOpen: (id: string) => void;
  /** Opens a chat in the left (0) or right (1) pane, opening the right one if there is one pane. */
  onOpenIn?: (id: string, side: number) => void;
  onSettle: (id: string, settled: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onListArchived: (on: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string, from: string) => Promise<unknown>;
  onRegenTitle: (id: string) => Promise<unknown>;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitchProfile: (name: string) => void;
  onRetrySwitch: () => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  // Opening a Settled chat, say from a search, shows it in the list; settling the chat on screen doesn't.
  const selectedSettled = chats.some((c) => c.id === selectedId && c.settled);
  useEffect(() => {
    if (selectedSettled) setSettledOpen(true);
  }, [selectedId]);
  const active = chats.filter((c) => !c.settled && !c.archived).sort(byRecent);
  const settled = chats.filter((c) => c.settled && !c.archived).sort(byRecent);
  const archived = chats.filter((c) => c.archived).sort(byRecent);
  const settledUnread = settled.filter((c) => c.unread).length;
  const row = (c: Chat) => (
    <ChatRow
      key={c.id}
      chat={c}
      selected={c.id === selectedId}
      alsoShown={c.id === alsoShownId && c.id !== selectedId}
      split={split}
      onOpen={() => onOpen(c.id)}
      onOpenIn={(side) => onOpenIn(c.id, side)}
      onSettle={(s) => onSettle(c.id, s)}
      onArchive={(a) => onArchive(c.id, a)}
      onDelete={() => onDelete(c.id)}
      onRename={(title, from) => onRename(c.id, title, from)}
      onRegenTitle={() => onRegenTitle(c.id)}
      projects={projectsOf?.(c.id)}
    />
  );
  return (
    <aside className="sidebar" onKeyDown={moveBetweenChats}>
      <div className="sb-head">
        <ProfileSwitcher
          profile={profile}
          others={others}
          leaving={leavingNote(profile, chats)}
          onListProfiles={onListProfiles}
          onCheckOthers={onCheckOthers}
          onSwitch={onSwitchProfile}
        />
        <button
          className={`icon-btn ${archivedListed ? "on" : ""}`}
          title={archivedListed ? "Back to the chat list" : "Archived chats"}
          aria-pressed={archivedListed}
          onClick={() => onListArchived(!archivedListed)}
        >
          <EyeOff size={16} />
        </button>
      </div>
      {projectSwitcher && <div className="sb-project">{projectSwitcher}</div>}
      <div className="sb-scroll">
        {switching && (
          <SwitchStatus profile={profile} switching={switching} status={status} onRetry={onRetrySwitch} onBack={() => onSwitchProfile(switching.from)} />
        )}
        {syncError && !switching?.error && (
          <div className="sync-error" role="status">
            {syncError}
          </div>
        )}
        {archivedListed ? (
          <>
            <div className="section-label">Archived</div>
            {archived.length ? archived.map(row) : <div className="empty-hint">No archived chats.</div>}
          </>
        ) : (
          <>
            <div className="section-label">Active</div>
            {active.length ? active.map(row) : <div className="empty-hint">Nothing active. Start a new chat.</div>}
          </>
        )}
      </div>
      {/* Settled is pinned to the foot of the list and opens upward as a drawer with its own scroll. */}
      {!archivedListed && (
        <div className={`settled-section ${settledOpen ? "open" : ""}`}>
          <button className="section-toggle" aria-expanded={settledOpen} onClick={() => setSettledOpen((o) => !o)}>
            <ChevronRight size={14} className={`chev ${settledOpen ? "open" : ""}`} />
            Settled
            <span className="count">{settled.length}</span>
            {settledUnread > 0 && !settledOpen && <span className="dot" title={`${settledUnread} unread`} />}
          </button>
          {settledOpen && <div className="settled-list">{settled.map(row)}</div>}
        </div>
      )}
    </aside>
  );
}
