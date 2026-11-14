// The Repository screen: a Git checkout on the Hermes server, reviewed from here (ADR 0110). It reads through the
// owner's own ssh, not through the dashboard, so it works while Hermes is away too. It covers the chat panes, as
// Server files does.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUpFromLine, Check, CircleAlert, CircleCheck, CircleDashed, CircleX, ExternalLink, GitPullRequest, FileWarning, FolderGit2, GitBranch, GitCommitHorizontal, GitMerge, Minus, Pencil, Plus, RefreshCw, Server, Sparkles, X } from "lucide-react";
import {
  CONTEXT_CHOICES,
  OPERATION_LABEL,
  SUGGEST_INSTRUCTIONS,
  asCommitted,
  asDiff,
  asPreview,
  asRepoFailure,
  asStatus,
  branchLabel,
  cleanSuggestion,
  commitMessage,
  diffStale,
  expectOf,
  failureHint,
  group,
  hunksSupported,
  parseDiff,
  previewRows,
  splitPatch,
  subjectNote,
  suggestInput,
  upstreamLabel,
  type Change,
  type Committed,
  type DiffReply,
  type ParsedDiff,
  type Preview,
  type RepoApi,
  RepoFailure,
  type RepoRequest,
  type Status,
  asPublishInfo,
  checksOf,
  checksSummary,
  prDraft,
  pushedHere,
  reviewLabel,
  stateLabel,
  type Check as PrCheck,
  type PrCreated,
  type PrStatus,
  type PrSummary,
  type PublishInfo,
  type Pushed,
  actionable,
  lostAnswer,
} from "../hermes/repo";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { WorktreesPanel, type WorktreeHooks } from "./Worktrees";
import { clockTimeWithSeconds, errorText, formatBytes } from "../hermes/values";

type Load<T> = { state: "idle" } | { state: "loading"; last?: T } | { state: "ready"; data: T } | { state: "failed"; error: RepoFailure; last?: T };

const lastOf = <T,>(l: Load<T>): T | undefined => (l.state === "ready" ? l.data : l.state === "idle" ? undefined : l.last);

const SECTIONS: { key: "conflicts" | "staged" | "unstaged" | "untracked"; title: string; empty?: string }[] = [
  { key: "conflicts", title: "Conflicts" },
  { key: "staged", title: "Staged", empty: "Nothing staged." },
  { key: "unstaged", title: "Changed, not staged", empty: "No changes in tracked files." },
  { key: "untracked", title: "Untracked" },
];

/** With no app around it (as in tests): no chats to name, start or ask about. */
const NO_HOOKS: WorktreeHooks = { profile: "", connection: "", chatTitle: () => undefined };

