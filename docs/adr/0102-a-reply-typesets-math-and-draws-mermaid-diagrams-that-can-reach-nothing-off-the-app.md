# A reply typesets math and draws Mermaid diagrams that can reach nothing off the app

Models write formulas (`$E = mc^2$`, `$$…$$`, `\(…\)`, `\[…\]`) and Mermaid diagrams (a ```` ```mermaid ```` fence) when they explain maths or a design. Hermes Chat rendered Markdown with GFM and line breaks only, so both showed as raw source (#350). Other desktop chat clients typeset both. Any change has to keep the per-delta streaming cost that ADR 0068 set. A reply can also carry text a prompt injection wrote (ADR 0099), and a Mermaid diagram is a small program that styles and links an SVG, so drawing one must not make the app fetch anything.

## Decisions

- **The parser reads math, never a regex over the text.** `src/ui/markdownMath.ts` adds micromark constructs, so a formula inside inline code or a code fence stays code, and `*` or `_` inside a formula is never emphasis. The mdast is mdast-util-math's (`inlineMath`, `math`). The splitter (`markdownBlocks.ts`) parses with the same constructs, so a `$$` block with blank lines in it stays one block.
  - `$$…$$` on its own lines is a display block (micromark-extension-math's flow construct).
  - `$…$` follows Pandoc's rule. The opening `$` has no space after it. The closing `$` has no space before it and no digit after it. "It costs $5 and $10" stays prose.
  - `\(…\)` is inline math, and `\[…\]` and `$$…$$` inside a paragraph are display math, as in TeX. These constructs run before Markdown's backslash escapes.
- **KaTeX typesets math in the rehype step that highlights code** (`rehypeCode`, `src/ui/markdownPipeline.ts`). The output is cached by display mode and TeX, least recently used first out past 2,000,000 characters of KaTeX HTML. Cached nodes go into the tree frozen rather than copied, because copying them was most of a streamed delta's work. TeX that KaTeX can't parse shows as itself in red. KaTeX's `trust` stays off, so `\href` and `\includegraphics` don't render.
- **KaTeX's CSS and fonts are bundled.** `Markdown.tsx` imports `katex/dist/katex.min.css`, Vite copies the fonts into `assets/`, and the CSS refers to them by path. KaTeX is in the startup bundle, because typesetting runs inside the synchronous render.
- **Math and diagrams still coming in stay source, as code does (ADR 0068).** An unclosed `$$` block at the end of a streaming reply counts as open and shows its TeX in a plain block until its closing `$$` comes, a block starts after it, or the reply ends. An unclosed `$` or `\(` is plain text until it closes. Open code carries `data-growing` on its `<code>`, and a ```` ```mermaid ```` block draws only once that attribute is gone.
- **Find-in-chat doesn't mark inside typeset math.** KaTeX's text is glyphs and a copy of the TeX for screen readers, not words a reader looks for. A diagram's source is still marked.
- **A finished `mermaid` block draws its diagram.** `src/ui/mermaid.ts` loads Mermaid with `import()` on the first diagram, in its own chunks, once the block has scrolled into view. The block keeps its language label and **Copy**, which copies the source, and gets a **Source** button that switches to the source and back to **Diagram**. Drawings are cached by theme and source, the last 50. Mermaid draws one diagram at a time, because its configuration is global.
- **A diagram that can't be drawn shows its source with a note**, such as "Couldn't draw this diagram: Parse error on line 3".
- **A diagram can reach nothing off the app.** Mermaid's `securityLevel: "strict"` was not enough. With it, a `%%{init}%%` directive or frontmatter `themeCSS` or `fontFamily` put `url(https://…)` into the SVG's styles, `click A href "https://…"` became a link that would take the app's window there, and an image shape (`A@{ img: "https://…" }`) made Mermaid request the image while it drew. So:
  - **Refused before drawing.** A source that has `@{` and either `img` or a YAML `\x` or `\u` escape anywhere isn't drawn, nor one whose text, with CSS escapes read, has `url(` (other than `url(#…)`), `image-set(` or `@import`. Mermaid applies `classDef` and `style` while it draws in the page, before there is an SVG to clean. The note says why.
  - **Settings are locked.** Mermaid's `secure` list names every configuration key, so no directive or frontmatter changes any setting. Labels are SVG text (`htmlLabels: false`), so a label's `<img>` or Markdown image is only words.
  - **The SVG is cleaned before it is shown.** It is parsed in a document that loads nothing. Elements that load something or animate an attribute go, as do every link's `href`, every other URL attribute not pointing at `#…`, `on…` handlers, and CSS that fetches.

## Considered options

- **remark-math and rehype-katex as they come.** remark-math reads `$5 and $10` as a formula and has no `\(` or `\[`. rehype-katex has no notion of math still coming in, and typesets every formula in the last block on every delta.
- **Rewriting `\(` and `\[` to dollars with a regex before parsing.** Rejected. To leave code spans and fences that show those characters alone, it would have to find code the way the parser does.
- **Mermaid's `sandbox` security level.** It draws the SVG in a sandboxed frame, which still loads images and CSS from the network.
- **A Content-Security-Policy `img-src`, `style-src` or `font-src`.** The issue keeps the policy as it is, and the open hardening work (#344) sets `script-src` only. Under that policy, built into the app, math and a sequence diagram still render. The checks above don't depend on any policy.
- **Settings → Appearance switches for math and diagrams, and Copy as SVG or PNG.** Not built. The issue lists them as possible solutions, not as acceptance criteria, and nobody has asked to turn either off.

## Consequences

- A finished reply's HTML is the same whether it streamed or not, for replies with math and diagrams too (`src/ui/streamingMarkdown.test.tsx`).
- Escaped brackets written as `\[text\]` now show as display math, not `[text]`.
- A diagram whose source mentions `img` next to shape data, or links a URL in its styles, shows as source even when it would have been harmless.
- A drawn diagram keeps the theme it was drawn in until its block renders again, such as when the chat is opened again.
- The startup bundle grows by KaTeX (259 kB, 78 kB gzipped) and its CSS, and `assets/` by 1.07 MB of fonts. Mermaid adds about 4.9 MB of chunks that load only when a diagram is drawn.
- Streaming cost (`node bench/parse.ts math`, median of 5 runs, 2026-11-08). On a reply of 10 paragraphs with three inline formulas each, the delta that closes a formula and typesets it for the first time takes 2.2 ms, against 0.7 ms on main, which typeset nothing. Other deltas take 0.3 ms on both. Nothing grows with the number of paragraphs. The code-block benchmark (`blocks`) is unchanged.
