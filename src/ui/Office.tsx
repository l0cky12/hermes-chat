// The agent office (ADR 0077, ADR 0122, ADR 0161): every agent at work on this connection, in the design the owner
// picks. It opens from the rail in place of the chat panes; Escape, or picking a chat, goes back. An agent opens
// what it stands for: the chat's reply opens the chat, at its Approval card or failure, and a subagent opens in the
// chat's Subagents panel. Nothing here answers, approves, retries or starts anything. App mounts it only while it is
// open and the window can be seen.
import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { X } from "lucide-react";
import { officeTally, type Desk, type Room } from "../hermes/office";
import { ago, composing } from "./bits";
import { useLocale } from "../i18n/locale";
import { OfficeBuilding, type OfficeMemory } from "./OfficeBuilding";
import { OfficeCard } from "./OfficeCard";
import { OfficePlan } from "./OfficePlan";
import { OfficeBoard } from "./OfficeBoard";
import { DesignMenu, ProfileMenu, type OfficeDesign, type ProfileCount } from "./OfficeMenus";
import { STATE_ICON, STATE_LABEL, deskLabel } from "./officeText";
import { TONE, TONE_COLOR, waitsOrFailed } from "./officeZones";

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
  view: OfficeDesign;
  onView: (view: OfficeDesign) => void;
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
  const [scope, setScope] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  const shows: OfficeDesign = view === "building" && (listFor || noBuilding) ? "list" : view;
  const profileFilter = view === "building" ? undefined : scope;

  const counts = useMemo<ProfileCount[]>(() => {
    const names = [...new Set([profile, ...profiles, ...rooms.map((r) => r.profile)])].sort((a, b) => a.localeCompare(b));
    return names.map((name) => {
      const mine = rooms.filter((r) => r.profile === name);
      return {
        name,
        agents: mine.reduce((n, r) => n + r.desks.length, 0),
        needs: mine.reduce((n, r) => n + r.desks.filter(waitsOrFailed).length, 0),
      };
    });
  }, [rooms, profiles, profile]);
  const seen = profileFilter ? rooms.filter((r) => r.profile === profileFilter) : rooms;
  const oneProfile = profileFilter ?? (new Set(seen.map((r) => r.profile)).size > 1 ? undefined : (seen[0]?.profile ?? profile));
  const away = profileFilter ? rooms.filter((r) => r.profile !== profileFilter) : [];
  const chatsWaiting = away.filter((r) => r.desks.some((d) => TONE[d.state] === "attn")).length;
  const chatsFailed = away.filter((r) => r.desks.some((d) => d.state === "failed")).length;
  const elsewhere = [chatsWaiting && `${chatsWaiting} need${chatsWaiting === 1 ? "s" : ""} you`, chatsFailed && `${chatsFailed} failed`].filter(Boolean).join(", ");
  const card = picked ? seen.flatMap((r) => r.desks.map((d) => ({ room: r, desk: d }))).find((a) => a.desk.key === picked) : undefined;
  useEffect(() => {
    if (picked) root.current?.querySelector(`[data-desk="${CSS.escape(picked)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  const closeCard = () => {
    const key = picked;
    setPicked(undefined);
    if (key) root.current?.querySelector<HTMLElement>(`[data-desk="${CSS.escape(key)}"]`)?.focus();
  };

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
      else if (card) closeCard();
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

  const pick = (v: OfficeDesign) => {
    setListFor(false);
    setPicked(undefined);
    onView(v);
  };
  const { working, waiting, failed, desks: count } = officeTally(seen);
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
          {seen.length > 0 && <span className="inbox-note">{tally}</span>}
          {elsewhere && (
            <button type="button" className="office-elsewhere" title="Chats in other profiles. Show all profiles." onClick={() => setScope(undefined)}>
              {elsewhere} elsewhere
            </button>
          )}
          {!connected && <span className="inbox-note err">Not connected to Hermes: every agent is as last seen.</span>}
        </div>
        {view !== "building" && <ProfileMenu scope={scope} profile={profile} counts={counts} onScope={(p) => (setScope(p), setPicked(undefined))} />}
        <DesignMenu design={shows} noBuilding={noBuilding} onDesign={pick} />
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
      ) : shows === "list" && seen.length === 0 ? (
        <div className="empty-hint inbox-empty">No agent is at work. One shows here while a reply runs, waits for you or failed, and for each subagent it starts.</div>
      ) : shows === "list" ? (
        <ul className="inbox-list office-list" aria-label="Agents">
          {seen.map((r) => (
            <RoomList key={r.key} room={r} profile={oneProfile ?? ""} onOpen={open} />
          ))}
        </ul>
      ) : (
        <div className="office-stage">
          <div className="office-scroll">
            {seen.length === 0 && profileFilter ? (
              <p className="office-quiet">No agent is at work in {profileFilter}.</p>
            ) : shows === "plan" ? (
              <OfficePlan rooms={seen} profile={oneProfile} picked={card?.desk.key} onPick={(_r, d) => setPicked(d.key)} />
            ) : (
              <OfficeBoard rooms={seen} profile={oneProfile} picked={card?.desk.key} onPick={(_r, d) => setPicked(d.key)} />
            )}
          </div>
          {card && (
            <OfficeCard
              room={card.room}
              desk={card.desk}
              profile={profile}
              color={TONE_COLOR[TONE[card.desk.state]]}
              onOpen={() => open(card.room, card.desk)}
              onClose={closeCard}
            />
          )}
        </div>
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
