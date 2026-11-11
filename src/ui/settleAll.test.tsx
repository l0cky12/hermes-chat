// @vitest-environment jsdom
// Settle all, the Inbox header's one action for clearing every chat the Inbox shows (issue #303, ADR 0090). The list on
// its own for the question, then the whole app against a fake Hermes for what reaches the server.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat, Item } from "../hermes/model";
import { CheckTimesStore } from "../hermes/otherProfiles";
import { PINS_KEY, SNOOZE_KEY, inboxSettle } from "../hermes/snooze";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { Main } from "../App";
import { ChatList } from "./Sidebar";
import { RestError } from "../hermes/pipe";

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
const HOUR = 3_600_000;
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW - 60_000, items: [], ...extra });
const waiting: Item = { kind: "approval", id: "ap", requestId: "r", command: "rm -rf build", description: "", choices: [], allowSession: true, allowPermanent: true };
const failure: Item = { kind: "error", id: "err", text: "The reply failed." };
const loadError: Item = { kind: "error", id: "load-error", text: "Couldn't load this chat." };

function List({ chats, onSettleAll, snoozes, pins }: { chats: Chat[]; onSettleAll?: (ids: string[]) => void; snoozes?: Record<string, number>; pins?: Record<string, number> }) {
  return (
    <ChatList
      snoozes={snoozes}
      pins={pins}
      profile="default"
      status="connected"
      others={{ byName: {} }}
      checkTimes={new CheckTimesStore()}
      chats={chats}
      selectedId={null}
      onOpen={() => {}}
      onSettle={() => {}}
      onSettleAll={onSettleAll}
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

const settleAllButton = () => screen.queryByRole("button", { name: "Settle all" });
const inboxHead = () => document.querySelector<HTMLElement>('[data-section-head="inbox"]')!;
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);

describe("Settle all, in the list", () => {
  const mix = [
    chat("new", { unread: true }),
    chat("asking", { running: true, items: [waiting] }),
    chat("broke", { items: [failure] }),
    chat("unloaded", { items: [loadError] }),
    chat("busy", { running: true }),
    chat("nap"),
    chat("pin"),
    chat("old", { settled: true }),
  ];
  const snoozes = { nap: NOW + HOUR };
  const pins = { pin: NOW - 1 };

  it("counts the chats the Inbox shows, and names the ones with an Approval waiting or a failure", async () => {
    const user = userEvent.setup();
    const asked: string[][] = [];
    render(<List chats={mix} snoozes={snoozes} pins={pins} onSettleAll={(ids) => asked.push(ids)} />);
    await user.click(screen.getByRole("button", { name: "Settle all" }));
    const dialog = screen.getByRole("alertdialog", { name: "Settle 4 chats from the Inbox?" });
    expect(dialog.textContent).toContain("1 of them has an Approval waiting, and 1 of them has a failure. They move to the Settled drawer");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Settle all" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(asked).toHaveLength(1);
    expect([...asked[0]].sort()).toEqual(["asking", "broke", "new", "unloaded"]);
  });

  it("says nothing of waiting chats when none wait, and uses the singular for one chat", async () => {
    const user = userEvent.setup();
    render(<List chats={[chat("one")]} onSettleAll={() => {}} />);
    await user.click(settleAllButton()!);
    const note = screen.getByRole("alertdialog", { name: "Settle 1 chat from the Inbox?" }).textContent!;
    expect(note).toContain("They move to the Settled drawer, and you can undo it.");
    expect(note).not.toMatch(/waiting|failure/);
  });

  it("counts a chat once per kind of thing it waits on", () => {
    expect(inboxSettle([chat("a", { items: [waiting] }), chat("b", { items: [waiting, failure] }), chat("c", { items: [failure] })])).toEqual({
      ids: ["a", "b", "c"],
      approvals: 2,
      failures: 2,
    });
  });

  it("settles nothing on Cancel or Escape, and puts focus back on the button", async () => {
    const user = userEvent.setup();
    const asked: string[][] = [];
    render(<List chats={mix} onSettleAll={(ids) => asked.push(ids)} />);
    await user.click(settleAllButton()!);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(settleAllButton());
    await user.click(settleAllButton()!);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(settleAllButton());
    expect(asked).toEqual([]);
  });

  it("is the next Tab stop after the Inbox's toggle, and Enter opens the question", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} onSettleAll={() => {}} />);
    inboxHead().focus();
    await user.tab();
    expect(document.activeElement).toBe(settleAllButton());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("settles only the chats still in the Inbox when answered, leaving one that started working meanwhile", async () => {
    const user = userEvent.setup();
    const asked: string[][] = [];
    const chats = [chat("a"), chat("b"), chat("c")];
    const { rerender } = render(<List chats={chats} onSettleAll={(ids) => asked.push(ids)} />);
    await user.click(settleAllButton()!);
    rerender(<List chats={[chat("a"), chat("b", { running: true }), chat("c")]} onSettleAll={(ids) => asked.push(ids)} />);
    expect(screen.getByRole("alertdialog", { name: "Settle 3 chats from the Inbox?" })).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Settle all" }));
    expect(asked).toEqual([["a", "c"]]);
  });

  it("closes the question when the Inbox empties meanwhile, and the button goes with the chats", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<List chats={[chat("a")]} onSettleAll={() => {}} />);
    await user.click(settleAllButton()!);
    rerender(<List chats={[chat("a", { settled: true })]} onSettleAll={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(settleAllButton()).toBeNull();
  });

  it("has no button while the Inbox is empty, or without a handler", () => {
    const { rerender } = render(<List chats={[chat("old", { settled: true }), chat("busy", { running: true })]} onSettleAll={() => {}} />);
    expect(inboxHead()).toBeTruthy();
    expect(settleAllButton()).toBeNull();
    rerender(<List chats={[chat("a")]} />);
    expect(settleAllButton()).toBeNull();
    rerender(<List chats={[chat("a")]} onSettleAll={() => {}} />);
    expect(settleAllButton()).toBeTruthy();
  });

  it("keeps the Inbox toggle collapsing the section", async () => {
    const user = userEvent.setup();
    render(<List chats={[chat("a")]} onSettleAll={() => {}} />);
    expect(inboxHead().getAttribute("aria-expanded")).toBe("true");
    await user.click(inboxHead());
    expect(inboxHead().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Settle all, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
  const scope = () => projectScope(connection, "default");
  async function signedIn(server: FakeHermes) {
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    return { hermes, user };
  }
  const pinnedWrites = (server: FakeHermes) =>
    server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => [r.path.split("/").pop(), r.body!.pinned]);
  const settleEverything = async (user: ReturnType<typeof userEvent.setup>, hermes: Hermes) => {
    await user.click(screen.getByRole("button", { name: "Settle all" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Settle all" }));
    await act(async () => void (await hermes.idle()));
  };
  const toastBox = () => document.querySelector<HTMLElement>(".toast")!;
  const toast = () => toastBox().textContent!;
  const undo = (user: ReturnType<typeof userEvent.setup>) => user.click(within(toastBox()).getByRole("button", { name: "Undo" }));

  function sessions() {
    const server = new FakeHermes();
    server.sessions = [
      row("a", 1, { pinned: true, title: "Deploy notes" }),
      row("b", 2, { pinned: true, title: "Groceries" }),
      row("pin", 3, { pinned: true, title: "Pinned one" }),
      row("nap", 4, { pinned: true, title: "Snoozed one" }),
      row("old", 5, { title: "Settled one" }),
    ];
    localStorage.setItem(PINS_KEY, JSON.stringify({ v: 1, scopes: { [scope()]: { pin: NOW - 1 } } }));
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ v: 1, scopes: { [scope()]: { nap: NOW + HOUR } } }));
    return server;
  }

  it("writes pinned = false for the Inbox's chats only, moves them to the closed drawer, and Undo pins exactly them back", async () => {
    const server = sessions();
    const { hermes, user } = await signedIn(server);
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    await settleEverything(user, hermes);

    expect(pinnedWrites(server).sort()).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(toast()).toContain("Settled 2 chats");
    expect(titles("inbox")).toEqual([]);
    expect(titles("pinned")).toEqual(["Pinned one"]);
    expect(screen.getByRole("button", { name: /^Settled\d/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /^Settled\d/ }).textContent).toBe("Settled3");
    expect(screen.queryByRole("button", { name: "Settle all" })).toBeNull();

    await undo(user);
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));
    expect(pinnedWrites(server).slice(2).sort()).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(server.sessions.map((s) => [s.id, s.pinned])).toEqual([
      ["a", true],
      ["b", true],
      ["pin", true],
      ["nap", true],
      ["old", false],
    ]);
  });

  it("leaves the chats outside the shown project alone", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" }), row("out", 3, { pinned: true, title: "Elsewhere" })];
    server.projects.default = [{ id: "p_budget", name: "Budget Tracker", folders: ["/srv/budget"] } as never];
    server.serverDirs = new Set(["/srv", "/srv/budget"]);
    const { hermes, user } = await signedIn(server);
    for (const title of ["Deploy notes", "Groceries"]) {
      await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: new RegExp(title) }) });
      await user.click(await screen.findByRole("menuitemcheckbox", { name: "Budget Tracker" }));
    }
    await user.click(document.querySelector<HTMLElement>(".project-btn")!);
    await user.click(await screen.findByRole("option", { name: /Budget Tracker/ }));
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    await settleEverything(user, hermes);
    expect(pinnedWrites(server).sort()).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(server.sessions.find((s) => s.id === "out")!.pinned).toBe(true);
  });

  it("says how many failed, leaves them in the Inbox, and Undo unsettles only the ones that went in", async () => {
    const server = sessions();
    server.sessions.push(row("c", 6, { pinned: true, title: "Taxes" }));
    const { hermes, user } = await signedIn(server);
    server.rest["PATCH /api/sessions/b"] = () => {
      throw new RestError(503, "busy");
    };
    await settleEverything(user, hermes);
    expect(toast()).toContain("Settled 2 chats. 1 chat couldn't be settled and is still in the Inbox.");
    expect(titles("inbox")).toEqual(["Groceries"]);
    expect(screen.getByRole("button", { name: /^Settled\d/ }).textContent).toBe("Settled3");

    delete server.rest["PATCH /api/sessions/b"];
    const before = pinnedWrites(server).length;
    await undo(user);
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries", "Taxes"]));
    expect(pinnedWrites(server).slice(before).sort()).toEqual([
      ["a", true],
      ["c", true],
    ]);
  });

  it("offers no Undo when every write failed, and keeps all of them in the Inbox", async () => {
    const server = sessions();
    const { hermes, user } = await signedIn(server);
    for (const id of ["a", "b"])
      server.rest[`PATCH /api/sessions/${id}`] = () => {
        throw new RestError(503, "busy");
      };
    await settleEverything(user, hermes);
    expect(toast()).toContain("Couldn't settle 2 chats. They're still in the Inbox.");
    expect(within(toastBox()).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    expect(screen.getByRole("button", { name: "Settle all" })).toBeTruthy();
  });

  it("is absent once the Inbox is empty", async () => {
    const server = new FakeHermes();
    server.sessions = [row("old", 5, { title: "Settled one" })];
    await signedIn(server);
    expect(screen.queryByRole("button", { name: "Settle all" })).toBeNull();
  });
});
