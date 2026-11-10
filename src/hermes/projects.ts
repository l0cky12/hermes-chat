// Projects: named groups of chats and of folders on the server (GLOSSARY.md "Project", ADR 0131). The project itself,
// its name and its folders, is Hermes's own: the profile's `projects.db`, read and written with the legacy `projects.*`
// JSON-RPC on `/api/ws`, so the official desktop app and `hermes projects` see the same ones. Which chats belong to a
// project is kept by Hermes when it has a membership store (membership.ts, ADR 0109), and on this computer when it
// doesn't (projectLinks.ts). Which project the list shows is always this computer's.
//
// Folders are only references. Nothing here creates, moves or deletes a folder, a repository or a worktree on the
// server: a folder is checked with a read-only directory listing before it is added, and a repository's worktrees are
// read with `git worktree list` (dashboard REST `GET /api/git/worktrees`), never added.
import { savedDefaults, type DefaultsDoc, type DefaultsDraft, type ProjectDefaults } from "./projectDefaults";
import {
  MEMBERSHIP_MIGRATION,
  MembershipUnsupportedError,
  addOp,
  effectiveChats,
  linkKey,
  membershipApi,
  toLinks,
  nextBatch,
  newOpId,
  planMigration,
  mergeChats,
  toChats,
  type Link,
  type MembershipApi,
  type MembershipOp,
  type MigrationPreview,
} from "./membership";
import type { ProjectLinks, ScopeLinks } from "./projectLinks";
import { unscope } from "./templates";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";

/** One of a project's folders: a path on the server. `primary`: the folder Hermes names the project's main one. */
export type ProjectFolder = { path: string; primary: boolean };

/** A project as Hermes stores it. `archived`: archived in another Hermes client; this app lists it no more. */
export type Project = { id: string; name: string; folders: ProjectFolder[]; archived: boolean };

/** One of a git repository's worktrees as `git worktree list` reports it. `main`: the repository's own checkout. */
export type Worktree = { path: string; branch?: string; main: boolean; detached: boolean };

/** How the projects calls reach Hermes: a legacy JSON-RPC request, and a dashboard REST read. */
export type ProjectsIO = {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  get(pathAndQuery: string): Promise<unknown>;
};

/**
 * Hermes's projects for one profile. Every call names the profile, because each profile has its own `projects.db`.
 * Writes answer with the project, or the projects, as Hermes has them afterwards.
 */
export type ProjectsApi = {
  list(profile: string): Promise<Project[]>;
  create(profile: string, name: string): Promise<Project>;
  rename(profile: string, id: string, name: string): Promise<Project>;
  /** Deletes the project and its folder references, never its chats or the folders themselves. */
  delete(profile: string, id: string): Promise<Project[]>;
  addFolder(profile: string, id: string, path: string): Promise<Project>;
  removeFolder(profile: string, id: string, path: string): Promise<Project>;
  /** Resolves if `path` is a folder Hermes can open on the server; rejects saying why not. Reads only. */
  checkFolder(profile: string, path: string): Promise<void>;
  /** The worktrees of the git repository `path` is in; none when it isn't in one. Reads only. */
  worktrees(path: string): Promise<Worktree[]>;
  /** Which chats are in which project, on a Hermes that keeps it (membership.ts). */
  membership?: MembershipApi;
};

/** The longest project name this app sends. Hermes sets no limit; a name this long is a mistake. */
export const PROJECT_NAME_MAX = 200;

// JSON-RPC codes the deployed `bf0203a` answers (`tui_gateway/methods_projects.py`): no such project, invalid
// argument. Older servers have no `projects.*` methods at all.
const NO_SUCH_METHOD = -32601;
const NO_PROJECT = 5062;
const BAD_ARGUMENT = 5063;

