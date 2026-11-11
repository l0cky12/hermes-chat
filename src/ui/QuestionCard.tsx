// A Clarify, Sudo password or Secret card (#390): what Hermes asks, and the owner's answer. A password or secret lives
// only in the card's masked DOM field until it goes to Hermes; the card then keeps only that it was answered (ADR 0138).
import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { KeyRound, MessageCircleQuestion } from "lucide-react";
import type { ClarifyQuestion, QuestionAnswer, QuestionItem } from "../hermes/model";
import { endedNote, useDeliberate, visible } from "./ApprovalCard";

type Card = Exclude<QuestionItem, { kind: "approval" }>;

/** Hermes marks the choice it recommends with this (`tools/clarify_tool.py` `mark_recommended`); it isn't the answer. */
const RECOMMENDED = "(Recommended)";
const bare = (choice: string) => (choice.endsWith(RECOMMENDED) ? choice.slice(0, -RECOMMENDED.length).trim() : choice);

/** A locked Clarify answer as the owner gave it: a multiple-choice one is a JSON list. */
function shownAnswer(q: ClarifyQuestion, answer: string | null): string {
  if (answer === null) return "Skipped";
  if (!q.multiSelect) return answer;
  try {
    const picked: unknown = JSON.parse(answer);
    return Array.isArray(picked) ? picked.map(String).join(", ") : answer;
  } catch {
    return answer;
  }
}

/** Enter in a field answers, unless an input method is composing. */
const onEnter = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  act();
};

/** What a waiting card asks, in its head. */
const asking = (i: Card) => (i.kind === "secret" ? `Hermes needs a value for ${i.envVar}` : i.kind === "sudo" ? "Hermes needs the sudo password" : "Hermes is asking");
const ANSWERED: Record<Card["kind"], string> = { clarify: "Answered", sudo: "Password sent", secret: "Value sent" };

/**
 * A card takes no focus when it arrives, so typing elsewhere never answers it; it answers only from its own buttons and
 * fields. Buttons ignore a double click and a click just after the transcript moved (`useDeliberate`). Offline, they
 * stay focusable but do nothing, so a reconnect doesn't drop the owner's place, and a typed value stays in its field.
 */
export function QuestionCard({ item, offline, movedAt = 0, onAnswer }: { item: Card; offline: boolean; movedAt?: number; onAnswer: (a: QuestionAnswer) => void }) {
  const deliberate = useDeliberate(movedAt);
  const closed = item.answer ?? item.ended;
  const card = useRef<HTMLDivElement>(null);
  const headId = useId();
  // As on an Approval card: when the fields and buttons go, focus stays on the card instead of falling to the page.
  const keepFocus = useCallback((body: HTMLDivElement | null) => {
    return () => void (body?.contains(document.activeElement) && card.current?.isConnected && card.current.focus());
  }, []);
  const head = item.answer === "skipped" ? "Skipped" : item.answer ? ANSWERED[item.kind] : item.ended ? endedNote(item.ended) : asking(item);
  const Icon = item.kind === "clarify" ? MessageCircleQuestion : KeyRound;
  const send = (a: QuestionAnswer) => !offline && onAnswer(a);
  return (
    <div ref={card} tabIndex={-1} role="group" aria-labelledby={headId} data-item={item.id} className={`approval question ${closed ? "answered" : ""}`}>
      <div className="approval-head" id={headId}>
        <Icon size={15} aria-hidden />
        {head}
      </div>
      {item.kind === "clarify" ? (
        <Clarify item={item} open={!closed} offline={offline} deliberate={deliberate} keepFocus={keepFocus} send={send} />
      ) : (
        <Masked item={item} open={!closed} offline={offline} deliberate={deliberate} keepFocus={keepFocus} send={send} />
      )}
    </div>
  );
}

type Parts = {
  open: boolean;
  offline: boolean;
  deliberate: ReturnType<typeof useDeliberate>;
  keepFocus: (body: HTMLDivElement | null) => () => void;
  send: (a: QuestionAnswer) => void;
};

