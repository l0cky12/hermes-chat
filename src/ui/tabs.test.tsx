// @vitest-environment jsdom
// Chat tabs and splits made by dragging a chat from the list, driven the way the owner would, against a fake Hermes.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY } from "../hermes/uiPrefs";
import { Main } from "../App";
import { CHAT_DRAG, closeTabIn, navigateTabs } from "./Tabs";

const drops = vi.hoisted(() => new Set<(e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => { drops.add(cb); return () => drops.delete(cb); },
}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  // As WebView2 answers (a Promise that settles when the scroll ends), so an effect that leaks it fails here too (#308).
  Element.prototype.scrollIntoView = () => Promise.resolve() as unknown as void;
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  drops.clear();
  vi.restoreAllMocks();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");

const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
const pane = (i: number) => panes()[i];
const titleIn = (i: number) => pane(i).querySelector(".chat-title span")?.textContent;
const composerIn = (i: number) => within(pane(i)).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const activeIndex = () => panes().findIndex((p) => p.classList.contains("active"));
const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const lastOpen = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").lastOpenChat?.default;

/** Signed in with three Active chats, one pane on the New chat pane. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks" }),
    row("vpn", 3, { pinned: true, title: "VPN tunnel" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
    vpn: [{ role: "user", text: "Is the tunnel up?" }],
  };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

const tabsIn = (i: number) => Array.from(pane(i).querySelectorAll('[role="tab"]')).map((t) => t.textContent);
const shownTab = (i: number) => pane(i).querySelector('[role="tab"][aria-selected="true"]')?.textContent;

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => {} });

/**
 * Drags `source` onto `target`: at `at` within it as a share of its width and height, or at `clientX` on a tab strip
 * whose tabs are laid out 100 pixels wide each. `drop` false stops over the target, to see the hint.
 */
function drag(source: Element, target: Element, { at, clientX, drop = true }: { at?: { x: number; y: number }; clientX?: number; drop?: boolean } = {}) {
  expect(source.getAttribute("draggable")).toBe("true");
  const data = new Map<string, string>();
  // As in a browser, the data can be read only on drop; before, only its types.
  let readable = false;
  const dataTransfer = {
    types: [] as string[],
    setData: (k: string, v: string) => (data.set(k, v), dataTransfer.types.push(k)),
    getData: (k: string) => (readable ? (data.get(k) ?? "") : ""),
    effectAllowed: "",
    dropEffect: "",
  };
  if (at) vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1000, 800));
  if (clientX !== undefined) target.querySelectorAll(".tab").forEach((t, i) => vi.spyOn(t, "getBoundingClientRect").mockReturnValue(rect(i * 100, 0, 100, 30)));
  // jsdom has no DragEvent, so the pointer's place is put on the event by hand.
  const place = (e: Event) => {
    if (at) Object.defineProperties(e, { clientX: { value: at.x * 1000 }, clientY: { value: at.y * 800 } });
    if (clientX !== undefined) Object.defineProperties(e, { clientX: { value: clientX }, clientY: { value: 10 } });
    return e;
  };
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent(target, place(createEvent.dragOver(target, { dataTransfer })));
  if (!drop) return;
  readable = true;
  fireEvent(target, place(createEvent.drop(target, { dataTransfer })));
  fireEvent.dragEnd(source, { dataTransfer });
}

/** Drags the chat list's row for `id` onto `target`, at `at` within it as a share of its width and height. */
const dragOnto = (target: Element, id: string, at?: { x: number; y: number }) => drag(document.querySelector(`.row-open[data-chat="${id}"]`)!, target, { at });
const tabIn = (i: number, title: string) => within(pane(i)).getByRole("tab", { name: title });
const stacked = () => document.querySelector(".panes")?.classList.contains("stacked");

describe("tab bookkeeping", () => {
  it("switches to a chat that has a tab, else replaces the tab left", () => {
    expect(navigateTabs(["a", "b"], "a", "b")).toEqual(["a", "b"]);
    expect(navigateTabs(["a", "b"], "a", "c")).toEqual(["c", "b"]);
    expect(navigateTabs([null], null, "c")).toEqual(["c"]);
    expect(navigateTabs([], "a", null)).toEqual([null]);
  });
  it("shows the tab after a closed one, or before it at the end", () => {
    expect(closeTabIn(["a", "b", "c"], "b")).toEqual({ rest: ["a", "c"], next: "c" });
    expect(closeTabIn(["a", "b", "c"], "c")).toEqual({ rest: ["a", "b"], next: "b" });
    expect(closeTabIn(["a"], "a")).toEqual({ rest: [], next: undefined });
  });
});

