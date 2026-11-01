// Markdown with highlighted, copyable code blocks and find-in-chat marks. Ported from the prototype. Single newlines
// are kept as line breaks, since replies often put one item per line.
import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { escapeRe } from "./bits";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/**
 * Rehype plugin: wraps each case-insensitive occurrence of `query` in `<mark class="hit">`. It runs after
 * rehype-highlight, so code blocks are marked too, except where a match spans two highlighted tokens.
 */
function rehypeFind(query: string) {
  return () => (tree: HastNode) => {
    if (!query) return;
    const re = new RegExp(`(${escapeRe(query)})`, "gi");
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        return child.value
          .split(re)
          .flatMap((part, i): HastNode[] =>
            !part ? [] : i % 2 ? [{ type: "element", tagName: "mark", properties: { className: ["hit"] }, children: [{ type: "text", value: part }] }] : [{ type: "text", value: part }],
          );
      });
    };
    walk(tree);
  };
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState("");
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang}</span>
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
      <pre
        ref={(el) => {
          ref.current = el;
          const m = el?.querySelector("code")?.className.match(/language-(\S+)/);
          if (m && m[1] !== lang) setLang(m[1]);
        }}
      >
        {children}
      </pre>
    </div>
  );
}

/** `query`: the find-in-chat text to mark. */
export const Markdown = memo(function Markdown({ text, query = "" }: { text: string; query?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }], rehypeFind(query)]}
      components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
    >
      {text}
    </ReactMarkdown>
  );
});
