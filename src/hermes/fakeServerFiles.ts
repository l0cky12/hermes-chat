// The files on a fake Hermes server, for tests of the file browser: `GET /api/files`, `GET /api/files/read` and
// `GET /api/files/download` as the deployed `bf0203a` answers them (`hermes_cli/web_routers/files.py`, `hermes_cli/web_server_files.py`). Listings
// resolve symbolic links, skip credential files and sort folders first; refusals are FastAPI `{"detail"}` bodies in a
// `RestError`, as the Rust side reports them.
import { RestError } from "./pipe";

/**
 * One node on the server's disk. A file has its text (sent as UTF-8), its raw `bytes` (one char per byte), or only a
 * `size` when it's too big to make. `unreadable`: the
 * server's OS user can't open it. `link`: a symbolic link to that absolute path, which may not exist.
 */
export type ServerNode =
  | { dir: true; unreadable?: boolean; mtime?: number }
  | { text: string; mime?: string; unreadable?: boolean; mtime?: number }
  | { bytes: string; mime?: string; mtime?: number }
  | { size: number; mime?: string; mtime?: number }
  | { link: string };

const MiB = 1024 * 1024;
/** `_MANAGED_FILE_MAX_BYTES` in `hermes_cli/web_server.py` at `bf0203a`. */
const READ_MAX_BYTES = 100 * MiB;
/** `_SENSITIVE_MANAGED_FILE_BASENAMES`, in part, and `_SENSITIVE_MANAGED_DIR_NAMES`. */
const SENSITIVE = new Set(["auth.json", "credentials", "config.yaml", ".git-credentials"]);
const SENSITIVE_DIRS = new Set(["mcp-tokens", "pairing"]);
/** What Python's `mimetypes.guess_type` says for the extensions tests use. */
const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  py: "text/x-python",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ts: "video/mp2t",
  mp4: "video/mp4",
  zip: "application/zip",
  pdf: "application/pdf",
  log: "text/plain",
};

const fail = (status: number, detail: string): never => {
  throw new RestError(status, JSON.stringify({ detail }));
};

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const thrown = (e: string | Error) => (typeof e === "string" ? new Error(e) : e);
const isSensitive = (p: string) => {
  const name = basename(p).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name === ".envrc" || SENSITIVE.has(name) || p.split("/").some((s) => SENSITIVE_DIRS.has(s.toLowerCase()));
};

const STOPPED = "The transfer was stopped.";

export class FakeServerFiles {
  /** This computer's disk: what downloads wrote, by local path. */
  readonly local: Record<string, Uint8Array> = {};
  /** The native Save dialog: the local path the owner picks for a suggested name, or undefined when they close it. */
  saveDialog: (name: string) => string | undefined = (name) => `/home/me/Downloads/${name}`;
  /** Set: each download reports progress once more after it has ended, as a late Channel message would. */
  lateProgress = false;
  /** Set: a download fails this way halfway, as the Rust side words it (a full disk, a dropped connection). */
  transferError?: string;
  /** Set: a download holds here after reporting its first bytes, until the promise settles. */
  transferGate?: Promise<void>;
  /** Transfers running now, by id, with how to stop each (src-tauri `Transfers`). */
  private running = new Map<number, (e: Error) => void>();
  /** The server's disk, by absolute path. Folders above a node needn't be listed: they exist. */
  nodes: Record<string, ServerNode> = {};
  /** `Path.home()` for the server's OS user: where a listing with no path starts. */
  home = "/home/liam";
  /** Set: browsing is locked to this folder (`HERMES_DASHBOARD_FILES_ROOT`). */
  root?: string;
  /** Every path read, in order. */
  readonly reads: string[] = [];

  /** Follows symbolic links in every part of `p`; undefined when something on the way isn't there. */
  resolve(p: string, hops = 0): string | undefined {
    if (hops > 20) return undefined;
    let at = "/";
    for (const part of p.split("/").filter(Boolean)) {
      at = join(at, part);
      const node = this.nodes[at];
      if (node && "link" in node) {
        const target = this.resolve(node.link, hops + 1);
        if (target === undefined) return undefined;
        at = target;
      } else if (!node && !this.isDir(at)) return undefined;
    }
    return at;
  }

