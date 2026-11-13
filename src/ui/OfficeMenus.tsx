// The office header's two menus (ADR 0161).
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, Users } from "lucide-react";
import type { OfficeView } from "../hermes/uiPrefs";
import { useDismiss, useReturnFocus } from "./bits";

export type OfficeDesign = Exclude<OfficeView, "off">;

export const DESIGNS: readonly {
  value: OfficeDesign;
  label: string;
  hint: string;
  sketch: ReactNode;
}[] = [
  {
    value: "plan",
    label: "Floor plan",
    hint: "Rooms by state, each agent at a desk",
    sketch: (
      <>
        <rect x="1" y="1" width="38" height="26" rx="2" />
        <path d="M20 1v10M20 15v12M1 14h8M13 14h26" />
        <rect className="fill" x="4" y="4" width="5" height="3" />
        <rect className="fill" x="23" y="4" width="5" height="3" />
        <rect className="fill" x="30" y="4" width="5" height="3" />
        <rect className="fill" x="23" y="18" width="5" height="3" />
      </>
    ),
  },
  {
    value: "board",
    label: "Board",
    hint: "A row per chat, a column per state",
    sketch: (
      <>
        <rect x="1" y="1" width="38" height="26" rx="2" />
        <path d="M12 1v26M19 1v26M26 1v26M33 1v26M1 7h38M1 14h38M1 21h38" />
        <rect className="fill" x="20" y="9" width="5" height="3" />
        <rect className="fill" x="13" y="16" width="5" height="3" />
        <rect className="fill" x="34" y="23" width="4" height="2" />
      </>
    ),
  },
  {
    value: "list",
    label: "List",
    hint: "Rows grouped by chat",
    sketch: (
      <>
        <rect x="1" y="1" width="38" height="26" rx="2" />
        <path d="M5 7h18M8 12h24M8 17h20M5 22h16" />
      </>
    ),
  },
  {
    value: "building",
    label: "3D building",
    hint: "The original low-poly 3D office",
    sketch: (
      <>
        <path d="M4 18l16-8 16 8-16 8z" />
        <path d="M4 18v-3l16-8 16 8v3" />
      </>
    ),
  },
];

function moveMenuFocus(e: KeyboardEvent<HTMLElement>, selector: string) {
  const step = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 }[e.key];
  if (step === undefined || (e.target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End"))) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const at = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  e.stopPropagation();
  (e.key === "Home" ? items[0] : e.key === "End" ? items.at(-1) : items[at < 0 ? 0 : (at + step + items.length) % items.length])?.focus();
}

function Popover({ label, button, className, children }: { label: string; button: ReactNode; className: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(root, open, close);
  return (
    <div
      ref={root}
      className={`office-pop ${className}`}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        close();
      }}
    >
      <button type="button" className="office-pop-btn" aria-haspopup="true" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {button}
        <ChevronDown size={13} className="office-pop-chev" aria-hidden />
      </button>
      {open && children(close)}
    </div>
  );
}

/** `noBuilding`: why this computer can't draw the 3D building, which then can't be picked. */
export function DesignMenu({ design, noBuilding, onDesign }: { design: OfficeDesign; noBuilding?: string; onDesign: (d: OfficeDesign) => void }) {
  const now = DESIGNS.find((d) => d.value === design)!;
  return (
    <Popover
      label={`Office design: ${now.label}`}
      className="office-design"
      button={
        <>
          <svg className="office-sketch small" viewBox="0 0 40 28" aria-hidden>
            {now.sketch}
          </svg>
          <span className="office-pop-label">{now.label}</span>
        </>
      }
    >
      {(close) => <DesignItems design={design} noBuilding={noBuilding} onDesign={(d) => (onDesign(d), close())} />}
    </Popover>
  );
}

