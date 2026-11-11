// Outputs: the files Hermes's tools reported writing, found in the chats' stored tool results (GLOSSARY.md "Output",
// ADR 0016). Only a tool that says, in its own structured result, which file it wrote counts: `write_file`, `patch`
// (files it created), `text_to_speech` and `image_generate`. A path that a reply, a terminal command or any other tool
// merely mentions is never an Output.
//
// The stored rows come from dashboard REST `GET /api/sessions/{id}/messages`, the newest first, a bounded number of
// rows per chat and chats per run. A file written by a file tool is on the machine the profile's tools run on (its SSH
// workspace, if it has one): whether it is still there is read with `GET /api/fs/list` on its folder, the route family
// the preview pane reads it through. Audio and images Hermes saves itself are on the dashboard's own machine, read with
// the managed files routes Server files uses (`host`). The index is metadata only (paths, sizes the tool reported, which message made each file), kept on this computer per
// connection and profile; no file's contents are copied.
import { RestError, statusOf } from "./pipe";
import { errorText, isObj } from "./values";

/** A stored row of `GET /api/sessions/{id}/messages` (`SELECT *` from `messages`), as far as Outputs reads it. */
export type StoredRow = {
  id?: number;
  role?: string;
  content?: unknown;
  tool_name?: string | null;
  tool_call_id?: string | null;
  /** The assistant row's tool calls: JSON text as stored, or already parsed. */
  tool_calls?: unknown;
  timestamp?: number | null;
};

/**
 * How a file came to be an Output. `written`: `write_file` wrote it whole. `created`: `patch` created it. `speech`:
 * `text_to_speech` made it. `image`: `image_generate` saved it. `added`: the owner added it here by its path.
 */
export type OutputHow = "written" | "created" | "speech" | "image" | "added";

/**
 * Whether the file was at its path when last checked. `missing`: its folder doesn't list it, or the folder is gone:
 * deleted, moved or renamed, or hidden by Hermes. `forbidden`: the server's user may not open its folder. `folder`:
 * the path is a folder now. `unknown`: the check failed; `why` says how.
 */
export type Availability = { state: "available" | "missing" | "forbidden" | "folder" | "unknown"; checkedAt: number; why?: string };

/**
 * One Output: one file, as one tool call (or the owner) produced it. `host`: it is on the dashboard's own machine
 * (`text_to_speech` audio, an `image_generate` image), not where the profile's tools run; for a profile without an SSH
 * terminal those are the same machine. The same path written by two calls is two
 * Outputs, two versions of the file. `key` is the same however often the chat is indexed: chat, call (or stored row)
 * and path. `callId`: the tool call, to go to it in the chat. `rowId`: the stored row of the tool's result. `at`: when
 * Hermes stored it (Unix ms). `size`: bytes, as the tool reported writing them.
 */
export type Output = {
  key: string;
  chatId?: string;
  path: string;
  how: OutputHow;
  host?: boolean;
  tool?: string;
  callId?: string;
  rowId?: number;
  at?: number;
  size?: number;
  availability?: Availability;
};

/**
 * One chat's Outputs as last indexed. `updatedAt`: the chat's last activity then, so an unchanged chat isn't read
 * again. `partial`: why the index may miss Outputs in it: older rows weren't read, a row was too big to read, or a
 * file tool's result didn't say which file it wrote (older Hermes versions, or a result Hermes cut short).
 */
export type ChatOutputs = { updatedAt: number; indexedAt: number; outputs: Output[]; partial?: IndexGaps };
/** `evicted`: its Outputs were dropped to stay within `OUTPUTS_KEPT`; opening the chat in Outputs reads them again. */
export type IndexGaps = { olderRows?: boolean; bigRows?: number; unlabelled?: number; tooMany?: boolean; evicted?: boolean };

/** The tools whose results name the files they wrote, and how. */
const PRODUCERS = new Set(["write_file", "patch", "text_to_speech", "image_generate"]);

/** Most stored rows read for one chat, newest first; most chats indexed in one run; rows per page. */
export const MAX_ROWS_PER_CHAT = 2000;
export const MAX_CHATS_PER_RUN = 25;
const PAGE_ROWS = 100;
/** The most one page's answer may be. Tool results such as `read_file` can be large; a bigger page is read in smaller ones. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The most of a chat's stored rows read in all; past it, older rows aren't read. */
export const CHAT_MAX_BYTES = 64 * 1024 * 1024;
/** Most Outputs kept for one chat (the newest), and most files the owner can add to one profile. */
export const OUTPUTS_PER_CHAT = 1000;
export const ADDED_MAX = 200;
/** Most folders listed in one availability check. */
export const MAX_FOLDERS_PER_CHECK = 40;
/** The most files one check reads again, naming their chat, after their folder's listing didn't find them. */
export const MAX_CONFIRMS_PER_CHECK = 40;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A path a tool on the server wrote: absolute, or under its home. Anything else is ambiguous and isn't listed. */
export const isOutputPath = (p: unknown): p is string => typeof p === "string" && /^(\/|~\/)./.test(p) && !p.includes("\0") && p.length <= 4096;
const storedMs = (s: unknown) => (typeof s === "number" && s > 0 && s * 1000 <= 8.64e15 ? Math.round(s * 1000) : undefined);

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** The arguments of every tool call the assistant rows made, by call id. */
function callArgs(rows: StoredRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.role !== "assistant" || !r.tool_calls) continue;
    const calls = parseJson(r.tool_calls);
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!isObj(c) || !str(c.id) || !isObj(c.function)) continue;
      const args = parseJson(c.function.arguments);
      if (isObj(args)) out.set(c.id as string, args);
    }
  }
  return out;
}

