// Reading and changing a project's context files on the server (GLOSSARY.md "Context file", ADR 0135), for the project
// page's Context card and for every send in a project's chat.
import {
  CONTEXT_DIR,
  MAX_FILE_BYTES,
  SSH_REFUSED,
  bytesOf,
  capacityOf,
  contextFile,
  defaultFolder,
  joinPath,
  kindByName,
  listedFiles,
  needsRead,
  plan,
  sameEntry,
  start,
  toEntry,
  type ContextFile,
  type ContextState,
  type ContextTexts,
  type ContextWrites,
  type LedgerEntry,
  type ListedFile,
  type LocalFile,
  type Told,
} from "./projectContext";
import type { LocalFile as PickedFile } from "./pipe";
import type { Project } from "./projects";
import { RemoteFilesError, explain, newTransferId, parseListing, type RemoteEntry, type RemoteGet, type RemotePreview, type TransferProgress } from "./remoteFiles";

/** What Rust answers for a context folder's repository (src-tauri `context_git_exclude`). */
export type GitExclude = "none" | "added" | "already";

/**
 * The Rust commands for context files (src-tauri `context_*`). Server paths are absolute. `sshProfile`: the profile
 * whose tools run over SSH, when the file is on that machine; left out, it is on the dashboard's.
 */
export type ContextPipe = {
  /** The native Open dialog, for any number of files. Empty when the owner closed it. */
  pick(): Promise<PickedFile[]>;
  /** The size of each dropped file, for paths the app was given by a drop; `error` for one it wasn't given. */
  localFiles(paths: string[]): Promise<PickedFile[]>;
  /** Sends a local file to `serverPath`. Rejects with `exists` when a file is there and `overwrite` is off. */
  upload(id: number, local: string, serverPath: string, overwrite: boolean, sshProfile: string | undefined, onProgress: (p: TransferProgress) => void): Promise<void>;
  writeText(serverPath: string, text: string, overwrite: boolean, sshProfile?: string): Promise<void>;
  /** Makes a `context` folder and the folders above it. Resolves to its path as the server has it. */
  mkdir(path: string): Promise<string>;
  remove(serverPath: string): Promise<void>;
  /** A file's text, extracted from a PDF or a Word document; undefined when it has none to read. */
  readText(serverPath: string, size: number, sshProfile?: string): Promise<string | undefined>;
  /** A file where an SSH profile's tools run: its size there, and its text when Hermes sent all of it and it is text. */
  sshFile(serverPath: string, sshProfile: string): Promise<{ size: number; text?: string }>;
  /** Keeps `context/` out of the repository `mainFolder` is in, by its `info/exclude`, unless it is ignored already. */
  gitExclude(mainFolder: string, sshProfile?: string): Promise<GitExclude>;
};

export type ContextFilesIo = {
  get: RemoteGet;
  /** The Rust commands, while connected. */
  pipe(): ContextPipe | undefined;
  /** What the server lacks of what the card needs, for a profile whose tools run over SSH or on the dashboard's machine. */
  lacks(ssh: boolean): string[];
  /** Names the connection, so a text read on one isn't taken for a file on another. */
  scope(): string;
  /** Server files' own preview of a file on the dashboard's machine (remoteFiles.ts). */
  preview(entry: RemoteEntry, asText: boolean): Promise<RemotePreview>;
};

/** Local files to add, and the ones that can't be read on this computer, each with why. */
export type Picked = { files: LocalFile[]; refused: { name: string; why: string }[] };

const picked = (found: PickedFile[]): Picked => ({
  files: found.flatMap((f) => (f.error === undefined && f.size !== undefined ? [{ path: f.path, name: f.name, size: f.size }] : [])),
  refused: found.flatMap((f) => (f.error === undefined && f.size !== undefined ? [] : [{ name: f.name, why: `${f.name} wasn't added: ${f.error ?? "this computer couldn't read it"}.` }])),
});