/** The project was deleted in another Hermes client meanwhile. */
export class ProjectGoneError extends Error {
  constructor() {
    super("This project isn't on the server any more: it was deleted in another Hermes client.");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const codeOf = (e: unknown) => (isObj(e) && typeof e.code === "number" ? e.code : undefined);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/** A projects call's failure as the owner reads it. */
function projectError(e: unknown): Error {
  const code = codeOf(e);
  if (code === NO_SUCH_METHOD) return new Error("This Hermes server has no projects. Update Hermes to use them.");
  if (code === NO_PROJECT) return new ProjectGoneError();
  if (code === BAD_ARGUMENT && e instanceof Error) return new Error(sentence(e.message));
  return e instanceof Error ? e : new Error(String(e));
}

function toFolder(v: unknown): ProjectFolder | undefined {
  if (!isObj(v) || typeof v.path !== "string" || !v.path) return undefined;
  return { path: v.path, primary: v.is_primary === true };
}

/** A project row as `Project.to_dict` sends it (`hermes_cli/projects_db.py`); undefined if it isn't one. */
export function toProject(v: unknown): Project | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") return undefined;
  const folders = Array.isArray(v.folders) ? v.folders.map(toFolder).filter((f): f is ProjectFolder => !!f) : [];
  return { id: v.id, name: v.name, folders, archived: v.archived === true };
}

function toProjects(v: unknown): Project[] {
  if (!isObj(v) || !Array.isArray(v.projects)) throw new Error("Hermes answered without a list of projects.");
  return v.projects.map(toProject).filter((p): p is Project => !!p);
}

function oneProject(v: unknown): Project {
  const p = isObj(v) ? toProject(v.project) : undefined;
  if (!p) throw new Error("Hermes answered without the project.");
  return p;
}

function toWorktree(v: unknown): Worktree | undefined {
  if (!isObj(v) || typeof v.path !== "string" || !v.path) return undefined;
  return {
    path: v.path,
    ...(typeof v.branch === "string" && v.branch && { branch: v.branch }),
    main: v.isMain === true,
    detached: v.detached === true,
  };
}

/** A project's name as the owner typed it, trimmed; throws saying what is wrong with it. */
export function projectName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Give the project a name.");
  if (name.length > PROJECT_NAME_MAX) throw new Error(`Keep the name under ${PROJECT_NAME_MAX} characters.`);
  return name;
}

/**
 * A folder path on the server as the owner typed it, tidied: one slash between parts, none at the end. Throws saying
 * what is wrong with it. It must be absolute: Hermes would read a relative path from its own home folder.
 */
export function remotePath(raw: string): string {
  const path = raw.trim();
  if (!path) throw new Error("Enter the folder's full path on the server.");
  if (!path.startsWith("/")) throw new Error("Enter the folder's full path on the server, starting with /.");
  if (/[\u0000-\u001f]/.test(path)) throw new Error("That path has characters a folder name can't have.");
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("Enter the path without . or .. in it.");
  return `/${parts.join("/")}`;
}

/** Why `GET /api/fs/list` couldn't list a folder (`_FS_LIST_ERRNO`, `hermes_cli/web_routers/files.py`). */
function folderProblem(path: string, error: string): string {
  if (error === "ENOENT") return `There's no folder at ${path} on the server.`;
  if (error === "ENOTDIR") return `${path} is a file on the server, not a folder.`;
  if (error === "EACCES") return `Hermes isn't allowed to open ${path} on the server.`;
  return `Hermes can't open ${path} on the server: ${error}.`;
}

/** The projects calls over `io` (the dashboard's `/api/ws` and REST, see the research doc "Projects"). */
export function projectsApi(io: ProjectsIO): ProjectsApi {
  const call = async (method: string, params: Record<string, unknown>) => {
    try {
      return await io.rpc(method, params);
    } catch (e) {
      throw projectError(e);
    }
  };
  return {
    list: async (profile) => toProjects(await call("projects.list", { profile })),
    create: async (profile, name) => oneProject(await call("projects.create", { profile, name: projectName(name) })),
    rename: async (profile, id, name) => oneProject(await call("projects.update", { profile, id, name: projectName(name) })),
    delete: async (profile, id) => toProjects(await call("projects.delete", { profile, id })),
    addFolder: async (profile, id, path) => oneProject(await call("projects.add_folder", { profile, id, path: remotePath(path) })),
    removeFolder: async (profile, id, path) => oneProject(await call("projects.remove_folder", { profile, id, path })),
    checkFolder: async (profile, raw) => {
      const path = remotePath(raw);
      const res = await io.get(`api/fs/list?${new URLSearchParams({ path, profile })}`);
      const error = isObj(res) ? res.error : "no answer";
      if (typeof error === "string" && error) throw new Error(folderProblem(path, error));
    },
    worktrees: async (path) => {
      const res = await io.get(`api/git/worktrees?${new URLSearchParams({ path })}`);
      const list = isObj(res) && Array.isArray(res.worktrees) ? res.worktrees : [];
      return list.map(toWorktree).filter((w): w is Worktree => !!w);
    },
    membership: membershipApi(io.rpc),
  };
}

