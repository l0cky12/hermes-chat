// The agents as low-poly people (ADR 0089): a shirt in their team's color, a head with hair and, close up, a face, arms
// and legs, posed for their room, or walking. Each part is one instanced mesh for every character, so forty cost a
// handful of draw calls. Only a typing character's arms move by themselves, from `animate`, which the pacer calls inside
// a frame; a walking one is placed again on each frame of its walk.
import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FLOOR_CAP, TEAM_COLORS, type Character, type Pose } from "../../hermes/officeFloor";
import { FIGURE_SCALE } from "./building";

/**
 * A character as drawn: where the floor seats it, or where its walk has got to. `stride` swings a walker's arms and
 * legs. Characters past the floor's are leaving the building: they can't be picked.
 */
export type Placed = Pick<Character, "key" | "color" | "stale" | "spot"> & { pose: Pose | "walking"; stride?: number };

/** Characters on the floor, and as many again walking out of the building. */
const CAPACITY = FLOOR_CAP * 2;

const STALE = new Color("#9aa0a8");
const STALE_SKIN = new Color("#b9bdc3");
const STALE_HAIR = new Color("#80858c");
const STALE_PANTS = new Color("#858b93");
const STALE_SHOE = new Color("#6d727a");
const STALE_FACE = new Color("#6b7078");
const FACE = new Color("#1d1e23");
const SHOE = new Color("#34373f");
const WARN = new Color("#e3a72f");
const BAD = new Color("#d6455d");

export type HairStyle = "short" | "long" | "bun" | "bald";
export type Look = { skin: number; hair: HairStyle; hairColor: number; pants: number };

