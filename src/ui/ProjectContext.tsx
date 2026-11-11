// The project page's Context card (GLOSSARY.md "Context file", ADR 0135): the files in the project's context folder on
// the server, how much of the model's room they take, and the ways to add, replace, preview and remove them.
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { File as FileIcon, FilePen, FileText, GitBranch, Plus, RefreshCw, Search, Upload, X } from "lucide-react";
import {
  MAX_FILE_BYTES,
  joinPath,
  nameProblem,
  percentUsed,
  planAdd,
  sizeText,
  textFileName,
  typeLabel,
  type Capacity,
  type ContextFile,
  type ContextState,
  type ContextWrites,
  type LocalFile,
} from "../hermes/projectContext";
import { ContextExistsError, asEntry, mainFolder, type AddTarget, type ContextProject, type Picked, type ProjectContextFiles } from "../hermes/projectContextFiles";
import type { RemoteFiles } from "../hermes/remoteFiles";
import { PreviewPane, type Preview } from "./FileBrowser";
import { Spinner, composing, menuArrows, useDismiss } from "./bits";
import { useModal } from "./modal";
import { errorText } from "../hermes/values";

/** The default model the capacity is measured against: its name, and its context window once a chat has reported one. */
export type CapacityModel = { name?: string; window?: number };

const SSH_NOTE =
  "This profile's tools run over SSH, so its files are on that machine. Hermes can only write text files there, up to 8 MB, into a context folder that is already there, and can't remove a file or make a folder yet.";

function limitNote(c: Capacity, model: CapacityModel): string {
  const tokens = `${c.limit.toLocaleString("en-US")} tokens`;
  if (model.window) return `100% is half of ${model.name ?? "the default model"}'s context window: ${tokens}.`;
  if (model.name) return `100% is ${tokens}: Hermes doesn't list ${model.name}'s context window, and no chat here has run on it yet.`;
  return `100% is ${tokens}, as this project has no default model.`;
}

