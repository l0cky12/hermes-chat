// The office's building (ADR 0089): where each agent `officeRooms` lists stands on the floor. Its room comes from its
// state, its seat from the floor plan, its color from its chat's team. Worked out here, in plain data, so tests decide
// it without WebGL; the 3D layer (ui/office3d) only draws what this returns, furniture included, from the same plan.
import type { Desk, DeskState, Room } from "./office";

/** The building's four rooms. A chat is a `Room` in office.ts; these are the rooms of the building itself. */
export type BuildingRoom = "workroom" | "waiting" | "trouble" | "lounge";

/** Which room an agent is in, by its state. A new `DeskState` doesn't compile until it has a room. */
export const ROOM_OF: Record<DeskState, BuildingRoom> = {
  running: "workroom",
  queued: "workroom",
  // With its team: the team's dispatched work is what runs. The Waiting room is for waiting on the owner.
  waiting: "workroom",
  approval: "waiting",
  uncertain: "waiting",
  failed: "trouble",
  completed: "lounge",
  unread: "lounge",
  stopped: "lounge",
  ended: "lounge",
  idle: "lounge",
  unknown: "lounge",
};

/** How an agent is posed: at a desk typing, or seated there waiting, standing at the Workroom door, hand up, slumped at a desk, on a couch. */
export type Pose = "typing" | "seated" | "door" | "hand-up" | "slumped" | "couch";

const POSE_IN: Record<BuildingRoom, Pose> = { workroom: "typing", waiting: "hand-up", trouble: "slumped", lounge: "couch" };

/** A place on the floor, in metres from the building's centre; `facing` turns about the vertical, 0 facing +z. */
export type Spot = { x: number; z: number; facing: number };
export type Bounds = { x: number; z: number; w: number; d: number };

// The floor: 24 m by 16 m, a hallway across the middle, two rooms on each side of it.
const ROOMS: Record<BuildingRoom, Bounds> = {
  workroom: { x: -12, z: -8, w: 14, d: 7 },
  waiting: { x: 2, z: -8, w: 10, d: 7 },
  trouble: { x: -12, z: 1, w: 10, d: 7 },
  lounge: { x: -2, z: 1, w: 14, d: 7 },
};
const HALLWAY: Bounds = { x: -12, z: -1, w: 24, d: 2 };
/** Where the Workroom door is, and where agents queue for it: along the hallway, nearest first. */
const WORKROOM_DOOR: Spot = { x: -5, z: -1, facing: 0 };

/** Desks in the Workroom come in pods of four, facing in pairs. A team takes whole pods. */
export const POD_SIZE = 4;
const PODS = 10;

function workroomSeats(): Spot[] {
  const r = ROOMS.workroom;
  // Pods in a 5 by 2 grid, numbered from the door outward: the front row first, nearest the door first, so the first
  // team in sits where it is seen.
  const centres = Array.from({ length: PODS }, (_, p) => ({ x: r.x + 1.4 + 2.8 * (p % 5), z: r.z + 1.75 + 3.5 * Math.floor(p / 5) }));
  centres.sort((a, b) => b.z - a.z || Math.abs(a.x - WORKROOM_DOOR.x) - Math.abs(b.x - WORKROOM_DOOR.x) || a.x - b.x);
  const out: Spot[] = [];
  for (const { x: cx, z: cz } of centres)
    // Two at the back facing forward, two at the front facing back, each across a desk from another.
    for (const [dx, dz] of [[-0.6, -1], [0.6, -1], [-0.6, 1], [0.6, 1]] as const) out.push({ x: cx + dx, z: cz + dz * 1.05, facing: dz < 0 ? 0 : Math.PI });
  return out;
}

