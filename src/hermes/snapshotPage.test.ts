// @vitest-environment jsdom
// The snapshot page (snapshotPage.ts, ADR 0123): hostile chat text stays inert, and redacted text is gone from the bytes.
// The expected vocabulary below is written out here, not imported, so widening the page's registry can't widen the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_DRAFT, exportPreview, type ExportDraft } from "./exportChat";
import type { Chat, Item } from "./model";
import { snapshotPage } from "./snapshotPage";

const ALLOWED: Record<string, readonly string[]> = {
  html: [],
  head: [],
  meta: ["http-equiv", "content", "name", "charset"],
  title: [],
  style: [],
  body: [],
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  br: [],
  hr: [],
  blockquote: [],
  ul: [],
  ol: ["start"],
  li: [],
  pre: [],
  code: [],
  em: [],
  strong: [],
  del: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
  a: ["href", "rel", "title"],
};
const LINK_SCHEMES = ["https:", "http:", "mailto:"];
const NEVER_IN_BYTES = ["<script", "<iframe", "<img", "<svg", "<math", "<object", "<embed", "<base", "<form", "<input", "<link"];
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Parses a page and checks every invariant the page promises, whatever went into it. */
function inspect(html: string): Document {
  const lower = html.toLowerCase();
  for (const bad of NEVER_IN_BYTES) expect(lower, `${bad} in the bytes`).not.toContain(bad);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const e of doc.querySelectorAll("*")) {
    const tag = e.localName;
    expect(Object.keys(ALLOWED), `<${tag}>`).toContain(tag);
    for (const name of e.getAttributeNames()) {
      expect(name.startsWith("on"), `${name} on <${tag}>`).toBe(false);
      expect(ALLOWED[tag], `${name} on <${tag}>`).toContain(name);
    }
  }
  expect(doc.querySelectorAll("style")).toHaveLength(1);
  expect(doc.head.querySelectorAll("style")).toHaveLength(1);
  for (const m of doc.querySelectorAll("meta")) expect(m.parentElement).toBe(doc.head);
  for (const a of doc.querySelectorAll("a")) {
    expect(LINK_SCHEMES).toContain(new URL(a.getAttribute("href")!).protocol);
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  }
  return doc;
}

function page(markdown: string, redacted: string[] = []): string {
  const r = snapshotPage({ markdown, redacted });
  if (!("page" in r)) throw new Error(r.problem);
  return r.page.html;
}

/** The page's visible body text. */
const shown = (md: string) => inspect(page(md)).body.textContent!;

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "<iframe src=https://e.x>",
  "<link rel=stylesheet href=https://e.x/s.css>",
  "<style>body{background:url(https://e.x/p)}</style>",
  "<base href=https://e.x/>",
  '<meta http-equiv=refresh content="0;url=https://e.x">',
  "<object data=https://e.x/o.swf>",
  "<form action=https://e.x/f><button>go</button></form>",
  "<!-- -->",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<math><mi xlink:href="javascript:1">',
];

const CONTEXTS: Record<string, (f: string) => string> = {
  paragraph: (f) => f,
  heading: (f) => `# ${f}`,
  "list item": (f) => `- ${f}`,
  "table cell": (f) => `| a |\n|---|\n| ${f} |`,
  blockquote: (f) => `> ${f}`,
  "link text": (f) => `[${f}](https://e.x/ok)`,
  emphasis: (f) => `*${f}*`,
  footnote: (f) => `Note[^1]\n\n[^1]: ${f}`,
};

describe("Hostile chat text on the page", () => {
  for (const [context, wrap] of Object.entries(CONTEXTS))
    for (const fragment of HOSTILE)
      it(`shows ${fragment} in a ${context} as text`, () => {
        expect(shown(`Before.\n\n${wrap(fragment)}\n\nAfter.`)).toContain(fragment);
      });
});