function DesignItems({ design, noBuilding, onDesign }: { design: OfficeDesign; noBuilding?: string; onDesign: (d: OfficeDesign) => void }) {
  useReturnFocus();
  return (
    <div className="menu office-menu" role="menu" aria-label="Office design" onKeyDown={(e) => moveMenuFocus(e, '[role="menuitemradio"]:not(:disabled)')}>
      {DESIGNS.map((d) => {
        const off = d.value === "building" ? noBuilding : undefined;
        return (
          <button
            key={d.value}
            className="menu-item office-design-item"
            role="menuitemradio"
            aria-checked={d.value === design}
            disabled={!!off}
            autoFocus={d.value === design}
            onClick={() => onDesign(d.value)}
          >
            <svg className="office-sketch" viewBox="0 0 40 28" aria-hidden>
              {d.sketch}
            </svg>
            <span className="office-design-text">
              <span className="office-design-name">{d.label}</span>
              <span className="office-design-hint">{off ?? d.hint}</span>
            </span>
            {d.value === design && <Check size={14} className="office-design-check" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

export type ProfileCount = { name: string; agents: number; needs: number };

/** `scope`: the profile shown, or undefined for all of them. */
export function ProfileMenu({ scope, profile, counts, onScope }: { scope?: string; profile: string; counts: ProfileCount[]; onScope: (p?: string) => void }) {
  const total = counts.reduce((n, c) => n + c.agents, 0);
  return (
    <Popover
      label={`Profiles shown: ${scope ?? "All profiles"}`}
      className="office-scope"
      button={
        <>
          <Users size={13} aria-hidden />
          <span className="office-pop-label">{scope ?? "All profiles"}</span>
        </>
      }
    >
      {(close) => <ProfileItems scope={scope} profile={profile} counts={counts} total={total} onScope={(p) => (onScope(p), close())} />}
    </Popover>
  );
}

function ProfileItems({ scope, profile, counts, total, onScope }: { scope?: string; profile: string; counts: ProfileCount[]; total: number; onScope: (p?: string) => void }) {
  useReturnFocus();
  const [filter, setFilter] = useState("");
  const match = counts.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const needs = counts.reduce((n, c) => n + c.needs, 0);
  const busy = match.filter((c) => c.agents);
  const quiet = match.filter((c) => !c.agents);
  const shown = [...busy, ...quiet];
  const row = (c: ProfileCount) => (
    <button
      key={c.name}
      className={`menu-item office-scope-item${c.agents ? "" : " quiet"}`}
      role="option"
      aria-selected={scope === c.name}
      autoFocus={counts.length <= 6 && scope === c.name}
      onClick={() => onScope(c.name)}
    >
      <span className="office-scope-name">
        {c.name}
        {c.name === profile && <span className="office-scope-open"> · open</span>}
      </span>
      {c.needs > 0 && <Needs n={c.needs} />}
      <span className="office-scope-count">{c.agents || ""}</span>
      <Check size={14} className="office-scope-check" style={{ visibility: scope === c.name ? undefined : "hidden" }} aria-hidden />
    </button>
  );
  return (
    <div className="menu office-menu office-scope-menu" role="listbox" aria-label="Profiles" onKeyDown={(e) => moveMenuFocus(e, '[role="option"]')}>
      {counts.length > 6 && (
        <input
          className="profile-filter"
          autoFocus
          placeholder="Filter profiles"
          aria-label="Filter profiles"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !filter.trim() || !shown[0]) return;
            e.preventDefault();
            onScope(shown[0].name);
          }}
        />
      )}
      <button className="menu-item office-scope-item" role="option" aria-selected={!scope} autoFocus={counts.length <= 6 && !scope} onClick={() => onScope(undefined)}>
        <span className="office-scope-name">All profiles</span>
        {needs > 0 && <Needs n={needs} />}
        <span className="office-scope-count">{total}</span>
        <Check size={14} className="office-scope-check" style={{ visibility: scope ? "hidden" : undefined }} aria-hidden />
      </button>
      <div className="menu-sep" />
      <div className="office-scope-list">
        {busy.map(row)}
        {quiet.length > 0 && (
          <div className="menu-heading" role="presentation">
            Quiet · {quiet.length}
          </div>
        )}
        {quiet.map(row)}
        {shown.length === 0 && <div className="profile-hint">No profile matches.</div>}
      </div>
    </div>
  );
}

const Needs = ({ n }: { n: number }) => (
  <span className="office-scope-needs" title={`${n} need${n === 1 ? "s" : ""} you or failed`}>
    <CircleAlert size={12} aria-hidden />
    {n}
  </span>
);
