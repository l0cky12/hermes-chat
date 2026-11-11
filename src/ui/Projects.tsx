// Projects (GLOSSARY.md "Project", ADR 0131): the switcher under the profile's name, which narrows the chat list to one
// project's chats, and the project page (ADR 0135), where a chat is started in the project, its instructions and
// context files are kept, and it is renamed or deleted and its folders added and taken out.
// The project and its folders are Hermes's; which chats are in it is Hermes's when it keeps it, and this computer's when
// it doesn't (MembershipSync.tsx, ADR 0109).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Ellipsis, FolderGit2, Folder, FolderKanban, GitBranch, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { EFFORT_LABEL, shortName, type Effort, type ModelCatalog, type ModelPick } from "../hermes/models";
import { DefaultsConflict, NewerDefaultsError, cleanDraft, draftProblem, sameDraft, type DefaultsDraft, type ProjectDefaults } from "../hermes/projectDefaults";
import type { Project, ProjectFolder, Worktree } from "../hermes/projects";
import { Age, Spinner, composing, menuArrows, useDismiss, useReturnFocus } from "./bits";
import { ModelControls } from "./ModelPicker";
import { errorText } from "../hermes/values";

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const chatsText = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;

/** Unread chats: in the whole list, outside the project shown, and in each project. */
export type ProjectUnread = { all: number; hidden: number; of: (projectId: string) => number };

/**
 * The project the chat list shows, with a ▾ that opens the profile's projects, "All chats" first, and New project.
 * Opening it reads the projects from Hermes again. A dot on it shows Unread chats the list doesn't show, as the profile
 * switcher does for other profiles. Beside it, the shown project's settings.
 */
