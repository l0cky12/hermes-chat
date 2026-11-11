// The Repository screen's model: a Git checkout on the Hermes server, read through the owner's own ssh by a helper
// the app sends there (src-tauri/src/repo_git.rs, repo_git_helper.py, ADR 0110). This file holds what the helper
// answers, how its changes are grouped for the screen, and how a diff is read. The screen is src/ui/Repository.tsx.

import type { Progress, WorktreeRequest } from "./worktrees";
import { signInSshTarget, type SignInAddress } from "./terminal";
import { errorText } from "./values";

/** One line of `git status --porcelain=v2`, as the helper reports it. Paths are relative to the checkout's top. */
export type Entry = {
  kind: "ordinary" | "renamed" | "copied" | "unmerged" | "untracked";
  /** The index's status code against HEAD ("." for none), and the working tree's against the index. */
  x: string;
  y: string;
  /** A submodule. */
  sub: boolean;
  modes?: string[];
  path: string;
  /** A rename's or copy's path in HEAD. */
  origPath?: string;
  /** Lines added and removed, staged and unstaged; null for a binary file; absent when unknown. */
  staged?: [number, number] | null;
  unstaged?: [number, number] | null;
  /** An untracked file whose first 8000 bytes hold a NUL, as Git decides. */
  binary?: boolean;
  /** The working-tree file's stamp as read (null: it's gone), for a file with unstaged changes or untracked: SHA-256
   * of its bytes, or its metadata ("meta:…") for a file over 32 MiB or past what one status hashes. Staging sends it
   * back, and the helper stages nothing if the file has changed since. */
  worktree?: string | null;
  /** Its name isn't UTF-8, so `path` shows it with � and names no file on the server: it can't be staged or unstaged here. */
  nameLossy?: boolean;
};

export type Status = {
  /** The top folder of the checkout: every path is relative to it, and every later request names it. */
  top: string;
  gitDir: string;
  /** HEAD's commit and the index's stamp when this was read: every write sends them back, and is refused if either
   * moved (another agent committed or staged meanwhile). */
  head: string | null;
  index: string;
  branch: {
    /** HEAD's commit, or null before the first commit. */
    oid: string | null;
    /** The branch checked out, or null when HEAD is detached. */
    head: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
  };
  /** A merge, rebase, cherry-pick, revert or bisect waiting to be finished. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null;
  entries: Entry[];
  /** More than 5000 changed files: the rest aren't listed. */
  truncated: boolean;
};

/** Which changes of a file a diff shows. */
export type Side = "staged" | "unstaged" | "untracked" | "conflict";

export type DiffReply = {
  diff: string;
  /** Cut at 2 MiB. */
  truncated: boolean;
  /** Some bytes weren't UTF-8, so the text isn't byte for byte what Git printed. */
  lossy: boolean;
  bytes: number;
  /** SHA-256 of the diff's bytes. */
  sha: string;
  /** For a conflict, which index stages exist: 1 the common base, 2 ours, 3 theirs. */
  stages: number[];
  /** The working-tree file's stamp as this diff shows it (unstaged and untracked sides only). */
  worktree?: string | null;
  /** The same file's metadata stamp, to compare with a list that stamped it by its metadata. */
  worktreeMeta?: string | null;
  /** HEAD and the index when the diff was read. */
  head?: string | null;
  index?: string;
};

/** What a write expects to find. `rawSha` and `headRef` (a commit only): the stamp of the staged changes the preview
 * showed, and the ref HEAD pointed at then, so a commit can't land on another branch at the same commit. */
export type Expect = { head: string | null; index: string; rawSha?: string; headRef?: string };

