// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A.
// Search, Settings, settling and the profile switcher come in later tickets.
import { useState } from "react";
import { ChevronRight, SquarePen } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";
import { SourceIcon, Spinner, relTime } from "./bits";

const byRecent = (a: Chat, b: Chat) => b.updatedAt - a.updatedAt;

export function Rail({
  status,
  where,
  onToggleList,
  onNew,
}: {
  status: ConnectionStatus;
  where: string;
  onToggleList: () => void;
  onNew: () => void;
}) {
  const label = status === "connected" ? "Connected" : "Offline";
  return (
    <aside className="rail">
      <div className="rail-top">
        <button className="rail-brand" title="Hide or show chats (Ctrl+B)" onClick={onToggleList}>
          H
        </button>
        <button className="icon-btn" title="New chat (Ctrl+N)" onClick={onNew}>
          <SquarePen size={18} />
        </button>
      </div>
      <div className="rail-bottom">
        <span className={`conn-dot ${status}`} title={`${label} · ${where}`} />
      </div>
    </aside>
  );
}

function ChatRow({ chat, selected, onOpen }: { chat: Chat; selected: boolean; onOpen: () => void }) {
  return (
    <div
      className={`row ${selected ? "sel" : ""}`}
      onClick={onOpen}
      title={chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}
    >
      {chat.source !== "app" && <SourceIcon source={chat.source} />}
      <span className="row-title">{chat.title}</span>
      <span className="row-meta">{chat.running ? <Spinner /> : relTime(chat.updatedAt)}</span>
    </div>
  );
}

export function ChatList({
  profile,
  chats,
  syncError,
  selectedId,
  onOpen,
}: {
  profile: string;
  chats: Chat[];
  syncError?: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const active = chats.filter((c) => !c.settled).sort(byRecent);
  const settled = chats.filter((c) => c.settled).sort(byRecent);
  const row = (c: Chat) => <ChatRow key={c.id} chat={c} selected={c.id === selectedId} onOpen={() => onOpen(c.id)} />;
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="profile-name">{profile}</span>
      </div>
      <div className="sb-scroll">
        {syncError && (
          <div className="sync-error" role="status">
            {syncError}
          </div>
        )}
        <div className="section-label">Active</div>
        {active.length ? active.map(row) : <div className="empty-hint">Nothing active. Start a new chat.</div>}
        <button className="section-toggle" onClick={() => setSettledOpen((o) => !o)}>
          <ChevronRight size={14} className={`chev ${settledOpen ? "open" : ""}`} />
          Settled
          <span className="count">{settled.length}</span>
        </button>
        {settledOpen && <div className="settled-list">{settled.map(row)}</div>}
      </div>
    </aside>
  );
}
