// What the preview pane beside the chat can show, and how it reads it. Terms follow GLOSSARY.md "Preview pane".
// A Server file is read on the Hermes server through dashboard REST `GET /api/fs/read-text` and
// `GET /api/fs/read-data-url` (research doc "Preview pane"). A Local file is one the owner picked on this computer in
// the native Open dialog; Rust reads it (src-tauri/src/transport.rs `read_local_text`). Web pages load in a sandboxed
// frame (ADR 0007). Everything shown is untrusted: nothing here turns it into HTML the app itself renders.
import type { Item } from "./model";
import { SANDBOX_MISSING, SANDBOX_NOT_FOUND_PREFIX, SESSION_GONE, type RemotePreview } from "./remoteFiles";
import type { ArtifactRef } from "./artifacts";

/**
 * What the Preview shows (nothing open is no target: previewHistory.ts). `server`: a path on the Hermes server.
 * `local`: a file on this computer the owner picked. `web`: an http(s) page. `tool`: a tool call's output, as Hermes
 * sent it.
 */
export type PreviewTarget =
  /**
   * `on`: for a page on a loopback address (`loopbackOf`), whose loopback it is: the Hermes server's, through an SSH
   * tunnel (the default, since that is where Hermes runs what it starts), or this computer's (ADR 0052).
   */
  | { kind: "web"; url: string; on?: PageOn }
  /**
   * `host`: on the dashboard's own machine, read through the managed files routes (ADR 0012), not where tools run.
   * `session`: the chat whose sandbox the path is in, an Output's (outputs.ts `sessionOf`, ADR 0062).
   */
  | { kind: "server"; path: string; host?: boolean; session?: string }
  /** An Output open to edit (artifacts.ts, ADR 0029): read and saved on the machine `ref` names. */
  | { kind: "artifact"; ref: ArtifactRef }
  | { kind: "local"; path: string; name: string }
  | { kind: "tool"; name: string; text: string };

/**
 * A file as the pane shows it. `text`: its first part when `truncated`; `format` picks the view: Markdown and HTML
 * have a rendered view beside the source. `image`: a `data:` or `blob:` URL of an image. `unsupported`: why the pane
 * can't show it.
 */
export type FileView =
  | { kind: "text"; text: string; language: string; format: "markdown" | "html" | "code"; size: number; truncated: boolean }
  | { kind: "image"; src: string; size?: number }
  | { kind: "unsupported"; reason: string; size?: number };

/**
 * What a site answered when Rust asked for a page the way the preview's frame does (src-tauri/src/web_page.rs, ADR
 * 0011). `refused`: its response forbids being shown inside another app; `by` is the header that says so.
 * `unreachable`: this computer couldn't connect to it. `notRefused`: nothing said no, which doesn't promise it shows.
 */
export type Framing = { kind: "refused"; by: string } | { kind: "unreachable"; message: string } | { kind: "notRefused" };

/** The most text Hermes's `read-text` returns, and the most Rust reads of a Local file (`_FS_TEXT_PREVIEW_MAX_BYTES`). */
export const TEXT_PREVIEW_BYTES = 512 * 1024;

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
/** The images a local preview reads: the ones Rust's `read_preview` takes. */
const LOCAL_IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MARKDOWN_NAME = /\.(md|markdown|mdx)$/i;
const HTML_NAME = /\.x?html?$/i;
/** `data:` URLs the pane shows as images. SVG in an `<img>` runs no scripts. */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]*$/;

/**
 * Text from a tool, with its bidi embedding, override and isolate controls made visible as `\uFFFD`: they can make a
 * file name read backwards (`invoice\u202Efdp.exe` shows as `invoiceexe.pdf`). Text in a right-to-left language
 * doesn't need them, and the marks and joiners it does use are kept.
 */
