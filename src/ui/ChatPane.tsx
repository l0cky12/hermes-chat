// Transcript, tool-call groups and composer, ported from the prototype. Find-in-chat, approvals and
// settling come in later tickets.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Paperclip, Square, Wrench, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { AttachCheck, Attachment, Chat, Item } from "../hermes/model";
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

export function ChatPane({
  chat,
  offline,
  onAttach,
  onSend,
  onStop,
}: {
  chat: Chat;
  offline: boolean;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
}) {
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
          {chat.loading && blocks.length === 0 && (
            <div className="loading-chat">
              <Spinner /> Loading chat
            </div>
          )}
          {!chat.loading && blocks.length === 0 && <div className="empty-chat">What should Hermes work on?</div>}
          {blocks.map((b) => {
            if (b.kind === "user")
              return (
                <div key={b.id} className="msg user">
                  {b.attachments && (
                    <div className="msg-files">
                      {b.attachments.map((name, i) => (
                        <span key={i} className="chip">
                          <Paperclip size={12} />
                          <span className="chip-name">{name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {b.text && <div className="bubble-text">{b.text}</div>}
                </div>
              );
            if (b.kind === "assistant")
              return (
                <div key={b.id} className="msg assistant">
                  <Markdown text={b.text} />
                  {chat.running && b === last && <span className="cursor" />}
                  {b.interrupted && <div className="stopped">Stopped</div>}
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
        offline={offline}
        running={!!chat.running}
        stopping={!!chat.stopping}
        note={offline ? "Offline. Sign in again to keep chatting." : undefined}
        onAttach={onAttach}
        onSend={(t, attachments) => {
          stickToBottom.current = true;
          onSend(t, attachments);
        }}
        onStop={onStop}
      />
    </div>
  );
}

function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const summary = t.status === "stopped" ? "stopped" : t.summary;
  return (
    <div className={`tool ${open ? "open" : ""}`}>
      <button className="tool-line" onClick={() => setOpen((o) => !o)}>
        {t.status === "running" ? <Spinner /> : <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />}
        <span className="tool-name">{t.name}</span>
        <span className="tool-preview">{t.preview}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {t.durationS != null && <span className="tool-dur">{t.durationS}s</span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Arguments</div>
          <pre>{JSON.stringify(t.args ?? {}, null, 2)}</pre>
          {/* Stored history keeps no result for most tools. */}
          {(t.status === "running" || t.result !== undefined) && (
            <>
              <div className="tool-label">Result</div>
              <pre>{t.status === "running" ? "…" : t.result || "(empty)"}</pre>
            </>
          )}
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

function Composer({
  offline,
  running,
  stopping,
  note,
  onAttach,
  onSend,
  onStop,
}: {
  offline: boolean;
  running: boolean;
  stopping: boolean;
  note?: string;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const add = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const got = await onAttach(paths);
      setAttachments((cur) => [...cur, ...got.attachments.filter((a) => !cur.some((x) => x.path === a.path))]);
      setRefused(got.refused);
    } catch (e) {
      setRefused([`Couldn't attach files: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };
  const addRef = useRef(add);
  addRef.current = add;

  // Tauri's native drop event, not HTML5 drops: it gives real file paths, so Rust can read the bytes.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") setDragging(true);
      else {
        setDragging(false);
        if (payload.type === "drop") void addRef.current(payload.paths);
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  const pick = async () => {
    try {
      const paths = await openFileDialog({ multiple: true, directory: false });
      if (paths) await add(paths);
    } catch (e) {
      setRefused([`Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  const sendable = !!text.trim() || attachments.length > 0;
  const send = () => {
    if (offline || running || !sendable) return;
    onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
    setRefused([]);
  };

  return (
    <div className="composer-wrap">
      {note && <div className="offline-note">{note}</div>}
      {refused.map((r, i) => (
        <div key={i} className="attach-note" role="alert">
          {r}
        </div>
      ))}
      <div className={`composer ${dragging ? "dragging" : ""}`}>
        {dragging && <div className="drop-overlay">Drop files to attach</div>}
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((f) => (
              <span key={f.path} className="chip" title={f.path}>
                <Paperclip size={12} />
                <span className="chip-name">{f.name}</span>
                <span className="chip-size">{fmtSize(f.size)}</span>
                <button title="Remove" onClick={() => setAttachments((cur) => cur.filter((x) => x.path !== f.path))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
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
          <button className="icon-btn" title="Attach files" onClick={() => void pick()}>
            <Paperclip size={16} />
          </button>
          <span className="composer-keys">Enter to send · Shift+Enter for a new line</span>
          {running ? (
            <button className="send stop" title={stopping ? "Stopping" : "Stop"} disabled={offline || stopping} onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send" title="Send" disabled={offline || !sendable} onClick={send}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
