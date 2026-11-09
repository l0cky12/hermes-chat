// The agent office (ADR 0077, ADR 0089): every agent at work on this connection, as a 3D building (OfficeBuilding.tsx)
// or as a list. It opens from the rail in place of the chat panes; Escape, or picking a chat, goes back. An agent opens
// what it stands for: the chat's reply opens the chat, at its Approval card or failure, and a subagent opens in the
// chat's Subagents panel. Nothing here answers, approves, retries or starts anything. App mounts it only while it is
// open and the window can be seen.
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { Building2, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleStop, Clock, Coffee, Hourglass, List, Loader, ShieldAlert, X } from "lucide-react";
import { officeTally, type Desk, type DeskState, type Room } from "../hermes/office";
import type { OfficeView } from "../hermes/uiPrefs";
import { ago, composing } from "./bits";
import { useLocale } from "../i18n/locale";
import { OfficeBuilding, type OfficeMemory } from "./OfficeBuilding";
import { STATE_LABEL, deskLabel } from "./officeText";

const STATE_ICON: Record<DeskState, typeof X> = {
  queued: Clock,
  running: Loader,
  handedOff: Hourglass,
  approval: ShieldAlert,
  failed: CircleAlert,
  uncertain: CircleHelp,
  completed: CircleCheck,
  unread: CircleDot,
  stopped: CircleStop,
  ended: CircleDashed,
  unknown: CircleHelp,
  idle: Coffee,
};

/**
 * `rooms`: from `officeRooms`. `view`: the building or a list, the owner's choice, kept by the caller. `leaving`: what
 * switching away from the shown profile leaves behind, asked about before an agent in another profile opens.
 */
