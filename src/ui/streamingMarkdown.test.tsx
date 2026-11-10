// @vitest-environment jsdom
// A reply streaming in through Markdown (#224): each delta must redo only what it changed, and the finished reply must
// come out as it always has.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { splitBlocks, type Blocks } from "./markdownBlocks";
import { rehypePlugins, remarkPlugins } from "./markdownPipeline";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";

// Each piece of Markdown ReactMarkdown is asked to parse, in order.
const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (original) => {
  const real = (await original()) as typeof import("react-markdown");
  return { ...real, default: (props: Parameters<typeof real.default>[0]) => (parsed.push(String(props.children)), real.default(props)) };
});

beforeEach(() => void (parsed.length = 0));
// jsdom has no layout; mermaid, drawing the replies' finished diagrams, measures boxes and text to place them.
beforeAll(() => Object.assign(SVGElement.prototype, { getBBox: () => ({ x: 0, y: 0, width: 80, height: 20 }), getComputedTextLength: () => 40 }));
afterEach(cleanup);

const fence = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```";
// An svg in a code block other than its header's icons: a drawn diagram.
const diagram = (container: HTMLElement) => [...container.querySelectorAll(".code svg")].find((svg) => !svg.closest(".code-head")) ?? null;

/**
 * Finished replies of every shape a block split has to get right. The tests going over every prefix of all of them
 * take about half a second, so they get longer than the default to finish on a loaded machine.
 */
const REPLIES: Record<string, string> = {
  code: "Here it is:\n\n" + fence("ts", "const a = 1;\n\n\nconst b = 2;") + "\n\nThen run:\n\n" + fence("", "fn main() {\n    let x: u32 = 1;\n}") + "\n\nDone.",
  tildes: "~~~python\ndef f():\n    return 1\n~~~\nAfter, with no blank line.\n````\n```\nnot closed by three\n````",
  "code in a list": "1. Install:\n\n   ```bash\n   npm ci\n   ```\n\n2. Build:\n   ```\n   npm run build\n   ```\n3. Done\n\n- a\n- b\n\n\n- c",
  "lists, loose and tight": "- one\n- two\n\n- three\n\nPara.\n\n3. three\n4. four\n\n* star\n+ plus\n\n- [ ] task\n- [x] done",
  table: "Intro line\n| a | b |\n| - | :-: |\n| 1 | `2` |\n| 3 | 4 |\nafter table\n\n| x |\n|---|\n\nend",
  links: "See [the docs](https://example.com \"Docs\") and https://auto.link/path, <https://angle.link>, and ~~gone~~.",
  "reference links": "Use [the guide][g] and [g].\n\n- more about [it][g]\n\n[g]: https://example.com/guide 'Guide'",
  footnotes: "A claim.[^1] Another.[^note]\n\n[^1]: The source.\n[^note]: Second\n    with more.\n\nAfter.",
  "headings and rules": "# One\n\nSetext\n===\n\nText\n---\n\n***\n\n## Two ##\n\n> quote\n> - in list\n>\n> ```js\n> let q = 1\n> ```\nlazy line\n\n    indented code\n    more\n\n\n    after blanks",
  html: "<div>\n*raw*\n</div>\n\nText <b>inline</b>.\n\n<!-- comment -->\n\n<pre>\nkept\n</pre>\nend",
  breaks: "Line one\nline two  \nline three\\\nfour\n\n\n\n\nfar below",
  "think tags": "<think>reasoning\nmore</think>\n\nAnswer.",
  empty: "",
  "only blanks": "\n\n\n",
  "numbered steps": "Steps:\n\n1) First\n\n   ```sh\n   make\n   ```\n\n2) Second\n\n10. Ten\n11. Eleven\n\n- x\n\n  continued\n\n -\n\n- y",
  "open fence": "Start:\n\n```diff\n- old\n+ new\n\n```not a close\n",
  "unclosed fence ending blank": "Here:\n\n~~~text\nx\n\n",
  "unclosed fence ending in spaces and tabs": "```\nx\n \t\n\t\n\n",
  "crlf": "Para one\r\nline two\r\n\r\n```js\r\nlet a = 1\r\n\r\n```\r\n\r\n- a\r\n- b\r\n\r\n| x | y |\r\n| - | - |\r\n| 1 | 2 |\r\n",
  tabs: "-\tone\n-\ttwo\n\n\tindented code\n\t\tmore\n\n\t\nafter",
  "byte order mark first": "\uFEFF# Heading\n\nabc",
  "byte order mark later": "Intro.\n\n\uFEFF# Heading\n\n```\nx\n```",
  "starts indented": "   - indented list\n   - item\n\n  ```\n  fence indented two\n    four\n  ```",
  "inline math": "Energy is $E = mc^2$, and \\(a^2 + b^2 = c^2\\) costs $5 and $10.\n\n- a list of $n$ items\n\n> quoted $q$ and $$y = 2$$\nSo \\[\nx = 1\n\\] holds.",
  "math blocks": "Sum:\n\n$$\n\\int_0^1 x\\,dx\n\n= \\tfrac12\n$$\n\nThen $x$.\n\n1. Item\n\n   $$\n   a\n   $$\n\n$$\nnever closed\n\n",
  mermaid: "Flow:\n\n```mermaid\nflowchart TD\n  Go-->Stop\n```\n\nDone.\n\n```mermaid\nnot a diagram\n```",
};