/** Each question with its answer locked, or the ways to answer it; Skip skips every question not locked yet. */
function Clarify({ item, open, offline, deliberate, keepFocus, send }: Parts & { item: Extract<Card, { kind: "clarify" }> }) {
  const someLocked = Object.keys(item.locked).length > 0;
  return (
    <>
      <ol className="question-list">
        {item.questions.map((q) => (
          <li key={q.qid} className="question-row">
            <div className="question-text">{visible(q.question)}</div>
            {q.qid in item.locked ? (
              <div className="question-locked">{visible(shownAnswer(q, item.locked[q.qid]))}</div>
            ) : (
              open && <ClarifyAnswer q={q} offline={offline} deliberate={deliberate} keepFocus={keepFocus} lock={(answer) => send({ kind: "lock", qid: q.qid, answer })} />
            )}
          </li>
        ))}
      </ol>
      {open && (
        <div className="approval-actions" ref={keepFocus}>
          <button className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => send({ kind: "skip" }))}>
            {someLocked ? "Skip the rest" : "Skip"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One question's answer. A single choice locks as it is picked; several are ticked, then locked together with Lock
 * answer. Any question also takes words of the owner's own, as Hermes's clarify does.
 */
function ClarifyAnswer({ q, offline, deliberate, keepFocus, lock }: Pick<Parts, "offline" | "deliberate" | "keepFocus"> & { q: ClarifyQuestion; lock: (answer: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [words, setWords] = useState("");
  const typed = words.trim();
  const answer = q.multiSelect ? (picked.length || typed ? JSON.stringify([...picked.map(bare), ...(typed ? [typed] : [])]) : "") : typed;
  const go = () => !offline && answer && lock(answer);
  const fieldId = useId();
  return (
    <div className="question-answer" ref={keepFocus}>
      {q.choices.length > 0 && (
        <div className="question-choices" role={q.multiSelect ? "group" : undefined} aria-label={q.multiSelect ? "Choices" : undefined}>
          {q.choices.map((c) =>
            q.multiSelect ? (
              <label key={c} className="question-choice">
                <input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))} />
                {visible(c)}
              </label>
            ) : (
              <button key={c} className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => !offline && lock(bare(c)))}>
                {visible(c)}
              </button>
            ),
          )}
        </div>
      )}
      <div className="question-own">
        <label htmlFor={fieldId} className="sr-only">
          {q.choices.length ? "Or your own answer" : "Your answer"}
        </label>
        <input
          id={fieldId}
          className="question-field"
          value={words}
          placeholder={q.choices.length ? "Or type your own answer" : "Type your answer"}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={onEnter(go)}
        />
        {(q.multiSelect || !q.choices.length || typed) && (
          <button className="btn primary" aria-disabled={offline || !answer || undefined} onClick={deliberate(go)}>
            Lock answer
          </button>
        )}
      </div>
    </div>
  );
}

/** A Sudo password or Secret: what it is for, and while it waits, the masked field. */
function Masked({ item, open, ...parts }: Parts & { item: Exclude<Card, { kind: "clarify" }> }) {
  return (
    <>
      {item.kind === "sudo" ? (
        item.command && <pre className="approval-cmd">{visible(item.command)}</pre>
      ) : (
        <>
          {item.prompt && <div className="approval-desc question-prompt">{visible(item.prompt)}</div>}
          {item.skill && <div className="approval-desc">For the {visible(item.skill)} skill.</div>}
        </>
      )}
      {open && <MaskedField item={item} {...parts} />}
    </>
  );
}

/**
 * The masked field, whose value goes to Hermes and nowhere else. The field is uncontrolled, so the value is only in the
 * DOM field, never in React's state or props; React knows only whether it is empty. It shows only while the card
 * waits, so the value goes however the card closes, and Send clears it as it goes.
 */
function MaskedField({ item, offline, deliberate, keepFocus, send }: Omit<Parts, "open"> & { item: Exclude<Card, { kind: "clarify" }> }) {
  const field = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const fieldId = useId();
  const go = () => {
    const input = field.current;
    if (offline || !input?.value) return;
    send({ kind: "value", value: input.value });
    input.value = "";
    setFilled(false);
  };
  return (
    <div className="question-masked" ref={keepFocus}>
      <label htmlFor={fieldId} className="sr-only">
        {item.kind === "sudo" ? "Sudo password" : `Value for ${item.envVar}`}
      </label>
      <div className="question-own">
        <input
          ref={field}
          id={fieldId}
          className="question-field"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={item.kind === "sudo" ? "Sudo password" : item.envVar}
          onInput={(e) => setFilled(!!e.currentTarget.value)}
          onKeyDown={onEnter(go)}
        />
        <button className="btn primary" aria-disabled={offline || !filled || undefined} onClick={deliberate(go)}>
          Send
        </button>
        <button className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => send({ kind: "skip" }))}>
          Skip
        </button>
      </div>
      <div className="approval-desc question-note">
        {item.kind === "sudo"
          ? "It goes only to Hermes, which keeps it in memory for this chat's later sudo commands. Hermes Chat doesn't keep it."
          : `Hermes saves it as ${item.envVar} in this profile on the server. Hermes Chat doesn't keep it.`}
      </div>
    </div>
  );
}
