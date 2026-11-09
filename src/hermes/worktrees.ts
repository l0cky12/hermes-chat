// Worktrees on the server (ADR 0043): the Repository screen's Worktrees view and the chats started in one. Every Git
// operation runs on the server, through the same helper and ssh as the rest of the Repository screen (repo.ts,
// src-tauri/src/repo_worktree_helper.py). Which worktrees this app made, and which chats work in each, is recorded on
// the server too, in the repository's own Git folder, so every desktop sees the same and a removal can't race an
// attach. This computer keeps only a copy of which chats it started in a worktree, to label them in the chat.

import { RepoFailure, type RepoApi } from "./repo";

export type WorktreeState =
  | "creating"
  | "setup"
  | "ready"
  | "setup-failed"
  | "removing"
  | "create-interrupted"
  | "setup-interrupted"
  | "remove-interrupted";

export type SetupEntry = {
  entry: string;
  action: "copy" | "link" | "skip";
  reason?: string | null;
  size?: number | null;
  target?: string;
  /** After a run: what happened to it. */
  result?: "copied" | "linked" | "present" | "kept" | "skipped" | "failed";
  error?: string;
};

/** A chat working in a worktree, as the record on the server has it. `starting`: its place is held, and Hermes was
 * asked to start it, but the app hasn't confirmed it started (or couldn't). Both count: neither can be removed. */
export type AttachedChat = { token: string; chat: string | null; profile: string; connection: string; state: "starting" | "attached"; at: number };

/** What this app recorded about a worktree it made. */
export type WorktreeRecord = {
  id: string;
  path: string;
  branch: string;
  newBranch: boolean;
  base: string;
  baseOid: string;
  source: string;
  createdAt: number;
  protected: boolean;
  state: WorktreeState;
  /** A creation, setup or removal is running right now (not cut off). */
  running: boolean;
  setup: { state: "pending" | "skipped" | "running" | "done" | "failed"; entries: SetupEntry[]; log: string; startedAt?: number; finishedAt?: number | null };
  chats: AttachedChat[];
  createOutput?: string;
  /** For a record without a worktree (`missing`): whether something is at its path. */
  exists?: boolean;
};

export type Protection = { kind: "main" | "unmanaged" | "marked" | "locked"; message: string };

export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Git's lock reason ("" for a lock without one), or null when unlocked. */
  locked: string | null;
  prunable: string | null;
  main: boolean;
  exists: boolean;
  managed: WorktreeRecord | null;
  /** Null when not read (more worktrees than the list reads in detail). */
  dirty: { staged: number; unstaged: number; untracked: number; conflicts: number } | null;
  /** Commits no remote has. */
  unpublished: number | null;
  /** For a detached HEAD: commits no branch, tag or remote has. */
  lost: number | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  submodules: number | null;
  protected: Protection[];
  error?: string;
};

export type Kept = { ref: string; commit: string; at: number; subject: string; id?: string; path?: string; branch?: string | null; files?: number };

export type WorktreeList = {
  top: string;
  main: string;
  commonDir: string;
  worktrees: Worktree[];
  missing: WorktreeRecord[];
  kept: Kept[];
  detailLimit: number;
  git: string;
};

export type WorktreePlan = {
  repo: string;
  main: string;
  source: string;
  base: string;
  baseOid: string;
  baseRef: string | null;
  baseSubject: string;
  branch: string;
  newBranch: boolean;
  path: string;
  suggested: boolean;
  sourceDirty: { staged: number; unstaged: number; untracked: number; conflicts: number };
  submodules: string[];
  setup: SetupEntry[];
  /** Repository setup commands (an install script): no Hermes contract for them, so never run (ADR 0043). */
  setupCommands: "unsupported";
  stamp: string;
};

/** `hidden`: a change Git's status doesn't show, because the file is marked assume-unchanged or skip-worktree. */
export type RemovalFile = { path: string; from?: string | null; kind: "change" | "conflict" | "untracked"; xy: string; sub: boolean; size: number | null; hidden?: boolean };
export type Blocker = { kind: string; message: string };

export type RemovalPlan = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  files: RemovalFile[];
  fileCount: number;
  filesCut: boolean;
  ignored: string[];
  /** More ignored files than the stamp reads one by one: later changes to the rest aren't noticed. */
  ignoredUnchecked?: boolean;
  /** Files whose changes an index flag hides, kept too. */
  hidden?: string[];
  unpublished: { sha: string; subject: string }[];
  unpublishedCount: number;
  lost: number;
  submodules: { path: string; dirty: number; unpublished: number }[];
  processes: { pid: number; name: string; cwd: string }[];
  blockers: Blocker[];
  operation: string | null;
  /** Changes or commits that only the worktree holds: they're kept first, under refs/hermes-chat/kept/. */
  keep: boolean;
  stamp: string;
  worktree: WorktreeRecord;
};

