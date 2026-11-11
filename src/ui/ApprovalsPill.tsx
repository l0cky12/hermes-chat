import { Fragment, useRef, useState } from "react";
import { Check, ChevronDown, Shield, ShieldCheck, ShieldQuestionMark, Zap } from "lucide-react";
import { PICK_COPY, badgeOf, type ApprovalPick, type ApprovalsBadge } from "../hermes/approvals";
import type { Approvals } from "../hermes/model";
import { useDismiss, useReturnFocus } from "./bits";
import { errorText } from "../hermes/values";

/**
 * `approvals`: the chat's, as Hermes reported them; undefined until it has. `profile`: the profile Smart and Manual
 * change. `onPick`: resolves once Hermes has answered, or rejects with Hermes's reason.
 */
export type ApprovalsPillProps = { approvals?: Approvals; connected: boolean; profile: string; onPick: (pick: ApprovalPick) => Promise<void> };

const PICKS: ApprovalPick[] = ["smart", "manual", "yolo"];

const ICON = { smart: ShieldCheck, manual: ShieldQuestionMark, yolo: Zap };

function faceOf(b: ApprovalsBadge) {
  if (b.kind === "unknown") return { Icon: Shield, label: "Approvals", scope: "", full: "unknown" };
  if (b.kind === "mode") return { Icon: ICON[b.mode], label: PICK_COPY[b.mode].name, scope: "", full: PICK_COPY[b.mode].name };
  const scope = b.scope === "chat" ? "this chat" : "all chats";
  return { Icon: Zap, label: "YOLO", scope, full: `YOLO, ${scope}` };
}

const tickedOf = (b: ApprovalsBadge): ApprovalPick | undefined => (b.kind === "mode" ? b.mode : b.kind === "yolo" ? "yolo" : undefined);

export function ApprovalsPill({ approvals, connected, profile, onPick }: ApprovalsPillProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const wrap = useRef<HTMLDivElement>(null);
  // A sent write can't be taken back, so the menu stays until Hermes answers it.
  const close = () => busy || setOpen(false);
  useDismiss(wrap, open, close);
  const send = (pick: ApprovalPick) => {
    setBusy(true);
    setError(undefined);
    onPick(pick).then(
      () => {
        setBusy(false);
        setOpen(false);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  const badge = badgeOf(approvals);
  const { Icon, label, scope, full } = faceOf(badge);
  const blocked = !connected
    ? "Connect to Hermes to change the approval mode."
    : !approvals
      ? "Hermes hasn't reported this chat's approval mode yet."
      : undefined;
  const yolo = badge.kind === "yolo";
  return (
    <div className="pill-wrap" ref={wrap}>
      <button
        className={`reasoning-pill approvals-pill${yolo ? " yolo" : ""}${open ? " on" : ""}`}
        aria-label={`Approval mode: ${full}`}
        aria-description={blocked}
        title={blocked ?? "Approval mode"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!!blocked}
        onClick={() => {
          if (busy) return;
          setError(undefined);
          setOpen((o) => !o);
        }}
      >
        <Icon size={12} aria-hidden />
        <span className="approvals-label">
          {label}
          {scope && <span className="approvals-scope"> · {scope}</span>}
        </span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && !blocked && <ApprovalsMenu badge={badge} profile={profile} busy={busy} error={error} send={send} onClose={close} />}
    </div>
  );
}

type MenuProps = { badge: ApprovalsBadge; profile: string; busy: boolean; error?: string; send: (pick: ApprovalPick) => void; onClose: () => void };

function ApprovalsMenu({ badge, profile, busy, error, send, onClose }: MenuProps) {
  useReturnFocus();
  const [confirming, setConfirming] = useState(false);
  const ticked = tickedOf(badge);
  const escape = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose();
  };
  const alert = error && (
    <div className="approvals-error" role="alert">
      {error}
    </div>
  );
  if (confirming)
    return (
      <div className="status-popover approvals-confirm" role="dialog" aria-label="Turn on YOLO for this chat?" onKeyDown={escape}>
        <div className="popover-title">Turn on YOLO for this chat?</div>
        <p className="small">Hermes will run commands in this chat without asking you first, dangerous ones too. Other chats still ask.</p>
        <ul>
          <li>Writes to AGENTS.md, CLAUDE.md and SOUL.md still ask.</li>
          <li>Commands on Hermes's blocklist are still blocked.</li>
        </ul>
        {alert}
        <div className="confirm-actions">
          <button className="btn" autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy} onClick={() => send("yolo")}>
            Turn on YOLO
          </button>
        </div>
      </div>
    );
  return (
    <div className="menu pill-menu approvals-menu" role="menu" aria-label="Approval mode" aria-busy={busy} onKeyDown={escape}>
      <div className="menu-heading">Approvals</div>
      {PICKS.map((pick) => {
        const copy = PICK_COPY[pick];
        const Icon = ICON[pick];
        return (
          <Fragment key={pick}>
            {pick === "yolo" && <div className="menu-sep" role="separator" />}
            <button
              role="menuitemradio"
              aria-checked={pick === ticked}
              aria-label={copy.name}
              aria-description={`${copy.tag}. ${copy.what}`}
              className={`menu-item approvals-option ${pick}`}
              autoFocus={pick === ticked}
              disabled={busy}
              onClick={() => {
                if (pick !== "yolo") send(pick);
                else if (badge.kind === "yolo") onClose();
                else setConfirming(true);
              }}
            >
              <span className="menu-icon">
                <Icon size={13} />
              </span>
              <span className="approvals-name">{copy.name}</span>
              <span className="approvals-check">{pick === ticked && <Check size={13} />}</span>
              <span className="approvals-tag">{copy.tag}</span>
              <span className="approvals-what">{copy.what}</span>
            </button>
          </Fragment>
        );
      })}
      {alert}
      <p className="approvals-note">
        Smart and Manual change every chat on the <b>{profile}</b> profile, including CLI and Telegram ones. A change applies from Hermes's next command.
      </p>
    </div>
  );
}