function Dialog({ label, className = "", onClose, children, returnTo }: { label: string; className?: string; onClose: () => void; children: ReactNode; returnTo?: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className={`leave-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

type Doing =
  | { kind: "idle" }
  | { kind: "busy"; what: string }
  | { kind: "menu" }
  | { kind: "text"; title: string; text: string; taken?: string; saving: boolean; error?: string }
  | { kind: "replace"; dir: string; writes: ContextWrites; files: LocalFile[] }
  | { kind: "remove"; dir: string; file: ContextFile }
  | { kind: "preview"; writes: ContextWrites; preview: Preview };

export function ContextCard({
  files,
  remote,
  profile,
  project,
  connection,
  connected,
  model,
  onAddFolder,
}: {
  files: ProjectContextFiles;
  /** Server files, for a preview's Download on a profile whose files are on the dashboard's machine. */
  remote: RemoteFiles;
  profile: string;
  project: ContextProject;
  /** Names the connection, so an answer for another one is dropped. */
  connection?: string;
  connected: boolean;
  model: CapacityModel;
  /** Adds a folder to the project, as its main folder when it has none. */
  onAddFolder: (path: string) => Promise<unknown>;
}) {
  const [state, setState] = useState<ContextState>({ kind: "loading" });
  const [doing, setDoing] = useState<Doing>({ kind: "idle" });
  const [notes, setNotes] = useState<string[]>([]);
  const [query, setQuery] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const card = useRef<HTMLElement>(null);
  const adder = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const key = [connection ?? "", profile, project.id, mainFolder(project) ?? ""].join("\n");
  const shown = useRef(key);
  shown.current = key;
  const reads = useRef(0);
  const refresh = async () => {
    const asked = key;
    const n = ++reads.current;
    const next = await files.read(profile, project, { window: model.window, git: true });
    if (shown.current === asked && n === reads.current) setState(next);
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    setState({ kind: "loading" });
    setNotes([]);
    setDoing({ kind: "idle" });
    if (connected) void refreshRef.current();
  }, [key, connected]);
  useEffect(() => {
    if (connected && state.kind === "ready") void refreshRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [model.window]);

  useDismiss(adder, doing.kind === "menu", () => setDoing((d) => (d.kind === "menu" ? { kind: "idle" } : d)));

  const target: AddTarget | undefined = state.kind === "ready" || state.kind === "noFolder" ? state : undefined;
  const cantAdd = !connected ? "Connect to Hermes to add context files." : doing.kind === "busy" ? doing.what : undefined;

  const change = async (what: string, run: (note: (text: string) => void) => Promise<Doing | void>) => {
    const asked = key;
    const said: string[] = [];
    setDoing({ kind: "busy", what });
    let next: Doing | void = undefined;
    try {
      next = await run((text) => said.push(text));
    } catch (e) {
      said.push(errorText(e));
    }
    if (shown.current !== asked) return;
    setNotes(said);
    setDoing(next ?? { kind: "idle" });
    await refresh();
  };

  const addFiles = (picked: Picked | Promise<Picked>) => {
    if (!target || cantAdd) return;
    const to = target;
    void change("Adding files…", async (note) => {
      const got = await picked;
      const plan = planAdd(to.kind === "ready" ? to.files : [], got.files, to.writes);
      for (const r of [...got.refused, ...plan.refused]) note(r.why);
      if (!plan.fresh.length && !plan.taken.length) return;
      const dir = await files.folderFor(to, onAddFolder);
      const taken = [...plan.taken];
      for (const f of plan.fresh)
        try {
          await files.upload(profile, dir, to.writes, f, false);
        } catch (e) {
          if (e instanceof ContextExistsError) taken.push(f);
          else note(errorText(e));
        }
      if (taken.length) return { kind: "replace", dir, writes: to.writes, files: taken };
    });
  };

  const replaceNext = (replace: boolean) => {
    if (doing.kind !== "replace") return;
    const { dir, writes, files: waiting } = doing;
    const [file, ...rest] = waiting;
    const after: Doing = rest.length ? { kind: "replace", dir, writes, files: rest } : { kind: "idle" };
    if (!replace) return setDoing(after);
    void change(`Replacing ${file.name}…`, async () => {
      await files.upload(profile, dir, writes, file, true);
      return after;
    });
  };

  const saveText = () => {
    if (doing.kind !== "text" || !target) return;
    const to = target;
    const form = doing;
    const name = textFileName(form.title);
    if (!form.title.trim()) return setDoing({ ...form, error: "Give it a title: it is saved as <title>.md." });
    const bad = nameProblem(name);
    if (bad) return setDoing({ ...form, error: `${name} can't be a context file: ${bad}.` });
    const there = to.kind === "ready" && to.files.some((f) => f.name === name);
    if (there && form.taken !== name) return setDoing({ ...form, taken: name, error: undefined });
    setDoing({ ...form, saving: true, error: undefined });
    const asked = key;
    void (async () => {
      try {
        const dir = await files.folderFor(to, onAddFolder);
        await files.addText(profile, dir, to.writes, name, form.text, form.taken === name);
        if (shown.current !== asked) return;
        setDoing({ kind: "idle" });
        setNotes([]);
      } catch (e) {
        if (shown.current !== asked) return;
        setDoing(e instanceof ContextExistsError ? { ...form, taken: name, saving: false } : { ...form, saving: false, error: errorText(e) });
      }
      await refresh();
    })();
  };

  const remove = () => {
    if (doing.kind !== "remove") return;
    const { dir, file } = doing;
    void change(`Removing ${file.name}…`, () => files.remove(profile, dir, file));
  };

  const openPreview = (writes: ContextWrites, file: ContextFile) => {
    const entry = asEntry(file);
    const asked = key;
    setDoing({ kind: "preview", writes, preview: { entry, state: "loading" } });
    const still = (d: Doing) => d.kind === "preview" && d.preview.entry.path === entry.path && shown.current === asked;
    files.preview(profile, writes, file).then(
      (result) => setDoing((d) => (still(d) ? { kind: "preview", writes, preview: { entry, state: "ready", result } } : d)),
      (e) => setDoing((d) => (still(d) ? { kind: "preview", writes, preview: { entry, state: "failed", error: errorText(e) } } : d)),
    );
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  // Tauri's native drop gives real paths (off on Windows, where the drop arrives as HTML5 below). Every listener hears
  // every drop, so the card takes only one that lands on it.
  useEffect(() => {
    const over = (p: { x: number; y: number }) => {
      const box = card.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!box && p.x / scale >= box.left && p.x / scale <= box.right && p.y / scale >= box.top && p.y / scale <= box.bottom;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") return setDragging(over(payload.position));
      setDragging(false);
      if (payload.type === "drop" && over(payload.position)) addFilesRef.current(files.dropped(payload.paths));
    });
    return () => void unlisten.then((stop) => stop());
  }, [files]);

  // A file dropped as HTML5 has no path of its own, so Rust stages its bytes.
  const dropped = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    const all = Array.from(e.dataTransfer.files);
    const tooBig = all.filter((f) => f.size > MAX_FILE_BYTES);
    addFiles(
      (async (): Promise<Picked> => {
        const staged = await Promise.all(
          all.filter((f) => !tooBig.includes(f)).map(async (f) => invoke<string>("stage_clipboard_file", await f.arrayBuffer(), { headers: { "x-name": encodeURIComponent(f.name) } })),
        );
        const got = await files.dropped(staged);
        return { files: got.files, refused: [...got.refused, ...tooBig.map((f) => ({ name: f.name, why: `${f.name} wasn't added: it's ${sizeText(f.size)}, over the ${sizeText(MAX_FILE_BYTES)} a context file can be.` }))] };
      })(),
    );
  };

  const ready = state.kind === "ready" ? state : undefined;
  const listed = ready?.files ?? [];
  const found = query ? listed.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase())) : listed;
  const percent = ready && percentUsed(ready.capacity);

  return (
    <section
      ref={card}
      className={`project-card pctx-card${dragging && target ? " dropping" : ""}`}
      aria-labelledby={titleId}
      onDragOver={(e) => {
        if (!target || !e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={dropped}
    >
      <div className="project-card-head">
        <h2 id={titleId}>Context</h2>
        {ready?.capacity.mode === "list" && (
          <span className="badge warn" title="The files are over 100%, so chats get each file's path instead of its text, and open the ones they need.">
            List mode
          </span>
        )}
        <span className="project-card-actions">
          {listed.length > 0 && (
            <button className={`icon-btn${query !== undefined ? " on" : ""}`} aria-label="Search context files" aria-pressed={query !== undefined} title="Search context files by name" onClick={() => setQuery(query === undefined ? "" : undefined)}>
              <Search size={14} />
            </button>
          )}
          {target && (
            <div className="pctx-add" ref={adder}>
              <button
                ref={addButton}
                className="icon-btn"
                aria-label="Add context"
                aria-haspopup="menu"
                aria-expanded={doing.kind === "menu"}
                disabled={!!cantAdd}
                title={cantAdd ?? "Add files or text to this project's context"}
                onClick={() => setDoing(doing.kind === "menu" ? { kind: "idle" } : { kind: "menu" })}
              >
                <Plus size={15} />
              </button>
              {doing.kind === "menu" && (
                <div
                  className="menu pctx-add-menu"
                  role="menu"
                  aria-label="Add context"
                  onKeyDown={(e) => {
                    menuArrows(e);
                    if (e.key !== "Escape") return;
                    setDoing({ kind: "idle" });
                    addButton.current?.focus();
                  }}
                >
                  <button role="menuitem" className="menu-item" autoFocus onClick={() => addFiles(files.pick())}>
                    <span className="menu-icon">
                      <Upload size={13} />
                    </span>
                    Upload files
                  </button>
                  <button role="menuitem" className="menu-item" onClick={() => setDoing({ kind: "text", title: "", text: "", saving: false })}>
                    <span className="menu-icon">
                      <FilePen size={13} />
                    </span>
                    Add text content
                  </button>
                </div>
              )}
            </div>
          )}
        </span>
      </div>

      {ready && (
        <div className="pctx-capacity">
          <div
            className={`pctx-bar${ready.capacity.mode === "list" ? " over" : ""}`}
            role="progressbar"
            aria-label="Project capacity used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, percent!)}
            aria-valuetext={`${percent}% of project capacity used`}
          >
            <span style={{ width: `${Math.min(100, percent!)}%` }} />
          </div>
          <p className="pctx-capacity-text">{percent}% of project capacity used</p>
          <p className="muted small">
            {limitNote(ready.capacity, model)}
            {ready.capacity.mode === "list" && " Over it, chats get each file's path instead of its text, and open the ones they need."}
          </p>
        </div>
      )}

      {query !== undefined && (
        <input
          className="profile-filter pctx-search"
          type="search"
          aria-label="Filter context files by name"
          placeholder="Filter by name"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && !composing(e) && setQuery(undefined)}
        />
      )}

      {!connected && state.kind === "loading" && <p className="muted small">Connect to Hermes to see this project's context files.</p>}
      {connected && state.kind === "loading" && (
        <p className="muted small" role="status">
          <Spinner /> Reading the project's context files…
        </p>
      )}
      {state.kind === "unsupported" && (
        <div className="pctx-note" role="status">
          <p>This Hermes server can't keep context files for this profile. It lacks:</p>
          <ul>
            {state.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="muted small">Updating Hermes on the server adds them. Settings → Diagnostics shows what else it supports.</p>
        </div>
      )}
      {state.kind === "failed" && (
        <div className="pctx-note">
          <p className="sign-in-error small" role="alert">
            Couldn't read the context files: {state.message}
          </p>
          <button className="btn" disabled={!connected} onClick={() => void refresh()}>
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      )}
      {target && !listed.length && (
        <div className="pctx-empty">
          <p>Add files to give every chat in this project the same context</p>
          <p className="muted small">
            {target.kind === "ready" ? (
              <>
                They go in <span className="mono">{target.dir}</span> on the server{target.exists ? "" : ", which the first file makes"}. Files put there by other means show here too.
              </>
            ) : target.creates ? (
              <>
                This project has no folder yet. The first file makes <span className="mono">{target.creates}</span> on the server, adds it to the project as its main folder, and goes in{" "}
                <span className="mono">{joinPath(target.creates, "context")}</span>.
              </>
            ) : target.writes === "text-only" ? (
              <>This project has no folder yet, and Hermes can't make one on an SSH machine. Add a folder that has a context folder inside it from the project's menu.</>
            ) : (
              <>This project has no folder yet, and Hermes didn't say where this profile's own folder is. Add a folder from the project's menu first.</>
            )}
          </p>
        </div>
      )}
      {listed.length > 0 && (
        <ul className="pctx-files" aria-label="Context files">
          {found.map((f) => (
            <li key={f.path} className="pctx-file">
              <button className="pctx-file-open" title={`Preview ${f.path}`} onClick={() => openPreview(ready!.writes, f)}>
                {f.tokens === undefined ? <FileIcon size={15} aria-hidden /> : <FileText size={15} aria-hidden />}
                <span className="pctx-file-name">{f.name}</span>
                <span className="pctx-file-meta">
                  {f.size !== undefined && <span>{sizeText(f.size)}</span>}
                  <span className="badge">{typeLabel(f.name)}</span>
                  {f.tokens === undefined && (
                    <span className="badge" title="It has no text Hermes Chat can read, so chats get its path and open it with their own tools.">
                      Path only
                    </span>
                  )}
                </span>
              </button>
              {ready!.writes === "all" && (
                <button
                  className="icon-btn pctx-file-remove"
                  aria-label={`Remove ${f.name}`}
                  title={connected ? `Remove ${f.name} from the project and delete it on the server` : "Connect to Hermes to remove it"}
                  disabled={!connected || doing.kind === "busy"}
                  onClick={() => setDoing({ kind: "remove", dir: ready!.dir, file: f })}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
          {!found.length && <li className="muted small">No context file's name has “{query}” in it.</li>}
        </ul>
      )}

      {target?.writes === "text-only" && <p className="muted small pctx-ssh">{SSH_NOTE}</p>}
      {ready?.gitNote && (
        <p className="muted small pctx-git">
          <GitBranch size={11} aria-hidden /> context/ is ignored locally in this Git repository
        </p>
      )}
      {doing.kind === "busy" && (
        <p className="muted small" role="status">
          <Spinner /> {doing.what}
        </p>
      )}
      {notes.length > 0 && (
        <ul className="pctx-notes" role="alert">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          <li>
            <button className="link-btn" onClick={() => setNotes([])}>
              Dismiss
            </button>
          </li>
        </ul>
      )}

      {doing.kind === "text" && (
        <Dialog label="Add text content" className="pctx-text-dialog" onClose={() => !doing.saving && setDoing({ kind: "idle" })} returnTo={addButton}>
          <h2 className="leave-title">Add text content</h2>
          <label className="field">
            <span className="field-label">Title</span>
            <input autoFocus value={doing.title} readOnly={doing.saving} placeholder="Style guide" onChange={(e) => setDoing({ ...doing, title: e.target.value, taken: undefined, error: undefined })} />
          </label>
          <label className="field">
            <span className="field-label">Content</span>
            <textarea rows={10} value={doing.text} readOnly={doing.saving} spellCheck onChange={(e) => setDoing({ ...doing, text: e.target.value })} />
          </label>
          <p className="muted small">
            Saved as <span className="mono">{doing.title.trim() ? textFileName(doing.title) : "<title>.md"}</span> in the project's context folder on the server.
          </p>
          {doing.taken && (
            <p className="files-collision-note" role="alert">
              There's already a <span className="mono">{doing.taken}</span> in this project's context files. Replace it? Its text on the server is lost.
            </p>
          )}
          {doing.error && (
            <p className="sign-in-error small" role="alert">
              {doing.error}
            </p>
          )}
          <div className="confirm-actions">
            <button className="btn" disabled={doing.saving} onClick={() => setDoing({ kind: "idle" })}>
              Cancel
            </button>
            <button className={`btn ${doing.taken ? "danger" : "primary"}`} disabled={doing.saving || !connected} onClick={saveText}>
              {doing.saving ? "Saving…" : doing.taken ? "Replace" : "Add"}
            </button>
          </div>
        </Dialog>
      )}
      {doing.kind === "replace" && (
        <Dialog label="Replace context file" onClose={() => replaceNext(false)} returnTo={addButton}>
          <p>
            There's already a <span className="mono">{doing.files[0].name}</span>
            {(() => {
              const there = listed.find((f) => f.name === doing.files[0].name);
              return there?.size !== undefined ? `, ${sizeText(there.size)},` : "";
            })()}{" "}
            in this project's context files. Replace it with the one you picked, {sizeText(doing.files[0].size)}?
          </p>
          <p className="muted small">
            The file at <span className="mono">{joinPath(doing.dir, doing.files[0].name)}</span> on the server is written over. It can't be undone.
          </p>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => replaceNext(false)}>
              Keep the one there
            </button>
            <button className="btn danger" disabled={!connected} onClick={() => replaceNext(true)}>
              Replace
            </button>
          </div>
        </Dialog>
      )}
      {doing.kind === "remove" && (
        <Dialog label="Remove context file" onClose={() => setDoing({ kind: "idle" })}>
          <p>
            Remove <span className="mono">{doing.file.name}</span> from this project's context files?
          </p>
          <p className="muted small">
            <span className="mono">{doing.file.path}</span> is deleted on the server. Chats in this project are told it was removed with their next message; what they already read of it
            stays in their history.
          </p>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setDoing({ kind: "idle" })}>
              Cancel
            </button>
            <button className="btn danger" disabled={!connected} onClick={remove}>
              Remove
            </button>
          </div>
        </Dialog>
      )}
      {doing.kind === "preview" && (
        <Dialog label={`Preview of ${doing.preview.entry.name}`} className="pctx-preview-dialog" onClose={() => setDoing({ kind: "idle" })}>
          <PreviewPane preview={doing.preview} files={doing.writes === "all" ? remote : undefined} connected={connected} onClose={() => setDoing({ kind: "idle" })} />
        </Dialog>
      )}
    </section>
  );
}
