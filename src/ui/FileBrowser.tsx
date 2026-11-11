// Server files: a browser for the files on the machine the Hermes dashboard runs on (remoteFiles.ts). It is the side
// panel's Files tab (ADR 0039), and opens from the rail there too. Folders open in place, with the path above them as a trail
// of folders; a file opens in the preview beside the list, where it can be downloaded to this computer. Upload… sends
// a file the owner picks into the folder on screen, after showing where it goes and what is in the way (ADR 0023). A
// text file in the preview can be edited and saved back, checked against what the server has (ADR 0024). Nothing else
// on the server can be changed from here.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { ArrowLeft, ArrowUp, Check, CircleAlert, Download, FilePen, File, FileImage, FileText, Folder, House, Link2, Link2Off, RefreshCw, Server, Upload, WifiOff, X } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import {
  ENTRY_PAGE,
  RemoteFilesError,
  crumbs,
  previewSupport,
  type RemoteEntry,
  type RemoteFiles,
  type RemoteListing,
  type Collision,
  type PickedUpload,
  type RemotePreview,
  type Transfer,
} from "../hermes/remoteFiles";
import { STATUS_LABEL, Spinner, composing, fmtSize, routeLabel, storedTime } from "./bits";
import { useModal } from "./modal";
import { FileEditor } from "./FileEditor";
import { EDIT_MAX_BYTES } from "../hermes/textEdit";
import { errorText } from "../hermes/values";

/** A file's preview, from the click until its contents are read. `ask`: its type is unknown, and it may be text. */
export type Preview =
  | { entry: RemoteEntry; state: "loading" }
  | { entry: RemoteEntry; state: "ready"; result: RemotePreview }
  | { entry: RemoteEntry; state: "ask" }
  | { entry: RemoteEntry; state: "failed"; error: string };

const errorOf = (e: unknown) => (e instanceof RemoteFilesError ? e : new RemoteFilesError(errorText(e)));

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "broken-link") return <Link2Off size={15} className="files-icon broken" aria-hidden />;
  if (entry.kind === "dir") return <Folder size={15} className="files-icon dir" aria-hidden />;
  const support = previewSupport(entry).kind;
  if (support === "image") return <FileImage size={15} className="files-icon" aria-hidden />;
  if (support === "text") return <FileText size={15} className="files-icon" aria-hidden />;
  return <File size={15} className="files-icon" aria-hidden />;
}

// One formatter for every row: `toLocaleString` makes a new one per call, which a big folder feels. Same style as
// `storedTime`.
const MODIFIED = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const modifiedAt = (ms: number) => MODIFIED.format(ms);

const typeLabel = (e: RemoteEntry) => (e.kind === "dir" ? "Folder" : e.kind === "broken-link" ? "Broken link" : e.mime ?? "");

