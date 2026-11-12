// Checking for and installing updates (src-tauri/src/update.rs says who may replace which install). One store for the
// whole app: the launch check, the rail's dot and the Updates section in Settings all read it.
//
// A pacman install of hermes-chat-git is versioned `r<commits>.<commit>` (packaging/aur/PKGBUILD's pkgver). It is
// compared with `main` on GitHub, which is what the PKGBUILD builds, and the pull requests merged since are its release
// notes. Only the package manager installs it; the app then asks to restart. A standalone AppImage built with an
// update key uses Tauri's updater, which verifies the download's signature. Drafts survive the restart (`restart`).

import { restartHold, sending, unsaved } from "./unsaved";
import { clockTime, errorText } from "./values";

export const REPO = "l0cky12/hermes-chat";

export type Install =
  | { kind: "pacman"; package: string; running: string; installed: string | null }
  | { kind: "appImage"; version: string; updater: boolean }
  | { kind: "unmanaged"; version: string; installer?: "nsis" };

/** One line of release notes. Shown as text: a link would take the app's own window to GitHub. */
export type Note = { text: string };

/**
 * An update found. `via`: who installs it, pacman or this app's updater. `command`: how the owner has pacman install
 * it, when the app knows.
 */
export type Found = { from: string; to: string; notes: Note[]; more: number; via: "pacman" | "updater"; allUrl?: string; warning?: string; command?: string };

export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; version: string; note?: string; checkedAt: number }
  | { state: "available"; found: Found; checkedAt: number }
  | { state: "installing"; found: Found; downloaded: number; total?: number; verifying?: boolean }
  /** Installed but not running yet: by this app (`found`), or by pacman meanwhile (`from` → `to`). */
  | { state: "restart"; from: string; to: string; found?: Found }
  | { state: "restarting"; from: string; to: string; found?: Found }
  /** This copy isn't updated from here; `reason` says why and how to update it. */
  | { state: "unsupported"; version: string; reason: string }
  /** `found`: the update the failure was about, still there to try again. */
  | { state: "error"; message: string; found?: Found; restart?: { from: string; to: string; found?: Found }; setAside?: string };

export type Progress = { event: "downloading"; downloaded: number; total: number | null } | { event: "installing" };

export type UpdateDeps = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** Opens a progress channel for a command; returns the value to pass as its `onProgress`. */
  channel: (onMessage: (p: Progress) => void) => unknown;
  fetch: typeof fetch;
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
  /** Deletes the chat lists and Saved copies kept on this computer, to make room for drafts (chatCache.ts). */
  clearCache?: () => void;
  now?: () => number;
  /** How long GitHub gets (`CHECK_TIMEOUT_MS`). */
  checkTimeoutMs?: number;
};

/** Release notes listed before "and N more". */
export const NOTES_SHOWN = 20;

/**
 * How long GitHub gets to answer an update check. Without a limit a check that never answers stays "Checking…", and
 * no check runs after it, not even the quiet one that notices pacman's install when the window is focused.
 */
export const CHECK_TIMEOUT_MS = 20_000;

/** A hermes-chat-git pkgver (`r312.ef433a2-1`, epoch allowed): its commit count and commit. Anything else: null. */
export function parseGitPkgver(version: string): { count: number; commit: string } | null {
  const m = /^(?:\d+:)?r(\d+)\.(?:g)?([0-9a-f]{7,40})(?:-[\d.]+)?$/.exec(version.trim());
  return m ? { count: Number(m[1]), commit: m[2] } : null;
}

type Commit = { sha: string; commit: { message: string }; parents?: unknown[] };
type Compare = { status: string; ahead_by: number; behind_by: number; total_commits?: number; commits: Commit[]; html_url?: string };

/**
 * Release notes from the commits since the installed one, newest first: the pull requests merged, by title, or each
 * commit's first line when nothing came through a pull request. Merges of one branch into another are left out.
 */
export function releaseNotes(commits: Commit[]): Note[] {
  const pulls: Note[] = [];
  const plain: Note[] = [];
  for (const c of [...commits].reverse()) {
    const [subject, ...rest] = c.commit.message.split("\n");
    const pr = /^Merge pull request #(\d+) from \S+/.exec(subject);
    if (pr) {
      const title = rest.map((l) => l.trim()).find(Boolean) ?? subject;
      pulls.push({ text: `#${pr[1]} ${title}` });
    } else if (!/^Merge (remote-tracking )?branch /.test(subject) && (c.parents?.length ?? 1) < 2) {
      plain.push({ text: subject.trim() });
    }
  }
  return pulls.length ? pulls : plain;
}

