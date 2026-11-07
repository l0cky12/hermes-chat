// The characters' meshes, without a renderer: each agent is drawn at the seat the floor gave it, as a person in its
// room's pose, and only typing arms move between frames. Positions are read back from the instance matrices, in the
// world and in metres, against what the furniture in building.ts makes them.
import { describe, expect, it, vi } from "vitest";
import { Color, InstancedMesh, Matrix4, Mesh, Vector3 } from "three";
import type { Desk, DeskState, Room } from "../../hermes/office";
import { EMPTY_FLOOR_MEMORY, FLOOR_CAP, TEAM_COLORS, officeFloor, type Character, type Pose } from "../../hermes/officeFloor";
import { FIGURE_SCALE } from "./building";
import { HAIR_COLORS, PANTS_COLORS, SKIN_TONES, buildFigures, lookOf } from "./figures";

function team(key: string, ...states: DeskState[]): Room {
  const desks = states.map((state, i) => ({ key: `${key} ${i}`, agent: { kind: "reply" }, name: `${key} ${i}`, state }) as Desk);
  return { key, profile: "default", chatId: key, title: key, desks };
}

const positionOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const SEAT_TOP = 0.42 * FIGURE_SCALE;
const DESK_TOP = 0.74 * FIGURE_SCALE;

/** One of every pose: a typing agent and one queued at the door, then one waiting, one failed and one finished. */
const MIXED = officeFloor([team("a", "running", "queued"), team("b", "approval", "failed", "completed")], EMPTY_FLOOR_MEMORY);

function drawn(characters: readonly Character[]) {
  const figures = buildFigures();
  figures.set(characters);
  const mesh = (name: string) => figures.group.getObjectByName(name) as InstancedMesh;
  const matrix = (name: string, i: number) => new Matrix4().fromArray(mesh(name).instanceMatrix.array, i * 16);
  const color = (name: string, i: number) => {
    const c = new Color();
    mesh(name).getColorAt(i, c);
    return c.getHex();
  };
  /** An instance's vertices, in the world. */
  const points = (name: string, i: number) => {
    const m = mesh(name);
    const at = m.geometry.getAttribute("position");
    const to = matrix(name, i);
    return Array.from({ length: at.count }, (_, k) => new Vector3().fromBufferAttribute(at, k).applyMatrix4(to));
  };
  const top = (name: string, i: number) => Math.max(...points(name, i).map((p) => p.y));
  const bottom = (name: string, i: number) => Math.min(...points(name, i).map((p) => p.y));
  /** The lowest point of a forearm's geometry along its length: the tip of the hand. */
  const handTip = (i: number) => {
    const m = mesh("forearm");
    m.geometry.computeBoundingBox();
    return new Vector3(0, m.geometry.boundingBox!.min.y, 0).applyMatrix4(matrix("forearm", i));
  };
  return { figures, mesh, matrix, color, points, top, bottom, handTip };
}

const indexOfPose = (characters: readonly Character[], pose: Pose) => characters.findIndex((c) => c.pose === pose);
/** How far ahead of a character's seat a point is, along the way it faces. */
const forward = (c: Character, p: Vector3) => (p.x - c.spot.x) * Math.sin(c.spot.facing) + (p.z - c.spot.z) * Math.cos(c.spot.facing);