/** What a commit now would hold (the helper's `preview`). */
export type Preview = {
  head: string | null;
  index: string;
  branch: string | null;
  /** The ref HEAD points at (`refs/heads/<branch>`), or `HEAD` when detached. A commit sends it back. */
  headRef: string;
  /** Each staged file, renames shown as a deletion and an addition; `renames` pairs them up. */
  files: { status: string; path: string; oldMode: string; newMode: string }[];
  renames: Record<string, { from: string; score: string }>;
  rawSha: string;
  /** The staged diff with a stat, cut at 2 MiB (`truncated`). The file list is never cut. */
  diff: string;
  truncated: boolean;
  lossy: boolean;
  unmerged: boolean;
  operation: Status["operation"];
  /** "Name <email>", or null when Git doesn't know who. */
  author: string | null;
  committer: string | null;
  hooksPath: string;
  /** The commit hooks Git will run: pre-commit, prepare-commit-msg, commit-msg, post-commit. */
  hooks: string[];
  /** The last ten commit subjects, for drafting a message in the same style. */
  recent: string[];
};

export type Committed = {
  head: string;
  subject: string;
  /** What Git and the hooks printed. */
  output: string;
  /** The commit holds exactly what the preview showed. False when a hook changed it. */
  matches: boolean;
  /** Git's exit status. Not 0 when Git failed after the commit was made: it's made, and `output` says what failed. */
  exitCode?: number;
  files: { status: string; path: string }[];
  branch: string | null;
};

/** What the screen asks the helper for. Mirrors `Request` in repo_git.rs; nothing else can be asked. */
export type RepoRequest =
  | { op: "status"; repo: string }
  | { op: "diff"; repo: string; path: string; origPath?: string; side: Side; context: number }
  | { op: "stage"; repo: string; files: { path: string; worktree: string | null }[]; expect: Expect }
  | { op: "unstage"; repo: string; paths: string[]; expect: Expect }
  | { op: "apply"; repo: string; path: string; hunks: number[]; reverse: boolean; context: number; diffSha: string; expect: Expect }
  | { op: "preview"; repo: string }
  | { op: "commit"; repo: string; message: string; expect: Expect }
  | { op: "publishInfo"; repo: string }
  /** `pushUrl`: the push URL the confirmation showed (no credentials); refused if the remote now pushes elsewhere. */
  | { op: "push"; repo: string; remote: string; pushUrl: string; branch: string; remoteBranch: string; expect: { head: string | null } }
  | {
      op: "prCreate";
      repo: string;
      /** The local branch the form was written for: refused if it's no longer checked out at `expect.head`. */
      branch: string;
      remote: string;
      /** The GitHub repository (`owner/name`) the form showed: refused if the remote now names another. */
      githubRepo: string;
      remoteBranch: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
      expect: { head: string | null };
    }
  | { op: "prStatus"; repo: string; remote: string; number: number }
  | { op: "remoteHead"; repo: string; remote: string; remoteBranch: string }
  | WorktreeRequest;

/**
 * Rust's command: send `request` to the helper through ssh to `target`. Rejects with a `RepoFailure`. `stream`: the
 * same, passing on each progress line as the helper prints it (worktrees.ts); without it, requests run without progress.
 */
export type RepoApi = {
  run(target: string, request: RepoRequest): Promise<unknown>;
  stream?(target: string, request: RepoRequest, onProgress: (p: Progress) => void): Promise<unknown>;
};

/**
 * A failure the screen tells apart by `kind`:
 * - ssh: "bad-target", "spawn", "ssh-auth", "ssh-host-key", "ssh-unreachable", "ssh"
 * - the server: "unsupported" (no python3 or git), "timeout", "bad-reply"
 * - the repository: "bad-path", "not-found", "not-repo", "stale", "busy", "git", "internal"
 * - a commit: "hook", "identity", "locked", "conflict", "operation", "nothing-staged", "empty-message", "lost"
 * - a push: "rejected", "remote-rejected", "auth", "network", "hook", "bad-branch", "bad-remote"
 * - a pull request: "not-pushed", "no-commits", "bad-base", "empty-title", "pr-api", "auth", "unsupported"
 * `output` is what ssh or Git printed, shown as it is.
 */
export class RepoFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly output = "",
  ) {
    super(message);
  }
}

