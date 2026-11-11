// Branch from here (ADR 0027): the button under a message, the preview that says what the branch will hold before
// Hermes makes it, and the note at the top of a branch that links back to where it came from.
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { CircleAlert, FileText, GitBranch, Image as ImageIcon, Wrench } from "lucide-react";
import type { BranchLink, BranchPreview } from "../hermes/branch";
import { BranchUnconfirmed } from "../hermes/transport";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { errorText, plural } from "../hermes/values";

/** Under a message: opens the preview of a branch from it. `blocked`: why no branch can be made now, shown on hover. */
export function BranchButton({ onBranch, blocked }: { onBranch: () => void; blocked?: string }) {
  return (
    <button
      className="msg-action"
      title={blocked ?? "Start a new chat from this point. This chat stays as it is."}
      aria-label="Branch from here"
      aria-disabled={!!blocked}
      onClick={(e) => {
        // Kept as the place focus goes back to when the preview closes.
        e.currentTarget.focus();
        onBranch();
      }}
    >
      <GitBranch size={13} aria-hidden />
      <span>Branch from here</span>
    </button>
  );
}

/** What the dialog needs from the transport: read the preview, and make the branch it describes. */
export type BranchApi = {
  preview: () => Promise<BranchPreview>;
  make: (preview: BranchPreview, title?: string) => Promise<{ chatId: string; warnings: string[] }>;
};

type State =
  | { phase: "loading" }
  | { phase: "refused"; why: string }
  | { phase: "ready"; preview: BranchPreview; error?: string }
  | { phase: "making"; preview: BranchPreview }
  | { phase: "unconfirmed"; why: string };

/** The preview lists this many of the last messages copied. */
const SHOWN_MESSAGES = 40;
const whose = (role: "user" | "assistant") => (role === "user" ? "your message" : "Hermes's reply");

/**
 * The preview of a branch from one message, and the button that makes it. It reads what the branch would hold first:
 * the messages copied, what isn't copied (tool results), the files and images the messages refer to, and the model.
 * A file no longer on the server must be acknowledged before the branch can be made. `done` gets the new chat's id
 * and what couldn't be set on it; `onClose` closes without making one. Late answers after it closed change nothing.
 */
