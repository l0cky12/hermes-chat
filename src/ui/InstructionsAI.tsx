// Write or improve a project's instructions with Hermes (issue #536, ADR 0152). A dialog over the project page: with
// text in the box Hermes rewrites it; with none the owner writes notes about the project, or answers Hermes's questions
// one at a time. Every call is a stateless `llm.oneshot` that adds nothing to any chat, and every way ends in the same
// review. Use this only fills the box; Save defaults decides what's kept.
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Check, CircleAlert, MessageCircleQuestion, NotebookPen, Sparkles } from "lucide-react";
import {
  MAX_QUESTIONS,
  draftCall,
  draftFrom,
  questionCall,
  questionFrom,
  type Answered,
  type Call,
  type ProjectFacts,
  type Source,
} from "../hermes/instructionsAI";
import { shortName } from "../hermes/models";
import { deadline } from "../hermes/remoteFiles";
import { ASK_DEADLINE_MS } from "../hermes/artifacts";
import { errorText } from "../hermes/values";
import { DiffView } from "./FileEditor";
import { Spinner, composing } from "./bits";
import { useModal } from "./modal";

/** How the dialog reaches Hermes. */
export type InstructionsWriter = {
  /** One stateless `llm.oneshot`; resolves with Hermes's text. */
  ask: (call: Call) => Promise<string>;
  /** The model that call runs on, to say who writes the draft. */
  model: () => Promise<{ provider: string; model: string; followsMain: boolean }>;
};

type Step =
  | { kind: "improve" }
  | { kind: "choose" }
  | { kind: "notes" }
  /** `question` undefined: none asked yet, or Hermes has heard enough. */
  | { kind: "questions"; question?: string }
  /** `before`: the box's text when the draft was asked for; Use this works only while the box still holds it. */
  | { kind: "review"; source: Source; before: string; draft: string };