/** A transport failure, or an answer that couldn't be read: whether a write happened isn't known. */
export const lostAnswer = (e: RepoFailure) => e.kind === "timeout" || e.kind === "spawn" || e.kind === "bad-reply" || e.kind.startsWith("ssh");

/** Whether the screen can stage or unstage this change: not a conflict, a submodule, or a file it can't name. */
export const actionable = (c: Change) => c.side !== "conflict" && !c.submodule && !c.nameLossy;

export function asRepoFailure(e: unknown): RepoFailure {
  if (e instanceof RepoFailure) return e;
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const o = e as { kind: unknown; message: unknown; output?: unknown };
    return new RepoFailure(String(o.kind), String(o.message), typeof o.output === "string" ? o.output : "");
  }
  return new RepoFailure("internal", errorText(e));
}

/** What to do about a failure, beyond what it says, or undefined when there's nothing to add. */
export function failureHint(f: RepoFailure): string | undefined {
  switch (f.kind) {
    case "ssh-auth":
      return "The Repository screen runs ssh without a terminal, so it can't ask for a passphrase. Add the key to your SSH agent (ssh-add), then try again.";
    case "ssh-host-key":
      return "Open the Terminal, connect to the same target, and accept the host key there.";
    case "bad-target":
      return "Change the SSH target above.";
    case "unsupported":
      return "The server needs OpenSSH, python3 (3.8 or newer) and git on the PATH a non-interactive ssh gets.";
    case "timeout":
      return "A read changes nothing. A write may or may not have happened, so look at the repository again before trying it again.";
    case "stale":
      return "Another agent or tool may be working in this checkout. Look at it again before you retry.";
    case "busy":
      return "Something kept changing the repository while it was read. Try again in a moment.";
    case "hook":
      return "Fix what the hook reports (in the chat or the Terminal), stage the fix, and commit again. Hooks are never skipped.";
    case "identity":
      return "Set them on the server: git config --global user.name and user.email.";
    case "locked":
      return "If no Git command is running, the lock was left by one that crashed; remove .git/index.lock in the Terminal.";
    case "conflict":
      return "Resolve the conflicts in the Terminal or ask Hermes to, then stage the resolved files.";
    case "operation":
      return "This screen doesn't finish merges, rebases, cherry-picks or reverts. Use the Terminal, or ask Hermes to.";
    case "lost":
      return "Look at the history in the Terminal (git log) before doing anything else.";
    case "rejected":
      return "Fetch and merge or rebase in the Terminal (or ask Hermes to), check the result here, then push again.";
    case "remote-rejected":
      return "The remote's own rules refused it; its reason is in the output. Change what it asks for, or push to another branch.";
    case "auth":
      return "The server's credentials are used as they are; this app adds none. Fix them on the server, then try again.";
    case "network":
      return "Check the server's network and the remote's address, then try again.";
    case "bad-base":
      return "To forget branches deleted on the remote, run git fetch --prune in the Terminal.";
    case "not-pushed":
      return "Push the branch first, here, then create the pull request.";
    case "pr-api":
      return "The push isn't repeated. Try again, or open the pull request on GitHub.";
    default:
      return undefined;
  }
}

/** A change of one file on one side, as the screen lists it. */
export type Change = {
  /** Unique among the listed changes. */
  key: string;
  side: Side;
  path: string;
  origPath?: string;
  /** One letter: M, A, D, R, C, T, U (conflict) or ? (untracked). */
  code: string;
  /** What the code means, in words. */
  label: string;
  /** Lines added and removed, when known. */
  counts?: [number, number];
  binary: boolean;
  submodule: boolean;
  /** Its name isn't UTF-8: listed, but not staged or unstaged here. */
  nameLossy?: boolean;
};

const CODE_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Updated but unmerged",
};

/** Git's two-letter codes for a merge conflict. */
const CONFLICT_LABEL: Record<string, string> = {
  DD: "Deleted on both sides",
  AU: "Added by us",
  UD: "Deleted by them",
  UA: "Added by them",
  DU: "Deleted by us",
  AA: "Added on both sides",
  UU: "Changed on both sides",
};

