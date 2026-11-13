// The office as a floor plan (ADR 0161).
import { useId } from "react";
import type { Desk, Room } from "../hermes/office";
import { ago } from "./bits";
import { useLocale } from "../i18n/locale";
import { STATE_ICON, STATE_LABEL, deskLabel } from "./officeText";
import { PLAN_ZONES, TONE, desksIn } from "./officeZones";

const MAX_INDENT = 4;
const INDENT_PX = 14;

export type OfficeDesignProps = {
  rooms: Room[];
  /** The one profile every agent shown is in, which they then don't repeat; undefined: each agent names its profile. */
  profile?: string;
  /** The agent whose card is open. */
  picked?: string;
  onPick: (room: Room, desk: Desk) => void;
};

export function OfficePlan({ rooms, profile, picked, onPick }: OfficeDesignProps) {
  return (
    <div className="plan" role="group" aria-label="Floor plan">
      {PLAN_ZONES.map((z) => {
        const pods = rooms.map((r) => ({ room: r, desks: desksIn(r, z.room) })).filter((p) => p.desks.length);
        return <PlanRoom key={z.room} zone={z.room} label={z.label} pods={pods} profile={profile} picked={picked} onPick={onPick} />;
      })}
    </div>
  );
}

function PlanRoom({
  zone,
  label,
  pods,
  profile,
  picked,
  onPick,
}: {
  zone: string;
  label: string;
  pods: { room: Room; desks: Desk[] }[];
  profile?: string;
  picked?: string;
  onPick: (room: Room, desk: Desk) => void;
}) {
  const headId = useId();
  const count = pods.reduce((n, p) => n + p.desks.length, 0);
  return (
    <section className={`plan-room plan-${zone}${count ? " occupied" : ""}`} aria-labelledby={headId}>
      <h3 id={headId} className="plan-room-head">
        <span>{label}</span>
        <span className="plan-room-count">{count}</span>
      </h3>
      {count === 0 ? (
        <p className="plan-empty">Nobody</p>
      ) : (
        <div className="plan-pods">
          {pods.map(({ room, desks }) =>
            desks.length === 1 && desks[0].agent.kind === "reply" ? (
              <div key={room.key} className="plan-pod solo">
                <Workstation room={room} desk={desks[0]} profile={profile} on={picked === desks[0].key} onPick={onPick} solo />
              </div>
            ) : (
              <div key={room.key} className="plan-pod">
                <div className="plan-pod-title">
                  <span className="plan-pod-name">{room.title}</span>
                  {room.profile !== profile && <span className="plan-pod-profile">{room.profile}</span>}
                </div>
                {desks.map((d) => (
                  <Workstation key={d.key} room={room} desk={d} profile={profile} on={picked === d.key} onPick={onPick} />
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function Workstation({
  room,
  desk: d,
  profile,
  on,
  onPick,
  solo,
}: {
  room: Room;
  desk: Desk;
  profile?: string;
  on: boolean;
  onPick: (room: Room, desk: Desk) => void;
  solo?: boolean;
}) {
  const l = useLocale();
  const Icon = STATE_ICON[d.state];
  const indent = d.agent.kind === "subagent" ? Math.min(d.agent.depth + 1, MAX_INDENT) : 0;
  return (
    <button
      className={`plan-desk${on ? " on" : ""}${d.stale ? " is-stale" : ""}`}
      data-desk={d.key}
      data-tone={TONE[d.state]}
      data-state={d.state}
      style={indent > 0 ? { marginLeft: `${indent * INDENT_PX}px` } : undefined}
      aria-label={deskLabel(room, d, profile ?? "")}
      aria-pressed={on}
      onClick={() => onPick(room, d)}
    >
      <svg className="plan-screen" width="24" height="20" viewBox="0 0 24 20" aria-hidden>
        <rect x="0.5" y="0.5" width="23" height="14" rx="2.5" />
        <path d="M8 19.5h8M12 15v4.5" />
      </svg>
      <span className="plan-desk-text">
        <span className="plan-desk-head">
          <span className="plan-desk-name">{solo ? room.title : d.agent.kind === "reply" ? "Reply" : d.name}</span>
          {solo && room.profile !== profile && <span className="plan-pod-profile">{room.profile}</span>}
        </span>
        <span className="plan-desk-state">
          <Icon size={11} aria-hidden />
          <span className="plan-desk-words">
            {STATE_LABEL[d.state]}
            {d.stale && " · as last seen"}
          </span>
          {!!d.doing?.at && <span className="plan-desk-time">· {ago(l, d.doing.at, "now")}</span>}
        </span>
      </span>
    </button>
  );
}
