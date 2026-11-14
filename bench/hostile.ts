// Reply text and filters built to stall the UI thread (#490), each timed at growing sizes. Linear work doubles when the
// size doubles; quadratic work quadruples. Runs in Node (V8) and on the bench page in WebKitGTK (JavaScriptCore), whose
// regex engine backtracks differently: `bench.hostile()` there.
// Usage: npx rolldown bench/hostile.ts --platform node -o <out>.mjs && node <out>.mjs [case...]
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { rehypePlugins, remarkPlugins } from "../src/ui/markdownPipeline";
import { findSecrets } from "../src/hermes/secrets";
import { filterMatches } from "../src/hermes/automations";
import { testPattern } from "../src/hermes/pyRegex";

/** What ReactMarkdown runs over one message, marking `query` as find-in-chat does. */
function render(text: string, query = "") {
  const p = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype).use(rehypePlugins(query));
  return p.runSync(p.parse(text));
}

let salt = 0;
/** An untagged code block of about `n` characters, different each call so the highlight cache never answers. */
function untagged(n: number) {
  const line = `const value${++salt} = compute(input, options) + 1; // step\n`;
  return "```\n" + line.repeat(Math.ceil(n / line.length)) + "```\n";
}

/** Reply text that renders slowly, at size `n`. */
export const REPLIES: Record<string, (n: number) => string> = {
  prose: (n) => "ab ".repeat(n),
  "math-dollar": (n) => "$a ".repeat(n),
  "math-paren": (n) => "\\(a ".repeat(n),
  "code-untagged": untagged,
  paths: (n) => "a/ /a ))/b/c)) ".repeat(n),
};

export type Case = { name: string; what: string; sizes: number[]; run: (n: number) => unknown };

export const CASES: Case[] = [
  { name: "prose", what: '"ab ".repeat(n), rendered: plain text as long as math-dollar\'s', sizes: [2500, 5000, 10000, 20000], run: (n) => render(REPLIES.prose(n)) },
  { name: "math-dollar", what: '"$a ".repeat(n), rendered', sizes: [2500, 5000, 10000, 20000], run: (n) => render(REPLIES["math-dollar"](n)) },
  { name: "math-paren", what: '"\\\\(a ".repeat(n), rendered', sizes: [2500, 5000, 10000, 20000], run: (n) => render(REPLIES["math-paren"](n)) },
  { name: "code-untagged", what: "untagged code block of n characters, rendered", sizes: [25000, 50000, 100000, 200000], run: (n) => render(untagged(n)) },
  { name: "paths", what: '"a/ /a ))/b/c)) ".repeat(n), rendered: words that nearly are paths (ADR 0163)', sizes: [500, 1000, 2000, 4000], run: (n) => render(REPLIES.paths(n)) },
  {
    name: "code-untagged-find",
    what: "the same block rendered twice, the second time marking a find query",
    sizes: [25000, 50000, 100000, 200000],
    run: (n) => {
      const text = untagged(n);
      render(text);
      const t0 = performance.now();
      render(text, "valu");
      return performance.now() - t0;
    },
  },
  { name: "secrets-dash", what: 'findSecrets("a-".repeat(n))', sizes: [5000, 10000, 20000, 40000], run: (n) => findSecrets("a-".repeat(n)) },
  { name: "secrets-dot", what: 'findSecrets("a.".repeat(n))', sizes: [5000, 10000, 20000, 40000], run: (n) => findSecrets("a.".repeat(n)) },
  {
    name: "webhook-regex",
    what: 'filter { regex: "(a+)+$" } on a field of n "a"s and a "!", tested on this thread as the pattern worker does',
    sizes: [16, 18, 20, 22],
    run: (n) => filterMatches({ field: "x", regex: "(a+)+$" }, { x: "a".repeat(n) + "!" }, "push", {}, testPattern),
  },
];

export type Row = { name: string; n: number; ms: number };

/** Times each case in `names` (all when empty) at each of its sizes, after one warm-up at its smallest. */
export function hostile(names: string[] = [], sizes?: number[]): Row[] {
  const rows: Row[] = [];
  for (const c of CASES.filter((c) => !names.length || names.includes(c.name))) {
    c.run((sizes ?? c.sizes)[0]);
    for (const n of sizes ?? c.sizes) {
      const t0 = performance.now();
      const inner = c.run(n);
      const ms = typeof inner === "number" ? inner : performance.now() - t0;
      rows.push({ name: c.name, n, ms: Math.round(ms * 10) / 10 });
    }
  }
  return rows;
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith(".mjs")) {
  console.log("| Case | n | ms | × previous |\n|---|---|---|---|");
  let prev: Row | undefined;
  for (const r of hostile(process.argv.slice(2))) {
    const ratio = prev?.name === r.name && prev.ms > 0 ? (r.ms / prev.ms).toFixed(1) : "";
    console.log(`| ${r.name} | ${r.n} | ${r.ms} | ${ratio} |`);
    prev = r;
  }
}
