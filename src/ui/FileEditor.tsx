// Editing a Server file's text (ADR 0024). It covers the window until the owner saves or cancels, so nothing else can
// take the edit away. Save goes through a review of the changes; the save itself checks that the server still has the
// file the edit started from, and reads it back after. When the file changed on the server, nothing is written: the
// owner sees what changed there and merges, reloads, or saves the edit as a copy. The edit is kept until they choose.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FilePen, GitMerge } from "lucide-react";
import type { EditBase, RemoteEntry, RemoteFiles, SaveOutcome } from "../hermes/remoteFiles";
import { MINE_MARK, diffLines, hunks, merge3 } from "../hermes/textEdit";
import { useCloseGuard } from "./LeaveMemoryEdit";
import { useModal } from "./modal";
import { Spinner, fmtSize } from "./bits";
import { errorText } from "../hermes/values";

type Conflict = Extract<SaveOutcome, { kind: "conflict" }>;

type Mode =
  | { kind: "loading" }
  | { kind: "refused"; why: string }
  | { kind: "edit" }
  | { kind: "review" }
  | { kind: "saving" }
  | { kind: "conflict"; conflict: Conflict }
  /** Asking before the edit is dropped; `back` is what it asked over, and goes on showing (a save under way too). */
  | { kind: "discard"; then: () => void; back: Mode };

const eolLabel = (b: EditBase) => `UTF-8${b.bom ? " with BOM" : ""}, ${b.eol === "\r\n" ? "CRLF (Windows)" : "LF"} line ends`;