describe("The office's characters", () => {
  it("stands each body at its own seat, over the floor plan's spot", () => {
    const floor = officeFloor([team("a", "running", "running", "running"), team("b", "approval", "failed", "completed", "queued")], EMPTY_FLOOR_MEMORY);
    const figures = buildFigures();
    figures.set(floor.characters);
    const [torso, head] = figures.pickable;
    expect([torso.name, head.name]).toEqual(["torso", "head"]);
    expect(torso.count).toBe(floor.characters.length);
    floor.characters.forEach((c, i) => {
      const m = new Matrix4();
      torso.getMatrixAt(i, m);
      const at = positionOf(m);
      // The torso hinges at the hip and leans with its pose, so it sits within a hand's width of its spot.
      expect(Math.hypot(at.x - c.spot.x, at.z - c.spot.z)).toBeLessThan(0.3);
      expect(at.y).toBeGreaterThan(0.3);
    });
    const places = floor.characters.map((_, i) => {
      const m = new Matrix4();
      torso.getMatrixAt(i, m);
      const p = positionOf(m);
      return `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    });
    expect(new Set(places).size).toBe(places.length);
    expect(figures.keyAt(2)).toBe("a 2");
  });

  it("draws every character as one head and torso, two of each limb part, and one head of hair unless bald", () => {
    const floor = officeFloor(Array.from({ length: 10 }, (_, t) => team(`t${t}`, "running", t % 2 ? "running" : "failed", "approval", "completed")), EMPTY_FLOOR_MEMORY);
    const n = floor.characters.length;
    expect(n).toBe(FLOOR_CAP);
    const { mesh, figures } = drawn(floor.characters);
    for (const part of ["torso", "head", "face"]) expect(mesh(part).count).toBe(n);
    for (const part of ["upper-arm", "forearm", "thigh", "shin", "shoe"]) expect(mesh(part).count).toBe(2 * n);
    const bald = floor.characters.filter((c) => lookOf(c.key).hair === "bald").length;
    expect(mesh("hair-short").count + mesh("hair-long").count + mesh("hair-bun").count).toBe(n - bald);
    // Every part is one mesh for all the characters, so what is drawn is a fixed list, not a list per person.
    const calls = figures.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.count > 0);
    expect(calls.length).toBeLessThanOrEqual(16);
  });

  describe("poses", () => {
    const { mesh, matrix, top, bottom, handTip } = drawn(MIXED.characters);
    const chars = MIXED.characters;
    const hip = (i: number) => positionOf(matrix("thigh", 2 * i));

    it.each(["door", "hand-up"] as const)("stands a %s agent on both feet, its head over its hips", (pose) => {
      const i = indexOfPose(chars, pose);
      expect(i).toBeGreaterThanOrEqual(0);
      for (const side of [0, 1]) {
        // A shoe's sole rests on the floor: touching it, never through it.
        expect(bottom("shoe", 2 * i + side)).toBeGreaterThanOrEqual(-0.001);
        expect(bottom("shoe", 2 * i + side)).toBeLessThan(0.02);
      }
      expect(positionOf(matrix("head", i)).y).toBeGreaterThan(hip(i).y + 0.5);
      expect(hip(i).y).toBeGreaterThan(0.8 * FIGURE_SCALE);
    });

    it.each(["typing", "slumped", "couch"] as const)("seats a %s agent with its hips on the seat and its feet on the floor", (pose) => {
      const i = indexOfPose(chars, pose);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(hip(i).y).toBeGreaterThanOrEqual(SEAT_TOP);
      expect(hip(i).y).toBeLessThan(SEAT_TOP + 0.15);
      for (const side of [0, 1]) {
        expect(bottom("shoe", 2 * i + side)).toBeGreaterThanOrEqual(-0.001);
        expect(bottom("shoe", 2 * i + side)).toBeLessThan(0.02);
      }
    });

    it("raises one hand above the head, with the '!' above that hand", () => {
      const i = indexOfPose(chars, "hand-up");
      const raised = Math.max(top("forearm", 2 * i), top("forearm", 2 * i + 1));
      const lowered = Math.min(top("forearm", 2 * i), top("forearm", 2 * i + 1));
      expect(raised).toBeGreaterThan(top("head", i));
      expect(lowered).toBeLessThan(positionOf(matrix("head", i)).y);
      // Only the waiting agent carries a '!', so its instance is the first.
      expect(mesh("bang").count).toBe(1);
      expect(bottom("dot", 0)).toBeGreaterThan(raised);
    });

    it("rests a typing agent's hands on the desk top, in front of its body", () => {
      const i = indexOfPose(chars, "typing");
      for (const side of [0, 1]) {
        const tip = handTip(2 * i + side);
        expect(Math.abs(tip.y - DESK_TOP)).toBeLessThan(0.12);
        expect(forward(chars[i], tip) - forward(chars[i], positionOf(matrix("torso", i)))).toBeGreaterThan(0.25);
      }
    });

    it("folds a failed agent forward, its head lower than a typing agent's and further ahead", () => {
      const t = indexOfPose(chars, "typing");
      const s = indexOfPose(chars, "slumped");
      const headT = positionOf(matrix("head", t));
      const headS = positionOf(matrix("head", s));
      expect(headS.y).toBeLessThan(headT.y - 0.2);
      expect(forward(chars[s], headS) - forward(chars[t], headT)).toBeGreaterThan(0.2);
      // Its forearms lie along the desk top.
      for (const side of [0, 1]) expect(Math.abs(handTip(2 * s + side).y - DESK_TOP)).toBeLessThan(0.12);
    });
  });

  describe("looks", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `chat${i} reply`);
    const rgb = (h: number) => [h >> 16, (h >> 8) & 255, h & 255];
    const distance = (a: number, b: number) => Math.hypot(...rgb(a).map((c, k) => c - rgb(b)[k]));

    it("is the same for the same key, in any run", () => {
      const a = drawn(MIXED.characters);
      const b = drawn(MIXED.characters);
      // No dice: the look comes from the key alone, so it is the same on the next launch. (three draws its object ids
      // from Math.random, which is why the spy goes up only once the meshes exist.)
      const random = vi.spyOn(Math, "random");
      for (const key of keys) expect(lookOf(key)).toEqual(lookOf(key));
      a.figures.set(MIXED.characters);
      expect(random).not.toHaveBeenCalled();
      random.mockRestore();
      MIXED.characters.forEach((_, i) => {
        for (const [part, at] of [["head", i], ["thigh", 2 * i]] as const) expect(a.color(part, at)).toBe(b.color(part, at));
      });
    });

    it("varies: forty keys are no clones of each other", () => {
      const looks = keys.map(lookOf);
      // 6 skins x 4 hair styles x 6 hair colors x 4 pants make 576 looks, so 40 draws collide a time or two at most.
      expect(new Set(looks.map((l) => JSON.stringify(l))).size).toBeGreaterThanOrEqual(25);
      expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThanOrEqual(4);
      expect(new Set(looks.map((l) => l.hair)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(looks.map((l) => l.hairColor)).size).toBeGreaterThanOrEqual(4);
      expect(new Set(looks.map((l) => l.pants)).size).toBeGreaterThanOrEqual(3);
    });

    it("keeps skin and pants apart from every team's shirt", () => {
      // Not merely unequal: a skin 25 steps of 255 off a shirt is a different color to the eye.
      for (const own of [...SKIN_TONES, ...PANTS_COLORS]) for (const shirt of TEAM_COLORS) expect(distance(own, parseInt(shirt.slice(1), 16))).toBeGreaterThan(25);
      for (const key of keys) {
        const look = lookOf(key);
        expect(SKIN_TONES).toContain(look.skin);
        expect(PANTS_COLORS).toContain(look.pants);
        expect(HAIR_COLORS).toContain(look.hairColor);
      }
    });

    it("dresses the torso and sleeves in the team's color and the head, hands and legs in the look's", () => {
      const { color } = drawn(MIXED.characters);
      const hex = (c: number | string) => new Color(c).getHex();
      MIXED.characters.forEach((c, i) => {
        const look = lookOf(c.key);
        expect(color("torso", i)).toBe(hex(TEAM_COLORS[c.color]));
        expect(color("upper-arm", 2 * i)).toBe(hex(TEAM_COLORS[c.color]));
        expect(color("head", i)).toBe(hex(look.skin));
        expect(color("forearm", 2 * i + 1)).toBe(hex(look.skin));
        expect(color("shin", 2 * i)).toBe(hex(look.pants));
      });
    });

    it("greys every part of a stale character", () => {
      const stale = officeFloor([{ ...team("s", "running"), desks: [{ ...team("s", "running").desks[0], stale: "As last seen." }] }], EMPTY_FLOOR_MEMORY);
      const { mesh, color } = drawn(stale.characters);
      for (const part of ["torso", "head", "face", "upper-arm", "forearm", "thigh", "shin", "shoe", "hair-short", "hair-long", "hair-bun"]) {
        const m = mesh(part);
        if (!m.count) continue;
        // Grey: no channel stands out from the others.
        const [r, g, b] = [color(part, 0) >> 16, (color(part, 0) >> 8) & 255, color(part, 0) & 255];
        expect(Math.max(r, g, b) - Math.min(r, g, b), part).toBeLessThan(25);
      }
    });
  });

  it("moves only a typing, current agent's arms, and none when nothing may move", () => {
    const floor = officeFloor([team("a", "running", "completed")], EMPTY_FLOOR_MEMORY);
    const stale = officeFloor([{ ...team("s", "running"), desks: [{ ...team("s", "running").desks[0], stale: "As last seen." }] }], EMPTY_FLOOR_MEMORY);
    const figures = buildFigures();
    figures.set(floor.characters);
    expect(figures.animate(0, false)).toBe(false);
    expect(figures.animate(0, true)).toBe(true);
    figures.set(stale.characters);
    expect(figures.animate(0, true)).toBe(false);
  });

  it("re-poses only the typing character's forearms between frames; nothing else's matrices change", () => {
    const floor = officeFloor([team("a", "running", "completed")], EMPTY_FLOOR_MEMORY);
    const { figures, mesh } = drawn(floor.characters);
    expect(floor.characters.map((c) => c.pose)).toEqual(["typing", "couch"]);
    const meshes = figures.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh);
    const before = new Map(meshes.map((m) => [m, Float32Array.from(m.instanceMatrix.array)]));
    figures.animate(0, true);
    for (const m of meshes) {
      const was = before.get(m)!;
      const now = Array.from(m.instanceMatrix.array.slice(0, was.length));
      const changed = now.flatMap((x, k) => (x === was[k] ? [] : [Math.floor(k / 16)]));
      if (m === mesh("forearm")) {
        // The typing character is instance 0: its two forearms, and not the couch character's, instances 2 and 3.
        expect(new Set(changed).size).toBeGreaterThan(0);
        expect(changed.every((i) => i < 2)).toBe(true);
      } else expect(changed, m.name).toEqual([]);
    }
    // And the next beat moves them again, the other way.
    const lifted = Float32Array.from(mesh("forearm").instanceMatrix.array.slice(0, 32));
    figures.animate(160, true);
    expect(Float32Array.from(mesh("forearm").instanceMatrix.array.slice(0, 32))).not.toEqual(lifted);
  });

  it("shows faces only when told the camera is close", () => {
    const { figures, mesh } = drawn(MIXED.characters);
    figures.showFaces(false);
    expect(mesh("face").visible).toBe(false);
    figures.showFaces(true);
    expect(mesh("face").visible).toBe(true);
  });

  it("keeps the selection ring under the selected agent when the floor moves it, and drops it when the agent goes", () => {
    const queued = officeFloor([team("a", "running", "queued")], EMPTY_FLOOR_MEMORY);
    const started = officeFloor([team("a", "running", "running")], queued.memory);
    const figures = buildFigures();
    const ring = figures.group.children.find((o): o is Mesh => o instanceof Mesh && !(o instanceof InstancedMesh))!;
    figures.set(queued.characters);
    figures.select("a 1");
    expect(ring.visible).toBe(true);
    const door = queued.characters.find((c) => c.key === "a 1")!.spot;
    expect([ring.position.x, ring.position.z]).toEqual([door.x, door.z]);

    figures.set(started.characters);
    const desk = started.characters.find((c) => c.key === "a 1")!.spot;
    expect(desk).not.toEqual(door);
    expect([ring.position.x, ring.position.z]).toEqual([desk.x, desk.z]);

    figures.set(officeFloor([team("a", "running")], started.memory).characters);
    expect(ring.visible).toBe(false);
  });
});