export function FileBrowser({
  files,
  status,
  route,
  path,
  onPath,
  onClose,
}: {
  files: RemoteFiles;
  status: ConnectionStatus;
  route?: Route;
  /** The folder to open: the one open last time, else the server's starting folder. */
  path?: string;
  /** Each folder listed, so it opens there next time. */
  onPath: (path: string) => void;
  /** Back to the chat; without it, the browser is a tab of the side panel and has no Back button. */
  onClose?: () => void;
}) {
  const connected = status === "connected";
  const [listing, setListing] = useState<RemoteListing>();
  const [loading, setLoading] = useState(false);
  // Why the last folder asked for couldn't be listed, and which one it was. The folder listed before stays on screen.
  const [error, setError] = useState<{ path?: string; error: RemoteFilesError }>();
  const [preview, setPreview] = useState<Preview>();
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [shown, setShown] = useState(ENTRY_PAGE);
  const [goTo, setGoTo] = useState("");
  // A file picked to upload, and the folder it was picked for, until the owner sends it or cancels.
  const [uploading, setUploading] = useState<{ picked: PickedUpload; listing: RemoteListing }>();
  const [pickError, setPickError] = useState<string>();
  // The file open in the editor, and what the last save said.
  const [editing, setEditing] = useState<RemoteEntry>();
  const [saved, setSaved] = useState<string>();
  const shownPath = useRef<string | undefined>(undefined);
  const uploadButton = useRef<HTMLButtonElement>(null);
  shownPath.current = listing?.path;
  // Only the latest listing and preview asked for land; an older answer arriving late is dropped.
  const listSeq = useRef(0);
  const previewSeq = useRef(0);
  // The path of the file in the preview pane, kept in step with `preview` without waiting for a render.
  const previewPath = useRef<string | undefined>(undefined);
  // A file to open in the preview again once the next listing lands, with what that listing says of it (after a save).
  const reopen = useRef<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  // Closing the preview also drops the read it's waiting on, so a late answer can't open it again.
  const dropPreview = () => {
    previewSeq.current++;
    previewPath.current = undefined;
    setPreview(undefined);
  };

  const load = (to?: string, keepPreview = false) => {
    const seq = ++listSeq.current;
    setLoading(true);
    files.list(to).then(
      (l) => {
        if (seq !== listSeq.current) return;
        const same = l.path === listing?.path;
        setListing(l);
        setError(undefined);
        setLoading(false);
        onPath(l.path);
        if (!same) {
          setFilter("");
          setShown(ENTRY_PAGE);
          listRef.current?.scrollTo?.({ top: 0 });
        }
        // A refresh keeps the preview open only while its file is still listed.
        if (!(same && keepPreview && l.entries.some((e) => e.path === previewPath.current))) dropPreview();
        const again = reopen.current && l.entries.find((e) => e.path === reopen.current);
        reopen.current = undefined;
        if (again) open(again);
      },
      (e) => {
        if (seq !== listSeq.current) return;
        setError({ path: to, error: errorOf(e) });
        setLoading(false);
      },
    );
  };

  const open = (entry: RemoteEntry, asText = false) => {
    if (entry.kind === "dir") return load(entry.path);
    const seq = ++previewSeq.current;
    previewPath.current = entry.path;
    const support = previewSupport(entry);
    if (support.kind === "none") return setPreview({ entry, state: "failed", error: support.why });
    if (support.kind === "maybe-text" && !asText) return setPreview({ entry, state: "ask" });
    setPreview({ entry, state: "loading" });
    files.preview(entry, asText).then(
      (result) => seq === previewSeq.current && setPreview({ entry, state: "ready", result }),
      (e) => seq === previewSeq.current && setPreview({ entry, state: "failed", error: errorOf(e).message }),
    );
  };

  // The first listing, and a fresh one each time Hermes connects again: what's on screen may be out of date.
  const listed = useRef(false);
  useEffect(() => {
    if (!connected) return;
    if (!listed.current) {
      listed.current = true;
      load(path);
    } else load(listing?.path ?? path, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const visible = showHidden ? all : all.filter((e) => !e.name.startsWith("."));
    const q = filter.trim().toLowerCase();
    return q ? visible.filter((e) => e.name.toLowerCase().includes(q)) : visible;
  }, [listing, showHidden, filter]);
  const hiddenCount = listing ? listing.entries.filter((e) => e.name.startsWith(".")).length : 0;
  const trail = listing ? crumbs(listing.path, listing.root) : [];
  const where = routeLabel(route) ?? "the Hermes server";

  const pickUpload = () => {
    const at = listing;
    if (!at) return;
    setPickError(undefined);
    files.pickUpload().then(
      (picked) => picked && setUploading({ picked, listing: at }),
      (e) => setPickError(errorOf(e).message),
    );
  };

  const sendUpload = (collision: Collision) => {
    if (!uploading) return;
    const { picked, listing: at } = uploading;
    setUploading(undefined);
    // The folder is listed again once Hermes answers, when it is still the one on screen.
    void files.upload(at, picked, collision).catch((e) => setPickError(errorOf(e).message)).finally(() => shownPath.current === at.path && load(at.path, true));
  };

  const onListKey = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.altKey && e.key === "ArrowUp" && listing?.parent && connected) {
      e.preventDefault();
      load(listing.parent);
    }
  };

  return (
    <div className="files" onKeyDown={onListKey}>
      <div className="files-head">
        {onClose && (
          <button className="back" onClick={onClose}>
            <ArrowLeft size={15} /> Back to chat
          </button>
        )}
        <div className="files-title">
          <h1>Server files</h1>
          <span className="files-server" title="The machine the Hermes dashboard runs on">
            <Server size={13} aria-hidden /> <span className="mono">{where}</span>
          </span>
          {listing?.root && (
            <span className="badge" title="The server only lets you browse inside this folder">
              Limited to {listing.root}
            </span>
          )}
        </div>
        <p className="files-note muted small">
          The files on the Hermes server, as its own user can open them, the same for every profile. Hermes doesn't list credential files such as .env
          or auth.json.
        </p>
      </div>

      <div className="files-bar">
        <button className="icon-btn" title="Up one folder (Alt+↑)" aria-label="Up one folder" disabled={!connected || !listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" title="The server's starting folder" aria-label="Starting folder" disabled={!connected} onClick={() => load(undefined)}>
          <House size={16} />
        </button>
        <button className="icon-btn" title="Refresh" aria-label="Refresh" disabled={!connected || !listing} onClick={() => listing && load(listing.path, true)}>
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
        <nav className="files-crumbs" aria-label="Current folder">
          {listing ? (
            <ol>
              {trail.map((c, i) => (
                <li key={c.path}>
                  {/* "/" is both the top folder and the separator, so none follows it. */}
                  {i > 0 && !(i === 1 && trail[0].path === "/") && (
                    <span className="files-sep" aria-hidden>
                      /
                    </span>
                  )}
                  {i === trail.length - 1 ? (
                    <span aria-current="page" className="mono" title={listing.path}>
                      {c.label}
                    </span>
                  ) : (
                    <button className="mono" disabled={!connected} title={c.path} onClick={() => load(c.path)}>
                      {c.label}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <span className="muted small">{loading ? "Listing…" : ""}</span>
          )}
        </nav>
        <button ref={uploadButton} className="btn files-upload" disabled={!connected || !listing} title="Pick a file on this computer to upload into this folder" onClick={pickUpload}>
          <Upload size={14} aria-hidden /> Upload…
        </button>
        <form
          className="files-goto"
          onSubmit={(e) => {
            e.preventDefault();
            if (!goTo.trim()) return;
            load(goTo.trim());
            setGoTo("");
          }}
        >
          <input aria-label="Go to a folder on the server" placeholder="Go to /path or ~/path" value={goTo} disabled={!connected} onChange={(e) => setGoTo(e.target.value)} />
        </form>
      </div>

      {!connected && (
        <div className="files-banner warn" role="status">
          <WifiOff size={14} aria-hidden />
          <span>
            {STATUS_LABEL[status]} Server files can't be read until Hermes is connected again
            {listing ? `. This list is from ${storedTime(listing.listedAt)}, and refreshes once connected.` : "."}
          </span>
        </div>
      )}
      {saved && (
        <div className="files-banner ok" role="status">
          <Check size={14} aria-hidden />
          <span>{saved}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setSaved(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {pickError && (
        <div className="files-banner err" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{pickError}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setPickError(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="files-banner err" role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>
            {error.path ? (
              <>
                Couldn't open <span className="mono">{error.path}</span>:{" "}
              </>
            ) : (
              "Couldn't list the starting folder: "
            )}
            {error.error.message}
          </span>
          {!listing && connected && error.path !== undefined && (
            <button className="btn" onClick={() => load(undefined)}>
              Open the starting folder
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setError(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className={`files-body ${preview ? "with-preview" : ""}`}>
        <div className="files-list" ref={listRef} aria-busy={loading} data-stale={!connected || undefined}>
          {listing && (
            <div className="files-tools">
              <input aria-label="Filter this folder" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <label className="files-hidden">
                <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Hidden files
                {hiddenCount > 0 && !showHidden && <span className="count">{hiddenCount}</span>}
              </label>
              <span className="muted small files-count">
                {entries.length === listing.entries.length ? `${entries.length} items` : `${entries.length} of ${listing.entries.length} items`}
              </span>
            </div>
          )}
          {listing && (
            <table className="files-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="num">
                    Size
                  </th>
                  <th scope="col">Modified</th>
                  <th scope="col">Type</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(0, shown).map((entry) => {
                  const on = preview?.entry.path === entry.path && preview.entry.name === entry.name;
                  return (
                    <tr key={entry.name} className={on ? "sel" : undefined} aria-selected={on || undefined}>
                      <td className="files-name">
                        <button
                          disabled={!connected || entry.kind === "broken-link"}
                          title={entry.linkTarget ? `${entry.name} → ${entry.linkTarget}` : entry.path}
                          onClick={() => open(entry)}
                        >
                          <EntryIcon entry={entry} />
                          <span className="files-label">{entry.name}</span>
                          {entry.linkTarget && (
                            <span className="files-link muted">
                              <Link2 size={12} aria-label="Symbolic link to" /> <span className="mono">{entry.linkTarget}</span>
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="num muted">{entry.size !== undefined ? fmtSize(entry.size) : ""}</td>
                      <td className="muted">{entry.modified !== undefined ? modifiedAt(entry.modified) : ""}</td>
                      <td className="muted files-type">{typeLabel(entry)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {listing && !entries.length && (
            <p className="empty-hint">{listing.entries.length ? "Nothing here matches." : "This folder is empty."}</p>
          )}
          {entries.length > shown && (
            <div className="files-more">
              <button className="btn" onClick={() => setShown((n) => n + ENTRY_PAGE)}>
                Show {Math.min(ENTRY_PAGE, entries.length - shown)} more
              </button>
              <span className="muted small">
                Showing {shown} of {entries.length}. Filter by name to find one.
              </span>
            </div>
          )}
          {!listing && loading && (
            <p className="empty-hint">
              <Spinner /> Listing the server's files…
            </p>
          )}
        </div>

        {preview && (
          <PreviewPane
            preview={preview}
            files={files}
            connected={connected}
            onOpenAsText={() => open(preview.entry, true)}
            onEdit={() => {
              setSaved(undefined);
              setEditing(preview.entry);
            }}
            onClose={dropPreview}
          />
        )}
      </div>
      <Transfers files={files} />
      {editing && (
        <FileEditor
          files={files}
          entry={editing}
          connected={connected}
          onClose={() => setEditing(undefined)}
          onSaved={(note) => {
            const entry = editing;
            setEditing(undefined);
            setSaved(note);
            reopen.current = entry.path;
            if (listing) load(listing.path, true);
          }}
        />
      )}
      {uploading && (
        <UploadDialog
          files={files}
          {...uploading}
          connected={connected}
          returnTo={uploadButton}
          onSend={sendUpload}
          onCancel={() => {
            files.discardUpload(uploading.picked);
            setUploading(undefined);
          }}
        />
      )}
    </div>
  );
}

/**
 * Where a picked file goes, before anything is sent: its name and size, the server path, and, when the name is taken,
 * the choice of keeping both (the default) or replacing the server's file. Nothing is sent until Upload.
 */
function UploadDialog({
  files,
  picked,
  listing,
  connected,
  returnTo,
  onSend,
  onCancel,
}: {
  files: RemoteFiles;
  picked: PickedUpload;
  listing: RemoteListing;
  connected: boolean;
  returnTo: RefObject<HTMLButtonElement | null>;
  onSend: (collision: Collision) => void;
  onCancel: () => void;
}) {
  const plan = files.planUpload(listing, picked);
  const [collision, setCollision] = useState<Collision>("keep-both");
  const titleId = useId();
  const takenId = useId();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const replace = !!plan.taken && collision === "replace";
  const dest = plan.taken && !replace ? `${listing.path.replace(/\/$/, "")}/${plan.keepBothName}` : plan.dest;
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={box}
        className="leave-dialog files-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <Upload size={14} aria-hidden /> Upload to the server
        </h2>
        <dl className="files-meta">
          <dt>From this computer</dt>
          <dd>
            <span className="mono">{picked.name}</span>, {fmtSize(picked.size)}
          </dd>
          <dt>To the server</dt>
          <dd className="mono">{dest}</dd>
        </dl>
        {plan.refused ? (
          <p role="alert" className="files-transfer-error">
            {plan.refused}
          </p>
        ) : (
          plan.taken && (
            <div className="files-collision" role="radiogroup" aria-labelledby={takenId}>
              <p id={takenId} className="files-collision-note">
                <CircleAlert size={13} aria-hidden /> There's already a <span className="mono">{picked.name}</span> in this folder
                {plan.taken.size !== undefined && `, ${fmtSize(plan.taken.size)}`}
                {plan.taken.modified !== undefined && `, modified ${storedTime(plan.taken.modified)}`}.
              </p>
              <label>
                <input type="radio" name="collision" checked={collision === "keep-both"} onChange={() => setCollision("keep-both")} /> Keep both: upload this one as{" "}
                <span className="mono">{plan.keepBothName}</span>
              </label>
              <label>
                <input type="radio" name="collision" checked={collision === "replace"} onChange={() => setCollision("replace")} /> Replace the server's{" "}
                <span className="mono">{picked.name}</span>
              </label>
              {!replace && (
                <p className="muted small">Hermes checks the name again before it writes, though not at the very moment it writes; a file made there in that instant would still be replaced.</p>
              )}
              {replace && (
                <p className="muted small">
                  Hermes writes it as a new file, readable and writable only by the server's user; the old file's permissions aren't kept. It can't be undone.
                </p>
              )}
            </div>
          )
        )}
        {!plan.refused && <p className="muted small">Nothing is sent until you press {replace ? "Replace" : "Upload"}. The server's own permissions still apply.</p>}
        <div className="confirm-actions">
          <button className="btn" autoFocus={!!plan.refused} onClick={onCancel}>
            {plan.refused ? "Close" : "Cancel"}
          </button>
          {!plan.refused && (
            <button className={`btn ${replace ? "danger" : "primary"}`} autoFocus disabled={!connected} onClick={() => onSend(collision)}>
              {replace ? "Replace" : "Upload"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const percent = (t: Transfer) => (t.total ? Math.min(100, Math.floor((t.done / t.total) * 100)) : undefined);

/** The downloads started from this screen, with where each goes, how far it got, and Cancel while it runs. */
function Transfers({ files }: { files: RemoteFiles }) {
  const transfers = useSyncExternalStore(files.subscribe, files.transfers);
  if (!transfers.length) return null;
  return (
    <section className="files-transfers" aria-label="Transfers">
      <ul>
        {transfers.map((t) => {
          const pct = percent(t);
          const running = t.state === "picking" || t.state === "running";
          const up = t.kind === "upload";
          return (
            <li key={t.id} className={`files-transfer ${t.state}`}>
              <div className="files-transfer-main">
                <div className="files-transfer-title">
                  {t.state === "done" ? (
                    <Check size={14} aria-hidden className="ok" />
                  ) : t.state === "failed" ? (
                    <CircleAlert size={14} aria-hidden className="bad" />
                  ) : up ? (
                    <Upload size={14} aria-hidden />
                  ) : (
                    <Download size={14} aria-hidden />
                  )}
                  <span className="files-transfer-name">{t.name}</span>
                  <span className="muted small">
                    {t.state === "picking"
                      ? "Choosing where to save it…"
                      : t.state === "running"
                        ? pct !== undefined
                          ? `${fmtSize(t.done)} of ${fmtSize(t.total!)} (${pct}%)`
                          : `${fmtSize(t.done)} so far`
                        : t.state === "checking"
                          ? "Sent. Checking the server has it…"
                          : t.state === "done"
                            ? up
                              ? `Uploaded, and the server lists it at ${fmtSize(t.done)}`
                              : `Downloaded, ${fmtSize(t.done)}`
                            : up
                              ? t.state === "stopped"
                                ? "Stopped. Hermes never keeps part of a file, but if it had already received all of it, it may still save it: the folder shows what it has."
                                : "Failed."
                              : t.state === "stopped"
                                ? "Stopped. Nothing was saved, and any file already there is as it was."
                                : "Failed. Nothing was saved, and any file already there is as it was."}
                  </span>
                </div>
                <div className="files-transfer-where muted small">
                  {up ? (
                    <>
                      <span>
                        From this computer: <span className="mono">{t.localName}</span>
                      </span>
                      <span>
                        To the server: <span className="mono">{t.serverPath}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        From the server: <span className="mono">{t.serverPath}</span>
                      </span>
                      {t.dest && (
                        <span>
                          To this computer: <span className="mono">{t.dest}</span>
                        </span>
                      )}
                    </>
                  )}
                </div>
                {t.state === "running" && (
                  <progress className="files-progress" max={100} value={pct} aria-label={`${up ? "Uploading" : "Downloading"} ${t.name}`} aria-valuetext={pct !== undefined ? `${pct}%` : `${fmtSize(t.done)}`} />
                )}
                {t.error && (
                  <p className="files-transfer-error" role="alert">
                    {t.error}
                  </p>
                )}
              </div>
              {running ? (
                <button className="btn" onClick={() => files.cancel(t.id)} disabled={t.state === "picking"}>
                  Cancel
                </button>
              ) : (
                <button className="icon-btn" aria-label={`Dismiss ${t.name}`} title="Dismiss" onClick={() => files.dismiss(t.id)}>
                  <X size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A file's preview: its path, size and type, and its text or image. `files`: Server files, for Download; left out for a
 * file that isn't on the dashboard's machine. `onEdit` and `onOpenAsText` left out: the preview only shows.
 */
export function PreviewPane({
  preview,
  files,
  connected,
  onOpenAsText,
  onEdit,
  onClose,
}: {
  preview: Preview;
  files?: RemoteFiles;
  connected: boolean;
  onOpenAsText?: () => void;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const { entry } = preview;
  const result = preview.state === "ready" ? preview.result : undefined;
  const why = files?.cantDownload(entry);
  const cantDownload = why ?? (connected ? undefined : "Hermes isn't connected.");
  return (
    <aside className="files-preview" aria-label={`Preview of ${entry.name}`}>
      <div className="files-preview-head">
        <h2 title={entry.name}>{entry.name}</h2>
        <div className="files-preview-actions">
          {onEdit && result?.kind === "text" && result.size <= EDIT_MAX_BYTES && (
            <button className="btn" disabled={!connected} title="Edit this text file and save it back to the server" onClick={onEdit}>
              <FilePen size={14} aria-hidden /> Edit
            </button>
          )}
          {files && entry.kind === "file" && (
            <button className="btn" disabled={!!cantDownload} title={cantDownload ?? "Save a copy on this computer. You pick where."} onClick={() => void files.download(entry)}>
              <Download size={14} aria-hidden /> Download…
            </button>
          )}
          <button className="icon-btn" aria-label="Close preview" title="Close preview" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      {entry.kind === "file" && why && <p className="files-preview-note muted small">{why}</p>}
      <dl className="files-meta">
        <dt>Path</dt>
        <dd className="mono">{result?.path ?? entry.path}</dd>
        {entry.linkTarget && (
          <>
            <dt>Link</dt>
            <dd>A symbolic link; this is its target.</dd>
          </>
        )}
        {(result?.size ?? entry.size) !== undefined && (
          <>
            <dt>Size</dt>
            <dd>
              {fmtSize(result?.size ?? entry.size!)} ({(result?.size ?? entry.size!).toLocaleString()} bytes)
            </dd>
          </>
        )}
        {entry.modified !== undefined && (
          <>
            <dt>Modified</dt>
            <dd>{storedTime(entry.modified)}</dd>
          </>
        )}
        {entry.mime && (
          <>
            <dt>Type</dt>
            <dd>{entry.mime}</dd>
          </>
        )}
      </dl>
      <div className="files-preview-body">
        {preview.state === "loading" && (
          <p className="muted small">
            <Spinner /> Reading from the server…
          </p>
        )}
        {preview.state === "failed" && (
          <p className="files-preview-msg" role="alert">
            {preview.error}
          </p>
        )}
        {preview.state === "ask" && onOpenAsText && (
          <div className="files-preview-msg">
            <p>Hermes doesn't say what kind of file this is.</p>
            <button className="btn" disabled={!connected} onClick={onOpenAsText}>
              Open as text
            </button>
          </div>
        )}
        {result?.kind === "binary" && <p className="files-preview-msg">This looks like a binary file, so there's no text to show.</p>}
        {result?.kind === "image" && <img className="files-image" src={result.dataUrl} alt={result.name} />}
        {result?.kind === "text" && (result.text ? <pre className="files-text">{result.text}</pre> : <p className="files-preview-msg">This file is empty.</p>)}
      </div>
    </aside>
  );
}
