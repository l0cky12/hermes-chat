// Synthetic long chats for the rendering bench. Not real conversations: seeded, so every run renders the same text.
// Each turn is shaped like an agent session: a question, sometimes reasoning, a run of tool calls, then a markdown
// reply with lists, inline code, a fenced code block (a third of them untagged, so highlighting has to guess the
// language) and now and then a table.
import type { Chat, Item } from "../src/hermes/model";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the config server request session token build cache module error stream reply value file path test deploy " +
  "function handler client socket payload retry timeout queue worker schema index route profile commit branch " +
  "should would because then when after before while still only also maybe probably check update return"
).split(" ");

const CODE = [
  ["ts", "export async function load(id: string) {\n  const res = await fetch(`/api/sessions/${id}`);\n  if (!res.ok) throw new Error(res.statusText);\n  return (await res.json()) as Session;\n}"],
  ["python", "def retry(fn, tries=3):\n    for i in range(tries):\n        try:\n            return fn()\n        except TimeoutError:\n            time.sleep(2 ** i)\n    raise RuntimeError('gave up')"],
  ["bash", "systemctl --user restart hermes-gateway\njournalctl --user -u hermes-gateway -n 50 --no-pager | grep -i error"],
  ["rust", "fn parse(line: &str) -> Option<(u32, &str)> {\n    let (n, rest) = line.split_once(' ')?;\n    Some((n.parse().ok()?, rest.trim()))\n}"],
  ["json", '{\n  "model": "claude-opus",\n  "max_tokens": 4096,\n  "stream": true,\n  "tools": ["terminal", "read_file"]\n}'],
] as const;

export function makeChat(turns: number, seed = 1): Chat {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
  const sentence = () => {
    const s = words(8 + Math.floor(r() * 14));
    return s[0].toUpperCase() + s.slice(1) + (r() < 0.3 ? ` \`${pick(WORDS)}.${pick(WORDS)}\`` : "") + ".";
  };
  const para = () => Array.from({ length: 2 + Math.floor(r() * 4) }, sentence).join(" ");

  const items: Item[] = [];
  for (let t = 0; t < turns; t++) {
    items.push({ kind: "user", id: `u-${t}`, text: Array.from({ length: 1 + Math.floor(r() * 3) }, sentence).join(" ") });
    if (r() < 0.5) items.push({ kind: "thinking", id: `r-${t}`, text: Array.from({ length: 3 + Math.floor(r() * 5) }, sentence).join("\n") });
    const tools = Math.floor(r() * 6);
    for (let k = 0; k < tools; k++)
      items.push({
        kind: "tool",
        id: `t-${t}-${k}`,
        name: pick(["terminal", "read_file", "search_files", "write_file", "web_search"]),
        args: { command: `${pick(WORDS)} --${pick(WORDS)} ${pick(WORDS)}.txt` },
        preview: words(5),
        status: "done",
        durationS: Math.round(r() * 40) / 10,
        result: Array.from({ length: 4 }, () => words(10)).join("\n"),
      });
    const parts = [para()];
    if (r() < 0.4) parts.push(`## ${sentence().slice(0, -1)}`);
    parts.push(Array.from({ length: 3 + Math.floor(r() * 4) }, () => `- ${sentence()}`).join("\n"));
    if (r() < 0.7) {
      const [lang, code] = pick(CODE);
      parts.push("```" + (r() < 0.67 ? lang : "") + "\n" + code + "\n```");
    }
    if (r() < 0.15) parts.push("| key | value | note |\n| --- | --- | --- |\n" + Array.from({ length: 4 }, () => `| ${pick(WORDS)} | ${pick(WORDS)} | ${words(4)} |`).join("\n"));
    parts.push(para());
    items.push({ kind: "assistant", id: `a-${t}`, text: parts.join("\n\n") });
  }
  return { id: `bench-${turns}`, title: `Bench, ${turns} turns`, source: "app", settled: false, updatedAt: 0, items, runtimeId: "rt" };
}

/** A ~3 KB reply with a code block, to stream token by token. */
export function makeReply(seed = 99): string {
  return makeChat(3, seed)
    .items.filter((i) => i.kind === "assistant")
    .map((i) => (i as { text: string }).text)
    .join("\n\n");
}

const LOADER = [
  "export async function load(id: string, opts: { retries?: number } = {}) {",
  "  const res = await fetch(`/api/sessions/${id}`, { headers: { accept: 'application/json' } });",
  "  if (!res.ok) throw new Error(`load ${id}: ${res.status} ${res.statusText}`);",
  "  const body = (await res.json()) as { items: Item[]; next?: string };",
  "  for (const item of body.items) cache.set(item.id, { ...item, seen: Date.now() });",
  "  return body.next ? [...body.items, ...(await load(body.next, opts))] : body.items;",
  "}",
  "",
];

/**
 * The reply #224 measured: a sentence plus a 40-line code block, `blocks` times. `tagged`: the fences say `ts`;
 * otherwise highlighting has to guess the language of each. Each block names its function apart (`salt`, then its
 * place), as real code blocks differ, so none is highlighted from the cache of one already seen.
 */
export function codeReply(blocks: number, tagged: boolean, salt = ""): string {
  const code = Array.from({ length: 40 }, (_, i) => LOADER[i % LOADER.length]).join("\n");
  const one = (k: number) =>
    "Here is the next part of the loader, with the retry kept as it was.\n\n```" + (tagged ? "ts" : "") + "\n" + code.replaceAll("load", `load_${salt}${k}`) + "\n```";
  return Array.from({ length: blocks }, (_, k) => one(k)).join("\n\n");
}

/**
 * A reply heavy with math, `sections` times: a paragraph with three inline formulas (`$…$`, `\(…\)`), and with
 * `blocks`, a `$$` block after it. Each formula names its section apart (`salt`, then its place), so none is typeset
 * from the cache of one already seen.
 */
export function mathReply(sections: number, blocks: boolean, salt = ""): string {
  const one = (k: number) => {
    const i = `${salt}${k}`;
    const para =
      `For the step $x_{${i}} = \\frac{a_{${i}}}{b + 1}$ the error is $\\varepsilon_{${i}} \\le 2^{-n}$, ` +
      `and the variance \\(\\sigma_{${i}}^2 = \\frac{1}{n} \\sum_{j=1}^{n} (x_j - \\mu)^2\\) stays bounded, as it costs $5 and $10 to check.`;
    const block = `$$\n\\int_0^{${k + 1}} e^{-t^2} \\, dt_{${i}} = \\frac{\\sqrt{\\pi}}{2} \\operatorname{erf}(${k + 1})\n$$`;
    return blocks ? para + "\n\n" + block : para;
  };
  return Array.from({ length: sections }, (_, k) => one(k)).join("\n\n");
}
