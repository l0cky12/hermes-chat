// The Repository screen's Worktrees view (ADR 0043): the repository's worktrees on the server, with what each holds
// and which chats work in it; New worktree, with a preview of exactly what will be made and a setup run once; and
// Remove, with a preview of what it touches, which keeps every change first. Everything runs on the server through the
// screen's helper (worktrees.ts).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert, FolderGit2, GitBranch, Lock, MessageSquarePlus, Plus, RefreshCw, RotateCcw, Shield, ShieldOff, Trash2, Unlink, X } from "lucide-react";
import { RepoFailure, asRepoFailure, lostAnswer } from "../hermes/repo";
import {
  STATE_LABEL,
  asCreated,
  asRemovalPlan,
  asRemoved,
  asWorktreeList,
  asWorktreePlan,
  canRetrySetup,
  canStartIn,
  dirtyText,
  inside,
  newWorktreeId,
  plural,
  worktreeChats,
  type AttachedChat,
  type HermesChatIn,
  type Kept,
  type Progress,
  type RemovalPlan,
  type Removed,
  type Worktree,
  type WorktreeApi,
  type WorktreeList,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeRequest,
} from "../hermes/worktrees";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { Failure } from "./Repository";

type Load<T> = { state: "idle" } | { state: "loading"; last?: T } | { state: "ready"; data: T } | { state: "failed"; error: RepoFailure; last?: T };
const lastOf = <T,>(l: Load<T>): T | undefined => (l.state === "ready" ? l.data : l.state === "idle" ? undefined : l.last);

/** What the screen around the view gives it: who is looking, and how to start a chat or ask Hermes about one. */
export type WorktreeHooks = {
  /** The connection and profile shown, as the record names them. */
  profile: string;
  connection: string;
  /** A chat's title, when it is one of the shown profile's chats on the shown connection. */
  chatTitle(chat: string): string | undefined;
  /** The chats Hermes has working in `path` (any client), in each profile it can list; rejects when Hermes can't be
   * asked. Absent while Hermes isn't connected. */
  hermesChatsIn?: (path: string) => Promise<HermesChatIn[]>;
  /** Opens the New chat pane set to start in this worktree. Absent while Hermes isn't connected. */
  onStartChat?: (w: { target: string; repo: string; id: string; path: string; branch: string }) => void;
};

