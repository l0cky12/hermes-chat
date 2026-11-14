// The inbox: what needs the owner, or finished, across the server's profiles (hermes/inbox.ts). It opens beside the
// rail over the chat list, and leaves the chat panes as they are, so the chats on screen stay read. Opening an entry
// goes to its chat, in its profile, and to the Approval card or message it is about. A waiting Approval in the profile
// shown also shows its card here, the chat's own, answered the same way (ADR 0173). Nothing else here answers,
// retries or resends: that happens in the chat, the usual way.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleHelp, Loader, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { ApprovalChoice, ApprovalItem, LiveSessions, OtherProfiles } from "../hermes/model";
import { INBOX_FILTERS, dismissable, needsOwner, type InboxEntry, type InboxFilter, type InboxKind } from "../hermes/inbox";
import type { CheckTimesStore } from "../hermes/otherProfiles";
import { ApprovalCard } from "./ApprovalCard";
import { ago, composing, storedTime, useReturnFocus } from "./bits";
import { useLocale } from "../i18n/locale";

const FILTER_LABEL: Record<InboxFilter, string> = {
  all: "All",
  approval: "Needs approval",
  failed: "Failed",
  completed: "Completed",
  running: "Running",
};

const KIND_LABEL: Record<InboxKind, string> = {
  running: "Running",
  approval: "Needs approval",
  failed: "Failed",
  uncertain: "May not have sent",
  completed: "Completed, unread",
};

const KIND_ICON: Record<InboxKind, typeof X> = {
  running: Loader,
  approval: ShieldAlert,
  failed: CircleAlert,
  uncertain: CircleHelp,
  completed: CircleCheck,
};

/**
 * `entries`: the ones not dismissed. `server`: how the connection names the server. `leaving`: what switching away
 * from the shown profile leaves behind, which the owner is asked about before an entry takes them to another profile.
 * `unmatched`: live sessions the inbox couldn't put with one chat. `checkTimes`: when `others` and `live` were read.
 */
