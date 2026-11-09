// The building itself (ADR 0122): ground, room floors, low walls with doors, and the furniture at the floor plan's
// seats. Built once; a theme change recolors it. Plain shapes and colors made for this app, no imported art. No live
// shadows: a soft round shadow is painted under each piece of furniture instead.
import { BoxGeometry, CircleGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, Quaternion, Vector3 } from "three";
import { PLAN, type Bounds, type BuildingRoom, type Spot } from "../../hermes/officeFloor";

export type Mode = "light" | "dark";

/** The building's colors in each mode. Team colors aren't here: they stay the same in both. */
export const PALETTE: Record<Mode, { sky: string; ground: string; floor: Record<BuildingRoom | "hallway", string>; wall: string; desk: string; screen: string; seat: string; couch: string; mark: string; shadow: number; sun: number; fill: number }> = {
  light: {
    sky: "#eef0f3",
    ground: "#dfe3e8",
    floor: { workroom: "#f6f1e8", waiting: "#f3eee0", trouble: "#f2e9e7", lounge: "#e9efe6", hallway: "#e8e6e1" },
    wall: "#c9ccd3",
    desk: "#b9a184",
    screen: "#39404d",
    seat: "#8d93a0",
    couch: "#7d8fb0",
    mark: "#d6b25a",
    shadow: 0.16,
    sun: 1.6,
    fill: 1.5,
  },
  dark: {
    sky: "#16171b",
    ground: "#1d1f24",
    floor: { workroom: "#2c2a28", waiting: "#2d2b25", trouble: "#2e2728", lounge: "#262b26", hallway: "#25262a" },
    wall: "#454852",
    desk: "#6d5a45",
    screen: "#1a1d23",
    seat: "#555a66",
    couch: "#46536b",
    mark: "#9c823f",
    shadow: 0.35,
    sun: 1.0,
    fill: 0.9,
  },
};

const WALL_H = 1;
const WALL_T = 0.12;
const DOOR_W = 1.4;
/**
 * People are drawn this much larger than life, so they read from across the building; seats and desks rise with them
 * so they still sit on their chairs and type on their desks.
 */
export const FIGURE_SCALE = 1.35;
const SEAT_H = 0.42 * FIGURE_SCALE;
const DESK = { w: 0.95, h: 0.74 * FIGURE_SCALE, d: 0.6 };

/** A point `ahead` metres in front of a spot. */
export const ahead = (s: Spot, by: number) => ({ x: s.x + Math.sin(s.facing) * by, z: s.z + Math.cos(s.facing) * by });

/** The walls as segments: each room's sides, with a door onto the hallway, and the front door at the hallway's end. */
function wallSegments(): { x1: number; z1: number; x2: number; z2: number }[] {
  const out: { x1: number; z1: number; x2: number; z2: number }[] = [];
  // A horizontal run from x1 to x2 at z, with gaps of DOOR_W centred on each door x.
  const run = (z: number, x1: number, x2: number, doors: number[]) => {
    let from = x1;
    for (const d of [...doors].sort((a, b) => a - b)) {
      out.push({ x1: from, z1: z, x2: d - DOOR_W / 2, z2: z });
      from = d + DOOR_W / 2;
    }
    out.push({ x1: from, z1: z, x2, z2: z });
  };
  const { rooms, hallway, doors } = PLAN;
  run(hallway.z, -12, 12, [doors.workroom.x, doors.waiting.x]);
  run(hallway.z + hallway.d, -12, 12, [doors.trouble.x, doors.lounge.x]);
  run(-8, -12, 12, []);
  run(8, -12, 12, []);
  out.push({ x1: -12, z1: -8, x2: -12, z2: 8 });
  // The front door: the hallway's east end is open.
  out.push({ x1: 12, z1: -8, x2: 12, z2: hallway.z }, { x1: 12, z1: hallway.z + hallway.d, x2: 12, z2: 8 });
  out.push({ x1: rooms.waiting.x, z1: -8, x2: rooms.waiting.x, z2: hallway.z });
  out.push({ x1: rooms.lounge.x, z1: hallway.z + hallway.d, x2: rooms.lounge.x, z2: 8 });
  return out.filter((s) => Math.hypot(s.x2 - s.x1, s.z2 - s.z1) > 0.01);
}

