// The four places an agent can be in the office's flat designs (ADR 0161).
import type { Desk, DeskState, Room } from "../hermes/office";
import { ROOM_OF, type BuildingRoom } from "../hermes/officeFloor";

export type Zone = { room: BuildingRoom; label: string };

export const BOARD_ZONES: readonly Zone[] = [
  { room: "waiting", label: "Needs you" },
  { room: "workroom", label: "Working" },
  { room: "trouble", label: "Trouble" },
  { room: "lounge", label: "At rest" },
];

export const PLAN_ZONES: readonly Zone[] = ["waiting", "trouble", "workroom", "lounge"].map((r) => BOARD_ZONES.find((z) => z.room === r)!);

export type Tone = "work" | "attn" | "bad" | "ok" | "rest";
export const TONE: Record<DeskState, Tone> = {
  running: "work",
  queued: "work",
  handedOff: "work",
  approval: "attn",
  uncertain: "attn",
  failed: "bad",
  completed: "ok",
  unread: "rest",
  stopped: "rest",
  ended: "rest",
  idle: "rest",
  unknown: "rest",
};

export const TONE_COLOR: Record<Tone, string> = { work: "var(--accent)", attn: "var(--warn)", bad: "var(--bad)", ok: "var(--ok)", rest: "var(--line-3)" };

export const desksIn = (room: Room, zone: BuildingRoom): Desk[] => room.desks.filter((d) => ROOM_OF[d.state] === zone);

export const waitsOrFailed = (d: Desk) => TONE[d.state] === "attn" || d.state === "failed";

export const anyWaitsOrFailed = (room: Room) => room.desks.some(waitsOrFailed);
