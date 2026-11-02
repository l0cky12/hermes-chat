// Server files: a read-only view of the files on the machine the Hermes dashboard runs on, through the dashboard's own
// file-browser routes, `GET /api/files` and `GET /api/files/read` (the official web dashboard's Files tab uses the
// same two). The server decides what may be read: it lists and reads as its own OS user, can lock browsing to one
// folder, and never lists or reads credential files such as `.env` or `auth.json`. Nothing here touches the files on
// this computer. Wire details: docs/research/hermes-gateway-api.md, "Server files".

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

export type RemoteFiles = {
  /** Lists a folder by its absolute path on the server, or the server's starting folder when `path` is left out. */
  list(path?: string): Promise<RemoteListing>;
  /** Reads `entry` for its preview. `asText` reads an unknown type as text. */
  preview(entry: RemoteEntry, asText?: boolean): Promise<RemotePreview>;
};

export function remoteFiles(get: RemoteGet): RemoteFiles {
  return {
    async list(path) {
      const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
      const body = await call(() => get(`api/files${query}`), "list");
      return parseListing(body, Date.now());
    },
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

const MB = 1024 * 1024;
const mb = (n: number) => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
const tooLarge = (size: number, max: number) => `It's ${mb(size)}. Previews go up to ${mb(max)}.`;

/** Raster and vector images the webview shows in an `<img>`, where an SVG can't run scripts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);
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
    throw explain(e instanceof Error ? e.message : String(e), what, previewMax);
  }
}

const OFFLINE = [/^Not connected to Hermes/, /^The chat connection is closed/, /^Can't reach the Hermes dashboard/];

/**
 * The Rust side reports a refused call as `The dashboard answered <status>: <body>`, the body cut at 300 characters
 * (`TransportError::Unexpected`). The dashboard's own reasons are FastAPI `{"detail": ...}` bodies (`files.py`).
 */
export function explain(message: string, what: "list" | "read", previewMax?: number): RemoteFilesError {
  if (OFFLINE.some((re) => re.test(message))) return new RemoteFilesError("Hermes isn't connected. Server files can be browsed again once it is.", undefined, true);
  if (/^The dashboard sign-in has expired/.test(message)) return new RemoteFilesError(message, 401, true);
  if (/^it's .* MB now, over the .* MB limit/.test(message))
    return new RemoteFilesError(`The file grew past what a preview reads${previewMax ? ` (${mb(previewMax)})` : ""}.`, 413);
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return new RemoteFilesError(message);
  const status = Number(m[1]);
  let detail = m[2].trim();
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
  if (status === 403) return new RemoteFilesError(`The server refused: ${detail}`, status);
  return new RemoteFilesError(`The server couldn't ${what === "list" ? "list this folder" : "read this file"} (${status}): ${detail || "no reason given"}`, status);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
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
  const path = str(wire?.path);
  if (!path || !Array.isArray(wire.entries)) throw notAListing();
  const entries: RemoteEntry[] = [];
  for (const raw of wire.entries as WireEntry[]) {
    const name = str(raw?.name);
    const at = str(raw?.path);
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
      mime: str(raw.mime_type),
      // The server lists a link by where it leads; an entry anywhere else than inside this folder is one.
      linkTarget: at === expected ? undefined : at,
    });
  }
  const root = str(wire.locked_root) ?? str(wire.root);
  return { path, parent: str(wire.parent) ?? undefined, entries, root: root || undefined, listedAt };
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
  const dataUrl = str(wire?.data_url);
  const m = dataUrl && /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(dataUrl);
  if (!dataUrl || !m) throw new RemoteFilesError("The server's answer isn't a file.");
  const name = str(wire.name) ?? entry.name;
  const path = str(wire.path) ?? entry.path;
  const mime = str(wire.mime_type) ?? m[1] ?? entry.mime ?? "application/octet-stream";
  const max = "max" in support ? support.max : TEXT_PREVIEW_MAX_BYTES;
  const size = num(wire.size) ?? entry.size ?? 0;
  if (size > max) throw new RemoteFilesError(tooLarge(size, max));
  if (support.kind === "image" && !asText) return { kind: "image", path, name, size, mime, dataUrl };
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
