// @vitest-environment jsdom
// The agent office (ADR 0077, ADR 0089), from what a fake Hermes reports through the real transport: the building and
// the list show the same agents in the same states, named the same way, with the same Open chat, through a reply's
// run, Approval, failures, completion and a reconnect. Also the agent's card, "+N more", the list a computer without
// WebGL gets, the keyboard, reduced motion, the full view, and that it draws nothing while hidden. jsdom has no WebGL:
// the building's tests stand in a WebGL context and a scene that records what it was told to draw.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { inboxEntries } from "../hermes/inbox";
import { officeRooms, type Room } from "../hermes/office";
import type { Floor } from "../hermes/officeFloor";
import { SUBAGENTS_MAX, onSubagentEvent, type SubagentTree } from "../hermes/subagents";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";
import { Office } from "./Office";
import { EMPTY_OFFICE_MEMORY, unstacked } from "./OfficeBuilding";
import { setWindowHidden } from "./windowState";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

/** The scene the building mounted last, and what it was told. */
const drawn = vi.hoisted(() => ({
  mounts: 0,
  scene: undefined as undefined | { floors: string[]; floor?: Floor; profile?: string; tower?: readonly { lit: boolean }[]; moves?: boolean; awake?: boolean; selected?: string; resets: number; disposed: boolean },
}));
vi.mock("./office3d/scene", () => ({
  mountOfficeScene: (_canvas: HTMLCanvasElement, _events: unknown, start: { moves: boolean }) => {
    drawn.mounts++;
    const s: NonNullable<typeof drawn.scene> = { floors: [], moves: start.moves, resets: 0, disposed: false };
    drawn.scene = s;
    return {
      setFloor: (f: Floor, profile: string) => void ((s.floor = f), (s.profile = profile), s.floors.push(`${profile}: ${f.characters.map((c) => c.key).join(", ")}`)),
      setTower: (t: readonly { lit: boolean }[]) => void (s.tower = t),
      setMode: () => {},
      setMotion: (m: boolean) => void (s.moves = m),
      setSelected: (k?: string) => void (s.selected = k),
      resetCamera: () => void s.resets++,
      setAwake: (a: boolean) => void (s.awake = a),
      dispose: () => void (s.disposed = true),
    };
  },
}));

/** The floor memory the app keeps for the office, new. */
const fresh = () => ({ current: EMPTY_OFFICE_MEMORY });

