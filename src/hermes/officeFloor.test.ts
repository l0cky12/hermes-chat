import { describe, expect, it } from "vitest";
import type { Desk, DeskState, Room } from "./office";
import { EMPTY_BUILDING_MEMORY, EMPTY_FLOOR_MEMORY, FLOOR_CAP, HOME_AFTER_MS, PLAN, POD_SIZE, ROOM_OF, TEAM_COLORS, officeFloor, officeFloors, type Floor, type FloorMemory } from "./officeFloor";

/** When each floor is laid out, as Unix ms. */
const NOW = Date.UTC(2026, 10, 7, 12);

/** A chat's team: its reply's state first, then its subagents'. */
function team(key: string, ...states: DeskState[]): Room {
  const desks: Desk[] = states.map((state, i) =>
    i === 0
      ? { key: `${key} reply`, agent: { kind: "reply" }, name: "The chat's reply", state }
      : ({ key: `${key} sa-${i}`, agent: { kind: "subagent", id: `sa-${i}`, depth: 0 }, name: `Goal ${i}`, state } as Desk),
  );
  return { key, profile: "default", chatId: key, title: key, desks };
}

const at = (f: Floor, key: string) => f.characters.find((c) => c.key === key);
const placeOf = (f: Floor, key: string) => at(f, key) && `${at(f, key)!.place}/${at(f, key)!.pose}`;
const spotOf = (f: Floor, key: string) => at(f, key)?.spot;
/** Each team's Workroom desks, as the pods they fall in. */
const podsOf = (f: Floor, teamKey: string) =>
  [...new Set(f.characters.filter((c) => c.room.key === teamKey && c.pose === "typing").map((c) => Math.floor(PLAN.seats.workroom.indexOf(c.spot) / POD_SIZE)))].sort();