describe("chat tabs", () => {
  it("opens a chat dropped on the tab strip in a new tab, and switches between tabs", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "NAS disks"]);
    expect(titleIn(0)).toBe("NAS disks");

    await user.click(within(pane(0)).getByRole("tab", { name: "Nightly backup" }));
    await settle(hermes);
    expect(titleIn(0)).toBe("Nightly backup");
    expect(lastOpen()).toBe("backup");

    // A chat opened from the list takes the place of the tab showing, as a link does in a browser tab.
    await user.click(rowButton("VPN tunnel"));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["VPN tunnel", "NAS disks"]);

    // Ctrl+Tab goes to the next tab.
    await user.keyboard("{Control>}{Tab}{/Control}");
    await settle(hermes);
    expect(shownTab(0)).toBe("NAS disks");
  });

  it("opens a chat in a new tab from its menu, and closes tabs to the one beside", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.pointer({ keys: "[MouseRight]", target: rowButton("VPN tunnel") });
    await user.click(screen.getByRole("menuitem", { name: "Open in a new tab" }));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "VPN tunnel"]);
    expect(titleIn(0)).toBe("VPN tunnel");

    await user.click(within(pane(0)).getByRole("button", { name: "Close the tab VPN tunnel" }));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup"]);
    expect(titleIn(0)).toBe("Nightly backup");

    // The plus opens the New chat pane in a tab of its own.
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    expect(tabsIn(0)).toEqual(["Nightly backup", "New chat"]);
    expect(shownTab(0)).toBe("New chat");
  });

  it("splits down for a chat dropped on a pane's bottom edge, and right for its right edge", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    dragOnto(pane(0).querySelector(".pane-drop")!, "nas", { x: 0.5, y: 0.9 });
    await settle(hermes);
    expect(panes()).toHaveLength(2);
    expect(document.querySelector(".panes")?.classList.contains("stacked")).toBe(true);
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "NAS disks"]);
    expect(pane(1).getAttribute("aria-label")).toMatch(/^Bottom pane: NAS disks/);

    // Dropped on the right edge, the panes turn side by side and the chat gets a tab in the second one.
    dragOnto(pane(0).querySelector(".pane-drop")!, "vpn", { x: 0.95, y: 0.5 });
    await settle(hermes);
    expect(document.querySelector(".panes")?.classList.contains("stacked")).toBe(false);
    expect(tabsIn(1)).toEqual(["NAS disks", "VPN tunnel"]);
    expect(titleIn(1)).toBe("VPN tunnel");

    // Its last tab closed, the second pane closes.
    await user.click(within(pane(1)).getByRole("button", { name: "Close the tab VPN tunnel" }));
    await user.click(within(pane(1)).getByRole("button", { name: "Close the tab NAS disks" }));
    expect(panes()).toHaveLength(1);
  });

  it("drops a deleted chat's tab", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    await user.click(within(pane(0)).getByRole("tab", { name: "Nightly backup" }));
    await settle(hermes);
    const row = rowButton("NAS disks").closest(".row") as HTMLElement;
    await user.click(within(row).getByTitle("Delete"));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat" }));
    await settle(hermes);
    await waitFor(() => expect(tabsIn(0)).toEqual(["Nightly backup"]));
    expect(server.sessions.some((s) => s.id === "nas")).toBe(false);
  });

  it("moves between tabs with the arrow keys, focus following", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    within(pane(0)).getByRole("tab", { name: "NAS disks" }).focus();
    await user.keyboard("{ArrowLeft}");
    await settle(hermes);
    expect(shownTab(0)).toBe("Nightly backup");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Nightly backup"));
  });

  it("keeps a chat starting in its New chat tab when another tab closes meanwhile", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    const create = server.handlers["session.create"];
    let held: Parameters<typeof create>[0] | undefined;
    server.handlers["session.create"] = (r) => void (held = r);
    await user.type(composerIn(0), "Plan the migration{Enter}");
    await waitFor(() => expect(held).toBeTruthy());
    await user.click(within(pane(0)).getByRole("button", { name: "Close the tab Nightly backup" }));
    await act(async () => create(held!));
    await settle(hermes);
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    // The started chat takes the New chat tab's place, and is the one kept for the next launch.
    await waitFor(() => expect(tabsIn(0)).not.toContain("New chat"));
    expect(tabsIn(0)).toHaveLength(1);
    expect(lastOpen()).toBeTruthy();
    expect(lastOpen()).not.toBe("backup");
  });

  it("keeps a chat starting in its New chat tab when End is pressed on that tab", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    const create = server.handlers["session.create"];
    let held: Parameters<typeof create>[0] | undefined;
    server.handlers["session.create"] = (r) => void (held = r);
    await user.type(composerIn(0), "Plan the migration{Enter}");
    await waitFor(() => expect(held).toBeTruthy());
    within(pane(0)).getByRole("tab", { name: "New chat" }).focus();
    await user.keyboard("{End}");
    await act(async () => create(held!));
    await settle(hermes);
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    await waitFor(() => expect(tabsIn(0)).not.toContain("New chat"));
    expect(tabsIn(0)).toHaveLength(2);
  });
});