/**
 * The files one producer tool's stored result says it wrote, or `undefined` when it is a producer's result that
 * doesn't say (an older Hermes, or a result cut short), so the chat's index is marked partial. A failed call made
 * nothing. `args`: the call's arguments, for an older `write_file` result that has no `resolved_path`.
 */
export function producedBy(tool: string, content: unknown, args?: Record<string, unknown>): { path: string; how: OutputHow; size?: number; host?: boolean }[] | undefined {
  const r = parseJson(content);
  if (!isObj(r)) return undefined;
  // A patch that failed part-way still lists the files it created before it failed.
  if (tool === "patch" && Array.isArray(r.files_created) && r.files_created.some(isOutputPath))
    return r.files_created.filter(isOutputPath).map((path) => ({ path, how: "created" as const }));
  if (r.error || r.success === false) return [];
  switch (tool) {
    case "write_file": {
      const listed = Array.isArray(r.files_modified) ? r.files_modified.find(isOutputPath) : undefined;
      const path = [r.resolved_path, listed, args?.path].find(isOutputPath);
      if (!path) return typeof r.bytes_written === "number" ? undefined : [];
      const size = typeof r.bytes_written === "number" && r.bytes_written >= 0 ? r.bytes_written : undefined;
      return [{ path, how: "written", ...(size !== undefined && { size }) }];
    }
    case "patch":
      if (!Array.isArray(r.files_created)) return r.success === true ? [] : undefined;
      return r.files_created.filter(isOutputPath).map((path) => ({ path, how: "created" as const }));
    case "text_to_speech": {
      const paths = Array.isArray(r.file_paths) ? r.file_paths : [r.file_path];
      const found = paths.filter(isOutputPath);
      // Hermes saves the audio itself, on the dashboard's machine (`tools/tts_tool.py` `_default_output_dir`).
      return found.length ? found.map((path) => ({ path, how: "speech" as const, host: true })) : undefined;
    }
    case "image_generate": {
      // `image` is the file Hermes saved on the dashboard's machine, or the provider's URL when it saved none: a web
      // address isn't a Server file. With a non-local terminal, `agent_visible_image` is the same file where the tools
      // run, which is where the preview reads.
      if (isOutputPath(r.agent_visible_image)) return [{ path: r.agent_visible_image, how: "image" }];
      const path = [r.host_image, r.image].find(isOutputPath);
      if (path) return [{ path, how: "image", host: true }];
      return typeof r.image === "string" && /^https?:/i.test(r.image) ? [] : undefined;
    }
  }
  return [];
}

/** The Outputs in a chat's stored rows (any order), and how many file tools' results didn't say what they wrote. */
export function outputsFromRows(chatId: string, rows: StoredRow[]): { outputs: Output[]; unlabelled: number } {
  const args = callArgs(rows);
  const found = new Map<string, Output>();
  let unlabelled = 0;
  for (const r of rows) {
    const tool = r.role === "tool" ? (r.tool_name ?? "") : "";
    if (!PRODUCERS.has(tool)) continue;
    const callId = str(r.tool_call_id);
    const made = producedBy(tool, r.content, callId ? args.get(callId) : undefined);
    if (!made) {
      unlabelled++;
      continue;
    }
    const rowId = typeof r.id === "number" ? r.id : undefined;
    const at = storedMs(r.timestamp);
    for (const m of made) {
      const key = outputKey(chatId, callId ?? (rowId !== undefined ? `row:${rowId}` : ""), m.path);
      if (found.has(key) || (!callId && rowId === undefined)) continue;
      found.set(key, { key, chatId, path: m.path, how: m.how, ...(m.host && { host: true }), tool, ...(callId && { callId }), ...(rowId !== undefined && { rowId }), ...(at && { at }), ...(m.size !== undefined && { size: m.size }) });
    }
  }
  return { outputs: [...found.values()], unlabelled };
}

/** The result fields `producedBy` reads; everything else in a stored result (a patch's diff, say) is dropped at once. */
const RESULT_FIELDS = ["error", "success", "resolved_path", "files_modified", "files_created", "bytes_written", "file_path", "file_paths", "image", "host_image", "agent_visible_image"];

/**
 * A page of stored rows cut down to what finding Outputs needs, so a chat's whole history isn't held while it is read:
 * producer tool rows with only the result fields `producedBy` reads, and the producer calls of assistant rows with only
 * their `path` argument. Every other row goes.
 */
