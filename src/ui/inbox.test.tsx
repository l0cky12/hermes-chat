// @vitest-environment jsdom
// The inbox in the running app, against a fake Hermes: what it lists, where each entry takes the owner, and that
// dismissing an entry changes nothing else.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, readRow, row } from "../hermes/fakeHermes";
import { FakeTray } from "../hermes/fakeTray";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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

let launches = 0;
const nowS = () => Date.now() / 1000;

/** Signed in to `default`, with an Unread chat there and in `work`, and a reply waiting on an Approval in `work`. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [
    readRow("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("notes", 0.01, { pinned: true, title: "Release notes", last_read_at: 0 }),
  ];
  server.otherProfiles = {
    work: [
      row("deploy", 0.02, { pinned: true, title: "Deploy plan", last_read_at: 0 }),
      readRow("migrate", 0, { pinned: true, title: "Migrate db" }),
    ],
  };
  server.liveSessions = [{ id: "rt-w", session_key: "migrate", status: "waiting", last_active: nowS() - 300 }];
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const tray = new FakeTray();
  render(<Main hermes={hermes} tray={tray} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  const openInbox = () => tray.pick("inbox");
  return { server, hermes, tray, openInbox, user: userEvent.setup() };
}

const inbox = () => screen.getByRole("dialog", { name: /Inbox/ });
const rows = () => Array.from(inbox().querySelectorAll<HTMLButtonElement>(".inbox-open"));
const rowNames = () => rows().map((r) => r.getAttribute("aria-label")!.split(", in ")[0]);
const filter = (name: RegExp) => within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name });

describe("The inbox", () => {
  it("tells the tray how many entries need the owner, has no rail button, and lists each entry with its profile, chat, server and time", async () => {
    const { tray, openInbox } = await launch();
    await waitFor(() => expect(tray.counts.at(-1)).toBe(3));
    expect(within(document.querySelector<HTMLElement>(".rail")!).queryByRole("button", { name: /^Inbox/ })).toBeNull();

    openInbox();
    expect(rowNames()).toEqual(["Needs approval: Migrate db", "Completed, unread: Release notes", "Completed, unread: Deploy plan"]);
    const approval = rows()[0];
    expect(approval.getAttribute("aria-label")).toMatch(/^Needs approval: Migrate db, in work on ssh:\/\/liam@hermes, 5m ago\. Hermes is waiting for your answer/);
    expect(within(approval).getByText(/ago$/).tagName).toBe("TIME");
    // Focus goes to the first entry, so the keyboard can start there.
    expect(document.activeElement).toBe(approval);
    expect(inbox().textContent).toMatch(/Checked profiles just now, running work just now\./);
  });

  it("says it checked just now after a check that found nothing new", async () => {
    const { hermes, user, openInbox } = await launch();
    openInbox();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 180_000 });
    try {
      await user.click(filter(/^Completed/));
      expect(inbox().textContent).toMatch(/Checked profiles 3m ago, running work 3m ago\./);
      await act(async () => void (await hermes.checkOtherProfiles()));
      expect(inbox().textContent).toMatch(/Checked profiles just now, running work just now\./);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the Office's place when opened from the tray, as the rail's tools replace each other", async () => {
    const { user, openInbox } = await launch();
    await user.click(screen.getByRole("button", { name: "Office" }));
    expect(screen.getByRole("button", { name: "Office" }).getAttribute("aria-expanded")).toBe("true");
    openInbox();
    expect(inbox()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Office" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("filters by kind", async () => {
    const { user, openInbox } = await launch();
    openInbox();
    await user.click(filter(/^Completed/));
    expect(rowNames()).toEqual(["Completed, unread: Release notes", "Completed, unread: Deploy plan"]);
    await user.click(filter(/^Running/));
    expect(rows()).toEqual([]);
    expect(inbox().textContent).toMatch(/Nothing is running\./);
  });

  it("moves between entries with the arrow keys, and Escape closes it and puts focus back where it was", async () => {
    const { user, openInbox } = await launch();
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const composer = await screen.findByPlaceholderText("Message Hermes");
    composer.focus();
    openInbox();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("closes on a click anywhere outside it, such as another rail tool or the chat", async () => {
    const { user, openInbox } = await launch();
    openInbox();
    // Clicks inside it keep it open.
    await user.click(filter(/^Completed/));
    expect(inbox()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Usage" }));
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-pressed")).toBe("true");

    openInbox();
    expect(inbox()).toBeTruthy();
    await user.click(document.querySelector<HTMLElement>(".main")!);
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
  });

  it("closes when focus goes into a frame, such as a page in the Preview, but not when the window loses focus to another app", async () => {
    const { openInbox } = await launch();
    openInbox();
    // Another app: focus stays on the entry, and the inbox stays.
    act(() => void window.dispatchEvent(new FocusEvent("blur")));
    await new Promise((r) => setTimeout(r, 10));
    expect(inbox()).toBeTruthy();
    // A press in a frame never reaches the page; the frame takes focus and the window blurs.
    const frame = document.createElement("iframe");
    document.querySelector(".main")!.append(frame);
    try {
      act(() => {
        frame.focus();
        window.dispatchEvent(new FocusEvent("blur"));
      });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull());
    } finally {
      frame.remove();
    }
  });

  it("opens an entry in another profile by switching to it, and shows the chat waiting on an Approval", async () => {
    const { server, hermes, user, openInbox } = await launch();
    // Hermes still waits in work's chat, so resuming it brings back the card.
    server.openRequests.set("srq-work", {
      sid: "rt-w",
      stored: "migrate",
      method: "approval",
      params: { request_id: "apr-work", command: "psql -c 'drop table old'", description: "drop table", choices: ["once", "deny"] },
    });
    openInbox();
    await user.click(rows()[0]);

    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected", switching: undefined }));
    await waitFor(() => expect(server.last("session.resume")?.params).toMatchObject({ session_id: "migrate", profile: "work" }));
    // Focus lands on the card itself, never on one of its answers.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe("srq-work"));
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    // Nothing was answered for the owner.
    expect(server.approvalAnswers).toEqual([]);
  });

  it("opens a waiting chat older than the profile's list holds", async () => {
    const { hermes, user, openInbox } = await launch((server) => {
      server.otherProfiles.work.push(readRow("audit", 40, { title: "Quarterly audit" }));
      server.liveSessions = [{ id: "rt-a", session_key: "audit", status: "waiting", last_active: nowS() - 60 }];
      server.openRequests.set("srq-audit", { sid: "rt-a", stored: "audit", method: "approval", params: { request_id: "apr-audit", command: "x", description: "y", choices: ["once", "deny"] } });
    });
    openInbox();
    await user.click(rows().find((r) => r.getAttribute("aria-label")!.includes("Quarterly audit"))!);

    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", switching: undefined }));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe("srq-audit"));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "audit")).toMatchObject({ title: "Quarterly audit", settled: true });
  });

  it("opens the Approval card an entry is about, focusing the card and not an answer", async () => {
    const { server, hermes, user, openInbox } = await launch();
    let chatId = "";
    await act(async () => {
      chatId = await hermes.newChat();
      await hermes.send(chatId, "Clean up the logs");
    });
    const { id } = server.askApproval(server.runtimeIdOf(chatId)!);
    // The owner is in another chat meanwhile.
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));

    openInbox();
    const entry = rows().find((r) => r.getAttribute("aria-label")!.startsWith("Needs approval: Clean up the logs"))!;
    await user.click(entry);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe(id));
    expect(document.activeElement?.classList.contains("approval")).toBe(true);
    expect(server.approvalAnswers).toEqual([]);
  });

  it("asks before taking the owner to another profile while an Approval waits here", async () => {
    const { server, hermes, user, openInbox } = await launch();
    await act(async () => {
      const id = await hermes.newChat();
      await hermes.send(id, "Clean up the logs");
      server.askApproval(server.runtimeIdOf(id)!);
    });
    openInbox();
    await user.click(rows().find((r) => r.getAttribute("aria-label")!.includes("Deploy plan"))!);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to work?" });
    expect(ask.textContent).toMatch(/An approval is waiting in default/);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(hermes.getSnapshot().profile).toBe("default");

    await user.click(rows().find((r) => r.getAttribute("aria-label")!.includes("Deploy plan"))!);
    await user.click(screen.getByRole("button", { name: "Switch to work" }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", switching: undefined }));
  });

  it("dismisses an entry only from the inbox: the chat stays Unread and where it was, focus stays in the inbox, and the tray count drops", async () => {
    const { server, hermes, tray, user, openInbox } = await launch();
    openInbox();
    await user.click(screen.getByRole("button", { name: "Dismiss “Release notes” from the inbox" }));

    expect(rowNames()).toEqual(["Needs approval: Migrate db", "Completed, unread: Deploy plan"]);
    expect(document.activeElement).toBe(rows()[1]);
    await waitFor(() => expect(tray.counts.at(-1)).toBe(2));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "notes")).toMatchObject({ unread: true, settled: false });
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    // Still dismissed after a fresh look at the server.
    await act(async () => void (await hermes.sync()));
    expect(rowNames()).not.toContain("Completed, unread: Release notes");
  });

  it("clears every completed entry the filter shows at once, only from the inbox", async () => {
    const { server, hermes, user, openInbox } = await launch();
    openInbox();
    const clearDone = () => screen.queryByRole("button", { name: "Clear done" });
    await user.click(filter(/^Failed/));
    expect(clearDone()).toBeNull();
    await user.click(filter(/^Needs approval/));
    expect(clearDone()).toBeNull();

    await user.click(filter(/^All/));
    await user.click(clearDone()!);
    expect(rowNames()).toEqual(["Needs approval: Migrate db"]);
    expect(document.activeElement).toBe(rows()[0]);
    expect(clearDone()).toBeNull();
    expect(hermes.getSnapshot().chats.find((c) => c.id === "notes")).toMatchObject({ unread: true, settled: false });
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    await act(async () => void (await hermes.sync()));
    expect(rowNames()).toEqual(["Needs approval: Migrate db"]);
  });

  it("dismisses finished entries older than the time picked in Settings, from then on, and nothing else", async () => {
    const { server, hermes, openInbox } = await launch((server) => {
      server.sessions.push(row("report", 3, { pinned: true, title: "Weekly report", last_read_at: 0 }));
      server.otherProfiles.work.push(row("brief", 3, { pinned: true, title: "Morning brief", last_read_at: 0 }));
      server.liveSessions.push({ id: "rt-old", session_key: "brief", status: "waiting", last_active: nowS() - 3 * 86_400 });
    });
    openInbox();
    expect(rowNames()).toContain("Completed, unread: Weekly report");

    act(() => void setUIPrefs({ inboxAutoDismissDays: 1 }));
    expect(rowNames()).toEqual(["Needs approval: Migrate db", "Needs approval: Morning brief", "Completed, unread: Release notes", "Completed, unread: Deploy plan"]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "report")).toMatchObject({ unread: true });
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("drops a completed entry once its chat is open in another pane, without the inbox closing", async () => {
    const { hermes, openInbox } = await launch();
    openInbox();
    expect(rowNames()).toContain("Completed, unread: Release notes");
    // The owner opens the chat in a second pane from its menu, with the inbox still open.
    await act(async () => void (await hermes.open("notes", "pane-other")));
    await waitFor(() => expect(rowNames()).not.toContain("Completed, unread: Release notes"));
    expect(inbox()).toBeTruthy();
  });

  it("says when Hermes can't be reached, and shows what it last saw", async () => {
    const { server, openInbox } = await launch();
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    openInbox();
    expect(inbox().textContent).toMatch(/Not connected to Hermes: showing what was last seen\./);
    expect(rows()[0].getAttribute("aria-label")).toMatch(/As last seen\.$/);
    expect(screen.getByRole("button", { name: "Check now" })).toHaveProperty("disabled", true);
  });
});
