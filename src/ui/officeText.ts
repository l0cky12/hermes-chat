// What the office says about an agent, the same in every design (ADR 0077, ADR 0122, ADR 0161): its state in words and
// as an icon, and its accessible name.
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleStop,
  Clock,
  Coffee,
  Hourglass,
  Loader,
  MessageCircleQuestion,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { Desk, DeskState, Room } from "../hermes/office";

export const STATE_LABEL: Record<DeskState, string> = {
  queued: "Queued",
  running: "Running",
  handedOff: "Waiting on handed-off work",
  approval: "Waiting for your approval",
  failed: "Failed",
  uncertain: "May not have sent",
  completed: "Finished",
  unread: "New, not read yet",
  stopped: "Stopped",
  ended: "Ended, Hermes didn't say how",
  unknown: "Not known yet",
  idle: "Not running",
};

export const STATE_SHORT: Record<DeskState, string> = {
  queued: "Queued",
  running: "Running",
  handedOff: "Handed off",
  approval: "Approval",
  failed: "Failed",
  uncertain: "May not have sent",
  completed: "Finished",
  unread: "Unread",
  stopped: "Stopped",
  ended: "Ended",
  unknown: "Not known",
  idle: "Not running",
};

export const STATE_ICON: Record<DeskState, LucideIcon> = {
  queued: Clock,
  running: Loader,
  handedOff: Hourglass,
  approval: ShieldAlert,
  failed: CircleAlert,
  uncertain: MessageCircleQuestion,
  completed: CircleCheck,
  unread: CircleDot,
  stopped: CircleStop,
  ended: CircleDashed,
  unknown: CircleHelp,
  idle: Coffee,
};

/** The subagent that started a subagent, when it is in the office too. */
export function parentOf(room: Room, d: Desk): Desk | undefined {
  const id = d.agent.kind === "subagent" ? d.agent.parent : undefined;
  return id && room.desks.find((p) => p.agent.kind === "subagent" && p.agent.id === id);
}

/** What an agent says to a screen reader, the same in either view. */
export function deskLabel(room: Room, d: Desk, profile: string): string {
  const parent = parentOf(room, d);
  const where = `${parent ? `started by “${parent.name}”, ` : ""}in “${room.title}”${room.profile === profile ? "" : `, profile ${room.profile}`}`;
  return [`${d.name}, ${STATE_LABEL[d.state]}${d.stale ? ", as last seen" : ""}, ${where}.`, d.doing?.text, d.stale].filter(Boolean).join(" ");
}
