// The agents as faceless low-poly people (ADR 0089): a rounded body and arms in their team's color, a plain ball for a
// head, posed for their room, or walking. Each part is one instanced mesh for every character, so forty cost a handful
// of draw calls. Only a typing character's arms move by themselves, from `animate`, which the pacer calls inside a frame;
// a walking one is placed again on each frame of its walk.
import { CapsuleGeometry, CircleGeometry, Color, Euler, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, OctahedronGeometry, Quaternion, RingGeometry, Vector3, BoxGeometry } from "three";
import { FLOOR_CAP, TEAM_COLORS, type Character, type Pose } from "../../hermes/officeFloor";
import { FIGURE_SCALE } from "./building";

/**
 * A character as drawn: where the floor seats it, or where its walk has got to. `stride` swings a walker's arms.
 * Characters past the floor's are leaving the building: they can't be picked.
 */
export type Placed = Pick<Character, "key" | "color" | "stale" | "spot"> & { pose: Pose | "walking"; stride?: number };

/** Characters on the floor, and as many again walking out of the building. */
const CAPACITY = FLOOR_CAP * 2;

const HEAD = new Color("#d9dce1");
const STALE = new Color("#9aa0a8");
const STALE_HEAD = new Color("#b9bdc3");
const WARN = new Color("#e3a72f");
const BAD = new Color("#d6455d");
const SEAT_Y = 0.42;
const BODY_R = 0.18;
const BODY_LEN = 0.35;
const BODY_H = BODY_LEN + 2 * BODY_R;
const ARM_LEN = 0.26;
const ARM_H = ARM_LEN + 0.1;

type Part = { at: [number, number, number]; turn?: [number, number, number]; scale?: [number, number, number] };
type Figure = { body: Part; head: Part; arms: [Part, Part]; marker?: "ask" | "trouble" };

const sitting = (lean: number): Pick<Figure, "body" | "head"> => ({
  body: { at: [0, SEAT_Y + BODY_H / 2, 0], turn: [lean, 0, 0] },
  head: { at: [0, SEAT_Y + BODY_H + 0.13, -lean * 0.5] },
});
const STAND = 1.5;
const standing: Pick<Figure, "body" | "head"> = {
  body: { at: [0, (BODY_H * STAND) / 2, 0], scale: [1, STAND, 1] },
  head: { at: [0, BODY_H * STAND + 0.13, 0] },
};
const shoulder = (side: -1 | 1, y: number, z = 0): [number, number, number] => [side * (BODY_R + 0.04), y, z];

/** Each pose's parts, in the character's own frame: on the floor at its seat, facing +z. Arms hang from the shoulder. */
const FIGURE: Record<Pose | "walking", Figure> = {
  typing: { ...sitting(0.05), arms: [{ at: shoulder(-1, 1.0), turn: [-1.3, 0, 0] }, { at: shoulder(1, 1.0), turn: [-1.3, 0, 0] }] },
  "hand-up": { ...standing, arms: [{ at: shoulder(-1, 0.95), turn: [0, 0, -0.12] }, { at: shoulder(1, 0.98), turn: [Math.PI - 0.15, 0, 0.1] }], marker: "ask" },
  slumped: {
    body: { at: [0, SEAT_Y + BODY_H / 2 - 0.04, 0.12], turn: [0.55, 0, 0] },
    head: { at: [0, 0.9, 0.42] },
    arms: [{ at: shoulder(-1, 0.88, 0.22), turn: [-1.5, 0, 0] }, { at: shoulder(1, 0.88, 0.22), turn: [-1.5, 0, 0] }],
    marker: "trouble",
  },
  couch: { ...sitting(-0.18), arms: [{ at: shoulder(-1, 0.98, -0.08), turn: [-0.3, 0, -0.3] }, { at: shoulder(1, 0.98, -0.08), turn: [-0.3, 0, 0.3] }] },
  door: { ...standing, arms: [{ at: shoulder(-1, 0.95), turn: [0, 0, -0.12] }, { at: shoulder(1, 0.95), turn: [0, 0, 0.12] }] },
  walking: { ...standing, arms: [{ at: shoulder(-1, 0.95), turn: [0, 0, -0.12] }, { at: shoulder(1, 0.95), turn: [0, 0, 0.12] }] },
};

/** A walker's arms swing back and forth, opposite each other, with its stride. */
const SWING = 0.5;

const v = new Vector3();
const s = new Vector3();
const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const e = new Euler();
const m = new Matrix4();
const local = new Matrix4();

function partMatrix(base: Matrix4, p: Part, extraX = 0, out = new Matrix4()): Matrix4 {
  const [tx, ty, tz] = p.turn ?? [0, 0, 0];
  local.compose(v.set(...p.at), q.setFromEuler(e.set(tx + extraX, ty, tz)), s.set(...(p.scale ?? [1, 1, 1])));
  return out.multiplyMatrices(base, local);
}

export type Figures = {
  group: Group;
  /** Places the characters; drawn on the next frame. The first `onFloor` are the floor's; the rest walk out. */
  set(characters: readonly Placed[], onFloor?: number): void;
  /** Moves typing arms for time `t` (ms). Whether any character types, so the scene knows to keep drawing. */
  animate(t: number, moves: boolean): boolean;
  select(key: string | undefined): void;
  /** The meshes a click can hit, and which character an instance of them is. */
  pickable: InstancedMesh[];
  keyAt(instance: number): string | undefined;
  /** Where a character's name tag goes: just above its head, in world space. */
  tagAt(i: number, out: Vector3): Vector3;
  dispose(): void;
};

