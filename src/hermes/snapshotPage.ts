// A chat as one inert web page: the page a snapshot would publish (ADR 0123), and the Export dialog's HTML page.
// It parses the export's Markdown with the transcript's own syntax, then writes markup from a closed vocabulary:
// `BODY`'s tags and attributes, links only to `SCHEMES`, raw HTML, math and diagrams as text, and images as their
// address. No script, no event handler, nothing that loads. The parser decodes `&#100;` and `\-`, so every text taken
// from the document is redacted again before it is escaped.
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, Nodes, Parents, RootContent } from "mdast";
import { transcriptSyntax } from "../ui/markdownBlocks";
import { EXPORT_FORMATS } from "./exportChat";
import { redactValues } from "./secrets";

/** The export's Markdown, already redacted, and every text it was redacted for. */
export type PageSource = { markdown: string; redacted: readonly string[] };
/** `html`: the page's bytes. `title`: its title, redacted, before escaping. */
export type SnapshotPage = { html: string; title: string };
export type PageResult = { page: SnapshotPage } | { problem: string };

/** Every element the page's body can have, each with the only attributes it can carry. */
const BODY = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  br: [],
  hr: [],
  blockquote: [],
  ul: [],
  ol: ["start"],
  li: [],
  pre: [],
  code: [],
  em: [],
  strong: [],
  del: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
  a: ["href", "rel", "title"],
} as const;
type Tag = keyof typeof BODY;
const VOID: ReadonlySet<Tag> = new Set(["br", "hr"]);

/** The only schemes a link keeps. */
const SCHEMES: readonly string[] = ["https:", "http:", "mailto:"];

