// @vitest-environment jsdom
// The Bots view in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row
// shows, that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an
// ordinary chat there, that /new in a Bot Chat compacts it, and that a Hermes without Bot Mode shows no Bots button.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { BOT_CHAT_TITLE, BotModeUnsupportedError } from "../hermes/bots";
import { getUIPrefs } from "../hermes/uiPrefs";
import { Bots } from "./Bots";
import { connect, type Hermes } from "../hermes/transport";
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

/** Signed in to `default`, with Scribe in `scribe`: its Bot Chat holds one exchange and is replying again. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage", last_read_at: nowS() })];
  server.otherProfiles = {
    scribe: [
      row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() }),
      row("scribe-side", 1, { pinned: true, title: "Changelog wording", last_read_at: nowS() }),
    ],
  };
  server.transcripts = {
    disk: [{ role: "user", text: "How full is the disk?" }],
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
    "scribe-side": [{ role: "user", text: "Which wording reads better?" }],
  };
  server.profileMeta = { scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  server.liveSessions = [{ id: "rt-s", session_key: "scribe-bot", status: "working", last_active: nowS() - 5 }];
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  return { server, hermes, user: userEvent.setup() };
}

const botsButton = () => document.querySelector<HTMLButtonElement>(".bots-btn");
const bots = () => screen.getByRole("dialog", { name: /Bots/ });
const botRows = () => Array.from(bots().querySelectorAll<HTMLButtonElement>(".bots-open"));
const listTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);

async function pickProfile(user: ReturnType<typeof userEvent.setup>, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${profile}`) }));
}

async function openBots(user: ReturnType<typeof userEvent.setup>) {
  await user.click(botsButton()!);
  await waitFor(() => expect(botRows().length).toBe(2));
}

describe("The Bots view", () => {
  it("lists every profile as a bot, with its description, its Bot Chat's last message and what it is doing", async () => {
    const { user } = await launch();
    await openBots(user);
    const [hermesRow, scribeRow] = botRows();
    expect(within(hermesRow).getByText("Hermes")).toBeTruthy();
    expect(within(hermesRow).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    expect(within(scribeRow).getByText("Scribe")).toBeTruthy();
    expect(within(scribeRow).getByText("Writes release notes")).toBeTruthy();
    expect(within(scribeRow).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(within(scribeRow).getByText("Replying")).toBeTruthy();
    expect(scribeRow.getAttribute("aria-label")).toMatch(/^Scribe\. Replying\. Writes release notes\. Last message: Release notes drafted/);
    expect(screen.getByRole("button", { name: "New chat with Scribe" })).toBeTruthy();
  });

  it("opens a bot's Bot Chat in its profile, and keeps it out of the chat list", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    // Looked up by title, not created.
    expect(server.requests.filter((r) => r.method === "session.list").map((r) => r.params.title)).toEqual([BOT_CHAT_TITLE]);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
    // The list shows the side-chat only.
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
  });

  it("marks the open Bot Chat as one, and offers nothing that would rename, retire or link it by id", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    const head = document.querySelector<HTMLElement>(".chat-head")!;
    expect(within(head).getByText("Bot")).toBeTruthy();
    expect(within(head).queryByText("Settled")).toBeNull();
    await user.click(within(head).getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: /More actions for Bot Chat/ });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Export…"]);
  });

  it("starts a Bot Chat once for a bot without one, and sends nothing", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE && s.hidden)).toBe(true));
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    const id = server.sessions.find((s) => s.title === BOT_CHAT_TITLE)!.id;
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true));
  });

  it("starts an ordinary chat in the bot's profile from the pen", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New chat with Scribe" }));
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
  });

  it("compacts a Bot Chat for /new instead of starting a new chat", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.keyboard("/new{Enter}{Enter}");
    await waitFor(() => expect(screen.getByText(/A Bot Chat is one continuous conversation, so \/new compacts it/)).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.compress")).toHaveLength(1);
    expect(screen.queryByText("What should Hermes work on?")).toBeNull();
  });
});

describe("A Hermes without Bot Mode", () => {
  it("shows no Bots button once the check finds no profiles.list", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
  });

  it("shows no Bots button once the check finds a profiles.list that doesn't report Bot Chats, without opening the view", async () => {
    const { hermes } = await launch((s) => (s.botMode = "no-canonical"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
    expect(hermes.capabilities.get("botMode").why).toMatch(/doesn't report their Bot Chats/);
  });

  it("says why in the view when it finds out there, with focus on Close so Escape closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUnsupported = vi.fn();
    render(
      <Bots
        server="hermes"
        profile="default"
        connected
        load={async () => {
          throw new BotModeUnsupportedError("This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode.");
        }}
        avatar={async () => undefined}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        onUnsupported={onUnsupported}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/so it has no Bot Mode\. Hermes Chat shows no Bots button for it\.$/));
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement?.classList.contains("bots-close")).toBe(true));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("What the owner does while a Bot Chat opens", () => {
  /** Holds every `session.list` until `release`. */
  function holdLookups(server: FakeHermes) {
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => void held.push(() => lookup(r));
    return () => held.splice(0).forEach((f) => f());
  }

  it("keeps the chat the owner opened meanwhile, in the same profile", async () => {
    const { server, hermes, user } = await launch();
    const release = holdLookups(server);
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.requests.some((r) => r.method === "session.list")).toBe(true));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(screen.getByText("How full is the disk?")).toBeTruthy());
    await act(async () => release());
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE)).toBe(true));
    // The Bot Chat was made, but the pane stays on the chat the owner picked.
    await act(async () => void (await hermes.idle()));
    expect(screen.getByText("How full is the disk?")).toBeTruthy();
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Disk usage/);
  });

  it("drops the open once the owner picks another profile before the bot's list loads, even after coming back", async () => {
    const { server, hermes, user } = await launch();
    // The scribe profile's list is held, so the open waits for it.
    const list = server.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    let holding = true;
    server.rest["GET /api/sessions"] = (req) =>
      holding && req.query.get("profile") === "scribe" ? new Promise((resolve) => held.push(() => resolve(list(req)))) : list(req);
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    holding = false;
    held.splice(0).forEach((f) => f());
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    await act(async () => void (await hermes.idle()));
    // Coming back is an ordinary switch: no Bot Chat lookup, and the Bot Chat doesn't open.
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
  });
});

describe("A Bot Chat outside the list", () => {
  it("keeps the rail's dot for an Approval in a Bot Chat resumed here, after switching away from its profile", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const runtimeId = hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")!.runtimeId!;
    // Hermes lists the session this app resumed as waiting; its row carries no title, and the app knows its profile.
    server.liveSessions = [{ id: runtimeId, session_key: "scribe-bot", status: "waiting", last_active: nowS() }];
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.checkOtherProfiles()));
    expect(hermes.getSnapshot().live?.sessions).toEqual([expect.objectContaining({ chatId: "scribe-bot", status: "waiting", profile: "scribe" })]);
    expect(hermes.getSnapshot().live?.sessions[0].title).toBeUndefined();
    await waitFor(() => expect(botsButton()?.getAttribute("aria-label")).toBe("Bots, one needs you"));
  });

  it("stays out of the list after switching away and back, and isn't the chat reopened at launch", async () => {
    const { hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(getUIPrefs().lastOpenChat.scribe).toBeUndefined();
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.switchProfile("scribe")));
    // The saved list shows at once, before Hermes answers: it never held the Bot Chat.
    expect(listTitles()).not.toContain(BOT_CHAT_TITLE);
    await act(async () => void (await hermes.sync()));
    expect(listTitles()).toEqual(["Changelog wording"]);
  });
});
