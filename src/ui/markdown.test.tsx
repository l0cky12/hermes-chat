// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as renderDom, screen } from "@testing-library/react";
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
