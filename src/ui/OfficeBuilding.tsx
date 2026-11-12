// The office as a 3D building (ADR 0122): the canvas three.js draws on, the agents' name tags over it, the tower of
// the other profiles' floors, and the card of the one picked. three.js loads with the scene (office3d/scene.ts) the
// first time this mounts, as its own chunk. Where everyone stands is officeFloors's to say; the scene only draws it.
// The tags are real buttons named as List names its rows, so the building and List read the same to a screen reader
// and the arrow keys move between them.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { RotateCcw } from "lucide-react";
import type { Desk, Room } from "../hermes/office";
import { getUIPrefs, subscribe } from "../hermes/uiPrefs";
import { EMPTY_BUILDING_MEMORY, EMPTY_FLOOR_MEMORY, ROOM_OF, TEAM_COLORS, officeFloors, type BuildingMemory, type BuildingRoom, type Floor } from "../hermes/officeFloor";
import type { OfficeScene, ScreenPoint } from "./office3d/scene";
import { OfficeCard } from "./OfficeCard";
import { OfficeQualitySwitch } from "./OfficeSettings";
import { deskLabel } from "./officeText";
import { usePageHidden, useWindowFocused } from "./windowState";
import { errorText } from "../hermes/values";

const HEAD_TO_TAG_GRACE_MS = 250;

const ROOM_NAME: Record<BuildingRoom, string> = { workroom: "Workroom", waiting: "Waiting room", trouble: "Trouble room", lounge: "Lounge" };

/** Why this computer can't draw the building, or undefined when it can. Asked before three.js is fetched. */
export function webglMissing(): string | undefined {
  if (typeof WebGLRenderingContext === "undefined") return "This computer's web view has no WebGL, which the building needs.";
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "This computer's graphics didn't offer WebGL, which the building needs.";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return undefined;
  } catch {
    return "This computer's graphics didn't offer WebGL, which the building needs.";
  }
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)");
const subscribeMotion = (fn: () => void) => {
  const q = reducedMotion();
  q?.addEventListener?.("change", fn);
  return () => q?.removeEventListener?.("change", fn);
};
const subscribeMode = (fn: () => void) => {
  const watch = new MutationObserver(fn);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => watch.disconnect();
};
const modeNow = () => (document.documentElement.dataset.mode === "light" ? "light" : "dark");

/**
 * What changes the picture: who stands where, how, in which color, and whether "+N more" is there (a frame places it).
 * Text on the tags and the card changes no frame.
 */
const pictureOf = (f: Floor) => f.characters.map((c) => `${c.key}|${c.spot.x},${c.spot.z}|${c.pose}|${c.color}|${c.stale ? 1 : 0}`).join(";") + (f.more > 0 ? ";more" : "");

/** A tag's text: a subagent's name; for a chat's reply, which all share one name, the chat's title. */
const tagText = (room: Room, d: Desk) => (d.agent.kind === "reply" ? room.title : d.name);

const NO_ONE: Floor = { characters: [], more: 0, memory: EMPTY_FLOOR_MEMORY };

