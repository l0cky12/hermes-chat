// What the preview pane beside the chat can show, and how it reads it. Terms follow GLOSSARY.md "Preview pane".
// A Server file is read on the Hermes server through dashboard REST `GET /api/fs/read-text` and
// `GET /api/fs/read-data-url` (research doc "Preview pane"). A Local file is one the owner picked on this computer in
// the native Open dialog; Rust reads it (src-tauri/src/transport.rs `read_local_text`). Web pages load in a sandboxed
// frame (ADR 0007). Everything shown is untrusted: nothing here turns it into HTML the app itself renders.
import type { Item } from "./model";

/**
 * What the pane shows. `start`: the pane is open with nothing in it yet. `server`: a path on the Hermes server.
 * `local`: a file on this computer the owner picked. `web`: an http(s) page. `tool`: a tool call's output, as Hermes
 * sent it.
 */
export type PreviewTarget =
  | { kind: "start" }
  | { kind: "web"; url: string }
  | { kind: "server"; path: string }
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

/** The last part of a path or URL, for the pane's title. */
export function previewName(t: PreviewTarget): string {
  switch (t.kind) {
    case "start":
      return "Preview";
    case "tool":
      return `${t.name} output`;
    case "local":
      return t.name;
    case "server":
      return t.path.split("/").filter(Boolean).pop() ?? t.path;
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
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http:// and https:// pages open in the preview." };
  if (u.username || u.password) return { error: "Web addresses with a username or password in them don't open in the preview." };
  if (!u.hostname) return { error: "That isn't a web address." };
  if (u.origin === appOrigin) return { error: "Hermes Chat's own pages don't open in the preview." };
  return { url: u.href };
}

/** A path the server can read: absolute, or under its home (`~/`). Relative paths would resolve in Hermes's own folder. */
export const isServerPath = (raw: string) => /^(\/|~\/)/.test(raw) && !raw.includes("\0") && raw.length <= 4096;

/**
 * What the owner typed in the pane's address box: a web page, or a Server file. Local files open only through the
 * Open dialog, so a `file://` address says so.
 */
export function parseAddress(raw: string, appOrigin: string): { target: PreviewTarget } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "Enter a web address or a path on the Hermes server." };
  if (/^file:/i.test(text)) return { error: "To preview a file on this computer, use Open a file on this computer." };
  if (isServerPath(text)) return { target: { kind: "server", path: text } };
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
  if (status === 403 && /sensitive/i.test(detail)) return new Error("Hermes doesn't show this file, since it may hold credentials.");
  if (status === 400 && detail === "Path points to a directory") return new Error("This path is a folder on the Hermes server, not a file.");
  if (status === 413) return new Error("This file is too large for Hermes to preview.");
  if (status === 409) return new Error("Hermes is using this file right now. Try again in a moment.");
  return new Error(detail || message);
}

/**
 * Reads a Server file for the pane. `get` is a signed-in dashboard REST GET returning the parsed body. Images go as a
 * `data:` URL, up to Hermes's 16 MB; anything else as text, up to its first 512 KB. A binary file that isn't an image
 * is `unsupported`. Failures reject with a message for the owner.
 */
export async function readServerFile(get: (pathAndQuery: string) => Promise<unknown>, path: string, profile: string): Promise<FileView> {
  if (!isServerPath(path)) throw new Error("Only full paths on the Hermes server, starting with / or ~/, open in the preview.");
  const query = new URLSearchParams({ path, profile }).toString();
  const image = async (size?: number): Promise<FileView> => {
    const res = (await get(`api/fs/read-data-url?${query}`).catch((e) => Promise.reject(serverFileError(e)))) as { dataUrl?: unknown };
    const src = typeof res.dataUrl === "string" ? res.dataUrl : "";
    if (!IMAGE_DATA_URL.test(src)) return unsupported(path, /^data:([^;,]+)/.exec(src)?.[1], size);
    const base64 = src.slice(src.indexOf(",") + 1);
    return { kind: "image", src, size: size ?? (base64.length * 3) / 4 - (base64.match(/=*$/)?.[0].length ?? 0) };
  };
  if (IMAGE_NAME.test(path)) return image();
  const res = (await get(`api/fs/read-text?${query}`).catch((e) => Promise.reject(serverFileError(e)))) as ReadText;
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