type Box = { x: number; y: number; z: number; w: number; h: number; d: number; turn?: number };

/** One instanced mesh of boxes, all of one material. */
function boxes(list: Box[], material: MeshLambertMaterial): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material, Math.max(list.length, 1));
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  list.forEach((b, i) => mesh.setMatrixAt(i, m.compose(new Vector3(b.x, b.y, b.z), q.setFromAxisAngle(up, b.turn ?? 0), new Vector3(b.w, b.h, b.d))));
  mesh.count = list.length;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Round shadows on the floor, `r` metres across each. */
function shadows(at: { x: number; z: number; r: number }[], material: MeshBasicMaterial): InstancedMesh {
  const geo = new CircleGeometry(0.5, 16).rotateX(-Math.PI / 2);
  const mesh = new InstancedMesh(geo, material, Math.max(at.length, 1));
  const m = new Matrix4();
  at.forEach((s, i) => mesh.setMatrixAt(i, m.makeScale(s.r, 1, s.r).setPosition(s.x, 0.012, s.z)));
  mesh.count = at.length;
  return mesh;
}

export type Building = { group: Group; recolor(mode: Mode): void; dispose(): void };

export function buildBuilding(mode: Mode): Building {
  const group = new Group();
  const mat = (c: string) => new MeshLambertMaterial({ color: c });
  const p = PALETTE[mode];
  const m = {
    ground: new MeshLambertMaterial({ color: p.ground }),
    floors: Object.fromEntries((["workroom", "waiting", "trouble", "lounge", "hallway"] as const).map((k) => [k, mat(p.floor[k])])) as Record<BuildingRoom | "hallway", MeshLambertMaterial>,
    wall: mat(p.wall),
    desk: mat(p.desk),
    screen: mat(p.screen),
    seat: mat(p.seat),
    couch: mat(p.couch),
    mark: mat(p.mark),
    shadow: new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: p.shadow, depthWrite: false }),
  };

  const ground = new Mesh(new PlaneGeometry(80, 80).rotateX(-Math.PI / 2), m.ground);
  ground.position.y = -0.02;
  group.add(ground);
  for (const [k, b] of [...Object.entries(PLAN.rooms), ["hallway", PLAN.hallway] as const] as [BuildingRoom | "hallway", Bounds][]) {
    const floor = new Mesh(new BoxGeometry(b.w, 0.04, b.d), m.floors[k]);
    floor.position.set(b.x + b.w / 2, 0, b.z + b.d / 2);
    group.add(floor);
  }

  group.add(
    boxes(
      wallSegments().map((s) => ({ x: (s.x1 + s.x2) / 2, y: WALL_H / 2, z: (s.z1 + s.z2) / 2, w: Math.abs(s.x2 - s.x1) + WALL_T, h: WALL_H, d: Math.abs(s.z2 - s.z1) + WALL_T })),
      m.wall,
    ),
  );

  // A desk, a screen on it and a chair at each Workroom and Trouble room seat.
  const deskSeats = [...PLAN.seats.workroom, ...PLAN.seats.trouble];
  const desks: Box[] = [];
  const screens: Box[] = [];
  const chairs: Box[] = [];
  for (const s of deskSeats) {
    const d = ahead(s, 0.55);
    desks.push({ x: d.x, y: DESK.h / 2, z: d.z, w: DESK.w, h: DESK.h, d: DESK.d, turn: s.facing });
    const sc = ahead(s, 0.68);
    screens.push({ x: sc.x, y: DESK.h + 0.17, z: sc.z, w: 0.46, h: 0.3, d: 0.04, turn: s.facing });
    chairs.push({ x: s.x, y: SEAT_H / 2, z: s.z, w: 0.46, h: SEAT_H, d: 0.46, turn: s.facing });
  }
  group.add(boxes(desks, m.desk), boxes(screens, m.screen), boxes(chairs, m.seat));

  // Couches of four in the Lounge: a seat and a back behind it.
  const couch: Box[] = [];
  const seats = PLAN.seats.lounge;
  for (let i = 0; i < seats.length; i += 4) {
    const a = seats[i];
    const b = seats[i + 3];
    const cx = (a.x + b.x) / 2;
    const back = ahead(a, -0.42);
    couch.push({ x: cx, y: SEAT_H / 2, z: a.z, w: 3, h: SEAT_H, d: 0.8, turn: 0 }, { x: cx, y: 0.55, z: back.z, w: 3, h: 1.1, d: 0.2, turn: 0 });
  }
  group.add(boxes(couch, m.couch));

  // A mark on the floor where each agent waiting for the owner stands.
  group.add(boxes(PLAN.seats.waiting.map((s) => ({ x: s.x, y: 0.025, z: s.z, w: 0.6, h: 0.01, d: 0.6 })), m.mark));

  group.add(
    shadows(
      [...desks.map((d) => ({ x: d.x, z: d.z, r: 1.15 })), ...seats.filter((_, i) => i % 4 === 1).map((s) => ({ x: s.x + 0.35, z: s.z, r: 3.3 }))],
      m.shadow,
    ),
  );

  return {
    group,
    recolor(next) {
      const q = PALETTE[next];
      m.ground.color = new Color(q.ground);
      for (const k of Object.keys(m.floors) as (BuildingRoom | "hallway")[]) m.floors[k].color = new Color(q.floor[k]);
      m.wall.color = new Color(q.wall);
      m.desk.color = new Color(q.desk);
      m.screen.color = new Color(q.screen);
      m.seat.color = new Color(q.seat);
      m.couch.color = new Color(q.couch);
      m.mark.color = new Color(q.mark);
      m.shadow.opacity = q.shadow;
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      Object.values(m).forEach((v) => (v instanceof MeshLambertMaterial || v instanceof MeshBasicMaterial ? v.dispose() : Object.values(v).forEach((f) => f.dispose())));
    },
  };
}

