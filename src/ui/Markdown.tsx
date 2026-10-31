// Markdown with highlighted, copyable code blocks. Ported from the prototype.
import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
    >
      {text}
    </ReactMarkdown>
  );
});