  private isDir(p: string) {
    const node = this.nodes[p];
    if (node) return "dir" in node;
    return p === "/" || Object.keys(this.nodes).some((k) => k.startsWith(p === "/" ? "/" : `${p}/`));
  }

  /** `_resolve_managed_path`: an absolute path (or one inside the locked root), resolved, inside the root. */
  private target(raw: string | null): string {
    const text = (raw ?? "").trim();
    let candidate: string;
    if (this.root && (!text || text === "." || text === "/")) candidate = this.root;
    else if (!text) candidate = this.home;
    else if (text.startsWith("~")) candidate = this.home + text.slice(1);
    else if (!text.startsWith("/")) {
      if (!this.root) fail(400, "Path must be absolute");
      if (text.split("/").includes("..")) fail(400, "Path cannot contain '..'");
      candidate = join(this.root!, text);
    } else candidate = text;
    if (candidate.split("/").includes("..")) fail(400, "Path cannot contain '..'");
    const resolved = this.resolve(candidate.replace(/\/+$/, "") || "/");
    if (resolved === undefined) fail(404, "Path not found");
    if (this.root && resolved !== this.root && !resolved!.startsWith(`${this.root}/`)) fail(403, "Path outside managed files root");
    return resolved!;
  }

  /** `GET /api/files?path=`. */
  list(query: URLSearchParams) {
    const dir = this.target(query.get("path"));
    if (!this.isDir(dir)) fail(400, "Path is not a directory");
    const node = this.nodes[dir];
    if (node && "unreadable" in node && node.unreadable) fail(403, "Directory is not readable");
    const names = new Set<string>();
    for (const k of Object.keys(this.nodes)) {
      if (k !== dir && dirname(k) === dir) names.add(basename(k));
      else if (k.startsWith(dir === "/" ? "/" : `${dir}/`)) names.add(k.slice(dir === "/" ? 1 : dir.length + 1).split("/")[0]);
    }
    const entries = [];
    for (const name of names) {
      const at = join(dir, name);
      if (isSensitive(at)) continue;
      const own = this.nodes[at];
      const resolved = own && "link" in own ? this.resolve(own.link) : at;
      if (resolved === undefined) {
        entries.push({ name, path: at, is_directory: false, broken_link: true, size: null, mtime: null, mime_type: null });
        continue;
      }
      if (this.root && resolved !== this.root && !resolved.startsWith(`${this.root}/`)) fail(403, "Path outside managed files root");
      const node = this.nodes[resolved];
      const isDir = this.isDir(resolved);
      const size = !node || "dir" in node || "link" in node ? null : "text" in node ? new TextEncoder().encode(node.text).length : "bytes" in node ? node.bytes.length : node.size;
      const mtime = node && "mtime" in node && node.mtime !== undefined ? node.mtime : 1_793_000_000;
      const mime = isDir ? null : ((node && "mime" in node && node.mime) || MIME[basename(resolved).split(".").pop()!.toLowerCase()] || "application/octet-stream");
      entries.push({ name, path: resolved, is_directory: isDir, size: isDir ? null : size, mtime, mime_type: mime });
    }
    entries.sort((a, b) => Number(a.is_directory === false) - Number(b.is_directory === false) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const parent = dir !== "/" && dir !== this.root ? dirname(dir) : null;
    return { path: dir, parent, entries, root: this.root ?? null, locked_root: this.root ?? null, can_change_path: !this.root };
  }

  /** `_managed_readable_file` and `_managed_file_size`: the bytes `GET /api/files/download` sends for `raw`. */
  private readable(raw: string): { at: string; bytes: Uint8Array } {
    const at = this.target(raw);
    if (this.isDir(at)) fail(400, "Path is not a file");
    if (isSensitive(at)) fail(403, "Access to sensitive files is not allowed");
    const node = this.nodes[at] as Exclude<ServerNode, { dir: true } | { link: string }>;
    if ("unreadable" in node && node.unreadable) fail(403, "File is not readable");
    const size = "text" in node ? new TextEncoder().encode(node.text).length : "bytes" in node ? node.bytes.length : node.size;
    if (size > READ_MAX_BYTES) fail(413, "File is too large");
    const bytes = "text" in node ? new TextEncoder().encode(node.text) : "bytes" in node ? Uint8Array.from(node.bytes, (c) => c.charCodeAt(0)) : new Uint8Array(size);
    return { at, bytes };
  }

  /**
   * src-tauri `files_download`: the Save dialog, then `GET /api/files/download` into a part file that takes the
   * destination's place only once complete. Stopped (`cancel`, or the connection closing), it leaves `local` as it was.
   */
  async download(id: number, path: string, name: string, onProgress: (p: { done: number; total: number; dest: string }) => void): Promise<{ dest: string; bytes: number } | undefined> {
    const dest = this.saveDialog(name);
    if (dest === undefined) return undefined;
    const stopped = new Promise<never>((_, reject) => this.running.set(id, reject));
    try {
      const { bytes } = this.readable(path);
      onProgress({ done: 0, total: bytes.length, dest });
      const half = Math.floor(bytes.length / 2);
      onProgress({ done: half, total: bytes.length, dest });
      if (this.transferGate) await Promise.race([this.transferGate, stopped]);
      if (this.transferError) throw new Error(this.transferError);
      onProgress({ done: bytes.length, total: bytes.length, dest });
      this.local[dest] = bytes;
      return { dest, bytes: bytes.length };
    } finally {
      this.running.delete(id);
      // A Channel message can reach the webview after the command's answer.
      if (this.lateProgress) setTimeout(() => onProgress({ done: 1, total: 2, dest }), 0);
    }
  }

  /** The native Open dialog's pick, as a name and its bytes (one char per byte), or undefined when closed. */
  openDialog: () => { name: string; bytes: string } | undefined = () => undefined;
  /** What each upload token stands for. */
  private picked = new Map<number, { name: string; bytes: string }>();
  private picks = 0;
  /** Every upload Hermes was sent: its path and `overwrite`. */
  readonly uploads: { path: string; overwrite: boolean }[] = [];

  /** src-tauri `files_discard_pick`. */
  discardPick(token: number) {
    this.picked.delete(token);
  }

  /** Picks not sent or let go yet. */
  get openPicks() {
    return this.picked.size;
  }

  /** src-tauri `files_pick_upload`. */
  pickUpload() {
    const file = this.openDialog();
    if (!file) return undefined;
    const token = ++this.picks;
    this.picked.set(token, file);
    return { token, name: file.name, size: file.bytes.length };
  }

  /**
   * src-tauri `files_upload` and `POST /api/files/upload-stream` at `bf0203a`: refused before sending for a credential
   * path (as Rust does); 409 for a file that's there without `overwrite`; written whole by a rename once all of it came.
   */
  async upload(id: number, token: number, path: string, overwrite: boolean, onProgress: (p: { done: number; total: number; dest: string }) => void): Promise<string> {
    const file = this.picked.get(token);
    if (!file) throw new Error("That file wasn't picked in the Open dialog, or was already sent.");
    this.picked.delete(token);
    if (isSensitive(path)) throw new Error(`Hermes Chat doesn't relay uploads to ${path}, a credential file Hermes keeps out of reach.`);
    const stopped = new Promise<never>((_, reject) => this.running.set(id, reject));
    try {
      onProgress({ done: 0, total: file.bytes.length, dest: path });
      onProgress({ done: Math.floor(file.bytes.length / 2), total: file.bytes.length, dest: path });
      if (this.transferGate) await Promise.race([this.transferGate, stopped]);
      if (this.transferError) throw new Error(this.transferError);
      this.uploads.push({ path, overwrite });
      const dir = this.target(dirname(path));
      if (this.root && dir !== this.root && !dir.startsWith(`${this.root}/`)) fail(403, "Path outside managed files root");
      const at = join(dir, basename(path));
      if (this.isDir(at)) fail(409, "A directory already exists at that path");
      if (this.nodes[at] && !overwrite) fail(409, "File already exists");
      if (this.nodes[dir] && "unreadable" in this.nodes[dir] && this.nodes[dir].unreadable) fail(403, "File is not writable");
      this.nodes[at] = { bytes: file.bytes, mtime: 1_793_100_000 };
      this.afterWrite?.(at);
      return JSON.stringify({ ok: true, path: at, entry: { name: basename(at), path: at, is_directory: false, size: file.bytes.length } });
    } finally {
      this.running.delete(id);
    }
  }

  /** Set: a save's answer is lost this way, after (`landed`) or before Hermes wrote it. */
  saveLost?: { message: string | Error; landed: boolean };
  /** Set: a save waits here before Hermes takes it, as one that gets no answer would. */
  saveGate?: Promise<void>;
  /** Set: before a save writes, the file changes as another client would change it. */
  beforeWrite?: (path: string) => void;
  /** Every text saved, in order: its path, text and `overwrite`. */
  readonly saves: { path: string; text: string; overwrite: boolean }[] = [];

  /** src-tauri `files_save_text`: the edit's text, as UTF-8, through the same upload route. */
  async saveText(path: string, text: string, overwrite: boolean): Promise<string> {
    if (isSensitive(path)) throw new Error(`Hermes Chat doesn't relay uploads to ${path}, a credential file Hermes keeps out of reach.`);
    if (this.saveGate) await this.saveGate;
    this.beforeWrite?.(path);
    const lost = this.saveLost;
    if (lost && !lost.landed) throw thrown(lost.message);
    const at = this.target(dirname(path)) === dirname(path) ? path : join(this.target(dirname(path)), basename(path));
    if (this.nodes[at] && !overwrite) fail(409, "File already exists");
    const node = this.nodes[at];
    if (node && "unreadable" in node && node.unreadable) fail(403, "File is not writable");
    this.saves.push({ path: at, text, overwrite });
    const bytes = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
    this.nodes[at] = { bytes, mime: node && "mime" in node ? node.mime : undefined, mtime: 1_793_200_000 };
    this.afterWrite?.(at);
    if (lost) throw thrown(lost.message);
    return JSON.stringify({ ok: true, path: at });
  }

  /** Called after each write lands, so a test can change the file as something else on the server would. */
  afterWrite?: (path: string) => void;

  cancel(id: number) {
    this.running.get(id)?.(new Error(STOPPED));
  }

  /** The connection closed or changed: every transfer stops (src-tauri `Transfers::stop_all`). */
  stopAll() {
    for (const stop of this.running.values()) stop(new Error(STOPPED));
  }

  /** Set: every `GET /api/files/read` fails this way, as during an outage. */
  readError?: string;

  /** `GET /api/files/read?path=`: the whole file as a base64 data URL. */
  read(query: URLSearchParams) {
    if (this.readError) throw new Error(this.readError);
    const raw = query.get("path");
    if (!raw) fail(422, "Field required");
    // A path that isn't there is "Path not found" here too: `_resolve_managed_path` resolves it strictly first.
    const at = this.target(raw);
    this.reads.push(at);
    if (this.isDir(at)) fail(400, "Path is not a file");
    if (isSensitive(at)) fail(403, "Access to sensitive files is not allowed");
    const node = this.nodes[at] as Exclude<ServerNode, { dir: true } | { link: string }>;
    if ("unreadable" in node && node.unreadable) fail(403, "File is not readable");
    const bytes = "text" in node ? new TextEncoder().encode(node.text) : "bytes" in node ? Uint8Array.from(node.bytes, (c) => c.charCodeAt(0)) : undefined;
    const size = bytes ? bytes.length : (node as { size: number }).size;
    if (size > READ_MAX_BYTES) fail(413, "File is too large");
    const mime = ("mime" in node && node.mime) || MIME[basename(at).split(".").pop()!.toLowerCase()] || "application/octet-stream";
    const base64 = bytes ? btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")) : "A".repeat(Math.ceil(size / 3) * 4);
    return { name: basename(at), path: at, size, mime_type: mime, data_url: `data:${mime};base64,${base64}`, root: this.root ?? null, locked_root: this.root ?? null, can_change_path: !this.root };
  }
}
