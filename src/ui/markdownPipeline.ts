// The remark and rehype plugins Markdown renders with, apart from React, so the bench (bench/parse.ts) can time the same
// work in Node.
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import katex from "katex";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import { toText } from "hast-util-to-text";
import { SKIP, visit } from "unist-util-visit";
import type { Element, ElementContent, Root } from "hast";
import type { VFile } from "vfile";
import { escapeRe } from "./bits";
import { remarkMath } from "./markdownMath";
import { findPaths, hrefPath, type PathMention } from "../hermes/paths";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const classes = (node: { properties?: Record<string, unknown> }) => {
  const className = node.properties?.className;
  return Array.isArray(className) ? className.map(String) : [];
};

/**
 * Rehype plugin: wraps each case-insensitive occurrence of `query` in `<mark class="hit">`. It runs after
 * rehype-highlight, so code blocks are marked too, except where a match spans two highlighted tokens. Typeset math is
 * left alone: its text is KaTeX's glyphs and a copy of the TeX for screen readers, not words to find.
 */
function rehypeFind(query: string) {
  return () => (tree: HastNode) => {
    if (!query) return;
    const re = new RegExp(`(${escapeRe(query)})`, "gi");
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== "text" || !child.value) {
          if (!classes(child).some((c) => c.startsWith("katex"))) walk(child);
          return [child];
        }
        return child.value
          .split(re)
          .flatMap((part, i): HastNode[] =>
            !part ? [] : i % 2 ? [{ type: "element", tagName: "mark", properties: { className: ["hit"] }, children: [{ type: "text", value: part }] }] : [{ type: "text", value: part }],
          );
      });
    };
    walk(tree);
  };
}

/**
 * Rehype plugin (ADR 0163): wraps each path in running text and in a code span in `<a data-path>`, with `data-folder`
 * when it is written as a folder, and makes a link whose address is a path into the same element. The `<a>` has no
 * `href`: a path is never an address the window could follow, and react-markdown's URL policy has nothing of it to
 * read. Code blocks, math and the words of a link are left as they are.
 */
const rehypePaths = () => (tree: HastNode) => {
  const data = (m: PathMention) => ({ dataPath: m.written, ...(m.folder && { dataFolder: true }) });
  const walk = (node: HastNode) => {
    if (!node.children) return;
    const where = node.tagName === "code" ? "code" : "prose";
    const siblings = node.children;
    // A word that runs on into an element beside it is only part of a path: `src/__init__.py` is `src/`, then
    // `init` in bold, then `.py`, and `src/` alone would open the wrong place.
    const glued = (i: number) => {
      const next = siblings[i];
      return next?.type === "element" && next.tagName !== "br";
    };
    node.children = siblings.flatMap((child, i): HastNode[] => {
      if (child.type === "text" && child.value) {
        const text = child.value;
        const spans = findPaths(text, where).filter((s) => !(s.start === 0 && glued(i - 1)) && !(s.end === text.length && glued(i + 1)));
        if (!spans.length) return [child];
        const out: HastNode[] = [];
        let at = 0;
        for (const s of spans) {
          if (s.start > at) out.push({ type: "text", value: text.slice(at, s.start) });
          out.push({ type: "element", tagName: "a", properties: data(s.mention), children: [{ type: "text", value: text.slice(s.start, s.end) }] });
          at = s.end;
        }
        if (at < text.length) out.push({ type: "text", value: text.slice(at) });
        return out;
      }
      if (child.tagName === "a") {
        const { href, ...rest } = child.properties ?? {};
        const mention = typeof href === "string" ? hrefPath(href) : undefined;
        if (mention) child.properties = { ...rest, ...data(mention) };
      } else if (child.tagName !== "pre" && !classes(child).some((c) => c.startsWith("katex") || c === "language-math")) walk(child);
      return [child];
    });
  };
  walk(tree);
};

/** A cache, least recently used first out once the weights of what it holds pass `limit`. */
function lru<V>(limit: number) {
  const held = new Map<string, { value: V; weight: number }>();
  let weights = 0;
  return {
    get(key: string): V | undefined {
      const hit = held.get(key);
      if (!hit) return undefined;
      held.delete(key);
      held.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V, weight: number) {
      held.set(key, { value, weight });
      weights += weight;
      for (const [old, { weight }] of held) {
        if (weights <= limit) break;
        held.delete(old);
        weights -= weight;
      }
    },
  };
}

// The highlighter is made once: rehype-highlight builds a fresh highlight.js instance, with every grammar to compile
// again, each time the plugin is attached, and ReactMarkdown attaches its plugins on every render.
const highlightCode = rehypeHighlight({ detect: true });

/**
 * Highlighted code, by its classes (so its language) and text: what highlight.js made of it. A block is highlighted
 * once, however often it renders: as a reply streams in, when find-in-chat marks change, in both panes. Least
 * recently used goes first once the code held passes 500,000 characters.
 */
const highlighted = lru<{ className: unknown; children: ElementContent[] }>(500_000);

/** Code longer than this stays plain: highlighting it would hold up the window (#490). */
export const HIGHLIGHT_MAX_CHARS = 100_000;

/** An untagged block's language is guessed from this much of its start, since the guess runs every grammar over it. */
const GUESS_FROM_CHARS = 4_000;

/** Whether highlight.js has to guess `code`'s language, by running every grammar over it. */
const guessing = (code: Element) => !classes(code).some((c) => /^(lang-|language-|no-?highlight$)/.test(c));