export function Inbox({
  entries,
  unmatched,
  server,
  profile,
  connected,
  others,
  live,
  checkTimes,
  leaving,
  onOpen,
  approvalOf,
  onAnswer,
  onDismiss,
  onClearDone,
  onRefresh,
  onClose,
  onGuide,
}: {
  /** Opens the compatibility guide at what the inbox can't see without, when Hermes lacks it. */
  onGuide?: () => void;
  entries: InboxEntry[];
  unmatched: number;
  server: string;
  profile: string;
  connected: boolean;
  others: OtherProfiles;
  live?: LiveSessions;
  checkTimes: CheckTimesStore;
  leaving?: string;
  onOpen: (e: InboxEntry) => void;
  /** The waiting Approval card `e` is about, when it can be answered here. */
  approvalOf?: (e: InboxEntry) => ApprovalItem | undefined;
  onAnswer?: (e: InboxEntry, choice: ApprovalChoice, confirmed?: boolean) => void;
  onDismiss: (e: InboxEntry) => void;
  /** Dismisses the finished entries the filter shows. */
  onClearDone: (es: InboxEntry[]) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  // The entry in another profile the owner picked while something here would be left behind.
  const [asking, setAsking] = useState<InboxEntry>();
  // After a dismissal, the row to put focus on, so it doesn't fall to the page.
  const [focusAt, setFocusAt] = useState<number>();
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  useReturnFocus();

  // A press in a frame (the Preview's page) never reaches this document, so focus going into one closes it too; the
  // window losing focus to another app doesn't.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target;
      if (at instanceof Node && !root.current?.contains(at)) onClose();
    };
    let later: ReturnType<typeof setTimeout> | undefined;
    // Read once the blur is over, when the frame is the active element.
    const blurred = () => {
      clearTimeout(later);
      later = setTimeout(() => document.activeElement instanceof HTMLIFrameElement && !root.current?.contains(document.activeElement) && onClose());
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", blurred);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", blurred);
      clearTimeout(later);
    };
  }, [onClose]);

  const shown = entries.filter((e) => (INBOX_FILTERS[filter] as readonly InboxKind[]).includes(e.kind));
  // When the list last changed, so a card's buttons ignore a click aimed at a row that moved under the pointer.
  const shownKeys = shown.map((e) => e.key).join("\n");
  const [movedAt, setMovedAt] = useState(0);
  useEffect(() => setMovedAt(performance.now()), [shownKeys]);
  const count = (f: InboxFilter) => entries.filter((e) => (INBOX_FILTERS[f] as readonly InboxKind[]).includes(e.kind) && (f === "running" || needsOwner(e))).length;

  // Opening puts focus on the first entry, or on Close when there is none.
  useEffect(() => void (list.current?.querySelector<HTMLElement>(".inbox-open") ?? document.querySelector<HTMLElement>(".inbox .inbox-close"))?.focus(), []);

  useEffect(() => {
    if (focusAt === undefined) return;
    const rows = list.current?.querySelectorAll<HTMLButtonElement>(".inbox-open");
    (rows?.[Math.min(focusAt, rows.length - 1)] ?? document.querySelector<HTMLElement>(".inbox .inbox-close"))?.focus();
    setFocusAt(undefined);
  }, [focusAt]);

  // An entry on another live connection leaves nothing here behind: this connection carries on in the background.
  const open = (e: InboxEntry) => (!e.server && e.profile !== profile && leaving ? setAsking(e) : onOpen(e));
  const dismiss = (e: InboxEntry) => {
    setFocusAt(shown.indexOf(e));
    onDismiss(e);
  };
  // An answered card's entry leaves the list, so focus goes to the row that takes its place.
  const answer = (e: InboxEntry, choice: ApprovalChoice, confirmed?: boolean) => {
    setFocusAt(shown.indexOf(e));
    onAnswer?.(e, choice, confirmed);
  };
  const done = shown.filter((e) => e.kind === "completed");
  const clearDone = () => {
    setFocusAt(0);
    onClearDone(done);
  };

  // Up and Down move between the entries; Escape closes, or backs out of the question first.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (asking) setAsking(undefined);
      else onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>(".inbox-open") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <section ref={root} className="inbox" role="dialog" aria-labelledby={headId} onKeyDown={onKeyDown}>
      <header className="inbox-head">
        <div className="inbox-heading">
          <h2 id={headId}>Inbox</h2>
          <span className="inbox-server" title="The server these come from">
            {server}
          </span>
        </div>
        {done.length > 0 && (
          <button className="btn inbox-clear-done" title="Dismiss every completed entry shown" onClick={clearDone}>
            Clear done
          </button>
        )}
        <button className="icon-btn" title="Check now" aria-label="Check now" onClick={onRefresh} disabled={!connected}>
          <RefreshCw size={15} />
        </button>
        <button className="icon-btn inbox-close" title="Close the inbox (Escape)" aria-label="Close the inbox" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="inbox-filters" role="group" aria-label="Show">
        {(Object.keys(FILTER_LABEL) as InboxFilter[]).map((f) => (
          <button key={f} className={`inbox-filter ${filter === f ? "on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]}
            {count(f) > 0 && <span className="count">{count(f)}</span>}
          </button>
        ))}
      </div>
      <Freshness connected={connected} others={others} live={live} checkTimes={checkTimes} unmatched={unmatched} onGuide={onGuide} />
      {asking && (
        <div className="confirm inbox-leave" role="alertdialog" aria-label={`Switch to ${asking.profile}?`}>
          <span>{leaving}</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setAsking(undefined)}>
              Stay
            </button>
            <button className="btn primary" onClick={() => onOpen(asking)}>
              Switch to {asking.profile}
            </button>
          </div>
        </div>
      )}
      <ul className="inbox-list" ref={list} aria-label={FILTER_LABEL[filter]}>
        {shown.map((e) => {
          const card = approvalOf?.(e);
          return (
            <Row key={e.key} entry={e} server={e.server?.name ?? server} onOpen={() => open(e)} onDismiss={() => dismiss(e)}>
              {card && <ApprovalCard item={card} offline={!connected} movedAt={movedAt} onAnswer={(c, confirmed) => answer(e, c, confirmed)} />}
            </Row>
          );
        })}
      </ul>
      {!shown.length && <div className="empty-hint inbox-empty">{emptyNote(filter)}</div>}
    </section>
  );
}

function emptyNote(filter: InboxFilter): string {
  if (filter === "running") return "Nothing is running.";
  if (filter === "approval") return "No Approval is waiting.";
  if (filter === "failed") return "Nothing has failed.";
  if (filter === "completed") return "Nothing unread.";
  return "Nothing needs you.";
}

function Row({
  entry: e,
  server,
  onOpen,
  onDismiss,
  children,
}: {
  entry: InboxEntry;
  server: string;
  onOpen: () => void;
  onDismiss: () => void;
  /** The entry's Approval card, below it. */
  children?: ReactNode;
}) {
  const l = useLocale();
  const Icon = KIND_ICON[e.kind];
  const when = e.at || e.noticedAt;
  const state = e.ended ? "Expired" : e.waiting ? "Waiting" : KIND_LABEL[e.kind];
  const whenText = when ? `${e.at ? "" : "noticed "}${ago(l, when, "now")}` : "time not known";
  return (
    <li className={`inbox-row kind-${e.kind}${e.ended ? " is-ended" : ""}${e.stale ? " is-stale" : ""}`}>
      <button
        className="inbox-open"
        aria-label={`${state}: ${e.title}, in ${e.profile} on ${server}, ${whenText}. ${e.summary}${e.stale ? " As last seen." : ""}`}
        onClick={onOpen}
      >
        <span className="inbox-line">
          <span className="inbox-kind">
            <Icon size={13} aria-hidden />
            {state}
          </span>
          {when ? (
            <time className="inbox-time" dateTime={new Date(when).toISOString()} title={`${e.at ? "" : "Noticed "}${storedTime(when)}`}>
              {whenText}
            </time>
          ) : (
            <span className="inbox-time">{whenText}</span>
          )}
        </span>
        <span className="inbox-title">{e.title}</span>
        <span className="inbox-where">
          {e.profile} · {server}
        </span>
        <span className="inbox-summary">
          {e.summary}
          {e.stale && " As last seen."}
        </span>
      </button>
      {dismissable(e) && (
        <button className="icon-btn inbox-dismiss" title="Dismiss from the inbox" aria-label={`Dismiss “${e.title}” from the inbox`} onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
      {children}
    </li>
  );
}

/** How fresh the inbox is, and which of its sources couldn't be read. */
function Freshness({
  connected,
  others,
  live,
  checkTimes,
  unmatched,
  onGuide,
}: {
  connected: boolean;
  others: OtherProfiles;
  live?: LiveSessions;
  checkTimes: CheckTimesStore;
  unmatched: number;
  onGuide?: () => void;
}) {
  const l = useLocale();
  const times = useSyncExternalStore(checkTimes.subscribe, checkTimes.get);
  const failed = Object.entries(others.byName).filter(([, p]) => p.error);
  const partial = Object.entries(others.byName).filter(([, p]) => p.more).map(([n]) => n);
  const notes = [
    !connected && { err: true, text: "Not connected to Hermes: showing what was last seen." },
    others.error && { err: true, text: others.error },
    failed.length && {
      err: true,
      text: `Couldn't check ${failed.map(([n]) => n).join(", ")}: their entries are as last seen.`,
      title: failed.map(([n, p]) => `${n}: ${p.error}`).join("\n"),
    },
    live?.unsupported && { err: false, text: "This Hermes doesn't report what runs or waits in other profiles. Open a profile to see its chats' replies and Approvals." },
    live?.error && { err: true, text: `Couldn't ask Hermes what is running: ${live.error}` },
    partial.length && { err: false, text: `Only the 50 most recent chats in ${partial.join(", ")} were checked.` },
    unmatched > 0 && { err: false, text: `${unmatched} running or waiting session${unmatched === 1 ? "" : "s"} couldn't be matched to one chat, so ${unmatched === 1 ? "it isn't" : "they aren't"} listed.` },
  ].filter((n): n is { err: boolean; text: string; title?: string } => !!n);
  const checked = [times.others && `profiles ${ago(l, times.others)}`, times.live && `running work ${ago(l, times.live)}`].filter(Boolean);
  return (
    <div className="inbox-fresh" role="status">
      <div className="inbox-note">{checked.length ? `Checked ${checked.join(", ")}.` : "Not checked yet."}</div>
      {notes.map((n) => (
        <div key={n.text} className={`inbox-note ${n.err ? "err" : ""}`} title={n.title}>
          {n.text}
        </div>
      ))}
      {live?.unsupported && onGuide && (
        <button className="link-btn inbox-note" onClick={onGuide} aria-label="Compatibility guide: Work in other profiles">
          Compatibility guide
        </button>
      )}
    </div>
  );
}
