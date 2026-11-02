// Asks before leaving an unsaved Persona edit: going back to the chats, switching profile, signing out or closing the
// window. Keep editing has focus, so a stray Enter stays. The edit is kept on this computer either way.
import { useId } from "react";
import { TriangleAlert } from "lucide-react";
import { composing } from "./bits";

/** What leaving does: `leave` Settings or its Persona tab, `profile` switch, `signout`, or `close` the window. */
export type LeaveWhat = "leave" | "profile" | "signout" | "close";

const TITLE: Record<LeaveWhat, string> = {
  leave: "Leave without saving the persona?",
  profile: "Switch profile without saving the persona?",
  signout: "Sign out without saving the persona?",
  close: "Close Hermes Chat without saving the persona?",
};
const GO: Record<LeaveWhat, string> = { leave: "Leave", profile: "Switch anyway", signout: "Sign out", close: "Close anyway" };

export function LeavePersona({ what, profile, onGo, onStay }: { what: LeaveWhat; profile: string; onGo: () => void; onStay: () => void }) {
  const title = useId();
  const note = useId();
  return (
    <div className="palette-scrim leave-scrim" onMouseDown={onStay}>
      <div
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={note}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && onStay()}
      >
        <div id={title} className="confirm-msg leave-title">
          <TriangleAlert size={14} /> {TITLE[what]}
        </div>
        <p id={note} className="muted">
          Your changes to SOUL.md for the <span className="mono">{profile}</span> profile haven't been saved to Hermes. They stay on this computer, and
          Settings → Persona offers them back next time.
        </p>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Keep editing
          </button>
          <button className="btn danger" onClick={onGo}>
            {GO[what]}
          </button>
        </div>
      </div>
    </div>
  );
}
