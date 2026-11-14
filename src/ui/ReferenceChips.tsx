// The chats an unsent message references (chatReferences.ts, ADR 0165), as chips above the composer's text: each one
// summarizing, ready, or failed with why. A ready chip opens the summary that will be sent.
import { useState } from "react";
import { CircleAlert, Link2, X } from "lucide-react";
import type { Reference } from "../hermes/chatReferences";
import { Spinner } from "./bits";

const STATE = { summarizing: "summarizing", ready: "summary ready", failed: "summary failed" };

export function ReferenceChips({
  refs,
  onRetry,
  onRemove,
  onTextModelSettings,
}: {
  refs: readonly Reference[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onTextModelSettings?: () => void;
}) {
  const [shown, setShown] = useState<string>();
  const open = refs.find((r): r is Extract<Reference, { state: "ready" }> => r.id === shown && r.state === "ready");
  return (
    <>
      <div className="chips">
        {refs.map((r) => (
          <span key={r.id} className={`chip ref-chip ${r.state}`}>
            <button
              className="ref-chip-main"
              aria-label={`Referenced chat ${r.title}, ${STATE[r.state]}${r.state === "ready" ? ". Show the summary" : ""}`}
              aria-expanded={r.state === "ready" ? open === r : undefined}
              title={r.state === "ready" ? "Show the summary that goes with the message" : r.state === "failed" ? r.why : "Hermes is summarizing this chat"}
              onClick={() => r.state === "ready" && setShown(open === r ? undefined : r.id)}
            >
              <Link2 size={12} aria-hidden />
              <span className="chip-name">{r.title}</span>
              <span className="chip-size">
                {r.state === "summarizing" ? <Spinner /> : r.state === "ready" ? "Summary ready" : <CircleAlert size={12} className="ref-warn" aria-hidden />}
              </span>
            </button>
            <button title="Remove" aria-label={`Remove the reference to ${r.title}`} onClick={() => onRemove(r.id)}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      {refs.map(
        (r) =>
          r.state === "failed" && (
            <div key={r.id} className="attach-note ref-failed" role="alert">
              Couldn't summarize {r.title}: {r.why}{" "}
              <button className="link-btn" onClick={() => onRetry(r.id)}>
                Retry
              </button>
              {r.fix === "text-model" && onTextModelSettings && (
                <button className="link-btn" onClick={onTextModelSettings}>
                  Text generation settings
                </button>
              )}
            </div>
          ),
      )}
      {open && (
        <div className="ref-summary" role="region" aria-label={`Summary of ${open.title}`}>
          {open.summary}
        </div>
      )}
    </>
  );
}