export function Office({
  rooms,
  floorMemory,
  view,
  onView,
  server,
  profile,
  profiles = [],
  connected,
  leaving,
  onOpen,
  onClose,
}: {
  rooms: Room[];
  /** Who sits where in the building, kept by the app across the office's closes and minimizes. */
  floorMemory: RefObject<OfficeMemory>;
  view: Exclude<OfficeView, "off">;
  onView: (view: Exclude<OfficeView, "off">) => void;
  server: string;
  profile: string;
  /** The server's other profiles, as far as the app knows them: a floor each in the building. */
  profiles?: readonly string[];
  connected: boolean;
  leaving?: string;
  onOpen: (room: Room, desk: Desk) => void;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState<{ room: Room; desk: Desk }>();
  /** Why the building can't be drawn on this computer; List shows instead. */
  const [noBuilding, setNoBuilding] = useState<string>();
  /** "+N more" shows List for this visit, without changing the owner's choice. */
  const [listFor, setListFor] = useState(false);
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  const shows = view === "list" || listFor || noBuilding ? "list" : "building";

  const desks = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-desk]") ?? []);
  // Opening, and switching views, puts focus on the first agent, or on Close when there is none.
  useEffect(() => void (desks()[0] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus(), [shows]);
  // An agent with focus can go, as when its reply ends and its chat with it. Focus then goes to the agent now in its
  // place, or Close, rather than to the page, where the office's keys don't reach. Where the agent with focus is, is
  // read again after every change, since agents before it can go or move while it stays.
  const lastDesk = useRef<{ key: string; index: number }>(undefined);
  const remember = (all: HTMLButtonElement[], at: number) => {
    if (at >= 0) lastDesk.current = { key: all[at].dataset.desk!, index: at };
  };
  useEffect(() => {
    const all = desks();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at >= 0) return remember(all, at);
    const was = lastDesk.current;
    if (!was || (document.activeElement && document.activeElement !== document.body)) return;
    (all.find((d) => d.dataset.desk === was.key) ?? all[Math.min(was.index, all.length - 1)] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus();
  });
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const all = desks();
    remember(all, all.indexOf(e.target as HTMLButtonElement));
  };

  const open = (room: Room, desk: Desk) => (room.profile !== profile && leaving ? setAsking({ room, desk }) : onOpen(room, desk));
  // Staying puts focus back on the agent the question came from.
  const stay = () => {
    const key = asking?.desk.key;
    setAsking(undefined);
    if (key) root.current?.querySelector<HTMLElement>(`[data-desk="${CSS.escape(key)}"]`)?.focus();
  };

  // The arrow keys, Home and End move between agents in reading order, in either view; Escape goes back to the chats.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (asking) stay();
      else onClose();
      return;
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    const all = desks();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    (e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : all[at + step!])?.focus();
  };

  const pick = (v: Exclude<OfficeView, "off">) => {
    setListFor(false);
    onView(v);
  };
  const { working, waiting, failed, desks: count } = officeTally(rooms);
  const tally = [working && `${working} running`, waiting && `${waiting} waiting for you`, failed && `${failed} failed`, `${count} agent${count === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <section ref={root} className="office" aria-labelledby={headId} onKeyDown={onKeyDown} onFocus={onFocus}>
      <header className="office-head">
        <div className="inbox-heading">
          <h2 id={headId}>Office</h2>
          <span className="inbox-server" title="The server these agents run on">
            {server}
          </span>
        </div>
        <div className="office-fresh" role="status">
          {rooms.length > 0 && <span className="inbox-note">{tally}</span>}
          {!connected && <span className="inbox-note err">Not connected to Hermes: every agent is as last seen.</span>}
        </div>
        <div className="segmented office-views" role="group" aria-label="Show as">
          <button type="button" aria-pressed={shows === "building"} disabled={!!noBuilding} onClick={() => pick("building")}>
            <Building2 size={13} aria-hidden /> Building
          </button>
          <button type="button" aria-pressed={shows === "list"} onClick={() => pick("list")}>
            <List size={13} aria-hidden /> List
          </button>
        </div>
        <button className="icon-btn office-close" title="Back to the chats (Escape)" aria-label="Close the office" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {noBuilding && view === "building" && (
        <p className="office-fallback inbox-note" role="status">
          Showing the list: {noBuilding}
        </p>
      )}
      {asking && (
        <div className="confirm inbox-leave" role="alertdialog" aria-label={`Switch to ${asking.room.profile}?`}>
          <span>{leaving}</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={stay}>
              Stay
            </button>
            <button className="btn primary" onClick={() => onOpen(asking.room, asking.desk)}>
              Switch to {asking.room.profile}
            </button>
          </div>
        </div>
      )}
      {shows === "building" ? (
        <OfficeBuilding rooms={rooms} memory={floorMemory} profile={profile} profiles={profiles} onOpen={open} onFallback={setNoBuilding} onMore={() => setListFor(true)} />
      ) : rooms.length === 0 ? (
        <div className="empty-hint inbox-empty">No agent is at work. One shows here while a reply runs, waits for you or failed, and for each subagent it starts.</div>
      ) : (
        <ul className="inbox-list office-list" aria-label="Agents">
          {rooms.map((r) => (
            <RoomList key={r.key} room={r} profile={profile} onOpen={open} />
          ))}
        </ul>
      )}
      <p className="inbox-note office-foot">Subagents show for the chats opened on this connection since the app started.</p>
    </section>
  );
}

function RoomList({ room, profile, onOpen }: { room: Room; profile: string; onOpen: (room: Room, desk: Desk) => void }) {
  const l = useLocale();
  const nameId = useId();
  return (
    <li className="office-list-room">
      <h3 id={nameId} className="office-room-name">
        <span className="office-room-title">{room.title}</span>
        {room.profile !== profile && <span className="office-room-profile">{room.profile}</span>}
      </h3>
      <ul aria-labelledby={nameId}>
        {room.desks.map((d) => {
          const Icon = STATE_ICON[d.state];
          const depth = d.agent.kind === "subagent" ? d.agent.depth + 1 : 0;
          return (
            <li key={d.key} className={`inbox-row office-row state-${d.state}${d.stale ? " is-stale" : ""}`} style={{ paddingLeft: `${Math.min(depth, 4) * 12}px` }}>
              <button className="inbox-open" data-desk={d.key} aria-label={deskLabel(room, d, profile)} onClick={() => onOpen(room, d)}>
                <span className="inbox-line">
                  <span className="inbox-kind">
                    <Icon size={13} aria-hidden />
                    {STATE_LABEL[d.state]}
                    {d.stale && " · as last seen"}
                  </span>
                  {!!d.doing?.at && <span className="inbox-time">{ago(l, d.doing.at, "now")}</span>}
                </span>
                <span className="inbox-title">{d.name}</span>
                {d.doing && <span className="inbox-summary">{d.doing.text}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