describe("Links on the page", () => {
  const refused: [string, string][] = [
    ["[x](javascript:alert(1))", "javascript:alert(1)"],
    ["[x](JaVaScRiPt:alert(1))", "JaVaScRiPt:alert(1)"],
    ["[x](<javascript:alert(1)>)", "javascript:alert(1)"],
    ["[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["[x](vbscript:msgbox(1))", "vbscript:msgbox(1)"],
    ["[x](//evil.example)", "//evil.example"],
    ["[x](/rel)", "/rel"],
    ["[x](#f)", "#f"],
    ["[x](https://user:pass@h.example)", "https://user:pass@h.example"],
    ["[x]\n\n[x]: javascript:alert(1)", "javascript:alert(1)"],
    ["[x][r]\n\n[r]: //e.x", "//e.x"],
  ];
  for (const [md, address] of refused)
    it(`keeps ${JSON.stringify(md)} as its text and address, with no link`, () => {
      const doc = inspect(page(md));
      expect(doc.querySelectorAll("a")).toHaveLength(0);
      expect(doc.body.textContent).toContain(`x (${address})`);
    });

  it("keeps a CommonMark autolink to javascript: as text", () => {
    const doc = inspect(page("<javascript:alert(1)>"));
    expect(doc.querySelectorAll("a")).toHaveLength(0);
    expect(doc.body.textContent).toContain("javascript:alert(1)");
  });

  it("links web and mail addresses, GFM's literal ones too, to the form it checked", () => {
    const doc = inspect(page("See www.e.x, https://e.x/a?b=1 and a@b.co, or [docs](https://docs.example/p 'The docs')."));
    expect([...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["http://www.e.x/", "https://e.x/a?b=1", "mailto:a@b.co", "https://docs.example/p"]);
    expect(doc.querySelector("a[title]")!.getAttribute("title")).toBe("The docs");
    expect(doc.querySelector("a")!.hasAttribute("target")).toBe(false);
  });

  it("resolves a reference to its first definition", () => {
    const doc = inspect(page("[x][r]\n\n[r]: https://first.example\n[r]: https://second.example"));
    expect(doc.querySelector("a")!.getAttribute("href")).toBe("https://first.example/");
  });
});

describe("Images on the page", () => {
  for (const [md, text] of [
    ["![a](https://tracker.example/p.gif)", "a (https://tracker.example/p.gif)"],
    ["![a](data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E)", "a (data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E)"],
    ["![a][t]\n\n[t]: https://tracker.example/q.gif", "a (https://tracker.example/q.gif)"],
  ])
    it(`shows ${JSON.stringify(md)} as its alt text and address, loading nothing`, () => {
      const html = page(md);
      expect(html).not.toContain("<img");
      expect(inspect(html).body.textContent).toContain(text);
    });
});

describe("Attribute values on the page", () => {
  it("keeps a quote in a link title inside the title", () => {
    const doc = inspect(page('[a](https://x.example "t\\" onmouseover=\\"x")'));
    const a = doc.querySelector("a")!;
    expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "title"]);
    expect(a.getAttribute("title")).toBe('t" onmouseover="x');
  });

  it("keeps a quote in an image's alt text as text", () => {
    expect(shown('![a" onerror="x](https://x.example/i.png)')).toContain('a" onerror="x (https://x.example/i.png)');
  });
});

describe("Math and diagrams on the page", () => {
  for (const md of ["$\\href{javascript:1}{x}$", "$$\\url{https://e.x}$$", "```mermaid\ngraph TD\nA-->B\nclick A href \"javascript:1\"\nA@{ img: \"https://e.x\" }\n```"])
    it(`shows ${JSON.stringify(md)} as code text, not typeset or drawn`, () => {
      const html = page(md);
      const doc = inspect(html);
      expect(html).not.toContain("katex");
      expect(doc.querySelectorAll("a, svg")).toHaveLength(0);
      expect(doc.querySelector("code")!.textContent).toMatch(/javascript:1|https:\/\/e\.x/);
    });
});

describe("Broken Markdown on the page", () => {
  for (const [name, md, text] of [
    ["an unclosed fence", "```js\nconst a = 1;", "const a = 1;"],
    ["an unclosed <div", "<div class=x\n\nhello", "hello"],
    ["unbalanced **", "**bold and *more", "**bold and *more"],
    ["5,000 nested quotes", `${">".repeat(5000)} deep`, "deep"],
    ["a 10,000-item list", Array.from({ length: 10_000 }, (_, i) => `- item ${i}`).join("\n"), "item 9999"],
  ])
    // The transcript's parser alone takes seconds on the two largest.
    it(`builds from ${name}`, () => {
      expect(shown(md)).toContain(text);
    }, 60_000);
});

const AT = new Date("2026-11-02T14:05:00Z");
const KEY = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
const chat = (items: Item[], title = "Moving house"): Chat => ({ id: "c1", runtimeId: "rt-1", title, source: "app", settled: false, updatedAt: 0, items });
const draft = (picked: string[]): ExportDraft => ({ ...FIRST_DRAFT, picked });
const asPage = (c: Chat, picked: string[]) => exportPreview(c, draft(picked), AT, "html");

