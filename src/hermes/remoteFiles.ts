// Server files: the files on the machine the Hermes dashboard runs on, through the dashboard's own managed-files routes
// (the official web dashboard's Files tab uses the same ones): `GET /api/files` and `GET /api/files/read` to browse
// and preview (ADR 0012), and `GET /api/files/download` to download one to a place the owner picks on this computer
// (ADR 0023), and `POST /api/files/upload-stream` to upload a file the owner picks into the folder on screen, read back
// from the folder's listing afterwards. A text file can be edited and saved back through the same upload route, after
// checking its revision and with a read-back (ADR 0024). The server decides what may be read: it lists and reads as its own OS user, can lock browsing to one
// folder, and never lists, reads or sends credential files such as `.env` or `auth.json`. Wire details:
// docs/research/hermes-gateway-api.md, "Server files".
import { RestError, statusOf } from "./pipe";
import { EDIT_MAX_BYTES, decodeForEdit, encodeEdit, revisionOf, type EditableText } from "./textEdit";
import { errorText, formatBytes, optionalText } from "./values";

/** A directory entry as `GET /api/files` lists it (`_managed_file_entry`, `hermes_cli/web_server_files.py` at `bf0203a`). */
type WireEntry = {
  name?: unknown;
  path?: unknown;
  is_directory?: unknown;
  broken_link?: unknown;
  size?: unknown;
  mtime?: unknown;
  mime_type?: unknown;
};

/**
 * One entry of a listed folder. `path` is where it really is: the server resolves symbolic links, so for a link
 * `linkTarget` is set to that resolved path, and opening the entry opens its target. A broken link has no target to
 * open. `modified` is Unix ms.
 */
export type RemoteEntry = {
  name: string;
  path: string;
  kind: "dir" | "file" | "broken-link";
  size?: number;
  modified?: number;
  mime?: string;
  linkTarget?: string;
};

/**
 * A listed folder. `path` is its resolved path on the server. `parent` is the folder above, unless this is the top the
 * server lets the owner reach. `root` is set when the server locks browsing to one folder
 * (`HERMES_DASHBOARD_FILES_ROOT`, or a hosted install's `/opt/data`).
 */
export type RemoteListing = {
  path: string;
  parent?: string;
  entries: RemoteEntry[];
  root?: string;
  listedAt: number;
};

export type RemotePreview =
  | { kind: "text"; path: string; name: string; size: number; text: string }
  | { kind: "image"; path: string; name: string; size: number; mime: string; dataUrl: string }
  | { kind: "binary"; path: string; name: string; size: number; mime: string };

/** How an entry can be previewed, judged from what the listing says, before reading anything. */
export type PreviewSupport =
  | { kind: "text" | "image"; max: number }
  /** An unknown type: it may be text, so the owner can ask to try. */
  | { kind: "maybe-text"; max: number }
  | { kind: "none"; why: string };

/** A request the server or the connection refused. `status` is the dashboard's HTTP status, when it answered. */
export class RemoteFilesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly offline = false,
  ) {
    super(message);
  }
}

/** The most the preview shows of a text file; bigger ones aren't read. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** The most an image preview reads. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** How many entries a folder shows at first, and how many more each "Show more" adds. */
export const ENTRY_PAGE = 500;

/** A read-only dashboard GET, with the answer refused once it passes `maxBytes` when that is given. */
export type RemoteGet = (pathAndQuery: string, maxBytes?: number) => Promise<string>;

/** A transfer's progress as the Rust side reports it: bytes so far, the size the server announced, the local path. */
export type TransferProgress = { done: number; total?: number | null; dest: string };

/** A local file picked in the native Open dialog to upload. The webview gets a token for it, never its path. */
export type PickedUpload = { token: number; name: string; size: number };

/** What the Rust side does for transfers (src-tauri `files_download`, `files_pick_upload`, `files_upload`, `files_cancel`). */
export type TransferPipe = {
  /** The native Open dialog. Nothing is sent. Undefined when the owner closed it. */
  pickUpload(): Promise<PickedUpload | undefined>;
  /** Lets go of a pick that won't be sent. */
  discardUpload(token: number): Promise<void>;
  /** Writes `text` (as UTF-8) to the server path `path` through the upload route (src-tauri `files_save_text`). */
  saveText(id: number, path: string, text: string, overwrite: boolean): Promise<string>;
  /**
   * Uploads the picked file to the server path `path`. `overwrite` false: Hermes refuses (409) when a file is there.
   * Resolves to Hermes's answer. Rejects with `TRANSFER_STOPPED` when stopped, like `download`.
   */
  upload(id: number, token: number, path: string, overwrite: boolean, onProgress: (p: TransferProgress) => void): Promise<string>;
  /**
   * Downloads the Server file at `path`. The owner picks where in the native Save dialog, which asks before replacing a
   * file; `name` only suggests the file name. Resolves to the local path, or undefined when the owner closed the dialog.
   * Rejects with `TRANSFER_STOPPED` when stopped by `cancel` or by the connection closing.
   */
  download(id: number, path: string, name: string, onProgress: (p: TransferProgress) => void): Promise<Downloaded | undefined>;
  cancel(id: number): Promise<void>;
};

