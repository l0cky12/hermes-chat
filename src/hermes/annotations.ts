// Annotations (ADR 0094): what the owner points at on a still of the Preview's page, and the words that go with it.
// Rust takes the still, asks the page what is under a point, and stages the marked image (src-tauri/src/annotate.rs);
// these are the shapes it answers with, and the words block the composer gets. Nothing here sends anything.

import { withoutBidi } from "./preview";

/** A box in the page's CSS pixels, from the view's top-left corner. */
export type Rect = { x: number; y: number; width: number; height: number };
export type PageView = { width: number; height: number; scrollX: number; scrollY: number; scale: number };

/**
 * A still of the page, kept in the captures folder until it is staged or cancelled. `width` × `height`: the view in CSS
 * pixels; the image is that times `scale`. `elements`: the page can be asked what is under a point (Linux); otherwise
 * only regions can be marked.
 */
export type Still = {
  id: number;
  generation: number;
  path: string;
  url: string;
  takenAtMs: number;
  width: number;
  height: number;
  scale: number;
  elements: boolean;
};

export type Field = { kind: "password" } | { kind: "hidden" } | { kind: "other"; type: string };
export type Target =
  | { kind: "element"; tag: string; role: string | null; label: string | null; selector: string; styles: Record<string, string> }
  | { kind: "field"; tag: string; field: Field; label: string | null }
  | { kind: "otherSite"; host: string };
export type Answer = { target: Target; rect: Rect; view: PageView };

/**
 * Why a mark carries no element details. Rust gives the first three; `drawn` is a box the owner dragged, and `framed`
 * a page the app can't read (Windows' sandboxed frame).
 */
export type RegionWhy = { kind: "otherSite"; host: string } | { kind: "changed" } | { kind: "noAnswer" } | { kind: "drawn" } | { kind: "framed" };
export type Pick = ({ kind: "element" } & Answer) | { kind: "region"; rect: Rect; why: RegionWhy };

/** Why an annotation command has no result, as Rust reports it. */
export type AnnotateFailure = { kind: "unsupported" | "noPage" | "stale" | "noAnswer" | "failed"; message?: string };

const isFailure = (e: unknown): e is AnnotateFailure => typeof e === "object" && e !== null && typeof (e as AnnotateFailure).kind === "string";

/** What the Preview says when a still or a pick didn't work. */
export function failureText(e: unknown): string {
  if (!isFailure(e)) return `Couldn't annotate the page: ${String(e)}`;
  switch (e.kind) {
    case "noPage":
      return "The page isn't shown any more.";
    case "stale":
      return "The page has changed since the still. Cancel and annotate it again to mark it as it is now.";
    case "noAnswer":
      return "The page didn't answer.";
    case "unsupported":
      return e.message ?? "Annotations don't work here yet.";
    default:
      return `Couldn't annotate the page: ${e.message ?? "no reason given"}`;
  }
}

export const REGION_WHY: Record<RegionWhy["kind"], (why: RegionWhy) => string> = {
  otherSite: (w) => `This part comes from ${(w as { host: string }).host}, which the app can't read.`,
  changed: () => "The page changed after the still. Element details are left out.",
  noAnswer: () => "The page didn't answer, so element details are left out.",
  drawn: () => "You drew this region, so it has no element details.",
  framed: () => "The app can't read this page on Windows, so annotations here are regions.",
};

/** Where the page is, for the words block: a Server page, a page on this computer, or the web. */
export type PageWhere = "server" | "local" | "web";
const WHERE: Record<PageWhere, string> = { server: "Server page", local: "page on this computer", web: "web page" };

const SECRET = /key|token|secret|password|auth|session|credential|signature|^sig$/i;

/**
 * `url` as the words may carry it: query and fragment parameters whose name looks like a secret (`?token=…`,
 * `#access_token=…`, `X-Amz-Signature`) lose their values, and any user name and password goes.
 */