export type Grouped = { conflicts: Change[]; staged: Change[]; unstaged: Change[]; untracked: Change[] };

/** The changes in a status, by where they are: conflicts, staged (in the index), unstaged (in the working tree) and untracked. */
export function group(s: Status): Grouped {
  const out: Grouped = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const e of s.entries) {
    const lossy = e.nameLossy ? { nameLossy: true } : {};
    if (e.kind === "untracked") {
      out.untracked.push({ key: `untracked:${e.path}`, side: "untracked", path: e.path, code: "?", label: "Untracked", binary: !!e.binary, submodule: false, ...lossy });
      continue;
    }
    if (e.kind === "unmerged") {
      const xy = e.x + e.y;
      out.conflicts.push({ key: `conflict:${e.path}`, side: "conflict", path: e.path, code: "U", label: CONFLICT_LABEL[xy] ?? `Conflict (${xy})`, binary: false, submodule: e.sub });
      continue;
    }
    if (e.x !== ".") {
      out.staged.push({
        key: `staged:${e.path}`,
        side: "staged",
        path: e.path,
        ...(e.origPath && { origPath: e.origPath }),
        code: e.x,
        label: CODE_LABEL[e.x] ?? e.x,
        ...(e.staged && { counts: e.staged }),
        binary: e.staged === null,
        submodule: e.sub,
        ...lossy,
      });
    }
    if (e.y !== ".") {
      out.unstaged.push({
        key: `unstaged:${e.path}`,
        side: "unstaged",
        path: e.path,
        code: e.y,
        label: CODE_LABEL[e.y] ?? e.y,
        ...(e.unstaged && { counts: e.unstaged }),
        binary: e.unstaged === null,
        submodule: e.sub,
        ...lossy,
      });
    }
  }
  return out;
}

/** The branch line: "main", or "detached at 1a2b3c4", or "no commits yet on main". */
export function branchLabel(b: Status["branch"]): string {
  if (b.detached) return b.oid ? `detached at ${b.oid.slice(0, 7)}` : "detached";
  if (!b.oid) return `${b.head ?? "?"} (no commits yet)`;
  return b.head ?? "?";
}

/** How the branch stands against its upstream, in words. */
export function upstreamLabel(b: Status["branch"]): string {
  if (b.detached) return "No branch, so nothing to compare with.";
  if (!b.upstream) return "No upstream branch set.";
  if (b.ahead === null || b.behind === null) return `${b.upstream} (gone from the remote, or never fetched)`;
  if (!b.ahead && !b.behind) return `Up to date with ${b.upstream}, as of the last fetch.`;
  const parts = [b.ahead ? `${b.ahead} ahead` : "", b.behind ? `${b.behind} behind` : ""].filter(Boolean);
  return `${parts.join(", ")} of ${b.upstream}, as of the last fetch.`;
}

export const OPERATION_LABEL: Record<NonNullable<Status["operation"]>, string> = {
  merge: "A merge is in progress.",
  rebase: "A rebase is in progress.",
  "cherry-pick": "A cherry-pick is in progress.",
  revert: "A revert is in progress.",
  bisect: "A bisect is in progress.",
};

// ── diffs ───────────────────────────────────────────────────────────────────