/** A finished download: where it went on this computer, and how many bytes it holds. */
export type Downloaded = { dest: string; bytes: number };

/** What a stopped transfer rejects with (src-tauri `TRANSFER_STOPPED`). */
export const TRANSFER_STOPPED = "The transfer was stopped.";

/**
 * A download or an upload, from the click until the owner dismisses it. `serverPath` is the file on the server: where a
 * download comes from, or where an upload goes. `dest` is a download's local path, once picked. `total` is the size
 * announced. `checking`: an upload Hermes answered, being read back from its folder's listing. `stopped`: by Cancel,
 * or because the connection closed or changed.
 */
export type Transfer = {
  id: number;
  kind: "download" | "upload";
  name: string;
  serverPath: string;
  dest?: string;
  /** An upload's local file name, which a kept-both upload doesn't keep on the server. */
  localName?: string;
  done: number;
  total?: number;
  state: "picking" | "running" | "checking" | "done" | "failed" | "stopped";
  error?: string;
};

/** What happens when the picked file's name is taken in the folder: upload under a free name, or replace it. */
export type Collision = "keep-both" | "replace";

/** Where a picked file would go, before anything is sent. `refused`: why it can't go there. */
export type UploadPlan = { dest: string; taken?: RemoteEntry; keepBothName: string; refused?: string };

/** The most Hermes sends of one file (`_MANAGED_FILE_MAX_BYTES` at `bf0203a`). */
export const SERVER_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * A text file opened for editing: its bytes as read, their revision (SHA-256), and the text as the editor holds it.
 */
export type EditBase = EditableText & { path: string; name: string; bytes: Uint8Array; revision: string };

/**
 * What a save found. `saved`: Hermes has exactly the edit, read back; `base` is the file now. `conflict`: the file on
 * the server isn't the one the edit started from, so nothing was written (`after` false), or it changed again
 * while the save ran (`after` true). `theirs` is what the server has now, or why it can't be shown.
 */
export type SaveOutcome =
  | { kind: "saved"; base: EditBase }
  | { kind: "conflict"; after: boolean; theirs: EditBase | { gone: true } | { why: string; revision: string } };

export type RemoteFiles = {
  /** Lists a folder by its absolute path on the server, or the server's starting folder when `path` is left out. */
  list(path?: string): Promise<RemoteListing>;
  /** Reads `entry` for its preview. `asText` reads an unknown type as text. */
  preview(entry: RemoteEntry, asText?: boolean): Promise<RemotePreview>;
  /** Why `entry` can't be downloaded, judged from its listing, or undefined when it can. */
  cantDownload(entry: RemoteEntry): string | undefined;
  /** Downloads `entry` to where the owner picks. Its progress and outcome show in `transfers()`. */
  download(entry: RemoteEntry): Promise<void>;
  cancel(id: number): void;
  /** The native Open dialog, for a file to upload. Sends nothing. */
  pickUpload(): Promise<PickedUpload | undefined>;
  /** Lets go of a pick the owner decided not to send, so its token can't be used. */
  discardUpload(picked: PickedUpload): void;
  /** Where `picked` would go in `listing`'s folder, and what is in the way, judged from the listing. */
  planUpload(listing: RemoteListing, picked: PickedUpload): UploadPlan;
  /**
   * Uploads `picked` into `listing`'s folder. When its name is taken, `collision` says whether to keep both (a free
   * name) or replace the server's file. Hermes never replaces a file unless asked. Once Hermes answers, the folder is
   * listed again, and it counts as uploaded only when the listing has the file with the picked size.
   */
  upload(listing: RemoteListing, picked: PickedUpload, collision: Collision): Promise<void>;
  /** Reads a text file to edit, or rejects with why it can't be edited. */
  openForEdit(entry: RemoteEntry): Promise<EditBase>;
  /**
   * Saves `text` over the file `base` was read from: only if the server still has `base`'s revision, and it counts as
   * saved only once Hermes, read back, has exactly what was sent. Rejects when Hermes refused the write (nothing was
   * written) or the outcome can't be told.
   */
  saveEdit(base: EditBase, text: string): Promise<SaveOutcome>;
  /** Saves `text` as a new file beside `base`'s, under a free name, never over another file. Resolves to its path. */
  saveCopy(base: EditBase, text: string): Promise<string>;
  /** Takes a finished, failed or stopped transfer off the list. */
  dismiss(id: number): void;
  /** The transfers, oldest first; a new array after each change. */
  transfers(): Transfer[];
  subscribe(listener: () => void): () => void;
};

/** Transfer ids, unique for as long as the app runs, across sign-ins: the Rust side keys running transfers by them. */
let nextTransferId = 1;
/** A new transfer id. Artifact saves (artifacts.ts) take theirs from here too, since Rust keys every transfer by its id. */
export const newTransferId = () => nextTransferId++;