export const withoutBidi = (text: string) => text.replace(/[\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");

/** The last part of a path or URL, for a tool call's chip. */
export function previewName(t: PreviewTarget): string {
  switch (t.kind) {
    case "tool":
      return `${t.name} output`;
    case "local":
      return t.name;
    case "server":
      return t.path.split("/").filter(Boolean).pop() ?? t.path;
    case "artifact":
      return t.ref.path.split("/").filter(Boolean).pop() ?? t.ref.path;
    case "web":
      try {
        const u = new URL(t.url);
        return u.pathname.split("/").filter(Boolean).pop() || u.host;
      } catch {
        return t.url;
      }
  }
}

/**
 * A web address the pane will load, or why it won't. Only http(s); no username or password in it; and never the app's
 * own origin, since a frame on it could reach the app (ADR 0007).
 */
export function checkWebUrl(raw: string, appOrigin: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "That isn't a web address." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { error: `Only http:// and https:// pages open in the preview, and ${u.protocol} isn't a web address.` };
  if (u.username || u.password) return { error: "Web addresses with a username or password in them don't open in the preview." };
  if (!u.hostname) return { error: "That isn't a web address." };
  if (u.origin === appOrigin) return { error: "Hermes Chat's own pages don't open in the preview." };
  return { url: u.href };
}

/** Where a page on a loopback address is loaded from: the Hermes server's loopback, or this computer's. */
export type PageOn = "server" | "local";

/** The loopback names a page can be on (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`), as `URL` normalises them. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Where an http(s) address on a loopback address points, as `localhost:3000`, or undefined for any other address. The
 * same hosts Rust takes for a server page (src-tauri/src/server_page.rs `server_page`); Rust checks again.
 */
export function loopbackOf(raw: string): { at: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK_HOSTS.has(u.hostname)) return undefined;
  return { at: `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}` };
}

/**
 * What a link points at. `page`: an http(s) page `checkWebUrl` passed, which the Preview and this computer's browser
 * both open. `serverPage`: one on a loopback address, the Hermes server's, which only the Preview's SSH tunnel reaches
 * (ADR 0052). `elsewhere`: anything the Preview won't load (`mailto:`, a relative path, `file:`, credentials, the app's
 * own origin), which opens nowhere and can only be copied. `url` is the checked address that opens; `href` is the
 * link's address as written.
 */
export type LinkTarget = { kind: "page"; url: string } | { kind: "serverPage"; url: string } | { kind: "elsewhere"; href: string };

/** A link's `href` as a `LinkTarget`. Undefined for none, an empty one or a same-page `#anchor`, which go nowhere else. */
export function linkTarget(href: string | undefined, appOrigin: string): LinkTarget | undefined {
  if (!href?.trim() || href.startsWith("#")) return undefined;
  const web = checkWebUrl(href, appOrigin);
  if (!("url" in web)) return { kind: "elsewhere", href };
  return { kind: loopbackOf(web.url) ? "serverPage" : "page", url: web.url };
}

export type WebTarget = Extract<PreviewTarget, { kind: "web" }>;

/** Where a web target loads from: `server` or `local` for a loopback address, undefined for any other page. */
export const pageOn = (t: WebTarget): PageOn | undefined => (loopbackOf(t.url) ? (t.on ?? "server") : undefined);

/**
 * An address in the page view's own terms: what it loads and reports. For a Server page that is its tunnel's end on
 * this computer (`http://127.0.0.1:41234/a`); for any other page, the page's own address. Branded so the owner's
 * `localhost:5173` never reaches the view, where it would load this computer's port instead of the server's.
 */
export type ViewUrl = string & { readonly __view: unique symbol };

/** A Server page's tunnel: the page's origin on the server, and the origin its tunnel answers on here. */
export type Tunnel = { remote: string; local: string };

/** `url` from its origin on: path, query and fragment. */
const afterOrigin = (url: URL) => url.href.slice(url.origin.length);

/** The server origin a web target needs a tunnel to: a loopback page on the server. Undefined for any other page. */
export const tunnelNeeded = (t: WebTarget): string | undefined => (pageOn(t) === "server" ? new URL(t.url).origin : undefined);

/**
 * Where the view loads `t`: through `tunnel` when `t` needs one (undefined until that tunnel is open), else `t.url`.
 * The only way to make a `ViewUrl` from the owner's address. Only the origin is swapped, so a page `fromView` mapped
 * comes back as the exact address the view reported.
 */
export function viewUrlOf(t: WebTarget, tunnel: Tunnel | undefined): ViewUrl | undefined {
  const need = tunnelNeeded(t);
  if (!need) return t.url as ViewUrl;
  return tunnel?.remote === need ? ((tunnel.local + afterOrigin(new URL(t.url))) as ViewUrl) : undefined;
}

/**
 * The page the view reports, as the owner's address. On the tunnel's origin: the server's page. Another loopback
 * address, which a page reaches only by its full address: this computer's (ADR 0052). Anything else: a web page.
 */
export function fromView(url: ViewUrl, tunnel: Tunnel | undefined): WebTarget {
  const u = new URL(url);
  if (tunnel && u.origin === tunnel.local) return { kind: "web", url: tunnel.remote + afterOrigin(u), on: "server" };
  return loopbackOf(url) ? { kind: "web", url, on: "local" } : { kind: "web", url };
}

/** What the address box shows: a loopback page as a dev server prints it (`localhost:5173/a`), a path, or a name. */
export function addressOf(t: PreviewTarget): string {
  switch (t.kind) {
    case "web": {
      const u = new URL(t.url);
      if (!loopbackOf(t.url) || u.protocol !== "http:") return t.url;
      const rest = afterOrigin(u);
      return u.host + (rest === "/" ? "" : rest);
    }
    case "server":
    case "local":
      return t.path;
    case "artifact":
      return t.ref.path;
    case "tool":
      return `${t.name} output`;
  }
}

/**
 * The address Rust gave for a server page's tunnel, if it is what Rust makes: http(s) on `127.0.0.1` at a port, and
 * never the app's own origin. Anything else isn't loaded.
 */
export function tunnelUrl(raw: string, appOrigin: string): string | undefined {
  const web = checkWebUrl(raw, appOrigin);
  if (!("url" in web)) return undefined;
  const u = new URL(web.url);
  return u.hostname === "127.0.0.1" && u.port ? web.url : undefined;
}

/** A path the server can read: absolute, or under its home (`~/`). Relative paths would resolve in Hermes's own folder. */
export const isServerPath = (raw: string) => /^(\/|~\/)/.test(raw) && !raw.includes("\0") && raw.length <= 4096;

/**
 * What the owner typed in the pane's address box: a web page, a dev server's bare port (a Server page, `pageOn`), or a
 * Server file. Local files open only through the Open dialog, so a `file://` address says so.
 */
export function parseAddress(raw: string, appOrigin: string): { target: PreviewTarget } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "Enter a web address or a path on the Hermes server." };
  if (/^file:/i.test(text)) return { error: "To preview a file on this computer, use Open a file on this computer." };
  if (isServerPath(text)) return { target: { kind: "server", path: text } };
  if (/^\d{1,5}$/.test(text) && +text > 0 && +text < 65536) return parseAddress(`localhost:${text}`, appOrigin);
  // `localhost:3000` as a dev server prints it, without its scheme: a web page on a loopback address.
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d{1,5})?([/?#]|$)/i.test(text)) return parseAddress(`http://${text}`, appOrigin);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const web = checkWebUrl(text, appOrigin);
    return "url" in web ? { target: { kind: "web", url: web.url } } : web;
  }
  return { error: "Enter a web address starting with http:// or https://, or a full path on the Hermes server starting with / or ~/." };
}

