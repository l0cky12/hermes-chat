// The chat's queue of messages waiting to go after its reply (ADR 0018), above the composer. Both panes of a chat show
// the same queue. Each message can be edited, dragged to another place or moved with Alt+↑/↓ (ADR 0071), and removed;
// the queue can be paused and resumed.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { GripVertical, ListOrdered, Paperclip, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { type Attachment, type Chat, type ChatQueue, type ConnectionStatus, type Queued, isOutgoing, isWaiting } from "../hermes/model";
import { composing, slotAt } from "./bits";

/** What the queue panel does, for a chat that has started. `add` returns why a message couldn't be queued. */
export type QueueApi = {
  add: (text: string, attachments: Attachment[]) => string | undefined;
  edit: (id: string, text: string) => boolean;
  remove: (id: string) => void;
  /** Puts the message at place `index`, 0 first. */
  moveTo: (id: string, index: number) => void;
  pause: () => void;
  resume: () => void;
  /** Keeps the queue from going while a message in it is edited; call the result when done. */
  hold: () => () => void;
};

/** The drag data type a queued message's id travels under. Nothing else in the app, the composer included, takes it. */
const QUEUED_DRAG = "application/x-hermes-queued";
// The message being dragged and its chat, kept because a drag's data can be read only on drop and the mark needs it
// before. As with tabs (Tabs.tsx), trusted only while the drag carries its type.
let queueDrag: { chat: string; id: string } | null = null;

/** What the next queued message waits for, when the queue isn't paused. */
function waitingFor(chat: Chat, status: ConnectionStatus): string {
  if (status !== "connected") return "Waits for Hermes to connect.";
  if (chat.items.some(isOutgoing)) return "Waits until the message above is sent, retried or dismissed.";
  if (chat.items.some(isWaiting)) return "Waits for your answer to the Approval above.";
  if (chat.running) return "The next one goes when this reply finishes.";
  return "Sending the next one…";
}

export function QueuePanel({ chat, queue, status, api }: { chat: Chat; queue?: ChatQueue; status: ConnectionStatus; api: QueueApi }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // After a move or removal, focus stays with the message moved, or goes to the one now in the removed one's place.
  const [focus, setFocus] = useState<{ id?: string; index: number }>();
  // While a drop would move a message: before which row it lands, `items.length` after the last.
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string>();
  const items = queue?.items ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  useEffect(() => {
    if (!focus) return;
    setFocus(undefined);
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".queue-item") ?? []);
    const row = rows.find((r) => r.dataset.queued === focus.id) ?? rows[Math.min(focus.index, rows.length - 1)];
    if (row) row.focus();
    else rootRef.current?.closest(".chat")?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  });
  // The panel goes with its last message; the wrapper stays, so focus can be put back in the pane.
  if (!items.length) return <div ref={rootRef} />;

  const paused = queue?.paused !== undefined;
  const move = (id: string, index: number) => {
    api.moveTo(id, index);
    setFocus({ id, index: 0 });
  };
  // Where a drop here would put the dragged message, or nothing for a drag that isn't one of this chat's queued
  // messages, or a drop that would leave it where it is. `edge`: over the queue's head or foot, which mean first and
  // last even when the list is scrolled and its rows out of sight would count otherwise.
  const dropAt = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(QUEUED_DRAG) || queueDrag?.chat !== chat.id) return undefined;
    const { id } = queueDrag;
    const from = items.findIndex((i) => i.id === id);
    const list = rootRef.current?.querySelector(".queue-list");
    const box = list?.getBoundingClientRect();
    const edge = !box?.height ? undefined : e.clientY < box.top ? "head" : e.clientY >= box.bottom ? "foot" : undefined;
    const slot = edge === "head" ? 0 : edge === "foot" ? items.length : slotAt(Array.from(list?.querySelectorAll(".queue-item") ?? []), e.clientY, "y");
    if (from < 0 || slot === undefined) return undefined;
    const to = slot > from ? slot - 1 : slot;
    return to === from ? undefined : { id, to, slot, edge, list };
  };
  const remove = (item: Queued, index: number) => {
    api.remove(item.id);
    setFocus({ index });
  };

  return (
    <div ref={rootRef}>
      <section
        className={`queue${paused ? " paused" : ""}`}
        aria-label="Queued messages"
        onDragOver={(e) => {
          const drop = dropAt(e);
          if (!drop) return setOver(null);
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (over !== drop.slot) setOver(drop.slot);
          // So the mark is in sight.
          if (drop.edge && drop.list) drop.list.scrollTop = drop.edge === "head" ? 0 : drop.list.scrollHeight;
        }}
        onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(null)}
        onDrop={(e) => {
          setOver(null);
          const drop = dropAt(e);
          queueDrag = null;
          if (!drop) return;
          e.preventDefault();
          move(drop.id, drop.to);
        }}
      >
        <div className="queue-head">
          <ListOrdered size={13} aria-hidden />
          <span className="queue-title">Queued · {items.length}</span>
          <span className="queue-state" aria-live="polite">
            {paused ? `Paused. ${queue!.paused}` : waitingFor(chat, status)}
          </span>
          {paused ? (
            <button className="btn queue-toggle" onClick={api.resume}>
              <Play size={12} /> Resume
            </button>
          ) : (
            <button className="btn queue-toggle" onClick={api.pause}>
              <Pause size={12} /> Pause
            </button>
          )}
        </div>
        {queue?.unsaved && (
          <div className="queue-note" role="alert">
            Couldn't save the queue on this computer: its storage is full. It's kept until Hermes Chat closes.
          </div>
        )}
        <ol className="queue-list">
          {items.map((item, i) => (
            <QueueRow
              key={item.id}
              item={item}
              index={i}
              count={items.length}
              state={paused ? "Paused" : i === 0 ? "Next" : "Queued"}
              mark={over === i ? "insert-before" : over === items.length && i === items.length - 1 ? "insert-after" : ""}
              dragged={dragging === item.id}
              api={api}
              onMove={(to) => move(item.id, to)}
              onRemove={() => remove(item, i)}
              onDrag={(on) => {
                queueDrag = on ? { chat: chat.id, id: item.id } : null;
                // WebKit takes the drag image once dragstart returns: a row faded by then would be dragged faded.
                if (on) setTimeout(() => queueDrag?.id === item.id && setDragging(item.id));
                else {
                  setDragging(undefined);
                  setOver(null);
                }
              }}
            />
          ))}
        </ol>
        <div className="queue-foot">Hermes Chat sends these itself, one after each reply, only while it's open and connected.</div>
      </section>
    </div>
  );
}