export function remoteFiles(get: RemoteGet, pipe: TransferPipe): RemoteFiles {
  let transfers: Transfer[] = [];
  const listeners = new Set<() => void>();
  const settled = (id: number) => !["picking", "running"].includes(transfers.find((t) => t.id === id)?.state ?? "");
  const change = (id: number, patch: Partial<Transfer> | undefined) => {
    transfers = patch ? transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) : transfers.filter((t) => t.id !== id);
    for (const l of listeners) l();
  };
  /** A file's bytes through `GET /api/files/read`, refused past what the editor opens. */
  const readBytes = async (path: string) => {
    const body = await call(() => deadline(get(`api/files/read?${new URLSearchParams({ path })}`, Math.ceil(EDIT_MAX_BYTES / 3) * 4 + 64 * 1024), EDIT_DEADLINES.readMs), "read", EDIT_MAX_BYTES);
    let wire: { data_url?: unknown; path?: unknown };
    try {
      wire = JSON.parse(body);
    } catch {
      throw new RemoteFilesError("The server's answer isn't a file.");
    }
    const dataUrl = optionalText(wire?.data_url);
    const m = dataUrl && /^data:[^,]*;base64,/.exec(dataUrl);
    if (!dataUrl || !m) throw new RemoteFilesError("The server's answer isn't a file.");
    return { path: optionalText(wire.path) ?? path, bytes: Uint8Array.from(atob(dataUrl.slice(m[0].length)), (c) => c.charCodeAt(0)) };
  };
  /**
   * Writes an edit's text through the upload route. Resolves when Hermes said it wrote it; rejects with a
   * `RemoteFilesError` when Hermes refused (the file is as it was), or with `{ lost }` when the outcome isn't known: no
   * answer within the deadline (the write is stopped then, but may already have landed), a dropped connection, or a
   * gateway's 502/503/504.
   */
  const writeText = async (path: string, text: string, overwrite: boolean) => {
    const id = newTransferId();
    try {
      await deadline(pipe.saveText(id, path, text, overwrite), EDIT_DEADLINES.writeMs);
    } catch (e) {
      if (e instanceof TimedOut) void pipe.cancel(id).catch(() => {});
      if (refusedBeforeWriting(e)) throw explainSave(e);
      throw { lost: e instanceof TimedOut ? `Hermes didn't answer within ${EDIT_DEADLINES.writeMs / 1000} s.` : explainSave(e).message };
    }
  };
  const list = async (path?: string) => {
    const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
    const body = await call(() => get(`api/files${query}`), "list");
    return parseListing(body, Date.now());
  };
  const editing = textEditing({
    readBytes,
    writeText,
    listNames: async (folder) => {
      const listing = await deadline(list(folder), EDIT_DEADLINES.readMs);
      return { path: listing.path, names: new Set(listing.entries.map((e) => e.name)) };
    },
  });
  const add = (t: Omit<Transfer, "id">) => {
    const id = newTransferId();
    transfers = [...transfers, { ...t, id }];
    change(id, {});
    return id;
  };
  const failed = (id: number, e: unknown, what: "download" | "upload") => {
    change(id, errorText(e) === TRANSFER_STOPPED ? { state: "stopped" } : { state: "failed", error: explainTransfer(e, what) });
  };
  const planUpload = (listing: RemoteListing, picked: PickedUpload): UploadPlan => {
    const names = new Set(listing.entries.map((e) => e.name));
    const dest = joinPath(listing.path, picked.name);
    const plan: UploadPlan = { dest, taken: listing.entries.find((e) => e.name === picked.name), keepBothName: freeName(picked.name, names) };
    if (protectedPath(dest)) plan.refused = `Hermes keeps credential files such as ${picked.name} out of its file browser, so Hermes Chat doesn't upload over them.`;
    // A link in the way would be written through: Hermes replaces what it points to.
    else if (plan.taken?.linkTarget && protectedPath(plan.taken.linkTarget))
      plan.refused = `${picked.name} here is a link to a credential file (${plan.taken.linkTarget}), so Hermes Chat doesn't upload over it.`;
    else if (picked.size > SERVER_FILE_MAX_BYTES) plan.refused = `It's ${formatBytes(picked.size)}. Hermes takes files up to 100 MB.`;
    else if (plan.taken?.kind === "dir") plan.refused = `There's a folder named ${picked.name} there.`;
    return plan;
  };
  const cantDownload = (entry: RemoteEntry) => {
    if (entry.kind !== "file") return entry.kind === "dir" ? "Folders can't be downloaded, only files." : "It's a symbolic link to something that isn't there.";
    if (entry.size !== undefined && entry.size > SERVER_FILE_MAX_BYTES) return `It's ${formatBytes(entry.size)}. Hermes sends files up to 100 MB.`;
  };
  return {
    cantDownload,
    async download(entry) {
      const why = cantDownload(entry);
      if (why) throw new RemoteFilesError(why);
      const id = add({ kind: "download", name: entry.name, serverPath: entry.path, done: 0, total: entry.size, state: "picking" });
      try {
        const got = await pipe.download(id, entry.path, entry.name, (p) =>
          // Progress can arrive after the outcome; it never takes a settled transfer back.
          settled(id) ? undefined : change(id, { state: "running", dest: p.dest, done: p.done, ...(typeof p.total === "number" && { total: p.total }) }),
        );
        // The owner closed the Save dialog: nothing was read or written.
        if (got === undefined) return change(id, undefined);
        change(id, { state: "done", dest: got.dest, done: got.bytes, total: got.bytes });
      } catch (e) {
        failed(id, e, "download");
      }
    },
    async openForEdit(entry) {
      if (entry.kind !== "file") throw new RemoteFilesError("Only files can be edited.");
      if (entry.size !== undefined && entry.size > EDIT_MAX_BYTES) throw new RemoteFilesError(`It's ${formatBytes(entry.size)}. The editor opens files up to ${formatBytes(EDIT_MAX_BYTES)}.`);
      if (protectedPath(entry.path)) throw new RemoteFilesError("Hermes Chat doesn't edit credential files.");
      return editing.open(entry.path, entry.name);
    },
    saveEdit: editing.saveEdit,
    saveCopy: editing.saveCopy,
    pickUpload: () => pipe.pickUpload(),
    discardUpload: (picked) => void pipe.discardUpload(picked.token).catch(() => {}),
    planUpload,
    async upload(listing, picked, collision) {
      const plan = planUpload(listing, picked);
      if (plan.refused) throw new RemoteFilesError(plan.refused);
      const replace = !!plan.taken && collision === "replace";
      const name = plan.taken && !replace ? plan.keepBothName : picked.name;
      const serverPath = joinPath(listing.path, name);
      const id = add({ kind: "upload", name, localName: picked.name, serverPath, done: 0, total: picked.size, state: "running" });
      try {
        // The size Rust measured when it opened the file is what it sends, whatever the picker said earlier.
        await pipe.upload(id, picked.token, serverPath, replace, (p) =>
          settled(id) ? undefined : change(id, { done: p.done, ...(typeof p.total === "number" && { total: p.total }) }),
        );
      } catch (e) {
        return failed(id, e, "upload");
      }
      // Read back: Hermes's answer says it wrote the file; the folder's listing says what is there now.
      const size = transfers.find((t) => t.id === id)?.total ?? picked.size;
      change(id, { state: "checking", done: size });
      try {
        const now = await list(listing.path);
        const entry = now.entries.find((e) => e.name === name);
        if (entry?.size === size) change(id, { state: "done" });
        else
          change(id, {
            state: "failed",
            error: entry
              ? `Hermes said it saved it, but the folder lists ${name} at ${fmtBytes(entry.size)}, not ${fmtBytes(size)}. Something else may have changed it since.`
              : `Hermes said it saved it, but the folder doesn't list ${name}. Something else may have moved it since.`,
          });
      } catch (e) {
        change(id, { state: "failed", error: `Hermes said it saved it, but the folder couldn't be listed to check: ${errorText(e)}` });
      }
    },
    cancel: (id) => void pipe.cancel(id).catch(() => {}),
    dismiss: (id) => change(id, undefined),
    transfers: () => transfers,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list,
    async preview(entry, asText = false) {
      const support = previewSupport(entry);
      if (support.kind === "none") throw new RemoteFilesError(support.why);
      if (entry.size !== undefined && entry.size > support.max) throw new RemoteFilesError(tooLarge(entry.size, support.max));
      // The answer is the whole file as a base64 data URL in JSON: about 4/3 of the file, plus its name and path.
      const answerMax = Math.ceil(support.max / 3) * 4 + 64 * 1024;
      const body = await call(() => get(`api/files/read?${new URLSearchParams({ path: entry.path })}`, answerMax), "read", support.max);
      return parseRead(body, entry, support, asText);
    },
  };
}