/**
 * Where this connection and profile's membership is kept, and how far it is from Hermes's (ADR 0109).
 * - `unknown`: not asked yet. `checking`: asking Hermes whether it keeps membership.
 * - `local`: Hermes has no membership store, or the owner hasn't moved this computer's to it yet: kept here only.
 * - `preview`: Hermes has one, and this computer has links it doesn't: the move waits for the owner (`preview`).
 * - `syncing`: sending changes or reading Hermes's links. `synced`: nothing waits.
 * - `pending`: changes wait for Hermes, which couldn't be reached (`error` says why), or conflict with it.
 * - `stranded`: moved to Hermes before, but this Hermes no longer answers: the last links read are shown, changes wait.
 */
export type MembershipSync = {
  state: "unknown" | "checking" | "local" | "preview" | "syncing" | "synced" | "pending" | "stranded";
  /** This computer's membership was moved to Hermes: Hermes's links are the ones shown. */
  moved: boolean;
  /** Changes not yet confirmed by Hermes, conflicts among them. */
  pending: readonly MembershipOp[];
  /** The move to Hermes, as the owner is shown it before it runs. `later`: the owner chose Not now. */
  preview?: MigrationPreview & { later?: boolean };
  /** Changes Hermes refused, since this opened: the project or the chat isn't on Hermes any more. */
  refused: readonly { link: Link; why: "no_project" | "no_session" }[];
  error?: string;
  /** When Hermes's links were last read. */
  at?: number;
  /** When this computer's grouping was copied aside before the move, if it was. */
  recoveryAt?: number;
};

/**
 * What the project switcher and the project screen show, for one connection and profile. `projects`: as Hermes listed
 * them last, or as this computer saved them until Hermes is read. `loaded`: read from Hermes since this opened.
 * `selectedId`: the project the chat list shows, if any. `chats`: each project's chats, by project id. `defaults`: each
 * project's defaults for new chats, kept on this computer (projectDefaults.ts).
 */
