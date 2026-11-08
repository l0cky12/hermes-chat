// The question before Settle all clears the Inbox (issue #303). It names the chats with an Approval waiting or a
// failure, so nothing the owner may want to look at is cleared by surprise. Cancel has focus, so a stray Enter keeps them.
import { useRef, type RefObject } from "react";
import { Archive } from "lucide-react";
import type { InboxSettle } from "../hermes/snooze";
import { composing } from "./bits";
import { useModal } from "./modal";

const chats = (n: number) => `${n} chat${n === 1 ? "" : "s"}`;
const have = (n: number) => (n === 1 ? "has" : "have");

export function settleAllNote({ approvals, failures }: Pick<InboxSettle, "approvals" | "failures">): string {
  const waiting = [
    approvals > 0 && `${approvals} of them ${have(approvals)} an Approval waiting`,
    failures > 0 && `${failures} of them ${have(failures)} a failure`,
  ].filter(Boolean);
  return `${waiting.length ? `${waiting.join(", and ")}. ` : ""}They move to the Settled drawer, and you can undo it.`;
}

export function SettleAllDialog({
  inbox,
  returnTo,
  onSettle,
  onClose,
}: {
  inbox: InboxSettle;
  returnTo?: RefObject<HTMLElement | null>;
  onSettle: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog settle-all-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settle-all-title"
        aria-describedby="settle-all-note"
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="settle-all-title" className="leave-title">
          <Archive size={14} aria-hidden /> Settle {chats(inbox.ids.length)} from the Inbox?
        </h2>
        <p id="settle-all-note" className="muted">
          {settleAllNote(inbox)}
        </p>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSettle}>
            Settle all
          </button>
        </div>
      </div>
    </div>
  );
}
