// Paths in a reply (ADR 0163): which words are a path, the full path each one names, and what opening one does. Pure,
// with no React and no transport. A path is where Hermes's tools run, never on this computer, and it is model output:
// nothing here reads it as anything but text.
import { isServerPath, looksLikeHost, previewKnows, withoutBidi, type PreviewTarget } from "./preview";

/**
 * A full path where Hermes's tools run: `/…` or `~/…`, with `.`, `..` and doubled slashes folded away, no slash at its
 * end (but `/` and `~/` themselves), and no control character. Only `resolvePath` makes one.
 */
export type ServerPath = string & { readonly __serverPath: unique symbol };

/** A path as a reply wrote it. `folder`: it ends in `/`. A `:12`, `:12:3` or `#L12` after it is not part of `written`. */
export type PathMention = { written: string; folder: boolean };

/** Where `mention` is in a text: `text.slice(start, end)` is the link's words, the line suffix included. */
export type PathSpan = { start: number; end: number; mention: PathMention };

/** What the server says is at a path. `unknown`: it couldn't say (not connected, no route, refused, too long a listing). */
export type PathKind = "folder" | "file" | "missing" | "unknown";

/** A word longer than this is no path, which also bounds the work one word can take. */
const MAX_WORD = 1024;
/** Never in a path a reply names: shell and glob syntax, a variable, a drive's or a URL's colon, a control character. */
const NEVER = /[<>|*?"\\`{}$:\u0000-\u001f\u007f-\u009f]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A line (and column) after a path: `:12`, `:12:3`, `#L12`, `#L12-L20`. */
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;
/** A file name's extension: a letter, then up to seven letters or digits. `v1.2` and `3.14` have none. */
const EXTENSION = /\.[a-z][a-z0-9]{0,7}$/i;
/** A file's name on its own, as a code span may hold it: `package.json`, `.eslintrc.json`. */
const FILE_NAME = /^[\p{L}\p{N}_.@+][\p{L}\p{N}_.@+-]*$/u;
const OPENING = new Set(["(", "[", "{", '"', "'", "“", "‘", "«"]);
const CLOSING = new Set([".", ",", ";", ":", "!", "?", "…", '"', "'", "”", "’", "»", "}"]);
/** A bracket a path may hold (`app/[id]/page.tsx`), which ends a word only when nothing in the word opens it. */
const OPENED_BY: Record<string, string> = { ")": "(", "]": "[" };

const startsAsPath = (w: string) => w.startsWith("~/") || w.startsWith("./") || w.startsWith("../");

/**
 * A web address without its scheme (`github.com/a/b`, `example.com`). One file's name the Preview knows is not one:
 * `README.md` is a file, though `.md` is also a country's domain.
 */
const hostNotFile = (w: string) => looksLikeHost(w) && (w.includes("/") || !previewKnows(w));

/** What no rule takes for a path: a scoped package, a web address without its scheme, an empty segment. */
const neverAPath = (w: string) => !w || NEVER.test(w) || w.startsWith("@") || w.includes("//") || hostNotFile(w);

/**
 * A path in running text: it has a slash, and enough else that `and/or`, `1/2`, `TCP/IP`, `origin/main`,
 * `application/json` and a slash command (`/help`) aren't one.
 */
function prosePath(w: string): boolean {
  if (startsAsPath(w)) return true;
  const segments = w.split("/").filter(Boolean);
  const folder = w.endsWith("/");
  const named = EXTENSION.test(segments[segments.length - 1] ?? "");
  if (w.startsWith("/")) return segments.length >= 2 || (segments.length === 1 && (folder || named));
  return folder ? segments[0].length >= 2 : segments.length >= 2 && named;
}

/**
 * A path that is a code span's whole text, which the writer marked as a name: any `/x`, any relative path whose first
 * segment has two characters or more (so `y/n` and `1/2` stay text), and a file's name on its own when the Preview
 * knows its extension.
 */
function codePath(w: string): boolean {
  if (!w.includes("/")) return FILE_NAME.test(w) && previewKnows(w);
  if (w.startsWith("/")) return w.length > 1;
  return startsAsPath(w) || (!w.startsWith("-") && w.indexOf("/") >= 2);
}

/** `body` as a mention, if `isPath` takes what is left of it without its line suffix. */
function mentionIn(body: string, isPath: (w: string) => boolean): PathMention | undefined {
  const written = body.replace(LINE_SUFFIX, "");
  return !neverAPath(written) && isPath(written) ? { written, folder: written.endsWith("/") } : undefined;
}

/** The path in one word of running text, without the quotes, brackets and punctuation around it. */
function inWord(word: string): { from: number; to: number; mention: PathMention } | undefined {
  let from = 0;
  let to = word.length;
  while (from < to && OPENING.has(word[from])) from++;
  // Counted once, so trimming a long run of brackets stays linear in the word.
  const count: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0 };
  for (let i = from; i < to; i++) if (word[i] in count) count[word[i]]++;
  for (;;) {
    const last = word[to - 1];
    if (to > from && CLOSING.has(last)) to--;
    else if (to > from && last in OPENED_BY && count[last] > count[OPENED_BY[last]]) {
      count[last]--;
      to--;
    } else break;
  }
  const mention = mentionIn(word.slice(from, to), prosePath);
  return mention && { from, to, mention };
}

