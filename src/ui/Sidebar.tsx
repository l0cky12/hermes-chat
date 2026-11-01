// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A.
// Search, Settings and the profile switcher come in later tickets.
import { useState } from "react";
import { ChevronRight, LockOpen, SquarePen } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { SettleButton, SourceIcon, Spinner, relTime } from "./bits";

const byRecent = (a: Chat, b: Chat) => b.updatedAt - a.updatedAt;

const STATUS_LABEL: Record<ConnectionStatus, string> = { connected: "Connected", reconnecting: "Reconnecting…", offline: "Offline" };

export function Rail({
  status,
  route,
  unsecure,
  closedReason,
  onReconnect,
  onToggleList,
  onNew,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  onReconnect: () => void;
  onToggleList: () => void;
  onNew: () => void;
}) {
  const where = route?.kind === "ssh" ? `ssh://${route.target}` : route?.url;
  // The full wording lives only in the tooltip (ADR 0001).
  const tip = [
    STATUS_LABEL[status],
    where,
    unsecure && "Unsecure: traffic to the server isn't encrypted",
    status !== "connected" && closedReason,
    status !== "connected" && "Click to reconnect",
  ]
    .filter(Boolean)
    .join(" · ");
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
        <button className="conn-btn" title={tip} aria-label={tip} onClick={() => status !== "connected" && onReconnect()}>
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          {unsecure && <LockOpen className="conn-lock" size={9} strokeWidth={2.8} />}
        </button>
      </div>
    </aside>
  );
}

function ChatRow({
  chat,
  selected,
  onOpen,
  onSettle,
}: {
  chat: Chat;
  selected: boolean;
  onOpen: () => void;
  onSettle: (settled: boolean) => void;
}) {
  return (
    <div
      className={`row ${selected ? "sel" : ""}`}
      onClick={onOpen}
      title={chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}
    >
      {chat.source !== "app" && <SourceIcon source={chat.source} />}
      <span className="row-title">{chat.title}</span>
      <span className="row-meta">{chat.running ? <Spinner /> : relTime(chat.updatedAt)}</span>
      <SettleButton settled={chat.settled} size={14} className="row-action" onSettle={onSettle} />
    </div>
  );
}

export function ChatList({
  profile,
  chats,
  syncError,
  selectedId,
  onOpen,
  onSettle,
}: {
  profile: string;
  chats: Chat[];
  syncError?: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onSettle: (id: string, settled: boolean) => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const active = chats.filter((c) => !c.settled).sort(byRecent);
  const settled = chats.filter((c) => c.settled).sort(byRecent);
  const row = (c: Chat) => (
    <ChatRow key={c.id} chat={c} selected={c.id === selectedId} onOpen={() => onOpen(c.id)} onSettle={(s) => onSettle(c.id, s)} />
  );
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
