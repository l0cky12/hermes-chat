// @vitest-environment jsdom
// The chat list's sections as the side panel shows them (ADR 0063): each one collapsible, remembered across a restart;
// Settings → General picking which show, never none; Settled as the drawer at the list's foot, and clearing a chat from
// the Inbox by settling it (ADR 0090). The list on its own first, then the whole app against a fake Hermes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { CLEARED_KEY, PINS_KEY, type Pins, type Snoozes } from "../hermes/snooze";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { Main } from "../App";
import { ChatList } from "./Sidebar";
import { TAB_DRAG } from "./Tabs";
import { ChatSectionSettings } from "./ChatSectionSettings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const NOW = Date.now();
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW - 60_000, items: [], ...extra });

function List({
  chats,
  onSettle = () => {},
  pins,
  snoozes,
  onPin,
  selectedId = null,
}: {
  chats: Chat[];
  onSettle?: (id: string, settled: boolean) => void;
  pins?: Pins;
  snoozes?: Snoozes;
  onPin?: (id: string, on: boolean) => void;
  selectedId?: string | null;
}) {
  return (
    <ChatList
      pins={pins}
      snoozes={snoozes}
      onPin={onPin}
      profile="default"
      status="connected"
      others={{ byName: {} }}
      chats={chats}
      selectedId={selectedId}
      onOpen={() => {}}
      onSettle={onSettle}
      onArchive={() => {}}
      onDelete={() => {}}
      onRename={async () => {}}
      onRegenTitle={async () => {}}
      onListProfiles={async () => ["default"]}
      onCheckOthers={() => {}}
      onSwitchProfile={() => {}}
      onRetrySwitch={() => {}}
    />
  );
}