export type DiffLine = {
  kind: "context" | "add" | "del" | "note";
  text: string;
  /** Line numbers in the old and new file, where the line has one. */
  oldNo?: number;
  newNo?: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  /** A conflict's combined diff (`diff --cc`): two columns of signs, no single old file. */
  combined: boolean;
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  rename?: { from: string; to: string; similarity?: string };
  copy?: { from: string; to: string };
  mode?: { from: string; to: string };
  /** A file whose mode alone is shown, such as a new empty file. */
  newMode?: string;
  submodule: boolean;
  hunks: DiffHunk[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads one file's unified diff, as the helper returns it. An empty string is no change. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { combined: false, binary: false, newFile: false, deletedFile: false, submodule: false, hunks: [] };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let renameFrom: string | undefined;
  let copyFrom: string | undefined;
  let oldMode: string | undefined;
  let similarity: string | undefined;
  for (const line of lines) {
    if (hunk) {
      if (out.combined) {
        if (line.startsWith("@@@")) hunk = undefined;
        else {
          const signs = line.slice(0, 2);
          hunk.lines.push({ kind: signs.includes("+") ? "add" : signs.includes("-") ? "del" : line.startsWith("\\") ? "note" : "context", text: line.slice(2) });
          continue;
        }
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        continue;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        continue;
      } else if (line.startsWith("\\")) {
        hunk.lines.push({ kind: "note", text: line.slice(2) });
        continue;
      } else if (line === "") {
        // A blank context line whose leading space was lost.
        hunk.lines.push({ kind: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else hunk = undefined;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) out.combined = true;
    else if (line.startsWith("new file mode ")) {
      out.newFile = true;
      out.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) out.deletedFile = true;
    else if (line.startsWith("old mode ")) oldMode = line.slice("old mode ".length);
    else if (line.startsWith("new mode ") && oldMode) out.mode = { from: oldMode, to: line.slice("new mode ".length) };
    else if (line.startsWith("similarity index ")) similarity = line.slice("similarity index ".length);
    else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ") && renameFrom !== undefined) out.rename = { from: renameFrom, to: line.slice("rename to ".length), ...(similarity && { similarity }) };
    else if (line.startsWith("copy from ")) copyFrom = line.slice("copy from ".length);
    else if (line.startsWith("copy to ") && copyFrom !== undefined) out.copy = { from: copyFrom, to: line.slice("copy to ".length) };
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") out.binary = true;
    else if (line.startsWith("Subproject commit ") || line.startsWith("-Subproject commit ") || line.startsWith("+Subproject commit ")) out.submodule = true;
    else if (out.combined && line.startsWith("@@@")) {
      hunk = { header: line, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] };
      out.hunks.push(hunk);
    } else {
      const m = HUNK.exec(line);
      if (m) {
        hunk = {
          header: line,
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        };
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        out.hunks.push(hunk);
      }
    }
  }
  return out;
}

/** Lines added and removed in a parsed diff. */
export function diffCounts(d: ParsedDiff): [number, number] {
  let add = 0;
  let del = 0;
  for (const h of d.hunks) for (const l of h.lines) l.kind === "add" ? add++ : l.kind === "del" ? del++ : undefined;
  return [add, del];
}

/** How many lines of context a diff shows. "Whole file" asks for as many as the helper allows. */
export const CONTEXT_CHOICES: { label: string; lines: number }[] = [
  { label: "No context", lines: 0 },
  { label: "3 lines", lines: 3 },
  { label: "10 lines", lines: 10 },
  { label: "25 lines", lines: 25 },
  { label: "Whole file", lines: 1_000_000 },
];

// ── where ───────────────────────────────────────────────────────────────────

/** The repository folder last opened, and the SSH target the screen uses (else the Terminal's, else the sign-in's). */
export const REPO_PATH_KEY = "hermes-chat.repo-path";
export const REPO_RECENT_KEY = "hermes-chat.repo-recent";
export const REPO_TARGET_KEY = "hermes-chat.repo-target";

export function repoTarget(signIn: SignInAddress, saved: string | null, terminalSaved: string | null): string {
  if (saved?.trim()) return saved.trim();
  if (terminalSaved?.trim()) return terminalSaved.trim();
  return signInSshTarget(signIn);
}

/** The folders opened lately, newest first, at most five. */
export function remember(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, 5);
}

export function readRecent(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Checks a reply's shape just enough that the screen can't be broken by an older or different helper. */
export function asStatus(v: unknown): Status {
  const s = v as Status;
  if (!s || typeof s.top !== "string" || !s.branch || !Array.isArray(s.entries)) throw new RepoFailure("bad-reply", "The server's answer wasn't a repository status.");
  return s;
}

export function asPreview(v: unknown): Preview {
  const p = v as Preview;
  if (!p || typeof p.index !== "string" || !Array.isArray(p.files) || typeof p.rawSha !== "string" || typeof p.headRef !== "string") throw new RepoFailure("bad-reply", "The server's answer wasn't a commit preview.");
  return { ...p, renames: p.renames ?? {}, hooks: Array.isArray(p.hooks) ? p.hooks : [], recent: Array.isArray(p.recent) ? p.recent : [] };
}

export function asCommitted(v: unknown): Committed {
  const c = v as Committed;
  if (!c || typeof c.head !== "string" || !Array.isArray(c.files)) throw new RepoFailure("bad-reply", "The server's answer wasn't a commit.");
  return c;
}

export function asDiff(v: unknown): DiffReply {
  const d = v as DiffReply;
  if (!d || typeof d.diff !== "string") throw new RepoFailure("bad-reply", "The server's answer wasn't a diff.");
  return { ...d, stages: Array.isArray(d.stages) ? d.stages : [] };
}

// ── staging and committing ──────────────────────────────────────────────────

/** The stamps of a status, for a write made from it. */
export const expectOf = (s: { head: string | null; index: string }): Expect => ({ head: s.head, index: s.index });

/**
 * Why the shown diff can't be acted on, or undefined when it can: the list and the diff were read at different
 * moments, and something changed in between. Staging then would stage something the owner hasn't seen.
 */
export function diffStale(s: Status, entry: Entry | undefined, d: DiffReply): string | undefined {
  if (d.head !== undefined && (d.head !== s.head || d.index !== s.index)) return "The repository changed after the list was read.";
  const shown = entry?.worktree?.startsWith("meta:") ? (d.worktreeMeta ?? d.worktree) : d.worktree;
  if (entry && shown !== undefined && shown !== null && entry.worktree !== shown) return "This file changed after the list was read.";
  return undefined;
}

/**
 * Whether single hunks of a change can be staged or unstaged: a text change to a file that exists on both sides,
 * shown whole and byte for byte. Anything else (new, deleted, renamed, binary, a submodule, a conflict, a cut or
 * lossy diff) is staged as a whole file.
 */
export function hunksSupported(c: Change, d: DiffReply, parsed: ParsedDiff): boolean {
  if (c.side !== "staged" && c.side !== "unstaged") return false;
  if (c.code !== "M" || c.binary || c.submodule || c.nameLossy || c.origPath) return false;
  if (d.truncated || d.lossy || parsed.combined || parsed.binary || parsed.newFile || parsed.deletedFile || parsed.mode || parsed.rename) return false;
  return parsed.hunks.length > 0;
}

/** The message as it will be committed: verbatim, with one final new line. Empty when there's nothing but space. */
export function commitMessage(draft: string): string {
  if (!draft.trim()) return "";
  return draft.replace(/\s+$/, "") + "\n";
}

/** A word on the message's first line, when it's long. */
export function subjectNote(draft: string): string | undefined {
  const subject = draft.split("\n")[0];
  if (subject.length > 72) return `The first line is ${subject.length} characters; Git tools show about 72.`;
  return undefined;
}

/** What `llm.oneshot` is told when asked for a commit message. It sees only the staged changes and recent subjects. */
export const SUGGEST_INSTRUCTIONS =
  "Write a Git commit message for the staged changes below. First line: an imperative summary under 72 characters, " +
  "in the style of the recent subjects if they share one. Then, if the change needs it, a blank line and a short body " +
  "saying why. Answer with the message only: no quotes, no code fences, no commentary.";

/** The input for a suggested message: recent subjects, the files, then the staged diff, cut to `max` characters. */
export function suggestInput(p: Preview, max = 60_000): string {
  const files = previewRows(p).map((r) => `${r.code} ${r.from ? `${r.from} -> ` : ""}${r.path}`).join("\n");
  const recent = p.recent.length ? `Recent subjects:\n${p.recent.join("\n")}\n\n` : "";
  const diff = p.diff.length > max ? `${p.diff.slice(0, max)}\n[diff cut]` : p.diff;
  return `${recent}Staged files:\n${files}\n\nStaged diff:\n${diff}`;
}

/** Hermes's suggestion as a message: a fence or quotes around the whole answer taken off. */
export function cleanSuggestion(text: string): string {
  let t = text.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (/^".*"$/s.test(t) || /^'.*'$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/** A combined patch (the preview's diff) split into each file's own diff, without the stat above them. */
export function splitPatch(text: string): { header: string; diff: string }[] {
  const out: { header: string; diff: string }[] = [];
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    out.push({ header: part.slice(0, part.indexOf("\n") >>> 0), diff: part });
  }
  return out;
}

/** A preview's files, with each rename pair as one row: "R old → new" in place of "D old" and "A new". */
export function previewRows(p: Preview): { code: string; path: string; from?: string }[] {
  const moved = new Set(Object.values(p.renames).map((r) => r.from));
  const rows: { code: string; path: string; from?: string }[] = [];
  for (const f of p.files) {
    if (moved.has(f.path) && f.status === "D") continue;
    const r = p.renames[f.path];
    if (r && f.status === "A") rows.push({ code: r.score.startsWith("C") ? "C" : "R", path: f.path, from: r.from });
    else rows.push({ code: f.status, path: f.path });
  }
  return rows;
}

// ── publishing: push, pull requests, status ─────────────────────────────────

/** A pull request as gh lists it. `state` is GitHub's: OPEN, CLOSED or MERGED. */
export type PrSummary = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
};

/** Where a push and a pull request would go (the helper's `publishInfo`). */
export type PublishInfo = {
  head: string | null;
  branch: string | null;
  /** Remotes with push URLs, any user name and password taken out. */
  remotes: { name: string; url: string; pushUrls?: string[] }[];
  upstream: { ref: string | null; remote: string; branch: string } | null;
  /** The remote a push goes to: the upstream's, else origin, else the only one. */
  remote: string | null;
  remoteUrl: string;
  /** Every URL a push to `remote` goes to, without credentials. More than one, and Push is refused. */
  remotePushUrls?: string[];
  /** The branch on the remote: the upstream's, else the same name. */
  remoteBranch: string | null;
  /** What this checkout last saw the remote branch at (its tracking ref). For a remote that pushes somewhere other
   * than it fetches from (`remoteAsked`), what the push destination itself answered. */
  remoteHead: string | null;
  remoteAsked?: boolean;
  /** Why the push destination couldn't be asked. */
  remoteError?: string | null;
  /** Whether the push destination has a branch called `remoteBranch`: as of the last fetch, or as it answered when
   * asked (`remoteAsked`). Null when that couldn't be told. False with `ahead` 0 means a new branch on commits the
   * remote already has: Push still creates the branch. */
  remoteBranchExists?: boolean | null;
  ahead: number | null;
  behind: number | null;
  /** Up to 50 commits a push would send, newest first. */
  commits: { sha: string; subject: string }[];
  /** Up to 50 commits on HEAD that the remote's default branch doesn't have, newest first: what a pull request holds. */
  prCommits?: { sha: string; subject: string }[];
  /** The remote's branches, as last fetched: bases a pull request can go into. */
  bases: string[];
  /** For a GitHub remote: the repository, its default branch, and pull requests from this branch. */
  github: { repo: string; url: string | null; defaultBranch: string | null; prs: PrSummary[]; error: string | null } | null;
};

/** A push that happened. `matches`: the remote, asked afterwards, has the commit; null when that check itself failed
 * (`verifyError`), which says nothing against the push. */
export type Pushed = { pushed: string; remoteHead: string | null; matches: boolean | null; verifyError?: string | null; upstreamSet: boolean; output: string };

/** A pull request made (or found open). When reading it back failed, `pr` holds only its `url`. */
export type PrCreated = { pr: Partial<PrSummary> & { url: string }; existing: boolean; output: string; readBack?: boolean; readBackError?: string | null };

type RawCheck =
  | { __typename: "CheckRun"; name?: string; workflowName?: string; status?: string; conclusion?: string; detailsUrl?: string }
  | { __typename: "StatusContext"; context?: string; state?: string; targetUrl?: string };

export type PrStatus = PrSummary & {
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: RawCheck[];
  updatedAt?: string;
};

export type CheckState = "pass" | "fail" | "pending" | "skipped" | "neutral";
export type Check = { name: string; state: CheckState; url?: string };

/** A pull request's checks, from GitHub's rollup of check runs and commit statuses. */
export function checksOf(p: PrStatus): Check[] {
  return (p.statusCheckRollup ?? []).map((c): Check => {
    if (c.__typename === "StatusContext") {
      const st = (c.state ?? "").toUpperCase();
      return { name: c.context ?? "status", state: st === "SUCCESS" ? "pass" : st === "FAILURE" || st === "ERROR" ? "fail" : "pending", ...(c.targetUrl && { url: c.targetUrl }) };
    }
    const name = c.workflowName && c.name ? `${c.workflowName} / ${c.name}` : (c.name ?? "check");
    const url = c.detailsUrl ? { url: c.detailsUrl } : {};
    if ((c.status ?? "").toUpperCase() !== "COMPLETED") return { name, state: "pending", ...url };
    const conclusion = (c.conclusion ?? "").toUpperCase();
    const state: CheckState =
      conclusion === "SUCCESS" ? "pass" : conclusion === "SKIPPED" ? "skipped" : conclusion === "NEUTRAL" ? "neutral" : conclusion === "" ? "pending" : "fail";
    return { name, state, ...url };
  });
}

/** One line for a set of checks: "2 passed, 1 failed, 1 running". */
export function checksSummary(checks: Check[]): string {
  if (!checks.length) return "No checks reported.";
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  const parts = [
    n("fail") && `${n("fail")} failed`,
    n("pending") && `${n("pending")} running or waiting`,
    n("pass") && `${n("pass")} passed`,
    n("skipped") && `${n("skipped")} skipped`,
    n("neutral") && `${n("neutral")} neutral`,
  ].filter(Boolean);
  return parts.join(", ") + ".";
}

const REVIEW: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
export const reviewLabel = (d?: string) => (d ? (REVIEW[d] ?? d.toLowerCase().replace(/_/g, " ")) : "No review yet");
export const stateLabel = (p: Pick<PrSummary, "state" | "isDraft">) => (p.state === "OPEN" ? (p.isDraft ? "Open, draft" : "Open") : p.state === "MERGED" ? "Merged" : "Closed");

/** A title and body to start a pull request from: the one commit's own words, or the branch name and the commits. */
export function prDraft(info: PublishInfo, log: { sha: string; subject: string }[] = info.prCommits?.length ? info.prCommits : info.commits): { title: string; body: string } {
  if (log.length === 1) return { title: log[0].subject, body: "" };
  const words = (info.remoteBranch ?? info.branch ?? "").replace(/^.*\//, "").replace(/[-_]+/g, " ").trim();
  const title = words ? words[0].toUpperCase() + words.slice(1) : "";
  return { title, body: log.length ? log.slice().reverse().map((c) => `- ${c.subject}`).join("\n") : "" };
}

/** Whether the remote has this branch at HEAD, as this checkout last saw it. A pull request asks the remote itself. */
export const pushedHere = (info: PublishInfo) => !!info.head && info.remoteHead === info.head;

export function asPublishInfo(v: unknown): PublishInfo {
  const p = v as PublishInfo;
  if (!p || !Array.isArray(p.remotes) || !Array.isArray(p.commits)) throw new RepoFailure("bad-reply", "The server's answer didn't say where a push would go.");
  return { ...p, bases: Array.isArray(p.bases) ? p.bases : [] };
}
