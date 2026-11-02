// The files on a fake Hermes server, for tests of the file browser: `GET /api/files` and `GET /api/files/read` as the
// deployed `bf0203a` answers them (`hermes_cli/web_routers/files.py`, `hermes_cli/web_server_files.py`). Listings
// resolve symbolic links, skip credential files and sort folders first; refusals are FastAPI `{"detail"}` bodies,
// worded as the Rust side reports them.

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
  throw new Error(`The dashboard answered ${status}: ${JSON.stringify({ detail })}`);
};

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const isSensitive = (p: string) => {
  const name = basename(p).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name === ".envrc" || SENSITIVE.has(name) || p.split("/").some((s) => SENSITIVE_DIRS.has(s.toLowerCase()));
};

export class FakeServerFiles {
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

  /** `GET /api/files/read?path=`: the whole file as a base64 data URL. */
  read(query: URLSearchParams) {
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