export function ProjectSwitcher({
  projects,
  selected,
  unread,
  loading,
  error,
  connected,
  onOpen,
  onSelect,
  onCreate,
  onManage,
  attention,
  onReview,
  unsupported,
}: {
  /**
   * The connected Hermes has no projects (capabilities.ts): the menu says so with a link to the compatibility guide,
   * and offers no New project, so nothing is sent that Hermes can't take.
   */
  unsupported?: { onGuide: () => void };
  /** What the membership sync wants of the owner, if anything: shown as a dot, and a line in the menu. */
  attention?: string;
  onReview?: () => void;
  /** The projects that can be shown: archived ones are left out. */
  projects: Project[];
  selected?: Project;
  unread: ProjectUnread;
  loading: boolean;
  error?: string;
  connected: boolean;
  onOpen: () => void;
  onSelect: (id: string | undefined) => void;
  onCreate: (name: string) => Promise<unknown>;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const name = selected?.name ?? "All chats";
  const tip = [
    selected ? `Showing the chats in ${selected.name}` : "Showing every chat",
    unread.hidden > 0 && `${unread.hidden} unread ${unread.hidden === 1 ? "chat isn't" : "chats aren't"} shown`,
    attention,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="project-switch" ref={box}>
      <button className="project-btn" title={tip} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)}>
        <FolderKanban size={14} className="project-icon" />
        <span className="project-name">{name}</span>
        {unread.hidden > 0 && <span className="dot" aria-label="Unread chats not shown" />}
        {attention && <span className="dot warn" aria-label={attention} />}
        <ChevronDown size={13} className="profile-chev" />
      </button>
      {selected && (
        <button className="icon-btn project-manage" title={`Project settings for ${selected.name}`} onClick={onManage}>
          <Settings2 size={14} />
        </button>
      )}
      {open && (
        <ProjectMenu
          projects={projects}
          selectedId={selected?.id}
          unread={unread}
          loading={loading}
          error={error}
          connected={connected}
          onPick={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onCreate={async (n) => {
            await onCreate(n);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          unsupported={unsupported}
          attention={attention}
          onReview={
            onReview &&
            (() => {
              setOpen(false);
              onReview();
            })
          }
        />
      )}
    </div>
  );
}

function UnreadCount({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="profile-unread" aria-label={`${n} unread`}>
      <span className="dot" />
      {n}
    </span>
  );
}

/** The open project menu. Closing it puts focus back on the switcher. */
function ProjectMenu({
  projects,
  selectedId,
  unread,
  loading,
  error,
  connected,
  onPick,
  onCreate,
  onClose,
  attention,
  onReview,
  unsupported,
}: {
  unsupported?: { onGuide: () => void };
  attention?: string;
  onReview?: () => void;
  projects: Project[];
  selectedId?: string;
  unread: ProjectUnread;
  loading: boolean;
  error?: string;
  connected: boolean;
  onPick: (id: string | undefined) => void;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string>();
  useReturnFocus();

  const create = () => {
    if (saving) return;
    setSaving(true);
    setCreateError(undefined);
    onCreate(name).catch((e) => {
      setCreateError(`Couldn't make the project: ${errorText(e)}`);
      setSaving(false);
    });
  };

  const option = (id: string | undefined, label: string, n: number) => (
    <button
      key={id ?? ""}
      role="option"
      aria-selected={id === selectedId}
      autoFocus={id === selectedId && !naming}
      className={`profile-option ${id === selectedId ? "on" : ""}`}
      onClick={() => onPick(id)}
    >
      <span className="row-title">{label}</span>
      {id === selectedId ? <Check size={14} /> : <UnreadCount n={n} />}
    </button>
  );

  return (
    <div className="profile-menu project-menu" onKeyDown={(e) => e.key === "Escape" && !composing(e) && (naming ? setNaming(false) : onClose())}>
      <div className="profile-options" role="listbox" aria-label="Projects">
        {option(undefined, "All chats", unread.all)}
        {projects.map((p) => option(p.id, p.name, unread.of(p.id)))}
      </div>
      {!projects.length && !loading && !error && <div className="profile-hint">No projects in this profile yet.</div>}
      {loading && !projects.length && <div className="profile-hint">Loading projects…</div>}
      {error && !unsupported && <div className="profile-hint err">{error}</div>}
      {unsupported && (
        <div className="profile-hint">
          This Hermes server doesn't support projects.{" "}
          <button className="link-btn" onClick={unsupported.onGuide} aria-label="Compatibility guide: Projects">
            Compatibility guide
          </button>
        </div>
      )}
      {attention && onReview && (
        <button className="profile-option project-attention" onClick={onReview}>
          <span className="row-title">{attention}</span>
          <span className="muted small">Review…</span>
        </button>
      )}
      {unsupported ? null : naming ? (
        <div className="project-new">
          <input
            className="profile-filter"
            aria-label="New project name"
            placeholder="Project name"
            autoFocus
            value={name}
            readOnly={saving}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !composing(e) && create()}
          />
          {saving && <Spinner />}
          {createError && <div className="profile-hint err" role="alert">{createError}</div>}
        </div>
      ) : (
        <button
          className="profile-option project-create"
          disabled={!connected}
          title={connected ? "Make a project in this profile, in every Hermes client" : "Connect to Hermes to make a project"}
          onClick={() => setNaming(true)}
        >
          <span className="row-title">
            <Plus size={13} /> New project…
          </span>
        </button>
      )}
    </div>
  );
}

/** What was found on the server for one of a project's folders: why it can't be opened, or its repository's worktrees. */
type FolderFacts = { problem?: string; worktrees: Worktree[] };

/** The worktree `path` is, if it is one, and the repository's own checkout. */
function gitOf(path: string, trees: Worktree[]) {
  return { tree: trees.find((t) => t.path === path), main: trees.find((t) => t.main) };
}

function GitNote({ path, facts }: { path: string; facts?: FolderFacts }) {
  if (!facts) return null;
  if (facts.problem) return <div className="folder-note err">{facts.problem}</div>;
  const { tree, main } = gitOf(path, facts.worktrees);
  if (!facts.worktrees.length) return null;
  if (!tree) return <div className="folder-note">Inside the git repository at {main?.path ?? facts.worktrees[0].path}</div>;
  const branch = tree.detached ? "detached HEAD" : (tree.branch ?? "no branch");
  return (
    <div className="folder-note">
      <GitBranch size={11} /> {branch} · {tree.main ? "the repository's main worktree" : `a worktree of ${main?.path ?? "a repository"}`}
    </div>
  );
}

/** One of the project's chats, as the project page lists it. */
export type ProjectChat = { id: string; title: string; updatedAt?: number; unread?: boolean };

type Section = "folders" | "defaults" | "delete";


/**
 * A project's own page, over the chat pane like Settings (ADR 0135). A folder is checked on the server before it is
 * added. The only folder this app ever makes is the one for a project's context files (ProjectContext.tsx); no
 * repository or worktree is made.
 */
export function ProjectScreen({
  project,
  profile,
  connection,
  connected,
  chats,
  unlisted,
  onRename,
  onDelete,
  onAddFolder,
  onRemoveFolder,
  readFolder,
  onClose,
  defaults,
  membership,
  draft,
  onDraft,
  onStartChat,
  onOpenChat,
  context,
}: {
  /** Where the project's membership is kept and how far it is from Hermes (MembershipSync.tsx). */
  membership?: ReactNode;
  /** The project's defaults for new chats, and how to edit them. */
  defaults: Omit<DefaultsProps, "folders" | "profile" | "connection">;
  project: Project;
  profile: string;
  /** The connection the folders are on, as the owner typed it. */
  connection?: string;
  connected: boolean;
  /** The project's chats in the list now, newest first. */
  chats: ProjectChat[];
  /** The project's chats the list doesn't hold: older than it reaches, or archived or deleted elsewhere. */
  unlisted: number;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onAddFolder: (path: string) => Promise<unknown>;
  onRemoveFolder: (path: string) => Promise<unknown>;
  /** Reads what the server has at a folder; reads only. */
  readFolder: (path: string) => Promise<FolderFacts>;
  onClose: () => void;
  /** The New chat draft, which the page's composer shares with the New chat pane's. */
  draft: string;
  onDraft: (text: string) => void;
  /** Starts a chat in this project with the draft, the way the New chat pane's composer does. */
  onStartChat: () => void;
  onOpenChat: (id: string) => void;
  /** The Context card (ProjectContext.tsx). */
  context: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [path, setPath] = useState("");
  const [folderError, setFolderError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [facts, setFacts] = useState<Record<string, FolderFacts>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<{ section: Section; focus: "heading" | "instructions" }>();
  const moreBox = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useDismiss(moreBox, menuOpen, () => setMenuOpen(false));
  useEffect(() => {
    if (!open) return;
    const target = open.focus === "instructions" ? "#defaults-instructions" : `[data-section="${open.section}"] h2`;
    const el = panel.current?.querySelector<HTMLElement>(target);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const show = (section: Section, focus: "heading" | "instructions" = "heading") => {
    setMenuOpen(false);
    setOpen({ section, focus });
  };
  const closeSection = () => {
    setOpen(undefined);
    setConfirmDelete(false);
    more.current?.focus();
  };

  // What the server has at each folder, read again when the folders change or the connection comes back.
  const folderKey = project.folders.map((f) => f.path).join("\n");
  useEffect(() => {
    if (!connected) return;
    let current = true;
    for (const { path: p } of project.folders)
      void readFolder(p).then(
        (f) => current && setFacts((all) => ({ ...all, [p]: f })),
        () => {},
      );
    return () => {
      current = false;
    };
  }, [folderKey, connected]);

  const run = async (what: string, fn: () => Promise<unknown>, onError = setError) => {
    setBusy(what);
    onError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      onError(errorText(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const rename = async () => {
    if (name.trim() === project.name) return setRenaming(false);
    if (await run("rename", () => onRename(name))) setRenaming(false);
  };

  const addFolder = async (p: string) => {
    if (await run(`add ${p}`, () => onAddFolder(p), setFolderError)) setPath("");
  };

  // The worktrees of each repository the project's folders are in, that the project doesn't have yet.
  const inProject = new Set(project.folders.map((f) => f.path));
  const others = new Map<string, Worktree>();
  for (const f of project.folders)
    for (const t of facts[f.path]?.worktrees ?? []) if (!inProject.has(t.path)) others.set(t.path, t);

  const offline = connected ? undefined : "Connect to Hermes to change this project.";
  const instructions = defaults.saved?.instructions?.trim();
  const canStart = connected && !!draft.trim();

  return (
    <div className="settings project-screen">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="project-head">
          {renaming ? (
            <div className="project-rename">
              <input
                className="row-rename"
                aria-label="Project name"
                autoFocus
                value={name}
                readOnly={busy === "rename"}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (composing(e)) return;
                  if (e.key === "Enter") void rename();
                  else if (e.key === "Escape") {
                    setName(project.name);
                    setRenaming(false);
                    setError(undefined);
                  }
                }}
              />
              <button className="btn" disabled={busy === "rename"} onClick={() => void rename()}>
                {busy === "rename" ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <h1 className="project-title">
              <FolderKanban size={20} /> <span>{project.name}</span>
            </h1>
          )}
          <div className="project-more" ref={moreBox}>
            <button
              ref={more}
              className="icon-btn"
              aria-label="Project settings"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Folders, defaults for new chats, rename and delete"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Ellipsis size={17} />
            </button>
            {menuOpen && (
              <div
                className="menu project-more-menu"
                role="menu"
                aria-label="Project settings"
                onKeyDown={(e) => {
                  menuArrows(e);
                  if (e.key !== "Escape") return;
                  setMenuOpen(false);
                  more.current?.focus();
                }}
              >
                <button role="menuitem" className="menu-item" autoFocus onClick={() => show("folders")}>
                  <span className="menu-icon">
                    <Folder size={13} />
                  </span>
                  Folders
                </button>
                <button role="menuitem" className="menu-item" onClick={() => show("defaults")}>
                  <span className="menu-icon">
                    <Settings2 size={13} />
                  </span>
                  Defaults for new chats
                </button>
                <button
                  role="menuitem"
                  className="menu-item"
                  disabled={!connected}
                  title={offline ?? "Rename this project, in every Hermes client"}
                  onClick={() => {
                    setMenuOpen(false);
                    setName(project.name);
                    setRenaming(true);
                  }}
                >
                  <span className="menu-icon">
                    <Pencil size={13} />
                  </span>
                  Rename
                </button>
                <button role="menuitem" className="menu-item danger" onClick={() => show("delete")}>
                  <span className="menu-icon">
                    <Trash2 size={13} />
                  </span>
                  Delete project
                </button>
              </div>
            )}
          </div>
        </div>
        {error && (
          <p className="sign-in-error small" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          A project in the <span className="mono">{profile}</span> profile. Hermes keeps the project and its folders, so other Hermes clients
          show them too.
        </p>

        <div className="project-settings" ref={panel} hidden={!open} role="region" aria-label="Project settings">
          <button className="icon-btn project-settings-close" aria-label="Close project settings" title="Close" onClick={closeSection}>
            <X size={15} />
          </button>
          {open?.section === "folders" && (
            <section data-section="folders">
              <h2 tabIndex={-1}>Folders</h2>
              <p className="muted">
                Folders on the server this project is about. Hermes Chat adds only folders that are already there, and taking one out of the
                project leaves it on the server. The first is the main folder: new chats start in it, and the project's context files are kept in
                its <span className="mono">context</span> folder.
              </p>
              {project.folders.length ? (
                <ul className="folder-list">
                  {project.folders.map((f) => (
                    <li key={f.path} className="folder-row">
                      {facts[f.path]?.worktrees.length ? <FolderGit2 size={16} className="folder-icon" /> : <Folder size={16} className="folder-icon" />}
                      <div className="folder-main">
                        <div className="folder-name">
                          {baseName(f.path)}
                          {f.primary && <span className="badge">Main folder</span>}
                        </div>
                        <div className="folder-where">
                          <span className="mono folder-conn" title="The connection this folder is on">
                            {connection ?? "Not connected"}
                          </span>
                          <span className="mono folder-path" title="The folder's path on the server">
                            {f.path}
                          </span>
                        </div>
                        <GitNote path={f.path} facts={facts[f.path]} />
                      </div>
                      <button
                        className="btn"
                        disabled={!connected || !!busy}
                        title={offline ?? "Take this folder out of the project. It stays on the server."}
                        aria-label={`Remove ${f.path} from the project`}
                        onClick={() => void run(`remove ${f.path}`, () => onRemoveFolder(f.path), setFolderError)}
                      >
                        <X size={14} /> Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-hint">No folders yet.</div>
              )}
              <div className="folder-add">
                <label className="field">
                  <span className="field-label">Add a folder on the server</span>
                  <input
                    placeholder="/home/you/code/project"
                    value={path}
                    disabled={!connected}
                    spellCheck={false}
                    onChange={(e) => setPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !composing(e) && path.trim() && void addFolder(path)}
                  />
                </label>
                <button className="btn" disabled={!connected || !path.trim() || !!busy} title={offline} onClick={() => void addFolder(path)}>
                  <Plus size={14} /> {busy === `add ${path}` ? "Checking…" : "Add folder"}
                </button>
              </div>
              {folderError && (
                <div className="field-hint err" role="alert">
                  {folderError}
                </div>
              )}
              {others.size > 0 && (
                <div className="worktrees">
                  <h3>Other worktrees of these repositories</h3>
                  <p className="muted small">These worktrees are already on the server. Adding one puts it in the project; nothing is created.</p>
                  <ul className="folder-list">
                    {[...others.values()].map((t) => (
                      <li key={t.path} className="folder-row">
                        <GitBranch size={15} className="folder-icon" />
                        <div className="folder-main">
                          <div className="folder-name">{t.detached ? "detached HEAD" : (t.branch ?? "no branch")}</div>
                          <div className="folder-where">
                            <span className="mono folder-conn">{connection}</span>
                            <span className="mono folder-path">{t.path}</span>
                          </div>
                        </div>
                        <button className="btn" disabled={!connected || !!busy} aria-label={`Add the worktree ${t.path}`} onClick={() => void addFolder(t.path)}>
                          <Plus size={14} /> Add
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          <div data-section="defaults" hidden={open?.section !== "defaults"}>
            <DefaultsSection {...defaults} folders={project.folders} profile={profile} connection={connection} />
          </div>

          {open?.section === "delete" && (
            <section data-section="delete">
              <h2 tabIndex={-1}>Delete project</h2>
              <div className="settings-row">
                <p className="muted">
                  Deletes the project in every Hermes client. Its chats stay in Hermes, and its folders stay on the server, context files included.
                </p>
                {!confirmDelete ? (
                  <button className="btn" disabled={!connected} title={offline} onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={14} /> Delete project
                  </button>
                ) : (
                  <div className="confirm" onKeyDown={(e) => e.key === "Escape" && setConfirmDelete(false)}>
                    <span>
                      Delete {project.name}? {chats.length + unlisted ? `Its ${chatsText(chats.length + unlisted)} stay in Hermes and in the list.` : ""} Nothing on
                      the server is deleted but the project.
                    </span>
                    <div className="confirm-actions">
                      <button className="btn" autoFocus onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </button>
                      <button className="btn danger" disabled={busy === "delete"} onClick={() => void run("delete", onDelete)}>
                        {busy === "delete" ? "Deleting…" : "Delete project"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="project-columns">
          <div className="project-main">
            <form
              className="project-composer"
              onSubmit={(e) => {
                e.preventDefault();
                if (canStart) onStartChat();
              }}
            >
              <textarea
                aria-label={`Message to start a new chat in ${project.name}`}
                placeholder={`Start a new chat in ${project.name}`}
                rows={3}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey || composing(e)) return;
                  e.preventDefault();
                  if (canStart) onStartChat();
                }}
              />
              <div className="project-composer-foot">
                <span className="muted small">A chat started here is in this project, and gets its instructions and context files.</span>
                <button className="btn primary" type="submit" disabled={!canStart} title={connected ? undefined : "Connect to Hermes to start a chat."}>
                  <ArrowUp size={14} /> Start chat
                </button>
              </div>
            </form>

            <section className="project-chats" aria-labelledby="project-chats-title">
              <h2 id="project-chats-title">Chats</h2>
              {chats.length > 0 && (
                <ul className="project-chat-list">
                  {chats.map((c) => (
                    <li key={c.id}>
                      <button className="project-chat" onClick={() => onOpenChat(c.id)}>
                        <span className="row-title">{c.title}</span>
                        {c.unread && <span className="dot" aria-label="Unread" />}
                        {c.updatedAt !== undefined && (
                          <span className="muted small">
                            <Age at={c.updatedAt} />
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">
                {chats.length ? `${chatsText(chats.length)} in the list.` : "No chats in the list yet."} Put a chat in this project from its right-click
                menu; a chat started while the list shows this project is put in it too. Deleting the project takes its chats out of it, and keeps
                them.
                {unlisted > 0 &&
                  ` ${chatsText(unlisted)} in this project ${unlisted === 1 ? "isn't" : "aren't"} in the list: older than a month, or archived or deleted. Pull older history in Settings, or open the archived chats, to see them.`}
              </p>
              {membership}
            </section>
          </div>

          <aside className="project-side" aria-label="Instructions and context">
            <section className="project-card" aria-labelledby="project-instructions-title">
              <div className="project-card-head">
                <h2 id="project-instructions-title">Instructions</h2>
                <span className="project-card-actions">
                  <button className="icon-btn" aria-label="Edit instructions" title="Edit the instructions new chats in this project start with" onClick={() => show("defaults", "instructions")}>
                    <Pencil size={14} />
                  </button>
                </span>
              </div>
              {instructions ? <p className="project-instructions">{instructions}</p> : <p className="muted small">None yet. Add some to tell every new chat in this project how to work.</p>}
              <p className="muted small">Kept on this computer, and sent once as a hidden message when a chat starts.</p>
            </section>
            {context}
          </aside>
        </div>
      </div>
    </div>
  );
}

type DefaultsProps = {
  /** As kept now; undefined when none were ever saved. */
  saved?: ProjectDefaults;
  folders: ProjectFolder[];
  profile: string;
  connection?: string;
  catalog?: ModelCatalog;
  /** The profile's own model and effort, which a new chat runs on when the project sets none. */
  profilePick?: ModelPick;
  profileEffort?: Effort;
  favorites: string[];
  onToggleFavorite: (key: string) => void;
  /** Checks and keeps the defaults over revision `base`; rejects with `DefaultsConflict` if another save landed. */
  onSave: (base: number, draft: DefaultsDraft) => Promise<ProjectDefaults>;
};

const blank = (d?: ProjectDefaults): DefaultsDraft => cleanDraft({ instructions: d?.instructions, model: d?.model, folder: d?.folder });

/**
 * The project's defaults for new chats: instructions, a model and its reasoning effort, and a folder on the server. Each
 * left empty comes from the profile. Edits wait for Save; Cancel puts back what is kept. Saving over a save made
 * elsewhere meanwhile is refused, and the owner chooses which to keep.
 */
function DefaultsSection({ saved, folders, profile, connection, catalog, profilePick, profileEffort, favorites, onToggleFavorite, onSave }: DefaultsProps) {
  // `shown`: the kept defaults the form started from, and their revision; `draft`: the owner's edits over them.
  const [shown, setShown] = useState(() => ({ rev: saved?.rev ?? 0, draft: blank(saved) }));
  const [draft, setDraft] = useState<DefaultsDraft>(shown.draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<ProjectDefaults | null>();
  const [done, setDone] = useState(false);
  const unsaved = !sameDraft(draft, shown.draft);
  const tooLong = draftProblem(draft);

  const load = (d?: ProjectDefaults) => {
    const next = { rev: d?.rev ?? 0, draft: blank(d) };
    setShown(next);
    setDraft(next.draft);
    setConflict(undefined);
    setError(undefined);
  };
  // A save made elsewhere shows at once, unless the owner is editing; then their Save meets it as a conflict.
  useEffect(() => {
    if (!unsaved && (saved?.rev ?? 0) !== shown.rev) load(saved);
  }, [saved?.rev]);

  const edit = (patch: Partial<DefaultsDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDone(false);
    setError(undefined);
  };
  const save = async (over = shown.rev) => {
    setSaving(true);
    setError(undefined);
    try {
      load(await onSave(over, draft));
      setDone(true);
    } catch (e) {
      if (e instanceof DefaultsConflict) setConflict(e.saved ?? null);
      else setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const newer = error === new NewerDefaultsError().message;
  const model = draft.model;
  const folderKnown = !draft.folder || folders.some((f) => f.path === draft.folder);
  const where = (
    <span className="defaults-where">
      on <span className="mono">{connection ?? "no connection"}</span>, profile <span className="mono">{profile}</span>
    </span>
  );

  return (
    <section className="project-defaults" aria-labelledby="project-defaults-title">
      <h2 id="project-defaults-title" tabIndex={-1}>
        Defaults for new chats
      </h2>
      <p className="muted">
        New chats started while the list shows this project use these. Anything left empty comes from the profile, and a model picked for one
        chat beats the project's. Changing them doesn't change chats that have started. They're kept on this computer only: Hermes has no
        place for them, so other computers and Hermes clients don't use them.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="defaults-instructions">
          Instructions
        </label>
        <textarea
          id="defaults-instructions"
          aria-describedby="defaults-instructions-hint"
          aria-invalid={!!tooLong || undefined}
          aria-errormessage={tooLong ? "defaults-instructions-error" : undefined}
          className="defaults-instructions"
          readOnly={saving}
          rows={5}
          value={draft.instructions ?? ""}
          placeholder="None. Chats follow the profile's own prompt."
          spellCheck
          onChange={(e) => edit({ instructions: e.target.value })}
        />
        <span className="field-hint block" id="defaults-instructions-hint">
          Sent once, as a hidden message before your first one, when a chat starts. The model reads it as part of the chat, not as its
          system prompt, and no Hermes client shows it.
        </span>
        {tooLong && (
          <span className="field-hint err" id="defaults-instructions-error" role="alert">
            {tooLong}
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label" id="defaults-model-label">
          Model and reasoning effort
        </span>
        {/* Edits made while a save is under way would be replaced by what it saved, so nothing changes meanwhile. */}
        <div className="defaults-model" role="group" aria-labelledby="defaults-model-label" inert={saving || undefined}>
          <ModelControls
            catalog={catalog}
            current={model ?? profilePick}
            defaultEffort={profileEffort}
            favorites={favorites}
            onPick={(pick) => edit({ model: pick })}
            onToggleFavorite={onToggleFavorite}
          />
          {model ? (
            <button className="btn" onClick={() => edit({ model: undefined })}>
              Use the profile's
            </button>
          ) : (
            <span className="field-hint">
              Profile default{profilePick ? `: ${shortName(profilePick.model)}` : ""}
              {profileEffort ? `, ${EFFORT_LABEL[profileEffort]}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="defaults-folder">
          Working folder on the server
        </label>
        <select id="defaults-folder" disabled={saving} aria-describedby="defaults-folder-hint" className="defaults-folder" value={draft.folder ?? ""} onChange={(e) => edit({ folder: e.target.value || undefined })}>
          <option value="">The profile's (Hermes's default folder)</option>
          {folders.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
          {!folderKnown && <option value={draft.folder}>{draft.folder} (not in this project any more)</option>}
        </select>
        <span className="field-hint block" id="defaults-folder-hint">
          {draft.folder ? (
            <>
              <span className="mono">{draft.folder}</span> {where}. Checked on the server before each chat starts; a chat starts only if Hermes
              runs it there.
            </>
          ) : folders.length ? (
            <>Chats run in the profile's folder {where}.</>
          ) : (
            <>Add a folder above to start this project's chats in it.</>
          )}
        </span>
      </div>

      {conflict !== undefined && (
        <div className="confirm defaults-conflict" role="alert">
          <span className="confirm-msg">{new DefaultsConflict(undefined).message} Your edits are still here.</span>
          <span>
            Saved there: {conflict ? describe(conflict) : "no defaults"}.
          </span>
          <div className="confirm-actions">
            <button className="btn" onClick={() => load(saved)}>
              Use the saved ones
            </button>
            <button className="btn primary" disabled={saving || !!tooLong} onClick={() => void save(conflict?.rev ?? 0)}>
              Save mine over them
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="field-hint err" role="alert">
          {error}
        </div>
      )}
      <div className="defaults-actions">
        <span className="field-hint" aria-live="polite">
          {saving ? "Saving…" : unsaved ? "Unsaved changes" : done ? "Saved. New chats in this project use these." : ""}
        </span>
        <button className="btn" disabled={!unsaved || saving} onClick={() => load(saved)}>
          Cancel
        </button>
        <button className="btn primary" disabled={!unsaved || saving || newer || !!tooLong || conflict !== undefined} onClick={() => void save()}>
          {saving ? "Saving…" : "Save defaults"}
        </button>
      </div>
    </section>
  );
}

/** Saved defaults in a line. */
function describe(d: ProjectDefaults): string {
  const parts = [
    d.instructions && "instructions",
    d.model && `${shortName(d.model.model)}${d.model.effort ? ` (${EFFORT_LABEL[d.model.effort]})` : ""}`,
    d.folder,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "none, everything from the profile";
}
