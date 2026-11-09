// A reply split into its top-level Markdown blocks, so that while it streams in, each finished block renders once and
// only the last, still-growing one is parsed again (#224). Blocks are found by the same parser and GFM extensions that
// render them (micromark, through mdast-util-from-markdown), never by hand.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes } from "mdast";
import { mathMdast, mathSyntax } from "./markdownMath";

/**
 * One top-level block: its source, from the start of its first line to where the parser says it ends, so the blank
 * lines after a finished block don't change its text as the next one begins. `refs`: it defines a link reference or
 * footnote. `open`: it ends in code, or a `$$` math block, that may still be coming in.
 */
export type Block = { start: number; text: string; refs: boolean; open: boolean };

/**
 * `text` in blocks. `whole`: a block defines a link reference or footnote, which can change how any other block
 * renders, so the text has to be rendered in one piece.
 */
export type Blocks = { text: string; blocks: Block[]; whole: boolean };

// How many fences (opening, then closing) the parser found for each fenced code or `$$` math node; indented code has
// none. Read from micromark's own tokens, so a fence-like line that is really code content, or in another container,
// isn't one.
const fences = new WeakMap<object, number>();
const countFence = (type: "code" | "math") =>
  function (this: { stack: { type: string }[] }) {
    // The node, under the fragment its content is gathered into by the time the closing fence comes.
    const node = [...this.stack].reverse().find((n) => n.type === type);
    if (node) fences.set(node, (fences.get(node) ?? 0) + 1);
  };
const countFences = { enter: { codeFencedFence: countFence("code"), mathFlowFence: countFence("math") } };

const options = { extensions: [gfm(), mathSyntax], mdastExtensions: [gfmFromMarkdown(), mathMdast, countFences] };

/**
 * Whether `node`, parsed from `source`, ends in code that may still be coming in: code or a `$$` math block with
 * nothing but blank space after it, whose fence isn't closed yet, or that has no fence (indented code goes on while
 * indented lines come).
 */
function endsInOpenCode(node: Nodes, source: string): boolean {
  for (;;) {
    if (node.type === "code" || node.type === "math")
      return !source.slice(node.position?.end.offset ?? source.length).trim() && (fences.get(node) ?? 0) < 2;
    if (!("children" in node) || !node.children.length) return false;
    node = node.children[node.children.length - 1];
  }
}

const definesRefs = (node: Nodes): boolean =>
  node.type === "definition" || node.type === "footnoteDefinition" || ("children" in node && node.children.some(definesRefs));

/** The top-level blocks of `text`, each starting at `base` plus where its first line starts in `text`. */
function lex(text: string, base: number): Block[] {
  const blocks: Block[] = [];
  const ends: number[] = [];
  for (const node of fromMarkdown(text, options).children) {
    const at = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? text.length;
    // From the start of its line: a fence or list indented a little keeps its indentation, which shapes its content.
    const start = blocks.length ? text.lastIndexOf("\n", at - 1) + 1 : 0;
    const last = blocks[blocks.length - 1];
    // Two blocks starting on one line would render as one; they can't be told apart by line, so they stay together.
    if (last && start <= last.start) {
      last.refs ||= definesRefs(node);
      last.open = endsInOpenCode(node, text);
      ends[ends.length - 1] = Math.max(ends[ends.length - 1], end);
      continue;
    }
    blocks.push({ start, text: "", refs: definesRefs(node), open: endsInOpenCode(node, text) });
    ends.push(end);
  }
  for (const [i, b] of blocks.entries()) {
    b.text = text.slice(b.start, ends[i]);
    b.start += base;
  }
  return blocks;
}

/**
 * `text`'s top-level blocks. With `prev`, the blocks of an earlier `text` that this one continues, only its last two
 * blocks and what follows are parsed again. Text added at the end can grow or end the last block, or turn it into
 * part of the block before (a paragraph "2" becomes item 2 of the list above it once "." comes). It can't change how
 * a block's first line reads, so nothing before the second last block moves. Link reference and footnote definitions
 * can change any block, and make the result `whole`, as does a byte order mark.
 */
export function splitBlocks(text: string, prev?: Blocks): Blocks {
  // The parser drops a byte order mark at the start of a document before counting offsets, and one starting a later
  // block would be dropped there too were the block parsed on its own: such a text renders in one piece.
  if (text.includes("\uFEFF")) return { text, blocks: [], whole: true };
  const from = prev && text.startsWith(prev.text) ? (prev.blocks[prev.blocks.length - 2]?.start ?? 0) : 0;
  const kept = from ? prev!.blocks.slice(0, -2) : [];
  const blocks = [...kept, ...lex(text.slice(from), from)];
  return { text, blocks, whole: blocks.some((b) => b.refs) };
}
