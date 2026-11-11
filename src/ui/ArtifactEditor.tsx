// An artifact open to edit in the preview pane beside the chat (artifacts.ts, ADR 0029). The editor shows which file
// it is and which version it is based on, and keeps the draft apart from the file: nothing reaches the server until
// Review changes → Save, which checks the revision first and reads the file back. "Ask Hermes to edit" proposes an edit
// to the selection, shown as a diff against the exact text it was made for, and applied to the editor only if that
// text is still what the editor holds. The draft, its history and the kept versions live in the store, so closing the
// pane or opening a chat loses nothing.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, GitMerge, History as HistoryIcon, Redo2, Sparkles, Undo2, X } from "lucide-react";
import { artifactKey as keyOf, isDirty, type ArtifactRef, type ArtifactStore } from "../hermes/artifacts";
import { VERSION_LABEL, proposed, type KeptVersion } from "../hermes/artifactEdit";
import { MINE_MARK } from "../hermes/textEdit";
import { DiffView } from "./FileEditor";
import { Markdown } from "./Markdown";
import { Spinner, fmtSize } from "./bits";
import { editStep } from "./editKeys";

type Tab = "edit" | "preview" | "changes" | "versions";

const MARKDOWN_NAME = /\.(md|markdown|mdx)$/i;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (revision: string) => revision.slice(0, 8);