export type Removed = { removed: string; branch: string | null; unpublished: number; kept: { ref: string; commit: string; files: number } | null };

export type Progress = { step: string; message: string; at: number; entry?: string; result?: string; output?: string };

/** What the Worktrees view asks the helper for. Mirrors the worktree variants of `Request` in repo_git.rs. */
export type WorktreeRequest =
  | { op: "worktreeList"; repo: string }
  | { op: "worktreePlan"; repo: string; base: string; branch: string; newBranch: boolean; path: string; setup: boolean }
  | { op: "worktreeCreate"; repo: string; id: string; base: string; branch: string; newBranch: boolean; path: string; setup: boolean; expect: string }
  | { op: "worktreeSetup"; repo: string; id: string }
  | { op: "worktreeAttach"; repo: string; id: string; token: string; profile: string; connection: string }
  | { op: "worktreeAttachConfirm"; repo: string; id: string; token: string; chat: string }
  | { op: "worktreeDetach"; repo: string; id: string; token: string }
  | { op: "worktreeProtect"; repo: string; id: string; protected: boolean }
  | { op: "worktreeRemovePlan"; repo: string; id: string }
  | { op: "worktreeRemove"; repo: string; id: string; expect: string }
  | { op: "worktreeForget"; repo: string; id: string };

/** The Rust commands (repo.ts `RepoApi`): `run`, and `stream`, which passes on each progress line as the helper prints
 * it (creating, setup, removing). Without `stream` the same request runs without progress. */
export type WorktreeApi = RepoApi;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function need<T>(v: unknown, check: (o: Record<string, unknown>) => boolean, what: string): T {
  if (!isObj(v) || !check(v)) throw new RepoFailure("bad-reply", `The server's answer wasn't ${what} this app understands.`);
  return v as T;
}

export const asWorktreeList = (v: unknown) =>
  need<WorktreeList>(v, (o) => typeof o.top === "string" && Array.isArray(o.worktrees) && Array.isArray(o.missing) && Array.isArray(o.kept), "a worktree list");
export const asWorktreePlan = (v: unknown) =>
  need<WorktreePlan>(v, (o) => typeof o.path === "string" && typeof o.stamp === "string" && typeof o.baseOid === "string" && Array.isArray(o.setup), "a worktree preview");
export const asRemovalPlan = (v: unknown) =>
  need<RemovalPlan>(v, (o) => typeof o.stamp === "string" && Array.isArray(o.files) && Array.isArray(o.blockers), "a removal preview");
export const asCreated = (v: unknown) =>
  need<{ worktree: WorktreeRecord; output?: string }>(v, (o) => isObj(o.worktree) && typeof (o.worktree as Record<string, unknown>).id === "string", "a new worktree");
export const asRemoved = (v: unknown) => need<Removed>(v, (o) => typeof o.removed === "string", "a removal");

/** A new id for a worktree or a chat's place in one: 16 random hex digits, as the helper accepts. */
export function newWorktreeId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const STATE_LABEL: Record<WorktreeState, string> = {
  creating: "Being created",
  setup: "Setting up",
  ready: "Ready",
  "setup-failed": "Setup failed",
  removing: "Being removed",
  "create-interrupted": "Creation was cut off",
  "setup-interrupted": "Setup was cut off",
  "remove-interrupted": "Removal was cut off",
};

/** Whether a chat can be started in a worktree in this state. A failed or cut-off setup still can (the Open choice). */
export const canStartIn = (w: Worktree) =>
  !!w.managed && w.exists && !w.bare && !["creating", "setup", "removing", "create-interrupted", "remove-interrupted"].includes(w.managed.state);

/** Retry is offered for a failed or cut-off setup, and for a creation cut off after Git made the worktree. */
export const canRetrySetup = (w: Worktree) =>
  !!w.managed && !w.managed.running && (["setup-failed", "setup-interrupted"].includes(w.managed.state) || (w.managed.state === "create-interrupted" && w.locked !== "initializing"));