const HEAD =
  "<!doctype html><html><head>" +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` +
  '<meta name="referrer" content="no-referrer">' +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

const STYLE =
  "<style>" +
  ":root{color-scheme:light dark;background:Canvas;color:CanvasText}" +
  "body{max-width:46rem;margin:0 auto;padding:1.5rem 1rem;font:16px/1.55 system-ui,sans-serif;overflow-wrap:anywhere}" +
  "pre,code{font-family:ui-monospace,monospace;font-size:.9em}" +
  "pre{padding:.75rem;border:1px solid #8884;border-radius:6px;overflow:auto;white-space:pre-wrap}" +
  "blockquote{margin:1rem 0;padding:0 1rem;border-left:3px solid #8886}" +
  "table{border-collapse:collapse}th,td{border:1px solid #8886;padding:.25rem .5rem;text-align:left}" +
  "li>p{margin:.25rem 0}" +
  "</style>";

/** Markup this module wrote: escaped document text, a constant, or elements made of them. */
type Safe = string & { readonly __safe: unique symbol };
const MARKUP = (s: string) => s as Safe;
const join = (parts: readonly Safe[]) => parts.join("") as Safe;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The only writer of markup in the body. */
function el<T extends Tag>(tag: T, attrs: Partial<Record<(typeof BODY)[T][number], Safe>>, inner: Safe = MARKUP("")): Safe {
  const list = Object.entries(attrs) as [string, Safe | undefined][];
  const open = `<${tag}${list.map(([k, v]) => (v === undefined ? "" : ` ${k}="${v}"`)).join("")}>`;
  return MARKUP(VOID.has(tag) ? open : `${open}${inner}</${tag}>`);
}

/** Past this depth a container writes its contents without its own element, read without recursion. */
const MAX_DEPTH = 100;

type Ctx = {
  /** Document text, redacted again and escaped. */
  text: (s: string) => Safe;
  /** A document value for an attribute, redacted again and escaped. */
  attr: (s: string) => Safe;
  /** An attribute value as written, checked for redacted text but not redacted again, and escaped. */
  exact: (s: string) => Safe;
  /** Document text with redacted text replaced, not escaped. */
  redact: (s: string) => string;
  /** Link and image definitions by identifier, the first of each. */
  defs: ReadonlyMap<string, Definition>;
  depth: number;
};

/** Text with each line break as `<br>`, as remark-breaks renders it in the transcript. */
const lines = (s: string, ctx: Ctx) => MARKUP(ctx.text(s).replace(/\n/g, "<br>"));

/** An `http:`, `https:` or `mailto:` address, absolute and without a username or password, as the form that was checked. */
function href(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  return SCHEMES.includes(u.protocol) && !u.username && !u.password ? u.href : undefined;
}

function link(url: string, title: string | null | undefined, inner: Safe, ctx: Ctx): Safe {
  const ok = href(ctx.redact(url));
  if (ok === undefined) return join([inner, MARKUP(" ("), ctx.text(url), MARKUP(")")]);
  return el("a", { href: ctx.exact(ok), rel: MARKUP("noopener noreferrer"), ...(title ? { title: ctx.attr(title) } : {}) }, inner);
}

function image(alt: string | null | undefined, url: string | undefined, ctx: Ctx): Safe {
  const parts = [alt ? ctx.text(alt) : undefined, url !== undefined ? join([MARKUP("("), ctx.text(url), MARKUP(")")]) : undefined];
  return join(parts.filter((p): p is Safe => p !== undefined).flatMap((p, i) => (i ? [MARKUP(" "), p] : [p])));
}

function emit(node: Nodes, ctx: Ctx): Safe {
  return (EMIT[node.type] as (n: Nodes, c: Ctx) => Safe)(node, ctx);
}

/** A parent's children, or past `MAX_DEPTH` every leaf under it in order, without recursion. */
function kids(node: Parents, ctx: Ctx): Safe {
  if (ctx.depth < MAX_DEPTH) {
    const inner = { ...ctx, depth: ctx.depth + 1 };
    return join((node.children as Nodes[]).map((c) => (c.type === "html" && flow(node) ? el("p", {}, emit(c, inner)) : emit(c, inner))));
  }
  const out: Safe[] = [];
  const stack: Nodes[] = [...(node.children as Nodes[])].reverse();
  for (let n = stack.pop(); n; n = stack.pop()) {
    if ("children" in n) stack.push(...[...(n.children as Nodes[])].reverse());
    else out.push(emit(n, ctx));
  }
  return join(out);
}

/** Whether `node` holds blocks, so raw HTML in it is a block of its own. */
const flow = (node: Parents) => node.type === "root" || node.type === "blockquote" || node.type === "listItem" || node.type === "footnoteDefinition";

/** `children` with `lead` written at the start of the first paragraph, or before them when they don't start with one. */
function led(lead: Safe, node: Parents & { children: RootContent[] }, ctx: Ctx): Safe {
  const [first, ...rest] = node.children;
  if (first?.type !== "paragraph" || ctx.depth >= MAX_DEPTH) return join([lead, kids(node, ctx)]);
  const inner = { ...ctx, depth: ctx.depth + 1 };
  return join([el("p", {}, join([lead, kids(first, inner)])), kids({ ...node, children: rest } as Parents, ctx)]);
}

/** One entry for every Markdown node type, so the compiler asks for a new one when the parser gains a type. */
const EMIT: { [T in Nodes["type"]]: (node: Extract<Nodes, { type: T }>, ctx: Ctx) => Safe } = {
  root: (n, ctx) => kids(n, ctx),
  paragraph: (n, ctx) => el("p", {}, kids(n, ctx)),
  heading: (n, ctx) => el(`h${n.depth}`, {}, kids(n, ctx)),
  thematicBreak: () => el("hr", {}),
  blockquote: (n, ctx) => el("blockquote", {}, kids(n, ctx)),
  list: (n, ctx) =>
    n.ordered
      ? el("ol", Number.isSafeInteger(n.start) && n.start !== 1 ? { start: MARKUP(String(n.start)) } : {}, kids(n, ctx))
      : el("ul", {}, kids(n, ctx)),
  listItem: (n, ctx) => el("li", {}, typeof n.checked === "boolean" ? led(MARKUP(n.checked ? "[x] " : "[ ] "), n, ctx) : kids(n, ctx)),
  text: (n, ctx) => lines(n.value, ctx),
  break: () => el("br", {}),
  emphasis: (n, ctx) => el("em", {}, kids(n, ctx)),
  strong: (n, ctx) => el("strong", {}, kids(n, ctx)),
  delete: (n, ctx) => el("del", {}, kids(n, ctx)),
  inlineCode: (n, ctx) => el("code", {}, ctx.text(n.value)),
  inlineMath: (n, ctx) => el("code", {}, ctx.text(n.value)),
  code: (n, ctx) => el("pre", {}, el("code", {}, ctx.text(n.value))),
  math: (n, ctx) => el("pre", {}, el("code", {}, ctx.text(n.value))),
  yaml: (n, ctx) => el("pre", {}, el("code", {}, ctx.text(n.value))),
  html: (n, ctx) => lines(n.value, ctx),
  link: (n, ctx) => link(n.url, n.title, kids(n, ctx), ctx),
  linkReference: (n, ctx) => {
    const def = ctx.defs.get(n.identifier);
    return def ? link(def.url, def.title, kids(n, ctx), ctx) : kids(n, ctx);
  },
  image: (n, ctx) => image(n.alt, n.url, ctx),
  imageReference: (n, ctx) => image(n.alt, ctx.defs.get(n.identifier)?.url, ctx),
  definition: () => MARKUP(""),
  footnoteReference: (n, ctx) => join([MARKUP("[^"), ctx.text(n.label ?? n.identifier), MARKUP("]")]),
  footnoteDefinition: (n, ctx) => led(join([MARKUP("[^"), ctx.text(n.label ?? n.identifier), MARKUP("]: ")]), n, ctx),
  table: (n, ctx) => {
    const [head, ...body] = n.children;
    const inner = { ...ctx, depth: ctx.depth + 1 };
    const cells = head ? join(head.children.map((c) => el("th", {}, kids(c, inner)))) : MARKUP("");
    return el("table", {}, join([el("thead", {}, el("tr", {}, cells)), el("tbody", {}, join(body.map((r) => EMIT.tableRow(r, inner))))]));
  },
  tableRow: (n, ctx) => el("tr", {}, kids(n, ctx)),
  tableCell: (n, ctx) => el("td", {}, kids(n, ctx)),
};

/** Every definition in the tree by identifier, the first of each winning, found without recursion. */
function definitions(root: Nodes): Map<string, Definition> {
  const defs = new Map<string, Definition>();
  const stack: Nodes[] = [root];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (n.type === "definition") {
      if (!defs.has(n.identifier)) defs.set(n.identifier, n);
    } else if ("children" in n) stack.push(...[...(n.children as Nodes[])].reverse());
  }
  return defs;
}

const SPLIT_REDACTION =
  "Formatting in the page splits text you redacted, so the page would still show it. Redact each formatted part of it on its own as well.";

/** `source.markdown` as a page, or why it can't be one: a redacted text the page would still show. */
export function snapshotPage(source: PageSource): PageResult {
  const shown: string[] = [];
  const values: string[] = [];
  const redact = (s: string) => redactValues(s, source.redacted, { anywhere: true }).text;
  const keep = (into: string[]) => (s: string) => {
    const r = redact(s);
    into.push(r);
    return MARKUP(escape(r));
  };
  const tree = fromMarkdown(source.markdown, transcriptSyntax);
  const ctx: Ctx = {
    text: keep(shown),
    attr: keep(values),
    exact: (s) => (values.push(s), MARKUP(escape(s))),
    redact,
    defs: definitions(tree),
    depth: 0,
  };
  const title = redact(EXPORT_FORMATS.markdown.title(source.markdown));
  const body = emit(tree, ctx);
  const visible = shown.join("");
  if (source.redacted.some((r) => r && (visible.includes(r) || title.includes(r) || values.some((v) => v.includes(r))))) return { problem: SPLIT_REDACTION };
  return { page: { html: `${HEAD}<title>${escape(title)}</title>${STYLE}</head><body>${body}</body></html>`, title } };
}