/** Why GitHub refused, in words the owner can act on. */
async function refusal(res: Response, commit: string, now: number): Promise<string> {
  if (res.status === 404) return `GitHub doesn't know commit ${commit} on ${REPO}, so this build can't be compared with main. Was it built from a fork or a local branch?`;
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const when = reset > now ? ` Try again after ${clockTime(reset)}.` : " Try again later.";
    return `GitHub has had too many update checks from this network.${when}`;
  }
  const body = await res.text().catch(() => "");
  return `GitHub answered ${res.status} to the update check${body ? `: ${body.slice(0, 200)}` : "."}`;
}

/** How the owner installs a newer build of `pkg`, run from their hermes-chat checkout. makepkg fetches main itself; build.sh runs it on a copy of the PKGBUILD, so the checkout stays clean for the next pull. */
export function packageCommand(pkg: string): string | undefined {
  return pkg === "hermes-chat-git" ? "git pull && packaging/aur/build.sh -si" : undefined;
}

/** A pacman install compared with `main` on GitHub. */
export async function checkPackage(
  install: Extract<Install, { kind: "pacman" }>,
  get: typeof fetch,
  now: number,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<UpdateState> {
  const { package: pkg, running } = install;
  const v = parseGitPkgver(running);
  if (!v)
    return {
      state: "unsupported",
      version: `${pkg} ${running}`,
      reason: `pacman installed this copy as ${pkg} ${running}, which isn't a build from main that this app can compare. Update it with your package manager.`,
    };
  // The answer's body too: a connection that stalls halfway mustn't hold the check either.
  const signal = AbortSignal.timeout(timeoutMs);
  const late = () => signal.aborted && { state: "error" as const, message: "GitHub didn't answer the update check in time. Try again." };
  let res: Response;
  try {
    res = await get(`https://api.github.com/repos/${REPO}/compare/${v.commit}...main`, { headers: { Accept: "application/vnd.github+json" }, signal });
  } catch (e) {
    return late() || { state: "error", message: `Couldn't reach GitHub to check for updates: ${errorText(e)}` };
  }
  if (!res.ok) return late() || { state: "error", message: await refusal(res, v.commit, now) };
  let c: Compare;
  try {
    c = await res.json();
    if (typeof c.status !== "string" || typeof c.ahead_by !== "number" || !Array.isArray(c.commits)) throw new Error("not a comparison");
  } catch (e) {
    return late() || { state: "error", message: `GitHub's answer to the update check didn't make sense: ${errorText(e)}` };
  }
  if (c.ahead_by === 0)
    return {
      state: "upToDate",
      version: running,
      note: c.status === "behind" ? "This build has commits that main doesn't have yet." : undefined,
      checkedAt: now,
    };
  // GitHub lists at most 250 commits, oldest first; only a full list ends at main's newest.
  const head = c.commits.length === c.ahead_by ? c.commits[c.commits.length - 1]?.sha.slice(0, 7) : undefined;
  const all = releaseNotes(c.commits);
  return {
    state: "available",
    checkedAt: now,
    found: {
      from: running,
      // On a straight line from the installed commit, main's pkgver is that many commits on.
      to: c.status === "ahead" ? `r${v.count + c.ahead_by}${head ? `.${head}` : ""}` : `main${head ? ` (${head})` : ""}`,
      notes: all.slice(0, NOTES_SHOWN),
      // Plus the commits GitHub left out of a long list.
      more: Math.max(0, all.length - NOTES_SHOWN) + Math.max(0, c.ahead_by - c.commits.length),
      allUrl: c.html_url,
      warning: c.status === "diverged" ? "This build has commits that aren't on main. Updating replaces it with main." : undefined,
      via: "pacman",
      command: packageCommand(pkg),
    },
  };
}

/** The update notes Tauri's updater gives, a line each. */
const noteLines = (body?: string | null): Note[] =>
  (body ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .map((text) => ({ text }));

export type Updater = {
  getSnapshot: () => UpdateState;
  subscribe: (fn: () => void) => () => void;
  /**
   * Checks again; does nothing while a check, install or restart is under way. `installedOnly`: only look for pacman
   * having installed a newer version, without asking GitHub.
   */
  check: (opts?: { installedOnly?: boolean }) => Promise<void>;
  /** Installs the update found (AppImage only). */
  install: () => Promise<void>;
  /** Saves the drafts, then restarts into the installed version. */
  restart: () => Promise<void>;
  /** Puts back the drafts the last restart saved. Run before anything reads a draft. */
  restoreAfterRestart: () => Promise<void>;
};

/**
 * What a restart must not lose, as a snapshot to put back after it: every draft (drafts.ts), every chat's outbox of
 * messages Hermes hasn't confirmed and queue of messages waiting to go, and held messages from before the outbox, not
 * yet moved into it (chatCache.ts).
 */
export const DRAFT_PREFIXES = ["hermes-chat.draft.", "hermes-chat.outbox.", "hermes-chat.queue.", "hermes-chat.undelivered."];
const isDraftKey = (k: string) => DRAFT_PREFIXES.some((p) => k.startsWith(p));

/** The drafts and outboxes in `storage`, with the latest of any its stores couldn't write there (unsaved.ts). */
/** Also marks every message in `sending` captured, and holds every queue (`restartHold`). */
export function snapshotDrafts(storage: UpdateDeps["storage"], pending: ReadonlyMap<string, string | null> = unsaved): string {
  restartHold.on = true;
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    const v = k && isDraftKey(k) ? storage.getItem(k) : null;
    if (k && v !== null) out[k] = v;
  }
  for (const [k, v] of pending) {
    if (!isDraftKey(k)) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  for (const s of sending) {
    s.captured = true;
    if (s.text) out[s.key] = out[s.key] ? `${out[s.key]}\n\n${s.text}` : s.text;
  }
  return JSON.stringify(out);
}

/** What the last restart left to put back (update.rs `Saved`). */
export type Saved = { kind: "none" } | { kind: "text"; text: string } | { kind: "unreadable"; reason: string };

/** The drafts by key in a snapshot `snapshotDrafts` wrote, or why the text isn't one. */
export function readSnapshot(text: string): { drafts: Record<string, string> } | { why: string } {
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch (e) {
    return { why: `it isn't complete JSON (${errorText(e)})` };
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return { why: "it isn't a list of drafts" };
  return { drafts: Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => isDraftKey(e[0]) && typeof e[1] === "string")) };
}

/**
 * Puts back the drafts saved as the app restarted, replacing whatever the webview kept, so the last keystrokes before
 * the restart aren't lost. Run before anything reads a draft. Anything wrong with the snapshot leaves drafts as they are.
 * False: storage refused a write, so keep the snapshot to try again at the next launch. Nothing in the snapshot is
 * lost meanwhile: a refused write leaves the key as it was, and only keys the snapshot doesn't have are deleted.
 */
export function restoreDrafts(storage: Pick<Storage, "length" | "key" | "setItem" | "removeItem">, snapshot: string | null): boolean {
  if (!snapshot) return true;
  let saved: unknown;
  try {
    saved = JSON.parse(snapshot);
  } catch {
    return true;
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return true;
  const entries = Object.entries(saved).filter((e): e is [string, string] => isDraftKey(e[0]) && typeof e[1] === "string");
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && isDraftKey(k) && !(k in saved)) stale.push(k);
  }
  try {
    stale.forEach((k) => storage.removeItem(k));
    entries.forEach(([k, v]) => storage.setItem(k, v));
    return true;
  } catch {
    return false;
  }
}