/** Replies with math, which highlighting alone leaves as code, and Markdown typesets. */
const hasMath = (name: string) => name.includes("math");

const whole = (text: string, query = "") => {
  const { container, unmount } = render(<Markdown text={text} query={query} />);
  const html = container.innerHTML;
  unmount();
  return html;
};

/** `text` streamed in `step` characters at a time, then finished; the HTML each time, and the last. */
function streamed(text: string, step: number, query = "") {
  const { container, rerender, unmount } = render(<Markdown text="" query={query} streaming />);
  const seen: string[] = [];
  for (let i = step; i < text.length + step; i += step) {
    rerender(<Markdown text={text.slice(0, i)} query={query} streaming />);
    seen.push(container.innerHTML);
  }
  rerender(<Markdown text={text} query={query} />);
  const html = container.innerHTML;
  unmount();
  return { seen, html };
}

describe("A code block while a reply streams in", () => {
  it("keeps its DOM node from delta to delta", () => {
    let text = "Here it is:\n\n" + fence("ts", "const a = 1;") + "\n\nAnd";
    for (const streaming of [false, true]) {
      const { container, rerender, unmount } = render(<Markdown text={text} streaming={streaming} />);
      const pre = container.querySelector("pre")!;
      const box = container.querySelector(".code")!;
      for (const more of [" then", " some", " more", "\n\n- a list", "\n- of things"]) {
        rerender(<Markdown text={(text += more)} streaming={streaming} />);
        expect(container.querySelector("pre")).toBe(pre);
        expect(container.querySelector(".code")).toBe(box);
      }
      unmount();
    }
  });

  it("names its language on the first render, with nothing to read back from the page", () => {
    expect(renderToStaticMarkup(<Markdown text={fence("python", "def f():\n    return 1")} />)).toContain('<div class="code-head"><span>python</span>');
  });
});