type ToolItem = Extract<Item, { kind: "tool" }>;
/** `MEDIA:/path` tags, which Hermes's tools put in their results for files they made (`tools/mcp_tool_content.py`). */
const MEDIA_TAG = /MEDIA:(\/[^\s"'`<>)\]]+)/g;
const MAX_TOOL_TARGETS = 6;

/**
 * The files and pages a tool call names, to open in the preview: `path` and `file_path` (read_file, write_file,
 * patch), `url` and `image_url` (browser_navigate, vision_analyze), `urls` (web_extract), and `MEDIA:` tags in the
 * result. Paths are on the server, since that is where Hermes runs its tools. Each is listed once.
 */
export function toolTargets(t: ToolItem, appOrigin: string): PreviewTarget[] {
  const out: PreviewTarget[] = [];
  const seen = new Set<string>();
  const add = (target: PreviewTarget, key: string) => {
    if (seen.has(key) || out.length >= MAX_TOOL_TARGETS) return;
    seen.add(key);
    out.push(target);
  };
  const path = (v: unknown) => typeof v === "string" && isServerPath(v) && add({ kind: "server", path: v }, `s:${v}`);
  const url = (v: unknown) => {
    if (typeof v !== "string") return;
    const web = checkWebUrl(v, appOrigin);
    if ("url" in web) add({ kind: "web", url: web.url }, `w:${web.url}`);
  };
  const args = t.args ?? {};
  path(args.path);
  path(args.file_path);
  url(args.url);
  url(args.image_url);
  if (Array.isArray(args.urls)) args.urls.forEach(url);
  // A tag ending a sentence keeps its full stop out of the path.
  for (const m of (t.result ?? "").matchAll(MEDIA_TAG)) path(m[1].replace(/[.,;:!?]+$/, ""));
  return out;
}

/** A known language for the code view, as highlight.js names it; plain text otherwise. */
const LANGUAGES: Record<string, string> = {
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  css: "css",
  go: "go",
  graphql: "graphql",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  diff: "diff",
  patch: "diff",
  php: "php",
  swift: "swift",
  cs: "csharp",
};
/** Hermes's own `language` names (`_FS_PREVIEW_LANGUAGE_BY_EXT`) that highlight.js calls something else. */
const SERVER_LANGUAGES: Record<string, string> = { html: "xml", jsx: "javascript", tsx: "typescript", shell: "bash", toml: "ini", text: "", csv: "" };

const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "";
export const languageOf = (name: string) => LANGUAGES[extOf(name)] ?? "";
const formatOf = (name: string): "markdown" | "html" | "code" => (MARKDOWN_NAME.test(name) ? "markdown" : HTML_NAME.test(name) ? "html" : "code");

/** Why a file that isn't text or an image can't be shown. */
function unsupported(name: string, mime: string | undefined, size?: number): FileView {
  const what =
    /\.pdf$/i.test(name) || mime === "application/pdf" ? "PDF files" : mime && mime !== "application/octet-stream" ? `${mime} files` : "binary files";
  return { kind: "unsupported", reason: `The preview can't show ${what}.`, size };
}

/** `read-text`'s answer (`hermes_cli/web_routers/files.py` `fs_read_text` at the deployed `bf0203a`). */
type ReadText = { binary?: boolean; byteSize?: number; language?: string; mimeType?: string; path?: string; text?: string; truncated?: boolean };

/** A failed dashboard request, as the Rust relay and FakeHermes word it: `The dashboard answered 404: {"detail":…}`. */
function serverFileError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (message === "Not connected to Hermes.") return new Error("Files on the server can't be read while Hermes Chat isn't connected.");
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return new Error(message);
  let detail = m[2].trim();
  try {
    const d = JSON.parse(detail).detail;
    if (typeof d === "string") detail = d;
  } catch {
    // Not JSON (or cut short by the relay): the text as it came.
  }
  const status = Number(m[1]);
  if (status === 404 && detail === "Not Found") return new Error("This Hermes server can't read files for the preview.");
  if (status === 404 && detail === "File not found") return new Error("There's no file at this path on the Hermes server.");
  if (status === 404 && detail.startsWith(SANDBOX_NOT_FOUND_PREFIX)) return new Error(SANDBOX_MISSING);
  if (status === 403 && /sensitive/i.test(detail)) return new Error("Hermes doesn't show this file, since it may hold credentials.");
  if (status === 400 && detail === "Path points to a directory") return new Error("This path is a folder on the Hermes server, not a file.");
  if (status === 413) return new Error("This file is too large for Hermes to preview.");
  if (status === 409) return new Error("Hermes is using this file right now. Try again in a moment.");
  return new Error(detail || message);
}

/**
 * Reads a Server file for the pane. `get` is a signed-in dashboard REST GET returning the parsed body. Images go as a
 * `data:` URL, up to Hermes's 16 MB; anything else as text, up to its first 512 KB. A binary file that isn't an image
 * is `unsupported`. Failures reject with a message for the owner. `session`: the chat whose sandbox the path is in
 * (ADR 0062), named as `session_id`; a chat Hermes no longer has is left out and the file read as before.
 */
export async function readServerFile(get: (pathAndQuery: string) => Promise<unknown>, path: string, profile: string, session?: string): Promise<FileView> {
  if (!isServerPath(path)) throw new Error("Only full paths on the Hermes server, starting with / or ~/, open in the preview.");
  let chat = session;
  const query = () => new URLSearchParams({ path, profile, ...(chat && { session_id: chat }) }).toString();
  const fetch = (route: string) =>
    get(`${route}?${query()}`).catch((e) => {
      if (!chat || !SESSION_GONE.test(e instanceof Error ? e.message : String(e))) throw e;
      chat = undefined;
      return get(`${route}?${query()}`);
    });
  const image = async (size?: number): Promise<FileView> => {
    const res = (await fetch("api/fs/read-data-url").catch((e) => Promise.reject(serverFileError(e)))) as { dataUrl?: unknown };
    const src = typeof res.dataUrl === "string" ? res.dataUrl : "";
    if (!IMAGE_DATA_URL.test(src)) return unsupported(path, /^data:([^;,]+)/.exec(src)?.[1], size);
    const base64 = src.slice(src.indexOf(",") + 1);
    return { kind: "image", src, size: size ?? (base64.length * 3) / 4 - (base64.match(/=*$/)?.[0].length ?? 0) };
  };
  if (IMAGE_NAME.test(path)) return image();
  const res = (await fetch("api/fs/read-text").catch((e) => Promise.reject(serverFileError(e)))) as ReadText;
  const size = typeof res.byteSize === "number" ? res.byteSize : undefined;
  if (res.binary) return res.mimeType?.startsWith("image/") ? image(size) : unsupported(path, res.mimeType, size);
  const text = typeof res.text === "string" ? res.text : "";
  const lang = res.language ?? "";
  return {
    kind: "text",
    text,
    language: lang in SERVER_LANGUAGES ? SERVER_LANGUAGES[lang] : lang || languageOf(path),
    format: formatOf(path),
    size: size ?? text.length,
    truncated: !!res.truncated,
  };
}

/** A file the managed files routes read (remoteFiles.ts `preview`), as the pane shows it. */
export function hostFileView(p: RemotePreview): FileView {
  if (p.kind === "image") return { kind: "image", src: p.dataUrl, size: p.size };
  if (p.kind === "binary") return unsupported(p.name, p.mime, p.size);
  return { kind: "text", text: p.text, language: languageOf(p.name), format: formatOf(p.name), size: p.size, truncated: false };
}

/** A Local file's text as Rust reads it: its first 512 KB, and whether it looks binary. */
export type LocalText = { size: number; truncated: boolean; binary: boolean; text: string };

/**
 * Reads a Local file for the pane: images through `readImage` (Rust's `read_preview`, image files up to 25 MB), anything
 * else through `readText`. `readImage` resolves to an object URL, which the caller revokes.
 */
export async function readLocalFile(
  file: { path: string; name: string },
  io: { readText: (path: string) => Promise<LocalText>; readImage: (path: string) => Promise<string> },
): Promise<FileView> {
  if (LOCAL_IMAGE_NAME.test(file.name)) return { kind: "image", src: await io.readImage(file.path) };
  const t = await io.readText(file.path);
  if (t.binary) return unsupported(file.name, undefined, t.size);
  return { kind: "text", text: t.text, language: languageOf(file.name), format: formatOf(file.name), size: t.size, truncated: t.truncated };
}

/**
 * The document an HTML file renders as. It goes in a frame with every sandbox flag off, so it runs no scripts and has
 * no origin; this policy also keeps it from loading anything from the network.
 */
export function sandboxedHtml(html: string): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";
  return `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${html}`;
}

/** A Markdown code fence longer than any run of backticks in `text`, so the file can't close it early. */
export function fenced(text: string, language: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