export type ProjectsSnapshot = {
  profile: string;
  projects: Project[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  selectedId?: string;
  chats: Readonly<Record<string, readonly string[]>>;
  defaults: Readonly<Record<string, ProjectDefaults>>;
  membership: MembershipSync;
};

const withLink = (chats: Record<string, string[]>, l: Link, member: boolean) => {
  const ids = (chats[l.projectId] ?? []).filter((c) => c !== l.chatId);
  const next = member ? [l.chatId, ...ids] : ids;
  const out = { ...chats, [l.projectId]: next };
  if (!next.length) delete out[l.projectId];
  return out;
};

/**
 * One connection and profile's projects: Hermes's projects, and the chats this computer has in each. A new store is
 * made for each profile. It writes only its own scope, so an answer that lands after the profile changed is kept for
 * the profile it was for.
 */
export class ProjectsStore {
  private snap: ProjectsSnapshot;
  private listeners = new Set<() => void>();
  private reads = 0;
  /** The projects' defaults as last read (`readDefaults`). */
  private stored: Record<string, ProjectDefaults> = {};
  private defaultsReads = 0;
  // Project writes return whole snapshots. Keep them in order with list reads so an older reply cannot prune
  // associations created after that request, or restore a project that a later request deleted.
  private pending: Promise<unknown> = Promise.resolve();

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => {});
    return result;
  }

  constructor(
    private api: ProjectsApi,
    private links: ProjectLinks,
    /** Where this computer keeps the profile's links (projectLinks.ts `projectScope`). */
    readonly scope: string,
    readonly profile: string,
    /** Where this computer keeps the projects' defaults (projectDefaults.ts). */
    private defaults: DefaultsDoc = savedDefaults,
  ) {
    this.snap = {
      profile,
      loaded: false,
      loading: false,
      ...this.fromLinks(),
      membership: { state: "unknown", moved: false, pending: [], refused: [] },
    };
    this.setSync({});
    void this.readDefaults();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  /** The project the chat list shows, while Hermes, or this computer, still has it. */
  selected(): Project | undefined {
    return this.snap.projects.find((p) => p.id === this.snap.selectedId);
  }

  /** The projects `chatId` is in, by id. */
  projectsOf(chatId: string): Set<string> {
    return new Set(Object.entries(this.snap.chats).flatMap(([id, chats]) => (chats.includes(chatId) ? [id] : [])));
  }

  /**
   * Reads the profile's projects from Hermes. A project deleted in another client goes, and with it which chats were
   * in it. A failed read keeps what was shown and says why.
   */
  load(): Promise<void> {
    const n = ++this.reads;
    this.set({ loading: true });
    return this.enqueue(async () => {
      try {
        const projects = await this.api.list(this.profile);
        if (n !== this.reads) return;
        this.links.remember(this.scope, projects);
        this.set({ loaded: true, loading: false, error: undefined, ...this.fromLinks() });
      } catch (e) {
        if (n !== this.reads) return;
        this.set({ loading: false, error: `Couldn't read the projects: ${(e as Error).message}` });
        return;
      }
      // Hermes's projects are known now: membership follows them, after another client's changes and this one's.
      await this.syncMembership();
    });
  }

  /**
   * Sends the changes waiting for Hermes and reads its links back, so another computer's changes show too. On a Hermes
   * without a membership store this changes nothing: membership stays on this computer.
   */
  syncNow(): Promise<void> {
    return this.enqueue(() => this.syncMembership());
  }

  /**
   * Moves this computer's membership to Hermes, as the preview showed: the links Hermes doesn't have are sent, the ones
   * it has are left as they are, so it keeps one record of each. This computer's grouping is copied aside first. Safe to
   * run again: a link already there is answered "unchanged", and a move cut short goes on at the next sync.
   */
  migrate(): Promise<void> {
    return this.enqueue(async () => {
      const api = this.api.membership;
      if (!api) throw new MembershipUnsupportedError();
      const { links, revision } = await api.list(this.profile);
      if (!this.moved()) this.commitMove(links, revision);
      await this.syncMembership();
    });
  }

  /** Not now: membership stays on this computer, across restarts, until the owner moves it from the project screen. */
  postponeMigration() {
    this.links.update(this.scope, (s) => ({ ...s, postponed: Date.now() }));
    const preview = this.snap.membership.preview;
    this.setSync({ state: "local", preview: preview && { ...preview, later: true } });
  }

  /**
   * Keeps the owner's change over the one Hermes has: sent again as a new operation over the revision the conflict
   * showed. (The old id would be answered from Hermes's record of it: a conflict again.)
   */
  keepMine(opId: string) {
    this.links.update(this.scope, (s) => ({
      ...s,
      pending: (s.pending ?? []).map((o) => {
        if (o.opId !== opId || !o.conflict) return o;
        const { conflict, ...rest } = o;
        return { ...rest, opId: newOpId(), base: conflict.rev, at: Date.now() };
      }),
    }));
    this.set(this.fromLinks());
    void this.syncNow();
  }

  /** Drops the owner's change: what Hermes has stands. */
  useHermes(opId: string) {
    this.links.update(this.scope, (s) => ({ ...s, pending: (s.pending ?? []).filter((o) => o.opId !== opId) }));
    this.set(this.fromLinks());
    if (!this.snap.membership.pending.length && !this.snap.membership.error) this.setSync({ state: "synced" });
  }

  private moved(s: ScopeLinks = this.links.read(this.scope)) {
    return !!s.synced && s.synced.v >= MEMBERSHIP_MIGRATION;
  }

  /**
   * Makes Hermes's links the ones this computer keeps, and the links only this computer had changes to send. The
   * grouping as it is now, with the links set aside for projects Hermes no longer has, is kept as the recovery copy; an
   * earlier copy is kept rather than replaced.
   */
  private commitMove(server: Link[], revision: number) {
    const at = Date.now();
    this.links.update(this.scope, (s) => {
      const plan = planMigration(s.chats, server, new Set(s.known.map((p) => p.id)));
      const ops: MembershipOp[] = plan.add.map((l) => ({ opId: newOpId(), ...l, member: true, base: revision, at }));
      return {
        ...s,
        recovery: s.recovery ?? { at, chats: mergeChats(s.chats, s.setAside ?? {}) },
        setAside: undefined,
        synced: { v: MEMBERSHIP_MIGRATION, at },
        chats: toChats(server),
        revision,
        acked: undefined,
        postponed: undefined,
        pending: [...(s.pending ?? []), ...ops],
      };
    });
    this.set(this.fromLinks());
  }

  /**
   * One round with Hermes's membership store. Runs in the request queue (`enqueue`).
   */
  private async syncMembership(): Promise<void> {
    const api = this.api.membership;
    if (!api) return this.setSync({ state: this.moved() ? "stranded" : "local" });
    this.setSync({ state: this.moved() ? "syncing" : "checking", error: undefined });
    try {
      let { links, revision } = await api.list(this.profile);
      if (!this.moved()) {
        const s = this.links.read(this.scope);
        const known = new Set(s.known.map((p) => p.id));
        const preview = planMigration(s.chats, links, known);
        // Links to projects Hermes no longer lists, kept aside since (projectLinks.ts `remember`): never sent, always shown.
        preview.noProject = [...preview.noProject, ...toLinks(s.setAside ?? {})];
        // Not now holds until the owner moves, even once Hermes has every link already. With nothing of this computer's
        // to send and no Not now, there is nothing to preview: Hermes's links are used from now.
        const later = s.postponed !== undefined;
        if (preview.add.length || later) return this.setSync({ state: later ? "local" : "preview", preview: { ...preview, ...(later && { later }) } });
        this.commitMove(links, revision);
      }
      if (await this.push(api)) ({ links, revision } = await api.list(this.profile));
      this.links.update(this.scope, (s) => ({ ...s, chats: toChats(links), revision, acked: undefined }));
      this.set(this.fromLinks());
      this.setSync({ state: this.snap.membership.pending.length ? "pending" : "synced", preview: undefined, error: undefined, at: Date.now() });
    } catch (e) {
      if (e instanceof MembershipUnsupportedError) return this.setSync({ state: this.moved() ? "stranded" : "local", preview: undefined });
      const waiting = this.links.read(this.scope).pending?.length ?? 0;
      this.setSync({
        state: this.moved() ? "pending" : "local",
        error: `Couldn't sync which chats are in each project${waiting ? `; ${waiting === 1 ? "1 change waits" : `${waiting} changes wait`} on this computer` : ""}: ${messageOf(e)}`,
      });
    }
  }

  /**
   * Sends the pending changes that aren't conflicts, in batches, and keeps what Hermes answered for each. Resolves with
   * whether anything was sent. Rejects if Hermes couldn't be reached; what wasn't answered stays pending.
   */
  private async push(api: MembershipApi): Promise<boolean> {
    const tried = new Set<string>();
    let sent = false;
    for (;;) {
      const batch = nextBatch(this.links.read(this.scope).pending ?? [], tried);
      if (!batch.length) return sent;
      const ids = new Set(batch.map((o) => o.opId));
      for (const id of ids) tried.add(id);
      // Marked before it goes: if no answer comes back it may still have been applied, so it is never cancelled.
      this.links.update(this.scope, (s) => ({ ...s, pending: (s.pending ?? []).map((o) => (ids.has(o.opId) ? { ...o, sent: true as const } : o)) }));
      const { results } = await api.apply(this.profile, batch);
      sent = true;
      const refused: MembershipSync["refused"][number][] = [];
      this.links.update(this.scope, (s) => {
        let chats = s.chats;
        const acked = { ...s.acked };
        let pending = [...(s.pending ?? [])];
        for (const r of results) {
          const op = batch.find((o) => o.opId === r.opId);
          const at = pending.findIndex((o) => o.opId === r.opId);
          if (!op || at < 0) continue;
          if (r.status === "no_project" || r.status === "no_session") {
            refused.push({ link: { projectId: op.projectId, chatId: op.chatId }, why: r.status });
            pending.splice(at, 1);
            continue;
          }
          // What Hermes has for this link now, and the revision it is known at until the links are read again.
          chats = withLink(chats, op, r.member);
          acked[linkKey(op)] = Math.max(acked[linkKey(op)] ?? 0, r.rev);
          const later = pending.slice(at + 1).find((o) => linkKey(o) === linkKey(op));
          if (r.status === "conflict" && !later) {
            pending[at] = { ...pending[at], conflict: { serverMember: r.member, rev: r.rev } };
            continue;
          }
          // The next change of the same link was made on top of this one (or is the owner's newer choice over a
          // conflict): it follows what Hermes has now, so this computer's own change isn't taken for another client's.
          if (later) pending = pending.map((o) => (o === later ? { ...o, base: Math.max(o.base, r.rev) } : o));
          pending.splice(at, 1);
        }
        return { ...s, chats, acked, pending };
      });
      this.set(this.fromLinks());
      if (refused.length) this.setSync({ refused: [...this.snap.membership.refused, ...refused] });
    }
  }


  /** Shows only `id`'s chats in the list; undefined shows every chat. Kept on this computer. */
  select(id: string | undefined) {
    this.links.select(this.scope, id);
    this.set(this.fromLinks());
  }

  /** Makes a project in Hermes, then shows it. */
  create(name: string): Promise<Project> {
    return this.enqueue(async () => {
      const project = await this.api.create(this.profile, name);
      this.keep(project);
      this.select(project.id);
      return project;
    });
  }

  rename(id: string, name: string): Promise<Project> {
    return this.enqueue(() => this.write(id, () => this.api.rename(this.profile, id, name)));
  }

  /**
   * Deletes the project in Hermes. Its chats stay in Hermes, in the list, and its folders stay on the server; only the
   * project and which chats were in it go.
   */
  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const projects = await this.api.delete(this.profile, id);
        this.links.remember(this.scope, projects);
      } catch (e) {
        if (!(e instanceof ProjectGoneError)) throw e;
        this.links.forgetProject(this.scope, id);
      }
      this.forgetDefaults(id);
      this.set(this.fromLinks());
    });
  }

  /** Checks the folder is there on the server, then adds it to the project. Nothing on the server is created. */
  addFolder(id: string, path: string): Promise<Project> {
    return this.enqueue(async () => {
      await this.api.checkFolder(this.profile, path);
      return this.write(id, () => this.api.addFolder(this.profile, id, path));
    });
  }

  /** Takes the folder out of the project. The folder itself stays on the server. */
  removeFolder(id: string, path: string): Promise<Project> {
    return this.enqueue(() => this.write(id, () => this.api.removeFolder(this.profile, id, path)));
  }

  /**
   * Puts `chatId` in project `id`, or takes it out; the chat itself doesn't change. Once membership is Hermes's, the
   * change is shown at once and waits as an operation until Hermes confirms it; otherwise it is kept on this computer.
   */
  setChat(id: string, chatId: string, inProject: boolean) {
    const s = this.links.read(this.scope);
    if (!this.moved(s)) {
      this.links.setChat(this.scope, id, chatId, inProject);
      this.set(this.fromLinks());
      return;
    }
    this.links.update(this.scope, (sc) => {
      const hermes = !!sc.chats[id]?.includes(chatId);
      const next = { opId: newOpId(), projectId: id, chatId, member: inProject, at: Date.now() };
      // The link's own revision when Hermes answered for it after the last read, so this isn't taken for a conflict.
      const base = Math.max(sc.revision ?? 0, sc.acked?.[linkKey(next)] ?? 0);
      return { ...sc, pending: addOp(sc.pending ?? [], next, hermes, base) };
    });
    this.set(this.fromLinks());
    this.setSync({ state: "pending" });
    void this.syncNow();
  }

  /**
   * Saves project `id`'s defaults for new chats on this computer, over revision `base` (projectDefaults.ts
   * `DefaultsDoc.save`). Chats already started don't change.
   */
  async saveDefaults(id: string, base: number, draft: DefaultsDraft): Promise<ProjectDefaults> {
    try {
      return await this.defaults.save(this.scope, id, base, draft);
    } finally {
      // A conflict means another window or instance saved: show what it saved.
      await this.readDefaults();
    }
  }

  /**
   * Reads the projects' defaults again, as another window or instance may have saved them. Resolves once the
   * snapshot has them; a failed read keeps the ones shown.
   */
  readDefaults(): Promise<void> {
    return this.freshDefaults().then(
      () => {},
      () => {}, // Kept as they were.
    );
  }

  /**
   * The projects' defaults as the file holds them now, for a chat about to start: this read's own answer, whatever other
   * reads are under way. Rejects if the file can't be read, rather than answering what was read before.
   */
  async freshDefaults(): Promise<Readonly<Record<string, ProjectDefaults>>> {
    const n = ++this.defaultsReads;
    const stored = await this.defaults.read(this.scope);
    // Shown only if no newer read was asked for meanwhile; the caller gets this read's answer either way.
    if (n === this.defaultsReads) {
      this.stored = stored;
      this.set(this.fromLinks());
    }
    return stored;
  }

  /** Reads this computer's copies again, after another window changed them. */
  reread() {
    this.set(this.fromLinks());
    void this.readDefaults();
  }

  /** The chat was deleted, so it is in no project any more. */
  forgetChat(chatId: string) {
    this.links.forgetChat(this.scope, chatId);
    this.set(this.fromLinks());
  }

  /** A write to one project. If it was deleted elsewhere meanwhile, it goes from the list too. */
  private async write(id: string, run: () => Promise<Project>): Promise<Project> {
    try {
      const project = await run();
      this.keep(project);
      return project;
    } catch (e) {
      if (e instanceof ProjectGoneError) {
        this.links.forgetProject(this.scope, id);
        this.forgetDefaults(id);
        this.set(this.fromLinks());
      }
      throw e;
    }
  }

  /**
   * Forgets project `id`'s defaults, once Hermes has said it is gone: deleted here, or answering that it no longer
   * exists. A list that merely leaves it out could be older than a save, so it never decides this. Best effort: defaults
   * left behind are never shown or used. Templates offered only in it are kept, offered in every chat (ADR 0028).
   */
  private forgetDefaults(id: string) {
    setUIPrefs({ templates: unscope(getUIPrefs().templates, this.scope, id) });
    void this.defaults.forget(this.scope, id).then(() => this.readDefaults(), () => {});
  }

  private keep(project: Project) {
    const known = this.snap.projects;
    const next = known.some((p) => p.id === project.id) ? known.map((p) => (p.id === project.id ? project : p)) : [...known, project];
    this.links.remember(this.scope, next);
    this.set(this.fromLinks());
  }

  private fromLinks(): Pick<ProjectsSnapshot, "projects" | "selectedId" | "chats" | "defaults"> {
    const s = this.links.read(this.scope);
    const { known, selected } = s;
    const chats = this.moved(s) ? effectiveChats(s.chats, s.pending ?? []) : s.chats;
    const ids = new Set(known.map((p) => p.id));
    const defaults = Object.fromEntries(Object.entries(this.stored).filter(([id]) => ids.has(id)));
    return { projects: known, selectedId: known.some((p) => p.id === selected && !p.archived) ? selected : undefined, chats, defaults };
  }

  /** Changes the membership state shown, with what this computer keeps (moved, pending, recovery copy) read afresh. */
  private setSync(patch: Partial<MembershipSync>) {
    const s = this.links.read(this.scope);
    const pending = this.moved(s) ? (s.pending ?? []) : [];
    this.set({
      membership: { ...this.snap.membership, ...patch, moved: this.moved(s), pending, recoveryAt: s.recovery?.at },
    });
  }

  private set(patch: Partial<ProjectsSnapshot>) {
    // What this computer keeps of the membership sync can change with any write (another window's too): keep it current.
    if (!patch.membership && this.snap) {
      const s = this.links.read(this.scope);
      const moved = this.moved(s);
      patch = { ...patch, membership: { ...this.snap.membership, moved, pending: moved ? (s.pending ?? []) : [], recoveryAt: s.recovery?.at } };
    }
    this.snap = { ...this.snap, ...patch };
    for (const fn of [...this.listeners]) fn();
  }
}