function grid(r: Bounds, cols: number, rows: number, facing: number, inset = 0): Spot[] {
  const out: Spot[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push({ x: r.x + (r.w / cols) * (i + 0.5), z: r.z + (r.d / rows) * (j + 0.5) + inset, facing });
  return out;
}

function loungeSeats(): Spot[] {
  const r = ROOMS.lounge;
  const out: Spot[] = [];
  // Four couches of four, facing the hallway.
  for (let c = 0; c < 4; c++) {
    const cx = r.x + 3.5 + 7 * (c % 2);
    const cz = r.z + 2 + 3.2 * Math.floor(c / 2);
    for (const dx of [-1.05, -0.35, 0.35, 1.05]) out.push({ x: cx + dx, z: cz, facing: Math.PI });
  }
  return out;
}

const doorLine = (n: number): Spot[] => Array.from({ length: n }, (_, i) => ({ x: WORKROOM_DOOR.x - 0.8 * i, z: 0, facing: 0 }));

/**
 * The floor plan: each room's walls and seats, the hallway, the Workroom door and the line outside it. Seats are the
 * places agents take; the 3D layer puts a desk, a couch or a standing mark at each one.
 */
export const PLAN = {
  rooms: ROOMS,
  hallway: HALLWAY,
  workroomDoor: WORKROOM_DOOR,
  seats: {
    workroom: workroomSeats(),
    waiting: grid(ROOMS.waiting, 4, 3, Math.PI),
    trouble: grid(ROOMS.trouble, 4, 2, Math.PI, -0.3),
    lounge: loungeSeats(),
  } satisfies Record<BuildingRoom, Spot[]>,
  door: doorLine(8),
} as const;

/** Team colors: the same in light and dark, apart from each other and from the walls in both. */
export const TEAM_COLORS = ["#4f8fe6", "#e0663f", "#3fae6a", "#c94fb6", "#e3b23c", "#2fb3b3", "#8a6fe0", "#d6455d", "#7fae3a", "#e08a3c", "#4a6fd0", "#b0763f"] as const;

/** Characters drawn on one floor at most; the rest show as "+N more", which opens List. */
export const FLOOR_CAP = 40;

/** An agent on the floor. `room` and `desk` are `officeRooms`'s, untouched, for the card and the accessible name. */
export type Character = {
  key: string;
  room: Room;
  desk: Desk;
  /** Index into TEAM_COLORS: its chat's team. */
  color: number;
  place: BuildingRoom;
  spot: Spot;
  pose: Pose;
  /** Greyed, frozen and labelled "as last seen" (ADR 0077). */
  stale: boolean;
};

/**
 * What the floor keeps from one call to the next, handed back by the caller: each team's color, the Workroom pods a
 * working team holds, and the desk each working agent sits at. Never written: each call returns a new one, or the same
 * one when nothing in it changed.
 */
export type FloorMemory = {
  readonly colors: ReadonlyMap<string, number>;
  readonly pods: ReadonlyMap<string, readonly number[]>;
  readonly desks: ReadonlyMap<string, number>;
};
export const EMPTY_FLOOR_MEMORY: FloorMemory = { colors: new Map(), pods: new Map(), desks: new Map() };

export type Floor = { characters: Character[]; more: number; memory: FloorMemory };

/** Which agents are drawn when not all fit: those that need the owner first, then those at work, then the rest. */
const KEEP_ORDER: readonly BuildingRoom[] = ["waiting", "trouble", "workroom", "lounge"];

const works = (s: DeskState) => s === "running" || s === "queued" || s === "waiting";
/** At a desk in the Workroom: typing, or seated while the work it handed off runs. */
const seated = (s: DeskState) => s === "running" || s === "waiting";

/**
 * Every agent in `rooms` on the one floor, in the room its state gives, at a seat, in its team's color. Pure: the same
 * rooms and memory give the same floor, and feeding the returned memory back with the same rooms changes nothing.
 * Characters come in the order `rooms` lists them.
 *
 * - A team keeps the pods it holds while any of its agents is running, waiting or queued; it takes the lowest free pods
 *   when it needs more, and lets them all go once none of its agents works. An agent keeps its desk while it runs.
 * - A running or waiting agent with no free desk in its team's pods, and every queued agent, stands in line at the
 *   Workroom door.
 * - A team keeps its color while it is on the floor; a new team takes the color fewest teams wear.
 * - At most `cap` characters, and no more than a room has seats. Those not drawn are counted in `more`.
 */
export function officeFloor(rooms: readonly Room[], memory: FloorMemory, cap = FLOOR_CAP): Floor {
  type Agent = { room: Room; desk: Desk; order: number; place: BuildingRoom };
  const agents: Agent[] = rooms.flatMap((room) => room.desks.map((desk) => ({ room, desk, place: ROOM_OF[desk.state], order: 0 })));
  agents.forEach((a, i) => (a.order = i));

  // Who is drawn: by room, those that need the owner first, each room up to its seats, all up to the cap.
  const lineOf = (a: Agent): BuildingRoom | "door" => (a.desk.state === "queued" ? "door" : a.place);
  const seatsAt = { ...PLAN.seats, door: PLAN.door };
  const used: Record<BuildingRoom | "door", number> = { workroom: 0, waiting: 0, trouble: 0, lounge: 0, door: 0 };
  const drawn = new Set<Agent>();
  const byNeed = [...agents].sort((a, b) => KEEP_ORDER.indexOf(a.place) - KEEP_ORDER.indexOf(b.place) || a.order - b.order);
  for (const a of byNeed) {
    if (drawn.size >= cap) break;
    // A running agent may yet stand at the door if its team has no desk for it; the door line counts it then.
    const at = lineOf(a);
    if (used[at] >= seatsAt[at].length) continue;
    used[at]++;
    drawn.add(a);
  }

  // Colors: kept while the team is on the floor; a new team takes the least worn.
  const colors = new Map<string, number>();
  for (const r of rooms) if (memory.colors.has(r.key)) colors.set(r.key, memory.colors.get(r.key)!);
  for (const r of rooms) {
    if (colors.has(r.key)) continue;
    const worn = TEAM_COLORS.map((_, i) => [...colors.values()].filter((c) => c === i).length);
    colors.set(r.key, worn.indexOf(Math.min(...worn)));
  }

  // Pods: a working team keeps what it holds, then teams in order take the lowest free pods they still need.
  const running = new Map<string, Agent[]>();
  for (const a of agents) if (drawn.has(a) && seated(a.desk.state)) running.set(a.room.key, [...(running.get(a.room.key) ?? []), a]);
  const pods = new Map<string, number[]>();
  const held = new Set<number>();
  for (const r of rooms) {
    const kept = memory.pods.get(r.key);
    if (!kept || !r.desks.some((d) => works(d.state))) continue;
    pods.set(r.key, [...kept]);
    kept.forEach((p) => held.add(p));
  }
  for (const r of rooms) {
    const need = Math.ceil((running.get(r.key)?.length ?? 0) / POD_SIZE);
    const mine = pods.get(r.key) ?? [];
    for (let p = 0; p < PODS && mine.length < need; p++) if (!held.has(p)) (mine.push(p), held.add(p));
    if (mine.length) pods.set(r.key, mine);
  }

  // Desks: each running agent keeps its desk if it is still in its team's pods; the others take the first free one.
  const desks = new Map<string, number>();
  const taken = new Set<number>();
  const mineOf = (key: string) => (pods.get(key) ?? []).flatMap((p) => Array.from({ length: POD_SIZE }, (_, i) => p * POD_SIZE + i));
  for (const [key, team] of running) {
    const mine = new Set(mineOf(key));
    for (const a of team) {
      const was = memory.desks.get(a.desk.key);
      if (was !== undefined && mine.has(was) && !taken.has(was)) (desks.set(a.desk.key, was), taken.add(was));
    }
  }
  for (const [key, team] of running)
    for (const a of team) {
      if (desks.has(a.desk.key)) continue;
      const free = mineOf(key).find((d) => !taken.has(d));
      if (free !== undefined) (desks.set(a.desk.key, free), taken.add(free));
    }

  // Spots: desks as assigned; the door line in order; the other rooms' seats in order.
  const next: Record<BuildingRoom | "door", number> = { workroom: 0, waiting: 0, trouble: 0, lounge: 0, door: 0 };
  const characters: Character[] = [];
  let more = agents.length - drawn.size;
  for (const a of agents) {
    if (!drawn.has(a)) continue;
    const desk = desks.get(a.desk.key);
    let spot: Spot | undefined;
    let pose: Pose = POSE_IN[a.place];
    if (desk !== undefined) {
      spot = PLAN.seats.workroom[desk];
      if (a.desk.state === "waiting") pose = "seated";
    } else if (a.place === "workroom") {
      spot = PLAN.door[next.door++];
      pose = "door";
    } else spot = PLAN.seats[a.place][next[a.place]++];
    // A running agent with no desk and a full line at the door isn't drawn.
    if (!spot) {
      more++;
      continue;
    }
    characters.push({ key: a.desk.key, room: a.room, desk: a.desk, color: colors.get(a.room.key)!, place: a.place, spot, pose, stale: !!a.desk.stale });
  }

  return { characters, more, memory: same(memory, { colors, pods, desks }) };
}

/** `memory` itself when `next` holds the same, so a caller comparing memories sees no change. */
function same(memory: FloorMemory, next: FloorMemory): FloorMemory {
  const eq = <V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, is: (x: V, y: V) => boolean) =>
    a.size === b.size && [...a].every(([k, v]) => b.has(k) && is(v, b.get(k)!));
  const num = (x: number, y: number) => x === y;
  const list = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(memory.colors, next.colors, num) && eq(memory.pods, next.pods, list) && eq(memory.desks, next.desks, num) ? memory : next;
}