export function buildFigures(): Figures {
  const group = new Group();
  const lambert = () => new MeshLambertMaterial({ color: 0xffffff });
  const make = (geo: CapsuleGeometry | IcosahedronGeometry | OctahedronGeometry | BoxGeometry | CircleGeometry, mat: MeshLambertMaterial | MeshBasicMaterial) => {
    const mesh = new InstancedMesh(geo, mat, CAPACITY);
    mesh.count = 0;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  const body = make(new CapsuleGeometry(BODY_R, BODY_LEN, 3, 8), lambert());
  const head = make(new IcosahedronGeometry(0.16, 1), lambert());
  // An arm's geometry hangs down from its top end, so turning it turns it at the shoulder.
  const arm = make(new CapsuleGeometry(0.05, ARM_LEN, 2, 6).translate(0, -ARM_H / 2, 0), lambert());
  const bang = make(new BoxGeometry(0.07, 0.24, 0.07).translate(0, 0.17, 0), new MeshBasicMaterial({ color: 0xffffff }));
  const dot = make(new BoxGeometry(0.08, 0.08, 0.08), new MeshBasicMaterial({ color: 0xffffff }));
  const flag = make(new OctahedronGeometry(0.11, 0), new MeshBasicMaterial({ color: 0xffffff }));
  const shadow = make(new CircleGeometry(0.32, 14).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  const ring = new Mesh(new RingGeometry(0.36, 0.46, 28).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: "#d08b6e" }));
  ring.visible = false;
  group.add(ring);

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

  return {
    group,
    pickable: [body, head],
    set(characters, onFloor = characters.length) {
      shown = characters.slice(0, CAPACITY);
      pickable = Math.min(onFloor, shown.length);
      typing.length = 0;
      let arms = 0;
      let bangs = 0;
      let flags = 0;
      const color = new Color();
      shown.forEach((c, i) => {
        const f = FIGURE[c.pose];
        const base = (bases[i] ??= new Matrix4()).compose(new Vector3(c.spot.x, 0, c.spot.z), q.setFromAxisAngle(UP, c.spot.facing), s.setScalar(FIGURE_SCALE));
        const tint = c.stale ? STALE : color.set(TEAM_COLORS[c.color]);
        body.setMatrixAt(i, partMatrix(base, f.body, 0, m));
        body.setColorAt(i, tint);
        head.setMatrixAt(i, partMatrix(base, f.head, 0, m));
        head.setColorAt(i, c.stale ? STALE_HEAD : HEAD);
        shadow.setMatrixAt(i, m.copy(base).multiply(local.makeTranslation(0, 0.015, c.pose === "slumped" ? 0.1 : 0)));
        f.arms.forEach((a, side) => {
          arm.setMatrixAt(arms, partMatrix(base, a, c.pose === "walking" ? Math.sin(c.stride ?? 0) * SWING * (side ? 1 : -1) : 0, m));
          arm.setColorAt(arms++, tint);
        });
        if (c.pose === "typing" && !c.stale) typing.push(i);
        const above = new Matrix4().multiplyMatrices(base, local.makeTranslation(0, f.head.at[1] + 0.32, f.head.at[2]));
        if (f.marker === "ask") {
          bang.setMatrixAt(bangs, above);
          dot.setMatrixAt(bangs, m.copy(above));
          bang.setColorAt(bangs, c.stale ? STALE : WARN);
          dot.setColorAt(bangs++, c.stale ? STALE : WARN);
        } else if (f.marker === "trouble") {
          flag.setMatrixAt(flags, m.copy(above).multiply(local.makeTranslation(0, 0.18, 0)));
          flag.setColorAt(flags++, c.stale ? STALE : BAD);
        }
      });
      body.count = head.count = shadow.count = shown.length;
      arm.count = arms;
      bang.count = dot.count = bangs;
      flag.count = flags;
      for (const mesh of [body, head, arm, bang, dot, flag, shadow]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        // Picking tests instances against these bounds, so they follow where the characters now are.
        mesh.computeBoundingSphere();
      }
      ringOn();
    },
    animate(t, moves) {
      if (!moves || typing.length === 0) return typing.length > 0 && moves;
      // Every pose has two arms, so character i's are arms 2i and 2i + 1.
      for (const i of typing) {
        const f = FIGURE.typing;
        f.arms.forEach((a, side) => {
          // Two poses, a hand up and a hand down, swapped each beat: at a few frames a second that reads as typing.
          const beat = Math.floor(t / 160) + i;
          const swing = (beat + side) % 2 ? 0.16 : -0.06;
          arm.setMatrixAt(i * 2 + side, partMatrix(bases[i], a, swing, m));
        });
      }
      arm.instanceMatrix.needsUpdate = true;
      return true;
    },
    select(key) {
      picked = key;
      ringOn();
    },
    keyAt: (instance) => (instance < pickable ? shown[instance]?.key : undefined),
    tagAt(i, out) {
      const c = shown[i];
      const f = FIGURE[c.pose];
      return out.set(...f.head.at).add(v.set(0, f.marker ? 0.75 : 0.32, 0)).applyMatrix4(bases[i]);
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