/** The section headers the list shows, as their text: label then count. */
const heads = () => [...document.querySelectorAll<HTMLElement>(".section-toggle")].map((b) => b.textContent);
const head = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}\\d`) });
/** The titles of the chats the list shows in `section`, in order; rows of a collapsed section are out of sight. */
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!;

const mix = [
  chat("new", { unread: true }),
  chat("read"),
  chat("busy", { running: true }),
  chat("quiet", { updatedAt: NOW - 3_600_000 }),
  chat("old", { settled: true }),
  chat("gone", { archived: true }),
];

describe("The side panel's sections", () => {
  it("shows the Inbox, Working and Settled with counts, and no Unsettled; Archived is off until Settings turns it on", () => {
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Working1", "Settled1"]);
    expect(titles("inbox")).toEqual(["new", "read", "quiet"]);
    expect(titles("working")).toEqual(["busy"]);
    expect(screen.queryByRole("button", { name: /^Unsettled/ })).toBeNull();
    // Settled starts collapsed.
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
    expect(titles("settled")).toEqual([]);
  });

  it("collapses and expands each section from its header, remembered across a restart", async () => {
    const user = userEvent.setup();
    const first = render(<List chats={mix} />);
    await user.click(head("Inbox"));
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(titles("inbox")).toEqual([]);
    await user.click(head("Settled"));
    expect(titles("settled")).toEqual(["old"]);
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).chatSectionsCollapsed).toEqual(["inbox", "snoozed", "archived"]);

    // A restart: the prefs are read again from storage.
    first.unmount();
    const stored = localStorage.getItem(UI_PREFS_KEY)!;
    localStorage.clear();
    localStorage.setItem(UI_PREFS_KEY, stored);
    render(<List chats={mix} />);
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(head("Settled").getAttribute("aria-expanded")).toBe("true");
    expect(titles("settled")).toEqual(["old"]);
  });

  it("marks a collapsed section that has an unread chat", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} />);
    expect(head("Inbox").querySelector(".dot")).toBeNull();
    await user.click(head("Inbox"));
    expect(head("Inbox").querySelector(".dot")?.getAttribute("title")).toBe("1 unread");
  });

  it("opens the section of a chat opened from elsewhere, such as a search", () => {
    const { rerender } = render(<List chats={mix} />);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
    rerender(<List chats={mix} selectedId="old" />);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("true");
    expect(titles("settled")).toEqual(["old"]);
  });

  it("shows only the sections Settings picks, in the list's own order, and Archived lists archived chats", () => {
    setUIPrefs({ chatSectionsShown: ["archived", "inbox"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Archived1"]);
    expect(titles("archived")).toEqual(["gone"]);
    expect(document.querySelector('.row[data-section="working"]')).toBeNull();
    expect(document.querySelector('.row[data-section="settled"]')).toBeNull();
  });

  it("says when an open section is empty", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={[chat("busy", { running: true })]} />);
    const hints = [...document.querySelectorAll(".empty-hint")].map((h) => h.textContent);
    expect(hints).toEqual(["Nothing needs you right now.", "No settled chats."]);
  });
});

describe("The Settled drawer, in the list", () => {
  const scroll = () => document.querySelector<HTMLElement>(".sb-scroll")!;
  const drawer = () => document.querySelector<HTMLElement>(".settled-drawer");

  it("sits at the list's foot, outside its scroll, after Archived, and opens and closes from its header", async () => {
    const user = userEvent.setup();
    setUIPrefs({ chatSectionsShown: ["inbox", "archived", "settled"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Archived1", "Settled1"]);
    expect(within(scroll()).queryByRole("button", { name: /^Settled/ })).toBeNull();
    expect(within(drawer()!).getByRole("button", { name: /^Settled/ })).toBe(head("Settled"));
    expect(scroll().nextElementSibling).toBe(drawer());
    // Open: its rows are in the drawer's own scroll.
    expect(drawer()!.classList.contains("open")).toBe(true);
    expect(drawer()!.querySelector(".settled-list .row-open")?.getAttribute("data-chat")).toBe("old");
    // Closed: the header stays at the foot, and the settled chats are hidden.
    await user.click(head("Settled"));
    expect(drawer()!.classList.contains("open")).toBe(false);
    expect(drawer()!.querySelector(".settled-list")).toBeNull();
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
  });

  it("has Working right above it, the scroll's last section, whether Archived shows or not", () => {
    const chats = [...mix, chat("nap")];
    const all = ["pinned", "inbox", "snoozed", "archived", "working", "settled"] as const;
    for (const [shown, want] of [
      [all, ["Pinned1", "Inbox2", "Snoozed1", "Archived1", "Working1", "Settled1"]],
      [all.filter((k) => k !== "archived"), ["Pinned1", "Inbox2", "Snoozed1", "Working1", "Settled1"]],
    ] as const) {
      setUIPrefs({ chatSectionsShown: [...shown], chatSectionsCollapsed: [] });
      const { unmount } = render(<List chats={chats} pins={{ read: NOW }} snoozes={{ nap: NOW + 3_600_000 }} />);
      expect(heads()).toEqual(want);
      const last = scroll().lastElementChild!;
      expect(last.getAttribute("data-section")).toBe("working");
      expect(last.querySelector(".row-open")?.getAttribute("data-chat")).toBe("busy");
      expect(scroll().nextElementSibling).toBe(drawer());
      unmount();
    }
  });

  it("isn't drawn while Settings hides Settled", () => {
    setUIPrefs({ chatSectionsShown: ["inbox"] });
    render(<List chats={mix} />);
    expect(drawer()).toBeNull();
  });

  it("clears a chat from the Inbox by settling it, from the row or its menu, and Unsettle puts one back; there is no Clear", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={mix} onSettle={(id, on) => calls.push([id, on])} />);
    expect(screen.queryByRole("button", { name: "Clear from the Inbox" })).toBeNull();
    await user.click(within(rowOf("quiet").parentElement!).getByRole("button", { name: "Settle" }));
    fireEvent.contextMenu(rowOf("read"));
    expect(screen.queryByRole("menuitem", { name: "Clear from the Inbox" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Settle" }));
    await user.click(within(rowOf("old").parentElement!).getByRole("button", { name: "Unsettle" }));
    fireEvent.contextMenu(rowOf("old"));
    expect(screen.queryByRole("menuitem", { name: "Back to the Inbox" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Unsettle" }));
    expect(calls).toEqual([
      ["quiet", true],
      ["read", true],
      ["old", false],
      ["old", false],
    ]);
  });

  it("offers no Settle on an archived chat's menu", () => {
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    fireEvent.contextMenu(rowOf("gone"));
    expect(screen.queryByRole("menuitem", { name: /^(Settle|Unsettle)$/ })).toBeNull();
  });
});

describe("Dragging a row to settle or unsettle it, in the list", () => {
  const drawer = () => document.querySelector<HTMLElement>(".settled-drawer")!;
  const scroll = () => document.querySelector<HTMLElement>(".sb-scroll")!;
  const inboxTinted = () => scroll().getAttribute("data-drop") === "inbox";
  const tinted = () => drawer().classList.contains("drop") || inboxTinted();

  function dragRow(id: string, target: Element, { drop = true, tab = false }: { drop?: boolean; tab?: boolean } = {}) {
    const data = new Map<string, string>();
    // Browsers hide drag data until drop; dragover sees only the types.
    let readable = false;
    const dataTransfer = {
      types: [] as string[],
      setData: (k: string, v: string) => (data.set(k, v), dataTransfer.types.push(k)),
      getData: (k: string) => (readable ? (data.get(k) ?? "") : ""),
      effectAllowed: "",
      dropEffect: "",
    };
    const source = rowOf(id);
    fireEvent.dragStart(source, { dataTransfer });
    if (tab) dataTransfer.types.push(TAB_DRAG);
    fireEvent.dragOver(target, { dataTransfer });
    if (!drop) return;
    readable = true;
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
  }

  const drag = [chat("fresh"), chat("shelved", { settled: true }), chat("gone", { archived: true })];

  it("settles an Inbox row dropped on the closed drawer, tinting it meanwhile, and leaves the drawer closed", () => {
    setUIPrefs({ chatSectionsCollapsed: ["settled"] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", head("Settled"), { drop: false });
    expect(drawer().classList.contains("drop")).toBe(true);
    dragRow("fresh", head("Settled"));
    expect(onSettle.mock.calls).toEqual([["fresh", true]]);
    expect(drawer().classList.contains("drop")).toBe(false);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
  });

  it("settles on the open drawer's rows too", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", rowOf("shelved"));
    expect(onSettle.mock.calls).toEqual([["fresh", true]]);
  });

  it("unsettles a Settled row dropped on an Inbox row or the Inbox's header, tinting the Inbox meanwhile", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("shelved", rowOf("fresh"), { drop: false });
    expect(inboxTinted()).toBe(true);
    expect(drawer().classList.contains("drop")).toBe(false);
    dragRow("shelved", rowOf("fresh"));
    dragRow("shelved", head("Inbox"));
    expect(onSettle.mock.calls).toEqual([
      ["shelved", false],
      ["shelved", false],
    ]);
    expect(inboxTinted()).toBe(false);
  });

  it("unsettles a pinned Settled chat dropped on the Inbox, and settles a snoozed one dropped on the drawer", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(
      <List
        chats={[chat("fresh"), chat("pinned", { settled: true }), chat("napping")]}
        pins={{ pinned: NOW }}
        snoozes={{ napping: NOW + 3_600_000 }}
        onSettle={onSettle}
      />,
    );
    dragRow("pinned", head("Inbox"));
    dragRow("napping", head("Settled"));
    expect(onSettle.mock.calls).toEqual([
      ["pinned", false],
      ["napping", true],
    ]);
  });

  it("does nothing, with no tint, for a drop that would change nothing", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    for (const [id, target] of [
      ["shelved", head("Settled")],
      ["shelved", rowOf("shelved")],
      ["fresh", head("Inbox")],
      ["fresh", rowOf("fresh")],
    ] as const) {
      dragRow(id, target, { drop: false });
      expect(tinted()).toBe(false);
      dragRow(id, target);
    }
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("refuses an archived chat on both", () => {
    setUIPrefs({ chatSectionsShown: ["inbox", "archived", "settled"], chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    for (const target of [head("Settled"), head("Inbox")]) {
      dragRow("gone", target, { drop: false });
      expect(tinted()).toBe(false);
      dragRow("gone", target);
    }
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("refuses a tab dragged onto the drawer or the Inbox", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", head("Settled"), { drop: false, tab: true });
    expect(tinted()).toBe(false);
    dragRow("fresh", head("Settled"), { tab: true });
    dragRow("shelved", head("Inbox"), { tab: true });
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("takes the Inbox's header when it is empty and collapsed, and not the sections below it", () => {
    setUIPrefs({ chatSectionsCollapsed: ["inbox"] });
    const onSettle = vi.fn();
    render(<List chats={[chat("shelved", { settled: true }), chat("busy", { running: true })]} onSettle={onSettle} />);
    dragRow("shelved", head("Working"), { drop: false });
    expect(tinted()).toBe(false);
    dragRow("shelved", head("Inbox"));
    expect(onSettle.mock.calls).toEqual([["shelved", false]]);
  });
});

describe("Pinned chats, in the list", () => {
  it("lists pinned chats first, in the order pinned, each with a pin, and new messages don't reorder them", () => {
    const pins = { old: NOW - 2_000, read: NOW - 1_000 };
    const { rerender } = render(<List chats={mix} pins={pins} onPin={() => {}} />);
    expect(heads()).toEqual(["Pinned2", "Inbox2", "Working1", "Settled0"]);
    expect(titles("pinned")).toEqual(["old", "read"]);
    expect(rowOf("old").querySelector('[aria-label="Pinned"]')).not.toBeNull();
    expect(rowOf("new").querySelector('[aria-label="Pinned"]')).toBeNull();
    const later = mix.map((c) => (c.id === "read" || c.id === "new" ? { ...c, updatedAt: NOW } : c));
    rerender(<List chats={later} pins={pins} onPin={() => {}} />);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["old", "read"]);
    expect(titles("inbox")).toEqual(["new", "quiet"]);
  });

  it("draws no Pinned header while nothing is pinned", () => {
    render(<List chats={mix} pins={{}} />);
    expect(heads()[0]).toBe("Inbox3");
  });

  it("pins and unpins from the row's menu, by click or by its P key", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    render(<List chats={mix} pins={{ read: NOW }} onPin={(id, on) => calls.push([id, on])} />);
    fireEvent.contextMenu(rowOf("new"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("read"));
    expect(screen.getByRole("menuitem", { name: /^Unpin/ }).getAttribute("aria-keyshortcuts")).toBe("P");
    await user.keyboard("p");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(calls).toEqual([
      ["new", true],
      ["read", false],
    ]);
  });
});

describe("The row's menu from the keyboard", () => {
  it("opens on Shift+F10, which WebKitGTK sends no contextmenu event for", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} onPin={() => {}} />);
    rowOf("read").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Actions for read" })).toBeTruthy();
  });

  it("opens for the Menu key's event, which WebKitGTK sends to the focused row's corner, just outside it", () => {
    render(<List chats={mix} onPin={() => {}} />);
    const list = document.querySelector<HTMLElement>(".sb-scroll")!;
    rowOf("read").focus();
    const at = rowOf("read").getBoundingClientRect();
    fireEvent.contextMenu(list, { clientX: at.left + 40, clientY: at.bottom });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(list, { clientX: at.left, clientY: at.bottom });
    expect(screen.getByRole("menu", { name: "Actions for read" })).toBeTruthy();
  });
});

describe("Settings → General: chat list sections", () => {
  it("turns each section on or off in any mix, but never the last one", async () => {
    const user = userEvent.setup();
    render(<ChatSectionSettings />);
    const sw = (name: string) => screen.getByRole("switch", { name });
    expect(screen.queryByRole("switch", { name: "Unsettled" })).toBeNull();
    const inOrder = ["Pinned", "Inbox", "Snoozed", "Archived", "Working", "Settled"].map(sw);
    expect(screen.getAllByRole("switch")).toEqual(inOrder);
    expect(inOrder.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "false", "true", "true"]);
    await user.click(sw("Archived"));
    await user.click(sw("Working"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "archived", "settled"]);
    for (const n of ["Pinned", "Inbox", "Snoozed", "Settled"]) await user.click(sw(n));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    // The last one on can't be turned off, and says why.
    expect(sw("Archived").getAttribute("aria-disabled")).toBe("true");
    expect(sw("Archived").getAttribute("aria-checked")).toBe("true");
    await user.click(sw("Archived"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    expect(screen.getByText(/At least one section stays on/)).toBeTruthy();
    await user.click(sw("Inbox"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "archived"]);
    expect(sw("Archived").getAttribute("aria-disabled")).toBeNull();
  });

  it("won't keep a stored list with no sections, or ones it doesn't know", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, chatSectionsShown: [], chatSectionsCollapsed: ["nope", "inbox", "inbox"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "settled"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["inbox"]);
    setUIPrefs({ chatSectionsShown: [] });
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "settled"]);
  });

  it("reads sections stored in an older order in the list's order, with Working last", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 3, chatSectionsShown: ["pinned", "inbox", "working", "snoozed", "archived", "settled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "archived", "working", "settled"]);
  });

  it("drops Unsettled from preferences stored before ADR 0090, and a list of only Unsettled shows the defaults", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, chatSectionsShown: ["inbox", "unsettled", "settled"], chatSectionsCollapsed: ["unsettled", "settled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "settled"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["settled"]);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, chatSectionsShown: ["unsettled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "settled"]);
  });
});

describe("Clearing from the Inbox, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
  async function signedIn(server = new FakeHermes()) {
    if (!server.sessions.length) server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" })];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    // Groceries stays in the Inbox in every test here; Deploy notes may be settled as the app starts.
    await screen.findByRole("button", { name: /Groceries/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user };
  }
  /** Every `pinned` the app has written, by chat, in order. */
  const pinnedWrites = (server: FakeHermes) =>
    server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => [r.path.split("/").pop(), r.body!.pinned]);

  it("settles the chat on Hermes, into the Settled drawer, and Undo brings it back to the Inbox", async () => {
    const { server, hermes, user } = await signedIn();
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Settle" }));
    await act(async () => void (await hermes.idle()));
    expect(screen.getByRole("status").textContent).toContain("Settled: Deploy notes");
    expect(titles("inbox")).toEqual(["Groceries"]);
    expect(head("Settled").textContent).toBe("Settled1");
    expect(server.sessions.find((s) => s.id === "a")!.pinned).toBe(false);

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));
    expect(server.sessions.find((s) => s.id === "a")!.pinned).toBe(true);
  });

  it("settles once the chats an older version kept cleared, then forgets every clear", async () => {
    const server = new FakeHermes();
    server.sessions = [
      row("a", 1, { pinned: true, title: "Deploy notes" }),
      row("b", 2, { pinned: true, title: "Groceries" }),
      row("c", 3, { pinned: true, title: "Taxes" }),
    ];
    const marks = Object.fromEntries(server.sessions.map((s) => [s.id, s.last_active! * 1000]));
    // "a" was cleared and nothing has happened since; "b" has had a message since its clear; "c" was never cleared.
    const scope = projectScope(connection, "default");
    localStorage.setItem(CLEARED_KEY, JSON.stringify({ v: 1, scopes: { [scope]: { a: marks.a, b: marks.b - 60_000 }, other: { x: 1 } } }));
    const { hermes } = await signedIn(server);
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(pinnedWrites(server)).toEqual([["a", false]]));
    expect(server.sessions.map((s) => [s.id, s.pinned])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
    await waitFor(() => expect(titles("inbox")).toEqual(["Groceries", "Taxes"]));
    // This connection and profile's clears are gone; another's are left as they were.
    expect(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes).toEqual({ other: { x: 1 } });
  });

  it("lists archived chats only while the Archived section is shown", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(row("z", 3, { archived: true, title: "Old plan" }));
    await act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
    expect(hermes.getSnapshot().archivedListed).toBe(false);
    expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
    act(() => void setUIPrefs({ chatSectionsShown: ["inbox", "archived"] }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(true));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(head("Archived").textContent).toBe("Archived1"));
    act(() => void setUIPrefs({ chatSectionsShown: ["inbox"] }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(false));
  });
});

describe("Pinning, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
  async function signedIn(server = new FakeHermes()) {
    if (!server.sessions.length)
      server.sessions = [
        row("a", 1, { pinned: true, title: "Deploy notes" }),
        row("b", 2, { pinned: true, title: "Groceries" }),
        row("c", 3, { pinned: true, title: "Taxes" }),
      ];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user, view };
  }
  const refresh = (hermes: Hermes) =>
    act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
  const storedPins = () => Object.values(JSON.parse(localStorage.getItem(PINS_KEY) ?? '{"scopes":{}}').scopes).map((s) => Object.keys(s as object));

  it("pins from the row menu and the header's More menu, keeps them on this computer only, and keeps them across a restart", async () => {
    const { server, hermes, user, view } = await signedIn();
    const before = server.restRequests.length;
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(screen.getByRole("status").textContent).toContain("Pinned: Groceries");
    await user.click(rowOf("a"));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);
    expect(storedPins()).toEqual([["b", "a"]]);
    // Opening a chat marks it read on Hermes; nothing else is written there.
    expect(server.restRequests.slice(before).filter((r) => r.method !== "GET").map((r) => r.body)).toEqual([expect.objectContaining({ unread: false })]);

    // A new message in an unpinned chat leaves it below the pinned ones.
    server.sessions.find((s) => s.id === "c")!.last_active = Date.now() / 1000;
    await refresh(hermes);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);

    view.unmount();
    const again = await connect(server.openPipe);
    running.push(again);
    render(<Main hermes={again} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
  }, 20_000);

  it("unpins back to the chat's place in the list, and Undo puts the pin back in its old place", async () => {
    const { user } = await signedIn();
    for (const id of ["b", "c"]) {
      fireEvent.contextMenu(rowOf(id));
      await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    }
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
    fireEvent.contextMenu(rowOf("b"));
    await user.keyboard("p");
    expect(titles("pinned")).toEqual(["Taxes"]);
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
  });

  it("keeps a pinned chat the list no longer reaches, and forgets the pin of one Hermes no longer has", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("old", 60, { title: "Last year's taxes" })];
    localStorage.setItem(PINS_KEY, JSON.stringify({ v: 1, scopes: { [projectScope(connection, "default")]: { old: NOW - 2, gone: NOW - 1 } } }));
    await signedIn(server);
    await waitFor(() => expect(titles("pinned")).toEqual(["Last year's taxes"]));
    await waitFor(() => expect(storedPins()).toEqual([["old"]]));
  });

  it("forgets a deleted chat's pin", async () => {
    const { user } = await signedIn();
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(storedPins()).toEqual([]));
  });
});
