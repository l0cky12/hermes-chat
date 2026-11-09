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

/** Code longer than this, such as a whole file in the preview pane, is highlighted each time rather than copied in. */
const CACHE_ONE_CHARS = 50_000;

function highlight(code: Element, pre: Element, file: VFile) {
  // Only this block, on its own; the rest of the tree is not highlight.js's to walk.
  const run = () => highlightCode({ type: "root", children: [{ ...pre, children: [code] }] }, file);
  const key = JSON.stringify(code.properties.className ?? null) + "\n" + toText(code, { whitespace: "pre" });
  if (key.length > CACHE_ONE_CHARS) return run();
  const hit = highlighted.get(key);
  if (!hit) {
    run();
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
 * language guessed again, on every delta (ADR 0068).
 */
function rehypeCode(source?: string) {
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
        highlight(code, node, file);
        return SKIP;
      }
      const formula = typeset(toText(code, { whitespace: "pre" }).trim(), code !== node || classes(code).includes("math-display"));
      if (!formula || !parent || index === undefined) return SKIP;
      parent.children.splice(index, 1, ...formula);
      return [SKIP, index + formula.length];
    });
}

export const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];

const highlightOnly = [rehypeCode()];

/**
 * The rehype plugins for Markdown marking `query`. `growingIn`: the Markdown, when it is the end of a reply still
 * streaming in.
 */
export const rehypePlugins = (query: string, growingIn?: string) =>
  query || growingIn !== undefined ? [rehypeCode(growingIn), ...(query ? [rehypeFind(query)] : [])] : highlightOnly;
