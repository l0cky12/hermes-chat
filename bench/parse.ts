// The parse + highlight work Markdown does while a reply streams in, timed in Node without React or layout (#224).
// The reply is a sentence plus a 40-line code block, repeated N times, streamed 12 characters at a time. `whole` is
// what Markdown did before #224: every delta runs remark → rehype → highlight over the whole reply. `blocks` is what it
// does now: the reply split into top-level blocks, only blocks whose text changed parsed again (`blocks-only`), and a
// code block whose fence is still open left unhighlighted (`blocks`). `math` is `blocks` over a reply of paragraphs
// with inline formulas, then with a `$$` block after each (#350).
// Usage: npx rolldown bench/parse.ts --platform node -o <out>.mjs && node <out>.mjs [whole|blocks-only|blocks|math]
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import { codeReply, mathReply } from "./fixture";
import { splitBlocks, type Blocks } from "../src/ui/markdownBlocks";
import { rehypePlugins, remarkPlugins } from "../src/ui/markdownPipeline";

const highlight = rehypeHighlight({ detect: true });
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkRehype).use(() => highlight);
const whole = (text: string) => processor.runSync(processor.parse(text));

export type Step = (text: string) => void;

/** A reply to stream: `n` of its parts, in one of two `variants` (named in the table). */
type Reply = { make: (n: number, variant: boolean, salt: string) => string; parts: string; variants: [string, string] };
const CODE: Reply = { make: codeReply, parts: "Code blocks", variants: ["Untagged", "Tagged ts"] };
const MATH: Reply = { make: mathReply, parts: "Paragraphs", variants: ["Inline math", "And $$ blocks"] };

export function run(name: string, make: () => Step, reply = CODE, blocks: number[] = [1, 3, 6, 10]) {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  // Warm up, so the first row isn't the JIT's.
  for (const variant of [false, true]) {
    const text = reply.make(1, variant, "warm");
    const step = make();
    for (let i = 12; i < text.length + 12; i += 12) step(text.slice(0, i));
  }
  const [a, b] = reply.variants;
  console.log(`\n${name}`);
  console.log(`| ${reply.parts} | ${a}: last delta | ${a}: worst delta | ${a}: total | ${b}: last delta | ${b}: worst delta | ${b}: total |`);
  console.log("|---|---|---|---|---|---|---|");
  for (const n of blocks) {
    const cells: string[] = [];
    for (const variant of [false, true]) {
      const text = reply.make(n, variant, `${name.length}x${n}${variant}`);
      const step = make();
      let total = 0;
      let last = 0;
      let worst = 0;
      for (let i = 12; i < text.length + 12; i += 12) {
        const t0 = performance.now();
        step(text.slice(0, i));
        last = performance.now() - t0;
        total += last;
        worst = Math.max(worst, last);
      }
      cells.push(`${r1(last)} ms`, `${r1(worst)} ms`, `${r1(total / 1000)} s`);
    }
    console.log(`| ${n} | ${cells.join(" | ")} |`);
  }
}

// What ReactMarkdown runs for one piece of Markdown, with Markdown's own plugins.
const now = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype).use(rehypePlugins(""));
const part = (text: string) => now.runSync(now.parse(text));

// What ReactMarkdown runs for the end of a reply still coming in: code not finished stays plain.
const growing = (text: string) => {
  const p = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype).use(rehypePlugins("", text));
  return p.runSync(p.parse(text));
};

// What Markdown does with `streaming` set: split the text, and render again only a block whose text or `growing`
// changed (the memoized Part), or the whole text when a block defines a reference. `highlightGrowing`: highlight code
// still coming in on every delta too, as step 2 of #224 did on its own, before step 3.
function blocks(highlightGrowing = false): Step {
  let split: Blocks | undefined;
  let shown: (string | undefined)[] = [];
  return (text) => {
    split = splitBlocks(text, split);
    if (split.whole) {
      growing(text);
      shown = [];
      return;
    }
    const last = split.blocks.length - 1;
    split.blocks.forEach((b, i) => {
      const open = !highlightGrowing && i === last && b.open;
      const key = (open ? "open\n" : "\n") + b.text;
      if (shown[i] !== key) (open ? growing : part)(b.text);
      shown[i] = key;
    });
    shown.length = split.blocks.length;
  };
}

if (process.argv[2] === "whole") run("whole reply per delta (before #224)", () => whole);
if (process.argv[2] === "blocks") run("a block at a time, code highlighted once finished (#224 steps 2 and 3)", () => blocks());
if (process.argv[2] === "blocks-only") run("a block at a time, code still coming in highlighted on every delta (#224 step 2)", () => blocks(true));
if (process.argv[2] === "math") run("a block at a time, over a reply heavy with math (#350)", () => blocks(), MATH, [1, 3, 6, 10, 20]);