describe("Redaction on the page, through the Export dialog's preview", () => {
  it("leaves a flagged key and a picked text out of the bytes and the visible text", () => {
    const p = asPage(chat([{ kind: "user", id: "u1", text: `Ship the boxes to 14 Larch Lane. The movers' key is ${KEY}` }]), ["Larch Lane"]);
    expect(p.problem).toBeUndefined();
    for (const gone of [KEY, "Larch Lane"]) {
      expect(p.text).not.toContain(gone);
      expect(inspect(p.text).documentElement.textContent).not.toContain(gone);
    }
    expect(inspect(p.text).body.textContent).toContain("Ship the boxes to 14 [redacted]. The movers' key is [redacted]");
  });

  it("redacts the title in <title> and in the file name", () => {
    const p = asPage(chat([{ kind: "user", id: "u1", text: "Hi" }], "Larch Lane move"), ["Larch Lane"]);
    expect(inspect(p.text).title).toBe("[redacted] move");
    expect(p.fileName).toBe("[redacted] move.html");
  });

  it("redacts text the parser decodes from a character reference", () => {
    const p = asPage(chat([{ kind: "assistant", id: "a1", text: "Use sk-abc&#100;ef for now." }]), ["sk-abcdef"]);
    expect(p.text).not.toContain("sk-abcdef");
    expect(p.text).not.toContain("&#100;");
    expect(inspect(p.text).body.textContent).toContain("Use [redacted] for now.");
  });

  it("redacts a link address the parser decodes", () => {
    const p = asPage(chat([{ kind: "assistant", id: "a1", text: "[the docs](https://e.example/?token=SEC&#82;ET)" }]), ["SECRET"]);
    const a = inspect(p.text).querySelector("a")!;
    expect(a.getAttribute("href")).not.toContain("SECRET");
    expect(p.text).not.toContain("SECRET");
  });

  it("makes no page when formatting splits a redacted text, and says why", () => {
    const p = asPage(chat([{ kind: "user", id: "u1", text: "The code is abc*d*ef." }]), ["abcdef"]);
    expect(p.text).toBe("");
    expect(p.problem).toMatch(/splits text you redacted/);
  });
});

describe("The page's head and bytes", () => {
  afterEach(() => vi.useRealTimers());
  const html = page("# A chat\n\nHello.");

  it("starts with the policy and referrer metas, before the title and any chat text", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const head = inspect(html).head.children;
    expect(head[0].localName).toBe("meta");
    expect(head[0].getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(head[0].getAttribute("content")).toBe(CSP);
    expect(head[1].localName).toBe("meta");
    expect(head[1].getAttribute("name")).toBe("referrer");
    expect(head[1].getAttribute("content")).toBe("no-referrer");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("A chat"));
  });

  it("declares its charset within the first 1024 bytes", () => {
    const meta = '<meta charset="utf-8">';
    expect(new TextEncoder().encode(html.slice(0, html.indexOf(meta) + meta.length)).length).toBeLessThanOrEqual(1024);
  });

  it("has a style that loads nothing", () => {
    const style = inspect(html).head.querySelector("style")!.textContent!;
    for (const bad of ["url(", "@import", "expression("]) expect(style).not.toContain(bad);
  });

  it("gives the same bytes for the same chat, whenever it is made", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = page("# A chat\n\nHello [x](https://e.x).");
    vi.setSystemTime(new Date("2031-06-15T12:00:00Z"));
    expect(page("# A chat\n\nHello [x](https://e.x).")).toBe(first);
  });

  it("writes a two-message chat as plain markup", () => {
    const body = page("# Two\n\n**You:**\n\nIs `x < y`?\n\n**Hermes:**\n\nYes, see [MDN](https://developer.mozilla.org).\n- a\n- b").split("<body>")[1];
    expect(body).toMatchInlineSnapshot(`"<h1>Two</h1><p><strong>You:</strong></p><p>Is <code>x &lt; y</code>?</p><p><strong>Hermes:</strong></p><p>Yes, see <a href="https://developer.mozilla.org/" rel="noopener noreferrer">MDN</a>.</p><ul><li><p>a</p></li><li><p>b</p></li></ul></body></html>"`);
  });
});