export function compactRows(rows: StoredRow[]): StoredRow[] {
  return rows.flatMap((r): StoredRow[] => {
    if (r.role === "tool" && PRODUCERS.has(r.tool_name ?? "")) {
      const parsed = parseJson(r.content);
      const content = isObj(parsed) ? Object.fromEntries(RESULT_FIELDS.filter((k) => k in parsed).map((k) => [k, parsed[k]])) : null;
      return [{ id: r.id, role: "tool", tool_name: r.tool_name, tool_call_id: r.tool_call_id, timestamp: r.timestamp, content }];
    }
    if (r.role !== "assistant" || !r.tool_calls) return [];
    const calls = parseJson(r.tool_calls);
    if (!Array.isArray(calls)) return [];
    const kept = calls.flatMap((c) => {
      if (!isObj(c) || !str(c.id) || !isObj(c.function) || c.function.name !== "write_file") return [];
      const args = parseJson(c.function.arguments);
      return isObj(args) && isOutputPath(args.path) ? [{ id: c.id, function: { name: "write_file", arguments: { path: args.path } } }] : [];
    });
    return kept.length ? [{ id: r.id, role: "assistant", tool_calls: kept }] : [];
  });
}

export const outputKey = (chatId: string, producer: string, path: string) => JSON.stringify([chatId, producer, path]);

// --- How an Output reads on screen ---

/** Text direction and other invisible control characters, which can disguise a name (`evil‮gnp.exe`). */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** A file name as it is shown: invisible and direction-changing characters are made visible as `�`. */
export const shownName = (path: string) => (path.replace(/\/+$/, "").split("/").pop() || path).replace(HIDDEN_CHARS, "�");
/** A whole path, made safe the same way. */
export const shownPath = (path: string) => path.replace(HIDDEN_CHARS, "�");

export type OutputType = "image" | "text" | "document" | "media" | "archive" | "other";
export const TYPE_LABEL: Record<OutputType, string> = {
  image: "Image",
  text: "Text or code",
  document: "Document",
  media: "Audio or video",
  archive: "Archive",
  other: "Other",
};
const TYPE_EXTENSIONS: [OutputType, string][] = [
  ["image", "png jpg jpeg gif webp bmp svg ico avif tif tiff"],
  ["media", "mp3 ogg oga opus wav flac m4a aac mp4 webm mkv mov avi"],
  ["document", "pdf doc docx odt rtf xls xlsx ods ppt pptx odp epub"],
  ["archive", "zip tar gz tgz bz2 xz zst 7z rar whl deb"],
  [
    "text",
    "md markdown txt log csv tsv json jsonl yaml yml toml ini cfg conf xml html htm css scss js jsx mjs cjs ts tsx py rb go rs java kt c h cc cpp hpp cs swift sh bash zsh sql graphql proto vue svelte tex rst org diff patch ipynb",
  ],
];
const BY_EXTENSION = new Map(TYPE_EXTENSIONS.flatMap(([type, exts]) => exts.split(" ").map((e) => [e, type] as const)));

export const extensionOf = (path: string) => /\.([a-z0-9]{1,10})$/i.exec(shownName(path))?.[1].toLowerCase() ?? "";
export const typeOf = (path: string): OutputType => BY_EXTENSION.get(extensionOf(path)) ?? "other";

/** The most an image preview reads: Hermes's `read-data-url` limit. Text previews show the first 512 KB of any size. */
export const IMAGE_PREVIEW_MAX = 16 * 1024 * 1024;

/** Why a file found missing can't be opened: what the check found, and how to look for it. */
const missingWhy = (a: Availability) => `${a.why ?? "The file isn't at this path any more."} Check again, or look in its folder.`;

/** Whether the preview pane can show the file, and why not. */
export function previewable(o: Output): { ok: true } | { ok: false; why: string } {
  if (o.availability?.state === "missing") return { ok: false, why: missingWhy(o.availability) };
  if (o.availability?.state === "folder") return { ok: false, why: "This path is a folder now." };
  const type = typeOf(o.path);
  if (type === "image" && o.size !== undefined && o.size > IMAGE_PREVIEW_MAX) return { ok: false, why: "It's too large to preview (over 16 MB)." };
  if (type === "image" || type === "text") return { ok: true };
  if (type === "other" && !extensionOf(o.path)) return { ok: true };
  return { ok: false, why: `The preview can't show ${TYPE_LABEL[type].toLowerCase()} files.` };
}

/** The most the artifact editor opens (textEdit.ts `EDIT_MAX_BYTES`). */
const EDIT_MAX = 1024 * 1024;

/**
 * Whether the file can be opened in the artifact editor beside the chat (ADR 0029), and why not: a text file, such as
 * Markdown, plain text or code, that a tool wrote or the owner added, up to 1 MB. The editor itself checks the bytes
 * (UTF-8, one kind of line end) once it reads them.
 */
export function editable(o: Output): { ok: true } | { ok: false; why: string } {
  if (o.how === "speech" || o.how === "image") return { ok: false, why: "Only text files can be edited." };
  if (o.availability?.state === "missing") return { ok: false, why: missingWhy(o.availability) };
  if (o.availability?.state === "folder") return { ok: false, why: "This path is a folder now." };
  if (o.size !== undefined && o.size > EDIT_MAX) return { ok: false, why: "It's over 1 MB, the most the editor opens." };
  const type = typeOf(o.path);
  if (type === "text" || (type === "other" && !extensionOf(o.path))) return { ok: true };
  return { ok: false, why: "Only text files, such as Markdown or plain text, can be edited." };
}