/** The changes from `from` to `to`, as unified hunks with line numbers. */
export function DiffView({ from, to, label }: { from: string; to: string; label: string }) {
  const parts = useMemo(() => {
    const ops = diffLines(from.split("\n"), to.split("\n"));
    return { hunks: hunks(ops), added: ops.filter((o) => o.op === "add").length, removed: ops.filter((o) => o.op === "del").length };
  }, [from, to]);
  if (!parts.hunks.length) return <p className="muted small files-diff-empty">No changes.</p>;
  return (
    <section className="files-diff" aria-label={label}>
      <p className="files-diff-sum small">
        <span className="add">{parts.added} added</span>, <span className="del">{parts.removed} removed</span>
      </p>
      {parts.hunks.map((h) => {
        let oldLine = h.oldStart;
        let newLine = h.newStart;
        return (
          <div className="files-diff-hunk" key={`${h.oldStart}-${h.newStart}`}>
            <div className="files-diff-at mono">
              Line {h.oldStart} → {h.newStart}
            </div>
            {h.lines.map((l, i) => {
              const at = l.op === "add" ? newLine++ : l.op === "del" ? oldLine++ : (newLine++, oldLine++);
              return (
                <div key={i} className={`files-diff-line mono ${l.op}`}>
                  <span className="files-diff-no" aria-hidden>
                    {at}
                  </span>
                  <span className="files-diff-sign" aria-label={l.op === "add" ? "added" : l.op === "del" ? "removed" : undefined}>
                    {l.op === "add" ? "+" : l.op === "del" ? "−" : " "}
                  </span>
                  <span className="files-diff-text">{l.text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

export function FileEditor({
  files,
  entry,
  connected,
  onClose,
  onSaved,
}: {
  files: RemoteFiles;
  entry: RemoteEntry;
  connected: boolean;
  onClose: () => void;
  /** Hermes has the edit, read back; or a copy was saved at `copy`. */
  onSaved: (note: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [base, setBase] = useState<EditBase>();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const titleId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  // A save lands nowhere once the editor is gone, and only one runs at a time.
  const live = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  // Each open is its own: an older one answering late is dropped.
  useEffect(() => {
    let current = true;
    setMode({ kind: "loading" });
    setBase(undefined);
    setDraft("");
    setNote(undefined);
    setError(undefined);
    files.openForEdit(entry).then(
      (b) => {
        if (!current) return;
        setBase(b);
        setDraft(b.text);
        setMode({ kind: "edit" });
      },
      (e) => current && setMode({ kind: "refused", why: errorText(e) }),
    );
    return () => void (current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [entry.path]);

  const dirty = !!base && draft !== base.text;
  const ask = (then: () => void) => setMode((m) => (m.kind === "discard" ? m : { kind: "discard", then, back: m }));
  useCloseGuard(dirty || inFlight.current, ask);
  useEffect(() => {
    if (mode.kind === "edit") area.current?.focus();
  }, [mode.kind]);

  const leave = () => (dirty ? ask(onClose) : onClose());
  // Back to what the question asked over, when it is still the latest: a save that ended meanwhile wins.
  const stay = () => setMode((m) => (m.kind === "discard" ? m.back : m));
  // Where a save or copy that ended goes: under the discard question when it is up, so Keep waiting lands there.
  const settle = (next: Mode) => setMode((m) => (m.kind === "discard" ? { ...m, back: next } : next));

  const save = async () => {
    if (!base || inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    setMode({ kind: "saving" });
    try {
      const got = await files.saveEdit(base, draft);
      if (!live.current) return;
      if (got.kind === "saved") return onSaved(`Saved ${entry.name}. Hermes has your edit, read back from the server.`);
      settle({ kind: "conflict", conflict: got });
    } catch (e) {
      if (!live.current) return;
      setError(errorText(e));
      settle({ kind: "review" });
    } finally {
      inFlight.current = false;
    }
  };

  const saveCopy = async () => {
    if (!base || inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    setMode({ kind: "saving" });
    try {
      const path = await files.saveCopy(base, draft);
      if (live.current) onSaved(`Your edit was saved as a copy, ${path}. ${entry.name} on the server is as Hermes has it.`);
    } catch (e) {
      if (!live.current) return;
      setError(errorText(e));
      settle({ kind: "edit" });
    } finally {
      inFlight.current = false;
    }
  };

  const theirs = mode.kind === "conflict" ? mode.conflict.theirs : undefined;
  const theirsBase = theirs && "bytes" in theirs ? theirs : undefined;

  const merge = () => {
    if (!base || !theirsBase) return;
    const merged = merge3(base.text, draft, theirsBase.text);
    setBase(theirsBase);
    setDraft(merged.text);
    setNote(
      merged.conflicts
        ? `Merged with the server's version. ${merged.conflicts} ${merged.conflicts === 1 ? "place" : "places"} both changed ${merged.conflicts === 1 ? "is" : "are"} marked with “${MINE_MARK}”: keep what you want there, remove the markers, then save.`
        : "Merged with the server's version: your changes are on top of it. Review, then save.",
    );
    setMode({ kind: "edit" });
  };

  const reload = () => {
    if (!theirsBase) return;
    setBase(theirsBase);
    setDraft(theirsBase.text);
    setNote("Reloaded the server's version. Your edit was dropped.");
    setMode({ kind: "edit" });
  };

  // What the body shows: under the discard question, what it asked over.
  const shown = mode.kind === "discard" ? mode.back : mode;
  const busy = shown.kind === "saving";
  return (
    <div className="leave-overlay files-editor-overlay">
      <div
        ref={box}
        className="leave-dialog files-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && mode.kind !== "saving") {
            e.preventDefault();
            if (mode.kind === "discard") stay();
            else if (mode.kind === "review") setMode({ kind: "edit" });
            else leave();
          }
        }}
      >
        <div className="files-editor-head">
          <h2 id={titleId}>
            <FilePen size={15} aria-hidden /> Edit {entry.name}
          </h2>
          <span className="mono muted small" title="On the Hermes server">
            {entry.path}
          </span>
          {base && (
            <span className="muted small">
              {eolLabel(base)}, {fmtSize(new TextEncoder().encode(draft).length)}
            </span>
          )}
        </div>

        {shown.kind === "loading" && (
          <p className="muted small">
            <Spinner /> Reading it from the server…
          </p>
        )}
        {shown.kind === "refused" && (
          <p role="alert" className="files-transfer-error">
            It can't be edited here: {shown.why}
          </p>
        )}
        {note && (shown.kind === "edit" || shown.kind === "review") && (
          <p className="files-editor-note small" role="status">
            {note}
          </p>
        )}
        {error && (
          <p role="alert" className="files-transfer-error">
            {error}
          </p>
        )}

        {base && shown.kind === "edit" && (
          <textarea
            ref={area}
            className="files-editor-text mono"
            aria-label={`Text of ${entry.name}`}
            spellCheck={false}
            value={draft}
            readOnly={mode.kind !== "edit"}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
            }}
          />
        )}
        {base && (shown.kind === "review" || shown.kind === "saving") && (
          <>
            <p className="small">Your changes to the file as you opened it. Save writes them, if the server still has that version.</p>
            <DiffView from={base.text} to={draft} label="Your changes" />
            {draft.includes(MINE_MARK) && (
              <p className="files-editor-note small">
                <AlertTriangle size={13} aria-hidden /> The text still has merge markers.
              </p>
            )}
          </>
        )}
        {shown.kind === "conflict" && base && (
          <div className="files-editor-conflict">
            <p role="alert" className="files-editor-warn">
              <AlertTriangle size={14} aria-hidden />{" "}
              {shown.conflict.after
                ? "Something else changed the file on the server while it saved, so it now has another version than yours."
                : "The file changed on the server since you opened it, so nothing was written."}{" "}
              Your edit is kept here.
            </p>
            {"gone" in shown.conflict.theirs ? (
              <p className="small">It isn't on the server any more. Save your edit as a copy to keep it.</p>
            ) : "why" in shown.conflict.theirs ? (
              <p className="small">What the server has now can't be shown here: {shown.conflict.theirs.why}</p>
            ) : (
              <DiffView from={base.text} to={shown.conflict.theirs.text} label="Changes on the server since you opened it" />
            )}
          </div>
        )}
        {mode.kind === "discard" && (
          <p role="alert" className="files-editor-warn">
            <AlertTriangle size={14} aria-hidden />{" "}
            {mode.back.kind === "saving"
              ? `A save of ${entry.name} is under way. Leave anyway? It may still land on the server; reopen the file to see.`
              : `Discard your changes to ${entry.name}? They aren't saved on the server.`}
          </p>
        )}

        <div className="files-editor-foot">
          {base && mode.kind !== "conflict" && mode.kind !== "discard" && (
            <p className="muted small">Saving replaces the file. Hermes writes it as a new file readable only by the server's user, so its permissions aren't kept.</p>
          )}
          <div className="confirm-actions">
            {mode.kind === "discard" ? (
              <>
                <button className="btn" autoFocus onClick={stay}>
                  {mode.back.kind === "saving" ? "Keep waiting" : "Keep editing"}
                </button>
                <button className="btn danger" onClick={mode.then}>
                  Discard changes
                </button>
              </>
            ) : mode.kind === "review" || mode.kind === "saving" ? (
              <>
                <button className="btn" disabled={busy} onClick={() => setMode({ kind: "edit" })}>
                  Back to editing
                </button>
                <button className="btn primary" autoFocus disabled={busy || !connected} onClick={() => void save()}>
                  {busy ? (
                    <>
                      <Spinner /> Saving…
                    </>
                  ) : (
                    <>
                      <Check size={14} aria-hidden /> Save
                    </>
                  )}
                </button>
              </>
            ) : mode.kind === "conflict" ? (
              <>
                <button className="btn" onClick={leave}>
                  Close
                </button>
                <button className="btn" disabled={!connected} onClick={() => void saveCopy()}>
                  Save mine as a copy
                </button>
                {theirsBase && (
                  <button className="btn" onClick={reload} title="Drop your edit and edit the server's version">
                    Reload theirs
                  </button>
                )}
                {theirsBase && (
                  <button className="btn primary" autoFocus onClick={merge}>
                    <GitMerge size={14} aria-hidden /> Merge
                  </button>
                )}
              </>
            ) : (
              <>
                <button className="btn" onClick={leave}>
                  {mode.kind === "edit" ? "Cancel" : "Close"}
                </button>
                {mode.kind === "edit" && (
                  <button className="btn primary" disabled={!dirty} onClick={() => setMode({ kind: "review" })}>
                    Review changes…
                  </button>
                )}
              </>
            )}
          </div>
          {!connected && base && <p className="muted small">Hermes isn't connected. Your edit stays here until it is.</p>}
        </div>
      </div>
    </div>
  );
}

