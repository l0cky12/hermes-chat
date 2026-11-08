// The office's building as a three.js scene (ADR 0089). The only way in from the app: OfficeBuilding.tsx loads this
// file with import(), so three.js is its own chunk, fetched when the office first opens. It draws what officeFloor
// decided and decides nothing itself, beyond walking each agent from where it was to where the floor now puts it.
// Every frame goes through the pacer: none unless something changed or moves, at most QUALITY's rate a second, none
// while asleep.
import { DirectionalLight, HemisphereLight, PerspectiveCamera, Plane, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, Color } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { OfficeQuality } from "../../hermes/uiPrefs";
import { PLAN, type BuildingRoom, type Floor } from "../../hermes/officeFloor";
import { buildBuilding, buildTower, PALETTE, type Mode } from "./building";
import { buildFigures } from "./figures";
import { createPacer } from "./pacer";
import { createCrowd } from "./walk";

/** A point on the canvas, in CSS pixels from its top left. `off`: behind the camera or outside the view. */
export type ScreenPoint = { x: number; y: number; off: boolean };

export type SceneEvents = {
  /** A click on a character, or on nothing (undefined). */
  onPick(key: string | undefined): void;
  /** The pointer is over a character, or no longer (undefined). Told only when that changes. It draws nothing. */
  onHover(key: string | undefined): void;
  /** A click on one of the tower's floors, by its index in `setTower`'s list. */
  onFloor(index: number): void;
  /**
   * After each drawn frame: where each character's tag, each room's name, the front door and each tower floor's label
   * are on the canvas.
   */
  onDrawn(tags: ReadonlyMap<string, ScreenPoint>, rooms: Readonly<Record<BuildingRoom, ScreenPoint>>, door: ScreenPoint, tower: readonly ScreenPoint[]): void;
  onFrame(frames: number): void;
  /** The scene can't draw any more, and why, in words for the owner. */
  onLost(why: string): void;
};

export type OfficeScene = {
  /**
   * The floor `profile` is now. Each of its agents that moved walks to its new spot, a new one walks in from the front
   * door, and one no longer there walks out of it. A floor of another profile replaces the last at once.
   */
  setFloor(floor: Floor, profile: string): void;
  /** The tower's closed floors, the first at the bottom; lit where something needs the owner. */
  setTower(floors: readonly { lit: boolean }[]): void;
  setMode(mode: Mode): void;
  /** Whether things may move: typing arms, walks and camera moves. Off for reduced motion. */
  setMotion(moves: boolean): void;
  /** How much the building may cost. Applies at once; Low puts anyone walking in place. */
  setQuality(quality: OfficeQuality): void;
  setSelected(key: string | undefined): void;
  resetCamera(): void;
  /** Whether it may draw at all: on screen and its window focused. */
  setAwake(awake: boolean): void;
  dispose(): void;
};

/**
 * What each quality allows. Normal holds the device pixel ratio at 1.5 at most: past it the cost grows faster than
 * anyone can see. Low is for a computer where the office costs too much: no walking, and a frame cheaper to draw.
 * Typing needs a few distinct poses a second, not smooth motion, and each of its frames redraws the whole building.
 * It is most of what an open office costs, so Low types at half the pace: on a screen at pixel ratio 1, that is all
 * that makes Low cheaper while agents work.
 */
const QUALITY: Record<OfficeQuality, { maxFps: number; maxDpr: number; walks: boolean; typingFps: number }> = {
  normal: { maxFps: 30, maxDpr: 1.5, walks: true, typingFps: 6 },
  low: { maxFps: 15, maxDpr: 1, walks: false, typingFps: 3 },
};
const MIN_DISTANCE = 7;
const MAX_DISTANCE = 44;
const HOME = { target: new Vector3(0, 0, 0.5), position: new Vector3(15, 27, 23) };
const TWEEN_MS = 450;