/**
 * The paths in one run of text, in order, never overlapping. `where`: "code" for a code span, whose whole text may be
 * one path by a looser rule (`codePath`); otherwise, and for running text, each word is tried (`prosePath`). One pass,
 * linear in `text`.
 */
export function findPaths(text: string, where: "prose" | "code"): PathSpan[] {
  if (where === "code") {
    const whole = text.trim();
    const mention = whole && whole.length <= MAX_WORD && !/\s/.test(whole) ? mentionIn(whole, codePath) : undefined;
    if (mention) {
      const start = text.length - text.trimStart().length;
      return [{ start, end: start + whole.length, mention }];
    }
  }
  if (!text.includes("/")) return [];
  const spans: PathSpan[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    if (m[0].length > MAX_WORD || !m[0].includes("/")) continue;
    const found = inWord(m[0]);
    if (found) spans.push({ start: m.index + found.from, end: m.index + found.to, mention: found.mention });
  }
  return spans;
}

/**
 * A Markdown link's address as a path: one with no scheme, or a `file:` address on no host. Undefined for a web
 * address, `mailto:`, a same-page `#anchor`, `//host/…` and a host without its scheme (`example.com/a`), which stay
 * links. A `?query` and a `#fragment` aren't part of the path.
 */
export function hrefPath(href: string): PathMention | undefined {
  let raw = href.trim().replace(/[?#].*$/s, "");
  if (/^file:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (url.host && url.host !== "localhost") return undefined;
    raw = url.pathname;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
  let written = raw;
  try {
    written = decodeURIComponent(raw);
  } catch {
    // A `%` that escapes nothing is itself.
  }
  written = written.replace(LINE_SUFFIX, "");
  if (!written || written.startsWith("//") || hostNotFile(written) || CONTROL.test(written)) return undefined;
  return { written, folder: written.endsWith("/") };
}

/**
 * `written` as a full path. A relative one joins `base`, the folder it is relative to (a chat's working folder), and
 * is undefined without one. `..` stops at `/`; above `~/` only the server could say where it leads, so that is undefined.
 */
export function resolvePath(written: string, base: string | undefined): ServerPath | undefined {
  const full = /^(\/|~\/)/.test(written) ? written : base && isServerPath(base) ? `${base}/${written}` : undefined;
  if (full === undefined || CONTROL.test(full)) return undefined;
  const home = full.startsWith("~/");
  const kept: string[] = [];
  for (const segment of full.slice(home ? 2 : 1).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") kept.push(segment);
    else if (kept.length) kept.pop();
    else if (home) return undefined;
  }
  const path = (home ? "~/" : "/") + kept.join("/");
  return isServerPath(path) ? (path as ServerPath) : undefined;
}

/** The folder `path` is in: `/a/b.txt` gives `/a`, `~/x` gives `~/`. */
export function folderOf(path: ServerPath): ServerPath {
  const up = path.slice(0, path.lastIndexOf("/"));
  return (up === "" ? "/" : up === "~" ? "~/" : up) as ServerPath;
}

/**
 * One request to open a path. `saysFolder`: the reply wrote it with a `/` at its end. `session`: the chat whose
 * sandbox it may be in (ADR 0062). `as`: the owner picked in the path menu; left out, it is a click.
 */
export type PathOpen = { path: ServerPath; saysFolder: boolean; session?: string; as?: "preview" | "terminal" };

/**
 * Where a path opens. `shell`: a folder shell in it. `shellBeside`: a folder shell in the folder it is in. `noFolder`:
 * nowhere, and the owner is told.
 */
export type Destination = "preview" | "shell" | "shellBeside" | "noFolder";

/**
 * The whole policy of opening a path whose kind the server was asked for: by what the owner did, then what is there.
 * A click on anything that isn't a folder opens the Preview, whose read names the chat, so it finds a sandbox file the
 * listing can't see, and whose own errors say exactly what is wrong.
 */
const DESTINATIONS: Record<"click" | "terminal", Record<PathKind, Destination>> = {
  click: { folder: "shell", file: "preview", missing: "preview", unknown: "preview" },
  terminal: { folder: "shell", file: "shellBeside", missing: "noFolder", unknown: "shell" },
};

export const destinationOf = (kind: PathKind, asked: "click" | "terminal"): Destination => DESTINATIONS[asked][kind];

/**
 * How a path opens. The server is asked what is there only when the answer could change where it opens: not for the
 * menu's Preview, and not for a path written as a folder. The newest call wins: an answer that comes back after a
 * later call opens nothing. Resolves once something opened or was said, so a link can show it is busy until then.
 * `kindOf` never rejects.
 */
export function pathOpener(io: {
  kindOf(path: ServerPath): Promise<PathKind>;
  preview(target: PreviewTarget): void;
  /** Shows the folder shell in `folder`, starting one if there is none. */
  shell(folder: ServerPath): void;
  say(text: string): void;
}): (open: PathOpen) => Promise<void> {
  let latest = 0;
  return async ({ path, saysFolder, session, as }) => {
    const run = ++latest;
    const to = as === "preview" ? "preview" : destinationOf(saysFolder ? "folder" : await io.kindOf(path), as ?? "click");
    if (run !== latest) return;
    switch (to) {
      case "preview":
        return io.preview({ kind: "server", path, ...(session && { session }) });
      case "shell":
        return io.shell(path);
      case "shellBeside":
        return io.shell(folderOf(path));
      case "noFolder":
        return io.say(`There's no folder at ${withoutBidi(path)} on the Hermes server.`);
    }
  };
}
