// Transcript, tool-call groups, find bar, composer and the Settle button, ported from the prototype. Approvals come
// in a later ticket.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, ChevronUp, Paperclip, Search, Square, Wrench, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { AttachCheck, Attachment, Chat, ConnectionStatus, Item, Source } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";
import { Markdown } from "./Markdown";
import { SettleButton, SourceIcon, Spinner, highlight } from "./bits";

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

/**
 * Where the find bar opens when a chat is opened from a search: on `query`, at the first match in the message
 * `itemId`, or at the first match anywhere when the matched message isn't known. `at` tells one pick from the next.
 */
export type FindTarget = { query: string; itemId?: string; at: number };

const STATUS_NOTE: Record<ConnectionStatus, string | undefined> = {
  connected: undefined,
  reconnecting: "Reconnecting to Hermes…",
  offline: "Offline. Click the status dot to reconnect.",
};

/**
 * `alsoPostsIn`: the Telegram or Discord chat Hermes will also post its replies in. `onSettle` is left out for a chat
 * not started yet. Ctrl+F opens the find bar.
 */
export function ChatPane({
  chat,
  findTarget,
  status,
  alsoPostsIn,
  onAttach,
  onSend,
  onStop,
  onSettle,
}: {
  chat: Chat;
  findTarget?: FindTarget;
  status: ConnectionStatus;
  alsoPostsIn?: Source;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onSettle?: (settled: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Which match is the current one, counting from the top of the chat.
  const [matchIndex, setMatchIndex] = useState(0);
  const [count, setCount] = useState(0);
  // A search pick waiting for the chat's history, so the find bar can land on the matched message.
  const [landing, setLanding] = useState(false);
  // The current match should be scrolled to after the next render.
  const scrollToMatch = useRef(false);

  useEffect(() => {
    if (!findTarget) return;
    setFindOpen(true);
    setQuery(findTarget.query);
    setLanding(true);
    stickToBottom.current = false;
  }, [findTarget?.at]);

  const openFind = () => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = findOpen ? query : "";

  // After every render, count the marks and point at the current one.
  useLayoutEffect(() => {
    const marks = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("mark.hit") ?? []);
    setCount(marks.length);
    let idx = Math.min(matchIndex, marks.length - 1);
    // Land once the history is in: it has marks, or it has loaded without any (the match was in a tool call, say).
    if (landing && !chat.loading && (marks.length || chat.runtimeId)) {
      setLanding(false);
      const itemId = findTarget?.itemId;
      idx = Math.max(0, itemId ? marks.findIndex((m) => m.closest(`[data-item="${CSS.escape(itemId)}"]`)) : 0);
      setMatchIndex(idx);
      scrollToMatch.current = true;
    }
    marks.forEach((m, i) => m.classList.toggle("current", i === idx));
    if (scrollToMatch.current && marks[idx]) {
      scrollToMatch.current = false;
      marks[idx].scrollIntoView({ block: "center" });
    }
  });

  // Follow the stream while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && !q) el.scrollTop = el.scrollHeight;
  });

  const step = (d: number) => {
    if (!count) return;
    setMatchIndex((i) => (Math.min(i, count - 1) + d + count) % count);
    scrollToMatch.current = true;
    stickToBottom.current = false;
  };
  const closeFind = () => {
    setFindOpen(false);
    setLanding(false);
  };

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
        <div className="chat-head-actions">
          <button
            className="icon-btn"
            title="Find in chat (Ctrl+F)"
            onClick={openFind}
          >
            <Search size={16} />
          </button>
          {onSettle && <SettleButton settled={chat.settled} size={16} className="icon-btn" onSettle={onSettle} />}
        </div>
        {findOpen && (
          <div className="find" role="search">
            <input
              ref={findRef}
              autoFocus
              placeholder="Find in chat"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
                setLanding(false);
                scrollToMatch.current = true;
                stickToBottom.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
                } else if (e.key === "Escape") closeFind();
              }}
            />
            <span className="find-count" aria-live="polite">
              {query ? `${count ? Math.min(matchIndex, count - 1) + 1 : 0} of ${count}` : ""}
            </span>
            <button className="icon-btn" title="Previous (↑ or Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
              <ChevronUp size={16} />
            </button>
            <button className="icon-btn" title="Next (↓ or Enter)" disabled={!count} onClick={() => step(1)}>
              <ChevronDown size={16} />
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
              <X size={16} />
            </button>
          </div>
        )}
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
              <SourceIcon source={chat.source} /> Imported from {SOURCE_LABEL[chat.source]}.
              {chat.settled && " Replying here moves it to Active."}
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
                <div key={b.id} className="msg user" data-item={b.id}>
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
                  {b.text && <div className="bubble-text">{highlight(b.text, q)}</div>}
                </div>
              );
            if (b.kind === "assistant")
              return (
                <div key={b.id} className="msg assistant" data-item={b.id}>
                  <Markdown text={b.text} query={q} />
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
        offline={status !== "connected"}
        running={!!chat.running}
        stopping={!!chat.stopping}
        note={STATUS_NOTE[status]}
        alsoPostsIn={alsoPostsIn}
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
  alsoPostsIn,
  onAttach,
  onSend,
  onStop,
}: {
  offline: boolean;
  running: boolean;
  stopping: boolean;
  note?: string;
  alsoPostsIn?: Source;
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
      {alsoPostsIn && (
        <div className="platform-note">
          <SourceIcon source={alsoPostsIn} /> Hermes also posts its replies in this {SOURCE_LABEL[alsoPostsIn]} chat.
        </div>
      )}
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
