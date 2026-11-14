// Edit and Regenerate (ADR 0035): the buttons under a message and a reply, the dialog that says what the new branch
// holds and leaves out before anything is sent, and the switcher between the versions of a turn.
import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, FileText, Pencil, RefreshCw, Wrench } from "lucide-react";
import { BranchUnconfirmed } from "../hermes/transport";
import { modelLabel, type ReplayKind, type ReplayPreview, type Variant } from "../hermes/replay";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { useSpellCheck } from "./SpellCheckSettings";
import { errorText, plural } from "../hermes/values";

/** Under a message of the owner's: opens Edit. `blocked`: why it can't be used now, shown on hover. */
export function EditButton({ onEdit, blocked }: { onEdit: () => void; blocked?: string }) {
  return (
    <button
      className="msg-action"
      title={blocked ?? "Change this message and send it in a new branch. This chat stays as it is."}
      aria-label="Edit"
      aria-disabled={!!blocked}
      onClick={(e) => {
        e.currentTarget.focus();
        onEdit();
      }}
    >
      <Pencil size={13} aria-hidden />
      <span>Edit</span>
    </button>
  );
}

/** Under the last reply of a turn: opens Regenerate. `blocked`: why it can't be used now, shown on hover. */
export function RegenerateButton({ onRegenerate, blocked }: { onRegenerate: () => void; blocked?: string }) {
  return (
    <button
      className="msg-action"
      title={blocked ?? "Get another answer in a new branch. This answer stays here."}
      aria-label="Regenerate"
      aria-disabled={!!blocked}
      onClick={(e) => {
        e.currentTarget.focus();
        onRegenerate();
      }}
    >
      <RefreshCw size={13} aria-hidden />
      <span>Regenerate</span>
    </button>
  );
}

/** What the dialog needs from the transport: read what would be made, and make it. */
export type ReplayApi = {
  preview: () => Promise<ReplayPreview>;
  make: (preview: ReplayPreview, words?: string) => Promise<{ chatId: string; warnings: string[] }>;
};

type State =
  | { phase: "loading" }
  | { phase: "refused"; why: string }
  | { phase: "ready"; preview: ReplayPreview; error?: string }
  | { phase: "making"; preview: ReplayPreview }
  | { phase: "unconfirmed"; why: string };

const TITLE: Record<ReplayKind, string> = { edit: "Edit message", regenerate: "Regenerate reply" };
const SHOWN = 12;

/**
 * Edit or Regenerate under one message. It reads first what the new branch would start with and what it leaves out,
 * then sends nothing until the owner confirms. An Edit opens on the message's words as Hermes stored them. `done` gets
 * the branch's chat id and what went wrong after it was made; `onClose` closes without making one. The composer's
 * Draft is never touched. Late answers after it closed change nothing.
 */