/** The dirty counts in words, or undefined when clean. */
export function dirtyText(d: Worktree["dirty"]): string | undefined {
  if (!d) return undefined;
  const parts = [
    d.conflicts && `${d.conflicts} in conflict`,
    d.staged && `${d.staged} staged`,
    d.unstaged && `${d.unstaged} changed`,
    d.untracked && `${d.untracked} untracked`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The folder a worktree for `branch` would get by default, as the helper suggests it; shown before the first preview. */
export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "work";
}

/** Whether `cwd` is `root` or inside it. */
export const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/+$/, "")}/`);

/** A chat Hermes has working in a folder: from `GET /api/sessions?cwd_prefix=` in one profile. */
export type HermesChatIn = { id: string; title: string; profile: string; cwd: string; active: boolean };

// ── which chats this computer started in a worktree ─────────────────────────

export const WORKTREE_CHATS_KEY = "hermes-chat.worktree-chats";

/** A chat started in a worktree from this computer: where, and the token holding its place in the server's record. */
export type WorktreeChat = { target: string; repo: string; id: string; path: string; branch: string; token: string };

type ChatsDoc = { v: 1; scopes: Record<string, Record<string, WorktreeChat>> };

function readChats(): ChatsDoc {
  try {
    const doc = JSON.parse(localStorage.getItem(WORKTREE_CHATS_KEY) ?? "null") as unknown;
    if (isObj(doc) && doc.v === 1 && isObj(doc.scopes)) return doc as ChatsDoc;
  } catch {
    // An unreadable copy is no copy: the server's record is the authority.
  }
  return { v: 1, scopes: {} };
}

const chatListeners = new Set<() => void>();

function writeChats(doc: ChatsDoc): boolean {
  try {
    localStorage.setItem(WORKTREE_CHATS_KEY, JSON.stringify(doc));
  } catch {
    return false;
  }
  chatListeners.forEach((f) => f());
  return true;
}

/** This computer's copy of which chat runs in which worktree, for each connection and profile (`scope`). The record on
 * the server is what removal checks; this copy only labels the chat and lets it be detached from its own header. */
export const worktreeChats = {
  get(scope: string, chatId: string): WorktreeChat | undefined {
    return readChats().scopes[scope]?.[chatId];
  },
  /** False: this computer's storage is full or unavailable, and the copy wasn't kept. */
  set(scope: string, chatId: string, chat: WorktreeChat): boolean {
    const doc = readChats();
    doc.scopes[scope] = { ...(doc.scopes[scope] ?? {}), [chatId]: chat };
    return writeChats(doc);
  },
  /** Drops every copy that names a token the server no longer holds for that worktree. */
  forgetToken(token: string) {
    const doc = readChats();
    let changed = false;
    for (const chats of Object.values(doc.scopes))
      for (const [id, c] of Object.entries(chats))
        if (c.token === token) {
          delete chats[id];
          changed = true;
        }
    if (changed) writeChats(doc);
  },
  subscribe(f: () => void) {
    chatListeners.add(f);
    return () => void chatListeners.delete(f);
  },
};

/** A worktree the New chat pane will start its chat in. `scope`: the connection and profile it was picked under. */
export type WorktreeStart = { target: string; repo: string; id: string; path: string; branch: string; scope: string };

/**
 * Starts a chat in a worktree: holds its place in the server's record first (so the worktree can't be removed while
 * Hermes starts it), then `start` (Hermes's `session.create` with the worktree as its `cwd`), then confirms the place
 * with the chat's id. If the chat doesn't start, the place is let go. If it started but the confirm fails, the place
 * stays held (`starting`) and still blocks removal; `warning` says so.
 */
export async function startInWorktree(
  api: WorktreeApi,
  w: WorktreeStart,
  who: { profile: string; connection: string },
  start: () => Promise<string>,
): Promise<{ chatId: string; token: string; warning?: string }> {
  const token = newWorktreeId();
  await api.run(w.target, { op: "worktreeAttach", repo: w.repo, id: w.id, token, profile: who.profile, connection: who.connection });
  let chatId: string;
  try {
    chatId = await start();
  } catch (e) {
    void api.run(w.target, { op: "worktreeDetach", repo: w.repo, id: w.id, token }).catch(() => undefined);
    throw e;
  }
  try {
    await api.run(w.target, { op: "worktreeAttachConfirm", repo: w.repo, id: w.id, token, chat: chatId });
    return { chatId, token };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      chatId,
      token,
      warning: `The chat started in ${w.path}, but the server's worktree record couldn't be updated with it (${why}). The worktree still counts it as a chat starting there, so it can't be removed until you detach it.`,
    };
  }
}
