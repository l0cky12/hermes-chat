// Server files: a read-only browser for the files on the machine the Hermes dashboard runs on (remoteFiles.ts). It
// opens from the rail and takes the chat pane's place, as Settings does. Folders open in place, with the path above
// them as a trail of folders; a file opens in the preview beside the list. Nothing can be changed from here.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowUp, CircleAlert, File, FileImage, FileText, Folder, House, Link2, Link2Off, RefreshCw, Server, WifiOff, X } from "lucide-react";
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
  type RemotePreview,
} from "../hermes/remoteFiles";
import { STATUS_LABEL, Spinner, composing, fmtSize, routeLabel, storedTime } from "./bits";

type Preview =
  | { entry: RemoteEntry; state: "loading" }
  | { entry: RemoteEntry; state: "ready"; result: RemotePreview }
  | { entry: RemoteEntry; state: "ask" }
  | { entry: RemoteEntry; state: "failed"; error: string };

const errorOf = (e: unknown) => (e instanceof RemoteFilesError ? e : new RemoteFilesError(e instanceof Error ? e.message : String(e)));

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
  onClose: () => void;
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
  // Only the latest listing and preview asked for land; an older answer arriving late is dropped.
  const listSeq = useRef(0);
  const previewSeq = useRef(0);
  // The path of the file in the preview pane, kept in step with `preview` without waiting for a render.
  const previewPath = useRef<string | undefined>(undefined);
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
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="files-title">
          <h1>Server files</h1>
          <span className="files-server" title="The machine the Hermes dashboard runs on">
            <Server size={13} aria-hidden /> <span className="mono">{where}</span>
          </span>
          <span className="badge">Read-only</span>
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

        {preview && <PreviewPane preview={preview} connected={connected} onOpenAsText={() => open(preview.entry, true)} onClose={dropPreview} />}
      </div>
    </div>
  );
}

function PreviewPane({ preview, connected, onOpenAsText, onClose }: { preview: Preview; connected: boolean; onOpenAsText: () => void; onClose: () => void }) {
  const { entry } = preview;
  const result = preview.state === "ready" ? preview.result : undefined;
  return (
    <aside className="files-preview" aria-label={`Preview of ${entry.name}`}>
      <div className="files-preview-head">
        <h2 title={entry.name}>{entry.name}</h2>
        <button className="icon-btn" aria-label="Close preview" title="Close preview" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
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
        {preview.state === "ask" && (
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