/** What made it, in a few words. */
export const HOW_LABEL: Record<OutputHow, string> = {
  written: "Written by write_file",
  created: "Created by patch",
  speech: "Spoken by text_to_speech",
  image: "Made by image_generate",
  added: "Added by you",
};

export type Version = { n: number; of: number; latest: boolean };

/**
 * Each Output's version among the Outputs at the same path, oldest first by when it was stored. Only the latest one
 * is what the path holds now (if it is still there).
 */
export function versions(outputs: Output[]): Map<string, Version> {
  const byPath = new Map<string, Output[]>();
  // The same path on the dashboard's machine and where the tools run is two files, not two versions of one.
  for (const o of outputs) if (o.how !== "added") byPath.set(placeOf(o), [...(byPath.get(placeOf(o)) ?? []), o]);
  const out = new Map<string, Version>();
  for (const list of byPath.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.rowId ?? 0) - (b.rowId ?? 0));
    sorted.forEach((o, i) => out.set(o.key, { n: i + 1, of: sorted.length, latest: i === sorted.length - 1 }));
  }
  return out;
}

// --- Reading Hermes ---

/** How the index reaches Hermes, for one profile. Both reject with the transport's message. */
export type OutputsIo = {
  /** One page of a chat's stored rows, newest first, refused past `maxBytes`; `bytes`: how big the answer was. */
  rows(chatId: string, offset: number, limit: number, maxBytes: number): Promise<{ rows: StoredRow[]; bytes: number }>;
  /**
   * A folder's entries, or none and an errno-like `error` (`ENOENT`, `ENOTDIR`, `EACCES`): where the profile's tools
   * run (`GET /api/fs/list`), or with `host` on the dashboard's own machine (`GET /api/files`).
   */
  listDir(path: string, host?: boolean): Promise<{ entries: { name: string; isDirectory: boolean }[]; error?: string }>;
  /**
   * Whether the file is there, read as Preview reads it (`GET /api/fs/read-text`) naming `session`, the chat whose
   * sandbox it is in (ADR 0062). For an Output its folder's listing didn't find: `fs/list` takes no chat, so for a
   * container path it lists the profile's own `/workspace`, not the chat's. Undefined when Hermes no longer has the
   * chat, so the listing's answer stands.
   */
  confirm?(path: string, session: string): Promise<Omit<Availability, "checkedAt"> | undefined>;
};

const TOO_BIG = /over the .* MB limit/;
/** FastAPI's own 404 for a route the server doesn't have. */
const noRoute = (e: unknown) => e instanceof RestError && e.status === 404 && e.detail === "Not Found";

/** The routes Outputs needs aren't on this server. */
export class OutputsUnsupported extends Error {}

/**
 * Reads a chat's newest stored rows, at most `MAX_ROWS_PER_CHAT`, a page at a time; a page too big to read is read in
 * smaller ones, and a single row too big is skipped and counted.
 */
export async function readRows(io: OutputsIo, chatId: string, stillWanted: () => boolean): Promise<{ rows: StoredRow[]; partial: IndexGaps }> {
  const rows: StoredRow[] = [];
  const partial: IndexGaps = {};
  let offset = 0;
  let limit = PAGE_ROWS;
  let read = 0;
  while (offset < MAX_ROWS_PER_CHAT && stillWanted()) {
    if (read >= CHAT_MAX_BYTES) {
      partial.olderRows = true;
      return { rows, partial };
    }
    const want = Math.min(limit, MAX_ROWS_PER_CHAT - offset);
    let page: StoredRow[];
    const max = Math.min(PAGE_MAX_BYTES, CHAT_MAX_BYTES - read);
    try {
      const answer = await io.rows(chatId, offset, want, max);
      page = answer.rows;
      read += answer.bytes;
    } catch (e) {
      const message = errorText(e);
      if (noRoute(e)) throw new OutputsUnsupported("This Hermes server can't list a chat's stored messages (GET /api/sessions/{id}/messages).");
      if (e instanceof RestError || !TOO_BIG.test(message)) throw e;
      // A refused page was read up to its limit before Rust stopped, so it spends that much of the budget.
      read += max;
      if (read >= CHAT_MAX_BYTES) {
        // The budget is spent: the rest is older than what was read.
        partial.olderRows = true;
        return { rows, partial };
      }
      if (want > 1) {
        limit = Math.max(1, Math.floor(want / 5));
        continue;
      }
      partial.bigRows = (partial.bigRows ?? 0) + 1;
      offset += 1;
      limit = PAGE_ROWS;
      continue;
    }
    rows.push(...compactRows(page));
    offset += page.length;
    if (page.length < want) return { rows, partial };
    limit = PAGE_ROWS;
  }
  if (offset >= MAX_ROWS_PER_CHAT) partial.olderRows = true;
  return { rows, partial };
}

/** The folder a path is in, and its name there. */
export function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\/+$/, "");
  const at = clean.lastIndexOf("/");
  if (at < 0) return { dir: "~", name: clean.slice(2) };
  return { dir: at === 0 ? "/" : clean.slice(0, at), name: clean.slice(at + 1) };
}

/**
 * The chat whose sandbox an Output's path is in, which every read and save of it names as `session_id` (ADR 0062):
 * for a file a tool wrote where the profile's tools run, its chat. With a Docker terminal backend that mounts each
 * chat's folder at `/workspace`, `/workspace/x` is a different file in each chat, and Hermes finds the right one only
 * when told the chat. Files on the dashboard's machine (`host`) and files the owner added by path name none.
 */