export const SKIN_TONES = [0xf3d3b6, 0xe6bb98, 0xcf9a6e, 0x8e5f45, 0x6b4630, 0x4a3022] as const;
export const HAIR_COLORS = [0x1d1a18, 0x3a281d, 0x7a3f24, 0x8b5a34, 0xb58c4e, 0xe0c27c] as const;
export const PANTS_COLORS = [0x2f3b57, 0x3a3d44, 0xa89a78, 0x55585f] as const;
const HAIR_STYLES: readonly HairStyle[] = ["short", "short", "short", "long", "long", "bun", "bun", "bald"];

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The hash, remixed by `salt`, so each look field reads its own bits and the fields don't move together. */
function mix(h: number, salt: number): number {
  let x = (h ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const pick = <T>(list: readonly T[], h: number, salt: number): T => list[mix(h, salt) % list.length];

/** A character's look, from its key alone: the same agent keeps its look between launches. */
export function lookOf(key: string): Look {
  const h = fnv1a(key);
  return { skin: pick(SKIN_TONES, h, 1), hair: pick(HAIR_STYLES, h, 2), hairColor: pick(HAIR_COLORS, h, 3), pants: pick(PANTS_COLORS, h, 4) };
}

type Vec3 = [number, number, number];
type Part = { at: Vec3; turn?: Vec3; scale?: Vec3 };
/** A limb of two segments: the upper hangs from `at` turned by `turn`, the lower from the upper's end, bent about x. */
type Limb = { at: Vec3; turn: Vec3; bend: number };
type Figure = { torso: Part; head: Part; arms: [Limb, Limb]; legs: [Limb, Limb]; marker?: "ask" | "trouble" };

const SEAT_Y = 0.42;
const TORSO = 0.48;
const NECK = 0.19;
const SHOULDER = { x: 0.215, y: TORSO - 0.06 };
const HIP_X = 0.09;
const ARM = { upper: 0.26, lower: 0.24 };
const LEG = { upper: 0.42, lower: 0.38 };
const THIGH_R = 0.075;
/** How far a shoe's sole is below the ankle. */
const SOLE = 0.04;
const SEATED_HIP = SEAT_Y + THIGH_R;
const STAND_HIP = LEG.upper + LEG.lower + SOLE;
/** A marker's height over the head's centre. The hand-up pose's marker clears its raised hand. */
const MARKER_LIFT = { ask: 0.5, trouble: 0.32 } as const;

const along = (hip: Vec3, lean: number, d: number, side = 0): Vec3 => [hip[0] + side, hip[1] + d * Math.cos(lean), hip[2] + d * Math.sin(lean)];

function upperBody(hip: Vec3, lean: number, nod = 0) {
  return {
    torso: { at: hip, turn: [lean, 0, 0] } satisfies Part,
    head: { at: along(hip, lean, TORSO + NECK), turn: [lean + nod, 0, 0] } satisfies Part,
    shoulders: [along(hip, lean, SHOULDER.y, -SHOULDER.x), along(hip, lean, SHOULDER.y, SHOULDER.x)] as const,
  };
}

const legsAt = (hipY: number, hipZ: number, thigh: number, shin: number, splay = 0.04): Figure["legs"] => [
  { at: [-HIP_X, hipY, hipZ], turn: [thigh, 0, -splay], bend: shin },
  { at: [HIP_X, hipY, hipZ], turn: [thigh, 0, splay], bend: shin },
];

const standingLegs = legsAt(STAND_HIP, 0, 0, 0, 0.03);
/** Thighs along the seat, easing down to knees at seat height, shins straight down to feet flat on the floor. */
const seatedLegs = (hipZ: number) => legsAt(SEATED_HIP, hipZ, -1.39, 1.39);

const TYPING = upperBody([0, SEATED_HIP, -0.04], 0.1, 0.08);
const SLUMP = upperBody([0, SEATED_HIP, -0.12], 0.5);
const LOUNGE = upperBody([0, SEATED_HIP, -0.08], -0.22, -0.1);
const STAND = upperBody([0, STAND_HIP, 0], 0);

/** Each pose's parts, in the character's own frame: on the floor at its seat, facing +z. */
const FIGURE: Record<Pose | "walking", Figure> = {
  typing: {
    ...TYPING,
    arms: [
      { at: TYPING.shoulders[0], turn: [-0.294, 0, -0.05], bend: -1.676 },
      { at: TYPING.shoulders[1], turn: [-0.294, 0, 0.05], bend: -1.676 },
    ],
    legs: seatedLegs(-0.04),
  },
  seated: {
    ...TYPING,
    // Waiting on work it handed off: back from the keyboard, hands resting in its lap.
    arms: [
      { at: TYPING.shoulders[0], turn: [-0.15, 0, -0.08], bend: -1.1 },
      { at: TYPING.shoulders[1], turn: [-0.15, 0, 0.08], bend: -1.1 },
    ],
    legs: seatedLegs(-0.04),
  },
  door: {
    ...STAND,
    arms: [
      { at: STAND.shoulders[0], turn: [0, 0, -0.1], bend: -0.2 },
      { at: STAND.shoulders[1], turn: [0, 0, 0.1], bend: -0.2 },
    ],
    legs: standingLegs,
  },
  walking: {
    ...STAND,
    arms: [
      { at: STAND.shoulders[0], turn: [0, 0, -0.1], bend: -0.3 },
      { at: STAND.shoulders[1], turn: [0, 0, 0.1], bend: -0.3 },
    ],
    legs: standingLegs,
  },
  "hand-up": {
    ...STAND,
    arms: [
      { at: STAND.shoulders[0], turn: [0, 0, -0.1], bend: -0.2 },
      { at: STAND.shoulders[1], turn: [Math.PI, 0, 0.3], bend: 0 },
    ],
    legs: standingLegs,
    marker: "ask",
  },
  slumped: {
    ...SLUMP,
    // The head drops onto the desk, its neck leaning back toward the shoulders.
    head: { at: [0, 0.93, 0.3], turn: [1.1, 0, 0] },
    arms: [
      { at: SLUMP.shoulders[0], turn: [-1.26, 0, -0.1], bend: -0.31 },
      { at: SLUMP.shoulders[1], turn: [-1.26, 0, 0.1], bend: -0.31 },
    ],
    legs: seatedLegs(-0.12),
    marker: "trouble",
  },
  couch: {
    ...LOUNGE,
    arms: [
      { at: LOUNGE.shoulders[0], turn: [0.1, 0, -0.05], bend: -1.0 },
      { at: LOUNGE.shoulders[1], turn: [0.1, 0, 0.05], bend: -1.0 },
    ],
    legs: seatedLegs(-0.08),
  },
};

/** How far a walker's arms and legs swing back and forth with its stride, opposite each other, in radians. */
const SWING = { arm: 0.5, leg: 0.45 };

/** A limb swung forward (+) or back (-) at its top joint. */
const swung = (l: Limb, by: number): Limb => (by ? { ...l, turn: [l.turn[0] - by, l.turn[1], l.turn[2]] } : l);

const v = new Vector3();
const s = new Vector3();
const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const e = new Euler();
const m = new Matrix4();
const local = new Matrix4();
const step = new Matrix4();
const elbow = new Matrix4();

function partMatrix(base: Matrix4, p: Part, out = new Matrix4()): Matrix4 {
  const [tx, ty, tz] = p.turn ?? [0, 0, 0];
  local.compose(v.set(...p.at), q.setFromEuler(e.set(tx, ty, tz)), s.set(...(p.scale ?? [1, 1, 1])));
  return out.multiplyMatrices(base, local);
}

/**
 * A limb's three matrices: its upper segment (hung from `at`), its lower segment (hung from the upper's end, bent by
 * `bend` and `extraBend`) and the end piece, a hand or a shoe, at the lower segment's end.
 */
function limbMatrices(base: Matrix4, l: Limb, seg: { upper: number; lower: number }, out: readonly [Matrix4, Matrix4, Matrix4], extraBend = 0): void {
  partMatrix(base, { at: l.at, turn: l.turn }, out[0]);
  step.makeTranslation(0, -seg.upper, 0);
  elbow.makeRotationX(l.bend + extraBend);
  out[1].multiplyMatrices(out[0], step).multiply(elbow);
  out[2].multiplyMatrices(out[1], step.makeTranslation(0, -seg.lower, 0));
}

const HEAD_R = new Vector3(0.145, 0.165, 0.155);
const onHead = (x: number, y: number) => HEAD_R.z * Math.sqrt(1 - (x / HEAD_R.x) ** 2 - (y / HEAD_R.y) ** 2);

const ball = (r: Vector3, at: Vec3, w = 12, h = 9) => new SphereGeometry(1, w, h).scale(r.x, r.y, r.z).translate(...at);

function headGeometry(): BufferGeometry {
  const neck = new CylinderGeometry(0.055, 0.065, 0.2, 8).translate(0, -0.12, 0);
  return mergeGeometries([ball(HEAD_R, [0, 0, 0]), neck])!;
}

/** Hair as a cap tipped back, so it ends at a hairline above the eyes at the front and low at the nape. */
function cap(): BufferGeometry {
  return new SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, 1.85).rotateX(-0.75).scale(HEAD_R.x * 1.09, HEAD_R.y * 1.09, HEAD_R.z * 1.09).translate(0, 0.012, -0.012);
}

const HAIR: Record<Exclude<HairStyle, "bald">, () => BufferGeometry> = {
  short: cap,
  long: () => mergeGeometries([cap(), ball(new Vector3(0.165, 0.2, 0.095), [0, -0.09, -0.115], 10, 8)])!,
  bun: () => mergeGeometries([cap(), ball(new Vector3(0.075, 0.075, 0.075), [0, 0.165, -0.1], 8, 6)])!,
};

function faceGeometry(): BufferGeometry {
  const eye = (side: number) => ball(new Vector3(0.021, 0.024, 0.021), [side * 0.052, 0.015, onHead(side * 0.052, 0.015) - 0.004], 6, 5);
  const mouth = new BoxGeometry(0.05, 0.012, 0.014).translate(0, -0.06, onHead(0, -0.06) - 0.002);
  return mergeGeometries([eye(-1), eye(1), mouth])!;
}

function torsoGeometry(): BufferGeometry {
  const trunk = new CylinderGeometry(0.165, 0.145, TORSO - 0.04, 10).translate(0, (TORSO - 0.04) / 2, 0);
  const top = new SphereGeometry(1, 10, 6).scale(0.2, 0.09, 0.2).translate(0, TORSO - 0.06, 0);
  return mergeGeometries([trunk, top])!.scale(1, 1, 0.66);
}

/** A segment hangs down from its top joint, so turning it turns it at the joint. */
const segment = (r: number, len: number) => new CapsuleGeometry(r, len, 3, 7).translate(0, -len / 2, 0);

function forearmGeometry(): BufferGeometry {
  const hand = ball(new Vector3(0.05, 0.062, 0.034), [0, -ARM.lower - 0.04, 0.0], 8, 6);
  return mergeGeometries([segment(0.042, ARM.lower), hand])!;
}

const shoeGeometry = () => ball(new Vector3(0.058, SOLE, 0.115), [0, 0, 0.05], 8, 6);

export type Figures = {
  group: Group;
  /** Places the characters; drawn on the next frame. The first `onFloor` are the floor's; the rest walk out. */
  set(characters: readonly Placed[], onFloor?: number): void;
  /** Moves typing arms for time `t` (ms). Whether any character types, so the scene knows to keep drawing. */
  animate(t: number, moves: boolean): boolean;
  select(key: string | undefined): void;
  showFaces(on: boolean): void;
  /** The meshes a click can hit, and which character an instance of one of them is. */
  pickable: InstancedMesh[];
  keyAt(mesh: object, instance: number): string | undefined;
  /** Where a character's name tag goes: just above its head, in world space. */
  tagAt(i: number, out: Vector3): Vector3;
  dispose(): void;
};

/** Every character has two of each limb part. */
const LIMB_CAP = 2 * CAPACITY;

export function buildFigures(): Figures {
  const group = new Group();
  const lambert = () => new MeshLambertMaterial({ color: 0xffffff });
  const make = (name: string, geo: BufferGeometry, mat: MeshLambertMaterial | MeshBasicMaterial, cap = CAPACITY) => {
    const mesh = new InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  const torso = make("torso", torsoGeometry(), lambert());
  const head = make("head", headGeometry(), lambert());
  const hair = {
    short: make("hair-short", HAIR.short(), lambert()),
    long: make("hair-long", HAIR.long(), lambert()),
    bun: make("hair-bun", HAIR.bun(), lambert()),
  };
  const face = make("face", faceGeometry(), lambert());
  const upperArm = make("upper-arm", segment(0.05, ARM.upper), lambert(), LIMB_CAP);
  const forearm = make("forearm", forearmGeometry(), lambert(), LIMB_CAP);
  const thigh = make("thigh", segment(THIGH_R, LEG.upper), lambert(), LIMB_CAP);
  const shin = make("shin", segment(0.06, LEG.lower), lambert(), LIMB_CAP);
  const shoe = make("shoe", shoeGeometry(), lambert(), LIMB_CAP);
  const bang = make("bang", new BoxGeometry(0.07, 0.24, 0.07).translate(0, 0.17, 0), new MeshBasicMaterial({ color: 0xffffff }));
  const dot = make("dot", new BoxGeometry(0.08, 0.08, 0.08), new MeshBasicMaterial({ color: 0xffffff }));
  const flag = make("flag", new OctahedronGeometry(0.11, 0), new MeshBasicMaterial({ color: 0xffffff }));
  const shadow = make("shadow", new CircleGeometry(0.32, 14).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  const ring = new Mesh(new RingGeometry(0.36, 0.46, 28).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: "#d08b6e" }));
  ring.visible = false;
  group.add(ring);

  const meshes = [torso, head, ...Object.values(hair), face, upperArm, forearm, thigh, shin, shoe, bang, dot, flag, shadow];
  let shown: readonly Placed[] = [];
  let pickable = 0;
  /** The selected character, whose ring follows it to wherever the next floor puts it. */
  let picked: string | undefined;
  const ringOn = () => {
    const i = shown.findIndex((c) => c.key === picked);
    ring.visible = i >= 0;
    if (i >= 0) ring.position.set(shown[i].spot.x, 0.02, shown[i].spot.z);
  };
  const bases: Matrix4[] = [];
  const typing: number[] = [];
  const chain: [Matrix4, Matrix4, Matrix4] = [new Matrix4(), new Matrix4(), new Matrix4()];
  const limbs: readonly InstancedMesh[] = [upperArm, forearm, thigh, shin, shoe];

  return {
    group,
    pickable: [torso, head, ...limbs],
    set(characters, onFloor = characters.length) {
      shown = characters.slice(0, CAPACITY);
      pickable = Math.min(onFloor, shown.length);
      typing.length = 0;
      const used = { short: 0, long: 0, bun: 0, bangs: 0, flags: 0 };
      const [teamColor, skinColor, hairColor, pantsColor] = [new Color(), new Color(), new Color(), new Color()];
      shown.forEach((c, i) => {
        const f = FIGURE[c.pose];
        const look = lookOf(c.key);
        const base = (bases[i] ??= new Matrix4()).compose(new Vector3(c.spot.x, 0, c.spot.z), q.setFromAxisAngle(UP, c.spot.facing), s.setScalar(FIGURE_SCALE));
        const shirt = c.stale ? STALE : teamColor.set(TEAM_COLORS[c.color]);
        const skin = c.stale ? STALE_SKIN : skinColor.setHex(look.skin);
        torso.setMatrixAt(i, partMatrix(base, f.torso, m));
        torso.setColorAt(i, shirt);
        partMatrix(base, f.head, m);
        head.setMatrixAt(i, m);
        head.setColorAt(i, skin);
        face.setMatrixAt(i, m);
        face.setColorAt(i, c.stale ? STALE_FACE : FACE);
        if (look.hair !== "bald") {
          const mesh = hair[look.hair];
          mesh.setMatrixAt(used[look.hair], m);
          mesh.setColorAt(used[look.hair]++, c.stale ? STALE_HAIR : hairColor.setHex(look.hairColor));
        }
        shadow.setMatrixAt(i, m.copy(base).multiply(local.makeTranslation(0, 0.015, c.pose === "slumped" ? 0.1 : 0)));
        const pants = c.stale ? STALE_PANTS : pantsColor.setHex(look.pants);
        // A walker swings each arm with the opposite leg.
        const stride = c.pose === "walking" ? Math.sin(c.stride ?? 0) : 0;
        for (const side of [0, 1] as const) {
          const at = 2 * i + side;
          const sway = side ? stride : -stride;
          limbMatrices(base, swung(f.arms[side], sway * SWING.arm), ARM, chain);
          upperArm.setMatrixAt(at, chain[0]);
          upperArm.setColorAt(at, shirt);
          forearm.setMatrixAt(at, chain[1]);
          forearm.setColorAt(at, skin);
          limbMatrices(base, swung(f.legs[side], -sway * SWING.leg), LEG, chain);
          thigh.setMatrixAt(at, chain[0]);
          thigh.setColorAt(at, pants);
          shin.setMatrixAt(at, chain[1]);
          shin.setColorAt(at, pants);
          shoe.setMatrixAt(at, chain[2]);
          shoe.setColorAt(at, c.stale ? STALE_SHOE : SHOE);
        }
        if (c.pose === "typing" && !c.stale) typing.push(i);
        if (f.marker) {
          const above = new Matrix4().multiplyMatrices(base, local.makeTranslation(0, f.head.at[1] + MARKER_LIFT[f.marker], f.head.at[2]));
          if (f.marker === "ask") {
            bang.setMatrixAt(used.bangs, above);
            dot.setMatrixAt(used.bangs, m.copy(above));
            bang.setColorAt(used.bangs, c.stale ? STALE : WARN);
            dot.setColorAt(used.bangs++, c.stale ? STALE : WARN);
          } else {
            flag.setMatrixAt(used.flags, m.copy(above).multiply(local.makeTranslation(0, 0.18, 0)));
            flag.setColorAt(used.flags++, c.stale ? STALE : BAD);
          }
        }
      });
      torso.count = head.count = face.count = shadow.count = shown.length;
      hair.short.count = used.short;
      hair.long.count = used.long;
      hair.bun.count = used.bun;
      for (const mesh of limbs) mesh.count = 2 * shown.length;
      bang.count = dot.count = used.bangs;
      flag.count = used.flags;
      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        // Picking tests instances against these bounds, so they follow where the characters now are.
        mesh.computeBoundingSphere();
      }
      ringOn();
    },
    animate(t, moves) {
      if (!moves || typing.length === 0) return typing.length > 0 && moves;
      for (const i of typing) {
        FIGURE.typing.arms.forEach((arm, side) => {
          // Two poses, hands resting and a forearm lifted, swapped each beat: at a few frames a second that reads as typing.
          const beat = Math.floor(t / 160) + i;
          limbMatrices(bases[i], arm, ARM, chain, (beat + side) % 2 ? -0.16 : 0);
          upperArm.setMatrixAt(2 * i + side, chain[0]);
          forearm.setMatrixAt(2 * i + side, chain[1]);
        });
      }
      upperArm.instanceMatrix.needsUpdate = forearm.instanceMatrix.needsUpdate = true;
      return true;
    },
    select(key) {
      picked = key;
      ringOn();
    },
    showFaces(on) {
      face.visible = on;
    },
    keyAt(mesh, instance) {
      const i = limbs.includes(mesh as InstancedMesh) ? instance >> 1 : instance;
      return i < pickable ? shown[i]?.key : undefined;
    },
    tagAt(i, out) {
      const f = FIGURE[shown[i].pose];
      return out.set(...f.head.at).add(v.set(0, f.marker ? MARKER_LIFT[f.marker] + 0.43 : 0.32, 0)).applyMatrix4(bases[i]);
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as MeshBasicMaterial).dispose();
        }
      });
    },
  };
}
