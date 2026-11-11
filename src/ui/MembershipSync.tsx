// Which chats are in which project, kept by Hermes when it can (ADR 0109): the status line on the project screen and
// in the project switcher, and the dialog that previews the move of this computer's membership to Hermes and settles
// changes that conflict with another computer's.
import { useId, useRef, useState, type RefObject } from "react";
import { CircleAlert, CloudOff, RefreshCw, Users } from "lucide-react";
import type { Link } from "../hermes/membership";
import type { MembershipSync, Project } from "../hermes/projects";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { errorText, plural } from "../hermes/values";

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { timeStyle: "short" });

/** The membership sync wants the owner: a move to preview, or a conflict to settle. */
export function needsOwner(m: MembershipSync): boolean {
  return m.state === "preview" || m.pending.some((o) => o.conflict);
}

/** One line saying where membership is kept and how far it is from Hermes, for the project screen. */
export function membershipLine(m: MembershipSync): string {
  const conflicts = m.pending.filter((o) => o.conflict).length;
  const waiting = m.pending.length - conflicts;
  const tail = [
    waiting > 0 && `${plural(waiting, "change waits", "changes wait")} to sync.`,
    conflicts > 0 && `${plural(conflicts, "change conflicts", "changes conflict")} with another computer's.`,
  ]
    .filter(Boolean)
    .join(" ");
  switch (m.state) {
    case "unknown":
    case "checking":
      return "Checking whether Hermes keeps which chats are in each project…";
    case "local":
      return m.preview?.later
        ? "Which chats are in it is kept on this computer. Hermes can keep it, so every computer shows the same."
        : "Which chats are in it is kept on this computer: this Hermes doesn't keep it, so other computers don't see it.";
    case "preview":
      return "Hermes can keep which chats are in each project. Review what moves before it does.";
    case "syncing":
      return "Syncing which chats are in each project with Hermes…";
    case "synced":
      return `Hermes keeps which chats are in it, so every computer shows the same.${m.at ? ` Synced ${clock(m.at)}.` : ""}`;
    case "pending":
      return `Hermes keeps which chats are in it. ${tail || "Waiting to sync."}`;
    case "stranded":
      return `This Hermes no longer answers which chats are in each project. Showing the ones last read.${tail ? ` ${tail}` : ""}`;
  }
}