export function BranchDialog({
  api,
  returnTo,
  done,
  onClose,
}: {
  api: BranchApi;
  returnTo?: RefObject<HTMLElement | null>;
  done: (chatId: string, warnings: string[]) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [title, setTitle] = useState("");
  const [missingOk, setMissingOk] = useState(false);
  const open = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const nameId = useId();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    open.current = true;
    apiRef.current.preview().then(
      (preview) => open.current && setState({ phase: "ready", preview }),
      (e) => open.current && setState({ phase: "refused", why: errorText(e) }),
    );
    return () => void (open.current = false);
  }, []);

  const make = (preview: BranchPreview) => {
    setState({ phase: "making", preview });
    apiRef.current.make(preview, title).then(
      ({ chatId, warnings }) => open.current && done(chatId, warnings),
      (e) => {
        if (!open.current) return;
        if (e instanceof BranchUnconfirmed) setState({ phase: "unconfirmed", why: e.message });
        else setState({ phase: "ready", preview, error: errorText(e) });
      },
    );
  };

  const busy = state.phase === "making";
  const close = () => !busy && onClose();
  const preview = state.phase === "ready" || state.phase === "making" ? state.preview : undefined;
  const missing = preview?.files.filter((f) => f.state === "missing") ?? [];
  const canMake = !!preview && !busy && (!missing.length || missingOk);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog branch-dialog"
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
          <GitBranch size={14} aria-hidden /> Branch from here
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
            <CircleAlert size={13} aria-hidden /> {state.why} Branching from the same message again won't make a second one.
          </p>
        )}
        {preview && (
          <>
            <p>
              A new chat starts with the history of <b>{preview.parentTitle}</b> up to {whose(preview.point.role)}{" "}
              <q className="branch-quote">{preview.point.excerpt}</q>. This chat stays as it is; what you send next goes to the branch.
            </p>
            <label className="field-label" htmlFor={nameId}>
              Title
            </label>
            <input
              id={nameId}
              className="branch-name"
              autoFocus
              value={title}
              maxLength={200}
              placeholder={`Leave empty for Hermes's name, like "${preview.parentTitle} #2"`}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canMake) {
                  e.preventDefault();
                  make(preview);
                }
              }}
            />
            <section aria-label="History it starts with" className="branch-section">
              <h3>
                History it starts with: {plural(preview.messages.length, "message")}
              </h3>
              {preview.messages.length > SHOWN_MESSAGES && (
                <p className="muted small">The {plural(preview.messages.length - SHOWN_MESSAGES, "earlier message")} aren't listed here, and are copied too.</p>
              )}
              <ol className="branch-history" start={Math.max(1, preview.messages.length - SHOWN_MESSAGES + 1)}>
                {preview.messages.slice(-SHOWN_MESSAGES).map((m, i) => (
                  <li key={i} className={m.role}>
                    <span className="branch-who">{m.role === "user" ? "You" : "Hermes"}</span> {m.excerpt}
                  </li>
                ))}
              </ol>
              {preview.hidden > 0 && (
                <p className="muted small">Also copied: the project's instructions, which Hermes keeps hidden in the chat.</p>
              )}
            </section>
            <section aria-label="What isn't copied" className="branch-section">
              <h3>
                <Wrench size={12} aria-hidden /> Tool outputs
              </h3>
              <p className="muted small">
                {preview.toolCalls
                  ? `${plural(preview.toolCalls, "tool call")} before this point. Their outputs aren't copied as context: Hermes copies what you and it said, and its reasoning. Replies that describe an output still do.`
                  : "No tool calls before this point. Hermes copies what you and it said, and its reasoning."}
              </p>
            </section>
            <section aria-label="Attachments" className="branch-section">
              <h3>
                <FileText size={12} aria-hidden /> Attachments
              </h3>
              {!preview.files.length && !preview.images && <p className="muted small">None in this part of the chat.</p>}
              {preview.files.length > 0 && (
                <ul className="branch-files">
                  {preview.files.map((f) => (
                    <li key={f.path} className={f.state}>
                      <span className="mono">{f.path}</span>{" "}
                      <span className="branch-file-state">
                        {f.state === "there"
                          ? "On the server: the branch can refer to it."
                          : f.state === "missing"
                            ? "No longer on the server: the branch can't read it."
                            : "Couldn't check whether it's still on the server."}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.images > 0 && (
                <p className="muted small">
                  <ImageIcon size={12} aria-hidden /> {plural(preview.images, "image")}: copied with {preview.images === 1 ? "its message" : "their messages"} as Hermes stored them.
                </p>
              )}
              {missing.length > 0 && (
                <label className="branch-ack">
                  <input type="checkbox" checked={missingOk} disabled={busy} onChange={(e) => setMissingOk(e.target.checked)} /> Branch anyway: the copied messages still name{" "}
                  {missing.length === 1 ? "this file" : "these files"}, and Hermes won't find {missing.length === 1 ? "it" : "them"}.
                </label>
              )}
            </section>
            <dl className="files-meta branch-meta">
              <dt>Model</dt>
              <dd>
                {preview.model
                  ? `${preview.model.model}${preview.model.effort ? `, ${preview.model.effort} reasoning` : ""}${preview.model.fast ? ", fast" : ""}, as this chat`
                  : "The profile's model"}
              </dd>
              <dt>Folder</dt>
              <dd>The same folder on the server as this chat</dd>
            </dl>
            <p className="branch-warning">
              <CircleAlert size={13} aria-hidden /> Branching copies messages only. It doesn't undo files Hermes changed on the server or anything else it did,
              and the branch's tools work on the same server.
            </p>
            {state.phase === "ready" && state.error && (
              <p role="alert" className="branch-error">
                <CircleAlert size={13} aria-hidden /> {state.error}
              </p>
            )}
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" disabled={busy} autoFocus={!preview} onClick={close}>
            {preview ? "Cancel" : "Close"}
          </button>
          {preview && (
            <button className="btn primary" disabled={!canMake} onClick={() => make(preview)}>
              {busy ? (
                <>
                  <Spinner /> Making the branch…
                </>
              ) : (
                "Create branch"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * At the top of a branch made here: where it came from, and a way back to that point. A branch made by Edit or
 * Regenerate says so (ADR 0035); one whose message hasn't gone into it yet offers `finish`, which sends it.
 */
export function BranchedFrom({
  link,
  parentListed,
  onOpen,
  finish,
}: {
  link: BranchLink;
  parentListed: boolean;
  onOpen: () => void;
  finish?: { busy: boolean; blocked?: string; run: () => void };
}) {
  const parent = parentListed ? (
    <button className="link-btn" onClick={onOpen} title="Open that chat at this point">
      {link.parentTitle}
    </button>
  ) : (
    <b title="That chat isn't in the list now">{link.parentTitle}</b>
  );
  const kind = link.variant?.kind;
  return (
    <div className="branch-note" role="note">
      <GitBranch size={13} aria-hidden />
      <span>
        {kind === "edit" ? (
          <>
            Edited from {parent}, where your original message <q className="branch-quote">{link.point.excerpt}</q> and what came after it stay
          </>
        ) : kind === "regenerate" ? (
          <>
            Another answer to your message <q className="branch-quote">{link.point.excerpt}</q> in {parent}, where the first answer stays.
          </>
        ) : (
          <>
            Branched from {parent} after {whose(link.point.role)} <q className="branch-quote">{link.point.excerpt}</q>
          </>
        )}
        {finish && (
          <span className="branch-unfinished" role="status">
            {" "}
            Your message hasn't gone to this branch yet.{" "}
            <button className="btn" disabled={finish.busy || !!finish.blocked} title={finish.blocked} onClick={finish.run}>
              {finish.busy ? <Spinner /> : null} Send it now
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