export function ArtifactEditor({
  store,
  artifact,
  connected,
  onDone,
}: {
  store: ArtifactStore;
  artifact: ArtifactRef;
  connected: boolean;
  /** Leaves the editor for the file's plain preview. The draft stays in the store unless it was discarded. */
  onDone: () => void;
}) {
  const artifactKey = keyOf(artifact);
  // Opening an artifact already open keeps its draft, history and versions.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  useEffect(() => void store.open(artifact), [artifactKey]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const s = snap.get(artifactKey);
  const [tab, setTab] = useState<Tab>("edit");
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [compare, setCompare] = useState<{ from: string; to: string }>({ from: "saved", to: "draft" });
  const area = useRef<HTMLTextAreaElement>(null);
  const askBox = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const dirty = isDirty(s);
  const markdown = !!s && MARKDOWN_NAME.test(s.name);
  const busy = s?.busy;
  const writing = busy === "saving" || busy === "copying";

  // The textarea shows the store's selection after an undo, redo or applied edit; typing keeps its own.
  useEffect(() => {
    const el = area.current;
    if (!el || !s || el.value !== s.draft) return;
    if (el.selectionStart !== s.sel.start || el.selectionEnd !== s.sel.end) el.setSelectionRange(s.sel.start, s.sel.end);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [s?.history, s?.draft]);
  // The webview's own undo (from its context menu) would undo against text React set: ours runs instead. The textarea
  // comes and goes (a proposal, a conflict or another tab replaces it), so the listener follows the element itself.
  const undoListener = useRef<((e: InputEvent) => void) | undefined>(undefined);
  const setArea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (area.current && undoListener.current) area.current.removeEventListener("beforeinput", undoListener.current);
      area.current = el;
      if (!el) return;
      const onBefore = (e: InputEvent) => {
        if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
        e.preventDefault();
        if (e.inputType === "historyUndo") store.undo(artifactKey);
        else store.redo(artifactKey);
      };
      undoListener.current = onBefore;
      el.addEventListener("beforeinput", onBefore);
    },
    [store, artifactKey],
  );
  useEffect(() => {
    if (asking) askBox.current?.focus();
  }, [asking]);
  // A save that went through leaves the review for the text itself.
  useEffect(() => {
    if (s?.savedAt) setTab("edit");
  }, [s?.savedAt]);

  const versionText = (id: string): { label: string; text: string } | undefined => {
    if (!s) return undefined;
    if (id === "draft") return { label: "Your edit", text: s.draft };
    if (id === "saved") return s.base ? { label: `Saved version ${short(s.base.revision)}`, text: s.base.text } : undefined;
    const v = s.versions.find((x) => String(x.id) === id);
    return v && { label: `${VERSION_LABEL[v.kind]} ${time(v.at)}`, text: v.text };
  };
  const from = versionText(compare.from);
  const to = versionText(compare.to);
  const selected = s ? s.sel.end - s.sel.start : 0;
  const proposal = s?.proposal;
  const proposalText = useMemo(() => (proposal ? proposed(proposal) : ""), [proposal]);

  if (!s || s.state === "loading")
    return (
      <p className="muted small artifact-pad">
        <Spinner /> Reading {s?.name ?? "the file"} from the server…
      </p>
    );
  if (s.state === "refused" || !s.base)
    return (
      <div className="artifact-pad">
        <p role="alert" className="files-transfer-error">
          {s.name} can't be edited here: {s.why}
        </p>
        <div className="confirm-actions">
          <button className="btn" onClick={onDone}>
            Back to the preview
          </button>
          <button className="btn" disabled={!connected} onClick={() => store.retry(artifactKey)}>
            Try again
          </button>
        </div>
      </div>
    );
  const base = s.base;

  const cancel = () => {
    if (dirty) return setConfirmCancel(true);
    onDone();
  };
  const ask = () => {
    void store.askEdit(artifactKey, instruction);
    setAsking(false);
    // Each request starts empty, so a new one never runs on from the last.
    setInstruction("");
  };
  const onKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const step = editStep(e);
    if (!step) return;
    e.preventDefault();
    store[step](artifactKey);
  };

  return (
    <div className="artifact" aria-labelledby={titleId}>
      <div className="artifact-id">
        <span id={titleId} className="artifact-title">
          Editing {s.name}
        </span>
        <span className={`badge ${dirty ? "warn" : ""}`} role="status">
          {writing ? (busy === "saving" ? "Saving…" : "Saving a copy…") : dirty ? "Unsaved changes" : s.savedAt ? `Saved ${time(s.savedAt)}` : "As on the server"}
        </span>
        <span className="muted small" title={`SHA-256 ${base.revision}`}>
          Based on version {short(base.revision)} · {s.ref.host ? "on the dashboard's machine" : "where the profile's tools run"} · UTF-8{base.bom ? " with BOM" : ""},{" "}
          {base.eol === "\r\n" ? "CRLF" : "LF"} · {fmtSize(new TextEncoder().encode(s.draft).length)}
        </span>
      </div>

      <div className="preview-bar artifact-bar">
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={tab === "edit"} onClick={() => setTab("edit")}>
            Edit
          </button>
          {markdown && (
            <button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </button>
          )}
          <button aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>
            Changes
          </button>
          <button aria-pressed={tab === "versions"} onClick={() => setTab("versions")}>
            Versions{s.versions.length > 1 ? ` (${s.versions.length})` : ""}
          </button>
        </div>
        {tab === "edit" && (
          <>
            <button className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!s.history.past.length || writing} onClick={() => store.undo(artifactKey)}>
              <Undo2 size={15} />
            </button>
            <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!s.history.future.length || writing} onClick={() => store.redo(artifactKey)}>
              <Redo2 size={15} />
            </button>
            <button className="btn artifact-ask-btn" disabled={!!busy || !connected} onClick={() => setAsking((a) => !a)} aria-expanded={asking}>
              <Sparkles size={14} aria-hidden /> Ask Hermes to edit
            </button>
            <span className="muted small">{selected ? `${selected.toLocaleString("en-US")} characters selected` : "Nothing selected: Hermes would edit the whole file"}</span>
          </>
        )}
      </div>

      {asking && (
        <form
          className="artifact-ask"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setAsking(false);
              area.current?.focus();
            }
          }}
        >
          <label className="small" htmlFor={`${titleId}-ask`}>
            {selected ? "What should Hermes change in the selected text?" : "What should Hermes change in the whole file?"}
          </label>
          <div className="artifact-ask-row">
            <input id={`${titleId}-ask`} ref={askBox} value={instruction} placeholder="e.g. Make this shorter and plainer" onChange={(e) => setInstruction(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!instruction.trim()}>
              Ask
            </button>
            <button className="btn" type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
          <p className="muted small">Hermes answers without tools, so it can't change the file. You review its edit before anything changes.</p>
        </form>
      )}
      {busy === "asking" && (
        <p className="muted small artifact-line" role="status">
          <Spinner /> Hermes is drafting an edit. Your text stays as it is.
        </p>
      )}
      {s.note && !s.conflict && (
        <p className="files-editor-note small artifact-line" role="status">
          {s.note}
        </p>
      )}
      {s.error && (
        <p role="alert" className="files-transfer-error artifact-line">
          {s.error}
        </p>
      )}

      {proposal ? (
        <section className="artifact-panel" aria-label="Hermes's proposed edit">
          <p className="small">
            <Sparkles size={13} aria-hidden /> Hermes proposes this edit for “{proposal.instruction}”, made against your text as it was when you asked (version{" "}
            {short(proposal.baseRevision)}
            {proposal.before !== base.text ? ", with your unsaved changes" : ""}). It used {proposal.lent ? "this chat's model" : "the profile's Text generation model"}.
          </p>
          {s.rejected && (
            <p role="alert" className="files-editor-warn">
              <AlertTriangle size={14} aria-hidden /> Not applied: {s.rejected} Ask again to have Hermes edit the text as it is now.
            </p>
          )}
          <DiffView from={proposal.before} to={proposalText} label="Hermes's proposed changes" />
          <div className="confirm-actions">
            <button className="btn" onClick={() => store.dismissProposal(artifactKey)}>
              Discard
            </button>
            {s.rejected ? (
              <button
                className="btn primary"
                disabled={!connected || !!busy}
                onClick={() => void store.askAgain(artifactKey)}
              >
                Ask again
              </button>
            ) : (
              <button className="btn primary" autoFocus disabled={writing} onClick={() => store.apply(artifactKey) && setTab("edit")}>
                <Check size={14} aria-hidden /> Apply to the editor
              </button>
            )}
          </div>
        </section>
      ) : s.conflict ? (
        <section className="artifact-panel files-editor-conflict" aria-label="The file changed on the server">
          <p role="alert" className="files-editor-warn">
            <AlertTriangle size={14} aria-hidden />{" "}
            {s.conflict.after
              ? "Something else changed the file on the server while it saved, so it now has another version than yours."
              : "The file changed on the server since this edit started, perhaps Hermes in the chat, so nothing was written."}{" "}
            Your edit is kept here, and so is the server's version.
          </p>
          {"gone" in s.conflict.theirs ? (
            <p className="small">It isn't on the server any more. Save your edit as a copy to keep it there.</p>
          ) : "why" in s.conflict.theirs ? (
            <p className="small">What the server has now can't be shown here: {s.conflict.theirs.why}</p>
          ) : (
            <DiffView from={base.text} to={s.conflict.theirs.text} label="Changes on the server since this edit started" />
          )}
          <div className="confirm-actions">
            <button className="btn" disabled={writing || !connected} onClick={() => void store.saveCopy(artifactKey)}>
              {busy === "copying" ? <Spinner /> : null} Save mine as a copy
            </button>
            {"bytes" in s.conflict.theirs && (
              <button className="btn" disabled={writing} onClick={() => store.reload(artifactKey)} title="Edit the server's version instead; Undo brings yours back">
                Use the server's version
              </button>
            )}
            {"bytes" in s.conflict.theirs && (
              <button className="btn primary" autoFocus disabled={writing} onClick={() => (store.merge(artifactKey), setTab("edit"))}>
                <GitMerge size={14} aria-hidden /> Merge
              </button>
            )}
          </div>
        </section>
      ) : tab === "edit" ? (
        <textarea
          ref={setArea}
          className="files-editor-text mono artifact-text"
          aria-label={`Text of ${s.name}`}
          spellCheck={false}
          value={s.draft}
          readOnly={writing}
          onKeyDown={onKeys}
          onChange={(e) => store.type(artifactKey, e.target.value, { start: e.target.selectionStart, end: e.target.selectionEnd })}
          onSelect={(e) => store.select(artifactKey, e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
        />
      ) : tab === "preview" ? (
        <div className="preview-doc artifact-doc" aria-label={`Rendered ${s.name}, from your edit`}>
          <Markdown text={s.draft} />
        </div>
      ) : tab === "changes" ? (
        <div className="artifact-panel">
          <p className="small">Your edit against the saved version {short(base.revision)}. Save writes it, only if the server still has that version.</p>
          <DiffView from={base.text} to={s.draft} label="Your changes" />
          {s.draft.includes(MINE_MARK) && (
            <p className="files-editor-note small">
              <AlertTriangle size={13} aria-hidden /> The text still has merge markers.
            </p>
          )}
        </div>
      ) : (
        <Versions
          versions={s.versions}
          compare={compare}
          onCompare={setCompare}
          from={from}
          to={to}
          disabled={writing}
          onRestore={(id) => {
            store.restore(artifactKey, id);
            setTab("edit");
          }}
        />
      )}

      {confirmCancel ? (
        <div className="artifact-foot" role="alertdialog" aria-label={`Discard your changes to ${s.name}?`}>
          <p className="files-editor-warn small">
            <AlertTriangle size={14} aria-hidden /> Discard your changes to {s.name}? They aren't saved on the server.
          </p>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setConfirmCancel(false)}>
              Keep editing
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setConfirmCancel(false);
                store.discard(artifactKey);
                onDone();
              }}
            >
              Discard changes
            </button>
          </div>
        </div>
      ) : (
        <div className="artifact-foot">
          {!connected && <p className="muted small">Hermes isn't connected. Your edit stays here until it is.</p>}
          {tab === "changes" && dirty && !s.conflict && <p className="muted small">Saving replaces the file with a new one, so its permissions aren't kept.</p>}
          <div className="confirm-actions">
            <button className="btn" disabled={writing} onClick={cancel}>
              <X size={14} aria-hidden /> {dirty ? "Cancel" : "Close"}
            </button>
            {tab === "changes" && !s.conflict && !proposal ? (
              <button className="btn primary" disabled={!dirty || !connected || !!busy} onClick={() => void store.save(artifactKey)}>
                {busy === "saving" ? (
                  <>
                    <Spinner /> Saving…
                  </>
                ) : (
                  <>
                    <Check size={14} aria-hidden /> Save
                  </>
                )}
              </button>
            ) : (
              <button className="btn primary" disabled={!dirty || !!s.conflict || !!proposal} onClick={() => setTab("changes")}>
                Review changes…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Versions({
  versions,
  compare,
  onCompare,
  from,
  to,
  disabled,
  onRestore,
}: {
  versions: KeptVersion[];
  compare: { from: string; to: string };
  onCompare: (c: { from: string; to: string }) => void;
  from?: { label: string; text: string };
  to?: { label: string; text: string };
  disabled: boolean;
  onRestore: (id: number) => void;
}) {
  const options = [
    { id: "saved", label: "The saved version" },
    { id: "draft", label: "Your edit" },
    ...[...versions].reverse().map((v) => ({ id: String(v.id), label: `${VERSION_LABEL[v.kind]}, ${time(v.at)} (${short(v.revision)})` })),
  ];
  return (
    <div className="artifact-panel">
      <p className="muted small">
        <HistoryIcon size={13} aria-hidden /> Versions are kept in this app's memory until you quit or sign out, not on the server or on disk. Restoring one puts it in the
        editor; Save writes it.
      </p>
      <ul className="artifact-versions">
        {[...versions].reverse().map((v) => (
          <li key={v.id}>
            <span>
              {VERSION_LABEL[v.kind]} <span className="muted small">{time(v.at)}</span> <span className="mono muted small">{short(v.revision)}</span>
            </span>
            <span className="confirm-actions">
              <button className="btn" onClick={() => onCompare({ from: String(v.id), to: "draft" })}>
                Compare with your edit
              </button>
              <button className="btn" disabled={disabled} onClick={() => onRestore(v.id)}>
                Restore
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="artifact-compare">
        <label className="small">
          From{" "}
          <select value={compare.from} onChange={(e) => onCompare({ ...compare, from: e.target.value })}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          to{" "}
          <select value={compare.to} onChange={(e) => onCompare({ ...compare, to: e.target.value })}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {from && to && <DiffView from={from.text} to={to.text} label={`Changes from ${from.label} to ${to.label}`} />}
    </div>
  );
}

/**
 * Asks before signing out or closing the window would drop artifact edits not saved to Hermes: they live only in this
 * app's memory. Keep editing has focus, so a stray Enter keeps them; Escape keeps them too.
 */
export function LeaveArtifacts({ names, what, onStay, onDiscard }: { names: string[]; what: "signout" | "close"; onStay: () => void; onDiscard: () => void }) {
  const noteId = useId();
  const title = `${what === "signout" ? "Sign out" : "Close"} and discard ${names.length === 1 ? "your edit" : `${names.length} edits`}?`;
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div
        className="leave-dialog confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onStay();
          }
        }}
      >
        <span className="confirm-msg">
          <AlertTriangle size={13} /> {title}
        </span>
        <span id={noteId}>
          {names.length === 1 ? <span className="mono">{names[0]}</span> : names.map((n, i) => <span key={i} className="mono">{(i ? ", " : "") + n}</span>)} {names.length === 1 ? "has" : "have"} an edit
          that isn't saved to Hermes. It's kept only in this app, so {what === "signout" ? "signing out" : "closing"} drops it, along with the versions kept for it.
        </span>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Keep editing
          </button>
          <button className="btn danger" onClick={onDiscard}>
            Discard {names.length === 1 ? "edit" : "edits"}
          </button>
        </div>
      </div>
    </div>
  );
}
