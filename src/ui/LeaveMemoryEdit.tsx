// Asking before an unsaved edit in Settings → Memory or Settings → Skills is dropped: by leaving Settings, opening a chat, switching
// profile, signing out, or closing the window (MemorySettings.tsx). The edit lives only on screen, so it would be lost.
import { useEffect, useId } from "react";
import { guardWindowClose } from "./tauriWindow";
import { AlertTriangle } from "lucide-react";

/** The question, over the whole window. Keep editing has focus, so a stray Enter keeps the edit; Escape keeps it too. */
export function LeaveMemoryEdit({
  profile,
  onStay,
  onDiscard,
  subject = "memory",
}: {
  profile: string;
  onStay: () => void;
  onDiscard: () => void;
  /** Whose edit it is: Settings → Memory's, or Settings → Skills'. */
  subject?: "memory" | "skill";
}) {
  const noteId = useId();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div
        className="leave-dialog confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Discard your ${subject} edit?`}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onStay();
          }
        }}
      >
        <span className="confirm-msg">
          <AlertTriangle size={13} /> Discard your {subject} edit?
        </span>
        <span id={noteId}>
          {subject === "skill" ? (
            <>
              You have an edit to a skill in the <span className="mono">{profile}</span> profile{" "}
            </>
          ) : (
            "You have an edit in Settings → Memory, to a memory entry or a memory provider's settings, "
          )}
          that isn't saved to Hermes. Leaving now drops it.
        </span>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Keep editing
          </button>
          <button className="btn danger" onClick={onDiscard}>
            Discard edit
          </button>
        </div>
      </div>
    </div>
  );
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * While `unsaved`, closing the window asks first (`ask` runs with what closes it), and so does reloading the page in a
 * browser. Listening only then leaves an ordinary close to Tauri itself.
 */
export function useCloseGuard(unsaved: boolean, ask: (close: () => void) => void) {
  useEffect(() => {
    if (!unsaved) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    let unlisten: (() => void) | undefined;
    let gone = false;
    if (inTauri()) void guardWindowClose(ask).then((stop) => (gone ? stop() : (unlisten = stop)));
    return () => {
      gone = true;
      window.removeEventListener("beforeunload", onUnload);
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- guard only while `unsaved` holds; callers pass a new `ask` each render, so listing it would drop and add the window-close guard on every render
  }, [unsaved]);
}