export function InstructionsAI({
  project,
  profile,
  current,
  writer,
  onUse,
  onClose,
  returnTo,
}: {
  project: ProjectFacts;
  profile: string;
  /** The Instructions box's text now. */
  current: string;
  writer: InstructionsWriter;
  onUse: (text: string) => void;
  onClose: () => void;
  returnTo?: RefObject<HTMLElement | null>;
}) {
  const improving = !!current.trim();
  const [step, setStep] = useState<Step>(() => (improving ? { kind: "improve" } : { kind: "choose" }));
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Answered[]>([]);
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState<"question" | "draft">();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"side" | "changes">("side");
  const [model, setModel] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  // Each call's number; a call whose number isn't the latest was stopped, or the dialog closed, and its answer is dropped.
  const latest = useRef(0);

  const call = async (what: "question" | "draft", c: Call, then: (text: string) => void) => {
    const n = ++latest.current;
    setWorking(what);
    setError(undefined);
    try {
      const text = await deadline(writer.ask(c), ASK_DEADLINE_MS);
      if (latest.current === n) then(text);
    } catch (e) {
      if (latest.current === n) setError(`Hermes couldn't ${what === "draft" ? "write the instructions" : "ask the next question"}: ${errorText(e)}`);
    } finally {
      if (latest.current === n) setWorking(undefined);
    }
  };
  const stop = () => {
    latest.current++;
    setWorking(undefined);
  };

  const write = (source: Source, again?: { previous: string; note: string }) => {
    const before = current;
    void call("draft", draftCall(project, source, again), (text) => {
      setStep({ kind: "review", source, before, draft: draftFrom(text) });
      setNote("");
    });
  };
  const improve = () => write({ kind: "improve", text: current });

  /** Asks for the next question after `so`; with enough answers, or once Hermes says it has heard enough, writes. */
  const next = (so: Answered[]) => {
    const keep = () => {
      setAnswers(so);
      setAnswer("");
    };
    if (so.length >= MAX_QUESTIONS) {
      keep();
      setStep({ kind: "questions" });
      return write({ kind: "answers", answers: so });
    }
    void call("question", questionCall(project, so), (text) => {
      const got = questionFrom(text);
      keep();
      if ("question" in got) return setStep({ kind: "questions", question: got.question });
      setStep({ kind: "questions" });
      write({ kind: "answers", answers: so });
    });
  };
  const asked = step.kind === "questions" ? step.question : undefined;
  const reply = (skip: boolean) => asked && next([...answers, { question: asked, answer: skip || !answer.trim() ? undefined : answer.trim() }]);
  const writeNow = () => {
    const so = asked && answer.trim() ? [...answers, { question: asked, answer: answer.trim() }] : answers;
    setAnswers(so);
    setAnswer("");
    setStep({ kind: "questions" });
    write({ kind: "answers", answers: so });
  };

  useEffect(() => {
    let live = true;
    writer.model().then(
      (m) => live && setModel(`${m.provider ? `${m.provider} · ` : ""}${shortName(m.model) || "its default model"}${m.followsMain ? ", the main model" : ""}`),
      () => {},
    );
    if (improving) improve();
    return () => {
      live = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a call counter, not a node: bumping it on close drops any answer still on its way
      latest.current++;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open dialog: the model is read, and an improve asked for, when it opens
  }, []);

  const stale = step.kind === "review" && current !== step.before;
  const askAgain = () => {
    if (step.kind !== "review") return;
    write(step.source.kind === "improve" ? { kind: "improve", text: current } : step.source, { previous: step.draft, note });
  };
  const close = () => {
    stop();
    onClose();
  };
  const busy = working !== undefined;
  const title = improving ? "Improve the instructions with AI" : "Write the instructions with AI";

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog instructions-ai"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title instructions-ai-title">
          <Sparkles size={14} aria-hidden /> {title}
        </h2>
        <p className="muted small instructions-ai-model">
          Written by profile <span className="mono">{profile}</span>'s Text generation model{model ? <>: <span className="mono">{model}</span></> : ""}. Each
          step is a one-off call with no tools: no chat is started or changed, and nothing is saved until you Save defaults.
        </p>

        {step.kind === "improve" && (
          <div className="instructions-ai-pane">
            <span className="field-label">Your instructions</span>
            <div className="instructions-ai-text">{current}</div>
          </div>
        )}

        {step.kind === "choose" && (
          <div className="instructions-ai-ways" role="group" aria-label="How to start">
            <button className="instructions-ai-way" onClick={() => setStep({ kind: "notes" })}>
              <NotebookPen size={16} aria-hidden />
              <span>
                <span className="instructions-ai-way-name">Tell Hermes about the project</span>
                <span className="muted small">Paste or type what you know: what it is, the stack, conventions, what you want from its chats.</span>
              </span>
            </button>
            <button
              className="instructions-ai-way"
              onClick={() => {
                setStep({ kind: "questions" });
                next(answers);
              }}
            >
              <MessageCircleQuestion size={16} aria-hidden />
              <span>
                <span className="instructions-ai-way-name">Let Hermes ask me questions</span>
                <span className="muted small">One at a time, up to {MAX_QUESTIONS}. Skip any, or have it write whenever you like.</span>
              </span>
            </button>
          </div>
        )}

        {step.kind === "notes" && (
          <form
            className="instructions-ai-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (notes.trim() && !busy) write({ kind: "notes", notes });
            }}
          >
            <label className="field">
              <span className="field-label">About the project</span>
              <textarea
                autoFocus
                rows={9}
                value={notes}
                readOnly={busy}
                placeholder="What it is, the stack, conventions, what the chats should and shouldn't do…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <div className="confirm-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setStep({ kind: "choose" })}>
                Back
              </button>
              <button type="submit" className="btn primary" disabled={busy || !notes.trim()}>
                Write instructions
              </button>
            </div>
          </form>
        )}

        {step.kind === "questions" && (
          <div className="instructions-ai-form">
            {answers.length > 0 && (
              <details className="instructions-ai-answers">
                <summary className="small">
                  Your answers so far ({answers.filter((a) => a.answer !== undefined).length} answered, {answers.filter((a) => a.answer === undefined).length} skipped)
                </summary>
                <ol>
                  {answers.map((a, i) => (
                    <li key={i}>
                      <span className="muted">{a.question}</span> {a.answer ?? <em className="muted">Skipped</em>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {asked ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy && answer.trim()) reply(false);
                }}
              >
                <label className="field">
                  <span className="field-label">
                    Question {answers.length + 1} of up to {MAX_QUESTIONS}
                  </span>
                  <span className="instructions-ai-question">{asked}</span>
                  <textarea
                    autoFocus
                    aria-label="Your answer"
                    rows={4}
                    value={answer}
                    readOnly={busy}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !composing(e) && !busy && answer.trim()) {
                        e.preventDefault();
                        reply(false);
                      }
                    }}
                  />
                </label>
                <div className="confirm-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => reply(true)}>
                    Skip
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={writeNow}>
                    Write it now
                  </button>
                  <button type="submit" className="btn primary" disabled={busy || !answer.trim()}>
                    Next question
                  </button>
                </div>
              </form>
            ) : (
              !busy && (
                <div className="confirm-actions">
                  <button className="btn" onClick={() => next(answers)}>
                    {answers.length ? "Ask another question" : "Ask the first question"}
                  </button>
                  {answers.length > 0 && (
                    <button className="btn primary" onClick={writeNow}>
                      Write it now
                    </button>
                  )}
                </div>
              )
            )}
          </div>
        )}

        {step.kind === "review" && (
          <section className="instructions-ai-review" aria-label="Hermes's draft">
            {stale && (
              <p role="alert" className="files-editor-warn">
                <CircleAlert size={13} aria-hidden /> The Instructions box changed since you asked, so this draft would replace text it wasn't written for. Ask again
                to write from the box as it is now.
              </p>
            )}
            {step.source.kind === "improve" && (
              <div className="out-scopes instructions-ai-view" role="group" aria-label="Show">
                <button aria-pressed={view === "side"} className={`out-scope ${view === "side" ? "on" : ""}`} onClick={() => setView("side")}>
                  Side by side
                </button>
                <button aria-pressed={view === "changes"} className={`out-scope ${view === "changes" ? "on" : ""}`} onClick={() => setView("changes")}>
                  Changes
                </button>
              </div>
            )}
            {step.source.kind === "improve" && view === "changes" ? (
              <DiffView from={step.source.text} to={step.draft} label="Changes Hermes made" />
            ) : (
              <div className={step.source.kind === "improve" ? "instructions-ai-columns" : undefined}>
                {step.source.kind === "improve" && (
                  <div className="instructions-ai-pane">
                    <span className="field-label">Yours</span>
                    <div className="instructions-ai-text" aria-label="Your instructions">
                      {step.source.text}
                    </div>
                  </div>
                )}
                <div className="instructions-ai-pane">
                  <span className="field-label">Hermes's draft</span>
                  <div className="instructions-ai-text" aria-label="Hermes's draft" tabIndex={0}>
                    {step.draft}
                  </div>
                </div>
              </div>
            )}
            <label className="field instructions-ai-note">
              <span className="field-label">What to change if you ask again (optional)</span>
              <input value={note} readOnly={busy} placeholder="e.g. shorter, or more about testing" onChange={(e) => setNote(e.target.value)} />
            </label>
          </section>
        )}

        {busy && (
          <p className="instructions-ai-working small" role="status">
            <Spinner /> {working === "question" ? "Hermes is thinking of a question…" : "Hermes is writing…"}
            <button className="btn" onClick={stop}>
              Stop
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="branch-error instructions-ai-error">
            <CircleAlert size={13} aria-hidden /> {error} {step.kind === "review" || step.kind === "improve" ? "The box keeps what it had." : "Your text is kept here."}
          </p>
        )}

        <div className="confirm-actions instructions-ai-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          {step.kind === "review" && (
            <>
              {step.source.kind !== "improve" && (
                <button className="btn" disabled={busy} onClick={() => setStep(step.source.kind === "notes" ? { kind: "notes" } : { kind: "questions" })}>
                  {step.source.kind === "notes" ? "Edit notes" : "Back to questions"}
                </button>
              )}
              <button className="btn" disabled={busy} onClick={askAgain}>
                Ask again
              </button>
              <button
                className="btn primary"
                autoFocus
                disabled={busy || stale}
                onClick={() => {
                  onUse(step.draft);
                  onClose();
                }}
              >
                <Check size={14} aria-hidden /> Use this
              </button>
            </>
          )}
          {step.kind === "improve" && !busy && (
            <button className="btn primary" onClick={improve}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