function QueueRow({
  item,
  index,
  count,
  state,
  mark,
  dragged,
  api,
  onMove,
  onRemove,
  onDrag,
}: {
  item: Queued;
  index: number;
  count: number;
  state: string;
  mark: string;
  dragged: boolean;
  api: QueueApi;
  onMove: (index: number) => void;
  onRemove: () => void;
  onDrag: (on: boolean) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const [gone, setGone] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const files = item.attachments?.length ?? 0;
  // Nothing in the queue goes while its words are being changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  useEffect(() => (editing === undefined ? undefined : api.hold()), [editing === undefined]);

  const close = () => {
    setEditing(undefined);
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('[data-action="edit"]')?.focus());
  };
  const save = () => {
    if (editing === undefined) return;
    if (!api.edit(item.id, editing.trim())) setGone(true);
    close();
  };

  return (
    <li
      ref={rowRef}
      className={`queue-item ${mark}${dragged ? " dragging" : ""}`}
      data-queued={item.id}
      tabIndex={0}
      // A message being edited stays put: its words are being changed, and a drag would take the text selection.
      draggable={editing === undefined}
      onDragStart={(e) => {
        // A text selection dragged out of the edit box bubbles here too.
        if (e.target !== e.currentTarget) return;
        e.dataTransfer.setData(QUEUED_DRAG, item.id);
        e.dataTransfer.effectAllowed = "move";
        onDrag(true);
      }}
      onDragEnd={(e) => e.target === e.currentTarget && onDrag(false)}
      aria-label={`Queued message ${index + 1} of ${count}${files ? `, ${files} ${files === 1 ? "file" : "files"}` : ""}: ${item.text}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || composing(e)) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          onMove(index + (e.key === "ArrowUp" ? -1 : 1));
        } else if (e.key === "Delete") {
          e.preventDefault();
          onRemove();
        }
      }}
    >
      <span className="queue-grip" title="Drag to move, or Alt+↑/↓" aria-hidden>
        <GripVertical size={13} />
      </span>
      <span className="queue-pos" aria-hidden>
        {index + 1}
      </span>
      <div className="queue-body">
        {editing === undefined ? (
          <span className="queue-text">{item.text || <i>Files only</i>}</span>
        ) : (
          <textarea
            className="queue-edit"
            aria-label={`Edit queued message ${index + 1}`}
            autoFocus
            rows={Math.min(6, editing.split("\n").length + 1)}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
        )}
        <div className="queue-meta">
          <span className={`queue-badge ${state.toLowerCase()}`}>{state}</span>
          {files > 0 && (
            <span className="queue-files">
              <Paperclip size={11} aria-hidden /> {files} {files === 1 ? "file" : "files"}
            </span>
          )}
          {gone && <span className="queue-gone">It had already gone, so the edit wasn't kept.</span>}
          {editing !== undefined && <span className="queue-keys">Enter to save · Esc to cancel</span>}
        </div>
      </div>
      <div className="queue-actions">
        {editing === undefined ? (
          <>
            <button
              className="icon-btn"
              data-action="edit"
              title="Edit"
              aria-label={`Edit queued message ${index + 1}`}
              onClick={() => (setGone(false), setEditing(item.text))}
            >
              <Pencil size={13} />
            </button>
            <button className="icon-btn" data-action="remove" title="Remove (Delete)" aria-label={`Remove queued message ${index + 1}`} onClick={onRemove}>
              <Trash2 size={13} />
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={!editing.trim() && !files}>
              Save
            </button>
          </>
        )}
      </div>
    </li>
  );
}