export const sessionOf = (o: Pick<Output, "how" | "host" | "chatId">): string | undefined => (!o.host && o.how !== "added" ? o.chatId : undefined);

/** Where a file is: its path, on the tools' machine or (`host`) the dashboard's. Availability is kept by this. */
export const placeOf = (o: { path: string; host?: boolean }) => `${o.host ? "host" : "tools"}:${o.path}`;

const FOLDER_ERRORS: Record<string, Omit<Availability, "checkedAt">> = {
  ENOENT: { state: "missing", why: "Its folder isn't on the server any more." },
  ENOTDIR: { state: "missing", why: "Its folder isn't a folder any more." },
  EACCES: { state: "forbidden", why: "The Hermes server's user isn't allowed to open its folder." },
};

/**
 * Checks where each file is now, one folder listing per folder and machine, at most `MAX_FOLDERS_PER_CHECK` folders;
 * files past that get no answer. Answers are keyed by `placeOf`. Rejects with `OutputsUnsupported` on a server without
 * `GET /api/fs/list`.
 */
export async function checkPaths(io: OutputsIo, files: { path: string; host?: boolean }[], now = Date.now()): Promise<Map<string, Availability>> {
  const byDir = new Map<string, { dir: string; host: boolean; files: { path: string; host?: boolean }[] }>();
  for (const f of files) {
    const { dir } = splitPath(f.path);
    const key = placeOf({ path: dir, host: f.host });
    if (!byDir.has(key) && byDir.size >= MAX_FOLDERS_PER_CHECK) continue;
    const group = byDir.get(key) ?? { dir, host: !!f.host, files: [] };
    group.files.push(f);
    byDir.set(key, group);
  }
  const out = new Map<string, Availability>();
  for (const { dir, host, files: inDir } of byDir.values()) {
    let listing: Awaited<ReturnType<OutputsIo["listDir"]>>;
    try {
      listing = await io.listDir(dir, host);
    } catch (e) {
      const message = errorText(e);
      if (noRoute(e) && !host) throw new OutputsUnsupported("This Hermes server can't list folders for the preview (GET /api/fs/list).");
      const forbidden = statusOf(e) === 403;
      for (const p of inDir) out.set(placeOf(p), forbidden ? { state: "forbidden", checkedAt: now, why: "The server refused to list its folder." } : { state: "unknown", checkedAt: now, why: message });
      continue;
    }
    const err = listing.error ? (FOLDER_ERRORS[listing.error] ?? { state: "unknown" as const, why: `The server couldn't list its folder (${listing.error}).` }) : undefined;
    const names = new Map(listing.entries.map((e) => [e.name, e.isDirectory]));
    for (const f of inDir) {
      const p = placeOf(f);
      const { name } = splitPath(f.path);
      if (err) out.set(p, { ...err, checkedAt: now });
      else if (!names.has(name))
        out.set(p, { state: "missing", checkedAt: now, why: "Its folder doesn't list it: it was deleted, moved or renamed, or Hermes hides it." });
      else out.set(p, names.get(name) ? { state: "folder", checkedAt: now } : { state: "available", checkedAt: now });
    }
  }
  return out;
}

// --- What this computer keeps ---

export const OUTPUTS_KEY = "hermes-chat.outputs";
/**
 * The shape the document has now. Version 1 kept no `host`, so every audio file and image it found would be checked on
 * the wrong machine: its chats are read again, and only the files the owner added are kept.
 */
const OUTPUTS_VERSION = 2;
/** Most connections and profiles kept, and Outputs kept for one; the least recently indexed chats go first. */
const SCOPES_KEPT = 8;
export const OUTPUTS_KEPT = 3000;

/** One connection and profile's index. `usedAt`: when it was last read or written, to keep the most recent scopes. */
export type ScopeIndex = { chats: Record<string, ChatOutputs>; added: Output[]; usedAt: number };
type Doc = { v: number; scopes: Record<string, ScopeIndex> };
export type OutputsStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY_SCOPE = (): ScopeIndex => ({ chats: {}, added: [], usedAt: 0 });

function cleanOutput(v: unknown): Output | undefined {
  if (!isObj(v) || typeof v.key !== "string" || !isOutputPath(v.path)) return undefined;
  const how = ["written", "created", "speech", "image", "added"].includes(v.how as string) ? (v.how as OutputHow) : undefined;
  if (!how) return undefined;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  const a = isObj(v.availability) && typeof v.availability.state === "string" && num(v.availability.checkedAt) !== undefined ? (v.availability as Availability) : undefined;
  return {
    key: v.key,
    path: v.path,
    how,
    ...(v.host === true && { host: true }),
    ...(str(v.chatId) && { chatId: v.chatId as string }),
    ...(str(v.tool) && { tool: v.tool as string }),
    ...(str(v.callId) && { callId: v.callId as string }),
    ...(num(v.rowId) !== undefined && { rowId: v.rowId as number }),
    ...(num(v.at) !== undefined && { at: v.at as number }),
    ...(num(v.size) !== undefined && { size: v.size as number }),
    ...(a && { availability: { state: a.state, checkedAt: a.checkedAt, ...(str(a.why) && { why: a.why }) } }),
  };
}