export function RepositoryScreen({
  api,
  initialTarget,
  initialPath,
  recent,
  suggestions,
  onOpened,
  onTarget,
  suggest,
  suggestScope = "",
  openUrl,
  worktrees = NO_HOOKS,
  initialView = "changes",
  onClose,
}: {
  api: RepoApi;
  /** The SSH target to read through. Empty asks for one. */
  initialTarget: string;
  /** The folder opened last, opened again at once. */
  initialPath: string;
  /** Folders opened lately, newest first. */
  recent: string[];
  /** Folders worth offering, such as the shown project's. */
  suggestions: { label: string; path: string }[];
  /** A folder opened: the checkout's top, to open next time. */
  onOpened: (top: string) => void;
  /** A target the owner set. */
  onTarget: (target: string) => void;
  /** Asks Hermes for a commit message from `input` (llm.oneshot); absent while Hermes isn't connected. */
  suggest?: (instructions: string, input: string) => Promise<string>;
  /** Who `suggest` asks: the connection and profile. A suggestion asked under one never fills the box under another:
   * the ask stops before Hermes is called, and a late answer or failure is dropped. */
  suggestScope?: string;
  /** Opens a pull request's or a check's page in the owner's browser. */
  openUrl?: (url: string) => void;
  /** What the Worktrees view needs from the app (ADR 0043). */
  worktrees?: WorktreeHooks;
  /** Which view the screen opens on. */
  initialView?: "changes" | "worktrees";
  onClose: () => void;
}) {
  const [view, setView] = useState<"changes" | "worktrees">(initialView);
  const [target, setTarget] = useState(initialTarget);
  const [editingTarget, setEditingTarget] = useState(!initialTarget);
  const [targetDraft, setTargetDraft] = useState(initialTarget);
  const [pathDraft, setPathDraft] = useState(initialPath);
  const [repo, setRepo] = useState(initialTarget && initialPath ? initialPath : "");
  const [status, setStatus] = useState<Load<Status>>({ state: "idle" });
  const [selected, setSelected] = useState<string>();
  const [context, setContext] = useState(3);
  const [diff, setDiff] = useState<Load<DiffReply>>({ state: "idle" });
  /** Changes ticked for Stage or Unstage, by key. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  /** A write running now, in words; every write button waits for it. */
  const [writing, setWriting] = useState<string>();
  const [writeError, setWriteError] = useState<{ what: string; error: RepoFailure }>();
  const [done, setDone] = useState<string>();
  const [message, setMessage] = useState("");
  const scopeNow = useRef(suggestScope);
  scopeNow.current = suggestScope;
  const [reviewing, setReviewing] = useState(false);
  const statusRun = useRef(0);
  const diffRun = useRef(0);
  /** Bumped when the folder or target changes, so a write's late answer can't touch the one shown now. */
  const place = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pathId = useId();

  const shown = lastOf(status);
  const groups = useMemo(() => (shown ? group(shown) : undefined), [shown]);
  const all = useMemo(() => (groups ? [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked] : []), [groups]);
  const change = all.find((c) => c.key === selected);

  const read = useCallback(
    (where: string, via: string) => {
      if (!where.trim() || !via.trim()) return;
      const run = ++statusRun.current;
      setStatus((s) => ({ state: "loading", last: lastOf(s) }));
      api.run(via, { op: "status", repo: where.trim() }).then(
        (v) => {
          if (run !== statusRun.current) return;
          try {
            const s = asStatus(v);
            setStatus({ state: "ready", data: s });
            onOpened(s.top);
          } catch (e) {
            setStatus({ state: "failed", error: asRepoFailure(e) });
          }
        },
        (e: unknown) => {
          if (run !== statusRun.current) return;
          setStatus((s) => ({ state: "failed", error: asRepoFailure(e), last: lastOf(s) }));
        },
      );
    },
    [api, onOpened],
  );

  useEffect(() => {
    if (repo && target) read(repo, target);
  }, [repo, target, read]);

  const forget = () => {
    place.current++;
    setChecked(new Set());
    setWriteError(undefined);
    setDone(undefined);
    setWriting(undefined);
    setReviewing(false);
  };

  /**
   * Runs one write, then reads the repository again whatever happened: the list afterwards is Git's, not a guess.
   * A late answer for another folder or target is dropped. Resolves true when the screen still shows the folder and
   * target the write was for, so a caller's follow-up (clearing ticks) can't touch another folder's state.
   */
  const write = async (what: string, request: RepoRequest, after?: string): Promise<boolean> => {
    if (writing) return false;
    const at = place.current;
    setWriting(what);
    setWriteError(undefined);
    setDone(undefined);
    try {
      await api.run(target, request);
      if (at === place.current && after) setDone(after);
    } catch (e) {
      if (at === place.current) setWriteError({ what: what.replace(/…$/, ""), error: asRepoFailure(e) });
    } finally {
      if (at === place.current) {
        setWriting(undefined);
        read(repo, target);
      }
    }
    return at === place.current;
  };

  // A different folder or target: what was shown belonged to the other one.
  const open = (where: string) => {
    if (!where.trim()) return;
    forget();
    statusRun.current++;
    diffRun.current++;
    setStatus({ state: "idle" });
    setSelected(undefined);
    setDiff({ state: "idle" });
    if (where.trim() === repo) read(repo, target);
    else setRepo(where.trim());
  };

  // The selected change's diff, read again whenever the status is, or the context changes.
  const top = shown?.top;
  useEffect(() => {
    if (!change || !top) {
      diffRun.current++;
      setDiff({ state: "idle" });
      return;
    }
    if (status.state === "loading") return;
    const run = ++diffRun.current;
    setDiff((d) => ({ state: "loading", last: lastOf(d) }));
    api
      .run(target, { op: "diff", repo: top, path: change.path, ...(change.origPath && { origPath: change.origPath }), side: change.side, context })
      .then(
        (v) => {
          if (run !== diffRun.current) return;
          try {
            setDiff({ state: "ready", data: asDiff(v) });
          } catch (e) {
            setDiff({ state: "failed", error: asRepoFailure(e) });
          }
        },
        (e: unknown) => run === diffRun.current && setDiff({ state: "failed", error: asRepoFailure(e) }),
      );
    // `status` is a dependency through `shown`: a refresh reads the diff again.
  }, [api, target, top, change?.key, change?.origPath, context, shown, status.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change that's gone after a refresh can't stay selected, or ticked.
  useEffect(() => {
    if (selected && groups && !change) setSelected(undefined);
    setChecked((c) => {
      const keep = [...c].filter((k) => all.some((x) => x.key === k));
      return keep.length === c.size ? c : new Set(keep);
    });
  }, [selected, groups, change, all]);

  const entryOf = (path: string) => shown?.entries.find((e) => e.path === path);
  const tick = (key: string, on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  /** Stages these changes (from Changed or Untracked), each as the list read it. */
  const stage = (picked: Change[]) => {
    const changes = picked.filter(actionable);
    if (!shown || !changes.length) return;
    const files = changes.map((c) => ({ path: c.path, worktree: entryOf(c.path)?.worktree ?? null }));
    const n = files.length;
    void write(`Staging ${n === 1 ? files[0].path : `${n} files`}…`, { op: "stage", repo: shown.top, files, expect: expectOf(shown) }, `Staged ${n === 1 ? files[0].path : `${n} files`}.`).then(
      (here) => here && setChecked(new Set()),
    );
  };

  /** Takes these staged changes out of the index; a rename takes its old path back too. */
  const unstage = (picked: Change[]) => {
    const changes = picked.filter(actionable);
    if (!shown || !changes.length) return;
    const paths = changes.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path]));
    const n = changes.length;
    void write(`Unstaging ${n === 1 ? changes[0].path : `${n} files`}…`, { op: "unstage", repo: shown.top, paths, expect: expectOf(shown) }, `Unstaged ${n === 1 ? changes[0].path : `${n} files`}.`).then(
      (here) => here && setChecked(new Set()),
    );
  };

  /** Stages or unstages one hunk of the diff on screen, against the stamps that diff was read with. */
  const hunk = (c: Change, d: DiffReply, i: number) => {
    if (!shown || d.head === undefined || d.index === undefined) return;
    const reverse = c.side === "staged";
    void write(
      `${reverse ? "Unstaging" : "Staging"} a hunk of ${c.path}…`,
      { op: "apply", repo: shown.top, path: c.path, hunks: [i], reverse, context, diffSha: d.sha, expect: { head: d.head, index: d.index } },
      `${reverse ? "Unstaged" : "Staged"} a hunk of ${c.path}.`,
    );
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button.repo-file") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };

  const setTargetTo = (t: string) => {
    const v = t.trim();
    if (!v) return;
    setEditingTarget(false);
    onTarget(v);
    if (v !== target) {
      forget();
      statusRun.current++;
      diffRun.current++;
      setStatus({ state: "idle" });
      setDiff({ state: "idle" });
      setSelected(undefined);
      setTarget(v);
    } else if (repo) read(repo, v);
  };

  const loading = status.state === "loading";
  const failure = status.state === "failed" ? status.error : undefined;
  const offers = [...suggestions, ...recent.filter((p) => !suggestions.some((s) => s.path === p)).map((p) => ({ label: "Recent", path: p }))].filter((o) => o.path !== shown?.top);

  return (
    <div className="files repo">
      <div className="files-head">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="files-title">
          <h1>Repository</h1>
          {target && !editingTarget && (
            <span className="files-server" title="Read through your own ssh to this target">
              <Server size={13} aria-hidden /> <span className="mono">{target}</span>
              <button className="icon-btn repo-edit-target" aria-label="Change the SSH target" title="Change the SSH target" onClick={() => setEditingTarget(true)}>
                <Pencil size={13} />
              </button>
            </span>
          )}
        </div>
        <p className="files-note muted small">
          A Git checkout on the server, read through your own ssh, so Hermes doesn't need to be connected. Reading changes nothing in the repository.
        </p>
      </div>

      {editingTarget && (
        <form
          className="repo-target"
          onSubmit={(e) => {
            e.preventDefault();
            setTargetTo(targetDraft);
          }}
        >
          <label htmlFor={`${pathId}-target`}>SSH target</label>
          <input
            spellCheck={false}
            id={`${pathId}-target`}
            className="mono"
            placeholder="liam@hermes or a host alias from ~/.ssh/config"
            value={targetDraft}
            autoFocus
            onChange={(e) => setTargetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && target) {
                e.stopPropagation();
                setTargetDraft(target);
                setEditingTarget(false);
              }
            }}
          />
          <button className="btn primary" disabled={!targetDraft.trim()}>
            Use this target
          </button>
          {target && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTargetDraft(target);
                setEditingTarget(false);
              }}
            >
              Cancel
            </button>
          )}
        </form>
      )}

      <form
        className="files-bar repo-bar"
        onSubmit={(e) => {
          e.preventDefault();
          open(pathDraft);
        }}
      >
        <label htmlFor={pathId} className="repo-path-label">
          <FolderGit2 size={15} aria-hidden /> Folder on the server
        </label>
        <input
          spellCheck={false}
          id={pathId}
          className="repo-path mono"
          placeholder="~/projects/app"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          list={`${pathId}-offers`}
        />
        <datalist id={`${pathId}-offers`}>
          {offers.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </datalist>
        <button className="btn" disabled={!pathDraft.trim() || !target}>
          Open
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Read the repository again"
          aria-label="Refresh"
          disabled={!repo || !target || loading}
          onClick={() => read(repo, target)}
        >
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </form>

      {repo && target && (
        <div className="repo-views" role="tablist" aria-label="Repository views">
          {(["changes", "worktrees"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              id={`${pathId}-tab-${v}`}
              aria-selected={view === v}
              aria-controls={`${pathId}-panel-${v}`}
              tabIndex={view === v ? 0 : -1}
              className={`repo-view ${view === v ? "on" : ""}`}
              onClick={() => setView(v)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                const next = v === "changes" ? "worktrees" : "changes";
                setView(next);
                document.getElementById(`${pathId}-tab-${next}`)?.focus();
              }}
            >
              {v === "changes" ? "Changes" : "Worktrees"}
            </button>
          ))}
        </div>
      )}

      {view === "worktrees" && repo && target && (
        <div role="tabpanel" className="repo-worktrees" id={`${pathId}-panel-worktrees`} aria-labelledby={`${pathId}-tab-worktrees`}>
          <WorktreesPanel
            key={`${target}\n${shown?.top ?? repo}`}
            api={api}
            target={target}
            top={shown?.top ?? repo}
            hooks={worktrees}
            onOpen={(path) => {
              setView("changes");
              setPathDraft(path);
              open(path);
            }}
          />
        </div>
      )}

      {view === "changes" && !repo && offers.length > 0 && (
        <div className="repo-offers">
          {offers.map((o) => (
            <button
              key={o.path}
              className="chip"
              disabled={!target}
              onClick={() => {
                setPathDraft(o.path);
                open(o.path);
              }}
            >
              <span className="muted">{o.label}</span> <span className="mono">{o.path}</span>
            </button>
          ))}
        </div>
      )}

      {view === "changes" && (
      <div role={repo && target ? "tabpanel" : undefined} id={`${pathId}-panel-changes`} aria-labelledby={repo && target ? `${pathId}-tab-changes` : undefined} className="repo-changes">
      {failure && <Failure failure={failure} what={`Couldn't read ${repo}`} onDismiss={shown ? () => setStatus({ state: "ready", data: shown }) : undefined} />}
      {writeError && <Failure failure={writeError.error} what={`${writeError.what} didn't happen`} onDismiss={() => setWriteError(undefined)} />}
      {writing && (
        <div className="files-banner repo-writing" role="status">
          <Spinner /> <span>{writing}</span>
        </div>
      )}
      {done && !writing && (
        <div className="files-banner ok" role="status">
          <Check size={14} aria-hidden />
          <span>{done}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setDone(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}

      {!shown && !failure && (
        <div className="repo-empty muted">
          {loading ? (
            <>
              <Spinner /> Reading {repo}…
            </>
          ) : !target ? (
            "Enter the SSH target of the Hermes server first."
          ) : (
            "Open a folder on the server to see its branch and changes."
          )}
        </div>
      )}

      {shown && groups && (
        <>
          <section className="repo-summary" aria-label="Repository" data-stale={loading || undefined}>
            <div className="repo-summary-row">
              <span className="mono repo-top" title="The top folder of the checkout, on the server">
                {shown.top}
              </span>
            </div>
            <div className="repo-summary-row">
              <span className="repo-branch">
                <GitBranch size={14} aria-hidden /> <span className="mono">{branchLabel(shown.branch)}</span>
              </span>
              <span className="muted small">{upstreamLabel(shown.branch)}</span>
              {shown.branch.oid && <span className="muted small mono" title="HEAD">{shown.branch.oid.slice(0, 12)}</span>}
            </div>
            {shown.operation && (
              <div className="files-banner warn" role="status">
                <GitMerge size={14} aria-hidden />
                <span>{OPERATION_LABEL[shown.operation]} Finish or abort it in the Terminal; this screen doesn't do either.</span>
              </div>
            )}
            {shown.truncated && (
              <div className="files-banner warn" role="status">
                <FileWarning size={14} aria-hidden />
                <span>More than 5,000 files changed. Only the first 5,000 are listed.</span>
              </div>
            )}
          </section>

          <div className={`repo-body ${change ? "with-diff" : ""}`}>
            <div className="repo-list" ref={listRef} onKeyDown={onListKey} aria-busy={loading} data-stale={loading || undefined}>
              {all.length === 0 && <p className="muted repo-clean">No changes: the working tree matches HEAD.</p>}
              {all.length > 0 &&
                SECTIONS.map(({ key, title, empty }) => {
                  const items = groups[key];
                  if (!items.length && !empty) return null;
                  // A tick kept across a refresh counts only while the change can still be acted on.
                  const ticked = items.filter((c) => checked.has(c.key) && actionable(c));
                  const unstaging = key === "staged";
                  return (
                    <section key={key} className="repo-section" aria-label={title}>
                      <div className="repo-section-head">
                        <h2>
                          {title} <span className="count">{items.length}</span>
                        </h2>
                        {key !== "conflicts" && items.length > 0 && (
                          <button
                            className="btn repo-section-act"
                            disabled={!ticked.length || !!writing || loading}
                            title={ticked.length ? undefined : `Tick files to ${unstaging ? "unstage" : "stage"} them`}
                            onClick={() => (unstaging ? unstage(ticked) : stage(ticked))}
                          >
                            {unstaging ? <Minus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
                            {unstaging ? "Unstage" : "Stage"} {ticked.length ? `${ticked.length} ticked` : "ticked"}
                          </button>
                        )}
                      </div>
                      {items.length === 0 ? (
                        <p className="muted small repo-none">{empty}</p>
                      ) : (
                        <ul>
                          {items.map((c) => (
                            <li key={c.key}>
                              <FileRow
                                change={c}
                                selected={c.key === selected}
                                onSelect={() => setSelected(c.key)}
                                checked={actionable(c) ? checked.has(c.key) : undefined}
                                onCheck={(on) => tick(c.key, on)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              {all.length > 0 && (
                <CommitBox
                  key={suggestScope}
                  message={message}
                  onMessage={setMessage}
                  staged={groups.staged.length}
                  conflicts={groups.conflicts.length}
                  operation={shown.operation}
                  busy={!!writing || loading}
                  suggest={
                    suggest &&
                    (async () => {
                      const asked = scopeNow.current;
                      const moved = () => new Error("the profile or connection changed while it was being asked, so it wasn't used");
                      const p = asPreview(await api.run(target, { op: "preview", repo: shown.top }));
                      // The staged diff goes only to the profile the owner asked under.
                      if (scopeNow.current !== asked) throw moved();
                      if (!p.files.length) throw new Error("Nothing is staged, so there's nothing to describe.");
                      const m = cleanSuggestion(await suggest(SUGGEST_INSTRUCTIONS, suggestInput(p)));
                      if (scopeNow.current !== asked) throw moved();
                      return m;
                    })
                  }
                  onReview={() => setReviewing(true)}
                />
              )}
              <PublishPanel
                key={`${target}\n${shown.top}`}
                api={api}
                target={target}
                top={shown.top}
                head={shown.head}
                branch={shown.branch.head}
                openUrl={openUrl}
                onPushed={() => read(repo, target)}
              />
            </div>
            {change && (
              <DiffPanel
                change={change}
                diff={diff}
                stale={diff.state === "ready" ? diffStale(shown, entryOf(change.path), diff.data) : undefined}
                busy={!!writing || loading}
                onStage={actionable(change) ? () => (change.side === "staged" ? unstage([change]) : stage([change])) : undefined}
                onHunk={(i) => diff.state === "ready" && hunk(change, diff.data, i)}
                onRefresh={() => read(repo, target)}
                context={context}
                onContext={setContext}
                onClose={() => {
                  setSelected(undefined);
                  listRef.current?.querySelector<HTMLButtonElement>("button.repo-file")?.focus();
                }}
              />
            )}
          </div>
        </>
      )}
      </div>
      )}
      {reviewing && shown && (
        <CommitDialog
          api={api}
          target={target}
          top={shown.top}
          message={message}
          onCommitted={(c) => {
            setMessage("");
            setDone(`Committed ${c.head.slice(0, 7)}${c.branch ? ` on ${c.branch}` : ""}: ${c.subject}`);
          }}
          onClose={() => {
            setReviewing(false);
            read(repo, target);
          }}
        />
      )}
    </div>
  );
}

/** The message box under the list: what to commit with, an optional suggestion from Hermes, and Review. */
function CommitBox({
  message,
  onMessage,
  staged,
  conflicts,
  operation,
  busy,
  suggest,
  onReview,
}: {
  message: string;
  onMessage: (m: string) => void;
  staged: number;
  conflicts: number;
  operation: Status["operation"];
  busy: boolean;
  suggest?: () => Promise<string>;
  onReview: () => void;
}) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string>();
  /** The message as it is now, for an answer that arrives later: it fills the box only if nothing was typed since. */
  const current = useRef(message);
  current.current = message;
  const alive = useRef(true);
  useEffect(() => {
    // Set again on every mount: StrictMode unmounts and mounts once more in development.
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const note = subjectNote(message);
  const why = operation && operation !== "bisect" ? `A ${operation} is in progress: finish or abort it in the Terminal first.` : conflicts ? "Resolve the conflicts first." : !staged ? "Stage something first." : !commitMessage(message) ? "Write a message first." : undefined;
  return (
    <section className="repo-commit" aria-label="Commit">
      <label htmlFor={id} className="repo-commit-label">
        <GitCommitHorizontal size={14} aria-hidden /> Commit message
      </label>
      <textarea id={id} className="repo-commit-message mono" rows={4} value={message} placeholder="Summary of the staged changes" onChange={(e) => onMessage(e.target.value)} />
      {note && <p className="small muted repo-commit-note">{note}</p>}
      {askError && (
        <p className="small repo-commit-error" role="alert">
          <CircleAlert size={12} aria-hidden /> Couldn't get a suggestion: {askError}
        </p>
      )}
      <div className="repo-commit-actions">
        <button
          className="btn"
          disabled={!suggest || !staged || asking || busy}
          title={suggest ? "Hermes's Text generation model reads the staged diff and suggests a message, which you can edit" : "Hermes isn't connected"}
          onClick={() => {
            if (!suggest) return;
            setAsking(true);
            setAskError(undefined);
            const asked = current.current;
            suggest().then(
              (m) => {
                if (!alive.current) return;
                if (current.current === asked) onMessage(m);
                else setAskError("you changed the message while Hermes was writing, so its suggestion wasn't used");
              },
              (e: unknown) => alive.current && setAskError(errorText(e)),
            ).finally(() => alive.current && setAsking(false));
          }}
        >
          {asking ? <Spinner /> : <Sparkles size={13} aria-hidden />} {message.trim() ? "Replace with a suggestion" : "Suggest a message"}
        </button>
        <button className="btn primary" disabled={!!why || busy} title={why} onClick={onReview}>
          Review commit…
        </button>
      </div>
    </section>
  );
}

type Review =
  | { phase: "loading" }
  | { phase: "refused"; error: RepoFailure }
  | { phase: "ready"; preview: Preview; error?: RepoFailure }
  | { phase: "committing"; preview: Preview }
  | { phase: "committed"; preview: Preview; result: Committed }
  /** No answer in time: the repository was read again to see whether HEAD moved. */
  | { phase: "unknown"; preview: Preview; moved?: boolean; head?: string | null };

/**
 * The commit preview: exactly what Commit will hold (the files, the whole staged diff, the message, who, on top of
 * which commit, and which hooks will run), then the commit itself and what Git and the hooks printed.
 */
function CommitDialog({
  api,
  target,
  top,
  message,
  onCommitted,
  onClose,
}: {
  api: RepoApi;
  target: string;
  top: string;
  message: string;
  onCommitted: (c: Committed) => void;
  onClose: () => void;
}) {
  const [review, setReview] = useState<Review>({ phase: "loading" });
  const box = useRef<HTMLDivElement>(null);
  /** The dialog's main button (Commit, Try again, Preview again or Close), focused whenever a step ends: the button
   * that had focus is disabled while Git runs, which drops focus out of the dialog. */
  const primary = useRef<HTMLButtonElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const alive = useRef(true);
  useEffect(() => {
    // Set again on every mount: StrictMode unmounts and mounts once more in development.
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  // The message as it was when the preview opened: the box behind is cleared once the commit lands.
  const [text] = useState(() => commitMessage(message));

  const load = useCallback(() => {
    setReview({ phase: "loading" });
    api.run(target, { op: "preview", repo: top }).then(
      (v) => {
        if (!alive.current) return;
        try {
          setReview({ phase: "ready", preview: asPreview(v) });
        } catch (e) {
          setReview({ phase: "refused", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => alive.current && setReview({ phase: "refused", error: asRepoFailure(e) }),
    );
  }, [api, target, top]);
  useEffect(load, [load]);
  useEffect(() => {
    if (review.phase !== "loading" && review.phase !== "committing") primary.current?.focus();
  }, [review.phase]);

  const commit = (p: Preview) => {
    /** What a failed or unreadable answer means: a refusal goes back to the preview; a lost or garbled answer (the
     * server's python killed while a hook ran, say) leaves whether Git committed unknown until HEAD is read again. */
    const failed = (error: RepoFailure) => {
      if (!lostAnswer(error)) return setReview({ phase: "ready", preview: p, error });
      setReview({ phase: "unknown", preview: p });
      api.run(target, { op: "status", repo: top }).then(
        (v) => {
          if (!alive.current) return;
          const s = asStatus(v);
          setReview({ phase: "unknown", preview: p, moved: s.head !== p.head, head: s.head });
        },
        () => undefined,
      );
    };
    setReview({ phase: "committing", preview: p });
    api.run(target, { op: "commit", repo: top, message: text, expect: { head: p.head, index: p.index, rawSha: p.rawSha, headRef: p.headRef } }).then(
      (v) => {
        if (!alive.current) return;
        let result: Committed;
        try {
          result = asCommitted(v);
        } catch (e) {
          return failed(asRepoFailure(e));
        }
        setReview({ phase: "committed", preview: p, result });
        onCommitted(result);
      },
      (e: unknown) => alive.current && failed(asRepoFailure(e)),
    );
  };

  const busy = review.phase === "loading" || review.phase === "committing";
  const close = () => !(review.phase === "committing") && onClose();
  const p = review.phase === "refused" || review.phase === "loading" ? undefined : review.preview;
  const rows = p ? previewRows(p) : [];
  const files = p ? splitPatch(p.diff) : [];
  const blocked = p && (p.unmerged ? "There are unresolved conflicts." : !p.files.length ? "Nothing is staged now." : !text ? "The message is empty." : undefined);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <GitCommitHorizontal size={15} aria-hidden /> {review.phase === "committed" ? "Committed" : `Commit${p?.branch ? ` to ${p.branch}` : ""}`}
        </h2>
        {review.phase === "loading" && (
          <p role="status" className="repo-review-status">
            <Spinner /> Reading what's staged…
          </p>
        )}
        {review.phase === "refused" && <Failure failure={review.error} what="Couldn't read what's staged" />}
        {p && (
          <div className="repo-review-body">
            <dl className="repo-review-facts">
              <dt>Repository</dt>
              <dd className="mono">{top}</dd>
              <dt>Branch</dt>
              <dd className="mono">{p.branch ?? "detached HEAD"}</dd>
              <dt>On top of</dt>
              <dd className="mono">{p.head ? p.head.slice(0, 12) : "nothing: this is the first commit"}</dd>
              <dt>Author</dt>
              <dd className="mono">{p.author ?? "unknown: Git on the server has no user.name and user.email"}</dd>
              <dt>Hooks</dt>
              <dd>
                {!p.hooks.length
                  ? "No commit hooks in this repository."
                  : review.phase === "committed"
                    ? `${p.hooks.join(", ")} ran.`
                    : `${p.hooks.join(", ")} will run, as Git runs them. Nothing skips them.`}
              </dd>
            </dl>
            {p.operation && <p className="repo-notice warn">{OPERATION_LABEL[p.operation]} This commit is part of it.</p>}
            <h3>Message</h3>
            <pre className="repo-review-message mono">{text || "(empty)"}</pre>
            <h3>
              {rows.length} {rows.length === 1 ? "file" : "files"}
            </h3>
            <ul className="repo-review-files">
              {rows.map((r) => (
                <li key={r.path}>
                  <span className={`repo-code code-${r.code}`}>{r.code}</span> <span className="mono">{r.from ? `${r.from} → ${r.path}` : r.path}</span>
                </li>
              ))}
            </ul>
            {p.truncated && <p className="repo-notice warn">The staged diff is over 2 MB, so only its start is shown. The file list above is complete.</p>}
            {p.lossy && <p className="repo-notice warn">Some of the diff isn't UTF-8, so a few characters are shown as �.</p>}
            <div className="repo-review-diff">
              {files.map((f, i) => (
                <PatchFile key={i} diff={f.diff} />
              ))}
            </div>
          </div>
        )}
        {review.phase === "ready" && review.error && (
          <Failure failure={review.error} what={review.error.kind === "hook" ? "The commit was refused" : "Nothing was committed"} />
        )}
        {review.phase === "committing" && (
          <p role="status" className="repo-review-status">
            <Spinner /> Committing{p?.hooks.length ? `; ${p.hooks.join(", ")} can take a while` : ""}…
          </p>
        )}
        {review.phase === "unknown" && (
          <div className="files-banner warn" role="alert">
            <CircleAlert size={14} aria-hidden />
            <span>
              The server didn't answer, so whether Git committed isn't known.{" "}
              {review.moved === undefined
                ? "Reading HEAD again…"
                : review.moved
                  ? `HEAD is now ${review.head?.slice(0, 12) ?? "?"}: a commit was made. Check it in the history before committing again.`
                  : "HEAD hasn't moved: nothing was committed."}
            </span>
          </div>
        )}
        {review.phase === "committed" && (
          <div className="repo-review-done">
            <p className="files-banner ok" role="status">
              <Check size={14} aria-hidden /> <span>
                Committed <span className="mono">{review.result.head.slice(0, 12)}</span>
                {review.result.branch ? <> on <span className="mono">{review.result.branch}</span></> : null}.
              </span>
            </p>
            {!!review.result.exitCode && (
              <p className="repo-notice warn">Git made the commit, then exited with an error (status {review.result.exitCode}). What it printed is below.</p>
            )}
            {!review.result.matches && (
              <div className="repo-notice warn">
                A hook changed what was committed. The commit holds:
                <ul className="repo-review-files">
                  {review.result.files.map((f) => (
                    <li key={f.path}>
                      <span className={`repo-code code-${f.status}`}>{f.status}</span> <span className="mono">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {review.phase === "committed" && review.result.output.trim() && (
          <>
            <h3>What Git and the hooks printed</h3>
            <pre className="repo-output mono">{review.result.output.trim()}</pre>
          </>
        )}
        <div className="confirm-actions">
          {review.phase === "committed" || review.phase === "unknown" ? (
            <button ref={primary} className="btn primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" onClick={close} disabled={review.phase === "committing"}>
                Cancel
              </button>
              {review.phase === "ready" && review.error?.kind === "stale" ? (
                <button ref={primary} className="btn primary" onClick={load}>
                  Preview again
                </button>
              ) : (
                <button ref={primary} className="btn primary" disabled={!p || !!blocked || busy} title={blocked} onClick={() => p && commit(p)}>
                  {review.phase === "ready" && review.error ? "Try again" : "Commit"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One file of a combined patch, drawn as the diff panel draws it. */
function PatchFile({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const title = /^diff --git a\/(.*) b\/(.*)$/m.exec(diff);
  return (
    <div className="repo-review-file">
      <div className="repo-review-file-head mono">{parsed.rename ? `${parsed.rename.from} → ${parsed.rename.to}` : (title?.[2] ?? "")}</div>
      {parsed.binary && <p className="repo-notice">Binary file.</p>}
      <DiffLines parsed={parsed} />
    </div>
  );
}

/**
 * Push and Create PR, separately (ADR 0110, stage 3). Both show where they go first: the repository, the remote and
 * its URL, the local and remote branch, the commits, and for a pull request its base. Read again whenever HEAD or
 * the branch moves, and on Refresh.
 */
function PublishPanel({
  api,
  target,
  top,
  head,
  branch,
  openUrl,
  onPushed,
}: {
  api: RepoApi;
  target: string;
  top: string;
  head: string | null;
  branch: string | null;
  openUrl?: (url: string) => void;
  /** A push dialog closed: the upstream and ahead counts above may have changed. */
  onPushed: () => void;
}) {
  const [info, setInfo] = useState<Load<PublishInfo>>({ state: "idle" });
  const [pushing, setPushing] = useState(false);
  const run = useRef(0);
  const load = useCallback(() => {
    const at = ++run.current;
    setInfo((i) => ({ state: "loading", last: lastOf(i) }));
    api.run(target, { op: "publishInfo", repo: top }).then(
      (v) => {
        if (at !== run.current) return;
        try {
          setInfo({ state: "ready", data: asPublishInfo(v) });
        } catch (e) {
          setInfo({ state: "failed", error: asRepoFailure(e) });
        }
      },
      (e: unknown) => at === run.current && setInfo((i) => ({ state: "failed", error: asRepoFailure(e), last: lastOf(i) })),
    );
  }, [api, target, top]);
  useEffect(load, [load, head, branch]);
  const p = lastOf(info);
  return (
    <section className="repo-publish" aria-label="Publish" aria-busy={info.state === "loading"}>
      <div className="repo-section-head">
        <h2 className="repo-commit-label">
          <ArrowUpFromLine size={14} aria-hidden /> Push and pull request
        </h2>
        <button className="icon-btn" title="Read the remote's branch and pull requests again" aria-label="Refresh push and pull request" disabled={info.state === "loading"} onClick={load}>
          <RefreshCw size={14} className={info.state === "loading" ? "spin" : undefined} />
        </button>
      </div>
      {info.state === "failed" && <Failure failure={info.error} what="Couldn't read where a push would go" />}
      {!p && info.state === "loading" && (
        <p className="muted small repo-review-status">
          <Spinner /> Reading the remote and pull requests…
        </p>
      )}
      {p && <PushCard info={p} onPush={() => setPushing(true)} />}
      {p && <PrCard key={`${p.remote}\n${p.remoteBranch}`} api={api} target={target} top={top} info={p} openUrl={openUrl} onChanged={load} />}
      {pushing && p && (
        <PushDialog
          api={api}
          target={target}
          top={top}
          info={p}
          onClose={() => {
            setPushing(false);
            load();
            onPushed();
          }}
        />
      )}
    </section>
  );
}

function PushCard({ info: p, onPush }: { info: PublishInfo; onPush: () => void }) {
  const many = (p.remotePushUrls?.length ?? 0) > 1;
  const why = !p.branch
    ? "HEAD is detached: check out a branch to push."
    : !p.remote
      ? "This repository has no remote to push to."
      : !p.head
        ? "There's no commit to push yet."
        : many
          ? `${p.remote} pushes to ${p.remotePushUrls!.length} places (${p.remotePushUrls!.join(", ")}). This screen pushes to one place only; use the Terminal.`
          : undefined;
  // Ahead by 0 is "nothing to push" only when the remote has the branch: a new branch made at a commit the remote
  // already has (under another name) sends no commits, but the push creates the branch, which a pull request needs.
  const newBranchOnly = !!p.remote && p.ahead === 0 && p.remoteBranchExists === false;
  const nothing = !!p.remote && p.ahead === 0 && !newBranchOnly;
  return (
    <div className="repo-card">
      <h3>Push</h3>
      {why ? (
        <p className="small muted">{why}</p>
      ) : (
        <>
          <dl className="repo-review-facts">
            <dt>Remote</dt>
            <dd className="mono">
              {p.remote} <span className="muted">{p.remoteUrl}</span>
            </dd>
            <dt>Branch</dt>
            <dd className="mono">
              {p.branch} → {p.remote}/{p.remoteBranch}
              {!p.upstream && <span className="muted"> (new upstream)</span>}
            </dd>
            {p.upstream && (p.upstream.remote !== p.remote || p.upstream.branch !== p.remoteBranch) && (
              <>
                <dt>Upstream</dt>
                <dd className="mono">
                  {p.upstream.remote}/{p.upstream.branch} <span className="muted">(not where a push goes: Git pushes a branch only to its own name)</span>
                </dd>
              </>
            )}
          </dl>
          {p.behind ? (
            <p className="repo-notice warn">
              {p.remote}/{p.remoteBranch} has {p.behind} {p.behind === 1 ? "commit" : "commits"} this branch doesn't, as of the last fetch. The push will be rejected; nothing is ever
              force-pushed.
            </p>
          ) : null}
          {p.remoteAsked && p.ahead === null && (
            <p className="repo-notice">
              {p.remote} pushes to {p.remoteUrl}, apart from where it fetches from.{" "}
              {p.remoteError ? `Asking it failed (${p.remoteError}), so` : "That destination doesn't have this commit's history here, so"} what a push sends can't be
              listed: Push sends {p.branch} at {p.head?.slice(0, 12)}.
            </p>
          )}
          {newBranchOnly && (
            <p className="small muted">
              {p.remote} has no branch {p.remoteBranch} yet, as of the last fetch, but already has every commit on it. Push creates {p.remote}/{p.remoteBranch} at{" "}
              {p.head?.slice(0, 12)} and sends no new commits.
            </p>
          )}
          {nothing ? (
            <p className="small muted">
              {p.remoteHead
                ? `Nothing to push: ${p.remote}/${p.remoteBranch} has this commit, as of the last fetch.`
                : `Nothing to push: every commit on this branch is already on ${p.remote}, as of the last fetch.`}
            </p>
          ) : (
            <ul className="repo-commits">
              {p.commits.slice(0, 10).map((c) => (
                <li key={c.sha}>
                  <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.subject}
                </li>
              ))}
              {(p.ahead ?? 0) > 10 && <li className="muted">and {(p.ahead ?? 0) - 10} more</li>}
            </ul>
          )}
          <div className="repo-commit-actions">
            <button className="btn primary" disabled={nothing} onClick={onPush}>
              <ArrowUpFromLine size={13} aria-hidden /> Push{p.ahead ? ` ${p.ahead} ${p.ahead === 1 ? "commit" : "commits"}` : ""}…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type PushState =
  | { phase: "ready"; error?: RepoFailure }
  | { phase: "pushing" }
  | { phase: "pushed"; result: Pushed }
  /** No answer: the remote is asked what it has now. `remoteHead` undefined while asking; `askError` if that failed. */
  | { phase: "unknown"; remoteHead?: string | null; askError?: string };

/** Exactly what Push sends, then the push and what the remote has afterwards. */
function PushDialog({ api, target, top, info: p, onClose }: { api: RepoApi; target: string; top: string; info: PublishInfo; onClose: () => void }) {
  const [state, setState] = useState<PushState>({ phase: "ready" });
  const box = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.phase !== "pushing") primary.current?.focus();
  }, [state.phase]);
  const keys = useModal(box);
  const titleId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const push = () => {
    if (!p.remote || !p.branch || !p.remoteBranch) return;
    setState({ phase: "pushing" });
    api.run(target, { op: "push", repo: top, remote: p.remote, pushUrl: p.remoteUrl, branch: p.branch, remoteBranch: p.remoteBranch, expect: { head: p.head } }).then(
      (v) => alive.current && setState({ phase: "pushed", result: v as Pushed }),
      (e: unknown) => {
        if (!alive.current) return;
        const error = asRepoFailure(e);
        if (!lostAnswer(error)) return setState({ phase: "ready", error });
        // Whether it was pushed isn't known: ask the remote itself, never the cached tracking ref.
        setState({ phase: "unknown" });
        api.run(target, { op: "remoteHead", repo: top, remote: p.remote!, remoteBranch: p.remoteBranch! }).then(
          (v) => alive.current && setState({ phase: "unknown", remoteHead: (v as { remoteHead: string | null }).remoteHead }),
          (e2: unknown) => alive.current && setState({ phase: "unknown", askError: asRepoFailure(e2).message }),
        );
      },
    );
  };
  const busy = state.phase === "pushing";
  const close = () => !busy && onClose();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <ArrowUpFromLine size={15} aria-hidden /> {state.phase === "pushed" ? "Pushed" : `Push to ${p.remote}/${p.remoteBranch}`}
        </h2>
        <dl className="repo-review-facts">
          <dt>Repository</dt>
          <dd className="mono">{top}</dd>
          <dt>Remote</dt>
          <dd className="mono">
            {p.remote} <span className="muted">{p.remoteUrl}</span>
          </dd>
          <dt>From</dt>
          <dd className="mono">
            {p.branch} at {p.head?.slice(0, 12)}
          </dd>
          <dt>To</dt>
          <dd className="mono">
            {p.remote}/{p.remoteBranch}
            {p.remoteHead ? <span className="muted"> (last seen at {p.remoteHead.slice(0, 12)})</span> : <span className="muted"> (new on the remote)</span>}
          </dd>
          <dt>How</dt>
          <dd>A plain push with the server's own credentials. Never forced; a pre-push hook runs as Git runs it.</dd>
        </dl>
        <ul className="repo-commits">
          {p.commits.slice(0, 20).map((c) => (
            <li key={c.sha}>
              <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.subject}
            </li>
          ))}
        </ul>
        {state.phase === "pushing" && (
          <p role="status" className="repo-review-status">
            <Spinner /> Pushing…
          </p>
        )}
        {state.phase === "ready" && state.error && <Failure failure={state.error} what="The push was refused" />}
        {state.phase === "unknown" && (
          <p className="files-banner warn" role="alert">
            <CircleAlert size={14} aria-hidden />{" "}
            <span>
              The server didn't answer, so whether the push happened wasn't known.{" "}
              {state.askError
                ? `Asking ${p.remote} failed too (${state.askError}); check it in the Terminal before pushing again.`
                : state.remoteHead === undefined
                  ? `Asking ${p.remote}…`
                  : state.remoteHead === p.head
                    ? `${p.remote} has ${p.remoteBranch} at ${p.head?.slice(0, 12)}: the push happened.`
                    : `${p.remote} has ${p.remoteBranch} at ${state.remoteHead?.slice(0, 12) ?? "nothing"}, not this commit: it wasn't pushed.`}
            </span>
          </p>
        )}
        {state.phase === "pushed" && (
          <>
            <p className={`files-banner ${state.result.matches ? "ok" : "warn"}`} role="status">
              {state.result.matches ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
              <span>
                {state.result.matches
                  ? `Pushed. ${p.remote} now has ${p.remoteBranch} at ${state.result.pushed.slice(0, 12)}.`
                  : state.result.matches === null
                    ? `Pushed (Git reported success), but checking ${p.remote} afterwards failed: ${state.result.verifyError ?? "no reason given"}.`
                    : `Git pushed, but ${p.remote} now has ${p.remoteBranch} at ${state.result.remoteHead?.slice(0, 12) ?? "nothing"}, not ${state.result.pushed.slice(0, 12)}.`}
                {state.result.upstreamSet ? ` ${p.branch} now tracks ${p.remote}/${p.remoteBranch}.` : ""}
              </span>
            </p>
            {state.result.output.trim() && <pre className="repo-output mono">{state.result.output.trim()}</pre>}
          </>
        )}
        <div className="confirm-actions">
          {state.phase === "pushed" || state.phase === "unknown" ? (
            <button ref={primary} className="btn primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button ref={primary} className="btn primary" disabled={busy} onClick={push}>
                {state.phase === "ready" && state.error ? "Try again" : "Push"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A pull request for this branch: the form to create one, or the one there is, with its status and checks. */
function PrCard({
  api,
  target,
  top,
  info: p,
  openUrl,
  onChanged,
}: {
  api: RepoApi;
  target: string;
  top: string;
  info: PublishInfo;
  openUrl?: (url: string) => void;
  onChanged: () => void;
}) {
  const draft = useMemo(() => prDraft(p), [p]);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  // The suggested title and body follow new commits until the owner writes their own. A ref, set as they type: an
  // effect from a re-read rendered just before a keystroke runs after it, and must not put the suggestion back.
  const edited = useRef(false);
  useEffect(() => {
    if (edited.current) return;
    setTitle(draft.title);
    setBody(draft.body);
  }, [draft]);
  const [base, setBase] = useState(p.github?.defaultBranch ?? p.bases[0] ?? "");
  const [isDraft, setIsDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<RepoFailure>();
  const [created, setCreated] = useState<PrCreated>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const ids = { title: useId(), body: useId(), base: useId() };
  if (!p.github) {
    return (
      <div className="repo-card">
        <h3>Pull request</h3>
        <p className="small muted">{p.remote ? `Pull requests are made with gh, for GitHub remotes only, and ${p.remote} isn't one.` : "There's no remote."}</p>
      </div>
    );
  }
  const gh = p.github;
  // A pull request made here but not read back has only its URL. The list, read again, has the whole of it.
  const createdWhole = created && typeof created.pr.number === "number" ? (created.pr as PrSummary) : undefined;
  const open = createdWhole ?? gh.prs.find((x) => x.state === "OPEN");
  const past = gh.prs.filter((x) => x.state !== "OPEN" && x.number !== open?.number);
  const create = () => {
    if (!p.remote || !p.remoteBranch) return;
    setCreating(true);
    setError(undefined);
    api
      .run(target, { op: "prCreate", repo: top, branch: p.branch ?? "", remote: p.remote, githubRepo: p.github?.repo ?? "", remoteBranch: p.remoteBranch, base, title, body, draft: isDraft, expect: { head: p.head } })
      .then(
        (v) => {
          if (!alive.current) return;
          setCreated(v as PrCreated);
          onChanged();
        },
        (e: unknown) => alive.current && setError(asRepoFailure(e)),
      )
      .finally(() => alive.current && setCreating(false));
  };
  const pushed = pushedHere(p);
  const why = !p.branch || !p.remoteBranch ? "Check out a branch first." : !pushed ? "Push this branch first: the remote doesn't have its commit, as of the last fetch." : !title.trim() ? "Write a title." : !base ? "Pick a base branch." : base === p.remoteBranch ? "The base can't be the branch itself." : undefined;
  return (
    <div className="repo-card">
      <h3>
        Pull request{" "}
        <span className="muted mono small">
          {gh.repo}
          {gh.url && openUrl && (
            <button className="icon-btn repo-link" aria-label={`Open ${gh.repo} on GitHub`} title="Open on GitHub" onClick={() => openUrl(gh.url!)}>
              <ExternalLink size={12} />
            </button>
          )}
        </span>
      </h3>
      {gh.error && <Failure failure={new RepoFailure("pr-api", "gh couldn't read this repository", gh.error)} what="GitHub" />}
      {created && !createdWhole && !open && (
        <div className="files-banner warn" role="status">
          <CircleAlert size={14} aria-hidden />
          <span>
            Created <span className="mono">{created.pr.url}</span>, but reading it back failed{created.readBackError ? `: ${created.readBackError}` : ""}. Refresh to read it from
            GitHub.
          </span>
        </div>
      )}
      {open ? (
        <>
          {created && (
            <p className="files-banner ok" role="status">
              <Check size={14} aria-hidden />
              <span>
                {created.existing ? "A pull request for this branch was already open: " : "Created "}
                <span className="mono">{created.pr.url}</span>
              </span>
            </p>
          )}
          <PrStatusView key={open.number} api={api} target={target} top={top} remote={p.remote ?? ""} pr={open} openUrl={openUrl} />
        </>
      ) : (
        !gh.error && !created && (
          <div className="repo-pr-form">
            <dl className="repo-review-facts">
              <dt>Repository</dt>
              <dd className="mono">{gh.repo}</dd>
              <dt>From</dt>
              <dd className="mono">
                {p.remote}/{p.remoteBranch}
              </dd>
            </dl>
            <label htmlFor={ids.base} className="small muted">
              Into (base)
            </label>
            <select id={ids.base} value={base} onChange={(e) => setBase(e.target.value)}>
              {!p.bases.includes(base) && base && <option value={base}>{base}</option>}
              {p.bases.filter((b) => b !== p.remoteBranch).map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === gh.defaultBranch ? " (default)" : ""}
                </option>
              ))}
            </select>
            <label htmlFor={ids.title} className="small muted">
              Title
            </label>
            <input
              id={ids.title}
              className="repo-pr-title"
              value={title}
              onChange={(e) => {
                edited.current = true;
                setTitle(e.target.value);
              }}
            />
            <label htmlFor={ids.body} className="small muted">
              Description
            </label>
            <textarea
              id={ids.body}
              className="repo-commit-message"
              rows={5}
              value={body}
              onChange={(e) => {
                edited.current = true;
                setBody(e.target.value);
              }}
            />
            <label className="repo-pr-draft small">
              <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} /> Open as a draft
            </label>
            {error && <Failure failure={error} what="No pull request was created" onDismiss={() => setError(undefined)} />}
            <div className="repo-commit-actions">
              <button className="btn primary" disabled={!!why || creating} title={why} onClick={create}>
                {creating ? <Spinner /> : <GitPullRequest size={13} aria-hidden />} Create pull request
              </button>
            </div>
            {why && <p className="small muted repo-commit-note">{why}</p>}
          </div>
        )
      )}
      {past.length > 0 && (
        <ul className="repo-commits">
          {past.map((x) => (
            <li key={x.number}>
              <span className="muted">
                #{x.number} {stateLabel(x)}:
              </span>{" "}
              {x.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** GitHub's mergeability in words. UNKNOWN means GitHub hasn't worked it out yet; Refresh asks again. */
function mergeLabel(s: PrStatus): string {
  const m = (s.mergeable ?? "UNKNOWN").toUpperCase();
  const base = m === "MERGEABLE" ? "Yes" : m === "CONFLICTING" ? "No: it conflicts with the base" : "Not worked out by GitHub yet";
  const state = (s.mergeStateStatus ?? "").toUpperCase();
  const why: Record<string, string> = { BLOCKED: "blocked by required reviews or checks", BEHIND: "behind the base", DIRTY: "conflicts", UNSTABLE: "some checks failing", DRAFT: "a draft", CLEAN: "" };
  const extra = why[state];
  return extra ? `${base} (${extra})` : base;
}

const CHECK_ICON: Record<PrCheck["state"], ReactNode> = {
  pass: <CircleCheck size={13} aria-hidden className="repo-check-pass" />,
  fail: <CircleX size={13} aria-hidden className="repo-check-fail" />,
  pending: <CircleDashed size={13} aria-hidden className="repo-check-pending" />,
  skipped: <CircleDashed size={13} aria-hidden className="muted" />,
  neutral: <CircleDashed size={13} aria-hidden className="muted" />,
};

/** A pull request's state, review, mergeability and checks, read from GitHub on open and on Refresh. */
function PrStatusView({ api, target, top, remote, pr, openUrl }: { api: RepoApi; target: string; top: string; remote: string; pr: PrSummary; openUrl?: (url: string) => void }) {
  const [status, setStatus] = useState<Load<PrStatus>>({ state: "idle" });
  const [readAt, setReadAt] = useState<Date>();
  const run = useRef(0);
  const load = useCallback(() => {
    const at = ++run.current;
    setStatus((s) => ({ state: "loading", last: lastOf(s) }));
    api.run(target, { op: "prStatus", repo: top, remote, number: pr.number }).then(
      (v) => {
        if (at !== run.current) return;
        setStatus({ state: "ready", data: v as PrStatus });
        setReadAt(new Date());
      },
      (e: unknown) => at === run.current && setStatus((s) => ({ state: "failed", error: asRepoFailure(e), last: lastOf(s) })),
    );
  }, [api, target, top, remote, pr.number]);
  useEffect(load, [load]);
  const s = lastOf(status) ?? (pr as PrStatus);
  const checks = checksOf(s);
  return (
    <div className="repo-pr-status">
      <div className="repo-pr-head">
        <GitPullRequest size={14} aria-hidden />
        <span className="repo-pr-title-text">
          #{s.number} {s.title}
        </span>
        {openUrl && (
          <button className="btn repo-pr-open" onClick={() => openUrl(s.url)}>
            <ExternalLink size={12} aria-hidden /> Open on GitHub
          </button>
        )}
        <button className="btn" onClick={load} disabled={status.state === "loading"}>
          <RefreshCw size={12} className={status.state === "loading" ? "spin" : undefined} aria-hidden /> Refresh status
        </button>
      </div>
      <p className="mono small muted repo-pr-url">{s.url}</p>
      <dl className="repo-review-facts">
        <dt>State</dt>
        <dd>{stateLabel(s)}</dd>
        <dt>Into</dt>
        <dd className="mono">
          {s.baseRefName} ← {s.headRefName}
        </dd>
        <dt>Head</dt>
        <dd className="mono">{s.headRefOid?.slice(0, 12)}</dd>
        {status.state !== "idle" && lastOf(status) && (
          <>
            <dt>Review</dt>
            <dd>{reviewLabel(s.reviewDecision)}</dd>
            <dt>Mergeable</dt>
            <dd>{mergeLabel(s)}</dd>
            <dt>Checks</dt>
            <dd>{checksSummary(checks)}</dd>
          </>
        )}
      </dl>
      {status.state === "failed" && <Failure failure={status.error} what="Couldn't read the pull request's status" />}
      {checks.length > 0 && (
        <ul className="repo-checks" aria-label="Checks">
          {checks.map((c, i) => (
            <li key={i}>
              {CHECK_ICON[c.state]} <span>{c.name}</span> <span className="muted small">{c.state}</span>
              {c.url && openUrl && (
                <button className="icon-btn repo-link" aria-label={`Open ${c.name}`} title="Open on GitHub" onClick={() => openUrl(c.url!)}>
                  <ExternalLink size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {readAt && <p className="small muted">Read from GitHub at {clockTimeWithSeconds(readAt.getTime())}. It doesn't refresh by itself.</p>}
    </div>
  );
}

function FileRow({
  change: c,
  selected,
  onSelect,
  checked,
  onCheck,
}: {
  change: Change;
  selected: boolean;
  onSelect: () => void;
  /** Ticked for Stage or Unstage; undefined for a change that can't be ticked (a conflict). */
  checked?: boolean;
  onCheck: (on: boolean) => void;
}) {
  const name = c.path.split("/").pop() ?? c.path;
  const dir = c.path.slice(0, c.path.length - name.length);
  return (
    <div className="repo-row">
      {checked === undefined ? (
        <span className="repo-tick-space" aria-hidden />
      ) : (
        <input
          type="checkbox"
          className="repo-tick"
          checked={checked}
          aria-label={`Tick ${c.path} to ${c.side === "staged" ? "unstage" : "stage"} it`}
          onChange={(e) => onCheck(e.target.checked)}
        />
      )}
    <button className="repo-file" aria-current={selected || undefined} onClick={onSelect} title={`${c.label}: ${c.origPath ? `${c.origPath} → ` : ""}${c.path}`}>
      <span className={`repo-code code-${c.code === "?" ? "untracked" : c.code}`} aria-label={c.label}>
        {c.code}
      </span>
      <span className="repo-file-name">
        <span className="mono">{name}</span>
        {dir && <span className="mono muted repo-file-dir">{dir.replace(/\/$/, "")}</span>}
        {c.origPath && <span className="mono muted repo-file-dir">from {c.origPath}</span>}
      </span>
      {c.binary ? (
        <span className="badge">binary</span>
      ) : c.submodule ? (
        <span className="badge">submodule</span>
      ) : c.nameLossy ? (
        <span className="badge">name not UTF-8</span>
      ) : (
        c.counts && (
          <span className="repo-counts small">
            <span className="add">+{c.counts[0]}</span> <span className="del">−{c.counts[1]}</span>
          </span>
        )
      )}
    </button>
    </div>
  );
}

const SIDE_TITLE: Record<Change["side"], string> = {
  staged: "Staged: the index against HEAD",
  unstaged: "Not staged: the working tree against the index",
  untracked: "Untracked: not in Git yet",
  conflict: "Merge conflict",
};

const STAGE_NAME: Record<number, string> = { 1: "the common base", 2: "ours", 3: "theirs" };

function DiffPanel({
  change,
  diff,
  stale,
  busy,
  onStage,
  onHunk,
  onRefresh,
  context,
  onContext,
  onClose,
}: {
  change: Change;
  diff: Load<DiffReply>;
  /** Why this diff is newer than the list, so nothing in it can be staged until a refresh. */
  stale?: string;
  /** A write or a read is running. */
  busy: boolean;
  /** Stages (or unstages) the whole file; undefined for a conflict. */
  onStage?: () => void;
  /** Stages (or unstages) the hunk at this index. */
  onHunk: (i: number) => void;
  onRefresh: () => void;
  context: number;
  onContext: (n: number) => void;
  onClose: () => void;
}) {
  const reply = lastOf(diff);
  const parsed = useMemo(() => (reply ? parseDiff(reply.diff) : undefined), [reply]);
  const contextId = useId();
  const ready = diff.state === "ready" && !stale && !busy;
  const byHunk = !!reply && !!parsed && diff.state === "ready" && hunksSupported(change, reply, parsed);
  const unstaging = change.side === "staged";
  return (
    <section className="repo-diff" aria-label={`Diff of ${change.path}`}>
      <div className="repo-diff-head">
        <div className="repo-diff-title">
          <span className="muted small">{SIDE_TITLE[change.side]}</span>
          <span className="mono repo-diff-path">
            {change.origPath ? (
              <>
                <span className="muted">{change.origPath}</span> → {change.path}
              </>
            ) : (
              change.path
            )}
          </span>
        </div>
        <label htmlFor={contextId} className="small muted">
          Context
        </label>
        <select id={contextId} value={context} onChange={(e) => onContext(Number(e.target.value))} disabled={change.side === "untracked"}>
          {CONTEXT_CHOICES.map((c) => (
            <option key={c.lines} value={c.lines}>
              {c.label}
            </option>
          ))}
        </select>
        {diff.state === "loading" && <Spinner />}
        {onStage && (
          <button className="btn repo-stage-file" disabled={!ready} onClick={onStage}>
            {unstaging ? <Minus size={13} aria-hidden /> : <Plus size={13} aria-hidden />} {unstaging ? "Unstage file" : "Stage file"}
          </button>
        )}
        <button className="icon-btn" aria-label="Close the diff" title="Close the diff" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {diff.state === "failed" && <Failure failure={diff.error} what={`Couldn't read the diff of ${change.path}`} />}
      {stale && (
        <div className="files-banner warn" role="status">
          <FileWarning size={14} aria-hidden />
          <span>{stale} Nothing here can be staged until the list is read again.</span>
          <button className="btn" onClick={onRefresh} disabled={busy}>
            Refresh
          </button>
        </div>
      )}
      {parsed && reply && (
        <div className="repo-diff-body" data-stale={diff.state === "loading" || undefined}>
          <DiffNotices change={change} parsed={parsed} reply={reply} />
          <DiffLines
            parsed={parsed}
            action={
              byHunk
                ? (i) => (
                    <button className="btn repo-hunk-act" disabled={!ready} onClick={() => onHunk(i)} aria-label={`${unstaging ? "Unstage" : "Stage"} hunk ${i + 1} of ${parsed.hunks.length}`}>
                      {unstaging ? <Minus size={12} aria-hidden /> : <Plus size={12} aria-hidden />} {unstaging ? "Unstage hunk" : "Stage hunk"}
                    </button>
                  )
                : undefined
            }
          />
          {!parsed.hunks.length && !parsed.binary && !parsed.rename && !parsed.mode && !parsed.newFile && !parsed.deletedFile && !parsed.submodule && (
            <p className="muted small repo-diff-none">No differences on this side any more. Refresh to see the repository as it is now.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** A parsed diff's hunks and lines, with an optional action beside each hunk's header. */
function DiffLines({ parsed, action }: { parsed: ParsedDiff; action?: (hunk: number) => ReactNode }) {
  return (
    <>
      {parsed.hunks.map((h, i) => (
        <div key={i} className="files-diff-hunk">
          <div className="files-diff-at mono repo-hunk-head">
            <span>{h.header}</span>
            {action?.(i)}
          </div>
          {h.lines.map((l, j) => (
            <div key={j} className={`files-diff-line mono ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : l.kind === "note" ? "note" : ""} ${conflictMarker(l.text) ? "marker" : ""}`}>
              {!parsed.combined && (
                <>
                  <span className="files-diff-no">{l.oldNo ?? ""}</span>
                  <span className="files-diff-no">{l.newNo ?? ""}</span>
                </>
              )}
              <span className="files-diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "note" ? "\\" : " "}</span>
              <span className="files-diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

const conflictMarker = (t: string) => /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(t);

function DiffNotices({ change, parsed, reply }: { change: Change; parsed: ReturnType<typeof parseDiff>; reply: DiffReply }) {
  const notes: { tone: "warn" | "info"; text: string }[] = [];
  if (change.side === "conflict") {
    const names = reply.stages.map((s) => STAGE_NAME[s] ?? `stage ${s}`);
    const stages = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
    notes.push({
      tone: "warn",
      text: `${change.label}. Git holds ${stages || "no versions"} for this file. Lines between <<<<<<< and >>>>>>> are unresolved. Resolve the conflict in the Terminal or ask Hermes to, then refresh.`,
    });
  }
  if (parsed.binary) notes.push({ tone: "info", text: "Binary file: Git shows no lines for it." });
  if (parsed.submodule || change.submodule) notes.push({ tone: "info", text: "A submodule: the change is the commit it points at." });
  if (change.nameLossy)
    notes.push({ tone: "warn", text: "This file's name isn't UTF-8, so it's shown with � and the screen can't name it to Git. Stage or unstage it in the Terminal." });
  if (parsed.rename) notes.push({ tone: "info", text: `Renamed from ${parsed.rename.from}${parsed.rename.similarity ? ` (${parsed.rename.similarity} similar)` : ""}.` });
  if (parsed.copy) notes.push({ tone: "info", text: `Copied from ${parsed.copy.from}.` });
  if (parsed.newFile && change.side !== "untracked") notes.push({ tone: "info", text: `New file${parsed.newMode ? `, mode ${parsed.newMode}` : ""}.` });
  if (parsed.deletedFile) notes.push({ tone: "info", text: "Deleted file." });
  if (parsed.mode) notes.push({ tone: "info", text: `Mode changed from ${parsed.mode.from} to ${parsed.mode.to}.` });
  if (reply.truncated) notes.push({ tone: "warn", text: `This diff is ${formatBytes(reply.bytes)}, so only its first 2 MB is shown.` });
  if (reply.lossy) notes.push({ tone: "warn", text: "Some of this file isn't UTF-8, so a few characters are shown as �." });
  if (!notes.length) return null;
  return (
    <div className="repo-notices">
      {notes.map((n, i) => (
        <p key={i} className={`repo-notice ${n.tone}`}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

export function Failure({ failure, what, onDismiss }: { failure: RepoFailure; what: string; onDismiss?: () => void }) {
  const hint = failureHint(failure);
  return (
    <div className="files-banner err repo-failure" role="alert">
      <CircleAlert size={14} aria-hidden />
      <div className="repo-failure-text">
        <span>
          {what}: {failure.message}
        </span>
        {hint && <span className="repo-hint">{hint}</span>}
        {failure.output.trim() && failure.output.trim() !== failure.message.trim() && <pre className="repo-output mono">{failure.output.trim()}</pre>}
      </div>
      {onDismiss && (
        <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