export type ContextProject = Pick<Project, "id" | "name" | "folders">;

/** A project's main folder: the one Hermes names primary, which every computer agrees on. */
export const mainFolder = (p: ContextProject) => (p.folders.find((f) => f.primary) ?? p.folders[0])?.path;

/** Where files can be added: a card that is `ready`, or one whose project has no folder yet. */
export type AddTarget = Extract<ContextState, { kind: "ready" | "noFolder" }>;

/** A file is already there under that name, and wasn't replaced. */
export class ContextExistsError extends Error {
  constructor(readonly name: string) {
    super(`There's already a ${name} in this project's context files.`);
  }
}

export type ProjectContextFiles = {
  /**
   * The Context card for `project`. Never rejects: what went wrong is the `failed` card. `window`: the context window
   * of the project's default model, when known. `git`: also keep `context/` out of its Git repository.
   */
  read(profile: string, project: ContextProject, opts?: { window?: number; git?: boolean }): Promise<ContextState>;
  /** The text of each of `files` that has any, by path. A file that can't be read now is left out. */
  texts(profile: string, state: Extract<ContextState, { kind: "ready" }>, files: readonly ContextFile[]): Promise<ContextTexts>;
  /** The files the owner picks in the native Open dialog. */
  pick(): Promise<Picked>;
  /** The files dropped on the card, by the paths the drop gave. */
  dropped(paths: string[]): Promise<Picked>;
  /**
   * The folder files go in, made first where it isn't there: for a project with no folder, its folder on the server,
   * which `addFolder` then adds to the project as its main folder.
   */
  folderFor(target: AddTarget, addFolder: (path: string) => Promise<unknown>): Promise<string>;
  /**
   * Adds a local file to the folder `dir`. It counts as added only once a fresh listing shows it at the size sent.
   * Rejects with `ContextExistsError` when the name is taken and `overwrite` is off.
   */
  upload(profile: string, dir: string, writes: ContextWrites, file: LocalFile, overwrite: boolean): Promise<void>;
  /** Saves `text` as the file `name` in `dir`, checked the same way. */
  addText(profile: string, dir: string, writes: ContextWrites, name: string, text: string, overwrite: boolean): Promise<void>;
  /** Deletes a context file from the server. It counts as removed once a fresh listing no longer has it. */
  remove(profile: string, dir: string, file: ContextFile): Promise<void>;
  /** A file's preview, as Server files shows one. On an SSH profile only a file's text can be shown. */
  preview(profile: string, writes: ContextWrites, file: ContextFile): Promise<RemotePreview>;
};

/** A context file as Server files' preview takes it. */
export const asEntry = (f: ContextFile): RemoteEntry => ({ name: f.name, path: f.path, kind: "file", size: f.size, mime: f.mime });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOT_CONNECTED = "Hermes isn't connected. Context files can be changed once it is.";
const TEXTS_KEPT = 300;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