/** This computer has WebGL, as far as the office's check can tell. */
function withWebGL() {
  vi.stubGlobal("WebGLRenderingContext", class {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getExtension: () => ({ loseContext() {} }) } as never);
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
beforeEach(() => {
  drawn.mounts = 0;
  drawn.scene = undefined;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWindowHidden(false);
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const who = (subagent_id: string, goal: string, more: Record<string, unknown> = {}) => ({ goal, task_count: 1, task_index: 0, subagent_id, depth: 0, model: "claude-sonnet-4-5", ...more });

/** The office's rooms for the app's snapshot now, as App works them out. */
function roomsOf(hermes: Hermes): { rooms: Room[]; connected: boolean } {
  const s = hermes.getSnapshot();
  const connected = s.status === "connected";
  const { entries } = inboxEntries({ profile: s.profile, chats: s.chats, connected, others: s.others, live: s.live });
  return { rooms: officeRooms({ entries, shown: () => true, chats: s.chats, profile: s.profile, connected }), connected };
}

type View = "building" | "list";
const agents = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-desk]"));

/**
 * Every agent's accessible name, and where Open chat goes for each, in one view. In the building an agent opens its
 * card, and the card's Open chat opens the chat; in the list the row opens it.
 */
function seen({ rooms, connected }: { rooms: Room[]; connected: boolean }, view: View) {
  if (view === "building") withWebGL();
  const onOpen = vi.fn();
  const { unmount } = render(<Office floorMemory={fresh()} rooms={rooms} view={view} onView={() => {}} server="hermes" profile="default" connected={connected} onOpen={onOpen} onClose={() => {}} />);
  const labels = agents().map((d) => d.getAttribute("aria-label")!);
  for (const d of agents()) {
    fireEvent.click(d);
    if (view === "building") fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  }
  const opened = onOpen.mock.calls.map(([r, d]) => `${r.chatId} ${d.agent.kind === "subagent" ? d.agent.id : "reply"}`);
  unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  return { labels, opened };
}

/** Both views agree, and each agent's state as its name says it. */
function states(hermes: Hermes): string[] {
  const now = roomsOf(hermes);
  const building = seen(now, "building");
  expect(seen(now, "list")).toEqual(building);
  return building.labels.map((l) => l.split(", in “")[0].replace(/, started by “[^”]*”$/, ""));
}

describe("The building and the list", () => {
  it("show the same agents, states and actions through a run, an Approval, failures, a completion and a reconnect", async () => {
    vi.useFakeTimers();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Audit the repo");
    const runtime = server.runtimeIdOf(id)!;

    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("sa-auth", "Read the auth code", { delegation_id: "d1" }));
    server.event(runtime, "subagent.spawn_requested", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.start", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1 }));
    expect(states(hermes)).toEqual(["The chat's reply, Running", "Read the auth code, Running", "Check token expiry, Running", "Read the tests, Queued"]);
    expect(seen(roomsOf(hermes), "building").opened).toEqual([`${id} reply`, `${id} sa-auth`, `${id} sa-expiry`, `${id} sa-tests`]);

    const asked = server.askApproval(runtime);
    await hermes.idle();
    expect(states(hermes)[0]).toBe("The chat's reply, Waiting for your approval");
    server.cancelRequest(asked.id!, "timeout");
    await hermes.idle();
    expect(states(hermes)[0]).toBe("The chat's reply, Running");

    server.event(runtime, "subagent.start", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.complete", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2, status: "failed", summary: "Rate limited." }));
    server.event(runtime, "subagent.complete", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1, status: "completed", summary: "Tokens expire in 1h." }));
    expect(states(hermes).slice(1)).toEqual(["Read the auth code, Running", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    server.drop();
    await hermes.idle().catch(() => {});
    expect(states(hermes)).toEqual([
      "The chat's reply, Not known yet, as last seen",
      "Read the auth code, Running, as last seen",
      "Check token expiry, Finished, as last seen",
      "Read the tests, Failed, as last seen",
    ]);
    withWebGL();
    render(<Office floorMemory={fresh()} {...roomsOf(hermes)} view="building" onView={() => {}} server="hermes" profile="default" onOpen={() => {}} onClose={() => {}} />);
    expect(document.querySelectorAll(".office-tag.is-stale")).toHaveLength(4);
    expect(screen.getByRole("region", { name: "Office" }).textContent).toMatch(/Not connected to Hermes: every agent is as last seen\./);
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    server.subagents[id] = [];
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(hermes.getSnapshot().status).toBe("connected");
    const back = states(hermes);
    expect(back.filter((s) => s.includes("as last seen"))).toEqual([]);
    expect(back.slice(1)).toEqual(["Read the auth code, Ended, Hermes didn't say how", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.event(server.runtimeIdOf(id)!, "message.start");
    server.event(server.runtimeIdOf(id)!, "message.complete", { status: "error", failure_reason: "provider timed out", text: "" });
    expect(states(hermes)[0]).toBe("The chat's reply, Failed");
  });

  it("show many agents: the building draws 40 named as the list names them, and counts the rest as more", async () => {
    const chats = Array.from({ length: 10 }, (_, n) => {
      let tree: SubagentTree | undefined;
      for (let i = 0; i < SUBAGENTS_MAX; i++)
        tree = onSubagentEvent(tree, i % 3 ? "subagent.complete" : "subagent.start", who(`s${i}`, `Task ${i}`, { status: "completed" }), Date.now());
      return { id: `c${n}`, title: `Chat ${n}`, source: "app" as const, settled: false, updatedAt: Date.now(), items: [], running: true, subagents: tree };
    });
    const { entries } = inboxEntries({ profile: "default", chats, connected: true, others: { byName: {} } });
    const rooms = officeRooms({ entries, shown: () => true, chats, profile: "default", connected: true });
    const list = seen({ rooms, connected: true }, "list");
    expect(list.labels).toHaveLength(10 * (SUBAGENTS_MAX + 1));
    expect(new Set(list.opened).size).toBe(list.opened.length);

    withWebGL();
    const user = userEvent.setup();
    render(<Office floorMemory={fresh()} rooms={rooms} view="building" onView={() => {}} server="hermes" profile="default" connected onOpen={() => {}} onClose={() => {}} />);
    const tags = agents().map((d) => d.getAttribute("aria-label")!);
    expect(tags).toHaveLength(40);
    expect(tags.every((t) => list.labels.includes(t))).toBe(true);
    const more = screen.getByRole("button", { name: `${list.labels.length - 40} more agents aren't drawn. Show them all in List.` });
    await user.click(more);
    expect(agents()).toHaveLength(list.labels.length);
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
  }, 20_000);

  it("keeps an agent only Hermes's own completion marks finished", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Audit the repo");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("a", "One"));
    server.event(runtime, "subagent.start", who("b", "Two"));
    server.event(runtime, "subagent.complete", who("a", "One", { status: "completed" }));
    server.event(runtime, "subagent.complete", who("b", "Two", { status: "whatever" }));
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.idle();
    // The reply ended, but the chat is read: no inbox entry says it finished, so it doesn't show as finished.
    expect(states(hermes)).toEqual(["The chat's reply, Not running", "One, Finished", "Two, Ended, Hermes didn't say how"]);
  });
});

/** Rooms as officeRooms makes them, for the component alone: a chat waiting in `deployIn`, and one with two subagents. */
function sample(deployIn = "default"): Room[] {
  return [
    {
      key: `${deployIn} deploy`,
      profile: deployIn,
      chatId: "deploy",
      title: "Deploy plan",
      desks: [{ key: `${deployIn} deploy reply`, agent: { kind: "reply" }, name: "The chat's reply", state: "approval", doing: { text: "A command is waiting for your approval.", at: 0 } }],
    },
    {
      key: "default audit",
      profile: "default",
      chatId: "audit",
      title: "Audit",
      desks: [
        { key: "default audit reply", agent: { kind: "reply" }, name: "The chat's reply", state: "running", detail: { model: "chat-model" } },
        { key: "default audit a", agent: { kind: "subagent", id: "a" as never, depth: 0 }, name: "Read the auth code", state: "running", doing: { text: "read_file: src/auth.ts", at: Date.now() }, detail: { goal: "Read the auth code", model: "sub-model", startedAt: Date.now() - 125 * 60_000 } },
        { key: "default audit b", agent: { kind: "subagent", id: "b" as never, depth: 1, parent: "a" as never }, name: "Check expiry", state: "completed", detail: { durationS: 42 } },
      ],
    },
  ];
}

function office(view: View, over: Partial<Parameters<typeof Office>[0]> = {}) {
  if (view === "building") withWebGL();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onView = vi.fn();
  const props = { rooms: sample(), floorMemory: fresh(), view, onView, server: "hermes", profile: "default", connected: true, onOpen, onClose, ...over };
  const { rerender, unmount } = render(<Office {...props} />);
  return {
    unmount, onOpen, onClose, onView, desks: agents, user: userEvent.setup(), rerender: (more: Partial<typeof props>) => rerender(<Office {...props} {...more} />) };
}

describe("The office from the keyboard", () => {
  it.each(["building", "list"] as const)("moves between every agent with the arrows, Home and End, and opens one with Enter (%s)", async (view) => {
    const { onOpen, onClose, desks, user } = office(view);
    expect(document.activeElement).toBe(desks()[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(desks()[1]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(desks()[2]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(desks()[3]);
    await user.keyboard("{ArrowUp}{Home}");
    expect(document.activeElement).toBe(desks()[0]);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    // In the building Enter opens the agent's card, with Open chat ready to press.
    if (view === "building") await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toMatchObject({ agent: { kind: "subagent", id: "a" } });
    // Escape closes the card first, then the office.
    await user.keyboard(view === "building" ? "{Escape}{Escape}" : "{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before an agent in another profile leaves something behind, and Escape backs out of the question first", async () => {
    const { onOpen, onClose, user } = office("list", { rooms: sample("work"), leaving: "Switching profiles leaves a reply running here." });
    await user.keyboard("{Enter}");
    const ask = screen.getByRole("alertdialog", { name: "Switch to work?" });
    expect(onOpen).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("data-desk")).toBe("work deploy reply");
    await user.keyboard("{Enter}");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Switch to work" }));
    expect(onOpen.mock.calls[0][0]).toMatchObject({ profile: "work", chatId: "deploy" });
    expect(ask.isConnected).toBe(false);
  });

  it("switches between the building and the list with the same agents named the same way", async () => {
    const { onView, user, desks } = office("building");
    const labels = desks().map((d) => d.getAttribute("aria-label"));
    expect(labels[3]).toBe("Check expiry, Finished, started by “Read the auth code”, in “Audit”.");
    expect(labels[0]).toBe("The chat's reply, Waiting for your approval, in “Deploy plan”. A command is waiting for your approval.");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(onView).toHaveBeenCalledWith("list");
    cleanup();
    office("list");
    expect(desks().map((d) => d.getAttribute("aria-label"))).toEqual(labels);
  });
});

describe("The building", () => {
  it("loads its scene once it opens, gives it the floor, and tags each agent with its name and a state dot only", async () => {
    office("building");
    await waitFor(() => expect(drawn.scene?.floor).toBeTruthy());
    expect(drawn.mounts).toBe(1);
    expect(drawn.scene!.floor!.characters.map((c) => `${c.key}: ${c.place}/${c.pose}`)).toEqual([
      "default deploy reply: waiting/hand-up",
      "default audit reply: workroom/typing",
      "default audit a: workroom/typing",
      "default audit b: lounge/couch",
    ]);
    // A reply's tag says its chat, since every reply has the same name; a subagent's says its own.
    expect(agents().map((t) => `${t.textContent} ${t.className}`)).toEqual([
      "Deploy plan office-tag state-approval",
      "Audit office-tag state-running",
      "Read the auth code office-tag state-running",
      "Check expiry office-tag state-completed",
    ]);
    // The chat's team wears one color, and another team another.
    const edges = agents().map((t) => t.style.borderColor);
    expect(edges[1]).toBe(edges[2]);
    expect(edges[0]).not.toBe(edges[1]);
  });

  it("opens the shown profile's floor, puts the others in the tower, and looks at another floor without switching the app", async () => {
    const { onOpen, user } = office("building", { rooms: sample("work"), profiles: ["work", "home"], leaving: "Switching profiles leaves a reply running here." });
    await waitFor(() => expect(drawn.scene?.profile).toBe("default"));
    expect(agents().map((t) => t.textContent)).toEqual(["Audit", "Read the auth code", "Check expiry"]);
    const floors = () => within(screen.getByRole("group", { name: "The other profiles' floors" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(floors()).toEqual(["home: 0 agents. Look at its floor.", "work: 1 agent, one needs you. Look at its floor."]);
    expect(drawn.scene!.tower).toEqual([{ profile: "home", agents: 0, lit: false }, { profile: "work", agents: 1, lit: true }]);
    expect(document.querySelector(".office-floor-open")!.textContent).toBe("default's floor");

    await user.click(screen.getByRole("button", { name: /^work: 1 agent/ }));
    await waitFor(() => expect(drawn.scene?.profile).toBe("work"));
    expect(agents().map((t) => t.textContent)).toEqual(["Deploy plan"]);
    expect(floors()).toEqual(["default: 3 agents. Look at its floor.", "home: 0 agents. Look at its floor."]);
    expect(document.querySelector(".office-floor-open")!.textContent).toBe("work's floor, looked at from default");
    expect(onOpen).not.toHaveBeenCalled();

    // Open chat on a card from another floor switches profile as the inbox does: asking first.
    await user.click(agents()[0]);
    await user.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByRole("alertdialog", { name: "Switch to work?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Switch to work" }));
    expect(onOpen.mock.calls[0][0]).toMatchObject({ profile: "work", chatId: "deploy" });
  });

  it("opens again on the floor last looked at, from the picture it last drew, so an agent dismissed meanwhile walks out", async () => {
    const floorMemory = fresh();
    const { user, unmount } = office("building", { rooms: sample("work"), profiles: ["work"], floorMemory });
    await user.click(await screen.findByRole("button", { name: /^work: 1 agent/ }));
    await waitFor(() => expect(drawn.scene?.profile).toBe("work"));
    unmount();

    // Its entry dismissed while the office was closed, the chat's reply is no longer on the work floor.
    office("building", { rooms: sample("work").slice(1), profiles: ["work"], floorMemory });
    await waitFor(() => expect(drawn.scene?.floors).toEqual(["work: work deploy reply", "work: "]));
    expect(document.querySelector(".office-floor-open")!.textContent).toBe("work's floor, looked at from default");
  });

  it("says where the agents are when none is on the open floor, while the header and List still count them", async () => {
    const done: Room = { key: "default old", profile: "default", chatId: "old", title: "Old chat", desks: [{ key: "default old reply", agent: { kind: "reply" }, name: "The chat's reply", state: "unread", doing: { text: "Something new.", at: Date.now() - 2 * 60 * 60_000 } }] };
    office("building", { rooms: [done] });
    await waitFor(() => expect(drawn.scene?.floor).toBeTruthy());
    expect(agents()).toEqual([]);
    expect(screen.getByText(/^No agent is on this floor\. Finished agents go home 30 minutes after their last change/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Office" }).textContent).toContain("1 agent");
    cleanup();
    office("list", { rooms: [done] });
    expect(agents()).toHaveLength(1);
  });

  it("says only that a floor is empty when its profile has no agent, while another floor has some", async () => {
    const { user } = office("building", { rooms: sample(), profiles: ["home"] });
    await user.click(await screen.findByRole("button", { name: /^home: 0 agents/ }));
    await waitFor(() => expect(drawn.scene?.profile).toBe("home"));
    expect(document.querySelector(".office-note")!.textContent).toBe("No agent is on this floor.");
  });

  it("shows an agent's card, kept up to date while open, with Open chat as its only action", async () => {
    const { onOpen, user, rerender } = office("building");
    await user.click(screen.getByRole("button", { name: /^Read the auth code, Running/ }));
    const card = screen.getByRole("dialog", { name: "Read the auth code" });
    const facts = () => Array.from(card.querySelectorAll("dt")).map((dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(facts()).toEqual(["Chat: Audit", "Profile: default (shown)", "State: Running", "Goal: Read the auth code", "Doing now: read_file: src/auth.ts (just now)", "Model: sub-model", "Time: Running for 2 h 5 min"]);
    expect(within(card).getAllByRole("button").map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Close the card", "Open chat"]);
    await waitFor(() => expect(drawn.scene?.selected).toBe("default audit a"));

    const rooms = sample();
    rooms[1].desks[1] = { ...rooms[1].desks[1], state: "failed", doing: { text: "Failed", at: Date.now() }, detail: { ...rooms[1].desks[1].detail, durationS: 600 } };
    rerender({ rooms });
    expect(facts()).toContain("State: Failed");
    expect(facts()).toContain("Time: Ran for 10 min");

    await user.click(within(card).getByRole("button", { name: "Open chat" }));
    expect(onOpen.mock.calls[0][1]).toMatchObject({ agent: { kind: "subagent", id: "a" } });
  });

  it("drops the selection when its agent leaves the floor, so the card doesn't open by itself when it comes back", async () => {
    const { user, rerender } = office("building");
    await user.click(screen.getByRole("button", { name: /^Read the auth code, Running/ }));
    await waitFor(() => expect(drawn.scene?.selected).toBe("default audit a"));
    const gone = sample();
    gone[1].desks.splice(1, 1);
    rerender({ rooms: gone });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(drawn.scene?.selected).toBeUndefined());
    rerender({ rooms: sample() });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(drawn.scene?.selected).toBeUndefined();
  });

  it("closes the card with Escape, back on the agent's tag, before Escape leaves the office", async () => {
    const { onClose, user } = office("building");
    await user.click(screen.getByRole("button", { name: /^Check expiry, Finished/ }));
    expect(screen.getByRole("dialog", { name: "Check expiry" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Check expiry" }).textContent).toContain("Ran for under a minute");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Check expiry" })).toBeNull();
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit b");
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the list on a computer without WebGL, says why, and never loads the scene", async () => {
    render(<Office floorMemory={fresh()} rooms={sample()} view="building" onView={() => {}} server="hermes" profile="default" connected onOpen={() => {}} onClose={() => {}} />);
    expect(document.querySelector(".office-fallback")!.textContent).toBe("Showing the list: This computer's web view has no WebGL, which the building needs.");
    expect(document.querySelector(".office-list")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Building" })).toHaveProperty("disabled", true);
    expect(agents()).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 0));
    expect(drawn.mounts).toBe(0);
  });

  it("lets things move only when the system doesn't ask for reduced motion, and draws only while the window has focus", async () => {
    const prefersReduced = (reduce: boolean) =>
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)", media: q, addEventListener() {}, removeEventListener() {} }));
    prefersReduced(true);
    office("building");
    await waitFor(() => expect(drawn.scene).toBeTruthy());
    expect(drawn.scene!.moves).toBe(false);
    cleanup();
    prefersReduced(false);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    office("building");
    await waitFor(() => expect(drawn.scene?.awake).toBe(true));
    expect(drawn.scene!.moves).toBe(true);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(drawn.scene!.awake).toBe(false);
    cleanup();
    expect(drawn.scene!.disposed).toBe(true);
  });

  it("gives the scene a new floor only when the picture changes, not when only words do", async () => {
    const { rerender } = office("building");
    await waitFor(() => expect(drawn.scene?.floor).toBeTruthy());
    const first = drawn.scene!.floor;
    const rooms = sample();
    rooms[1].desks[1] = { ...rooms[1].desks[1], doing: { text: "grep: token", at: Date.now() } };
    rerender({ rooms });
    expect(drawn.scene!.floor).toBe(first);
    rooms[1].desks[1] = { ...rooms[1].desks[1], state: "approval" };
    rerender({ rooms: [...rooms] });
    expect(drawn.scene!.floor).not.toBe(first);
  });

  it("draws a frame for \"+N more\" when it first shows, though no one drawn moved", async () => {
    /** A chat with `n` finished subagents: each sits on a Lounge couch, and the Lounge seats 16. */
    const finished = (n: number): Room[] => [
      { ...sample()[1], desks: Array.from({ length: n }, (_, i) => ({ key: `done ${i}`, agent: { kind: "subagent", id: `d${i}` as never, depth: 0 }, name: `Done ${i}`, state: "completed" as const })) },
    ];
    const { rerender } = office("building", { rooms: finished(16) });
    await waitFor(() => expect(drawn.scene?.floor).toBeTruthy());
    expect(drawn.scene!.floor!.more).toBe(0);
    rerender({ rooms: finished(17) });
    expect(drawn.scene!.floor!.characters.map((c) => c.key)).toEqual(finished(16)[0].desks.map((d) => d.key));
    expect(drawn.scene!.floor!.more).toBe(1);
    expect(screen.getByRole("button", { name: "1 more agents aren't drawn. Show them all in List." })).toBeTruthy();
  });

  it("seats each agent where it sat before when the building is drawn again, from the floor memory the app keeps", async () => {
    const team = (chatId: string): Room => ({ ...sample()[1], key: `default ${chatId}`, chatId, title: chatId, desks: [{ key: `default ${chatId} reply`, agent: { kind: "reply" }, name: "The chat's reply", state: "running" }] });
    const spotOf = (key: string) => drawn.scene!.floor!.characters.find((c) => c.key === key)!.spot;
    const floorMemory = fresh();
    office("building", { rooms: [team("b")], floorMemory });
    await waitFor(() => expect(drawn.scene?.floor).toBeTruthy());
    const b = spotOf("default b reply");
    cleanup();
    // Drawn again, as after a minimize, with a team listed ahead of it: it stays at its desk.
    office("building", { rooms: [team("a"), team("b")], floorMemory });
    await waitFor(() => expect(drawn.scene?.floor?.characters).toHaveLength(2));
    expect(spotOf("default b reply")).toEqual(b);
    expect(spotOf("default a reply")).not.toEqual(b);
  });

  it("lifts tags that would cover each other until none do, leaving the nearest where it is", () => {
    const at = new Map([
      ["far", { x: 100, y: 200, off: false }],
      ["near", { x: 110, y: 205, off: false }],
      ["apart", { x: 400, y: 205, off: false }],
      ["hidden", { x: 105, y: 205, off: true }],
    ]);
    const out = unstacked(at, () => ({ w: 80, h: 18 }));
    expect(out.get("near")).toEqual(at.get("near"));
    expect(out.get("apart")).toEqual(at.get("apart"));
    expect(out.get("hidden")).toEqual(at.get("hidden"));
    expect(out.get("far")!.y).toBeLessThanOrEqual(205 - 18 - 1);
  });

  it("resets the view from its button", async () => {
    const { user } = office("building");
    const reset = screen.getByRole("button", { name: "Reset view" });
    await waitFor(() => expect(reset).toHaveProperty("disabled", false));
    await user.click(reset);
    expect(drawn.scene!.resets).toBe(1);
  });
});

describe("An agent that goes while it has focus", () => {
  it.each(["building", "list"] as const)("leaves focus on the agent now in its place, where the keys still work (%s)", async (view) => {
    const { onClose, user, rerender } = office(view);
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default deploy reply");
    rerender({ rooms: sample().slice(1) });
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit reply");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit a");
    rerender({ rooms: [] });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close the office" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it.each(["building", "list"] as const)("follows the agent as the agents before it go, so the one after it takes its place (%s)", (view) => {
    const desk = (id: string) => ({ key: `default audit ${id}`, agent: { kind: "subagent" as const, id: id as never, depth: 0 }, name: `Task ${id}`, state: "running" as const });
    const audit = (ids: string[]): Room => ({ key: "default audit", profile: "default", chatId: "audit", title: "Audit", desks: ids.map(desk) });
    const first = sample()[0];
    const { rerender } = office(view, { rooms: [first, audit(["a", "b", "c", "d"])] });
    document.querySelector<HTMLElement>('[data-desk="default audit b"]')!.focus();
    rerender({ rooms: [audit(["a", "b", "c", "d"])] });
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit b");
    rerender({ rooms: [audit(["a", "c", "d"])] });
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit c");
  });
});

/** Signed in, with "Audit" open, its reply running with two subagents and one under the first, and an Approval asked. */
async function auditing() {
  const server = new FakeHermes();
  server.sessions = [row("audit", 1, { pinned: true, title: "Audit" }), row("other", 2, { pinned: true, title: "Other" })];
  server.transcripts = { audit: [{ role: "user", text: "Audit the repo" }], other: [{ role: "user", text: "Hi" }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Audit/ }));
  await act(async () => void (await hermes.idle()));
  const runtime = server.runtimeIdOf("audit")!;
  server.subagents.audit = [
    { subagent_id: "sa-auth", owner: runtime, accepting_steer: true, status: "running" },
    { subagent_id: "sa-expiry", owner: runtime, accepting_steer: true, status: "running" },
  ];
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("sa-auth", "Read the auth code"));
    server.event(runtime, "subagent.start", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1 }));
    server.askApproval(runtime);
  });
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user, runtime };
}

const officeButton = () => document.querySelector<HTMLButtonElement>(".office-btn");
/** What the app asked Hermes to do, as opposed to read: answers, sends, stops and steers. */
const writes = (server: FakeHermes) => [
  ...server.responses,
  ...server.requests.filter((r) => ["prompt.submit", "session.interrupt", "subagent.steer", "subagent.interrupt"].includes(r.method)),
];

describe("The office in the app", () => {
  it("opens a subagent's desk in its chat's Subagents panel and the reply's desk at its Approval, without answering or sending anything", async () => {
    const { server, user } = await auditing();
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    const before = writes(server).length;

    await user.click(officeButton()!);
    const room = screen.getByRole("list", { name: "Audit" });
    await user.click(within(room).getByRole("button", { name: /^Check token expiry, Running, started by “Read the auth code”/ }));
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    const panel = screen.getByRole("region", { name: "Subagents" });
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Check token expiry" })));

    await user.click(officeButton()!);
    await user.click(within(screen.getByRole("list", { name: "Audit" })).getByRole("button", { name: /^The chat's reply, Waiting for your approval/ }));
    await waitFor(() => expect(document.activeElement?.closest(".approval")).toBeTruthy());
    expect(writes(server)).toHaveLength(before);
  });

  it("focuses a subagent's name each time its desk opens it, and leaves the next chat's panel as it was", async () => {
    const { server, hermes, user } = await auditing();
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    await act(async () => void (await hermes.idle()));
    act(() => server.event(server.runtimeIdOf("other")!, "subagent.start", who("sa-docs", "Tidy the docs")));

    const desk = () => within(screen.getByRole("list", { name: "Audit" })).getByRole("button", { name: /^Read the auth code, Running/ });
    const heading = () => within(screen.getByRole("region", { name: "Subagents" })).getByRole("heading", { name: "Read the auth code" });
    await user.click(officeButton()!);
    await user.click(desk());
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    await user.click(officeButton()!);
    await user.click(desk());
    await waitFor(() => expect(document.activeElement).toBe(heading()));

    await user.click(screen.getByRole("button", { name: "Search all chats (Ctrl+K)" }));
    await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Other");
    await user.click(await within(screen.getByRole("dialog", { name: "Search chats" })).findByRole("button", { name: /Other/ }));
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")!.textContent).toContain("Other");
    const panel = screen.getByRole("region", { name: "Subagents" });
    expect(within(panel).getByRole("button", { name: /Subagents/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens in place of the chat panes, with the rail still there, and Escape or picking a chat goes back", async () => {
    const { user } = await auditing();
    const panes = () => document.querySelector(".main-chat .panes")!;
    expect(panes().classList.contains("covered")).toBe(false);
    await user.click(officeButton()!);
    expect(screen.getByRole("region", { name: "Office" }).closest(".main-chat")).toBeTruthy();
    expect(panes().classList.contains("covered")).toBe(true);
    expect(officeButton()!.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    expect(panes().classList.contains("covered")).toBe(false);

    await user.click(officeButton()!);
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    expect(document.querySelector(".chat-head")!.textContent).toContain("Other");
  });

  it("opens in Settings' place when Settings is open", async () => {
    const { user } = await auditing();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(officeButton()!.getAttribute("aria-expanded")).toBe("false");
    await user.click(officeButton()!);
    expect(screen.getByRole("region", { name: "Office" })).toBeTruthy();
    expect(officeButton()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the other profiles live with one small check every 15 s while it is seen, and never reads their chat lists sooner", async () => {
    const { hermes, user } = await auditing();
    const live = vi.spyOn(hermes, "checkLive");
    const lists = vi.spyOn(hermes, "checkOtherProfiles");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await user.click(officeButton()!);
    expect(live).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(4 * 15_000));
    expect(live).toHaveBeenCalledTimes(5);

    act(() => setWindowHidden(true));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(live).toHaveBeenCalledTimes(5);
    act(() => setWindowHidden(false));
    expect(live).toHaveBeenCalledTimes(6);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(live).toHaveBeenCalledTimes(7);

    await user.keyboard("{Escape}");
    expect(document.querySelector(".office")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(live).toHaveBeenCalledTimes(7);
    expect(lists).not.toHaveBeenCalled();
  });

  it("isn't drawn, and stops asking Hermes for checks, while the window is hidden to the tray or minimized", async () => {
    const { hermes, user } = await auditing();
    const checks = vi.spyOn(hermes, "checkLive");
    await user.click(officeButton()!);
    expect(document.querySelector(".office")).toBeTruthy();
    expect(checks).toHaveBeenCalledTimes(1);

    act(() => setWindowHidden(true));
    expect(document.querySelector(".office")).toBeNull();
    act(() => setWindowHidden(false));
    expect(document.querySelector(".office")).toBeTruthy();
    // Back in sight, it checks again at once: the checks it had asked for stopped while hidden.
    expect(checks).toHaveBeenCalledTimes(2);

    const was = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(document.querySelector(".office")).toBeNull();
    if (was) Object.defineProperty(document, "visibilityState", was);
    else delete (document as { visibilityState?: unknown }).visibilityState;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(document.querySelector(".office")).toBeTruthy();
    expect(checks).toHaveBeenCalledTimes(3);
  });

  it("is off with no rail button and nothing drawn when Settings turns it off, and draws nothing while closed", async () => {
    await auditing();
    expect(officeButton()).toBeTruthy();
    expect(document.querySelector(".office")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "list" }));
    await userEvent.setup().click(officeButton()!);
    expect(document.querySelector(".office-list")).toBeTruthy();
    expect(document.querySelector(".office-building")).toBeNull();
    withWebGL();
    act(() => void setUIPrefs({ agentOffice: "building" }));
    expect(document.querySelector(".office-building [data-desk]")).toBeTruthy();
    expect(document.querySelector(".office-list")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "off" }));
    expect(officeButton()).toBeNull();
    expect(document.querySelector(".office")).toBeNull();
  });
});
