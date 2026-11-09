// An agent's card in the office's building (ADR 0089): who it is, what it does and how long it has run, with Open chat,
// which goes where its row in List goes. Nothing else is done from here. It reads the agent from the office's
// current rooms on every render, so it follows the agent while open.
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Desk, Room } from "../hermes/office";
import { STATE_LABEL } from "./officeText";
import { ago } from "./bits";
import { useLocale } from "../i18n/locale";

/** A length of time in words: "under a minute", "12 min", "2 h 5 min". */
export function spanOf(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** How long it has run, in words, when that is known: a subagent's start, or how long Hermes said it took. */
function ran(desk: Desk, now: number): string | undefined {
  const d = desk.detail;
  if (d?.durationS !== undefined) return `Ran for ${spanOf(d.durationS * 1000)}`;
  if (d?.startedAt && (desk.state === "running" || desk.state === "queued")) return `Running for ${spanOf(now - d.startedAt)}`;
  return undefined;
}

export function OfficeCard({ room, desk, profile, color, onOpen, onClose }: { room: Room; desk: Desk; profile: string; color: string; onOpen: () => void; onClose: () => void }) {
  const l = useLocale();
  const headId = useId();
  const [now, setNow] = useState(Date.now);
  const open = useRef<HTMLButtonElement>(null);
  // Times on the card move on while it is open; the building draws nothing for it.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => open.current?.focus(), [desk.key]);

  const facts: [string, string | undefined][] = [
    ["Chat", room.title],
    ["Profile", room.profile === profile ? `${room.profile} (shown)` : room.profile],
    ["State", `${STATE_LABEL[desk.state]}${desk.stale ? ", as last seen" : ""}`],
    ["Goal", desk.detail?.goal],
    ["Doing now", desk.doing ? `${desk.doing.text}${desk.doing.at ? ` (${ago(l, desk.doing.at)})` : ""}` : undefined],
    ["Model", desk.detail?.model],
    ["Time", ran(desk, now) ?? (desk.doing?.at ? `Last heard ${ago(l, desk.doing.at)}` : undefined)],
  ];

  return (
    <section className="office-card" role="dialog" aria-labelledby={headId} style={{ borderTopColor: color }}>
      <header className="office-card-head">
        <h3 id={headId}>{desk.name}</h3>
        <button className="icon-btn" aria-label="Close the card" title="Close (Escape)" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {desk.stale && <p className="office-card-stale">{desk.stale}</p>}
      <dl className="office-card-facts">
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <button ref={open} className="btn primary" onClick={onOpen}>
        Open chat
      </button>
    </section>
  );
}