export function projectContextFiles(io: ContextFilesIo): ProjectContextFiles {
  const texts = new Map<string, string | null>();
  const keyOf = (path: string, version: string, ssh?: string) => [io.scope(), ssh ?? "", path, version].join("\n");
  const keep = (key: string, text: string | null) => {
    texts.delete(key);
    texts.set(key, text);
    if (texts.size > TEXTS_KEPT) texts.delete(texts.keys().next().value!);
  };
  const pipe = () => {
    const p = io.pipe();
    if (!p) throw new Error(NOT_CONNECTED);
    return p;
  };
  const json = async (pathAndQuery: string) => JSON.parse(await io.get(pathAndQuery)) as unknown;

  const overSsh = async (profile: string) => {
    const config = await json(`api/config?${new URLSearchParams({ profile })}`);
    return isObj(config) && isObj(config.terminal) && config.terminal.backend === "ssh";
  };
  const homeOf = async (profile: string) => {
    const res = await json("api/profiles");
    const row = (isObj(res) && Array.isArray(res.profiles) ? res.profiles : []).find((p) => isObj(p) && p.name === profile);
    return isObj(row) && typeof row.path === "string" && row.path ? row.path : undefined;
  };

  const listing = async (path: string) => {
    try {
      return parseListing(await io.get(`api/files?${new URLSearchParams({ path })}`), Date.now());
    } catch (e) {
      throw e instanceof RemoteFilesError ? e : explain(messageOf(e), "list");
    }
  };

  const readText = async (f: ListedFile, ssh?: string): Promise<string | null | undefined> => {
    const key = keyOf(f.path, f.version, ssh);
    if (texts.has(key)) return texts.get(key);
    if ((f.size ?? 0) > MAX_FILE_BYTES) return null;
    const p = io.pipe();
    if (!p) return undefined;
    const text = (await p.readText(f.path, f.size ?? 0, ssh)) ?? null;
    keep(key, text);
    return text;
  };

  type Folder = { dir: string; exists: boolean; files: ListedFile[]; main: string };

  const managedFolder = async (main: string): Promise<Folder> => {
    let top;
    try {
      top = await listing(main);
    } catch (e) {
      throw new Error(`Couldn't open the project's main folder ${main}: ${messageOf(e)}`);
    }
    const dir = joinPath(top.path, CONTEXT_DIR);
    let inside;
    try {
      inside = await listing(joinPath(main, CONTEXT_DIR));
    } catch (e) {
      if (e instanceof RemoteFilesError && e.status === 404) return { dir, exists: false, files: [], main: top.path };
      throw new Error(`Couldn't list ${dir}: ${messageOf(e)}`);
    }
    if (inside.path !== dir)
      throw new Error(`${dir} is a link to ${inside.path}, outside the project's main folder. Hermes Chat only uses a context folder that is inside it.`);
    return { dir, exists: true, files: listedFiles(inside.entries), main: top.path };
  };

  /**
   * The context folder where an SSH profile's tools run. `GET /api/fs/list` gives names only, so each file is read for
   * its size, and a file that isn't text has none.
   */
  const sshFolder = async (main: string, profile: string): Promise<Folder> => {
    const dir = joinPath(main, CONTEXT_DIR);
    const res = await json(`api/fs/list?${new URLSearchParams({ path: dir, profile })}`);
    const error = isObj(res) && typeof res.error === "string" ? res.error : "";
    if (error === "ENOENT") return { dir, exists: false, files: [], main };
    if (error) throw new Error(`Couldn't list ${dir} on the SSH machine: ${error}.`);
    const entries = isObj(res) && Array.isArray(res.entries) ? res.entries : [];
    const files: ListedFile[] = [];
    for (const e of entries) {
      if (!isObj(e) || typeof e.name !== "string" || typeof e.path !== "string" || e.isDirectory === true || e.name.startsWith(".")) continue;
      const read = await io.pipe()?.sshFile(e.path, profile).catch(() => undefined);
      const text = read?.text;
      const named = kindByName(e.name);
      const sized = read ? { size: read.size } : {};
      const file: ListedFile =
        text === undefined
          ? { name: e.name, path: e.path, ...sized, version: read ? `${read.size}:unread` : "unread", kind: named === "pdf" || named === "docx" ? named : "binary" }
          : { name: e.name, path: e.path, size: read!.size, version: `${read!.size}:${fnv1a(text)}`, kind: named ?? "text" };
      if (text !== undefined) keep(keyOf(file.path, file.version, profile), text);
      files.push(file);
    }
    return { dir, exists: true, files: files.sort((a, b) => a.name.localeCompare(b.name)), main };
  };

  const folder = (main: string, profile: string, ssh: boolean) => (ssh ? sshFolder(main, profile) : managedFolder(main));

  const listedNow = async (profile: string, dir: string, writes: ContextWrites, name: string) => {
    const main = dir.slice(0, dir.length - CONTEXT_DIR.length - 1);
    const now = await folder(main, profile, writes === "text-only");
    return now.files.find((f) => f.name === name);
  };
  const written = async (profile: string, dir: string, writes: ContextWrites, name: string, size: number) => {
    let found;
    try {
      found = await listedNow(profile, dir, writes, name);
    } catch (e) {
      throw new Error(`Hermes said it saved ${name}, but the folder couldn't be listed to check: ${messageOf(e)}`);
    }
    if (found?.size !== size) throw new Error(`Hermes said it saved ${name}, but ${dir} ${found ? "has it at another size" : "doesn't list it"}. It may not have been written whole.`);
  };
  const refusal = (e: unknown, name: string) => {
    const message = messageOf(e);
    if (message === "exists") return new ContextExistsError(name);
    if (message.includes(SSH_REFUSED)) return new Error(`${name}: ${SSH_REFUSED}. Only text files up to 8 MB can go there.`);
    return new Error(`Couldn't add ${name}: ${message}`);
  };
  const sshOf = (profile: string, writes: ContextWrites) => (writes === "text-only" ? profile : undefined);

  return {
    async read(profile, project, { window, git = false } = {}) {
      try {
        const ssh = await overSsh(profile);
        const writes: ContextWrites = ssh ? "text-only" : "all";
        const missing = io.lacks(ssh);
        if (missing.length) return { kind: "unsupported", missing };
        const main = mainFolder(project);
        if (!main) {
          const home = ssh ? undefined : await homeOf(profile).catch(() => undefined);
          return { kind: "noFolder", writes, ...(home && { creates: defaultFolder(home, project.name, project.id) }) };
        }
        const found = await folder(main, profile, ssh);
        const files: ContextFile[] = [];
        for (const f of found.files) {
          const read = () => (ssh ? (texts.get(keyOf(f.path, f.version, profile)) ?? null) : readText(f).catch(() => undefined));
          files.push(needsRead(f) ? contextFile(f, await read()) : contextFile(f));
        }
        const excluded = git && found.exists ? await io.pipe()?.gitExclude(found.main, sshOf(profile, writes)).catch(() => undefined) : undefined;
        return { kind: "ready", dir: found.dir, exists: found.exists, files, gitNote: excluded === "added" || excluded === "already", capacity: capacityOf(files, window), writes };
      } catch (e) {
        return { kind: "failed", message: messageOf(e) };
      }
    },
    async texts(profile, state, files) {
      const out = new Map<string, string>();
      for (const f of files) {
        if (f.tokens === undefined) continue;
        const text = await readText(f, sshOf(profile, state.writes)).catch(() => undefined);
        if (typeof text === "string") out.set(f.path, text);
      }
      return out;
    },
    pick: async () => picked(await pipe().pick()),
    dropped: async (paths) => picked(await pipe().localFiles(paths)),
    async folderFor(target, addFolder) {
      if (target.kind === "ready") {
        if (target.exists) return target.dir;
        if (target.writes === "text-only") throw new Error(`Make the folder ${target.dir} on the SSH machine first: Hermes can't make a folder there yet.`);
        return pipe().mkdir(target.dir);
      }
      if (!target.creates)
        throw new Error(
          target.writes === "text-only"
            ? "Add a folder to this project first, with a context folder inside it: Hermes can't make a folder on an SSH machine yet."
            : "Add a folder to this project first: Hermes didn't say where this profile's own folder is, so none could be made.",
        );
      const dir = await pipe().mkdir(joinPath(target.creates, CONTEXT_DIR));
      await addFolder(target.creates);
      return dir;
    },
    async upload(profile, dir, writes, file, overwrite) {
      try {
        await pipe().upload(newTransferId(), file.path, joinPath(dir, file.name), overwrite, sshOf(profile, writes), () => {});
      } catch (e) {
        throw refusal(e, file.name);
      }
      await written(profile, dir, writes, file.name, file.size);
    },
    async addText(profile, dir, writes, name, text, overwrite) {
      try {
        await pipe().writeText(joinPath(dir, name), text, overwrite, sshOf(profile, writes));
      } catch (e) {
        throw refusal(e, name);
      }
      await written(profile, dir, writes, name, bytesOf(text));
    },
    async remove(profile, dir, file) {
      if (file.path !== joinPath(dir, file.name)) throw new Error(`${file.name} isn't in ${dir}.`);
      const failed = await pipe()
        .remove(file.path)
        .then(
          () => undefined,
          (e: unknown) => messageOf(e),
        );
      // Hermes answers 404 for a file something else removed meanwhile: gone is what was asked for.
      const still = await listedNow(profile, dir, "all", file.name).catch(() => undefined);
      if (still) throw new Error(failed ? `Couldn't remove ${file.name}: ${failed}` : `Hermes said it removed ${file.name}, but ${dir} still lists it.`);
    },
    async preview(profile, writes, file) {
      if (writes === "all") return io.preview(asEntry(file), file.kind === "text");
      const text = await readText(file, profile);
      const shown = { path: file.path, name: file.name, size: file.size ?? 0 };
      return typeof text === "string" ? { kind: "text", ...shown, text } : { kind: "binary", ...shown, mime: file.mime ?? "application/octet-stream" };
    },
  };
}