describe("The office floor", () => {
  it("puts each agent in the room its state gives, posed for it", () => {
    const f = officeFloor([team("a", "running", "queued", "handedOff", "approval", "uncertain", "failed", "completed", "unread", "stopped", "ended", "idle", "unknown")], EMPTY_FLOOR_MEMORY, NOW);
    expect(f.characters.map((c) => `${c.desk.state}: ${c.place}/${c.pose}`)).toEqual([
      "running: workroom/typing",
      "queued: workroom/door",
      "handedOff: workroom/seated",
      "approval: waiting/hand-up",
      "uncertain: waiting/hand-up",
      "failed: trouble/slumped",
      "completed: lounge/couch",
      "unread: lounge/couch",
      "stopped: lounge/couch",
      "ended: lounge/couch",
      "idle: lounge/couch",
      "unknown: lounge/couch",
    ]);
    expect(f.more).toBe(0);
  });

  it("has a room for every state, and no two agents in one seat", () => {
    const states = Object.keys(ROOM_OF) as DeskState[];
    const f = officeFloor([team("a", ...states, ...states), team("b", "running", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    const spots = f.characters.map((c) => `${c.spot.x},${c.spot.z}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it("seats a reply waiting on handed-off work at its team's desks, with the subagents it waits on", () => {
    const f = officeFloor([team("a", "handedOff", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    expect(f.characters.map((c) => c.pose)).toEqual(["seated", "typing", "typing"]);
    expect(new Set(f.characters.map((c) => Math.floor(PLAN.seats.workroom.indexOf(c.spot) / POD_SIZE)))).toEqual(new Set([0]));
    expect(new Set(f.characters.map((c) => c.color)).size).toBe(1);
  });

  it("seats a chat that delegated to two subagents at one group of Workroom desks, in its team's color", () => {
    const f = officeFloor([team("a", "running", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    expect(f.characters.map((c) => c.pose)).toEqual(["typing", "typing", "typing"]);
    expect(podsOf(f, "a")).toEqual([0]);
    expect(new Set(f.characters.map((c) => c.color)).size).toBe(1);
  });

  it("keeps a team at its desks when another team starts or stops before it", () => {
    const first = officeFloor([team("b", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    const both = officeFloor([team("a", "running", "running", "running", "running", "running"), team("b", "running", "running")], first.memory, NOW);
    expect(spotOf(both, "b reply")).toEqual(spotOf(first, "b reply"));
    expect(spotOf(both, "b sa-1")).toEqual(spotOf(first, "b sa-1"));
    expect(podsOf(both, "a")).toEqual([1, 2]);
    const alone = officeFloor([team("a", "completed", "running", "completed", "completed", "completed"), team("b", "running", "running")], both.memory, NOW);
    expect(spotOf(alone, "b reply")).toEqual(spotOf(first, "b reply"));
    expect(spotOf(alone, "a sa-1")).toEqual(spotOf(both, "a sa-1"));
  });

  it("keeps an agent at its desk when a teammate ahead of it finishes", () => {
    const busy = officeFloor([team("a", "running", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    const later = officeFloor([team("a", "running", "completed", "running")], busy.memory, NOW);
    expect(spotOf(later, "a sa-2")).toEqual(spotOf(busy, "a sa-2"));
    expect(placeOf(later, "a sa-1")).toBe("lounge/couch");
  });

  it("keeps a team's pod while only a queued agent works, and lets it go once none does", () => {
    const busy = officeFloor([team("z", "running"), team("a", "running", "running")], EMPTY_FLOOR_MEMORY, NOW);
    expect(podsOf(busy, "a")).toEqual([1]);
    const queued = officeFloor([team("a", "queued", "completed"), team("z", "completed")], busy.memory, NOW);
    expect(queued.memory.pods.get("a")).toEqual([1]);
    expect(queued.memory.pods.has("z")).toBe(false);
    const back = officeFloor([team("a", "running", "completed"), team("y", "running")], queued.memory, NOW);
    expect(podsOf(back, "a")).toEqual([1]);
    expect(podsOf(back, "y")).toEqual([0]);
    const done = officeFloor([team("a", "completed")], back.memory, NOW);
    expect(done.memory.pods.size).toBe(0);
  });

  it("stands queued agents in line at the Workroom door", () => {
    const f = officeFloor([team("a", "running", "queued", "queued")], EMPTY_FLOOR_MEMORY, NOW);
    expect([spotOf(f, "a sa-1"), spotOf(f, "a sa-2")]).toEqual([PLAN.door[0], PLAN.door[1]]);
  });

  it("gives each team its own color, keeps it while the team is on the floor, and reuses one only once all are worn", () => {
    const keys = Array.from({ length: TEAM_COLORS.length + 1 }, (_, i) => `t${i}`);
    const f = officeFloor(keys.map((k) => team(k, "completed")), EMPTY_FLOOR_MEMORY, NOW);
    const colors = f.characters.map((c) => c.color);
    expect(new Set(colors.slice(0, TEAM_COLORS.length)).size).toBe(TEAM_COLORS.length);
    expect(colors[TEAM_COLORS.length]).toBe(0);
    const later = officeFloor([team("new", "running"), team("t5", "completed")], f.memory, NOW);
    expect(at(later, "t5 reply")!.color).toBe(5);
    expect(at(later, "new reply")!.color).toBe(0);
  });

  it("draws 40 at most, counting the rest, and never leaves out one that needs the owner for one that doesn't", () => {
    const lounge = Array.from({ length: 30 }, (_, i) => team(`done${i}`, "completed"));
    const f = officeFloor([...lounge, team("busy", "running", "running"), team("ask", "approval"), team("broke", "failed")], EMPTY_FLOOR_MEMORY, NOW);
    expect(f.characters.length).toBe(20);
    // 16 couch seats: the other 14 finished agents aren't drawn.
    expect(f.more).toBe(14);
    expect(["busy reply", "busy sa-1", "ask reply", "broke reply"].every((k) => at(f, k))).toBe(true);

    const many = Array.from({ length: 50 }, (_, i) => team(`w${i}`, i % 2 ? "approval" : "running"));
    const big = officeFloor(many, EMPTY_FLOOR_MEMORY, NOW);
    expect(big.characters.length).toBeLessThanOrEqual(FLOOR_CAP);
    expect(big.characters.length + big.more).toBe(50);
    expect(big.characters.filter((c) => c.place === "waiting").length).toBe(PLAN.seats.waiting.length);
  });

  it("stands running agents at the door when every pod is held, and counts those past the line", () => {
    const teams = Array.from({ length: 12 }, (_, i) => team(`t${i}`, "running"));
    const f = officeFloor(teams, EMPTY_FLOOR_MEMORY, NOW);
    expect(f.characters.filter((c) => c.pose === "typing").length).toBe(10);
    expect(f.characters.filter((c) => c.pose === "door").map((c) => c.key)).toEqual(["t10 reply", "t11 reply"]);
  });

  it("marks stale agents, so they are greyed and frozen", () => {
    const r = team("a", "running");
    r.desks[0].stale = "Not connected to Hermes: as last seen.";
    expect(officeFloor([r], EMPTY_FLOOR_MEMORY, NOW).characters[0].stale).toBe(true);
  });

  it("returns the same memory when nothing changed, and the same floor for the same rooms and memory", () => {
    const rooms = [team("a", "running", "running"), team("b", "approval")];
    const first = officeFloor(rooms, EMPTY_FLOOR_MEMORY, NOW);
    const again = officeFloor(rooms, first.memory, NOW);
    expect(again.memory).toBe(first.memory);
    expect(again.characters.map((c) => [c.key, c.spot, c.color])).toEqual(first.characters.map((c) => [c.key, c.spot, c.color]));
    const blank: FloorMemory = EMPTY_FLOOR_MEMORY;
    expect(officeFloor([], blank, NOW).memory).toBe(blank);
  });
});

describe("Going home", () => {
  const MIN = 60_000;
  const keys = (f: Floor) => f.characters.map((c) => c.key);
  /** A chat's reply in state `state`, which last did something at `at`. */
  const reply = (key: string, state: DeskState, at = 0, more: Partial<Desk> = {}): Room => {
    const r = team(key, state);
    r.desks[0] = { ...r.desks[0], ...(at && { doing: { text: "Something.", at } }), ...more };
    return r;
  };

  it("sends a Lounge agent home 30 minutes after it last changed state, and says when that will be", () => {
    const finished = officeFloor([reply("a", "unread", NOW - 20 * MIN)], EMPTY_FLOOR_MEMORY, NOW);
    expect(keys(finished)).toEqual(["a reply"]);
    expect(finished.wakeAt).toBe(NOW - 20 * MIN + HOME_AFTER_MS);
    const later = officeFloor([reply("a", "unread", NOW - 20 * MIN)], finished.memory, NOW + 10 * MIN);
    expect(keys(later)).toEqual([]);
    expect(later.more).toBe(0);
    expect(later.wakeAt).toBeUndefined();
  });

  it("counts from when the app saw the state change, not from what the agent last did before it", () => {
    const working = officeFloor([reply("a", "running", NOW - 3 * HOME_AFTER_MS)], EMPTY_FLOOR_MEMORY, NOW);
    const done = officeFloor([reply("a", "stopped", NOW - 3 * HOME_AFTER_MS)], working.memory, NOW + MIN);
    expect(keys(done)).toEqual(["a reply"]);
    expect(done.wakeAt).toBe(NOW + MIN + HOME_AFTER_MS);
    expect(keys(officeFloor([reply("a", "stopped")], done.memory, NOW + MIN + HOME_AFTER_MS))).toEqual([]);
  });

  it("never sends home an agent at work, waiting for the owner, or failed, however long it has been", () => {
    const long = NOW - 10 * HOME_AFTER_MS;
    const f = officeFloor([reply("w", "running", long), reply("q", "approval", long), reply("u", "uncertain", long), reply("x", "failed", long)], EMPTY_FLOOR_MEMORY, NOW);
    expect(keys(f)).toEqual(["w reply", "q reply", "u reply", "x reply"]);
    expect(f.wakeAt).toBeUndefined();
  });

  it("sends a reply home at once when the owner dismissed its inbox entry", () => {
    const f = officeFloor([reply("a", "idle", 0, { agent: { kind: "reply", dismissed: true } }), reply("b", "idle")], EMPTY_FLOOR_MEMORY, NOW);
    expect(keys(f)).toEqual(["b reply"]);
  });

  it("brings an agent back when its state changes or its chat has something new", () => {
    const gone = officeFloor([reply("a", "unread", NOW - 2 * HOME_AFTER_MS), reply("b", "completed", NOW - 2 * HOME_AFTER_MS)], EMPTY_FLOOR_MEMORY, NOW);
    expect(keys(gone)).toEqual([]);
    const back = officeFloor([reply("a", "unread", NOW + MIN), reply("b", "running", NOW - 2 * HOME_AFTER_MS)], gone.memory, NOW + MIN);
    expect(keys(back)).toEqual(["a reply", "b reply"]);
  });

  it("gives each profile its own floor and memory, and keeps the memory when nothing changed", () => {
    const work = { ...team("w", "running", "running"), key: "work w", profile: "work" };
    const rooms = [team("a", "running"), work];
    const first = officeFloors(rooms, EMPTY_BUILDING_MEMORY, NOW);
    expect([...first.floors.keys()]).toEqual(["default", "work"]);
    expect(keys(first.floors.get("work")!)).toEqual(["w reply", "w sa-1"]);
    // Each floor has its own Workroom: both teams sit at the pod nearest the door.
    expect(first.floors.get("work")!.characters[0].spot).toEqual(first.floors.get("default")!.characters[0].spot);
    expect(officeFloors(rooms, first.memory, NOW).memory).toBe(first.memory);
    const waking = officeFloors([reply("a", "unread", NOW - 25 * MIN), { ...reply("w", "unread", NOW - 10 * MIN), profile: "work" }], EMPTY_BUILDING_MEMORY, NOW);
    expect(waking.wakeAt).toBe(NOW - 25 * MIN + HOME_AFTER_MS);
  });
});