export function ReplayDialog({
  kind,
  api,
  done,
  onClose,
}: {
  kind: ReplayKind;
  api: ReplayApi;
  done: (chatId: string, warnings: string[]) => void;
  onClose: () => void;
}) {
  const spellCheck = useSpellCheck();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [words, setWords] = useState<string>();
  const [missingOk, setMissingOk] = useState(false);
  const open = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const textId = useId();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    open.current = true;
    apiRef.current.preview().then(
      (preview) => {
        if (!open.current) return;
        setWords((w) => w ?? preview.words);
        setState({ phase: "ready", preview });
      },
      (e) => open.current && setState({ phase: "refused", why: errorText(e) }),
    );
    return () => void (open.current = false);
  }, []);

  const make = (preview: ReplayPreview) => {
    setState({ phase: "making", preview });
    apiRef.current.make(preview, words).then(
      ({ chatId, warnings }) => open.current && done(chatId, warnings),
      (e) => {
        if (!open.current) return;
        if (e instanceof BranchUnconfirmed) setState({ phase: "unconfirmed", why: e.message });
        else setState({ phase: "ready", preview, error: errorText(e) });
      },
    );
  };

  const busy = state.phase === "making";
  const preview = state.phase === "ready" || state.phase === "making" ? state.preview : undefined;
  const edited = !!preview && kind === "edit" && words !== preview.words;
  // An edit typed and not saved isn't dropped by a stray Escape or click outside: Cancel says so.
  const close = (force = false) => !busy && (force || !edited) && onClose();
  const files = preview?.branch.files ?? [];
  const missing = files.filter((f) => f.state === "missing");
  const canMake = !!preview && !busy && (kind === "regenerate" || !!words?.trim()) && (!missing.length || missingOk);
  // The history the branch keeps: what Branch from here would copy, less the owner's message, which goes again.
  const kept = preview ? preview.branch.messages.slice(0, -1) : [];

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog branch-dialog replay-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={state.phase === "loading" || busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title branch-title">
          {kind === "edit" ? <Pencil size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />} {TITLE[kind]}
        </h2>
        {state.phase === "loading" && (
          <p className="branch-loading" role="status">
            <Spinner /> Reading this chat's history from Hermes…
          </p>
        )}
        {state.phase === "refused" && (
          <p role="alert" className="branch-error">
            <CircleAlert size={13} aria-hidden /> {state.why}
          </p>
        )}
        {state.phase === "unconfirmed" && (
          <p role="alert" className="branch-unsure">
            <CircleAlert size={13} aria-hidden /> {state.why} Asking again for the same message won't make a second branch.
          </p>
        )}
        {preview && (
          <>
            {kind === "edit" ? (
              <p>
                Your edited message goes to a new branch of <b>{preview.branch.parentTitle}</b>, after the history before it. This chat stays as it is,
                with your original message and everything after it.
              </p>
            ) : (
              <p>
                Hermes answers your message <q className="branch-quote">{preview.branch.point.excerpt}</q> again, in a new branch of{" "}
                <b>{preview.branch.parentTitle}</b>. This answer stays here, and you can switch between the answers under the reply.
              </p>
            )}
            {kind === "edit" && (
              <>
                <label className="field-label" htmlFor={textId}>
                  Your message
                </label>
                <textarea
                  id={textId}
                  className="branch-name replay-text"
                  autoFocus
                  spellCheck={spellCheck}
                  rows={Math.min(10, Math.max(3, (words ?? "").split("\n").length + 1))}
                  value={words ?? ""}
                  disabled={busy}
                  onChange={(e) => setWords(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canMake) {
                      e.preventDefault();
                      make(preview);
                    }
                  }}
                />
              </>
            )}
            {kind === "regenerate" && preview.answer && (
              <section aria-label="This answer" className="branch-section">
                <h3>Stays in this chat</h3>
                <p className="muted small">
                  <span className="branch-who">Hermes</span> {preview.answer}
                </p>
              </section>
            )}
            <section aria-label="Not in the new branch" className="branch-section">
              <h3>Not in the new branch: {plural(preview.later.length, "message")}</h3>
              <p className="muted small">
                {kind === "edit" ? "Your original message and what came after it" : "Your message as it was answered here, and what came after it"} stay
                in {preview.branch.parentTitle}
                {preview.laterTools ? `, with ${plural(preview.laterTools, "tool call")}` : ""}. The new branch starts with{" "}
                {plural(kept.length, "message")} before it.
              </p>
              <ol className="branch-history replay-later">
                {preview.later.slice(0, SHOWN).map((m, i) => (
                  <li key={i} className={m.role}>
                    <span className="branch-who">{m.role === "user" ? "You" : "Hermes"}</span> {m.excerpt}
                  </li>
                ))}
              </ol>
              {preview.later.length > SHOWN && <p className="muted small">And {plural(preview.later.length - SHOWN, "later message")}.</p>}
            </section>
            {files.length > 0 && (
              <section aria-label="Files" className="branch-section">
                <h3>
                  <FileText size={12} aria-hidden /> Files sent with it
                </h3>
                <p className="muted small">{kind === "edit" ? "They go with the edited message too." : "They go with the message again."}</p>
                <ul className="branch-files">
                  {files.map((f) => (
                    <li key={f.path} className={f.state}>
                      <span className="mono">{f.path}</span>{" "}
                      <span className="branch-file-state">
                        {f.state === "there" ? "On the server." : f.state === "missing" ? "No longer on the server: Hermes won't find it." : "Couldn't check whether it's still on the server."}
                      </span>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 && (
                  <label className="branch-ack">
                    <input type="checkbox" checked={missingOk} disabled={busy} onChange={(e) => setMissingOk(e.target.checked)} /> Send anyway, naming{" "}
                    {missing.length === 1 ? "a file" : "files"} Hermes won't find.
                  </label>
                )}
              </section>
            )}
            <dl className="files-meta branch-meta">
              <dt>Model</dt>
              <dd>{modelLabel(preview.branch.model) ?? "The profile's model"}, as this chat</dd>
              <dt>Folder</dt>
              <dd>The same folder on the server as this chat</dd>
            </dl>
            <p className="branch-warning">
              <Wrench size={13} aria-hidden /> This doesn't undo anything Hermes did after your original message: files it changed, commands it ran and
              anything it sent stay as they are, and the branch's tools work on the same server.
            </p>
            {state.phase === "ready" && state.error && (
              <p role="alert" className="branch-error">
                <CircleAlert size={13} aria-hidden /> {state.error}
              </p>
            )}
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" disabled={busy} autoFocus={!preview} onClick={() => close(true)}>
            {preview ? "Cancel" : "Close"}
          </button>
          {preview && (
            <button className="btn primary" disabled={!canMake} onClick={() => make(preview)}>
              {busy ? (
                <>
                  <Spinner /> {kind === "edit" ? "Saving…" : "Regenerating…"}
                </>
              ) : kind === "edit" ? (
                "Save as branch"
              ) : (
                "Regenerate"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<Variant["kind"], string> = { original: "Original", edit: "Edited", regenerate: "Regenerated" };

/**
 * The versions of one turn, under its last reply: which one this chat is, what each ran on, and a way to the one before
 * or after. `current`: this chat's place among them. Each version is its own chat; going to one opens it at this turn.
 */
export function VariantNav({ versions, current, onPick }: { versions: Variant[]; current: number; onPick: (chatId: string) => void }) {
  const here = versions[current];
  const model = modelLabel(here.model);
  return (
    <div className="variant-nav" role="group" aria-label="Versions of this turn">
      <button className="icon-btn" aria-label="Previous version" disabled={current === 0} onClick={() => onPick(versions[current - 1].chatId)}>
        <ChevronLeft size={14} />
      </button>
      <span className="variant-count">
        {current + 1} / {versions.length}
      </span>
      <button className="icon-btn" aria-label="Next version" disabled={current === versions.length - 1} onClick={() => onPick(versions[current + 1].chatId)}>
        <ChevronRight size={14} />
      </button>
      <span className="variant-what">
        {KIND_LABEL[here.kind]}
        {model ? ` · ${model}` : " · model not known"}
        {/* Hermes keeps no model per reply: for the original, all that's known is what the chat runs on now. */}
        {model && here.kind === "original" ? " (the chat's model now)" : ""}
      </span>
    </div>
  );
}