export const CONTEXT_LEDGER_KEY = "hermes-chat.projectContext";
const LEDGER_VERSION = 1;
const CHATS_KEPT = 2_000;

/**
 * What each chat has been told of each of its projects' context files (projectContext.ts `LedgerEntry`), kept on this
 * computer for each connection and profile, as project links are (`scope`: projectLinks.ts `projectScope`). A chat
 * with no entry has been told nothing.
 */
export type ContextLedger = {
  get(scope: string, chatId: string, projectId: string): LedgerEntry | undefined;
  set(scope: string, chatId: string, projectId: string, entry: LedgerEntry): void;
  forgetChat(scope: string, chatId: string): void;
};

type LedgerDoc = Record<string, Record<string, Record<string, LedgerEntry>>>;

export function contextLedger(storage: Pick<Storage, "getItem" | "setItem">): ContextLedger {
  let cachedRaw: string | null | undefined;
  let scopes: LedgerDoc = {};
  const current = (): LedgerDoc => {
    let raw: string | null = null;
    try {
      raw = storage.getItem(CONTEXT_LEDGER_KEY);
    } catch {
      return scopes;
    }
    if (raw === cachedRaw) return scopes;
    cachedRaw = raw;
    scopes = {};
    try {
      const doc: unknown = raw === null ? undefined : JSON.parse(raw);
      if (isObj(doc) && doc.v === LEDGER_VERSION && isObj(doc.scopes))
        for (const [scope, chats] of Object.entries(doc.scopes)) {
          if (!isObj(chats)) continue;
          scopes[scope] = {};
          for (const [chat, projects] of Object.entries(chats)) {
            if (!isObj(projects)) continue;
            const entries = Object.entries(projects).flatMap(([id, e]) => {
              const entry = toEntry(e);
              return entry ? [[id, entry] as const] : [];
            });
            if (entries.length) scopes[scope][chat] = Object.fromEntries(entries);
          }
        }
    } catch {}
    return scopes;
  };
  const write = (next: LedgerDoc) => {
    scopes = next;
    try {
      const raw = JSON.stringify({ v: LEDGER_VERSION, scopes: next });
      storage.setItem(CONTEXT_LEDGER_KEY, raw);
      cachedRaw = raw;
    } catch {}
  };
  return {
    get: (scope, chatId, projectId) => current()[scope]?.[chatId]?.[projectId],
    set(scope, chatId, projectId, entry) {
      const all = current();
      const { [chatId]: was, ...others } = all[scope] ?? {};
      // Written last, so the chats told longest ago are the first ones in the object, and the first to go.
      const chats = Object.entries({ ...others, [chatId]: { ...was, [projectId]: entry } }).slice(-CHATS_KEPT);
      write({ ...all, [scope]: Object.fromEntries(chats) });
    },
    forgetChat(scope, chatId) {
      const all = current();
      if (!all[scope]?.[chatId]) return;
      const { [chatId]: _, ...others } = all[scope];
      write({ ...all, [scope]: others });
    },
  };
}