export function mountOfficeScene(canvas: HTMLCanvasElement, events: SceneEvents, start: { mode: Mode; moves: boolean; quality: OfficeQuality }): OfficeScene {
  // The last frame drawn has to stay on screen until the next one, which may be minutes away: WebKitGTK otherwise
  // shows a cleared canvas the next time the page repaints.
  const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[start.quality].maxDpr));
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.5, 200);
  camera.position.copy(HOME.position);

  let mode = start.mode;
  let moves = start.moves;
  let quality = start.quality;
  // Whether agents walk to a new spot; otherwise they appear in it. `moves` still decides typing arms and camera moves.
  const walking = () => moves && QUALITY[quality].walks;
  const building = buildBuilding(mode);
  const tower = buildTower(mode);
  const figures = buildFigures();
  const hemi = new HemisphereLight(0xffffff, 0x888888, PALETTE[mode].fill);
  const sun = new DirectionalLight(0xffffff, PALETTE[mode].sun);
  sun.position.set(8, 20, 6);
  scene.add(building.group, tower.group, figures.group, hemi, sun);
  const paint = () => {
    renderer.setClearColor(new Color(PALETTE[mode].sky));
    hemi.intensity = PALETTE[mode].fill;
    sun.intensity = PALETTE[mode].sun;
  };
  paint();

  // Turning all the way round; tilted between nearly straight down and nearly side-on, never below the floor; zoomed
  // between the whole building and one room. No damping: it would need frames after the hand lets go.
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.zoomToCursor = true;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = 1.38;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.target.copy(HOME.target);
  controls.update();

  let tween: { from: { p: Vector3; t: Vector3 }; to: { p: Vector3; t: Vector3 }; start: number } | undefined;
  const pacer = createPacer({ draw, onFrame: events.onFrame, maxFps: QUALITY[quality].maxFps });
  // Zooming toward the cursor moves the point the camera turns about; it stays over the building.
  controls.addEventListener("change", () => {
    controls.target.x = Math.max(-12, Math.min(12, controls.target.x));
    controls.target.z = Math.max(-8, Math.min(8, controls.target.z));
    controls.target.y = 0;
    pacer.invalidate();
  });

  let floor: Floor | undefined;
  let towerSize = 0;
  const crowd = createCrowd();
  /** Puts every agent where it is at `t`, and keeps frames coming while any walks. */
  const place = (t: number) => {
    const now = crowd.at(t);
    figures.set(now.placed, now.onFloor);
    pacer.animating("walking", now.walking);
    return now.walking;
  };
  let walks = false;
  const tag = new Vector3();
  const size = new Vector2();
  const toScreen = (p: Vector3): ScreenPoint => {
    p.project(camera);
    return { x: ((p.x + 1) / 2) * size.x, y: ((1 - p.y) / 2) * size.y, off: p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05 };
  };
  const roomCentre = (r: BuildingRoom) => {
    const b = PLAN.rooms[r];
    return new Vector3(b.x + b.w / 2, 0, b.z + b.d / 2);
  };

  function draw() {
    const now = performance.now();
    if (tween) {
      const k = Math.min(1, (now - tween.start) / TWEEN_MS);
      const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(tween.from.p, tween.to.p, ease);
      controls.target.lerpVectors(tween.from.t, tween.to.t, ease);
      camera.lookAt(controls.target);
      if (k >= 1) {
        tween = undefined;
        controls.update();
        pacer.animating("camera", false);
      }
    }
    if (walks) walks = place(now);
    const { typingFps } = QUALITY[quality];
    pacer.animating("typing", figures.animate(now, moves, 1000 / typingFps), typingFps);
    renderer.render(scene, camera);
    renderer.getSize(size);
    const tags = new Map<string, ReturnType<typeof toScreen>>();
    floor?.characters.forEach((c, i) => tags.set(c.key, toScreen(figures.tagAt(i, tag))));
    const rooms = Object.fromEntries((Object.keys(PLAN.rooms) as BuildingRoom[]).map((r) => [r, toScreen(roomCentre(r).setY(0.05))])) as Record<BuildingRoom, ScreenPoint>;
    const labels = Array.from({ length: towerSize }, (_, i) => toScreen(tower.labelAt(i, tag)));
    events.onDrawn(tags, rooms, toScreen(new Vector3(12.6, 0.05, 0)), labels);
  }

  /** Moves the camera to `to` over TWEEN_MS, or at once when nothing may move. */
  const moveTo = (to: { p: Vector3; t: Vector3 }) => {
    if (!moves) {
      camera.position.copy(to.p);
      controls.target.copy(to.t);
      controls.update();
      return pacer.invalidate();
    }
    tween = { from: { p: camera.position.clone(), t: controls.target.clone() }, to, start: performance.now() };
    pacer.animating("camera", true);
  };

  // A click on a character picks it; a drag turns the camera and picks nothing.
  const raycaster = new Raycaster();
  const ndc = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  /** The nearest thing under the pointer: a character, a tower floor, or one walking out, which can't be picked. */
  type Under = { kind: "figure"; key: string } | { kind: "floor"; index: number } | { kind: "leaving" } | { kind: "nothing" };
  const under = (e: MouseEvent): Under => {
    raycaster.setFromCamera(ndc(e), camera);
    const hit = raycaster.intersectObjects([...figures.pickable, ...tower.pickable()], false)[0];
    if (!hit) return { kind: "nothing" };
    if (hit.object.userData.floor !== undefined) return { kind: "floor", index: hit.object.userData.floor as number };
    const key = hit.instanceId === undefined ? undefined : figures.keyAt(hit.instanceId);
    return key === undefined ? { kind: "leaving" } : { kind: "figure", key };
  };
  let down: { x: number; y: number } | undefined;
  const onDown = (e: PointerEvent) => void (down = { x: e.clientX, y: e.clientY });
  const onClick = (e: MouseEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const hit = under(e);
    if (hit.kind === "floor") return events.onFloor(hit.index);
    if (hit.kind !== "leaving") events.onPick(hit.kind === "figure" ? hit.key : undefined);
  };
  // Hover changes no frame, so it never goes through the pacer.
  let hovered: string | undefined;
  const hover = (key: string | undefined, pointer: boolean) => {
    canvas.style.cursor = pointer ? "pointer" : "";
    if (key !== hovered) events.onHover((hovered = key));
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return hover(undefined, false);
    const hit = under(e);
    hover(hit.kind === "figure" ? hit.key : undefined, hit.kind === "figure" || hit.kind === "floor");
  };
  const onLeave = () => hover(undefined, false);
  // A double click on a room zooms to it, keeping the direction the camera looks from.
  const onDouble = (e: MouseEvent) => {
    raycaster.setFromCamera(ndc(e), camera);
    const at = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
    const room = at && (Object.keys(PLAN.rooms) as BuildingRoom[]).find((r) => {
      const b = PLAN.rooms[r];
      return at.x >= b.x && at.x <= b.x + b.w && at.z >= b.z && at.z <= b.z + b.d;
    });
    if (!room) return;
    const b = PLAN.rooms[room];
    const t = roomCentre(room);
    const dir = camera.position.clone().sub(controls.target).normalize();
    moveTo({ t, p: t.clone().add(dir.multiplyScalar(Math.max(MIN_DISTANCE, Math.max(b.w, b.d) * 1.15))) });
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    pacer.dispose();
    events.onLost("The graphics card stopped drawing the office (its WebGL context was lost).");
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("webglcontextlost", onLost);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pacer.invalidate();
  };
  const watch = new ResizeObserver(resize);
  watch.observe(canvas);
  resize();

  return {
    setFloor(next, profile) {
      const t = performance.now();
      floor = next;
      crowd.set(next.characters, profile, t, walking());
      walks = place(t);
      pacer.animating("typing", moves && next.characters.some((c) => c.pose === "typing" && !c.stale), QUALITY[quality].typingFps);
      pacer.invalidate();
    },
    setTower(floors) {
      towerSize = floors.length;
      tower.set(floors);
      pacer.invalidate();
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      building.recolor(mode);
      tower.recolor(mode);
      paint();
      pacer.invalidate();
    },
    setMotion(next) {
      moves = next;
      if (!moves) pacer.animating("typing", false);
      if (!walking()) {
        crowd.stop();
        walks = place(performance.now());
      }
      pacer.invalidate();
    },
    setQuality(next) {
      quality = next;
      pacer.setMaxFps(QUALITY[quality].maxFps);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[quality].maxDpr));
      if (!walking()) {
        crowd.stop();
        walks = place(performance.now());
      }
      resize();
    },
    setSelected(key) {
      figures.select(key);
      pacer.invalidate();
    },
    resetCamera: () => moveTo({ p: HOME.position.clone(), t: HOME.target.clone() }),
    setAwake: (awake) => pacer.setAwake(awake),
    dispose() {
      pacer.dispose();
      watch.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.style.cursor = "";
      canvas.removeEventListener("dblclick", onDouble);
      canvas.removeEventListener("webglcontextlost", onLost);
      building.dispose();
      tower.dispose();
      figures.dispose();
      renderer.dispose();
      // dispose() keeps the WebGL context, and WebKit holds each one until it is lost: free it, so opening the office
      // again and again never runs into the browser's limit on contexts. No lost-listener is left to ask it back.
      renderer.forceContextLoss();
    },
  };
}
