// @vitest-environment jsdom
// Reply text built to hold the UI thread (#490), rendered as a reply is, and timed against plain prose as long: load on
// the machine slows both alike.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

/** The fastest of five renders of `text`, so a pause for garbage collection or another process doesn't count. */
const fastest = (text: string, query?: string) => {
  let ms = Infinity;
  let html = "";
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    html = renderToStaticMarkup(<Markdown text={text} query={query} />);
    ms = Math.min(ms, performance.now() - t0);
  }
  return { html, ms };
};

/** Words as long as `text`, rendered: what a reply that long costs anyway. */
const prose = (text: string) => fastest("ab ".repeat(Math.ceil(text.length / 3))).ms;

let salt = 0;
const untagged = (chars: number) => {
  const line = `const value${++salt} = compute(input, options) + 1; // step\n`;
  return "```\n" + line.repeat(Math.ceil(chars / line.length)) + "```";
};

// Rendering 100 KB six times over takes seconds on a busy machine, fixed or not.
describe("A reply built to stall the renderer", { timeout: 30_000 }, () => {
  // highlight.js compiles every grammar the first time it guesses a language, at any size.
  beforeAll(() => renderToStaticMarkup(<Markdown text={untagged(100)} />));

  it.each([
    ["$a ", 10_000],
    ["\\(a ", 5_000],
    ["\\[a ", 5_000],
  ])("renders unclosed %s formulas, repeated %i times, as text, about as fast as prose", (opener, times) => {
    const text = opener.repeat(times);
    const { html, ms } = fastest(text);
    expect(html).not.toContain("katex");
    // An opener costs what other inline syntax does (`\\*a ` repeated takes three to four times as long as words too),
    // and a busy machine skews either timing. Before #490 these took 100 to 300 times as long as words.
    expect(ms).toBeLessThan(10 * prose(text));
  });

  it("still typesets a formula closed after many unclosed ones", () => {
    const { html } = fastest("$a ".repeat(2_000) + "\n\nthen $x^2$ and \\(y\\)");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });

  it("leaves a code block over 100 KB plain, about as fast as prose", () => {
    const text = untagged(110_000);
    const { html, ms } = fastest(text);
    expect(html).toContain('<code class="hljs">');
    expect(html).not.toContain("hljs-");
    expect(ms).toBeLessThan(4 * prose(text));
  });

  it("colours a 60 KB untagged block, guessing its language from its start", () => {
    const text = untagged(60_000);
    const t0 = performance.now();
    const html = renderToStaticMarkup(<Markdown text={text} />);
    expect(html).toMatch(/<code class="hljs language-\w+">/);
    expect(html).toContain("hljs-");
    expect(performance.now() - t0).toBeLessThan(10 * prose(text));
  });

  it("marks a find query in a 60 KB block from the highlighted copy, not by highlighting it again", () => {
    const text = untagged(60_000);
    renderToStaticMarkup(<Markdown text={text} />);
    const { html, ms } = fastest(text, "valu");
    expect(html).toContain('<mark class="hit">valu</mark>');
    expect(ms).toBeLessThan(4 * prose(text));
  });
});