/** What a chat is told with a message: the hidden blocks, and `accepted`, called once Hermes has taken the message. */
export type ChatContext = { blocks: string[]; accepted(chatId: string): void };

/** The projects and membership a chat's context comes from: one connection and profile's `ProjectsStore`. */
export type ContextProjects = {
  readonly scope: string;
  readonly profile: string;
  getSnapshot(): { projects: readonly Project[] };
  projectsOf(chatId: string): Set<string>;
};

/**
 * What chats are told of their projects' context files. `start`: a new chat in `projectId`, everything. `next`: the
 * next message of a chat already open, in every project it is in by membership: what changed since it was last told.
 * Each rereads the folder first. Neither rejects: a folder that can't be read now tells the chat nothing, and its entry
 * stays as it was, so the next send tries again.
 */
export function chatContext(files: ProjectContextFiles, ledger: ContextLedger, projects: ContextProjects, windowOf: (projectId: string) => number | undefined) {
  const tell = async (projectId: string, entry: (() => LedgerEntry | undefined) | "start"): Promise<{ projectId: string; told: Told; was?: LedgerEntry } | undefined> => {
    const project = projects.getSnapshot().projects.find((p) => p.id === projectId && !p.archived);
    if (!project) return undefined;
    const state = await files.read(projects.profile, project, { window: windowOf(projectId) });
    if (state.kind !== "ready") return undefined;
    const set = { project: project.name, dir: state.dir, files: state.files };
    const mode = state.capacity.mode;
    const was = entry === "start" ? undefined : entry();
    const wanted = mode === "full" ? state.files.filter((f) => !(was?.files[f.path]?.version === f.version && was.files[f.path].text)) : [];
    const texts = await files.texts(projects.profile, state, wanted);
    return { projectId, was, told: entry === "start" ? start(set, texts, mode) : plan(was, set, texts, mode) };
  };
  const gather = (all: ({ projectId: string; told: Told; was?: LedgerEntry } | undefined)[]): ChatContext | undefined => {
    const told = all.filter((t) => !!t);
    if (!told.length) return undefined;
    return {
      blocks: told.flatMap((t) => (t.told.block === null ? [] : [t.told.block])),
      accepted: (chatId) => {
        for (const t of told) if (!sameEntry(t.was, t.told.next)) ledger.set(projects.scope, chatId, t.projectId, t.told.next);
      },
    };
  };
  const settled = async <T,>(work: Promise<T>) => work.catch(() => undefined);
  return {
    start: async (projectId: string) => gather([await settled(tell(projectId, "start"))]),
    /** Nothing, at once, for a chat in no project: its message waits for no read. */
    next: (chatId: string) => {
      const ids = [...projects.projectsOf(chatId)].sort();
      if (!ids.length) return undefined;
      return Promise.all(ids.map((id) => settled(tell(id, () => ledger.get(projects.scope, chatId, id))))).then(gather);
    },
  };
}

export type ChatContexts = ReturnType<typeof chatContext>;

/**
 * A model's context window, as a chat running on it reported it (`context_max`). Hermes's model list names no window,
 * so until some chat here has run on the model, none is known.
 */
export function knownWindow(
  chats: readonly { model?: { provider: string; model: string }; live?: { context?: { max: number } } }[],
  model: { provider: string; model: string } | undefined,
): number | undefined {
  if (!model) return undefined;
  return chats.find((c) => c.model?.provider === model.provider && c.model.model === model.model && c.live?.context)?.live?.context?.max;
}