export function updater(deps: UpdateDeps): Updater {
  const now = deps.now ?? Date.now;
  let state: UpdateState = { state: "idle" };
  const listeners = new Set<() => void>();
  const set = (s: UpdateState) => {
    state = s;
    listeners.forEach((fn) => fn());
  };
  const busy = () => ["checking", "installing", "restarting"].includes(state.state);

  /**
   * A check's result, unless an install or restart got under way meanwhile, or a restart failed or drafts were set
   * aside: nothing a check finds replaces those.
   */
  const settle = (s: UpdateState) => {
    if (!["installing", "restart", "restarting"].includes(state.state) && !(state.state === "error" && (state.restart || state.setAside))) set(s);
  };

  const check = async ({ installedOnly = false } = {}) => {
    // Installed and waiting for a restart: nothing newer matters until then.
    if (busy() || state.state === "restart") return;
    if (!installedOnly) set({ state: "checking" });
    try {
      const install = await deps.invoke<Install>("update_install_kind");
      if (install.kind === "pacman" && install.installed && install.installed !== install.running)
        return settle({ state: "restart", from: install.running, to: install.installed });
      if (installedOnly) return;
      if (install.kind === "unmanaged")
        return settle({
          state: "unsupported",
          version: install.version,
          reason:
            install.installer === "nsis"
              ? "This copy was installed with the Windows installer. To update, download and run a newer installer."
              : "This copy wasn't installed by pacman or as an AppImage, so it isn't updated from here. If you built it from source, pull and build it again.",
        });
      if (install.kind === "pacman") {
        if (install.installed === null)
          return settle({ state: "unsupported", version: install.running, reason: `pacman no longer lists ${install.package}, so there's nothing to compare.` });
        return settle(await checkPackage(install, deps.fetch, now(), deps.checkTimeoutMs));
      }
      if (!install.updater)
        return settle({
          state: "unsupported",
          version: install.version,
          reason: "This AppImage was built without an update key, so it can't check for or install updates. Download a newer build to update.",
        });
      const a = await deps.invoke<{ version: string; current: string; notes?: string | null } | null>("update_check");
      if (!a) return settle({ state: "upToDate", version: install.version, checkedAt: now() });
      const notes = noteLines(a.notes);
      settle({ state: "available", checkedAt: now(), found: { from: a.current, to: a.version, notes: notes.slice(0, NOTES_SHOWN), more: Math.max(0, notes.length - NOTES_SHOWN), via: "updater" } });
    } catch (e) {
      // A quiet look for pacman's install leaves things as they were.
      if (!installedOnly) settle({ state: "error", message: `Couldn't check for updates: ${errorText(e)}` });
    }
  };

  const install = async () => {
    const found = state.state === "available" || state.state === "error" ? state.found : undefined;
    if (!found || found.via !== "updater" || busy()) return;
    set({ state: "installing", found, downloaded: 0 });
    const onProgress = deps.channel((p) => {
      if (state.state !== "installing") return;
      set(p.event === "installing" ? { ...state, verifying: true } : { ...state, downloaded: p.downloaded, total: p.total ?? undefined });
    });
    try {
      await deps.invoke("update_download_and_install", { onProgress });
      set({ state: "restart", from: found.from, to: found.to, found });
    } catch (e) {
      set({ state: "error", message: `Couldn't install ${found.to}: ${errorText(e)}. The version you have is unchanged.`, found });
    }
  };

  const restart = async () => {
    const r: { from: string; to: string; found?: Found } | undefined = state.state === "restart" ? state : state.state === "error" ? state.restart : undefined;
    if (!r || busy()) return;
    const { from, to, found } = r;
    set({ state: "restarting", from, to, found });
    try {
      await deps.invoke("app_restart", { drafts: snapshotDrafts(deps.storage) });
    } catch (e) {
      // ponytail: queues go again at the transport's next change, not at once; add a wake-up if that's ever too late.
      restartHold.on = false;
      set({ state: "error", message: errorText(e), restart: { from, to, found } });
    }
  };

  const restoreAfterRestart = async () => {
    const saved = await deps.invoke<Saved>("restart_drafts_read");
    if (saved.kind === "none") return;
    const read = saved.kind === "text" ? readSnapshot(saved.text) : { why: saved.reason };
    // Not something this app wrote whole (a crash mid-write, a disk error): kept for the owner, never deleted, and
    // nothing in it is put back, since a part of it could be older than what storage has.
    if ("why" in read) {
      const path = await deps.invoke<string>("restart_drafts_set_aside");
      return set({
        state: "error",
        setAside: path,
        message: `The drafts and unsent messages saved for the restart couldn't be read, because ${read.why}, so none were put back. The file is kept at ${path}.`,
      });
    }
    const text = JSON.stringify(read.drafts);
    // A full store: the chat lists and Saved copies are only a copy of what Hermes has, so they go to make room.
    const restored = restoreDrafts(deps.storage, text) || (deps.clearCache?.(), restoreDrafts(deps.storage, text));
    // Never put back again later, over what the owner types from now on.
    if (restored) return void (await deps.invoke("restart_drafts_clear"));
    const path = await deps.invoke<string>("restart_drafts_set_aside");
    set({
      state: "error",
      setAside: path,
      message: `Some drafts and unsent messages from before the restart couldn't be put back, because the app's storage on this computer is full. Their text is saved in ${path}.`,
    });
  };

  return { getSnapshot: () => state, subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)), check, install, restart, restoreAfterRestart };
}

/** Whether the rail shows the update dot. */
export const needsAttention = (s: UpdateState) => s.state === "available" || s.state === "restart" || (s.state === "error" && !!s.setAside);