describe("Splitting a reply into blocks", () => {
  it("finds the same blocks whether it parses the reply afresh or carries on from the last split", { timeout: 30_000 }, () => {
    for (const [name, text] of Object.entries(REPLIES))
      for (const step of [1, 3, 12]) {
        let prev: Blocks | undefined;
        for (let i = step; i < text.length + step; i += step) {
          const part = text.slice(0, i);
          prev = splitBlocks(part, prev);
          expect(prev, `${name}, ${i} characters in ${step}s`).toEqual(splitBlocks(part));
        }
      }
  });

  it("covers every character of the reply, in order, but blank lines between blocks", () => {
    for (const text of Object.values(REPLIES)) {
      const { blocks } = splitBlocks(text);
      blocks.forEach((b, i) => {
        expect(text.slice(b.start, b.start + b.text.length)).toBe(b.text);
        expect(text.slice(b.start + b.text.length, blocks[i + 1]?.start ?? text.length).trim()).toBe("");
      });
      expect(blocks[0]?.start ?? 0).toBe(0);
    }
  });

  it("knows code still coming in by the parser's own fences, not lines that look like one", () => {
    const open = (text: string) => splitBlocks(text).blocks.at(-1)!.open;
    // Still open: a fence-like line that is code content, a closer indented four, a shorter or different fence.
    expect(open("~~~js\nconst x = 1;\n> ~~~")).toBe(true);
    expect(open("~~~js\nx\n    ~~~")).toBe(true);
    expect(open("````\n```\n")).toBe(true);
    expect(open("~~~\nx\n```")).toBe(true);
    expect(open("> ```js\n> x")).toBe(true);
    expect(open("1. a\n\n   ```\n   x")).toBe(true);
    expect(open("    indented code")).toBe(true);
    expect(open("$$\n\\sum_i x_i\n\n")).toBe(true);
    expect(open("- a\n\n  $$\n  x")).toBe(true);
    // Finished: closed, closed inside a quote or a list, or followed by something else.
    expect(open("~~~js\nx\n   ~~~")).toBe(false);
    expect(open("```\nx\n```\n\n")).toBe(false);
    expect(open("> ```js\n> x\n> ```")).toBe(false);
    expect(open("1. a\n\n   ```\n   x\n   ```")).toBe(false);
    expect(open("```\nx\n```\nAfter.")).toBe(false);
    expect(open("    code\n\npara")).toBe(false);
    expect(open("$$\nx\n$$")).toBe(false);
    expect(open("$$\nx\n$$\nAfter.")).toBe(false);
  });

  it("keeps a $$ block with blank lines inside it one block", () => {
    expect(splitBlocks("$$\na\n\n\nb\n$$\n\nAfter.").blocks.map((b) => b.text)).toEqual(["$$\na\n\n\nb\n$$", "After."]);
  });

  it("renders a reply that defines link references or footnotes in one piece", () => {
    expect(splitBlocks(REPLIES["reference links"]).whole).toBe(true);
    expect(splitBlocks(REPLIES.footnotes).whole).toBe(true);
    expect(splitBlocks("> [x]: /in-a-quote\n\n[x]").whole).toBe(true);
    expect(splitBlocks("\uFEFFabc").whole).toBe(true);
    expect(splitBlocks("Intro.\n\n\uFEFF# Heading").whole).toBe(true);
    expect(splitBlocks(REPLIES.code).whole).toBe(false);
  });
});

describe("A streamed reply, once finished", () => {
  it("comes out exactly as the same reply rendered in one piece", { timeout: 30_000 }, () => {
    for (const [name, text] of Object.entries(REPLIES))
      for (const query of ["", "e"]) expect(streamed(text, 7, query).html, `${name}, query "${query}"`).toBe(whole(text, query));
  });

  it("matches the one-piece render at every delta too, apart from code still coming in", { timeout: 30_000 }, () => {
    const text = REPLIES["lists, loose and tight"] + "\n\n" + REPLIES.table + "\n\n" + REPLIES.links + "\n\n" + REPLIES["inline math"];
    const { seen } = streamed(text, 5);
    seen.forEach((html, i) => expect(html, `after ${(i + 1) * 5} characters`).toBe(whole(text.slice(0, (i + 1) * 5))));
  });
});

