// @vitest-environment jsdom
// The chat list's sections (the Inbox, Working, Snoozed, Settled) and snoozing from a chat's menu: the list
// on its own with chats in each state, then the whole app against a fake Hermes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat, Item } from "../hermes/model";
import { SNOOZE_KEY } from "../hermes/snooze";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { ChatList } from "./Sidebar";
import { useSnoozeClock } from "./Snooze";
// @ts-expect-error The app has no Node types; the tests run in Node. (Vitest empties a CSS import, ?raw included.)
import { readFileSync } from "node:fs";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const HOUR = 3_600_000;
const NOW = Date.now();
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW - 60_000, items: [], ...extra });
const waiting: Item = { kind: "approval", id: "ap", requestId: "r", command: "rm -rf build", description: "", choices: [], allowSession: true, allowPermanent: true };

/** The list alone, keeping its snoozes in state; `snoozed` records what the menu asked for. */
function List({
  chats,
  start = {},
  outside = {},
  snoozed,
}: {
  chats: Chat[];
  start?: Record<string, number>;
  /** Snoozes another window set meanwhile. */
  outside?: Record<string, number>;
  snoozed: (string | number | undefined)[][];
}) {
  const [own, setSnoozes] = useState(start);
  const snoozes = { ...own, ...outside };
  return (
    <ChatList
      profile="default"
      status="connected"
      others={{ byName: {} }}
      chats={chats}
      selectedId={null}
      onOpen={() => {}}
      onSettle={() => {}}
      snoozes={snoozes}
      onSnooze={(id, until) => {
        snoozed.push([id, until]);
        setSnoozes((s) => ({ ...s, [id]: until }));
      }}
      onWake={(id) => {
        snoozed.push([id, undefined]);
        setSnoozes(({ [id]: _, ...s }) => s);
      }}
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

/** The list with the times chats stopped working, as App's AttentionClock gives them. */
function ListSince({ chats, since }: { chats: Chat[]; since: Record<string, number> }) {
  return (
    <ChatList
      profile="default"
      status="connected"
      others={{ byName: {} }}
      chats={chats}
      selectedId={null}
      onOpen={() => {}}
      onSettle={() => {}}
      attentionSince={since}
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

/** The button that opens chat `id` in the list. */
const rowOf = (id: string) => document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!;
/** The titles of the chats the list shows in `section` ("inbox", "working", "snoozed" or "settled"), in order. */
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);

describe("The chat list's sections", () => {
  it("shows no Active label: what needs you is in the Inbox, then Snoozed, Working and Settled", async () => {
    const user = userEvent.setup();
    render(
      <List
        snoozed={[]}
        start={{ nap: NOW + HOUR }}
        chats={[
          chat("done", { updatedAt: NOW - 5000 }),
          chat("busy", { running: true }),
          chat("asking", { running: true, items: [waiting] }),
          chat("nap"),
          chat("old", { settled: true }),
        ]}
      />,
    );
    expect(screen.queryByText("Active")).toBeNull();
    expect(titles("inbox")).toEqual(["done", "asking"]);
    expect(titles("working")).toEqual(["busy"]);
    expect(document.querySelector('.row[data-section="working"] .spinner')).toBeTruthy();
    // Snoozed and Settled start collapsed, with counts.
    const snoozedToggle = screen.getByRole("button", { name: /Snoozed/ });
    expect(snoozedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(snoozedToggle.textContent).toContain("1");
    await user.click(snoozedToggle);
    expect(titles("snoozed")).toEqual(["nap"]);
    expect(screen.getByRole("button", { name: /Settled/ }).textContent).toContain("1");
  });

  it("moves a chat between Working and the Inbox as its reply starts, waits on you, and ends", () => {
    const { rerender } = render(<List snoozed={[]} chats={[chat("a", { running: true })]} />);
    expect(titles("working")).toEqual(["a"]);
    expect(titles("inbox")).toEqual([]);
    expect(document.querySelector(".sb-scroll .empty-hint")!.textContent).toBe("Nothing needs you right now.");
    rerender(<List snoozed={[]} chats={[chat("a", { running: true, items: [waiting] })]} />);
    expect(screen.queryByText("Working")).toBeNull();
    expect(titles("inbox")).toEqual(["a"]);
    rerender(<List snoozed={[]} chats={[chat("a")]} />);
    expect(titles("inbox")).toEqual(["a"]);
  });

  it("snoozes from the right-click menu for an hour, 3 hours, tomorrow or next week, and wakes it", async () => {
    const snoozed: (string | number | undefined)[][] = [];
    const user = userEvent.setup();
    render(<List snoozed={snoozed} chats={[chat("a"), chat("b")]} />);
    fireEvent.contextMenu(rowOf("a"));
    const menu = screen.getByRole("menu");
    const group = within(menu).getByRole("group", { name: "Snooze" });
    expect(within(group).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["1 hour", "3 hours", "Tomorrow", "Next week", "Custom…"]);
    const before = Date.now();
    await user.click(within(group).getByRole("menuitem", { name: "3 hours" }));
    expect(snoozed[0][0]).toBe("a");
    expect((snoozed[0][1] as number) - before).toBeGreaterThanOrEqual(3 * HOUR - 1000);
    expect((snoozed[0][1] as number) - before).toBeLessThanOrEqual(3 * HOUR + 1000);
    expect(titles("inbox")).toEqual(["b"]);

    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    const napping = rowOf("a");
    expect(napping.title).toContain("snoozed until");
    fireEvent.contextMenu(napping);
    await user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
    expect(snoozed[1]).toEqual(["a", undefined]);
    expect(titles("inbox").sort()).toEqual(["a", "b"]);
  });

  it("snoozes for a custom duration or until a custom date and time", async () => {
    const snoozed: (string | number | undefined)[][] = [];
    const user = userEvent.setup();
    render(<List snoozed={snoozed} chats={[chat("a")]} />);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
    const dialog = screen.getByRole("dialog", { name: /Snooze/ });
    await user.click(within(dialog).getByRole("button", { name: "Duration" }));
    const amount = within(dialog).getByLabelText("Snooze for");
    await user.clear(amount);
    await user.type(amount, "0");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Enter how long, more than zero.");
    expect(snoozed).toEqual([]);
    await user.clear(amount);
    await user.type(amount, "45");
    await user.selectOptions(within(dialog).getByLabelText("Unit"), "minutes");
    const before = Date.now();
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Math.abs((snoozed[0][1] as number) - before - 45 * 60_000)).toBeLessThan(1000);

    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
    expect(snoozed[1]).toEqual(["a", undefined]);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
    const again = screen.getByRole("dialog", { name: /Snooze/ });
    const at = within(again).getByLabelText("Wake at");
    const when = new Date(Date.now() + 3 * 24 * HOUR);
    when.setHours(14, 30, 0, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    fireEvent.change(at, { target: { value: `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}T14:30` } });
    await user.click(within(again).getByRole("button", { name: "Snooze" }));
    expect(snoozed[2]).toEqual(["a", when.getTime()]);
  });

  it("shows only Unsnooze on a snoozed chat, and the snooze times again once it is unsnoozed", async () => {
    const user = userEvent.setup();
    render(<List snoozed={[]} start={{ a: NOW + HOUR }} chats={[chat("a")]} />);
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    fireEvent.contextMenu(rowOf("a"));
    let group = within(screen.getByRole("menu")).getByRole("group", { name: "Snooze" });
    expect(within(group).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Unsnooze"]);
    expect(group.textContent).toContain("Snoozed until");
    await user.click(within(group).getByRole("menuitem", { name: "Unsnooze" }));

    fireEvent.contextMenu(rowOf("a"));
    group = within(screen.getByRole("menu")).getByRole("group", { name: "Snooze" });
    expect(within(group).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["1 hour", "3 hours", "Tomorrow", "Next week", "Custom…"]);
  });

  it("offers the snooze times again when a snooze has run out on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    render(<List snoozed={[]} start={{ a: NOW + HOUR }} chats={[chat("a")]} />);
    fireEvent.click(screen.getByRole("button", { name: /Snoozed/ }));
    fireEvent.contextMenu(rowOf("a"));
    const snoozeItems = () => within(within(screen.getByRole("menu")).getByRole("group", { name: "Snooze" })).getAllByRole("menuitem").map((b) => b.textContent);
    expect(snoozeItems()).toEqual(["Unsnooze"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => void vi.advanceTimersByTime(HOUR + 100));
    fireEvent.contextMenu(rowOf("a"));
    expect(snoozeItems()).toEqual(["1 hour", "3 hours", "Tomorrow", "Next week", "Custom…"]);
  });

  it("moves the arrow keys over every item a snoozed chat's menu shows, and only those", async () => {
    const user = userEvent.setup();
    render(<List snoozed={[]} start={{ a: NOW + HOUR }} chats={[chat("a")]} />);
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    fireEvent.contextMenu(rowOf("a"));
    const shown = within(screen.getByRole("menu")).getAllByRole("menuitem").map((b) => b.textContent);
    const at = shown.indexOf("Unsnooze");
    screen.getByRole("menuitem", { name: "Unsnooze" }).focus();
    const reached = [];
    for (const _ of shown) {
      await user.keyboard("{ArrowDown}");
      reached.push(document.activeElement!.textContent);
    }
    expect(reached).toEqual([...shown.slice(at + 1), ...shown.slice(0, at + 1)]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement!.textContent).toBe(shown.at(at - 1));
  });

  it("keeps a row's rename box, and an open Custom snooze, when the chat moves between Working and the top", async () => {
    const user = userEvent.setup();
    const snoozed: (string | number | undefined)[][] = [];
    const { rerender } = render(<List snoozed={snoozed} chats={[chat("a", { running: true }), chat("b")]} />);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const box = screen.getByRole("textbox", { name: "Chat title" });
    await user.clear(box);
    await user.type(box, "Half typed");
    // The reply ends: the chat moves to the top, and the box keeps what was typed, and focus.
    rerender(<List snoozed={snoozed} chats={[chat("a"), chat("b")]} />);
    expect(screen.getByRole("textbox", { name: "Chat title" })).toBe(box);
    expect((box as HTMLInputElement).value).toBe("Half typed");
    expect(document.activeElement).toBe(box);
    await user.keyboard("{Escape}");

    rerender(<List snoozed={snoozed} chats={[chat("a", { running: true }), chat("b")]} />);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
    const dialog = screen.getByRole("dialog", { name: /Snooze/ });
    await user.click(within(dialog).getByRole("button", { name: "Duration" }));
    await user.clear(within(dialog).getByLabelText("Snooze for"));
    await user.type(within(dialog).getByLabelText("Snooze for"), "20");
    rerender(<List snoozed={snoozed} chats={[chat("a"), chat("b")]} />);
    expect(screen.getByRole("dialog", { name: /Snooze/ })).toBe(dialog);
    expect((within(dialog).getByLabelText("Snooze for") as HTMLInputElement).value).toBe("20");
    // Right-clicking in the dialog doesn't open the chat's menu behind it.
    fireEvent.contextMenu(within(dialog).getByLabelText("Snooze for"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("puts a chat that stops to ask for an Approval at the very top, above one that finished earlier", () => {
    const since: Record<string, number> = {};
    const { rerender } = render(
      <List snoozed={[]} chats={[chat("a", { running: true, updatedAt: NOW - 600_000 }), chat("b", { updatedAt: NOW - 300_000 })]} />,
    );
    expect(titles("inbox")).toEqual(["b"]);
    // App's AttentionClock says a stopped working just now; Hermes's own activity time for it is older than b's.
    since.a = NOW;
    rerender(
      <ListSince since={since} chats={[chat("a", { running: true, updatedAt: NOW - 600_000, items: [waiting] }), chat("b", { updatedAt: NOW - 300_000 })]} />,
    );
    expect(titles("inbox")).toEqual(["a", "b"]);
  });

  it("closes the Custom snooze dialog when its chat is settled, archived or gone meanwhile", async () => {
    const user = userEvent.setup();
    const snoozed: (string | number | undefined)[][] = [];
    const { rerender } = render(<List snoozed={snoozed} chats={[chat("a"), chat("b")]} />);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
    expect(screen.getByRole("dialog", { name: /Snooze/ })).toBeTruthy();
    rerender(<List snoozed={snoozed} chats={[chat("a", { settled: true }), chat("b")]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The same when it is archived, or leaves the list.
    for (const after of [[chat("a", { archived: true }), chat("b")], [chat("b")]]) {
      rerender(<List snoozed={snoozed} chats={[chat("a"), chat("b")]} />);
      fireEvent.contextMenu(rowOf("a"));
      await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
      expect(screen.getByRole("dialog", { name: /Snooze/ })).toBeTruthy();
      rerender(<List snoozed={snoozed} chats={after} />);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(snoozed).toEqual([]);
  });

  it("keeps a rename box when the chat is snoozed from another window, and shows it again when it wakes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<List snoozed={[]} chats={[chat("a"), chat("b")]} />);
    fireEvent.contextMenu(rowOf("a"));
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const box = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "Draft title");
    // Another window snoozes it: the Snoozed section is collapsed, so the box is out of sight but kept.
    rerender(<List snoozed={[]} outside={{ a: NOW + HOUR }} chats={[chat("a"), chat("b")]} />);
    expect(box.isConnected).toBe(true);
    expect(box.closest("[hidden]")).toBeTruthy();
    // Out of sight: .row sets a display of its own, which would beat the browser's rule for [hidden], so the app's
    // stylesheet hides a hidden row itself. (jsdom doesn't cascade author rules over [hidden], so this reads the sheet.)
    expect(readFileSync("src/styles.css", "utf8")).toMatch(/^\.row\[hidden\] \{ display: none; \}$/m);
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    expect(box.closest("[hidden]")).toBeNull();
    expect(box.value).toBe("Draft title");
  });

  it("shows when a snoozed chat wakes beside its spinner or unread dot", async () => {
    const user = userEvent.setup();
    render(<List snoozed={[]} start={{ a: NOW + HOUR, b: NOW + HOUR }} chats={[chat("a", { running: true }), chat("b", { unread: true })]} />);
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    for (const id of ["a", "b"]) expect(rowOf(id).querySelector(".row-wake")?.textContent).toBeTruthy();
    expect(rowOf("a").querySelector(".spinner")).toBeTruthy();
    expect(rowOf("b").querySelector(".dot")).toBeTruthy();
  });

  it("offers no Snooze on a Settled chat", async () => {
    const user = userEvent.setup();
    render(<List snoozed={[]} chats={[chat("old", { settled: true })]} />);
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    fireEvent.contextMenu(rowOf("old"));
    expect(within(screen.getByRole("menu")).queryByRole("group", { name: "Snooze" })).toBeNull();
  });

  it("wakes a snooze further off than one timer can wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const far = NOW + 30 * 24 * HOUR;
    render(<List snoozed={[]} start={{ a: far }} chats={[chat("a"), chat("b")]} />);
    await act(async () => void vi.advanceTimersByTime(2 ** 31));
    expect(titles("inbox")).toEqual(["b"]);
    await act(async () => void vi.advanceTimersByTime(far - Date.now() + 100));
    expect(titles("inbox")).toEqual(["a", "b"]);
  });

  it("renders what shows a snooze again when it wakes, as the chat's header does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const snoozes = { a: NOW + HOUR };
    function Header() {
      const now = useSnoozeClock(snoozes);
      return <span>{snoozes.a > now ? "Snoozed" : "Awake"}</span>;
    }
    render(<Header />);
    expect(screen.getByText("Snoozed")).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(HOUR + 100));
    expect(screen.getByText("Awake")).toBeTruthy();
  });

  it("brings a snoozed chat back to the top on its own when it wakes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    render(<List snoozed={[]} start={{ a: NOW + HOUR }} chats={[chat("a"), chat("b")]} />);
    expect(titles("inbox")).toEqual(["b"]);
    await act(async () => void vi.advanceTimersByTime(HOUR + 100));
    // It woke after b's last activity, so it comes first.
    expect(titles("inbox")).toEqual(["a", "b"]);
    expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
  });
});

/** Every `pinned` the app has written, in order. */
const pinnedWrites = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => r.body!.pinned);

describe("Snoozing in the app", () => {
  async function signedIn() {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" })];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user };
  }

  it("keeps the snooze on this computer, says when it wakes, and Undo brings the chat back", async () => {
    const { server, user } = await signedIn();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Deploy notes/ }));
    await user.click(screen.getByRole("menuitem", { name: "1 hour" }));
    expect(screen.getByRole("status").textContent).toMatch(/Snoozed until .*: Deploy notes/);
    expect(titles("inbox")).toEqual(["Groceries"]);
    const stored = JSON.parse(localStorage.getItem(SNOOZE_KEY)!);
    expect(Object.values(stored.scopes).map((s) => Object.keys(s as object))).toEqual([["a"]]);
    // Nothing about it goes to Hermes.
    expect(pinnedWrites(server)).toEqual([]);

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(titles("inbox")).toContain("Deploy notes"));
    expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
  });

  it("forgets the snooze when the chat is settled, and Undo puts both back", async () => {
    const { server, hermes, user } = await signedIn();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Deploy notes/ }));
    await user.click(screen.getByRole("menuitem", { name: "Tomorrow" }));
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    const snoozedRow = screen.getByRole("button", { name: /Deploy notes/ }).parentElement!;
    await user.click(within(snoozedRow).getByRole("button", { name: "Settle" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([false]);
    expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Settled: Deploy notes");

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([false, true]);
    await waitFor(() => expect(screen.getByRole("button", { name: /Snoozed/ })).toBeTruthy());
  });

  it("wakes a snoozed chat when the owner sends a message in it from this app", async () => {
    const { hermes, user } = await signedIn();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Deploy notes/ }));
    await user.click(screen.getByRole("menuitem", { name: "Next week" }));
    expect(titles("inbox")).toEqual(["Groceries"]);
    await user.click(screen.getByRole("button", { name: /Snoozed/ }));
    await user.click(screen.getByRole("button", { name: /Deploy notes/ }));
    await act(async () => void (await hermes.idle()));
    expect(screen.getByText("Snoozed", { selector: ".chat-title .badge" })).toBeTruthy();
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Ship it{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull());
    expect(JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}").scopes ?? {}).toEqual({});
    expect(screen.queryByText("Snoozed", { selector: ".chat-title .badge" })).toBeNull();
  });
});
