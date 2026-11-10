// Context files of a project (GLOSSARY.md "Context file", ADR 0135): the files in `<main folder>/context` on the
// server, which every chat in the project gets.
import { previewSupport, type RemoteEntry } from "./remoteFiles";

/** How a file's text is had: as it is, by extraction (`pdf`, `docx`), or not at all (`binary`). */
export type ContextKind = "text" | "pdf" | "docx" | "binary";

/**
 * One file in a project's `context` folder. `version` changes when the file does. `tokens`: the room its text takes;
 * missing when it has no readable text, and then chats get its path only. `size` is missing only where the server
 * can't say it (a file on an SSH profile that isn't text). `mime`: the type the server reports, for its preview.
 */
export type ContextFile = { name: string; path: string; size?: number; version: string; kind: ContextKind; tokens?: number; mime?: string };

/** `full`: chats get the files' text. `list`: the files are over capacity, and chats get their paths. */
export type ContextMode = "full" | "list";

/** The room the files' text takes (`used`) of what a project may use (`limit`), in tokens, and the mode that follows. */
export type Capacity = { used: number; limit: number; mode: ContextMode };

/**
 * What the profile lets the card change. `all`: add, replace and remove any file. `text-only`: its tools run over SSH,
 * where Hermes can write only text into a folder that is already there, and can't remove a file.
 */
export type ContextWrites = "all" | "text-only";

/**
 * The Context card. `unsupported`: the server lacks routes the card needs, named in `missing`. `noFolder`: the project
 * has no main folder yet; `creates` is the folder the first file added would make, missing where none can be made.
 * `ready`: `dir` is the context folder, which is there only if `exists`.
 */
export type ContextState =
  | { kind: "loading" }
  | { kind: "unsupported"; missing: string[] }
  | { kind: "noFolder"; creates?: string; writes: ContextWrites }
  | { kind: "failed"; message: string }
  | { kind: "ready"; dir: string; exists: boolean; files: ContextFile[]; gitNote: boolean; capacity: Capacity; writes: ContextWrites };

/** A file on this computer to add: `path` is known to Rust only (src-tauri `context_pick`, `context_local_files`). */
export type LocalFile = { path: string; name: string; size: number };

export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** The most Hermes writes where a profile's tools run (`POST /api/fs/write-text`). */
export const SSH_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LIMIT_TOKENS = 100_000;
export const SSH_REFUSED = "can't add this file to a project on an SSH profile yet";

export const CONTEXT_DIR = "context";
export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The badge on a file's card and in what chats are told: its extension, or FILE. */
export const typeLabel = (name: string) => extensionOf(name).toUpperCase() || "FILE";

/** A size as chats and the card read it: `1.2 KB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(1)} ${units[unit]}`;
}

export const tokensOf = (bytes: number) => Math.ceil(bytes / 4);
const utf8 = new TextEncoder();
export const bytesOf = (text: string) => utf8.encode(text).length;
const CJK_DENSE = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
/** Hermes's `estimate_tokens_rough` (`agent/model_metadata.py`): a token per CJK, Hangul or Kana character, else a token per four UTF-8 bytes. */
export function tokensOfText(text: string): number {
  const rest = text.replace(CJK_DENSE, "");
  return text.length - rest.length + tokensOf(bytesOf(rest));
}

/**
 * A file's kind from its name and the type the server reports, before anything is read. Undefined: the name doesn't
 * say, and reading it tells.
 */
export function kindByName(name: string, mime?: string): ContextKind | undefined {
  const ext = extensionOf(name);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  const support = previewSupport({ name, path: name, kind: "file", mime });
  if (support.kind === "text") return "text";
  return support.kind === "maybe-text" ? undefined : "binary";
}

/** A listed file before its text is known. `kind` undefined: reading it tells whether it is text. */
export type ListedFile = { name: string; path: string; size?: number; version: string; kind?: ContextKind; mime?: string };

/**
 * The context files among a folder's entries, by name. Folders, hidden files and broken links are left out, and so is
 * a link to a file elsewhere: nothing outside the folder is a context file.
 */