describe("Highlighting a block at a time, from the cache", () => {
  it("gives the tree rehype-highlight gives the whole reply, as Markdown did before #224", () => {
    const strip = (node: unknown): unknown =>
      Array.isArray(node) ? node.map(strip) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).filter(([k]) => k !== "position").map(([k, v]) => [k, strip(v)])) : node;
    const tree = (text: string, plugins: unknown[]) => {
      const p = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype).use(plugins as never);
      return strip(p.runSync(p.parse(text)));
    };
    const before = [() => rehypeHighlight({ detect: true })];
    for (const [name, text] of Object.entries(REPLIES).filter(([name]) => !hasMath(name)))
      for (let i = 0; i < 2; i++) expect(tree(text, rehypePlugins("")), `${name}, ${i ? "from the cache" : "first time"}`).toEqual(tree(text, before));
  });
});

describe("Each delta", () => {
  it("parses only the last block again, never one already finished", () => {
    const first = "Intro paragraph.\n\n";
    const code = fence("ts", "const a = 1;") + "\n\n";
    const { rerender } = render(<Markdown text={first + code + "Tail"} streaming />);
    parsed.length = 0;
    rerender(<Markdown text={first + code + "Tail grows"} streaming />);
    rerender(<Markdown text={first + code + "Tail grows more"} streaming />);
    expect(parsed).toEqual(["Tail grows", "Tail grows more"]);
  });

  it("parses nothing again when the find-in-chat query and text are unchanged", () => {
    const text = REPLIES.code;
    const { rerender } = render(<Markdown text={text} streaming />);
    parsed.length = 0;
    rerender(<Markdown text={text} streaming />);
    expect(parsed).toEqual([]);
  });
});

describe("Code still coming in", () => {
  const code = "fn parse(line: &str) -> Option<u32> {\n    let n: u32 = line.trim().parse().ok()?;\n    Some(n)\n}";

  it("stays plain until its fence closes, then is highlighted, with its language guessed after that commit, and left alone", async () => {
    const intro = "Like this:\n\n";
    const { container, rerender } = render(<Markdown text={intro + "```\n" + code.slice(0, 20)} streaming />);
    const codeEl = () => container.querySelector("pre code")!;
    expect(codeEl().className).toBe("hljs");
    expect(codeEl().querySelector("span")).toBeNull();
    rerender(<Markdown text={intro + "```\n" + code + "\n``"} streaming />);
    expect(codeEl().querySelector("span")).toBeNull();
    expect(container.querySelector(".code-head span")!.textContent).toBe("");
    rerender(<Markdown text={intro + "```\n" + code + "\n```"} streaming />);
    expect(codeEl().className, "the guess waits for the commit that closed the fence to paint").toBe("hljs");
    expect(codeEl().querySelector("span")).toBeNull();
    await waitFor(() => expect(codeEl().className).toBe("hljs language-rust"));
    expect(codeEl().querySelector(".hljs-keyword")!.textContent).toBe("fn");
    expect(container.querySelector(".code-head span")!.textContent).toBe("rust");
    const done = codeEl();
    parsed.length = 0;
    rerender(<Markdown text={intro + "```\n" + code + "\n```\n\nIt returns"} streaming />);
    rerender(<Markdown text={intro + "```\n" + code + "\n```\n\nIt returns a number."} streaming />);
    expect(parsed).toEqual(["It returns", "It returns a number."]);
    expect(codeEl()).toBe(done);
  });

  it("is highlighted once the reply ends, even with its fence still open", () => {
    const text = "```ts\nconst a = 1;";
    const { container, rerender } = render(<Markdown text={text} streaming />);
    expect(container.querySelector("pre code span")).toBeNull();
    rerender(<Markdown text={text} />);
    expect(container.querySelector("pre code .hljs-keyword")!.textContent).toBe("const");
  });

  it("stays plain inside a list still coming in, while finished code above it is highlighted", () => {
    const text = "1. Build:\n\n   ```bash\n   if true; then echo ok; fi\n   ```\n\n2. Run:\n\n   ```bash\n   npm te";
    const { container } = render(<Markdown text={text} streaming />);
    const [first, second] = container.querySelectorAll("pre code");
    expect(first.querySelector(".hljs-keyword")!.textContent).toBe("if");
    expect(second.querySelector("span")).toBeNull();
    expect(second.textContent).toBe("npm te\n");
  });

  it("is highlighted again from the cache without carrying find-in-chat marks into another render", () => {
    const text = "```bash\nsystemctl restart gateway\n```";
    const plainHtml = whole(text);
    expect(whole(text, "gateway")).toContain('<mark class="hit">gateway</mark>');
    expect(whole(text)).toBe(plainHtml);
    expect(whole(text, "restart")).not.toContain('<mark class="hit">gateway</mark>');
  });

  it("leaves code in a language highlight.js doesn't know as it was, from the cache too", () => {
    const text = "```klingon\nqapla' batlh\n```";
    const first = whole(text);
    expect(first).toContain('<code class="hljs language-klingon">qapla\' batlh\n</code>');
    expect(whole(text)).toBe(first);
  });
});

