// How agents walk across the building (ADR 0089): out of a room by its door, along the hallway, in by the other room's
// door, in one to two seconds; in from the front door, and out of it on the way home. Plain numbers from the floor
// plan, no three.js, so tests decide who walks where.
import { PLAN, type BuildingRoom, type Character, type Spot } from "../../hermes/officeFloor";
import type { Placed } from "./figures";

export type Point = { x: number; z: number };
export type Walk = { path: Point[]; start: number; ms: number; length: number; facing: number };

/** Metres a second. A walk across the building takes about a second and a half. */
const SPEED = 13;
const MIN_MS = 1000;
const MAX_MS = 2000;
/** A walk within one room is short, and may take less than a second. */
const MIN_MS_IN_ROOM = 400;
/** How far inside its door a room's route starts, so an agent walks through the doorway, not along the wall. */
const INSIDE = 0.7;

type Area = BuildingRoom | "hallway" | "outside";

function areaOf(p: Point): Area {
  for (const [r, b] of Object.entries(PLAN.rooms) as [BuildingRoom, (typeof PLAN.rooms)[BuildingRoom]][]) if (p.x >= b.x && p.x <= b.x + b.w && p.z >= b.z && p.z <= b.z + b.d) return r;
  return p.x > PLAN.hallway.x + PLAN.hallway.w ? "outside" : "hallway";
}

/** From a room to the middle of the hallway, through its door. Nothing from the hallway or outside. */
function viaDoor(area: Area): Point[] {
  if (area === "hallway" || area === "outside") return [];
  const door = PLAN.doors[area];
  const into = door.z <= PLAN.hallway.z ? -INSIDE : INSIDE;
  return [{ x: door.x, z: door.z + into }, { x: door.x, z: PLAN.hallway.z + PLAN.hallway.d / 2 }];
}

/** The route from `from` to `to`: straight within one room or the hallway, otherwise through the doors and hallway. */
export function walkPath(from: Point, to: Point): Point[] {
  const a = areaOf(from);
  const b = areaOf(to);
  const path = a === b ? [from, to] : [from, ...viaDoor(a), ...viaDoor(b).reverse(), to];
  return path.filter((p, i) => i === 0 || Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z) > 0.01);
}

const lengthOf = (path: readonly Point[]) => path.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z) : 0), 0);

/** A walk from `from` to the spot `to`, starting at `start` (ms), ending facing as the spot does. */
export function startWalk(from: Point, to: Spot, start: number): Walk {
  const path = walkPath(from, to);
  const length = lengthOf(path);
  const least = areaOf(from) === areaOf(to) ? MIN_MS_IN_ROOM : MIN_MS;
  return { path, start, length, ms: Math.min(MAX_MS, Math.max(least, (length / SPEED) * 1000)), facing: to.facing };
}

/**
 * Where a walk is at time `t`: on its route, facing the way it goes, at constant speed. `stride` grows with the
 * distance walked, for swinging arms. `done` once it has arrived, facing as its spot does.
 */
export function walkAt(w: Walk, t: number): { spot: Spot; stride: number; done: boolean } {
  const end = w.path[w.path.length - 1];
  if (t >= w.start + w.ms || w.length === 0) return { spot: { x: end.x, z: end.z, facing: w.facing }, stride: 0, done: true };
  const k = Math.max(0, (t - w.start) / w.ms);
  let left = k * w.length;
  for (let i = 1; i < w.path.length; i++) {
    const a = w.path[i - 1];
    const b = w.path[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= seg || i === w.path.length - 1) {
      const f = seg ? Math.min(1, left / seg) : 1;
      return { spot: { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, facing: Math.atan2(b.x - a.x, b.z - a.z) }, stride: k * w.length * 3, done: false };
    }
    left -= seg;
  }
  return { spot: { x: end.x, z: end.z, facing: w.facing }, stride: 0, done: true };
}

export type Crowd = {
  /**
   * The floor of `profile` at `t`. Each agent that moved walks from where it is to its new spot, a new one walks in from
   * the front door, and one no longer there walks out of it. A floor of another profile, or `moves` off, puts everyone
   * at their spot at once.
   */
  set(characters: readonly Character[], profile: string, t: number, moves: boolean): void;
  /** Every walk ends: each agent is at its spot, and those walking out are gone. */
  stop(): void;
  /** Every agent where it is at `t`: the floor's first, then those walking out. Walks that arrived end. */
  at(t: number): { placed: Placed[]; onFloor: number; walking: boolean };
};

export function createCrowd(): Crowd {
  let floor: readonly Character[] | undefined;
  let floorOf: string | undefined;
  const walking = new Map<string, Walk>();
  const leaving = new Map<string, { who: Character; walk: Walk }>();
  const whereIs = (key: string, t: number): Point | undefined => {
    const w = walking.get(key) ?? leaving.get(key)?.walk;
    return w ? walkAt(w, t).spot : floor?.find((c) => c.key === key)?.spot;
  };
  const along = (c: Character, w: Walk | undefined, t: number): Placed | undefined => {
    if (!w) return c;
    const now = walkAt(w, t);
    return now.done ? undefined : { ...c, pose: "walking", spot: now.spot, stride: now.stride };
  };
  return {
    set(characters, profile, t, moves) {
      if (!moves || profile !== floorOf || !floor) {
        walking.clear();
        leaving.clear();
      } else {
        const stays = new Set(characters.map((c) => c.key));
        for (const c of floor) {
          if (stays.has(c.key)) continue;
          leaving.set(c.key, { who: c, walk: startWalk(whereIs(c.key, t)!, { ...PLAN.outside, facing: Math.PI / 2 }, t) });
          walking.delete(c.key);
        }
        for (const c of characters) {
          const from = whereIs(c.key, t) ?? PLAN.outside;
          leaving.delete(c.key);
          if (Math.hypot(from.x - c.spot.x, from.z - c.spot.z) > 0.05) walking.set(c.key, startWalk(from, c.spot, t));
          else walking.delete(c.key);
        }
      }
      floor = characters;
      floorOf = profile;
    },
    stop() {
      walking.clear();
      leaving.clear();
    },
    at(t) {
      const placed = (floor ?? []).map((c) => along(c, walking.get(c.key), t) ?? c);
      for (const [key, w] of walking) if (walkAt(w, t).done) walking.delete(key);
      for (const [key, l] of leaving) {
        const out = along(l.who, l.walk, t);
        if (out) placed.push(out);
        else leaving.delete(key);
      }
      return { placed, onFloor: floor?.length ?? 0, walking: walking.size + leaving.size > 0 };
    },
  };
}