export function shareableAddress(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "(an address that couldn't be read)";
  }
  u.username = "";
  u.password = "";
  const scrub = (params: URLSearchParams) => {
    let changed = false;
    for (const name of new Set(params.keys()))
      if (SECRET.test(name)) {
        params.set(name, "…");
        changed = true;
      }
    return changed;
  };
  const query = new URLSearchParams(u.search);
  if (scrub(query)) u.search = query.toString();
  const fragment = u.hash.slice(1);
  if (fragment.includes("=")) {
    const params = new URLSearchParams(fragment);
    if (scrub(params)) u.hash = params.toString();
  }
  return withoutBidi(u.toString());
}

const round = (n: number) => Math.round(n);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const quote = (s: string) => `"${s}"`;

function fieldWords(tag: string, field: Field, label: string | null): string {
  if (field.kind === "password") return `${tag}, a password field`;
  if (field.kind === "hidden") return `${tag}, a hidden field`;
  return `${tag}, a ${field.type} field${label ? `, labelled on the page: ${quote(label)}` : ""}`;
}

/** The lines that say what was picked, without the note: the review card shows these, and the words block ends with the note. */
export function pickLines(pick: Pick, still: { width: number; height: number; scale: number }): string[] {
  const view = pick.kind === "element" ? pick.view : still;
  const box = `Box: ${round(pick.rect.x)}, ${round(pick.rect.y)}, ${round(pick.rect.width)} × ${round(pick.rect.height)} CSS px, in a ${round(view.width)} × ${round(view.height)} view at scale ${+view.scale.toFixed(2)}`;
  if (pick.kind === "region") return [`Region: ${REGION_WHY[pick.why.kind](pick.why)}`, box];
  const t = pick.target;
  if (t.kind === "otherSite") return [`Region: ${REGION_WHY.otherSite(t)}`, box];
  if (t.kind === "field") return [`Element: ${fieldWords(t.tag, t.field, t.label)}`, box];
  const lines = [`Element: ${t.tag}${t.role ? ` (role ${t.role})` : ""}${t.label ? `, text from the page: ${quote(t.label)}` : ""}`, `Selector: ${t.selector}`, box];
  const styles = Object.entries(t.styles).map(([k, v]) => `${k} ${v}`);
  if (styles.length) lines.push(`Styles: ${styles.join("; ")}`);
  return lines;
}

/** The most the words block may hold (ADR 0094); the owner's note is cut to fit. */
export const MAX_WORDS = 1500;

/**
 * The words block staged beside `annotation-<n>.png`. `url`: the page as the owner opened it (a Server page's tunnel
 * already set back to the server's address).
 */
export function annotationWords(a: { n: number; url: string; where: PageWhere; takenAtMs: number; still: Still; pick: Pick; note: string }): string {
  const head = [
    `Annotation ${a.n}. annotation-${a.n}.png marks it in blue.`,
    `Page: ${shareableAddress(a.url)} (${WHERE[a.where]}), still taken ${clock(a.takenAtMs)}`,
    ...pickLines(a.pick, a.still),
  ].join("\n");
  const note = withoutBidi(a.note.trim());
  if (!note) return head.slice(0, MAX_WORDS);
  const room = MAX_WORDS - head.length - "\nNote: ".length;
  if (room <= 1) return head.slice(0, MAX_WORDS);
  return `${head}\nNote: ${note.length > room ? `${note.slice(0, room - 1)}…` : note}`;
}

/** The box a drag from `a` to `b` covers, cut to the still. Points are in the still's CSS pixels. */
export function dragBox(a: { x: number; y: number }, b: { x: number; y: number }, still: { width: number; height: number }): Rect {
  const clamp = (v: number, most: number) => Math.min(Math.max(v, 0), most);
  const [x0, x1] = [clamp(Math.min(a.x, b.x), still.width), clamp(Math.max(a.x, b.x), still.width)];
  const [y0, y1] = [clamp(Math.min(a.y, b.y), still.height), clamp(Math.max(a.y, b.y), still.height)];
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** What a staged annotation's chip says about where it came from. */
export type AnnotationLabel = { url: string; takenAtMs: number; stale: boolean };

export function staleText(label: AnnotationLabel): string {
  const at = `Taken on ${shareableAddress(label.url)} at ${clock(label.takenAtMs)}.`;
  return label.stale ? `${at} The page has changed since.` : at;
}