type Size = { w: number; h: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where the tower's floor labels go, from where their floors are on screen, the bottom floor first. Each stays as near
 * its floor as it can while no two labels (each at most `tag` big, centred on its point) touch and all of them are
 * inside the `canvas`. A column holds as many as fit between the bottom floor and the canvas's top, so labels don't
 * slide down over the building; the rest go on in more columns beside it, toward the nearer edge (away from the
 * building in the middle) when they fit there. All show while any floor does, so a floor above the canvas's top edge
 * keeps a label inside it.
 */
export function towerLabels(at: readonly ScreenPoint[], tag: Size, canvas: Size): ScreenPoint[] {
  if (!at.length) return [];
  const w = tag.w + 2;
  const h = tag.h + 2;
  const above = Math.floor((clamp(at[0].y, h / 2, canvas.h - h / 2) + h / 2) / h);
  const rows = clamp(above, Math.ceil(at.length / Math.max(1, Math.floor(canvas.w / w))), Math.max(1, Math.floor(canvas.h / h)));
  const cols = Math.ceil(at.length / rows);
  const nearer = at[0].x < canvas.w / 2 ? -1 : 1;
  const fits = (dir: number) => (dir < 0 ? at[0].x - w / 2 : canvas.w - w / 2 - at[0].x) >= (cols - 1) * w;
  const step = (fits(nearer) || !fits(-nearer) ? nearer : -nearer) * w;
  const x0 = clamp(at[0].x, w / 2 + Math.max(0, -step) * (cols - 1), canvas.w - w / 2 - Math.max(0, step) * (cols - 1));
  const off = at.every((p) => p.off);
  // A later column's labels sit beside the first column's. Up each column: no lower than the canvas's foot or a label
  // above the one below. Then down: no higher than the canvas's top or a label below the one above. Both fit.
  const ys = at.map((_, i) => at[i % rows].y);
  for (let i = 0; i < ys.length; i++) ys[i] = Math.min(ys[i], i % rows ? ys[i - 1] - h : canvas.h - h / 2);
  for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.max(ys[i], i % rows === rows - 1 || i === ys.length - 1 ? h / 2 : ys[i + 1] + h);
  return at.map((p, i) => ({ x: cols === 1 ? clamp(p.x, w / 2, canvas.w - w / 2) : x0 + Math.floor(i / rows) * step, y: ys[i], off }));
}

/**
 * What the building keeps while it is closed: who sits where on each floor, and the floor it last drew. Opened again,
 * it starts from that picture, so an agent that left meanwhile, its entry dismissed in the inbox, walks out of it.
 */
export type OfficeMemory = { floors: BuildingMemory; last?: { floor: Floor; profile: string } };
export const EMPTY_OFFICE_MEMORY: OfficeMemory = { floors: EMPTY_BUILDING_MEMORY };

/** A floor in the tower: its profile, how many agents are on it, and whether one there waits for the owner or failed. */
type TowerFloor = { profile: string; agents: number; lit: boolean };
const needsOwner = (r: Room) => r.desks.some((d) => ROOM_OF[d.state] === "waiting" || ROOM_OF[d.state] === "trouble");

export function OfficeBuilding({
  rooms,
  memory,
  profile,
  profiles,
  onOpen,
  onFallback,
  onMore,
}: {
  rooms: readonly Room[];
  /** Who sits where, kept by the app: an agent keeps its desk while the building is unmounted and drawn again. */
  memory: RefObject<OfficeMemory>;
  /** The profile the app shows, whose floor opens first. */
  profile: string;
  /** The server's other profiles, as far as the app knows them: a floor each, even with no agent on it. */
  profiles: readonly string[];
  onOpen: (room: Room, desk: Desk) => void;
  /** The building can't be drawn here, and why: the office shows List instead. */
  onFallback: (why: string) => void;
  /** "+N more": show every agent, in List. */
  onMore: () => void;
}) {
  /** Bumped when an agent is due to go home, so the floors are worked out again then. */
  const [wake, setWake] = useState(0);
  const built = useMemo(() => {
    const b = officeFloors(rooms, memory.current.floors, Date.now());
    memory.current = { ...memory.current, floors: b.memory };
    return b;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `wake` is a trigger, not an input: bumping it works the floors out again at the new `Date.now()`
  }, [rooms, memory, wake]);
  useEffect(() => {
    if (built.wakeAt === undefined) return;
    const t = setTimeout(() => setWake((n) => n + 1), Math.max(0, built.wakeAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [built.wakeAt]);

  // Every profile is a floor: the one looked at is open, the others are the tower's, the app's own at the bottom.
  const [looked, setLooked] = useState(() => memory.current.last?.profile);
  const names = [...new Set([profile, ...[...profiles, ...rooms.map((r) => r.profile)].sort((a, b) => a.localeCompare(b))])];
  const opened = looked !== undefined && names.includes(looked) ? looked : profile;
  const floor = built.floors.get(opened) ?? NO_ONE;
  const tower: TowerFloor[] = names
    .filter((p) => p !== opened)
    .map((p) => {
      const f = built.floors.get(p);
      return { profile: p, agents: f ? f.characters.length + f.more : 0, lit: rooms.some((r) => r.profile === p && needsOwner(r)) };
    });
  const towerNow = useRef(tower);
  towerNow.current = tower;
  // All a floor's label says, so a frame lays the labels out again whenever one may change size.
  const towerLabelsSay = tower.map((t) => `${t.profile}|${t.agents}|${t.lit ? 1 : 0}`).join(";");

  const picture = `${opened}:${pictureOf(floor)}`;
  const latest = useRef({ floor, opened });
  latest.current = { floor, opened };

  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, HTMLElement>());
  const roomTags = useRef(new Map<BuildingRoom, HTMLElement>());
  const floorTags = useRef<(HTMLElement | null)[]>([]);
  const more = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState<OfficeScene>();
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const letGo = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = useCallback((key: string | undefined) => {
    clearTimeout(letGo.current);
    if (key !== undefined) setHovered(key);
    else letGo.current = setTimeout(() => setHovered(undefined), HEAD_TO_TAG_GRACE_MS);
  }, []);
  useEffect(() => () => clearTimeout(letGo.current), []);
  const mode = useSyncExternalStore(subscribeMode, modeNow);
  const moves = !useSyncExternalStore(subscribeMotion, () => !!reducedMotion()?.matches);
  const { officeQuality: quality } = useSyncExternalStore(subscribe, getUIPrefs);
  const focused = useWindowFocused();
  const pageHidden = usePageHidden();
  const awake = focused && !pageHidden;
  const fallback = useRef(onFallback);
  fallback.current = onFallback;

  useEffect(() => {
    const why = webglMissing();
    if (why) return fallback.current(why);
    let live = true;
    let made: OfficeScene | undefined;
    // Written only when it moved: while agents type and the camera stays, a frame changes nothing on the page.
    const place = (el: HTMLElement | null | undefined, p: ScreenPoint) => {
      if (!el) return;
      const at = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px)`;
      if (el.style.transform !== at) el.style.transform = at;
      if (el.hasAttribute("data-off") !== p.off) el.toggleAttribute("data-off", p.off);
    };
    import("./office3d/scene")
      .then(({ mountOfficeScene }) => {
        if (!live || !canvas.current) return;
        made = mountOfficeScene(
          canvas.current,
          {
            onPick: setSelected,
            onHover: hover,
            onFloor: (i) => towerNow.current[i] && setLooked(towerNow.current[i].profile),
            onDrawn(at, rooms, door, floors) {
              for (const [key, p] of at) place(tags.current.get(key), p);
              for (const [r, p] of Object.entries(rooms) as [BuildingRoom, ScreenPoint][]) place(roomTags.current.get(r), p);
              place(more.current, door);
              const labels = floorTags.current.slice(0, floors.length);
              const tag = { w: Math.max(0, ...labels.map((el) => el?.offsetWidth ?? 0)), h: Math.max(0, ...labels.map((el) => el?.offsetHeight ?? 0)) };
              const box = { w: canvas.current?.clientWidth ?? 0, h: canvas.current?.clientHeight ?? 0 };
              towerLabels(floors, tag, box).forEach((p, i) => place(labels[i], p));
            },
            // The frame counter, for proof that nothing draws while nothing moves. Written straight to the page.
            onFrame: (n) => host.current?.setAttribute("data-frames", String(n)),
            onLost: (why) => live && fallback.current(why),
          },
          { mode: modeNow(), moves: !reducedMotion()?.matches, quality: getUIPrefs().officeQuality },
        );
        setScene(made);
      })
      .catch((e: unknown) => live && fallback.current(`The building couldn't be loaded: ${errorText(e)}`));
    return () => {
      live = false;
      made?.dispose();
    };
  }, [hover]);

  const started = useRef<OfficeScene>(undefined);
  useEffect(() => {
    if (!scene) return;
    const { floor, opened } = latest.current;
    const last = memory.current.last;
    if (started.current !== scene && last) scene.setFloor(last.floor, last.profile);
    started.current = scene;
    scene.setFloor(floor, opened);
    memory.current = { ...memory.current, last: { floor, profile: opened } };
  }, [scene, picture, memory]);
  useEffect(() => scene?.setTower(towerNow.current), [scene, towerLabelsSay]);
  useEffect(() => scene?.setMode(mode), [scene, mode]);
  useEffect(() => scene?.setMotion(moves), [scene, moves]);
  useEffect(() => scene?.setQuality(quality), [scene, quality]);
  useEffect(() => scene?.setAwake(awake), [scene, awake]);
  useEffect(() => scene?.setSelected(selected), [scene, selected]);

  const picked = floor.characters.find((c) => c.key === selected);
  // An agent that leaves the floor takes its selection with it, so its card can't open again by itself if it comes back.
  // Cleared during render: React draws again before the card mounts and takes focus.
  if (selected !== undefined && !picked) setSelected(undefined);
  const close = () => {
    const key = selected;
    setSelected(undefined);
    if (key) tags.current.get(key)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && picked) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={host} className="office-building" data-frames="0" onKeyDown={onKeyDown}>
      {/* Focusable, so after a click on it the office's keys, Escape among them, still reach it. */}
      <canvas ref={canvas} className="office-canvas" aria-hidden tabIndex={-1} />
      {!scene ? (
        <div className="office-note inbox-note">Opening the building…</div>
      ) : (
        floor.characters.length === 0 &&
        floor.more === 0 && (
          <div className="office-note inbox-note">
            {rooms.some((r) => r.profile === opened)
              ? "No agent is on this floor. Finished agents go home 30 minutes after their last change, or once dismissed in the inbox. List shows every agent."
              : rooms.length > 0
                ? "No agent is on this floor."
                : "No agent is at work. One shows here while a reply runs, waits for you or failed, and for each subagent it starts."}
          </div>
        )
      )}
      <div className="office-overlay">
        {(Object.keys(ROOM_NAME) as BuildingRoom[]).map((r) => (
          <span key={r} className="office-room-label" aria-hidden data-off ref={(el) => void (el ? roomTags.current.set(r, el) : roomTags.current.delete(r))}>
            {ROOM_NAME[r]}
          </span>
        ))}
        <div className="office-tags" role="group" aria-label="Agents in the building">
          {floor.characters.map((c) => (
            <button
              key={c.key}
              className={`office-tag state-${c.desk.state}${c.stale ? " is-stale" : ""}${c.key === selected ? " on" : ""}`}
              style={{ borderColor: TEAM_COLORS[c.color] }}
              data-desk={c.key}
              data-off
              data-hover={c.key === hovered ? "" : undefined}
              aria-label={deskLabel(c.room, c.desk, profile)}
              aria-haspopup="dialog"
              ref={(el) => void (el ? tags.current.set(c.key, el) : tags.current.delete(c.key))}
              onClick={() => setSelected(c.key)}
              onPointerEnter={() => hover(c.key)}
              // Straight from the head onto its tag, React's enter comes before the canvas's own leave lets go of the
              // character; the move that follows both keeps the tag.
              onPointerMove={() => hover(c.key)}
              onPointerLeave={() => hover(undefined)}
            >
              <span className="office-dot" aria-hidden />
              <span className="office-tag-name">{tagText(c.room, c.desk)}</span>
            </button>
          ))}
        </div>
        {tower.length > 0 && (
          <div className="office-floors" role="group" aria-label="The other profiles' floors">
            {tower.map((t, i) => (
              <button
                key={t.profile}
                className={`office-floor-tag${t.lit ? " lit" : ""}`}
                data-off
                ref={(el) => void (floorTags.current[i] = el)}
                aria-label={`${t.profile}: ${t.agents} agent${t.agents === 1 ? "" : "s"}${t.lit ? ", one needs you" : ""}. Look at its floor.`}
                onClick={() => setLooked(t.profile)}
              >
                <span className="office-floor-name">{t.profile}</span>
                <span className="office-floor-count">{t.agents}</span>
                {t.lit && (
                  <span className="office-floor-alert" aria-hidden>
                    !
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {floor.more > 0 && (
          <button ref={more} className="office-more" data-off onClick={onMore} aria-label={`${floor.more} more agents aren't drawn. Show them all in List.`}>
            +{floor.more} more
          </button>
        )}
      </div>
      <div className="office-tools">
        <span className="office-floor-open" role="status">
          {opened === profile ? `${opened}'s floor` : `${opened}'s floor, looked at from ${profile}`}
        </span>
        <span className="office-hint">Drag to turn · scroll to zoom · double-click a room</span>
        <OfficeQualitySwitch aria-label="Office quality" />
        <button className="btn" onClick={() => scene?.resetCamera()} disabled={!scene}>
          <RotateCcw size={13} aria-hidden /> Reset view
        </button>
      </div>
      {picked && (
        <OfficeCard room={picked.room} desk={picked.desk} profile={profile} color={TEAM_COLORS[picked.color]} onOpen={() => onOpen(picked.room, picked.desk)} onClose={close} />
      )}
    </div>
  );
}