/**
 * Highlights `code`, from the cache when it can. With `guessed`, code whose language has to be guessed, and isn't in
 * the cache, is left plain in this render: the guess runs after it, in a task of its own, then `guessed` is called to
 * render it again from the cache (#451).
 */
function highlight(code: Element, pre: Element, file: VFile, guessed?: () => void) {
  const text = toText(code, { whitespace: "pre" });
  if (text.length > HIGHLIGHT_MAX_CHARS) return plain(code);
  // Only this block, on its own; the rest of the tree is not highlight.js's to walk.
  const one = (code: Element) => highlightCode({ type: "root", children: [{ ...pre, children: [code] }] }, file);
  const run = (code: Element) => {
    if (guessing(code) && text.length > GUESS_FROM_CHARS) {
      const start: Element = { ...code, properties: { ...code.properties, className: classes(code) }, children: [{ type: "text", value: text.slice(0, GUESS_FROM_CHARS) }] };
      one(start);
      const language = classes(start).find((c) => c.startsWith("language-"));
      if (!language) return plain(code);
      code.properties.className = [...classes(code), language];
    }
    one(code);
  };
  const key = JSON.stringify(code.properties.className ?? null) + "\n" + text;
  const hit = highlighted.get(key);
  if (!hit && guessed && guessing(code)) {
    const later = structuredClone(code);
    plain(code);
    setTimeout(() => {
      if (!highlighted.get(key)) {
        run(later);
        highlighted.set(key, { className: later.properties.className, children: later.children }, key.length);
      }
      guessed();
    });
    return;
  }
  if (!hit) {
    run(code);
    // A copy, since find-in-chat marks are put into the tree, and the tree's copy is the one marked.
    highlighted.set(key, structuredClone({ className: code.properties.className, children: code.children }), key.length);
    return;
  }
  const copy = structuredClone(hit);
  code.properties.className = copy.className as Element["properties"]["className"];
  code.children = copy.children;
}

/** Code left plain for now, with the `hljs` class highlighting would give it, so its colours don't jump when it does. */
function plain(code: Element) {
  const className = classes(code);
  if (!className.includes("hljs") && !className.includes("no-highlight") && !className.includes("nohighlight"))
    code.properties.className = ["hljs", ...className];
}

/**
 * Typeset math, by whether it is display math and its TeX: KaTeX's HTML, as hast. Weighed by the HTML, which is many
 * times longer than the TeX, and kept up to 2,000,000 characters of it.
 */
const typesetMath = lru<ElementContent[]>(2_000_000);

const frozen = <T,>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.values(Object.freeze(value)).forEach(frozen);
  return value;
};

/**
 * `tex` typeset, or undefined for what KaTeX can't take; TeX it can't parse comes back as itself, in red. Unlike
 * highlighted code it goes into the tree uncopied, frozen: find-in-chat leaves typeset math alone, and copying it was
 * most of a streamed delta's work (bench/parse.ts `math`).
 */
function typeset(tex: string, display: boolean): ElementContent[] | undefined {
  const key = (display ? "display\n" : "inline\n") + tex;
  let math = typesetMath.get(key);
  if (!math) {
    let html: string;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore" });
    } catch {
      return undefined;
    }
    math = frozen(fromHtmlIsomorphic(html, { fragment: true }).children as ElementContent[]);
    typesetMath.set(key, math, html.length);
  }
  return math;
}

/**
 * Rehype plugin: highlights each code block, guessing the language of untagged ones, and typesets math (mdast-util-
 * math's `<code class="language-math">`, a block's in a `<pre>`). `source`: the Markdown being rendered, when it ends
 * in code or math still coming in (markdownBlocks.ts says which); the code or math at its very end then stays plain,
 * with `data-growing` on its `<code>`, until it is finished, so a streaming reply isn't highlighted again, and its
 * language guessed again, on every delta (ADR 0068). `guessed`: see `highlight`.
 */
function rehypeCode(source?: string, guessed?: () => void) {
  const growing = (node: Element) => source !== undefined && !source.slice(node.position?.end.offset ?? 0).trim();
  return () => (tree: Root, file: VFile) =>
    visit(tree, "element", (node, index, parent) => {
      const code = node.tagName === "pre" ? node.children[0] : node;
      if (code?.type !== "element" || code.tagName !== "code") return;
      const math = classes(code).includes("language-math");
      if (!math && code === node) return;
      if (growing(node)) {
        if (!math) plain(code);
        code.properties.dataGrowing = true;
        return SKIP;
      }
      if (!math) {
        highlight(code, node, file, guessed);
        return SKIP;
      }
      const formula = typeset(toText(code, { whitespace: "pre" }).trim(), code !== node || classes(code).includes("math-display"));
      if (!formula || !parent || index === undefined) return SKIP;
      parent.children.splice(index, 1, ...formula);
      return [SKIP, index + formula.length];
    });
}

export const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];

const highlightOnly = [rehypeCode(), rehypePaths];

/**
 * The rehype plugins for Markdown marking `query`. `growingIn`: the Markdown, when it is the end of a reply still
 * streaming in. `guessed`: when given, a language guess waits until after this render, and `guessed` is called once it
 * is made, to render again. Paths are linked after code is highlighted and before find marks go in, so a mark lands
 * inside a path's link as it does inside any element.
 */
export const rehypePlugins = (query: string, growingIn?: string, guessed?: () => void) =>
  query || growingIn !== undefined || guessed ? [rehypeCode(growingIn, guessed), rehypePaths, ...(query ? [rehypeFind(query)] : [])] : highlightOnly;