export function listedFiles(entries: readonly RemoteEntry[]): ListedFile[] {
  return entries
    .filter((e) => e.kind === "file" && !e.name.startsWith(".") && !e.linkTarget)
    .map((e) => ({ name: e.name, path: e.path, size: e.size ?? 0, version: `${e.size ?? 0}:${e.modified ?? 0}`, kind: kindByName(e.name, e.mime), ...(e.mime && { mime: e.mime }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a listed file's text must be read to know its kind, its size or the room it takes. */
export const needsRead = (f: ListedFile) => f.size === undefined || (f.kind !== "text" && f.kind !== "binary");

/**
 * A listed file with what reading it found. A text file's room comes from its size alone; an extracted file's from
 * the text extracted. `text` null: it was read and has none.
 */
export function contextFile(f: ListedFile, text?: string | null): ContextFile {
  const kind = f.kind ?? (typeof text === "string" ? "text" : "binary");
  const size = f.size ?? (typeof text === "string" ? bytesOf(text) : undefined);
  const base = { name: f.name, path: f.path, version: f.version, kind, ...(size !== undefined && { size }), ...(f.mime && { mime: f.mime }) };
  if (kind === "binary" || text === null) return base;
  if (kind === "text") return size === undefined ? base : { ...base, tokens: tokensOf(size) };
  return typeof text === "string" ? { ...base, tokens: tokensOfText(text) } : base;
}

/**
 * How full the project is. 100% is half the context window of the project's default model, the most Hermes itself
 * lets attached files take, or `DEFAULT_LIMIT_TOKENS` when the window isn't known. Files without text take no room.
 */
export function capacityOf(files: readonly ContextFile[], window?: number): Capacity {
  const limit = window && window > 0 ? Math.floor(window / 2) : DEFAULT_LIMIT_TOKENS;
  const used = files.reduce((n, f) => n + (f.tokens ?? 0), 0);
  return { used, limit, mode: used <= limit ? "full" : "list" };
}

export const percentUsed = (c: Capacity) => Math.round((c.used / c.limit) * 100);

/**
 * The folder made on the server for a project that has none: the project's name in lower case, every run of other
 * characters a hyphen, at most 48 long, or `project-<id>` when nothing of the name is left.
 */
export function folderSlug(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || `project-${id}`;
}

/** Where a project with no folder gets one, under the profile's own folder on the server. */
export const defaultFolder = (profileHome: string, name: string, id: string) => `${profileHome.replace(/\/+$/, "")}/projects/${folderSlug(name, id)}`;

// Names Hermes keeps credentials under (`hermes_cli/web_routers/files.py`). Its write routes don't refuse them, so
// this app does, here and again in Rust.
const CREDENTIAL_NAMES = new Set([
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  "google_token.json",
  "google_oauth_pending.json",
  "google_oauth.json",
  "webhook_subscriptions.json",
  "bws_cache.json",
  "bws_cache.enc.json",
]);

/** Why a file can't be a context file under `name`, or nothing. */
export function nameProblem(name: string): string | undefined {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) return "that isn't a file name";
  if (name.startsWith(".")) return "hidden files, whose names start with a dot, aren't context files";
  if (CREDENTIAL_NAMES.has(name.toLowerCase())) return "Hermes keeps credentials under that name";
  return undefined;
}

/** The file name Add text content saves a title under: `<title>.md`. */
export function textFileName(title: string): string {
  const clean = title
    .trim()
    .replace(/[/\\\0-\x1f]+/g, "-")
    .replace(/^\.+/, "");
  return /\.md$/i.test(clean) ? clean : `${clean}.md`;
}

/** A batch of files to add: `fresh` go at once, `taken` wait for the owner to say replace, `refused` don't go. */
export type AddPlan = { fresh: LocalFile[]; taken: LocalFile[]; refused: { name: string; why: string }[] };

/**
 * Sorts a batch against the files already there. One file refused, for its size or its name, doesn't hold back the
 * others.
 */
export function planAdd(existing: readonly Pick<ContextFile, "name">[], picked: readonly LocalFile[], writes: ContextWrites): AddPlan {
  const plan: AddPlan = { fresh: [], taken: [], refused: [] };
  const names = new Set(existing.map((f) => f.name));
  const batch = new Set<string>();
  const max = writes === "text-only" ? SSH_MAX_BYTES : MAX_FILE_BYTES;
  for (const f of picked) {
    const bad = nameProblem(f.name);
    if (bad) plan.refused.push({ name: f.name, why: `${f.name} wasn't added: ${bad}.` });
    else if (f.size > max)
      plan.refused.push({
        name: f.name,
        why: `${f.name} wasn't added: it's ${sizeText(f.size)}, over the ${sizeText(max)} a context file can be${writes === "text-only" ? " on an SSH profile" : ""}.`,
      });
    else if (batch.has(f.name)) plan.refused.push({ name: f.name, why: `${f.name} wasn't added twice: two of the files picked have that name.` });
    else {
      batch.add(f.name);
      (names.has(f.name) ? plan.taken : plan.fresh).push(f);
    }
  }
  return plan;
}

/** A project's context files as a chat is about to be told of them. */
export type ContextSet = { project: string; dir: string; files: readonly ContextFile[] };

/** The text read for each file that has any, by the file's path. */
export type ContextTexts = ReadonlyMap<string, string>;

// Hermes expands `@file:`, `@folder:`, `@git:`, `@url:`, `@diff` and `@staged` in a submitted message, and fetches a
// `@url:` (`agent/context_references.py`). A word joiner after the `@` keeps a file's text from being read as one.
// The match is Hermes's `REFERENCE_PATTERN`: an `@` not after a word character or `/`.
const neutralize = (text: string) =>
  text.replace(/(?<![\p{L}\p{N}_/])@(?=(?:diff|staged)(?![\p{L}\p{N}_])|(?:file|folder|git|url):\S)/gu, "@\u2060");

const described = (f: ContextFile) => `${f.path} (${f.size === undefined ? "" : `${sizeText(f.size)}, `}${typeLabel(f.name)})`;
const body = (text: string) => text.replace(/\s+$/, "");

function fullStart(set: ContextSet, texts: ContextTexts): string {
  const withText = set.files.filter((f) => texts.has(f.path));
  const without = set.files.filter((f) => !texts.has(f.path));
  return [
    `Context files from the project "${set.project}". Every chat in this project has them. Each file's text follows its path.`,
    ...withText.map((f) => `## ${described(f)}\n${body(texts.get(f.path)!)}`),
    ...(without.length ? [`These files have no text to include. Open them with your file tools if you need them:\n${without.map((f) => `- ${described(f)}`).join("\n")}`] : []),
  ].join("\n\n");
}

function listStart(set: ContextSet): string {
  return `Context files from the project "${set.project}" are too large to include here. They are in ${set.dir}. Open the ones you need with your file tools:\n${set.files.map((f) => `- ${described(f)}`).join("\n")}`;
}

type Change = { kind: "Added" | "Replaced"; file: ContextFile; text?: string } | { kind: "Removed"; path: string };

function update(project: string, changes: readonly Change[]): string {
  return [
    `The context files of the project "${project}" changed since this chat last got them.`,
    ...changes.map((c) => (c.kind === "Removed" ? `Removed: ${c.path}` : `${c.kind}: ${described(c.file)}${c.text === undefined ? "" : `\n${body(c.text)}`}`)),
  ].join("\n\n");
}

/**
 * What one chat has been told of one project's context files: the mode it was told in, and for each file, by path,
 * the version it knows and whether it has had that version's text.
 */
export type LedgerEntry = { mode: ContextMode; files: Record<string, { version: string; text: boolean }> };

/** What to tell a chat now (`block`, or null for nothing), and what it will then have been told. */
export type Told = { block: string | null; next: LedgerEntry };

/** What a new chat is told as it starts: every file, as text while they fit and by path once they don't. */
export function start(set: ContextSet, texts: ContextTexts, mode: ContextMode): Told {
  const next: LedgerEntry = { mode, files: Object.fromEntries(set.files.map((f) => [f.path, { version: f.version, text: mode === "full" && texts.has(f.path) }])) };
  if (!set.files.length) return { block: null, next };
  return { block: neutralize(mode === "full" ? fullStart(set, texts) : listStart(set)), next };
}

/**
 * What a chat that has `entry` is told before its next message, and its entry afterwards. A chat with no entry has been
 * told nothing, so it gets every file. In full mode it gets the text of each file it hasn't had the text of, and the
 * paths of those removed; a text it has had is never sent again. Going over capacity sends the whole list of paths
 * once; after that, and until the files fit again, only what changed, without text.
 */
export function plan(entry: LedgerEntry | undefined, set: ContextSet, texts: ContextTexts, mode: ContextMode): Told {
  const known = entry?.files ?? {};
  const removed: Change[] = Object.keys(known)
    .filter((path) => !set.files.some((f) => f.path === path))
    .map((path) => ({ kind: "Removed", path }));
  const changes: Change[] = [];
  const files: LedgerEntry["files"] = {};
  for (const file of set.files) {
    const was = known[file.path];
    const same = was?.version === file.version;
    const text = mode === "full" ? texts.get(file.path) : undefined;
    if (!was) changes.push({ kind: "Added", file, text });
    else if (!same) changes.push({ kind: "Replaced", file, text });
    else if (!was.text && text !== undefined) changes.push({ kind: "Added", file, text });
    files[file.path] = { version: file.version, text: text !== undefined || (same && was.text) };
  }
  const next: LedgerEntry = { mode, files };
  if (mode === "list" && entry?.mode !== "list") return { block: set.files.length ? neutralize(listStart(set)) : null, next };
  const all = [...changes, ...removed];
  return { block: all.length ? neutralize(update(set.project, all)) : null, next };
}

/** Whether two entries say the same. */
export function sameEntry(a: LedgerEntry | undefined, b: LedgerEntry): boolean {
  if (!a || a.mode !== b.mode) return false;
  const paths = Object.keys(a.files);
  return paths.length === Object.keys(b.files).length && paths.every((p) => b.files[p]?.version === a.files[p].version && b.files[p].text === a.files[p].text);
}

/** What both Hermes clients hide in a stored message: everything from this line on (branch.ts `typedText`). */
const ATTACHED = "\n\n--- Attached Context ---\n\n";

/** A message as it is submitted with what its chat is told of its projects' context files, which no client shows. */
export const withContext = (text: string, blocks: readonly string[]) => (blocks.length ? `${text}${ATTACHED}${blocks.join("\n\n")}` : text);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A ledger entry as stored; undefined if it isn't one. */
export function toEntry(v: unknown): LedgerEntry | undefined {
  if (!isObj(v) || (v.mode !== "full" && v.mode !== "list") || !isObj(v.files)) return undefined;
  const files: LedgerEntry["files"] = {};
  for (const [path, f] of Object.entries(v.files)) if (isObj(f) && typeof f.version === "string") files[path] = { version: f.version, text: f.text === true };
  return { mode: v.mode, files };
}