describe("dragging tabs", () => {
  /** One pane with tabs for the three chats, NAS disks shown. */
  async function threeTabs() {
    const signed = await signedIn();
    await signed.user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    dragOnto(pane(0).querySelector(".tab-strip")!, "vpn");
    await signed.user.click(tabIn(0, "NAS disks"));
    await settle(signed.hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "NAS disks", "VPN tunnel"]);
    return signed;
  }

  it.each([
    ["right", { x: 0.95, y: 0.5 }, false, ["Nightly backup, VPN tunnel", "NAS disks"], "Right pane"],
    ["left", { x: 0.05, y: 0.5 }, false, ["NAS disks", "Nightly backup, VPN tunnel"], "Left pane"],
    ["bottom", { x: 0.5, y: 0.95 }, true, ["Nightly backup, VPN tunnel", "NAS disks"], "Bottom pane"],
    ["top", { x: 0.5, y: 0.05 }, true, ["NAS disks", "Nightly backup, VPN tunnel"], "Top pane"],
  ] as const)("splits for a tab dropped on the pane's %s edge, and moves the tab there", async (zone, at, isStacked, tabs, name) => {
    const { hermes } = await threeTabs();
    const body = pane(0).querySelector(".pane-drop")!;
    // While over the edge, the hint covers that half of the pane and says what the drop does.
    drag(tabIn(0, "NAS disks"), body, { at, drop: false });
    const hint = pane(0).querySelector(".drop-hint")!;
    expect(hint.getAttribute("data-zone")).toBe(zone);
    expect(hint.textContent).toBe({ right: "Split right", left: "Split left", bottom: "Split down", top: "Split up" }[zone]);
    fireEvent.drop(body, { dataTransfer: { types: [], getData: () => "" } });

    drag(tabIn(0, "NAS disks"), body, { at });
    await settle(hermes);
    expect(panes()).toHaveLength(2);
    expect(stacked()).toBe(isStacked);
    // Moved, not copied: the pane it left no longer has it.
    expect([tabsIn(0).join(", "), tabsIn(1).join(", ")]).toEqual(tabs);
    const moved = panes().findIndex((p) => p.querySelector(".chat-title span")?.textContent === "NAS disks");
    expect(pane(moved).getAttribute("aria-label")).toMatch(new RegExp(`^${name}: NAS disks`));
    expect(activeIndex()).toBe(moved);
    expect(lastOpen()).toBe("nas");
  });

  it("splits for the only tab, leaving a New chat tab where it was", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    drag(tabIn(0, "Nightly backup"), pane(0).querySelector(".pane-drop")!, { at: { x: 0.95, y: 0.5 } });
    await settle(hermes);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["New chat"], ["Nightly backup"]]);
  });

  it("shows no hint for a tab over its own pane's middle, and drops nothing there", async () => {
    const { hermes } = await threeTabs();
    const body = pane(0).querySelector(".pane-drop")!;
    drag(tabIn(0, "VPN tunnel"), body, { at: { x: 0.5, y: 0.5 } });
    await settle(hermes);
    expect(pane(0).querySelector(".drop-hint")).toBeNull();
    expect(panes()).toHaveLength(1);
    expect(tabsIn(0)).toEqual(["Nightly backup", "NAS disks", "VPN tunnel"]);
    expect(shownTab(0)).toBe("NAS disks");
  });

  it("moves a tab along its strip to where it is dropped, marking the place first", async () => {
    const { hermes } = await threeTabs();
    const strip = pane(0).querySelector(".tab-strip")!;
    // Before the first tab's middle: in front of it.
    drag(tabIn(0, "VPN tunnel"), strip, { clientX: 30, drop: false });
    expect(tabIn(0, "Nightly backup").parentElement!.classList.contains("insert-before")).toBe(true);
    expect(strip.classList.contains("drop")).toBe(true);
    fireEvent.dragEnd(tabIn(0, "VPN tunnel"));
    drag(tabIn(0, "VPN tunnel"), strip, { clientX: 30 });
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["VPN tunnel", "Nightly backup", "NAS disks"]);
    expect(shownTab(0)).toBe("VPN tunnel");
    // Past the last tab: to the end, with the mark after it.
    drag(tabIn(0, "VPN tunnel"), strip, { clientX: 290, drop: false });
    expect(tabIn(0, "NAS disks").parentElement!.classList.contains("insert-after")).toBe(true);
    fireEvent.dragEnd(tabIn(0, "VPN tunnel"));
    drag(tabIn(0, "VPN tunnel"), strip, { clientX: 290 });
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "NAS disks", "VPN tunnel"]);
    // Dropped where it is, nothing is marked and nothing moves.
    drag(tabIn(0, "NAS disks"), strip, { clientX: 130, drop: false });
    expect(strip.classList.contains("drop")).toBe(false);
    expect(pane(0).querySelector(".insert-before, .insert-after")).toBeNull();
  });

  it("shows no hint for a chat from the list that is shown in the pane already, though its id is read only on drop", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    const row = document.querySelector('.row-open[data-chat="backup"]')!;
    drag(row, pane(0).querySelector(".pane-drop")!, { at: { x: 0.5, y: 0.5 }, drop: false });
    expect(pane(0).querySelector(".drop-hint")).toBeNull();
    // Over an edge it would split, which shows the chat twice, as ADR 0010 allows.
    drag(row, pane(0).querySelector(".pane-drop")!, { at: { x: 0.95, y: 0.5 }, drop: false });
    expect(pane(0).querySelector(".drop-hint")?.textContent).toBe("Split right");
    fireEvent.dragEnd(row);
  });

  it("opens a chat from the list where it is dropped along the strip", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    drag(document.querySelector('.row-open[data-chat="vpn"]')!, pane(0).querySelector(".tab-strip")!, { clientX: 20 });
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["VPN tunnel", "Nightly backup", "NAS disks"]);
  });

  it("moves a tab to the other pane, closing the pane it leaves empty", async () => {
    const { hermes } = await threeTabs();
    drag(tabIn(0, "NAS disks"), pane(0).querySelector(".pane-drop")!, { at: { x: 0.95, y: 0.5 } });
    await settle(hermes);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup", "VPN tunnel"], ["NAS disks"]]);

    // Onto the other pane's strip: it leaves the first pane.
    drag(tabIn(0, "VPN tunnel"), pane(1).querySelector(".tab-strip")!);
    await settle(hermes);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup"], ["NAS disks", "VPN tunnel"]]);
    expect(titleIn(1)).toBe("VPN tunnel");

    // A pane's last tab dragged into the other pane: the pane closes, and the chat merges into the one left.
    drag(tabIn(0, "Nightly backup"), pane(1).querySelector(".pane-drop")!, { at: { x: 0.5, y: 0.5 } });
    await settle(hermes);
    expect(panes()).toHaveLength(1);
    expect(tabsIn(0)).toEqual(["NAS disks", "VPN tunnel", "Nightly backup"]);
    expect(titleIn(0)).toBe("Nightly backup");
  });

  it("leaves no copy when the other pane has a tab for the chat already", async () => {
    const { hermes } = await threeTabs();
    drag(tabIn(0, "NAS disks"), pane(0).querySelector(".pane-drop")!, { at: { x: 0.95, y: 0.5 } });
    await settle(hermes);
    // The right pane gets a tab for Nightly backup too, from the list: two views of one chat, as before.
    dragOnto(pane(1).querySelector(".tab-strip")!, "backup");
    await settle(hermes);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup", "VPN tunnel"], ["NAS disks", "Nightly backup"]]);
    drag(tabIn(0, "Nightly backup"), pane(1).querySelector(".tab-strip")!);
    await settle(hermes);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["VPN tunnel"], ["NAS disks", "Nightly backup"]]);
  });

  it("moves a pane's only tab to an edge by moving its pane there", async () => {
    const { hermes } = await threeTabs();
    drag(tabIn(0, "NAS disks"), pane(0).querySelector(".pane-drop")!, { at: { x: 0.95, y: 0.5 } });
    await settle(hermes);
    drag(tabIn(1, "NAS disks"), pane(1).querySelector(".pane-drop")!, { at: { x: 0.5, y: 0.05 }, drop: false });
    expect(pane(1).querySelector(".drop-hint")?.textContent).toBe("Move this pane up");
    fireEvent.dragEnd(tabIn(1, "NAS disks"));
    drag(tabIn(1, "NAS disks"), pane(1).querySelector(".pane-drop")!, { at: { x: 0.5, y: 0.05 } });
    await settle(hermes);
    expect(stacked()).toBe(true);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["NAS disks"], ["Nightly backup", "VPN tunnel"]]);
    expect(pane(0).getAttribute("aria-label")).toMatch(/^Top pane: NAS disks/);
  });

  it("moves the shown tab along the strip with Ctrl+Shift+PageUp and PageDown, focus following", async () => {
    const { hermes, user } = await threeTabs();
    tabIn(0, "NAS disks").focus();
    await user.keyboard("{Control>}{Shift>}{PageUp}{/Shift}{/Control}");
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["NAS disks", "Nightly backup", "VPN tunnel"]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("NAS disks"));
    // At the start already: nothing moves.
    await user.keyboard("{Control>}{Shift>}{PageUp}{/Shift}{/Control}");
    expect(tabsIn(0)).toEqual(["NAS disks", "Nightly backup", "VPN tunnel"]);
    await user.keyboard("{Control>}{Shift>}{PageDown}{/Shift}{/Control}{Control>}{Shift>}{PageDown}{/Shift}{/Control}");
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "VPN tunnel", "NAS disks"]);
    expect(shownTab(0)).toBe("NAS disks");
  });

  it("does every drag from the tab's menu, opened from the keyboard", async () => {
    const { hermes, user } = await threeTabs();
    const menuFor = (i: number, title: string) => {
      tabIn(i, title).focus();
      // The Menu key and Shift+F10 fire a contextmenu with no pointer position.
      fireEvent.contextMenu(tabIn(i, title));
      return screen.getByRole("menu", { name: `Actions for the tab ${title}` });
    };
    let menu = menuFor(0, "VPN tunnel");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Move tab left",
      "Split right",
      "Split down",
      "Split left",
      "Split up",
      "Close tab",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Move tab left" }));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "VPN tunnel", "NAS disks"]);

    menu = menuFor(0, "VPN tunnel");
    await user.click(within(menu).getByRole("menuitem", { name: "Split down" }));
    await settle(hermes);
    expect(stacked()).toBe(true);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup", "NAS disks"], ["VPN tunnel"]]);

    // With two panes: the other pane's tabs, then the edges, said from the tab's own pane. An edge that does what the
    // first item does (below the top pane is the bottom pane) isn't offered twice.
    menu = menuFor(0, "NAS disks");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Move tab leftCtrl+Shift+PgUp",
      "Move to the bottom pane",
      "Move right of this pane",
      "Move left of this pane",
      "Move above this pane",
      // The other pane's edges, as a drag onto them does: the tab stays in its pane, which goes to that side.
      "Move this pane right of the bottom pane",
      "Move this pane below the bottom pane",
      "Move this pane left of the bottom pane",
      "Close tab",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Move right of this pane" }));
    await settle(hermes);
    expect(stacked()).toBe(false);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup"], ["VPN tunnel", "NAS disks"]]);

    // Onto the other pane's edge, a tab of a pane with more tabs keeps its pane, which goes below the other one.
    menu = menuFor(1, "VPN tunnel");
    await user.click(within(menu).getByRole("menuitem", { name: "Move this pane below the left pane" }));
    await settle(hermes);
    expect(stacked()).toBe(true);
    expect([tabsIn(0), tabsIn(1)]).toEqual([["Nightly backup"], ["VPN tunnel", "NAS disks"]]);
    expect(shownTab(1)).toBe("VPN tunnel");

    // A pane's only tab can merge into the other pane.
    menu = menuFor(0, "Nightly backup");
    await user.click(within(menu).getByRole("menuitem", { name: "Merge into the bottom pane" }));
    await settle(hermes);
    expect(panes()).toHaveLength(1);
    expect(tabsIn(0)).toEqual(["VPN tunnel", "NAS disks", "Nightly backup"]);
  }, 20_000);
});
