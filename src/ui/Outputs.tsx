// Outputs: the files Hermes's tools reported writing, for the open chat, the project the list shows, or every chat in
// the profile (outputs.ts, ADR 0016). It opens from the rail and takes the chat pane's place, as Server files does; a
// file opens in the preview pane beside it. Paths a reply only mentions aren't listed.
import { useMemo, useState } from "react";
import { ArrowLeft, CircleAlert, File, FileArchive, FileAudio, FileImage, FilePen, FileText, FolderOpen, LocateFixed, Eye, Plus, RefreshCw, Trash2, WifiOff, X } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import {
  HOW_LABEL,
  TYPE_LABEL,
  checkPending,
  editable,
  previewable,
  shownName,
  shownPath,
  typeOf,
  versions,
  type Output,
  type OutputType,
  type OutputsSnapshot,
} from "../hermes/outputs";
import { STATUS_LABEL, Spinner, fmtSize, storedTime } from "./bits";

export type OutputsScope = "chat" | "project" | "profile";

/** How many rows show at first, and how many more each "Show more" adds. */
export const OUTPUT_PAGE = 200;

const TYPE_ICON: Record<OutputType, typeof File> = { image: FileImage, text: FileText, document: FileText, media: FileAudio, archive: FileArchive, other: File };

const AVAILABILITY: Record<string, string> = {
  available: "Available",
  missing: "Missing",
  forbidden: "Not allowed",
  folder: "A folder now",
  unknown: "Couldn't check",
};

const CHECKING = "Checking whether it's still there…";

function Availability({ o, pending, onRecheck, busy }: { o: Output; pending: boolean; onRecheck?: () => void; busy: boolean }) {
  const a = o.availability;
  if (pending) return <span className="muted" title={CHECKING}>Checking…</span>;
  if (!a) return <span className="muted" title="Refresh checks whether the file is still there">Not checked</span>;
  const tip = [a.why, `Checked ${storedTime(a.checkedAt)}`].filter(Boolean).join("\n");
  return (
    <span className={`out-avail ${a.state}`} title={tip}>
      {AVAILABILITY[a.state] ?? a.state}
      {a.why && a.state !== "available" && <span className="out-why muted small">{a.why}</span>}
      {a.state !== "available" && onRecheck && (
        <button className="link-btn small" disabled={busy} onClick={onRecheck} title="Check again whether the file is at its path">
          Check again
        </button>
      )}
    </span>
  );
}

