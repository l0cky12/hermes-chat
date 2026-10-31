// Transcript, tool-call groups and composer, ported from the prototype. Find-in-chat, approvals,
// attachments, Stop and settling come in later tickets.
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Wrench } from "lucide-react";
import type { Chat, Item } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";
import { Markdown } from "./Markdown";
import { SourceIcon, Spinner } from "./bits";

type ToolItem = Extract<Item, { kind: "tool" }>;
type Block = { kind: "tools"; id: string; tools: ToolItem[] } | Exclude<Item, ToolItem>;

// Consecutive tool calls collapse into one group so a long run doesn't dominate the transcript.
function toBlocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(it);
      else out.push({ kind: "tools", id: `g-${it.id}`, tools: [it] });
    } else out.push(it);
  }
  return out;
}

export function ChatPane({ chat, offline, onSend }: { chat: Chat; offline: boolean; onSend: (text: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Follow the stream while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  const blocks = toBlocks(chat.items);
  const last = chat.items[chat.items.length - 1];

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          {chat.source !== "app" && <SourceIcon source={chat.source} size={13} />}
          <span>{chat.title}</span>
          {chat.settled && <span className="badge">Settled</span>}
        </div>
      </header>

      <div
        className="transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="transcript-inner">
          {chat.source !== "app" && (
            <div className="imported-note">
              <SourceIcon source={chat.source} /> Imported from {SOURCE_LABEL[chat.source]}. Replying here moves it to
              Active.
            </div>
          )}
          {blocks.length === 0 && <div className="empty-chat">What should Hermes work on?</div>}
          {blocks.map((b) => {
            if (b.kind === "user")
              return (
                <div key={b.id} className="msg user">
                  <div className="bubble-text">{b.text}</div>
                </div>
              );
            if (b.kind === "assistant")
              return (
                <div key={b.id} className="msg assistant">
                  <Markdown text={b.text} />
                  {chat.running && b === last && <span className="cursor" />}
                </div>
              );
            if (b.kind === "error")
              return (
                <div key={b.id} className="msg error" role="alert">
                  {b.text}
                </div>
              );
            return <ToolGroup key={b.id} tools={b.tools} />;
          })}
          {chat.running && last?.kind !== "assistant" && (
            <div className="msg assistant thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>

      <Composer
        disabled={!!chat.running || offline}
        note={offline ? "Offline. Sign in again to keep chatting." : undefined}
        onSend={(t) => {
          stickToBottom.current = true;
          onSend(t);
        }}
      />
    </div>
  );
}

function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool ${open ? "open" : ""}`}>
      <button className="tool-line" onClick={() => setOpen((o) => !o)}>
        {t.status === "running" ? <Spinner /> : <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />}
        <span className="tool-name">{t.name}</span>
        <span className="tool-preview">{t.preview}</span>
        {t.summary && <span className="tool-summary">{t.summary}</span>}
        {t.durationS != null && <span className="tool-dur">{t.durationS}s</span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Arguments</div>
          <pre>{JSON.stringify(t.args ?? {}, null, 2)}</pre>
          <div className="tool-label">Result</div>
          <pre>{t.status === "running" ? "…" : t.result || "(empty)"}</pre>
        </div>
      )}
    </div>
  );
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1)
    return (
      <div className="tools">
        <ToolRow t={tools[0]} />
      </div>
    );
  const running = tools.find((t) => t.status === "running");
  const names = [...new Set(tools.map((t) => t.name))].join(", ");
  return (
    <div className="tools">
      <button className="tool-line group" onClick={() => setOpen((o) => !o)}>
        {running ? <Spinner /> : <Wrench size={13} />}
        <span className="tool-name">{tools.length} tool calls</span>
        <span className="tool-preview">{running ? `${running.name} · ${running.preview ?? ""}` : names}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ disabled, note, onSend }: { disabled: boolean; note?: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  const send = () => {
    if (disabled || !text.trim()) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="composer-wrap">
      {note && <div className="offline-note">{note}</div>}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          autoFocus
          placeholder="Message Hermes"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <span className="composer-keys">Enter to send · Shift+Enter for a new line</span>
          <button className="send" title="Send" disabled={disabled || !text.trim()} onClick={send}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