export function WorktreesPanel({ api, target, top, hooks, onOpen }: { api: WorktreeApi; target: string; top: string; hooks: WorktreeHooks; onOpen: (path: string) => void }) {
  const [list, setList] = useState<Load<WorktreeList>>({ state: "idle" });
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const [creating, setCreating] = useState<{ base?: string; branch?: string } | null>(null);
  const [removing, setRemoving] = useState<WorktreeRecord | null>(null);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ what: string; error: RepoFailure }>();
  const [done, setDone] = useState<string>();
  const [detaching, setDetaching] = useState<{ id: string; chat: AttachedChat }>();
  const newButton = useRef<HTMLButtonElement>(null);

  const read = useCallback(() => {
    const n = ++run.current;
    setList((l) => ({ state: "loading", last: lastOf(l) }));
    api.run(target, { op: "worktreeList", repo: top }).then(
      (v) => {
        if (n !== run.current || !alive.current) return;
        try {
          setList({ state: "ready", data: asWorktreeList(v) });
        } catch (e) {
          setList({ state: "failed", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => n === run.current && alive.current && setList((l) => ({ state: "failed", error: asRepoFailure(e), last: lastOf(l) })),
    );
  }, [api, target, top]);
  useEffect(read, [read]);

  /** One change to a worktree's record, then the list read again whatever happened. */
  const act = async (what: string, request: WorktreeRequest, after?: string) => {
    if (busy) return;
    setBusy(what);
    setError(undefined);
    setDone(undefined);
    try {
      const v = await api.run(target, request);
      if (!alive.current) return;
      if (after) setDone(after);
      return v;
    } catch (e) {
      if (alive.current) setError({ what: what.replace(/…$/, ""), error: asRepoFailure(e) });
    } finally {
      if (alive.current) {
        setBusy(undefined);
        read();
      }
    }
  };

  const shown = lastOf(list);
  const loading = list.state === "loading";
  const failure = list.state === "failed" ? list.error : undefined;
  const others = shown?.worktrees.filter((w) => !w.main) ?? [];

  return (
    <section className="wt" aria-label="Worktrees" aria-busy={loading}>
      <div className="wt-head">
        <h2>
          Worktrees {shown && <span className="count">{shown.worktrees.length}</span>}
        </h2>
        <span className="muted small">
          Separate working folders of {shown?.main ?? top}, on the server. Each has its own branch; chats started in one work only there.
        </span>
        <div className="wt-head-actions">
          <button className="icon-btn" aria-label="Read the worktrees again" title="Read the worktrees again" disabled={loading} onClick={read}>
            <RefreshCw size={16} className={loading ? "spin" : undefined} />
          </button>
          <button ref={newButton} className="btn primary" disabled={!shown || !!busy} onClick={() => setCreating({})}>
            <Plus size={14} aria-hidden /> New worktree…
          </button>
        </div>
      </div>

      {failure?.kind === "unsupported" ? (
        <div className="files-banner warn" role="status">
          <CircleAlert size={14} aria-hidden />
          <span>
            Worktrees aren't supported on this server: {failure.message} The rest of the Repository screen still works.
          </span>
        </div>
      ) : (
        failure && <Failure failure={failure} what="Couldn't read the worktrees" onDismiss={shown ? () => setList({ state: "ready", data: shown }) : undefined} />
      )}
      {error && <Failure failure={error.error} what={`${error.what} didn't happen`} onDismiss={() => setError(undefined)} />}
      {busy && (
        <div className="files-banner" role="status">
          <Spinner /> <span>{busy}</span>
        </div>
      )}
      {done && !busy && (
        <div className="files-banner ok" role="status">
          <Check size={14} aria-hidden /> <span>{done}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setDone(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {!shown && loading && (
        <p className="muted wt-empty">
          <Spinner /> Reading the worktrees…
        </p>
      )}

      {shown && (
        <>
          {others.length === 0 && <p className="muted wt-empty">No other worktrees yet. New worktree… makes one beside the repository, on its own branch.</p>}
          <ul className="wt-list" data-stale={loading || undefined}>
            {shown.worktrees.map((w, i) => (
              <li key={w.path}>
                <WorktreeRow
                  w={w}
                  detailed={i < shown.detailLimit}
                  hooks={hooks}
                  busy={!!busy}
                  current={inside(top, w.path) && (w.main ? !shown.worktrees.some((o) => !o.main && inside(top, o.path)) : true)}
                  onOpen={() => onOpen(w.path)}
                  onStart={hooks.onStartChat && w.managed ? () => startHere(w) : undefined}
                  onRetry={() =>
                    w.managed &&
                    void (async () => {
                      if (busy) return;
                      setBusy(`Running setup again in ${w.path}…`);
                      setError(undefined);
                      try {
                        const request: WorktreeRequest = { op: "worktreeSetup", repo: top, id: w.managed!.id };
                        const v = await (api.stream ? api.stream(target, request, () => undefined) : api.run(target, request));
                        const rec = (v as { worktree: WorktreeRecord }).worktree;
                        if (alive.current) setDone(rec.state === "ready" ? `Setup finished in ${w.path}.` : `Setup failed again in ${w.path}. Its log is below.`);
                      } catch (e) {
                        if (alive.current) setError({ what: "Running setup again", error: asRepoFailure(e) });
                      } finally {
                        if (alive.current) {
                          setBusy(undefined);
                          read();
                        }
                      }
                    })()
                  }
                  onProtect={(on) =>
                    w.managed &&
                    void act(`${on ? "Protecting" : "Unprotecting"} ${w.path}…`, { op: "worktreeProtect", repo: top, id: w.managed.id, protected: on }, on ? `${w.path} is protected: it can't be removed.` : `${w.path} isn't protected any more.`)
                  }
                  onRemove={() => w.managed && setRemoving(w.managed)}
                  onDetach={(chat) => w.managed && setDetaching({ id: w.managed.id, chat })}
                />
                {detaching && detaching.id === w.managed?.id && (
                  <div className="wt-confirm" role="group" aria-label="Detach the chat">
                    <p>
                      Detach {chatName(detaching.chat, hooks)}? The chat keeps working in {w.path}; detaching only means this worktree no longer counts it, so it could be removed.
                    </p>
                    <div className="confirm-actions">
                      <button className="btn" autoFocus onClick={() => setDetaching(undefined)}>
                        Cancel
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => {
                          const { id, chat } = detaching;
                          setDetaching(undefined);
                          void act(`Detaching ${chatName(chat, hooks)}…`, { op: "worktreeDetach", repo: top, id, token: chat.token }, `Detached ${chatName(chat, hooks)}.`).then(
                            (v) => v && worktreeChats.forgetToken(chat.token),
                          );
                        }}
                      >
                        Detach
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {shown.worktrees.length > shown.detailLimit && (
            <p className="muted small">Only the first {shown.detailLimit} worktrees are read in detail; open one to see its changes.</p>
          )}

          {shown.missing.length > 0 && (
            <section className="wt-section" aria-label="Recorded, but not on disk">
              <h3>Recorded, but not on disk</h3>
              <ul className="wt-list">
                {shown.missing.map((r) => (
                  <li key={r.id} className="wt-row">
                    <div className="wt-row-main">
                      <span className="mono wt-path">{r.path}</span>
                      <span className="wt-badges">
                        <span className={`badge ${r.running ? "" : "warn"}`}>{STATE_LABEL[r.state] ?? r.state}</span>
                      </span>
                    </div>
                    <p className="muted small">
                      {r.state === "create-interrupted"
                        ? `Making it on ${r.branch} was cut off before Git made it${r.exists ? ", but something is at that path now" : ""}.`
                        : `Git no longer lists it${r.exists ? ", but something is at that path" : ", and its folder is gone"}.`}{" "}
                      {r.exists
                        ? "Look at what is left there (in Server files or the Terminal), move anything you need, and delete the folder; then Forget it drops this app's record."
                        : "Forgetting it drops this app's record only; nothing on disk changes."}
                    </p>
                    <div className="wt-actions">
                      <button
                        className="btn"
                        disabled={!!busy || r.running || !!r.exists || r.chats.length > 0}
                        title={r.chats.length ? "Detach its chats first" : r.exists ? "Something is at its path" : undefined}
                        onClick={() => void act(`Forgetting ${r.path}…`, { op: "worktreeForget", repo: top, id: r.id }, `Forgot ${r.path}.`)}
                      >
                        Forget it
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shown.kept.length > 0 && (
            <section className="wt-section" aria-label="Changes kept from removed worktrees">
              <h3>Changes kept from removed worktrees</h3>
              <p className="muted small">Each is a commit under refs/hermes-chat/kept/ in the repository. Nothing here deletes them.</p>
              <ul className="wt-list">
                {shown.kept.map((k) => (
                  <li key={k.ref} className="wt-row">
                    <div className="wt-row-main">
                      <span className="mono wt-path">{k.path ?? k.ref}</span>
                      {k.branch && (
                        <span className="wt-branch">
                          <GitBranch size={13} aria-hidden /> <span className="mono">{k.branch}</span>
                        </span>
                      )}
                    </div>
                    <p className="muted small">
                      <span className="mono">{k.ref}</span> at <span className="mono">{k.commit.slice(0, 12)}</span>
                      {k.files ? `, ${plural(k.files, "file")} that ${k.files === 1 ? "wasn't" : "weren't"} committed` : ""}
                      {k.at ? `, kept ${new Date(k.at * 1000).toLocaleString()}` : ""}.
                    </p>
                    <div className="wt-actions">
                      <button className="btn" disabled={!!busy} onClick={() => setCreating({ base: k.ref, branch: restoredName(k) })}>
                        <RotateCcw size={13} aria-hidden /> Restore in a new worktree…
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {creating && shown && (
        <CreateDialog
          api={api}
          target={target}
          top={top}
          initial={creating}
          onStartChat={hooks.onStartChat}
          onOpen={onOpen}
          onChanged={read}
          onClose={() => setCreating(null)}
        />
      )}
      {removing && (
        <RemoveDialog
          api={api}
          target={target}
          top={top}
          record={removing}
          hooks={hooks}
          onRemoved={(r) => {
            setDone(
              `Removed ${r.removed}.${r.branch ? ` The branch ${r.branch} is kept${r.unpublished ? `, with ${plural(r.unpublished, "commit")} no remote has` : ""}.` : ""}${r.kept ? ` Its changes are kept in ${r.kept.ref}.` : ""}`,
            );
          }}
          onClose={() => {
            setRemoving(null);
            read();
          }}
        />
      )}
    </section>
  );

  function startHere(w: Worktree) {
    if (!hooks.onStartChat || !w.managed) return;
    hooks.onStartChat({ target, repo: top, id: w.managed.id, path: w.path, branch: w.branch ?? "(detached)" });
  }
}

const restoredName = (k: Kept) => `${(k.branch ?? "kept").replace(/-restored(-\d+)?$/, "")}-restored`;

function chatName(c: AttachedChat, hooks: WorktreeHooks): string {
  const mine = c.profile === hooks.profile && c.connection === hooks.connection;
  const title = mine && c.chat ? hooks.chatTitle(c.chat) : undefined;
  if (title) return `"${title}"`;
  const where = mine ? "" : ` in the ${c.profile} profile${c.connection === hooks.connection ? "" : ` on ${c.connection}`}`;
  return c.chat ? `the chat ${c.chat}${where}` : `a chat being started${where}`;
}

function WorktreeRow({
  w,
  detailed,
  hooks,
  busy,
  current,
  onOpen,
  onStart,
  onRetry,
  onProtect,
  onRemove,
  onDetach,
}: {
  w: Worktree;
  detailed: boolean;
  hooks: WorktreeHooks;
  busy: boolean;
  current: boolean;
  onOpen: () => void;
  onStart?: () => void;
  onRetry: () => void;
  onProtect: (on: boolean) => void;
  onRemove: () => void;
  onDetach: (chat: AttachedChat) => void;
}) {
  const m = w.managed;
  const dirty = dirtyText(w.dirty);
  const blockers = w.protected.filter((p) => p.kind !== "marked");
  const removable = !!m && !w.main && blockers.length === 0 && !m.protected && !m.running && m.chats.length === 0;
  const removeWhy = !m
    ? undefined
    : m.protected
      ? "It's protected"
      : m.chats.length
        ? "Chats work in it: detach them first"
        : m.running
          ? "Hermes Chat is still working on it"
          : blockers[0]?.message;
  const startable = canStartIn(w) && !!onStart && (!m || m.state !== "setup");
  return (
    <div className={`wt-row ${current ? "current" : ""}`}>
      <div className="wt-row-main">
        <FolderGit2 size={15} aria-hidden className="wt-icon" />
        <span className="mono wt-path" title={w.path}>
          {w.path}
        </span>
        <span className="wt-branch">
          <GitBranch size={13} aria-hidden /> <span className="mono">{w.branch ?? (w.detached ? `detached at ${w.head?.slice(0, 7)}` : w.bare ? "bare" : "?")}</span>
        </span>
        <span className="wt-badges">
          {w.main && <span className="badge">Main checkout</span>}
          {current && <span className="badge">Open here</span>}
          {m ? <span className="badge">Made here</span> : !w.main && <span className="badge muted">Not made by Hermes Chat</span>}
          {m && m.state !== "ready" && <span className={`badge ${m.running ? "" : "warn"}`}>{STATE_LABEL[m.state] ?? m.state}</span>}
          {m?.protected && (
            <span className="badge">
              <Shield size={11} aria-hidden /> Protected
            </span>
          )}
          {w.protected.some((p) => p.kind === "locked") && (
            <span className="badge warn" title={w.protected.find((p) => p.kind === "locked")?.message}>
              <Lock size={11} aria-hidden /> Locked by another tool
            </span>
          )}
          {w.prunable !== null && <span className="badge warn">Git can't find its folder</span>}
        </span>
      </div>
      <p className="wt-facts small">
        {!w.exists ? (
          <span className="err">The folder isn't there.</span>
        ) : !detailed || !w.dirty ? (
          <span className="muted">{w.error ?? "Not read in detail."}</span>
        ) : (
          <>
            <span>{dirty ?? "No changes"}</span>
            <span>
              {w.unpublished ? `${plural(w.unpublished, "commit")} no remote has` : "Every commit is on a remote"}
              {w.lost ? `, ${plural(w.lost, "commit")} on no branch` : ""}
            </span>
            {w.upstream && (
              <span className="muted">
                Tracks {w.upstream}
                {w.ahead || w.behind ? ` (${w.ahead ?? 0} ahead, ${w.behind ?? 0} behind, as of the last fetch)` : ""}
              </span>
            )}
            {!!w.submodules && <span className="muted">{plural(w.submodules, "submodule")} checked out</span>}
          </>
        )}
      </p>
      {m && m.chats.length > 0 && (
        <ul className="wt-chats" aria-label={`Chats working in ${w.path}`}>
          {m.chats.map((c) => (
            <li key={c.token}>
              <span>
                {chatName(c, hooks)}
                {c.state === "starting" && <span className="muted"> (starting; not confirmed)</span>}
              </span>
              <button className="btn small" disabled={busy} aria-label={`Detach ${chatName(c, hooks)} from ${w.path}`} onClick={() => onDetach(c)}>
                <Unlink size={12} aria-hidden /> Detach…
              </button>
            </li>
          ))}
        </ul>
      )}
      {m && m.setup.state !== "skipped" && m.setup.state !== "pending" && (
        <details className="wt-setup" open={m.state === "setup-failed" || m.state === "setup-interrupted"}>
          <summary>
            Setup: {m.setup.state === "done" ? "done" : m.setup.state === "failed" ? "failed" : m.state === "setup-interrupted" ? "cut off" : "running"}
          </summary>
          <pre className="repo-output mono">{m.setup.log || "No log yet."}</pre>
        </details>
      )}
      {m?.state === "create-interrupted" && (
        <p className="files-banner warn small" role="status">
          <CircleAlert size={13} aria-hidden />
          <span>
            {w.locked === "initializing"
              ? "Making this worktree was cut off while Git was checking out its files. Remove it (its files are kept first) and make it again."
              : "Making this worktree was cut off after Git made it. Retry finishes it."}
          </span>
        </p>
      )}
      <div className="wt-actions">
        {w.exists && !current && (
          <button className="btn" disabled={busy} onClick={onOpen}>
            Open
          </button>
        )}
        {onStart && (
          <button className="btn" disabled={busy || !startable} title={startable ? undefined : "Not while it's being made, set up or removed"} onClick={onStart}>
            <MessageSquarePlus size={13} aria-hidden /> Start a chat here
          </button>
        )}
        {w.exists && canRetrySetup(w) && (
          <button className="btn" disabled={busy} onClick={onRetry}>
            <RotateCcw size={13} aria-hidden /> Retry {m?.state === "create-interrupted" ? "" : "setup"}
          </button>
        )}
        {m && (
          <button className="btn" disabled={busy} aria-pressed={m.protected} onClick={() => onProtect(!m.protected)}>
            {m.protected ? <ShieldOff size={13} aria-hidden /> : <Shield size={13} aria-hidden />} {m.protected ? "Unprotect" : "Protect"}
          </button>
        )}
        {m && !w.main && (
          <button className="btn danger" disabled={busy || !removable} title={removable ? undefined : removeWhy} aria-label={`Remove ${w.path}…`} onClick={onRemove}>
            <Trash2 size={13} aria-hidden /> Remove…
          </button>
        )}
      </div>
      {m && !removable && removeWhy && <p className="muted small wt-why">Can't be removed: {removeWhy}.</p>}
      {!m && !w.main && <p className="muted small wt-why">Hermes Chat didn't make this worktree, so it lists it but never removes it.</p>}
    </div>
  );
}

// ── New worktree ────────────────────────────────────────────────────────────

type CreateState =
  | { phase: "editing"; plan?: WorktreePlan; planning?: boolean; error?: RepoFailure }
  | { phase: "creating"; plan: WorktreePlan; id: string; log: Progress[] }
  | { phase: "created"; plan: WorktreePlan; record: WorktreeRecord; log: Progress[]; output?: string; error?: RepoFailure }
  | { phase: "lost"; plan: WorktreePlan; id: string; log: Progress[]; error: RepoFailure; found?: WorktreeRecord | null; askError?: string }
  | { phase: "refused"; plan: WorktreePlan; error: RepoFailure; log: Progress[] };

function CreateDialog({
  api,
  target,
  top,
  initial,
  onStartChat,
  onOpen,
  onChanged,
  onClose,
}: {
  api: WorktreeApi;
  target: string;
  top: string;
  initial: { base?: string; branch?: string };
  onStartChat?: WorktreeHooks["onStartChat"];
  onOpen: (path: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [base, setBase] = useState(initial.base ?? "HEAD");
  const [branch, setBranch] = useState(initial.branch ?? "");
  const [path, setPath] = useState("");
  const [setup, setSetup] = useState(true);
  const [state, setState] = useState<CreateState>({ phase: "editing" });
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const id = useId();
  const alive = useRef(true);
  const asked = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const doneButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.phase === "created" || state.phase === "lost" || state.phase === "refused") doneButton.current?.focus();
  }, [state.phase]);

  // Any change to the form makes the preview old: it must be read again before anything is made.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    asked.current++;
    set(v);
    setState({ phase: "editing" });
  };

  const preview = () => {
    const n = ++asked.current;
    setState({ phase: "editing", planning: true });
    api.run(target, { op: "worktreePlan", repo: top, base: mode === "new" ? base : "", branch, newBranch: mode === "new", path, setup }).then(
      (v) => {
        if (n !== asked.current || !alive.current) return;
        try {
          setState({ phase: "editing", plan: asWorktreePlan(v) });
        } catch (e) {
          setState({ phase: "editing", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => n === asked.current && alive.current && setState({ phase: "editing", error: asRepoFailure(e) }),
    );
  };

  const create = (plan: WorktreePlan) => {
    const rid = newWorktreeId();
    const log: Progress[] = [];
    setState({ phase: "creating", plan, id: rid, log });
    const request: WorktreeRequest = {
      op: "worktreeCreate",
      repo: top,
      id: rid,
      base: plan.base,
      branch: plan.branch,
      newBranch: plan.newBranch,
      path: plan.path,
      setup: setup && plan.setup.length > 0,
      expect: plan.stamp,
    };
    const onProgress = (p: Progress) => {
      if (!alive.current) return;
      log.push(p);
      setState((s) => (s.phase === "creating" && s.id === rid ? { ...s, log: [...log] } : s));
    };
    (api.stream ? api.stream(target, request, onProgress) : api.run(target, request)).then(
      (v) => {
        if (!alive.current) return;
        onChanged();
        try {
          const made = asCreated(v);
          setState({ phase: "created", plan, record: made.worktree, log: [...log], output: made.output });
        } catch (e) {
          setState({ phase: "lost", plan, id: rid, log: [...log], error: asRepoFailure(e) });
        }
      },
      (e: unknown) => {
        if (!alive.current) return;
        const error = asRepoFailure(e);
        onChanged();
        if (!lostAnswer(error)) return setState({ phase: "refused", plan, error, log: [...log] });
        // The answer was lost: whether it was made isn't known. Ask the record, which says how far it got.
        setState({ phase: "lost", plan, id: rid, log: [...log], error });
        api.run(target, { op: "worktreeList", repo: top }).then(
          (l) => {
            if (!alive.current) return;
            const list = asWorktreeList(l);
            const found = list.worktrees.find((w) => w.managed?.id === rid)?.managed ?? list.missing.find((r) => r.id === rid) ?? null;
            setState((s) => (s.phase === "lost" && s.id === rid ? { ...s, found } : s));
          },
          (e2: unknown) => alive.current && setState((s) => (s.phase === "lost" && s.id === rid ? { ...s, askError: asRepoFailure(e2).message } : s)),
        );
      },
    );
  };

  const working = state.phase === "creating" || (state.phase === "editing" && state.planning);
  const close = () => !working && onClose();
  const plan = state.phase === "editing" ? state.plan : state.plan;
  const finished = state.phase === "created" ? state.record : state.phase === "lost" && state.found ? state.found : undefined;

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={working}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <FolderGit2 size={15} aria-hidden /> {state.phase === "created" ? "Worktree made" : "New worktree"}
        </h2>
        {state.phase === "editing" && (
          <form
            className="wt-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (state.plan) create(state.plan);
              else preview();
            }}
          >
            <fieldset className="wt-mode">
              <legend>Branch</legend>
              <label>
                <input type="radio" name={`${id}-mode`} checked={mode === "new"} onChange={() => edit(setMode)("new")} /> New branch
              </label>
              <label>
                <input type="radio" name={`${id}-mode`} checked={mode === "existing"} onChange={() => edit(setMode)("existing")} /> Existing local branch
              </label>
            </fieldset>
            <label htmlFor={`${id}-branch`}>{mode === "new" ? "New branch name" : "Branch to check out"}</label>
            <input id={`${id}-branch`} className="mono" autoFocus value={branch} placeholder={mode === "new" ? "feature/login" : "release"} onChange={(e) => edit(setBranch)(e.target.value)} />
            {mode === "new" && (
              <>
                <label htmlFor={`${id}-base`}>Base: the commit it starts from</label>
                <input id={`${id}-base`} className="mono" value={base} placeholder="main, origin/main, a tag or a commit" onChange={(e) => edit(setBase)(e.target.value)} />
                <span className="field-hint">A branch, tag or commit already in the repository. Nothing is fetched.</span>
              </>
            )}
            <label htmlFor={`${id}-path`}>Folder on the server</label>
            <input id={`${id}-path`} className="mono" value={path} placeholder="Beside the repository, named after the branch" onChange={(e) => edit(setPath)(e.target.value)} />
            <label className="wt-check">
              <input type="checkbox" checked={setup} onChange={(e) => edit(setSetup)(e.target.checked)} /> Run setup once after it's made (the files .worktreeinclude names)
            </label>
            {state.error && <Failure failure={state.error} what="Can't make it" />}
            {state.plan && <PlanFacts plan={state.plan} setup={setup} />}
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={close} disabled={state.planning}>
                Cancel
              </button>
              {state.plan ? (
                <button className="btn primary">Create worktree</button>
              ) : (
                <button className="btn primary" disabled={!branch.trim() || (mode === "new" && !base.trim()) || state.planning}>
                  {state.planning ? (
                    <>
                      <Spinner /> Checking…
                    </>
                  ) : (
                    "Preview"
                  )}
                </button>
              )}
            </div>
          </form>
        )}
        {state.phase !== "editing" && plan && <PlanFacts plan={plan} setup={setup} compact />}
        {"log" in state && state.log.length > 0 && (
          <ol className="wt-log mono" role="log" aria-live="polite" aria-label="Progress">
            {state.log.map((l, i) => (
              <li key={i}>{l.message}</li>
            ))}
          </ol>
        )}
        {state.phase === "creating" && (
          <p role="status" className="repo-review-status">
            <Spinner /> {state.log.at(-1)?.step === "setup" ? "Running setup…" : "Making the worktree…"}
          </p>
        )}
        {state.phase === "refused" && <Failure failure={state.error} what="It wasn't made" />}
        {state.phase === "lost" && (
          <p className="files-banner warn" role="alert">
            <CircleAlert size={14} aria-hidden />{" "}
            <span>
              The connection dropped before the server answered ({state.error.message}).{" "}
              {state.askError
                ? `Reading the worktrees failed too (${state.askError}). Refresh the list once the server is back: a worktree made part way shows there, with Retry.`
                : state.found === undefined
                  ? "Reading the worktrees to see how far it got…"
                  : state.found === null
                    ? "The server has no record of it: nothing was made."
                    : `The server has it: ${STATE_LABEL[state.found.state] ?? state.found.state}.${state.found.state === "ready" ? "" : " It's in the list, with what you can do next."}`}
            </span>
          </p>
        )}
        {finished && (
          <>
            <p className={`files-banner ${finished.state === "ready" ? "ok" : "warn"}`} role="status">
              {finished.state === "ready" ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}{" "}
              <span>
                {finished.state === "ready"
                  ? `Made ${finished.path} on ${finished.branch}${finished.setup.state === "done" ? ", and setup ran" : ""}.`
                  : finished.state === "setup-failed"
                    ? `Made ${finished.path} on ${finished.branch}, but setup failed. The worktree is kept: retry setup from the list, or start a chat in it anyway.`
                    : `${finished.path}: ${STATE_LABEL[finished.state] ?? finished.state}.`}
              </span>
            </p>
            {/* The progress log above already says what setup did; the record's log is for an answer that came without it. */}
            {finished.setup.log && finished.state !== "ready" && !("log" in state && state.log.length) && <pre className="repo-output mono">{finished.setup.log}</pre>}
          </>
        )}
        {state.phase !== "editing" && (
          <div className="confirm-actions">
            {finished && finished.state !== "create-interrupted" && finished.state !== "creating" && (
              <>
                <button
                  className="btn"
                  disabled={working}
                  onClick={() => {
                    onClose();
                    onOpen(finished.path);
                  }}
                >
                  Open
                </button>
                {onStartChat && (
                  <button
                    className="btn"
                    disabled={working}
                    onClick={() => {
                      onClose();
                      onStartChat({ target, repo: top, id: finished.id, path: finished.path, branch: finished.branch });
                    }}
                  >
                    <MessageSquarePlus size={13} aria-hidden /> Start a chat in it
                  </button>
                )}
              </>
            )}
            {state.phase === "refused" && (
              <button className="btn" onClick={() => setState({ phase: "editing" })}>
                Change it
              </button>
            )}
            <button ref={doneButton} className="btn primary" disabled={working} onClick={close}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PlanFacts({ plan, setup, compact }: { plan: WorktreePlan; setup: boolean; compact?: boolean }) {
  const dirty = dirtyText(plan.sourceDirty);
  const runs = setup && plan.setup.length > 0;
  return (
    <div className="wt-plan" aria-label="What will be made">
      <dl className="repo-review-facts">
        <dt>Folder</dt>
        <dd className="mono">{plan.path}</dd>
        <dt>Branch</dt>
        <dd>
          <span className="mono">{plan.branch}</span> {plan.newBranch ? "(new, tracking nothing)" : "(existing)"}
        </dd>
        <dt>From</dt>
        <dd>
          <span className="mono">{plan.baseRef ?? plan.base}</span> at <span className="mono">{plan.baseOid.slice(0, 12)}</span> <span className="muted">{plan.baseSubject}</span>
        </dd>
        {!compact && (
          <>
            <dt>Setup</dt>
            <dd>{runs ? `${plural(plan.setup.length, "entry", "entries")} from ${plan.source}/.worktreeinclude, once` : plan.setup.length ? "Not run" : "Nothing to set up: no .worktreeinclude"}</dd>
          </>
        )}
      </dl>
      {!compact && (
        <>
          {dirty && (
            <p className="files-banner small" role="note">
              <CircleAlert size={13} aria-hidden />
              <span>
                {plan.source} has changes ({dirty}). They stay there: the new worktree starts from {plan.baseOid.slice(0, 12)} without them.
              </span>
            </p>
          )}
          {plan.submodules.length > 0 && (
            <p className="files-banner small" role="note">
              <CircleAlert size={13} aria-hidden />
              <span>
                The base has {plural(plan.submodules.length, "submodule")} ({plan.submodules.slice(0, 5).join(", ")}). Git doesn't check them out in a new worktree; run
                git submodule update --init there if a chat needs them.
              </span>
            </p>
          )}
          {runs && (
            <ul className="wt-setup-plan">
              {plan.setup.map((e) => (
                <li key={e.entry}>
                  <span className="mono">{e.entry}</span>{" "}
                  <span className="muted">
                    {e.action === "copy" ? `copied (${e.size ?? 0} bytes)` : e.action === "link" ? `linked to ${e.target}` : `skipped: ${e.reason}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Setup commands (an install script) aren't run: Hermes has no supported way to declare them. Ask Hermes in the chat, or run them in the Terminal.
          </p>
        </>
      )}
    </div>
  );
}

// ── Remove ──────────────────────────────────────────────────────────────────

type RemoveState =
  | { phase: "reading" }
  | { phase: "ready"; plan: RemovalPlan; error?: RepoFailure }
  | { phase: "removing"; plan: RemovalPlan; log: Progress[] }
  | { phase: "removed"; result: Removed }
  | { phase: "failed"; error: RepoFailure; plan?: RemovalPlan };

function RemoveDialog({
  api,
  target,
  top,
  record,
  hooks,
  onRemoved,
  onClose,
}: {
  api: WorktreeApi;
  target: string;
  top: string;
  record: WorktreeRecord;
  hooks: WorktreeHooks;
  onRemoved: (r: Removed) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<RemoveState>({ phase: "reading" });
  const [hermes, setHermes] = useState<{ state: "reading" | "ready" | "failed" | "unavailable"; chats: HermesChatIn[]; error?: string }>({ state: hooks.hermesChatsIn ? "reading" : "unavailable", chats: [] });
  const [ack, setAck] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const alive = useRef(true);
  const read = useRef(0);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  // Hermes is asked through a ref: the app around the dialog draws again whenever a chat streams, and that must not
  // read the preview again, clear the owner's tick, or (during a removal) take the dialog out of `removing`.
  const chatsIn = useRef(hooks.hermesChatsIn);
  chatsIn.current = hooks.hermesChatsIn;
  const asked = useRef(0);
  const askHermes = useCallback(() => {
    const n = ++asked.current;
    setAck(false);
    const ask = chatsIn.current;
    if (!ask) return setHermes({ state: "unavailable", chats: [] });
    setHermes({ state: "reading", chats: [] });
    ask(record.path).then(
      (chats) => n === asked.current && alive.current && setHermes({ state: "ready", chats }),
      (e: unknown) => n === asked.current && alive.current && setHermes({ state: "failed", chats: [], error: e instanceof Error ? e.message : String(e) }),
    );
  }, [record.path]);
  const load = useCallback(() => {
    const n = ++read.current;
    setState({ phase: "reading" });
    api.run(target, { op: "worktreeRemovePlan", repo: top, id: record.id }).then(
      (v) => {
        if (n !== read.current || !alive.current) return;
        try {
          setState({ phase: "ready", plan: asRemovalPlan(v) });
        } catch (e) {
          setState({ phase: "failed", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => n === read.current && alive.current && setState({ phase: "failed", error: asRepoFailure(e) }),
    );
    askHermes();
  }, [api, target, top, record.id, askHermes]);
  useEffect(load, [load]);
  // Hermes connecting or going away makes the last answer about its chats an old one: ask again (or say it can't be
  // asked), and the owner's tick goes with it.
  const available = !!hooks.hermesChatsIn;
  const seenAvailable = useRef(available);
  useEffect(() => {
    if (seenAvailable.current === available) return;
    seenAvailable.current = available;
    askHermes();
  }, [available, askHermes]);
  useEffect(() => {
    if (state.phase !== "reading" && state.phase !== "removing") primary.current?.focus();
  }, [state.phase]);

  const remove = (plan: RemovalPlan) => {
    const log: Progress[] = [];
    setState({ phase: "removing", plan, log });
    const request: WorktreeRequest = { op: "worktreeRemove", repo: top, id: record.id, expect: plan.stamp };
    const onProgress = (p: Progress) => {
      if (!alive.current) return;
      log.push(p);
      setState((s) => (s.phase === "removing" ? { ...s, log: [...log] } : s));
    };
    (api.stream ? api.stream(target, request, onProgress) : api.run(target, request)).then(
      (v) => {
        if (!alive.current) return;
        try {
          const result = asRemoved(v);
          setState({ phase: "removed", result });
          onRemoved(result);
        } catch (e) {
          setState({ phase: "failed", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => alive.current && setState({ phase: "ready", plan, error: asRepoFailure(e) }),
    );
  };

  const busy = state.phase === "removing";
  const close = () => !busy && onClose();
  const plan = state.phase === "ready" || state.phase === "removing" ? state.plan : state.phase === "failed" ? state.plan : undefined;
  const active = hermes.chats.filter((c) => c.active);
  const quiet = hermes.chats.filter((c) => !c.active);
  const stale = state.phase === "ready" && state.error?.kind === "stale";
  const blocked = !plan || plan.blockers.length > 0 || active.length > 0 || hermes.state === "reading";
  const needsAck = quiet.length > 0 || hermes.state === "failed" || hermes.state === "unavailable";

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || state.phase === "reading"}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <Trash2 size={15} aria-hidden /> {state.phase === "removed" ? "Worktree removed" : `Remove ${record.path}`}
        </h2>
        {state.phase === "reading" && (
          <p role="status" className="repo-review-status">
            <Spinner /> Reading what removing it would touch…
          </p>
        )}
        {state.phase === "failed" && <Failure failure={state.error} what="Couldn't check it" />}
        {plan && state.phase !== "removed" && (
          <>
            <dl className="repo-review-facts">
              <dt>Folder</dt>
              <dd className="mono">{plan.path}</dd>
              <dt>Branch</dt>
              <dd>
                {plan.branch ? (
                  <>
                    <span className="mono">{plan.branch}</span> is kept: branches are never deleted here.
                  </>
                ) : (
                  `Detached at ${plan.head?.slice(0, 12)}`
                )}
              </dd>
              <dt>Kept first</dt>
              <dd>
                {plan.keep
                  ? `${plan.fileCount ? `${plural(plan.fileCount, "changed or untracked file")}` : ""}${plan.fileCount && plan.lost ? " and " : ""}${plan.lost ? `${plural(plan.lost, "commit")} no branch has` : ""}, as a commit under refs/hermes-chat/kept/, restorable from the list.`
                  : "Nothing: there are no changes only this folder holds."}
              </dd>
            </dl>
            {plan.blockers.length > 0 && (
              <div className="files-banner err" role="alert">
                <CircleAlert size={14} aria-hidden />
                <div>
                  <span>It can't be removed:</span>
                  <ul>
                    {plan.blockers.map((b, i) => (
                      <li key={i}>{b.message}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {plan.files.length > 0 && (
              <section aria-label="Files that will be kept">
                <h3 className="small">Changed and untracked files ({plan.fileCount})</h3>
                <ul className="wt-files mono">
                  {plan.files.slice(0, 200).map((f) => (
                    <li key={f.path}>
                      <span className="muted">{f.kind === "untracked" ? "??" : f.xy.replace(/\./g, " ")}</span> {f.from ? `${f.from} → ` : ""}
                      {f.path}
                      {f.hidden && <span className="muted"> (changed, though marked assume-unchanged or skip-worktree)</span>}
                    </li>
                  ))}
                </ul>
                {plan.fileCount > 200 && <p className="muted small">and {plan.fileCount - 200} more.</p>}
              </section>
            )}
            {plan.unpublishedCount > 0 && (
              <section aria-label="Commits no remote has">
                <h3 className="small">
                  {plural(plan.unpublishedCount, "commit")} no remote has{plan.branch ? `: they stay on ${plan.branch}` : ""}
                </h3>
                <ul className="repo-commits">
                  {plan.unpublished.slice(0, 10).map((c) => (
                    <li key={c.sha}>
                      <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.subject}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.ignored.length > 0 && (
              <p className="files-banner warn small" role="note">
                <CircleAlert size={13} aria-hidden />
                <span>
                  Ignored files go with the folder and aren't kept: {plan.ignored.slice(0, 8).join(", ")}
                  {plan.ignored.length > 8 ? `, and ${plan.ignored.length - 8} more` : ""}.
                  {plan.ignoredUnchecked && " There are too many to check one by one: a change to them after this preview isn't noticed."}
                </span>
              </p>
            )}
            {hermes.state === "reading" && (
              <p role="status" className="muted small">
                <Spinner /> Asking Hermes which chats work in this folder…
              </p>
            )}
            {active.length > 0 && (
              <div className="files-banner err" role="alert">
                <CircleAlert size={14} aria-hidden />
                <span>Hermes is working in it now, in {active.map((c) => `"${c.title}" (${c.profile})`).join(", ")}. Wait for it to finish.</span>
              </div>
            )}
            {quiet.length > 0 && (
              <div className="files-banner warn" role="note">
                <CircleAlert size={14} aria-hidden />
                <div>
                  <span>Hermes has chats whose folder is in it. A quiet chat may still be needed; it would lose its folder:</span>
                  <ul>
                    {quiet.slice(0, 10).map((c) => (
                      <li key={`${c.profile}/${c.id}`}>
                        "{c.title}" ({c.profile}) <span className="mono muted">{c.cwd}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {(hermes.state === "failed" || hermes.state === "unavailable") && (
              <p className="files-banner warn small" role="note">
                <CircleAlert size={13} aria-hidden />
                <span>
                  {hermes.state === "failed" ? `Hermes couldn't be asked which chats work in this folder (${hermes.error}).` : "Hermes isn't connected, so it couldn't be asked which chats work in this folder."} Chats
                  started from other apps aren't checked.
                </span>
              </p>
            )}
            {needsAck && !blocked && (
              <label className="wt-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I've checked these chats: none of them needs this folder.
              </label>
            )}
            {state.phase === "ready" && state.error && <Failure failure={state.error} what="It wasn't removed" />}
          </>
        )}
        {state.phase === "removing" && (
          <>
            {state.log.length > 0 && (
              <ol className="wt-log mono" role="log" aria-label="Progress">
                {state.log.map((l, i) => (
                  <li key={i}>{l.message}</li>
                ))}
              </ol>
            )}
            <p role="status" className="repo-review-status">
              <Spinner /> {state.plan.keep ? "Keeping its changes, then removing it…" : "Removing it…"}
            </p>
          </>
        )}
        {state.phase === "removed" && (
          <p className="files-banner ok" role="status">
            <Check size={14} aria-hidden />{" "}
            <span>
              Removed {state.result.removed}.
              {state.result.branch ? ` The branch ${state.result.branch} is kept${state.result.unpublished ? `, with ${plural(state.result.unpublished, "commit")} no remote has` : ""}.` : ""}
              {state.result.kept ? ` Its changes are in ${state.result.kept.ref} (${state.result.kept.commit.slice(0, 12)}).` : ""}
            </span>
          </p>
        )}
        <div className="confirm-actions">
          {state.phase === "removed" ? (
            <button ref={primary} className="btn primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button ref={blocked || stale ? primary : undefined} className="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              {(stale || state.phase === "failed") && (
                <button className="btn" onClick={load} disabled={busy}>
                  <RefreshCw size={13} aria-hidden /> Check again
                </button>
              )}
              {!stale && state.phase !== "failed" && (
                <button
                  ref={blocked ? undefined : primary}
                  className="btn danger"
                  disabled={busy || blocked || state.phase !== "ready" || (needsAck && !ack)}
                  onClick={() => plan && remove(plan)}
                >
                  {plan?.keep ? "Keep changes and remove" : "Remove"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