describe("A streamed reply's code blocks", () => {
  it("copy exactly their code, find marks and all, and name their language", () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    // jsdom has no layout, so no innerText; a <pre>'s innerText is its text.
    Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
    try {
      const text = "Run:\n\n" + fence("bash", "systemctl restart gateway\njournalctl -u gateway") + "\n\nThen check.";
      const { container, rerender } = render(<Markdown text={text.slice(0, 30)} query="gateway" streaming />);
      rerender(<Markdown text={text} query="gateway" streaming />);
      rerender(<Markdown text={text} query="gateway" />);
      expect(container.querySelectorAll("pre mark.hit")).toHaveLength(2);
      expect(container.querySelector(".code-head span")!.textContent).toBe("bash");
      fireEvent.click(container.querySelector(".code-copy")!);
      expect(writeText).toHaveBeenCalledWith("systemctl restart gateway\njournalctl -u gateway\n");
    } finally {
      delete (HTMLElement.prototype as { innerText?: string }).innerText;
      vi.unstubAllGlobals();
    }
  });

  it("are marked by find-in-chat while still coming in, before they are highlighted", () => {
    const { container } = render(<Markdown text={"```\nrestart the gateway\nand the gate"} query="gate" streaming />);
    expect(container.querySelector("pre code span")).toBeNull();
    expect([...container.querySelectorAll("pre mark.hit")].map((m) => m.textContent)).toEqual(["gate", "gate"]);
  });
});

describe("Math and diagrams still coming in", () => {
  it("leave an unclosed $$ block at the end as its source, typeset once it closes", () => {
    const text = "Sum:\n\n$x$ and\n\n$$\n\\sum_i x_i";
    const { container, rerender } = render(<Markdown text={text} streaming />);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(container.querySelector("pre")!.textContent).toBe("\\sum_i x_i");
    rerender(<Markdown text={text + "\n$$"} streaming />);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("typeset an unclosed $$ block once the reply ends", () => {
    const text = "$$\n\\sum_i x_i\n";
    const { container, rerender } = render(<Markdown text={text} streaming />);
    expect(container.querySelector(".katex")).toBeNull();
    rerender(<Markdown text={text} />);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("draw an unclosed mermaid fence at the end only once it is finished", { timeout: 30_000 }, async () => {
    const open = "Flow:\n\n```mermaid\nflowchart TD\n  Going-->Gone";
    // Drawn once already, so a fence taken for finished would show it at once, from the cache.
    const done = render(<Markdown text={open + "\n```"} />);
    await waitFor(() => expect(diagram(done.container)).not.toBeNull(), { timeout: 30_000 });
    done.unmount();
    const { container, rerender } = render(<Markdown text={open} streaming />);
    await new Promise((r) => setTimeout(r, 200));
    expect(diagram(container)).toBeNull();
    expect(container.querySelector("pre")!.textContent).toBe("flowchart TD\n  Going-->Gone\n");
    rerender(<Markdown text={open + "\n```"} streaming />);
    await waitFor(() => expect(diagram(container)).not.toBeNull(), { timeout: 30_000 });
  });
});
