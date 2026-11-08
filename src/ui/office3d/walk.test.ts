// Who walks where in the building, without a renderer: an agent whose state moves it to another room walks there
// through the doors and along the hallway in one to two seconds, a new one walks in from the front door, one that
// leaves walks out of it, and nothing walks for reduced motion or when another profile's floor opens.
import { describe, expect, it } from "vitest";
import type { Desk, DeskState, Room } from "../../hermes/office";
import { EMPTY_FLOOR_MEMORY, PLAN, officeFloor, type BuildingRoom, type Floor } from "../../hermes/officeFloor";
import { createCrowd, startWalk, walkAt, walkPath, type Point } from "./walk";

const NOW = Date.UTC(2026, 10, 7, 12);

function chat(key: string, ...states: DeskState[]): Room {
  const desks = states.map((state, i) => ({ key: `${key} ${i}`, agent: { kind: "reply" }, name: `${key} ${i}`, state }) as Desk);
  return { key, profile: "default", chatId: key, title: key, desks };
}

/** Which room, or the hallway or outside, a point is in. */
function areaOf(p: Point): BuildingRoom | "hallway" | "outside" {
  for (const [r, b] of Object.entries(PLAN.rooms) as [BuildingRoom, { x: number; z: number; w: number; d: number }][])
    if (p.x >= b.x && p.x <= b.x + b.w && p.z >= b.z && p.z <= b.z + b.d) return r;
  return p.x > 12 ? "outside" : "hallway";
}

/** The rooms a walk passes through, in order, sampled along it. */
function route(from: Point, to: Point): string[] {
  const w = startWalk(from, { ...to, facing: 0 }, 0);
  const seen: string[] = [];
  for (let t = 0; t <= w.ms; t += w.ms / 200) {
    const a = areaOf(walkAt(w, t).spot);
    if (seen[seen.length - 1] !== a) seen.push(a);
  }
  return seen;
}

describe("A walk", () => {
  it("goes from the Workroom to the Waiting room out of one door, along the hallway and in at the other, in one to two seconds", () => {
    const desk = PLAN.seats.workroom[0];
    const mark = PLAN.seats.waiting[5];
    expect(route(desk, mark)).toEqual(["workroom", "hallway", "waiting"]);
    const path = walkPath(desk, mark);
    expect(path).toContainEqual({ x: PLAN.doors.workroom.x, z: 0 });
    expect(path).toContainEqual({ x: PLAN.doors.waiting.x, z: 0 });
    const w = startWalk(desk, mark, 0);
    expect(w.ms).toBeGreaterThanOrEqual(1000);
    expect(w.ms).toBeLessThanOrEqual(2000);
  });

  it("crosses the hallway between rooms on either side of it, and keeps to one room within it", () => {
    expect(route(PLAN.seats.workroom[3], PLAN.seats.trouble[2])).toEqual(["workroom", "hallway", "trouble"]);
    expect(route(PLAN.seats.lounge[0], PLAN.outside)).toEqual(["lounge", "hallway", "outside"]);
    expect(walkPath(PLAN.seats.lounge[0], PLAN.seats.lounge[9])).toEqual([PLAN.seats.lounge[0], PLAN.seats.lounge[9]]);
  });

  it("moves at a steady pace, faces the way it goes, and arrives facing as its spot does", () => {
    const from = { x: 0, z: 0 };
    const to = { x: 6, z: 0, facing: Math.PI };
    const w = startWalk(from, to, 1000);
    expect(walkAt(w, 1000).spot.x).toBeCloseTo(0);
    expect(walkAt(w, 1000 + w.ms / 2).spot.x).toBeCloseTo(3);
    expect(walkAt(w, 1000 + w.ms / 2).spot.facing).toBeCloseTo(Math.PI / 2);
    expect(walkAt(w, 1000 + w.ms)).toMatchObject({ spot: to, done: true });
  });
});

describe("The crowd", () => {
  const floorOf = (rooms: Room[], memory = EMPTY_FLOOR_MEMORY): Floor => officeFloor(rooms, memory, NOW);

  it("walks an agent that needs approval from the Workroom to the Waiting room, and only while it walks", () => {
    const crowd = createCrowd();
    const working = floorOf([chat("a", "running")]);
    crowd.set(working.characters, "default", 0, true);
    expect(crowd.at(0)).toMatchObject({ walking: false, placed: [{ key: "a 0", pose: "typing" }] });

    const asking = floorOf([chat("a", "approval")], working.memory);
    crowd.set(asking.characters, "default", 100, true);
    const mid = crowd.at(900);
    expect(mid.walking).toBe(true);
    expect(mid.placed[0].pose).toBe("walking");
    expect(areaOf(mid.placed[0].spot)).toBe("hallway");

    const there = crowd.at(100 + 2000);
    expect(there.walking).toBe(false);
    expect(there.placed[0]).toMatchObject({ pose: "hand-up", spot: asking.characters[0].spot });
  });

  it("walks an agent that leaves the floor out of the front door, and one that comes back in from it", () => {
    const crowd = createCrowd();
    const two = floorOf([chat("a", "unread"), chat("b", "running")]);
    crowd.set(two.characters, "default", 0, true);
    const one = floorOf([chat("b", "running")], two.memory);
    crowd.set(one.characters, "default", 0, true);

    const leaving = crowd.at(500);
    expect(leaving.onFloor).toBe(1);
    expect(leaving.placed.map((p) => `${p.key} ${p.pose}`)).toEqual(["b 0 typing", "a 0 walking"]);
    const gone = crowd.at(2000);
    expect(gone.placed.map((p) => p.key)).toEqual(["b 0"]);
    expect(gone.walking).toBe(false);

    crowd.set(two.characters, "default", 3000, true);
    const back = crowd.at(3000);
    expect(back.placed.find((p) => p.key === "a 0")).toMatchObject({ pose: "walking", spot: { x: PLAN.outside.x, z: PLAN.outside.z } });
  });

  it("walks no one for reduced motion, or when another profile's floor opens", () => {
    const crowd = createCrowd();
    const working = floorOf([chat("a", "running")]);
    crowd.set(working.characters, "default", 0, false);
    crowd.set(floorOf([chat("a", "approval")], working.memory).characters, "default", 0, false);
    expect(crowd.at(10)).toMatchObject({ walking: false, placed: [{ pose: "hand-up" }] });

    crowd.set(working.characters, "default", 0, true);
    crowd.set(floorOf([chat("a", "approval")]).characters, "work", 0, true);
    expect(crowd.at(10)).toMatchObject({ walking: false, placed: [{ pose: "hand-up" }] });

    crowd.set(working.characters, "work", 0, true);
    expect(crowd.at(10).walking).toBe(true);
    crowd.stop();
    expect(crowd.at(10)).toMatchObject({ walking: false, placed: [{ pose: "typing" }] });
  });
});