function cleanScope(v: unknown): ScopeIndex {
  if (!isObj(v)) return EMPTY_SCOPE();
  const chats: Record<string, ChatOutputs> = {};
  if (isObj(v.chats))
    for (const [id, c] of Object.entries(v.chats)) {
      if (!isObj(c) || typeof c.updatedAt !== "number" || !Array.isArray(c.outputs)) continue;
      chats[id] = {
        updatedAt: c.updatedAt,
        indexedAt: typeof c.indexedAt === "number" ? c.indexedAt : 0,
        outputs: c.outputs.flatMap((o) => cleanOutput(o) ?? []),
        ...(isObj(c.partial) && { partial: c.partial as IndexGaps }),
      };
    }
  const added = Array.isArray(v.added) ? v.added.flatMap((o) => cleanOutput(o) ?? []).slice(-ADDED_MAX) : [];
  return { chats, added, usedAt: typeof v.usedAt === "number" ? v.usedAt : 0 };
}

export function readScope(storage: OutputsStorage, scope: string): ScopeIndex {
  try {
    const doc = JSON.parse(storage.getItem(OUTPUTS_KEY) ?? "null") as Doc | null;
    if (isObj(doc) && doc.v === 1 && isObj(doc.scopes) && isObj(doc.scopes[scope])) return { ...cleanScope(doc.scopes[scope]), chats: {} };
    return cleanScope(isObj(doc) && doc.v === OUTPUTS_VERSION && isObj(doc.scopes) ? doc.scopes[scope] : undefined);
  } catch {
    return EMPTY_SCOPE();
  }
}

