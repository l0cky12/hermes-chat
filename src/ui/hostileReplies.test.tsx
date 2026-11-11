// @vitest-environment jsdom
// Reply text built to hold the UI thread (#490), rendered as a reply is. Each limit is several times what the fix
// takes and a fraction of what the text took before it (bench/hostile.ts has the numbers).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

const timed = (text: string) => {
  const t0 = performance.now();
  const html = renderToStaticMarkup(<Markdown text={text} />);
  return { html, ms: performance.now() - t0 };
};

describe("A reply built to stall the renderer", () => {
  it.each([
    ["$a ", 10_000],
    ["\\(a ", 5_000],
    ["\\[a ", 5_000],
  ])("renders unclosed %s formulas, repeated %i times, as text, in linear time", (opener, times) => {
    const { html, ms } = timed(opener.repeat(times));
    expect(html).not.toContain("katex");
    expect(ms).toBeLessThan(500);
  });

  it("still typesets a formula closed after many unclosed ones", () => {
    const { html } = timed("$a ".repeat(2_000) + "\n\nthen $x^2$ and \\(y\\)");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });
});