/** The tower beside the building: a closed floor for each profile not shown, the first at the bottom. */
export const TOWER = { x: -16, z: -4.5, w: 3, d: 3, floorH: 0.9, gap: 0.12 } as const;

export type Tower = {
  group: Group;
  /** One closed floor for each entry, lit when something there needs the owner. */
  set(floors: readonly { lit: boolean }[]): void;
  recolor(mode: Mode): void;
  /** The floors a click can hit; a hit's `userData.floor` is its index. */
  pickable(): Mesh[];
  /** Where floor `i`'s label goes: the middle of its side that faces the building's front. */
  labelAt(i: number, out: Vector3): Vector3;
  dispose(): void;
};

export function buildTower(mode: Mode): Tower {
  const group = new Group();
  const geo = new BoxGeometry(TOWER.w, TOWER.floorH, TOWER.d);
  const plain = new MeshLambertMaterial({ color: PALETTE[mode].wall });
  const lit = new MeshLambertMaterial({ color: PALETTE[mode].mark });
  const shadow = new Mesh(new PlaneGeometry(TOWER.w + 0.8, TOWER.d + 0.8).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: PALETTE[mode].shadow, depthWrite: false }));
  shadow.position.set(TOWER.x, 0.012, TOWER.z);
  let slabs: Mesh[] = [];
  const y = (i: number) => i * (TOWER.floorH + TOWER.gap) + TOWER.floorH / 2;
  return {
    group,
    set(floors) {
      for (const s of slabs) group.remove(s);
      slabs = floors.map((f, i) => {
        const slab = new Mesh(geo, f.lit ? lit : plain);
        slab.position.set(TOWER.x, y(i), TOWER.z);
        slab.userData.floor = i;
        group.add(slab);
        return slab;
      });
      if (floors.length) group.add(shadow);
      else group.remove(shadow);
    },
    recolor(next) {
      plain.color = new Color(PALETTE[next].wall);
      lit.color = new Color(PALETTE[next].mark);
      (shadow.material as MeshBasicMaterial).opacity = PALETTE[next].shadow;
    },
    pickable: () => slabs,
    labelAt: (i, out) => out.set(TOWER.x, y(i), TOWER.z + TOWER.d / 2 + 0.05),
    dispose() {
      geo.dispose();
      plain.dispose();
      lit.dispose();
      shadow.geometry.dispose();
      (shadow.material as MeshBasicMaterial).dispose();
    },
  };
}