/** The status on the project screen, with Sync now and Review. */
export function MembershipStatus({
  membership: m,
  connected,
  onSync,
  onReview,
}: {
  membership: MembershipSync;
  connected: boolean;
  onSync: () => void;
  onReview: () => void;
}) {
  const busy = m.state === "checking" || m.state === "syncing";
  const canSync = m.moved || m.state === "local";
  const review = needsOwner(m) || (m.state === "local" && m.preview?.later) || m.refused.length > 0;
  return (
    <div className={`membership-status ms-${m.state}`} role="status">
      <span className="membership-icon" aria-hidden>
        {busy ? <Spinner /> : m.state === "pending" || m.state === "stranded" ? <CloudOff size={14} /> : <Users size={14} />}
      </span>
      <span className="membership-text">
        {membershipLine(m)}
        {m.error && <span className="membership-error"> {m.error}</span>}
      </span>
      <span className="membership-actions">
        {review && (
          <button className="btn" onClick={onReview}>
            {m.state === "local" ? "Move to Hermes…" : "Review…"}
          </button>
        )}
        {canSync && !busy && (
          <button className="btn" disabled={!connected} title={connected ? "Send waiting changes and read other computers' changes" : "Connect to Hermes to sync"} onClick={onSync}>
            <RefreshCw size={13} /> Sync now
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The move of this computer's membership to Hermes, before it runs, and the changes that conflict with another
 * computer's. Hermes's state stands for a conflict until the owner picks.
 */
export function MembershipDialog({
  membership: m,
  projects,
  titleOf,
  returnTo,
  connected,
  onMigrate,
  onLater,
  onKeepMine,
  onUseHermes,
  onClose,
}: {
  membership: MembershipSync;
  projects: Project[];
  /** A chat's title, if the list has it. */
  titleOf: (chatId: string) => string | undefined;
  returnTo?: RefObject<HTMLElement | null>;
  connected: boolean;
  onMigrate: () => Promise<void>;
  onLater: () => void;
  onKeepMine: (opId: string) => void;
  onUseHermes: (opId: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "a deleted project";
  const chatName = (id: string) => titleOf(id) ?? `a chat not in the list (${id})`;
  const linkText = (l: Link) => `${chatName(l.chatId)} in ${projectName(l.projectId)}`;
  const conflicts = m.pending.filter((o) => o.conflict);
  const preview = m.preview && !m.moved ? m.preview : undefined;

  const migrate = () => {
    setMoving(true);
    setError(undefined);
    onMigrate().then(
      () => onClose(),
      (e) => {
        setMoving(false);
        setError(errorText(e));
      },
    );
  };

  const list = (links: Link[], label: string) =>
    links.length > 0 && (
      <section className="membership-group" aria-label={label}>
        <h3>
          {label}: {links.length}
        </h3>
        <ul>
          {links.slice(0, 50).map((l) => (
            <li key={`${l.projectId}/${l.chatId}`}>{linkText(l)}</li>
          ))}
          {links.length > 50 && <li className="muted">and {links.length - 50} more</li>}
        </ul>
      </section>
    );

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !moving && onClose()}>
      <div
        ref={box}
        className="leave-dialog membership-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={moving}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !moving) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title membership-title">
          <Users size={14} aria-hidden /> {preview ? "Move project chats to Hermes" : "Project chats to sync"}
        </h2>
        {preview && (
          <>
            <p>
              This Hermes can keep which chats are in each project, so every computer signed in to it shows the same. Here is what moving this
              computer's grouping does. Nothing is sent until you choose Move.
            </p>
            {list(preview.add, "Sent to Hermes")}
            {list(preview.already, "Already on Hermes, left as they are")}
            {list(preview.serverOnly, "Put there by another computer, shown here from now on")}
            {list(preview.noProject, "In a project Hermes no longer has, not sent")}
            <p className="muted small">
              This computer's grouping is copied aside first, as a recovery copy. Moving again later, or from another computer, makes no duplicates. If
              the connection drops partway, what's left is sent at the next sync.
            </p>
          </>
        )}
        {conflicts.length > 0 && (
          <section className="membership-group" aria-label="Conflicts">
            <h3>
              <CircleAlert size={12} aria-hidden /> Changed on another computer: {conflicts.length}
            </h3>
            <p className="muted small">
              Another computer changed these after this one last synced. Hermes's version is shown until you pick.
            </p>
            <ul className="membership-conflicts">
              {conflicts.map((o) => (
                <li key={o.opId}>
                  <span>
                    You {o.member ? "put" : "took"} <b>{chatName(o.chatId)}</b> {o.member ? "in" : "out of"} <b>{projectName(o.projectId)}</b>
                    {o.at ? ` at ${clock(o.at)}` : ""}. On Hermes it is {o.conflict!.serverMember ? "in" : "out of"} it.
                  </span>
                  <span className="confirm-actions">
                    <button className="btn" onClick={() => onUseHermes(o.opId)}>
                      Use Hermes's
                    </button>
                    <button className="btn primary" disabled={!connected} title={connected ? undefined : "Connect to Hermes to send it"} onClick={() => onKeepMine(o.opId)}>
                      Keep mine
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {m.pending.length > conflicts.length && (
          <p className="muted small">
            {plural(m.pending.length - conflicts.length, "change waits", "changes wait")} on this computer and {m.pending.length - conflicts.length === 1 ? "goes" : "go"} to
            Hermes at the next sync.
          </p>
        )}
        {m.refused.length > 0 && (
          <section className="membership-group" aria-label="Not kept">
            <h3>Not kept: {m.refused.length}</h3>
            <ul>
              {m.refused.map((r, i) => (
                <li key={i}>
                  {linkText(r.link)}: {r.why === "no_project" ? "Hermes no longer has the project." : "Hermes no longer has the chat."}
                </li>
              ))}
            </ul>
          </section>
        )}
        {!preview && !conflicts.length && !m.refused.length && <p className="muted">Nothing needs you: every change is synced or waiting.</p>}
        {(m.error || error) && (
          <p role="alert" className="branch-error">
            <CircleAlert size={13} aria-hidden /> {error ?? m.error}
          </p>
        )}
        <div className="confirm-actions">
          {preview ? (
            <>
              <button
                className="btn"
                disabled={moving}
                onClick={() => {
                  onLater();
                  onClose();
                }}
              >
                Not now
              </button>
              <button className="btn primary" autoFocus disabled={moving || !connected} title={connected ? undefined : "Connect to Hermes to move"} onClick={migrate}>
                {moving ? "Moving…" : preview.add.length ? `Move ${plural(preview.add.length, "link")} to Hermes` : "Move to Hermes"}
              </button>
            </>
          ) : (
            <button className="btn" autoFocus onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