const tooLarge = (size: number, max: number) => `It's ${formatBytes(size)}. Previews go up to ${formatBytes(max)}.`;

/** Raster and vector images the webview shows in an `<img>`, where an SVG can't run scripts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);
/** A `data:` URL of one of those types: what the file browser and the preview pane show as an image. */
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]*$/;
const TEXT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-sh",
  "application/x-shellscript",
  "application/toml",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/x-httpd-php",
  "application/x-python",
  "application/x-perl",
  "application/x-ruby",
  "application/xhtml+xml",
  "application/x-ndjson",
  "application/x-subrip",
  "application/x-tex",
  "application/x-troff-man",
]);
/** Extensions Python's `mimetypes` doesn't call text, though they are. */
const TEXT_EXTENSIONS = new Set(
  "md markdown txt log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env sample lock rs ts tsx js jsx mjs cjs py rb go java kt c h cc cpp hpp cs swift sh bash zsh fish lua sql graphql proto vue svelte css scss less html htm xml svg tex rst org diff patch gitignore gitattributes editorconfig dockerignore service timer desktop properties gradle nix tf hcl".split(
    " ",
  ),
);
/** Names with no extension that are text. */
const TEXT_NAMES = new Set(["makefile", "dockerfile", "license", "readme", "changelog", "authors", "copying", "pkgbuild", "caddyfile", "procfile", "gemfile", "rakefile", "justfile", "vagrantfile"]);
const BINARY_FAMILIES = ["audio/", "video/", "font/"];

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 || (dot === 0 && name.length > 1) ? name.slice(dot + 1).toLowerCase() : "";
};