export function OutputsScreen({
  snapshot,
  outputs,
  scope,
  scopes,
  unindexed,
  partialChats,
  chatTitle,
  status,
  canAdd,
  onScope,
  onRefresh,
  onIndexMore,
  onAdd,
  onRemove,
  onPreview,
  onEdit,
  unsavedEdit,
  onRecheck,
  onJump,
  onShowFolder,
  onClose,
}: {
  snapshot: OutputsSnapshot;
  /** The Outputs in the scope shown. */
  outputs: Output[];
  scope: OutputsScope;
  /** What each scope covers, by name; a scope without one can't be picked (no chat open, no project shown). */
  scopes: { chat?: string; project?: string; profile: string };
  /** Chats in the scope whose Outputs haven't been read yet. */
  unindexed: number;
  /** Chats in the scope whose discovery is partial (outputs.ts `IndexGaps`), with or without Outputs found. */
  partialChats: number;
  chatTitle: (chatId: string) => string | undefined;
  status: ConnectionStatus;
  /** Whether a file can be added here: to this chat, or to the profile; a project has no files of its own. */
  canAdd: boolean;
  onScope: (s: OutputsScope) => void;
  onRefresh: () => void;
  onIndexMore: () => void;
  onAdd: (path: string) => Promise<unknown>;
  onRemove: (key: string) => void;
  onPreview: (o: Output) => void;
  /** Opens the file to edit beside the chat (ADR 0029). */
  onEdit?: (o: Output) => void;
  /** Whether the file has an edit open that isn't saved to Hermes. */
  unsavedEdit?: (o: Output) => boolean;
  /** Checks one file again, for a row that says it's missing or couldn't be checked (ADR 0062). */
  onRecheck?: (o: Output) => void;
  onJump: (o: Output) => void;
  onShowFolder: (o: Output) => void;
  onClose: () => void;
}) {
  const connected = status === "connected";
  const [query, setQuery] = useState("");
  const [type, setType] = useState<OutputType | "all">("all");
  const [shown, setShown] = useState(OUTPUT_PAGE);
  const [adding, setAdding] = useState("");
  const [addState, setAddState] = useState<{ busy?: boolean; error?: string; done?: string }>({});

  const versionOf = useMemo(() => versions(outputs), [outputs]);
  const sorted = useMemo(() => [...outputs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (b.rowId ?? 0) - (a.rowId ?? 0)), [outputs]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter(
      (o) =>
        (type === "all" || typeOf(o.path) === type) &&
        (!q || o.path.toLowerCase().includes(q) || (o.chatId && chatTitle(o.chatId)?.toLowerCase().includes(q))),
    );
  }, [sorted, query, type, chatTitle]);
  const inScopePartial = partialChats;
  const busy = !!snapshot.indexing || !!snapshot.checking;
  const scopeName = scope === "chat" ? "this chat" : scope === "project" ? `the project ${scopes.project}` : `the ${scopes.profile} profile`;

  const add = async () => {
    const path = adding.trim();
    if (!path) return;
    setAddState({ busy: true });
    try {
      await onAdd(path);
      setAdding("");
      setAddState({ done: `Added ${shownName(path)}.` });
    } catch (e) {
      setAddState({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="files outputs">
      <div className="files-head">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="files-title">
          <h1>Outputs</h1>
          <div className="out-scopes" role="radiogroup" aria-label="Show the outputs of">
            {(
              [
                ["chat", "This chat", scopes.chat],
                ["project", scopes.project ? `Project: ${scopes.project}` : "Project", scopes.project],
                ["profile", `All chats in ${scopes.profile}`, scopes.profile],
              ] as const
            ).map(([s, label, on]) => (
              <button
                key={s}
                role="radio"
                aria-checked={scope === s}
                className={`out-scope ${scope === s ? "on" : ""}`}
                disabled={!on}
                title={!on ? (s === "chat" ? "Open a chat first" : "Pick a project in the chat list first") : s === "chat" ? scopes.chat : undefined}
                onClick={() => onScope(s)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="files-note muted small">
          Files Hermes's tools reported writing: write_file, files patch created, text_to_speech audio and image_generate images. A path a reply only
          mentions isn't listed. This computer keeps only their paths and where they came from, for each connection and profile.
        </p>
      </div>

      <div className="files-bar">
        <input className="out-search" aria-label="Search outputs by name, path or chat" placeholder="Search by name, path or chat" value={query} onChange={(e) => { setQuery(e.target.value); setShown(OUTPUT_PAGE); }} />
        <select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value as OutputType | "all"); setShown(OUTPUT_PAGE); }}>
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as OutputType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!connected || busy} onClick={onRefresh} title="Read changed chats again and check whether each file is still there">
          <RefreshCw size={14} className={busy ? "spin" : undefined} /> Refresh
        </button>
        {canAdd && (
        <form
          className="files-goto out-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            aria-label={`Add a server file to ${scope === "chat" ? "this chat's" : "these"} outputs by its path`}
            placeholder="Add a server file: /path or ~/path"
            value={adding}
            disabled={!connected || addState.busy}
            onChange={(e) => {
              setAdding(e.target.value);
              setAddState({});
            }}
          />
          <button className="icon-btn" type="submit" aria-label="Add this file" title="Add this file" disabled={!connected || !adding.trim() || addState.busy}>
            <Plus size={16} />
          </button>
        </form>
        )}
      </div>

      <div aria-live="polite" className="out-status">
        {addState.done && <div className="files-banner ok">{addState.done}</div>}
        {snapshot.indexing && (
          <div className="files-banner" role="status">
            <Spinner /> <span>Reading chats for outputs: {snapshot.indexing.done} of {snapshot.indexing.total}…</span>
          </div>
        )}
        {snapshot.checking && (
          <div className="files-banner" role="status">
            <Spinner /> <span>Checking whether the files are still there…</span>
          </div>
        )}
      </div>
      {!connected && (
        <div className="files-banner warn" role="status">
          <WifiOff size={14} aria-hidden />
          <span>{STATUS_LABEL[status]} These are the outputs found before. Refresh once Hermes is connected again.</span>
        </div>
      )}
      {snapshot.unsupported && (
        <div className="files-banner err" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{snapshot.unsupported} Outputs need a Hermes dashboard with it; the ones found before are still listed.</span>
        </div>
      )}
      {snapshot.error && (
        <div className="files-banner err" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{snapshot.error}</span>
        </div>
      )}
      {addState.error && (
        <div className="files-banner err" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>Couldn't add it: {addState.error}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setAddState({})}>
            <X size={14} />
          </button>
        </div>
      )}
      {snapshot.notSaved && (
        <div className="files-banner warn" role="status">
          <CircleAlert size={14} aria-hidden />
          <span>This computer's storage is full, so these outputs won't be kept after Hermes Chat closes.</span>
        </div>
      )}
      {(unindexed > 0 || inScopePartial > 0) && (
        <div className="files-banner warn" role="status">
          <CircleAlert size={14} aria-hidden />
          <span>
            {unindexed > 0 && `${unindexed} ${unindexed === 1 ? "chat hasn't" : "chats haven't"} been read for outputs yet. `}
            {inScopePartial > 0 &&
              `Discovery is partial in ${inScopePartial} ${inScopePartial === 1 ? "chat" : "chats"}: older messages weren't read, a message was too big to read, a chat made more files than are kept, its files were dropped to stay within what this computer keeps (open the chat to read them again), or a file tool's result didn't say which file it wrote. Add a file by its path if one is missing.`}
          </span>
          {unindexed > 0 && (
            <button className="btn" disabled={!connected || busy} onClick={onIndexMore}>
              Read more chats
            </button>
          )}
        </div>
      )}

      <div className="files-body">
        <div className="files-list" aria-busy={busy} data-stale={!connected || undefined}>
          {outputs.length > 0 && (
            <div className="files-tools">
              <span className="muted small files-count">
                {filtered.length === outputs.length ? `${outputs.length} outputs in ${scopeName}` : `${filtered.length} of ${outputs.length} outputs in ${scopeName}`}
              </span>
            </div>
          )}
          {filtered.length > 0 && (
            <table className="files-table out-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">
                    Size
                  </th>
                  <th scope="col">Availability</th>
                  <th scope="col">Made by</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((o) => {
                  const kind = typeOf(o.path);
                  const Icon = TYPE_ICON[kind];
                  const name = shownName(o.path);
                  const v = versionOf.get(o.key);
                  const can = previewable(o);
                  const canEdit = editable(o);
                  // Not opened on a stale answer while opening (or Refresh) checks it again (#223).
                  const pending = checkPending(snapshot, o);
                  const unsaved = unsavedEdit?.(o) ?? false;
                  const title = o.chatId ? (chatTitle(o.chatId) ?? "A chat not in the list") : undefined;
                  return (
                    <tr key={o.key}>
                      <td className="files-name out-name">
                        <span className="out-file">
                          <Icon size={15} className="files-icon" aria-hidden />
                          <span className="files-label" title={shownPath(o.path)}>
                            {name}
                          </span>
                          {unsaved && (
                            <span className="badge warn" title="You have an edit of this file open that isn't saved to Hermes">
                              Unsaved edit
                            </span>
                          )}
                          {v && (
                            <span className="badge" title={v.latest ? "The newest version: what the path holds now" : "An older version: the path now holds a later one"}>
                              Version {v.n} of {v.of}
                            </span>
                          )}
                        </span>
                        <span className="out-path mono muted small">{shownPath(o.path)}</span>
                        {o.host && <span className="out-path muted small">On the dashboard's machine</span>}
                      </td>
                      <td className="muted">{TYPE_LABEL[kind]}</td>
                      <td className="num muted" title={o.size === undefined ? "The tool didn't report a size" : "As the tool reported writing it"}>
                        {o.size !== undefined ? fmtSize(o.size) : "—"}
                      </td>
                      <td>
                        <Availability o={o} pending={pending} busy={!connected || !!snapshot.checking} onRecheck={onRecheck && (() => onRecheck(o))} />
                      </td>
                      <td className="out-source">
                        {title && <span className="out-chat">{title}</span>}
                        <span className="muted small">
                          {HOW_LABEL[o.how]}
                          {o.at ? ` · ${storedTime(o.at)}` : ""}
                        </span>
                      </td>
                      <td className="out-actions">
                        <button
                          className="icon-btn"
                          aria-label={`Preview ${name}`}
                          title={pending ? CHECKING : can.ok ? (v && !v.latest ? "Preview what the path holds now (a later version)" : "Preview") : can.why}
                          disabled={!connected || !can.ok || pending}
                          onClick={() => onPreview(o)}
                        >
                          <Eye size={15} />
                        </button>
                        {onEdit && (
                          <button
                            className="icon-btn"
                            aria-label={`Edit ${name}`}
                            title={unsaved ? "Go back to your unsaved edit" : pending ? CHECKING : canEdit.ok ? "Edit beside the chat" : canEdit.why}
                            // An unsaved edit always opens again, whatever the server now has: it is the only copy.
                            disabled={!unsaved && (!canEdit.ok || !connected || pending)}
                            onClick={() => onEdit(o)}
                          >
                            <FilePen size={15} />
                          </button>
                        )}
                        {o.callId && o.chatId && (
                          <button className="icon-btn" aria-label={`Go to the message that made ${name}`} title="Go to the message that made it" onClick={() => onJump(o)}>
                            <LocateFixed size={15} />
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          aria-label={`Show ${name}'s folder in Server files`}
                          title="Show its folder in Server files. Server files shows the dashboard's machine, which may not be where this profile's tools run."
                          onClick={() => onShowFolder(o)}
                        >
                          <FolderOpen size={15} />
                        </button>
                        {o.how === "added" && (
                          <button className="icon-btn" aria-label={`Take ${name} out of Outputs`} title="Take it out of Outputs (the file stays on the server)" onClick={() => onRemove(o.key)}>
                            <Trash2 size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > shown && (
            <div className="files-more">
              <button className="btn" onClick={() => setShown((n) => n + OUTPUT_PAGE)}>
                Show {Math.min(OUTPUT_PAGE, filtered.length - shown)} more
              </button>
              <span className="muted small">
                Showing {shown} of {filtered.length}. Search to find one.
              </span>
            </div>
          )}
          {!outputs.length && !snapshot.indexing && (
            <p className="empty-hint">
              No files from Hermes's tools in {scopeName} yet. Files a reply only mentions aren't listed; add one by its path above if you need it here.
            </p>
          )}
          {!outputs.length && snapshot.indexing && (
            <p className="empty-hint">
              <Spinner /> Reading chats for outputs…
            </p>
          )}
          {outputs.length > 0 && !filtered.length && <p className="empty-hint">No outputs match.</p>}
        </div>
      </div>
    </div>
  );
}