/** Keeps `index` as `scope`'s, within the limits. Returns false when the storage refused it. */
export function writeScope(storage: OutputsStorage, scope: string, index: ScopeIndex): boolean {
  let doc: Doc;
  try {
    const read = JSON.parse(storage.getItem(OUTPUTS_KEY) ?? "null") as Doc | null;
    doc =
      isObj(read) && read.v === OUTPUTS_VERSION && isObj(read.scopes)
        ? read
        : isObj(read) && read.v === 1 && isObj(read.scopes)
          ? { v: OUTPUTS_VERSION, scopes: Object.fromEntries(Object.entries(read.scopes).map(([k, v]) => [k, { ...cleanScope(v), chats: {} }])) }
          : { v: OUTPUTS_VERSION, scopes: {} };
  } catch {
    doc = { v: OUTPUTS_VERSION, scopes: {} };
  }
  doc.scopes[scope] = trimmed(index);
  const kept = Object.entries(doc.scopes).sort(([, a], [, b]) => (b.usedAt ?? 0) - (a.usedAt ?? 0)).slice(0, SCOPES_KEPT);
  try {
    storage.setItem(OUTPUTS_KEY, JSON.stringify({ v: OUTPUTS_VERSION, scopes: Object.fromEntries(kept) }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The index within `OUTPUTS_KEPT` Outputs: the Outputs of the chats indexed longest ago are dropped first. Each such
 * chat keeps its entry, marked `evicted`, so a profile-wide run doesn't read it again and push out another, round and
 * round; opening the chat in Outputs reads it again. Applied to what is shown as well as to what is kept.
 *
 * Records themselves aren't capped here: a record is what says a chat was read, and dropping one makes runs read it
 * again ahead of chats never read. They are bounded instead by the profile's chat list (`OutputsIndex.keepOnly`), which
 * this computer keeps a copy of anyway; a record with no Outputs is a few dozen bytes.
 */
function trimmed<T extends Pick<ScopeIndex, "chats" | "added">>(index: T): T {
  let total = index.added.length + Object.values(index.chats).reduce((n, c) => n + c.outputs.length, 0);
  if (total <= OUTPUTS_KEPT) return index;
  const chats = { ...index.chats };
  for (const [id, c] of Object.entries(chats).sort(([, a], [, b]) => a.indexedAt - b.indexedAt)) {
    if (total <= OUTPUTS_KEPT) break;
    if (!c.outputs.length) continue;
    total -= c.outputs.length;
    chats[id] = { ...c, outputs: [], partial: { ...c.partial, evicted: true } };
  }
  return { ...index, chats };
}

// --- The index for one connection and profile ---

/**
 * What the Outputs screen shows. `indexing`: a run is reading chats, `done` of `total`. `waiting`: chats in the last
 * run's scope that weren't read because of the per-run limit. `error`: why the last run or check failed.
 * `unsupported`: this server lacks a route Outputs needs. `notSaved`: this computer's storage refused the index.
 * `checkingSince`: when the `refresh` under way started; an Output checked before then is still being checked again.
 */
export type OutputsSnapshot = {
  chats: Record<string, ChatOutputs>;
  added: Output[];
  indexing?: { done: number; total: number };
  checking?: boolean;
  checkingSince?: number;
  waiting: number;
  error?: string;
  unsupported?: string;
  notSaved?: boolean;
};

/** A chat to index: its id and last activity. */
export type ChatRef = { id: string; updatedAt: number };

export class OutputsIndex {
  private snap: OutputsSnapshot;
  private listeners = new Set<() => void>();
  /** Bumped by every run, check and `cancel`; an answer for an older one is dropped. */
  private runSeq = 0;
  private checkSeq = 0;

  constructor(
    private readonly io: OutputsIo,
    private readonly storage: OutputsStorage,
    readonly scope: string,
    private readonly now: () => number = Date.now,
  ) {
    const kept = readScope(storage, scope);
    this.snap = { chats: kept.chats, added: kept.added, waiting: 0 };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  /** False once the screen has let go of this index (another profile, sign-out): nothing it reads then lands or is kept. */
  private live = true;
  /** Bumped by `cancel`, so work begun before it stays dropped even after `resume`. */
  private generation = 0;

  private set(patch: Partial<OutputsSnapshot> | ((s: OutputsSnapshot) => Partial<OutputsSnapshot>), save = false) {
    if (!this.live) return;
    const next = trimmed({ ...this.snap, ...(typeof patch === "function" ? patch(this.snap) : patch) });
    if (save) next.notSaved = !writeScope(this.storage, this.scope, { chats: next.chats, added: next.added, usedAt: this.now() });
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  /**
   * Lets go of the index: the run, check or addition under way stops, and whatever it reads later is dropped and never
   * saved, so it can't overwrite what a newer index for the same profile kept. For a profile switch or sign-out.
   */
  cancel() {
    this.runSeq++;
    this.checkSeq++;
    if (this.snap.indexing || this.snap.checking || this.snap.checkingSince !== undefined) this.set({ indexing: undefined, checking: false, checkingSince: undefined });
    this.live = false;
    this.generation++;
  }

  /** Takes the index up again after `cancel`, reading what is kept now (React runs an effect's cleanup and body again). */
  resume() {
    if (this.live) return;
    const kept = readScope(this.storage, this.scope);
    this.live = true;
    this.set({ chats: kept.chats, added: kept.added });
  }

  /**
   * Indexes the chats in `chats` that changed since they were indexed (all of them with `force`), the most recently
   * active first, at most `MAX_CHATS_PER_RUN`. Each chat's Outputs replace its old ones once it is read, keeping the
   * availability already known for a path. A new run replaces one under way.
   */
  async index(chats: ChatRef[], force = false, rebuildEvicted = false): Promise<void> {
    if (!this.live) return;
    const seq = ++this.runSeq;
    const live = () => seq === this.runSeq && this.live;
    const due = chats
      .filter((c) => force || this.snap.chats[c.id]?.updatedAt !== c.updatedAt || (rebuildEvicted && this.snap.chats[c.id]?.partial?.evicted))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const now = due.slice(0, MAX_CHATS_PER_RUN);
    this.set({ indexing: now.length ? { done: 0, total: now.length } : undefined, waiting: due.length - now.length, error: undefined });
    for (const [i, chat] of now.entries()) {
      let read: Awaited<ReturnType<typeof readRows>>;
      try {
        read = await readRows(this.io, chat.id, live);
      } catch (e) {
        if (!live()) return;
        const message = errorText(e);
        if (e instanceof OutputsUnsupported) return this.set({ indexing: undefined, unsupported: message });
        // A chat deleted meanwhile has no rows to read; the rest go on.
        if (statusOf(e) === 404) continue;
        return this.set({ indexing: undefined, error: `Couldn't read a chat's messages: ${message}` });
      }
      if (!live()) return;
      const found = outputsFromRows(chat.id, read.rows);
      const { unlabelled } = found;
      // The newest ones, when a chat made more than can be kept.
      const outputs = found.outputs.sort((a, b) => (b.rowId ?? 0) - (a.rowId ?? 0)).slice(0, OUTPUTS_PER_CHAT);
      const known = new Map(this.snap.chats[chat.id]?.outputs.map((o) => [placeOf(o), o.availability]));
      const partial: IndexGaps = { ...read.partial, ...(unlabelled && { unlabelled }), ...(found.outputs.length > OUTPUTS_PER_CHAT && { tooMany: true }) };
      const entry: ChatOutputs = {
        updatedAt: chat.updatedAt,
        indexedAt: this.now(),
        outputs: outputs.map((o) => (known.get(placeOf(o)) ? { ...o, availability: known.get(placeOf(o)) } : o)),
        ...(Object.keys(partial).length && { partial }),
      };
      this.set((s) => ({ chats: { ...s.chats, [chat.id]: entry }, indexing: { done: i + 1, total: now.length } }), true);
    }
    if (live()) this.set({ indexing: undefined, unsupported: undefined });
  }

  /**
   * What opening Outputs and Refresh do (ADR 0064): `index`, then `check` the Outputs `shown` picks from what it read.
   * The check is skipped when a newer run, or `cancel`, replaced this one meanwhile, so it can't cancel that run's own
   * check, and when the read failed, so its error stays on screen.
   */
  async refresh(chats: ChatRef[], rebuildEvicted: boolean, shown: (s: OutputsSnapshot) => Output[]): Promise<void> {
    if (!this.live) return;
    const seq = this.runSeq + 1;
    this.set({ checkingSince: this.now() });
    await this.index(chats, false, rebuildEvicted);
    const s = this.snap;
    if (seq !== this.runSeq || !this.live) return;
    if (s.error === undefined && s.unsupported === undefined) await this.check(shown(s));
    // A newer refresh started meanwhile keeps its own mark.
    if (seq === this.runSeq) this.set({ checkingSince: undefined });
  }

  /** Reads where each of `outputs` is now (`checkPaths`) and keeps the answers. */
  async check(outputs: Output[]): Promise<void> {
    if (!this.live) return;
    const seq = ++this.checkSeq;
    this.set({ checking: true, error: undefined });
    let found: Map<string, Availability>;
    try {
      const places = new Map(outputs.map((o) => [placeOf(o), { path: o.path, host: o.host }]));
      found = await checkPaths(this.io, [...places.values()], this.now());
    } catch (e) {
      if (seq !== this.checkSeq) return;
      const message = errorText(e);
      return this.set(e instanceof OutputsUnsupported ? { checking: false, unsupported: message } : { checking: false, error: `Couldn't check the files: ${message}` });
    }
    if (seq !== this.checkSeq) return;
    // A file a chat's tools wrote that the listing didn't find is read again naming the chat, as Preview and Edit read
    // it (ADR 0062): with a sandbox per chat, the listing showed another folder.
    const confirmed = new Map<string, Availability>();
    const doubtful = outputs.filter((o) => sessionOf(o) && found.get(placeOf(o))?.state === "missing").slice(0, MAX_CONFIRMS_PER_CHECK);
    for (const o of doubtful) {
      if (!this.io.confirm) break;
      let answer: Omit<Availability, "checkedAt"> | undefined;
      try {
        answer = await this.io.confirm(o.path, sessionOf(o) as string);
      } catch (e) {
        answer = { state: "unknown", why: errorText(e) };
      }
      if (seq !== this.checkSeq) return;
      if (answer) confirmed.set(o.key, { ...answer, checkedAt: this.now() });
    }
    const keys = new Set(outputs.map((o) => o.key));
    const update = (o: Output) => {
      if (!keys.has(o.key)) return o;
      const a = confirmed.get(o.key) ?? found.get(placeOf(o));
      return a ? { ...o, availability: a } : o;
    };
    this.set(
      (s) => ({
        checking: false,
        chats: Object.fromEntries(Object.entries(s.chats).map(([id, c]) => [id, { ...c, outputs: c.outputs.map(update) }])),
        added: s.added.map(update),
      }),
      true,
    );
  }

  /**
   * Adds a Server file the owner names, for a file the index can't find on its own. It is checked first, and added
   * only when its folder lists it as a file. `chatId`: the chat it belongs with, if any. Rejects saying why not.
   */
  async add(path: string, chatId?: string): Promise<Output> {
    const p = path.trim();
    if (!isOutputPath(p)) throw new Error("Enter a full path on the Hermes server, starting with / or ~/.");
    const key = outputKey(chatId ?? "", "added", p);
    if (this.snap.added.some((o) => o.key === key)) throw new Error("That file is already in Outputs.");
    if (this.snap.added.length >= ADDED_MAX) throw new Error(`Outputs keeps up to ${ADDED_MAX} files you added. Take one out first.`);
    const generation = this.generation;
    const checked = (await checkPaths(this.io, [{ path: p }], this.now())).get(placeOf({ path: p }));
    if (!this.live || generation !== this.generation) throw new Error("Outputs now shows another profile, so the file wasn't added.");
    if (checked?.state !== "available") throw new Error(checked?.state === "folder" ? "That's a folder, not a file." : (checked?.why ?? "The server couldn't find that file."));
    const out: Output = { key, path: p, how: "added", at: this.now(), availability: checked, ...(chatId && { chatId }) };
    this.set((s) => ({ added: [...s.added.filter((o) => o.key !== key), out] }), true);
    return out;
  }

  /**
   * Forgets the chats not in `ids`, the profile's whole chat list as just read: a chat deleted, or no longer listed, keeps
   * no record. One listed again later is read again. The files the owner added stay.
   */
  keepOnly(ids: Set<string>) {
    if (Object.keys(this.snap.chats).every((id) => ids.has(id))) return;
    this.set((s) => ({ chats: Object.fromEntries(Object.entries(s.chats).filter(([id]) => ids.has(id))) }), true);
  }

  /** Takes an Output the owner added back out. Found ones go only when their chat is indexed without them. */
  remove(key: string) {
    this.set((s) => ({ added: s.added.filter((o) => o.key !== key) }), true);
  }
}

/** Whether `o` waits on the check of the `refresh` under way (ADR 0064): its last answer, if any, is from before it. */
export const checkPending = (snap: Pick<OutputsSnapshot, "checkingSince">, o: Output) =>
  snap.checkingSince !== undefined && !(o.availability && o.availability.checkedAt >= snap.checkingSince);

/** Every Output kept for the chats in `chatIds` (all of them when undefined), and the added ones that go with them. */
export function outputsIn(snap: Pick<OutputsSnapshot, "chats" | "added">, chatIds?: Set<string>): Output[] {
  const fromChats = Object.entries(snap.chats).flatMap(([id, c]) => (!chatIds || chatIds.has(id) ? c.outputs : []));
  const added = snap.added.filter((o) => !chatIds || (o.chatId !== undefined && chatIds.has(o.chatId)));
  return [...fromChats, ...added];
}