export function previewSupport(entry: RemoteEntry): PreviewSupport {
  if (entry.kind === "dir") return { kind: "none", why: "It's a folder." };
  if (entry.kind === "broken-link") return { kind: "none", why: "It's a symbolic link to something that isn't there." };
  const mime = (entry.mime ?? "").toLowerCase();
  if (IMAGE_TYPES.has(mime)) return { kind: "image", max: IMAGE_PREVIEW_MAX_BYTES };
  // A link's type is its target's (the server resolves it), so its target's name counts as much as its own.
  const target = entry.linkTarget?.slice(entry.linkTarget.lastIndexOf("/") + 1);
  const ext = extensionOf(target ?? entry.name);
  if (mime.startsWith("text/") || TEXT_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml")) return { kind: "text", max: TEXT_PREVIEW_MAX_BYTES };
  // Checked before the type, since `mimetypes` calls a `.ts` file video/mp2t.
  if ([entry.name, target].some((name) => name && nameSaysText(name))) return { kind: "text", max: TEXT_PREVIEW_MAX_BYTES };
  if (BINARY_FAMILIES.some((f) => mime.startsWith(f)) || mime.startsWith("image/"))
    return { kind: "none", why: `There's no preview for ${mime} files.` };
  if (!mime || mime === "application/octet-stream" || !ext) return { kind: "maybe-text", max: TEXT_PREVIEW_MAX_BYTES };
  return { kind: "none", why: `There's no preview for ${mime} files.` };
}

/**
 * A file name that marks a text file whatever its type says: a text extension, a well-known name such as `Makefile`,
 * or a dotfile with no other dot, such as `.bashrc`. What turns out to be binary after all shows as binary
 * (`looksBinary`).
 */
function nameSaysText(name: string): boolean {
  const ext = extensionOf(name);
  return TEXT_EXTENSIONS.has(ext) || (!ext && TEXT_NAMES.has(name.toLowerCase())) || (name.startsWith(".") && name.indexOf(".", 1) < 0);
}

/** Runs one request, turning the transport's errors into ones the browser can show. */
async function call(run: () => Promise<string>, what: "list" | "read", previewMax?: number): Promise<string> {
  try {
    return await run();
  } catch (e) {
    throw explain(e, what, previewMax);
  }
}

/** Why a transfer failed, in the owner's words: the server's refusals as `explain` words them, the rest as they come. */
function explainTransfer(e: unknown, what: "download" | "upload"): string {
  const message = errorText(e);
  if (what === "upload" && refused(e, 409, "File already exists")) return "A file with that name is on the server now. Nothing was replaced.";
  if (what === "upload" && refused(e, 403, "File is not writable")) return "The Hermes server's user isn't allowed to write there.";
  if (e instanceof RestError || /^Not connected|^The chat connection is closed/.test(message)) return explain(e, what === "download" ? "read" : "write").message;
  if (/^couldn't (write|read) it on this computer/.test(message)) return message[0].toUpperCase() + message.slice(1) + ".";
  if (/^it's .* MB now, over the .* MB limit/.test(message)) return `It's grown: ${message}.`;
  if (/^Hermes Chat doesn't relay/.test(message)) return message;
  return `The ${what} broke off: ${message}.`;
}

/** How long a read for the editor, and a save, may take before the app stops waiting (as Persona does). */
export const EDIT_DEADLINES = { readMs: 30_000, writeMs: 60_000 };

export class TimedOut extends Error {}

export function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimedOut(`Hermes didn't answer within ${ms / 1000} s.`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export const isLost = (e: unknown): e is { lost: string } => typeof e === "object" && e !== null && "lost" in e;

/** The edit's bytes, refused past what the editor saves (and could read back). */
function sizeChecked(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > EDIT_MAX_BYTES) throw new RemoteFilesError(`The edit is ${formatBytes(bytes.length)}. The editor saves files up to ${formatBytes(EDIT_MAX_BYTES)}.`);
  return bytes;
}

/**
 * Answers Hermes gives before it writes anything (`_managed_write_target`, `stream_upload_to_path`), or that never
 * reached it. Anything else, a 500 from the entry Hermes describes after writing or a gateway's 5xx included, may come
 * after the write landed, so it is settled by reading the file back.
 */
function refusedBeforeWriting(e: unknown): boolean {
  if (!(e instanceof RestError)) return /^Hermes Chat doesn't relay|^Not connected/.test(errorText(e));
  const status = e.status;
  // An expired sign-in never reaches the route, and FastAPI checks the form before it runs.
  if (status === 401 || status === 422) return true;
  let detail: unknown;
  try {
    detail = (JSON.parse(e.body) as { detail?: unknown }).detail;
  } catch {
    // Cut short or not Hermes's own JSON: not known to be a refusal.
    return false;
  }
  if (typeof detail !== "string") return false;
  const before: Record<number, (d: string) => boolean> = {
    409: (d) => d === "File already exists" || d === "A directory already exists at that path",
    413: (d) => d === "File is too large",
    403: (d) => d === "File is not writable",
    500: (d) => d.startsWith("Could not write file:") || d.startsWith("Could not create parent directory"),
  };
  return before[status]?.(detail) ?? false;
}

/** Why Hermes refused a save, in the owner's words. Its write is atomic, so a refused save changed nothing. */
function explainSave(e: unknown): RemoteFilesError {
  if (refused(e, 403, "File is not writable")) return new RemoteFilesError("The Hermes server's user isn't allowed to write this file.", 403);
  if (refused(e, 409, "File already exists")) return new RemoteFilesError("A file with that name is on the server now. Nothing was replaced.", 409);
  if (/^Hermes Chat doesn't relay/.test(errorText(e))) return new RemoteFilesError(errorText(e));
  return explain(e, "write");
}

/** Whether Hermes answered `status` with `reason` in its body, as `files.py` refuses an upload. */
const refused = (e: unknown, status: number, reason: string) => e instanceof RestError && e.status === status && e.body.includes(reason);

/**
 * How a text editor reaches one machine's files: Server files through the managed-files routes (ADR 0024), an
 * artifact through the agent fs routes where its profile's tools run (ADR 0029). `readBytes` resolves to a file's
 * exact bytes and the path the server names for it, or rejects with a `RemoteFilesError` whose status says why (404
 * gone; 400 not a regular file; 403 not allowed; 413 too big). `writeText` resolves once the server said it wrote the
 * text, rejects with a `RemoteFilesError` when the server refused (nothing was written), or with `{ lost }` when the
 * outcome can't be told. `listNames`: a folder's resolved path and the names in it, for a copy's free name.
 */
export type EditIo = {
  readBytes(path: string): Promise<{ path: string; bytes: Uint8Array }>;
  writeText(path: string, text: string, overwrite: boolean): Promise<void>;
  listNames(folder: string): Promise<{ path: string; names: Set<string> }>;
};

/**
 * Opening, checked saving and saving a copy of a text file through `io` (ADR 0024): the save reads the file first and
 * writes only if it still has the revision the edit started from, then reads it back and counts as saved only when
 * the server has exactly the bytes sent. A lost answer is settled by that read-back.
 */
export function textEditing(io: EditIo) {
  /** The file `base` came from as the server has it now: its revision, and its text when that can be edited. */
  const current = async (base: EditBase): Promise<{ revision: string; theirs: EditBase | { gone: true } | { why: string; revision: string } }> => {
    let read: { path: string; bytes: Uint8Array };
    try {
      read = await io.readBytes(base.path);
    } catch (e) {
      if (e instanceof RemoteFilesError && e.status === 404) return { revision: "", theirs: { gone: true } };
      // Now a folder, too big for the editor, or unreadable: another version, which can't be shown.
      if (e instanceof RemoteFilesError && (e.status === 400 || e.status === 403 || e.status === 413)) return { revision: "", theirs: { why: e.message, revision: "" } };
      throw e;
    }
    const revision = await revisionOf(read.bytes);
    const text = decodeForEdit(read.bytes);
    return { revision, theirs: "why" in text ? { why: text.why, revision } : { ...text, path: base.path, name: base.name, bytes: read.bytes, revision } };
  };
  /** Copies whose outcome isn't known yet, by the file and text they copy, so a retry checks them first. */
  const unsettledCopies = new Map<string, string>();
  return {
    current,
    /** Reads the text file at `path` to edit, or rejects with why it can't be edited. */
    async open(path: string, name: string): Promise<EditBase> {
      const read = await io.readBytes(path);
      const text = decodeForEdit(read.bytes);
      if ("why" in text) throw new RemoteFilesError(text.why);
      return { ...text, path: read.path, name, bytes: read.bytes, revision: await revisionOf(read.bytes) };
    },
    async saveEdit(base: EditBase, text: string): Promise<SaveOutcome> {
      const outgoing = encodeEdit(text, base.eol, base.bom);
      const sent = sizeChecked(outgoing);
      const sentRevision = await revisionOf(sent);
      // Before: the server must still have the file the edit started from.
      const now = await current(base);
      if (now.revision !== base.revision) return { kind: "conflict", after: false, theirs: now.theirs };
      let lost: string | undefined;
      try {
        await io.writeText(base.path, outgoing, true);
      } catch (e) {
        if (!isLost(e)) throw e;
        lost = e.lost;
      }
      // After: read back. A lost answer is settled the same way.
      const back = await current(base).catch((e) => {
        throw new RemoteFilesError(`${lost ? "The save's answer was lost" : "Hermes saved it"}, but the file couldn't be read back to check: ${errorText(e)}`);
      });
      if (back.revision === sentRevision && "bytes" in back.theirs) return { kind: "saved", base: back.theirs };
      if (lost && back.revision === base.revision) throw new RemoteFilesError(`It wasn't saved: ${lost} The server still has the file you started from.`);
      return { kind: "conflict", after: true, theirs: back.theirs };
    },
    async saveCopy(base: EditBase, text: string): Promise<string> {
      const outgoing = encodeEdit(text, base.eol, base.bom);
      const sentRevision = await revisionOf(sizeChecked(outgoing));
      const folder = base.path.slice(0, base.path.lastIndexOf("/")) || "/";
      // A copy of this same text whose outcome wasn't known: settle that one first, rather than make another.
      const key = `${base.path}\n${sentRevision}`;
      const unsettled = unsettledCopies.get(key);
      if (unsettled) {
        // null: it isn't there, so it never landed; undefined: still can't tell.
        // A file reached through a link isn't the copy, whatever it holds: Hermes names the path it resolved.
        const there = await io.readBytes(unsettled).then(
          (b) => (b.path === unsettled ? revisionOf(b.bytes) : null),
          (e) => (e instanceof RemoteFilesError && e.status === 404 ? null : undefined),
        );
        if (there === undefined) throw new RemoteFilesError(`An earlier copy, ${unsettled}, may have been saved, and still can't be read to check. Try again once it can.`);
        unsettledCopies.delete(key);
        if (there === sentRevision) return unsettled;
      }
      const listing = await io.listNames(folder);
      const path = joinPath(listing.path, freeName(base.name, listing.names));
      let lost: string | undefined;
      try {
        await io.writeText(path, outgoing, false);
      } catch (e) {
        if (!isLost(e)) throw e;
        lost = e.lost;
      }
      // Read back, which also settles a lost answer: retrying then would make a second copy.
      const back = await io.readBytes(path).catch((e) => {
        unsettledCopies.set(key, path);
        throw new RemoteFilesError(`${lost ? `The copy's answer was lost (${lost})` : `Hermes saved ${path}`}, but it couldn't be read back to check: ${errorText(e)}`);
      });
      if (back.path !== path || (await revisionOf(back.bytes)) !== sentRevision)
        throw new RemoteFilesError(`${path} on the server isn't your edit${lost ? ` (the save's answer was lost: ${lost})` : ""}. Something else may have written it.`);
      return path;
    },
  };
}

const fmtBytes = (n?: number) => (n === undefined ? "an unknown size" : `${n.toLocaleString("en-US")} bytes`);

/** `name (2).ext`, `name (3).ext`, … : the first that `taken` doesn't have. A leading dot isn't an extension's. */
export function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A path Hermes never lists, reads or sends, and doesn't guard on write (`_is_sensitive_path` at `bf0203a`); the Rust
 * side refuses to upload there too (`protected_server_path`). This copy only lets the upload dialog say so up front.
 */
export function protectedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const names = ["auth.json", "auth.lock", "credentials", "config.yaml", ".anthropic_oauth.json", "google_token.json", "google_oauth_pending.json", "google_oauth.json", "webhook_subscriptions.json", "bws_cache.json", "bws_cache.enc.json", ".git-credentials"];
  return name === ".env" || name.startsWith(".env.") || name === ".envrc" || names.includes(name) || path.split("/").some((p) => ["mcp-tokens", "pairing"].includes(p.toLowerCase()));
}

/**
 * Hermes's 404 for a container path (`/workspace/…`, `/root/…`) it couldn't map to a file on its machine
 * (`SANDBOX_NOT_FOUND` at `f0d94882`): the file may be in the agent's sandbox, out of the dashboard's reach.
 */
export const SANDBOX_NOT_FOUND_PREFIX = "File not found on the gateway host";
/** Hermes's 409 when a save names a chat whose own copy of the file is gone (`SANDBOX_COPY_MISSING`). */
export const SANDBOX_COPY_MISSING = "File is no longer in this session's workspace";
/** What the owner reads for `SANDBOX_NOT_FOUND`. */
export const SANDBOX_MISSING = "Hermes can't find it in its chat's sandbox. It may have been removed, or be in a sandbox the dashboard can't read.";

const OFFLINE = [/^Not connected to Hermes/, /^The chat connection is closed/, /^Can't reach the Hermes dashboard/];

/**
 * A failed call in the owner's words. A refused one is a `RestError`, its body cut at 300 characters
 * (`TransportError::Unexpected`). The dashboard's own reasons are FastAPI `{"detail": ...}` bodies (`files.py`).
 */
export function explain(e: unknown, what: "list" | "read" | "write", previewMax?: number): RemoteFilesError {
  const message = errorText(e);
  if (OFFLINE.some((re) => re.test(message))) return new RemoteFilesError("Hermes isn't connected. Server files can be browsed again once it is.", undefined, true);
  if (statusOf(e) === 401) return new RemoteFilesError(message, 401, true);
  if (/^it's .* MB now, over the .* MB limit/.test(message))
    return new RemoteFilesError(`The file grew past what a preview reads${previewMax ? ` (${formatBytes(previewMax)})` : ""}.`, 413);
  if (!(e instanceof RestError)) return new RemoteFilesError(message);
  const status = e.status;
  let detail = e.body.trim();
  try {
    const parsed = JSON.parse(detail) as { detail?: unknown; error?: unknown };
    const d = parsed.detail ?? parsed.error;
    if (typeof d === "string") detail = d;
  } catch {
    // Not JSON (or cut short): show it as it came.
  }
  const itsA = what === "list" ? "folder" : "file";
  const known: Record<string, string> = {
    // The route itself is missing: FastAPI's default 404.
    "Not Found": "This Hermes server has no file browser (GET /api/files). It needs a Hermes version whose dashboard has the Files tab.",
    "Path not found": `That ${itsA} isn't on the server, or is gone now.`,
    "File not found": "That file isn't on the server, or is gone now.",
    "Path is not a directory": "That's a file, not a folder.",
    "Path is not a file": "That isn't a regular file.",
    "Directory is not readable": "The Hermes server's user isn't allowed to open this folder.",
    "File is not readable": "The Hermes server's user isn't allowed to read this file.",
    "Path outside managed files root": "The server only lets you browse inside its files folder.",
    "Access to sensitive files is not allowed": "Hermes doesn't show credential files, such as .env or auth.json.",
    "File is too large": "Hermes won't send files over 100 MB.",
    "Path cannot contain '..'": "Type the path without '..' in it.",
    "Path must be absolute": "Type a full path, starting with / or ~.",
    "Invalid path": "That isn't a path the server can open.",
  };
  if (detail in known) return new RemoteFilesError(known[detail], status);
  if (status === 404 && detail.startsWith(SANDBOX_NOT_FOUND_PREFIX)) return new RemoteFilesError(SANDBOX_MISSING, status);
  if (status === 403) return new RemoteFilesError(`The server refused: ${detail}`, status);
  const doing = what === "list" ? "list this folder" : what === "read" ? "read this file" : "write this file";
  return new RemoteFilesError(`The server couldn't ${doing} (${status}): ${detail || "no reason given"}`, status);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function joinPath(dir: string, name: string) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function notAListing(): RemoteFilesError {
  return new RemoteFilesError("The server's answer isn't a file list. Its Hermes may be too old for the file browser (it needs GET /api/files).");
}

export function parseListing(body: string, listedAt: number): RemoteListing {
  let wire: { path?: unknown; parent?: unknown; entries?: unknown; locked_root?: unknown; root?: unknown };
  try {
    wire = JSON.parse(body);
  } catch {
    throw notAListing();
  }
  const path = optionalText(wire?.path);
  if (!path || !Array.isArray(wire.entries)) throw notAListing();
  const entries: RemoteEntry[] = [];
  for (const raw of wire.entries as WireEntry[]) {
    const name = optionalText(raw?.name);
    const at = optionalText(raw?.path);
    if (!name || !at) continue;
    const expected = joinPath(path, name);
    if (raw.broken_link === true) {
      entries.push({ name, path: expected, kind: "broken-link" });
      continue;
    }
    const size = num(raw.size);
    const mtime = num(raw.mtime);
    entries.push({
      name,
      path: at,
      kind: raw.is_directory === true ? "dir" : "file",
      size: raw.is_directory === true ? undefined : size,
      modified: mtime === undefined ? undefined : Math.round(mtime * 1000),
      mime: optionalText(raw.mime_type),
      // The server lists a link by where it leads; an entry anywhere else than inside this folder is one.
      linkTarget: at === expected ? undefined : at,
    });
  }
  const root = optionalText(wire.locked_root) ?? optionalText(wire.root);
  return { path, parent: optionalText(wire.parent) ?? undefined, entries, root: root || undefined, listedAt };
}

/** Mirrors the server's own test for binary text previews (`_fs_looks_binary`, `files.py`): a NUL, or over 12% control bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if (!head.length) return false;
  let odd = 0;
  for (const b of head) {
    if (b === 0) return true;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) odd++;
  }
  return odd / head.length > 0.12;
}

function parseRead(body: string, entry: RemoteEntry, support: PreviewSupport, asText: boolean): RemotePreview {
  let wire: { data_url?: unknown; size?: unknown; mime_type?: unknown; name?: unknown; path?: unknown };
  try {
    wire = JSON.parse(body);
  } catch {
    throw new RemoteFilesError("The server's answer isn't a file.");
  }
  const dataUrl = optionalText(wire?.data_url);
  const m = dataUrl && /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(dataUrl);
  if (!dataUrl || !m) throw new RemoteFilesError("The server's answer isn't a file.");
  const name = optionalText(wire.name) ?? entry.name;
  const path = optionalText(wire.path) ?? entry.path;
  const mime = optionalText(wire.mime_type) ?? m[1] ?? entry.mime ?? "application/octet-stream";
  const max = "max" in support ? support.max : TEXT_PREVIEW_MAX_BYTES;
  const size = num(wire.size) ?? entry.size ?? 0;
  if (size > max) throw new RemoteFilesError(tooLarge(size, max));
  if (support.kind === "image" && !asText) {
    if (!IMAGE_DATA_URL.test(dataUrl)) throw new RemoteFilesError("The server's answer isn't an image.");
    return { kind: "image", path, name, size, mime, dataUrl };
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(dataUrl.slice(m[0].length)), (c) => c.charCodeAt(0));
  } catch {
    throw new RemoteFilesError("The server's answer isn't a file.");
  }
  if (looksBinary(bytes)) return { kind: "binary", path, name, size, mime };
  return { kind: "text", path, name, size, text: new TextDecoder("utf-8").decode(bytes) };
}

/** One step of the path shown above the listing. */
export type Crumb = { label: string; path: string };

/**
 * The folders from the top down to `path`. With a locked `root`, the trail starts there, since nothing above it can
 * be opened; otherwise it starts at `/`.
 */
export function crumbs(path: string, root?: string): Crumb[] {
  const clean = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  path = clean(path);
  if (root && (path === clean(root) || path.startsWith(clean(root) === "/" ? "/" : `${clean(root)}/`))) {
    root = clean(root);
    const out: Crumb[] = [{ label: root, path: root }];
    let at = root;
    for (const part of path.slice(root.length).split("/").filter(Boolean)) {
      at = joinPath(at, part);
      out.push({ label: part, path: at });
    }
    return out;
  }
  const out: Crumb[] = [{ label: "/", path: "/" }];
  let at = "/";
  for (const part of path.split("/").filter(Boolean)) {
    at = joinPath(at, part);
    out.push({ label: part, path: at });
  }
  return out;
}
