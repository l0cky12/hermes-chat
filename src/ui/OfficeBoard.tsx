// The office as a board (ADR 0161).
import type { Room } from "../hermes/office";
import { ROOM_OF } from "../hermes/officeFloor";
import { ago } from "./bits";
import { useLocale } from "../i18n/locale";
import { STATE_ICON, STATE_SHORT, deskLabel } from "./officeText";
import { BOARD_ZONES, TONE, anyWaitsOrFailed, desksIn } from "./officeZones";
import type { OfficeDesignProps } from "./OfficePlan";

const working = (r: Room) => r.desks.some((d) => ROOM_OF[d.state] === "workroom");
const LANE_TIERS = [anyWaitsOrFailed, working, () => true];
const tier = (r: Room) => LANE_TIERS.findIndex((inTier) => inTier(r));

export function OfficeBoard({ rooms, profile, picked, onPick }: OfficeDesignProps) {
  const lanes = [...rooms].sort((a, b) => tier(a) - tier(b));
  const counts = BOARD_ZONES.map((z) => rooms.reduce((n, r) => n + desksIn(r, z.room).length, 0));
  return (
    <div className="board" role="table" aria-label="Board">
      <div className="board-head" role="row">
        <span role="columnheader" className="board-col-chat">
          Chat
        </span>
        {BOARD_ZONES.map((z, i) => (
          <span key={z.room} role="columnheader" className={`board-col board-${z.room}${counts[i] ? " occupied" : ""}`}>
            {z.label} <span className="board-count">{counts[i]}</span>
          </span>
        ))}
      </div>
      {lanes.length === 0 && <p className="board-empty">No agent is at work.</p>}
      {lanes.map((r) => (
        <Lane key={r.key} room={r} profile={profile} picked={picked} onPick={onPick} />
      ))}
    </div>
  );
}

function Lane({ room, profile, picked, onPick }: { room: Room; profile?: string; picked?: string; onPick: OfficeDesignProps["onPick"] }) {
  const l = useLocale();
  return (
    <div className={`board-lane${room.desks.some((d) => TONE[d.state] === "attn") ? " needs" : anyWaitsOrFailed(room) ? " failed" : ""}`} role="row">
      <span role="rowheader" className="board-chat">
        <span className="board-chat-name">{room.title}</span>
        {room.profile !== profile && <span className="board-chat-profile">{room.profile}</span>}
      </span>
      {BOARD_ZONES.map((z) => (
        <span key={z.room} role="cell" className="board-cell" data-zone={z.label}>
          {desksIn(room, z.room).map((d) => {
            const Icon = STATE_ICON[d.state];
            return (
              <button
                key={d.key}
                className={`board-chip${picked === d.key ? " on" : ""}${d.stale ? " is-stale" : ""}`}
                data-desk={d.key}
                data-tone={TONE[d.state]}
                data-state={d.state}
                aria-label={deskLabel(room, d, profile ?? "")}
                aria-pressed={picked === d.key}
                onClick={() => onPick(room, d)}
              >
                <Icon size={12} aria-hidden />
                {d.agent.kind === "subagent" && <span className="board-chip-name">{d.name}</span>}
                <span className="board-chip-state">
                  {STATE_SHORT[d.state]}
                  {d.stale && ", as last seen"}
                </span>
                {d.agent.kind === "reply" && !!d.doing?.at && <span className="board-chip-time">{ago(l, d.doing.at, "now")}</span>}
              </button>
            );
          })}
        </span>
      ))}
    </div>
  );
}
