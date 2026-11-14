// @vitest-environment jsdom
// The Bots view in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row
// shows, that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an
// ordinary chat there, that /new in a Bot Chat compacts it, that the chat list panel shows the bots while a Bot Chat is
// open (bot mode), and that a Hermes without Bot Mode shows no Bots button.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { BOT_CHAT_TITLE, BotModeUnsupportedError, rosterOf, type Bot } from "../hermes/bots";
import { getUIPrefs } from "../hermes/uiPrefs";
import { Bots, BOTS_REFRESH_MS } from "./Bots";
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
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
    // The panel shows the bots meanwhile; back on the chat list, it lists the side-chat only.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
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
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Export…", "Share snapshot…"]);
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

describe("New bot in the Bots view", () => {
  const form = () => screen.getByRole("dialog", { name: "New bot" });

  it("makes a profile through New profile's form and shows the new bot's row, focused, without starting its Bot Chat", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "ada");
    await user.type(within(form()).getByLabelText("Description (optional)"), "Reads papers");
    await user.click(within(form()).getByRole("button", { name: /Create bot/ }));
    await waitFor(() => expect(botRows()).toHaveLength(3));
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body])).toEqual([["POST /api/profiles", { name: "ada", description: "Reads papers" }]]);
    const ada = botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!;
    expect(within(ada).getByText("Reads papers")).toBeTruthy();
    expect(within(ada).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(ada));
    expect(within(bots()).getByRole("status").textContent).toBe("Created ada. Open its row to start its Bot Chat.");
    expect(server.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit")).toEqual([]);
  });

  it("refuses a name another bot's profile has, before asking Hermes", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(within(form()).getByRole("button", { name: /Create bot/ })).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  /** The Bots view with its first roster read still pending: `arrive` gives it `roster` and answers the read. */
  async function pending() {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    let answer = () => {};
    const view = (last?: { roster: Bot[]; at: number }) => (
      <Bots
        server="hermes"
        profile="default"
        connected
        last={last}
        pictures={{}}
        load={() => new Promise<void>((done) => (answer = done))}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        profiles={{
          api: hermes.manageProfiles,
          inUse: "default",
          connected: true,
          unread: () => undefined,
          catalog: async () => [],
          busy: () => undefined,
          lostMessages: () => 0,
          jobCount: async () => undefined,
          switchTo: async () => false,
          local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
          copyText: async () => {},
        }}
      />
    );
    const { rerender } = render(view());
    expect(screen.getByText("Reading the bots…")).toBeTruthy();
    const arrive = (roster: Bot[]) =>
      act(async () => {
        rerender(view({ roster, at: Date.now() }));
        answer();
      });
    return { user, onClose, server, arrive };
  }

  it("keeps focus in the form when the roster arrives after it opened", async () => {
    const { user, onClose, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    const name = within(form()).getByLabelText("Name");
    await user.type(name, "ada");
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }] }));
    expect(botRows()).toHaveLength(1);
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Escape}");
    expect(within(form()).getByText("The changes you made here aren't saved.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("waits for the roster before creating, so a taken name never reaches Hermes", async () => {
    const { user, server, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    const create = within(form()).getByRole("button", { name: /Create bot/ });
    expect(create).toHaveProperty("disabled", true);
    expect(within(form()).getByRole("status").textContent).toBe("Wait for the list of profiles, so the name can be checked against it.");
    await user.click(create);
    await user.keyboard("{Enter}");
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }, { name: "scribe", canonical_session: null }] }));
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(create).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("closes only the form on Escape, with focus back on New bot", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(bots()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New bot" }));
  });
});

describe("Opening the Bots view", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const picture = (i: number) => botRows()[i].querySelector("img")?.getAttribute("src");
  /** Holds every later `profiles.list` until `release`, so the view can show only what the app already read. */
  function holdRosters(server: FakeHermes) {
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    return () => {
      server.handlers["profiles.list"] = list;
      held.splice(0).forEach((f) => f());
    };
  }

  it("shows the bots and their pictures at once after connecting, before Hermes answers again", async () => {
    const { server, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    holdRosters(server);
    await user.click(botsButton()!);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    expect(screen.queryByText("Reading the bots…")).toBeNull();
    expect(document.activeElement).toBe(botRows()[0]);
  });

  it("shows them at once on reopening, and doesn't ask for the pictures again on the same connection", async () => {
    const { server, hermes, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    await openBots(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    const release = holdRosters(server);
    await user.click(botsButton()!);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    expect(server.requests.filter((r) => r.method === "profiles.get_asset")).toHaveLength(1);
  });

  it("shows the roster read last, then a change on the server once it is read again", async () => {
    const { server, user } = await launch();
    const scribe = server.profileMeta.scribe.ui_meta!["hermes-bots"] as { title: string };
    scribe.title = "Quill";
    const release = holdRosters(server);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await user.click(botsButton()!);
      expect(names()).toEqual(["Hermes", "Scribe"]);
      await act(async () => release());
      await waitFor(() => expect(names()).toEqual(["Hermes", "Quill"]));
      scribe.title = "Inkwell";
      await act(async () => void vi.advanceTimersByTime(BOTS_REFRESH_MS));
      await waitFor(() => expect(names()).toEqual(["Hermes", "Inkwell"]));
    } finally {
      vi.useRealTimers();
    }
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
        pictures={{}}
        load={async () => {
          throw new BotModeUnsupportedError("This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode.");
        }}
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

describe("Bot mode in the chat list panel", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const panelBots = () => Array.from(panel().querySelectorAll<HTMLButtonElement>(".bots-open"));
  const names = () => panelBots().map((r) => r.querySelector(".bots-name")?.textContent);
  const current = () => panelBots().map((r) => r.getAttribute("aria-current"));

  async function openScribe(user: ReturnType<typeof userEvent.setup>) {
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
  }

  it("shows the bots instead of the chats while a Bot Chat is open, with its bot current", async () => {
    const { user } = await launch();
    await openScribe(user);
    expect(within(panel()).getByRole("heading", { name: "Bots" })).toBeTruthy();
    expect(current()).toEqual([null, "true"]);
    expect(within(panelBots()[1]).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(listTitles()).toEqual([]);
    expect(panel().querySelector(".profile-btn")?.textContent).toMatch(/scribe/);
    expect(within(panel()).getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Search chats" })).toBeTruthy();
  });

  it("goes back to the chat list on New chat", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.click(within(panel()).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
    expect(within(panel()).queryByRole("heading", { name: "Bots" })).toBeNull();
  });

  it("goes back to the chat list on Ctrl+N", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    await waitFor(() => expect(listTitles()).toContain("Changelog wording"));
    expect(panelBots()).toEqual([]);
  });

  it("goes back to the chat list once an ordinary chat opens from search", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Changelog");
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await waitFor(() => expect(screen.getByText("Which wording reads better?")).toBeTruthy());
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
  });

  it("opens another bot's Bot Chat from the panel, in its profile, and stays in bot mode with that bot current", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    // Never the next profile's chats meanwhile.
    const chatsShown: string[][] = [];
    const watch = new MutationObserver(() => panelBots().length || chatsShown.push(listTitles() as string[]));
    watch.observe(document.body, { subtree: true, childList: true });
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    const made = await waitFor(() => server.sessions.find((s) => s.title === BOT_CHAT_TITLE && s.hidden)!.id);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === made)?.bot).toBe(true));
    await act(async () => void (await hermes.idle()));
    watch.disconnect();
    expect(chatsShown).toEqual([]);
    expect(current()).toEqual(["true", null]);
    expect(within(document.querySelector<HTMLElement>(".chat-head")!).getByText("Bot")).toBeTruthy();
    expect(panel().querySelector(".profile-btn")?.textContent).toMatch(/default/);
  });

  it("asks before a bot in another profile opens while an Approval waits here, as the Bots view does", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    await act(async () => void server.askApproval(server.runtimeIdOf("scribe-bot")!));
    await user.click(panelBots()[0]);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to default?" });
    expect(ask.textContent).toMatch(/An approval is waiting in scribe/);
    await user.keyboard("{Escape}");
    expect(ask.isConnected).toBe(false);
    expect(hermes.profile).toBe("scribe");
    expect(current()).toEqual([null, "true"]);
    // Escape from a row, or choosing another row, also takes the question away.
    await user.click(panelBots()[0]);
    panelBots()[1].focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    await user.click(panelBots()[0]);
    await user.click(panelBots()[1]);
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    expect(hermes.profile).toBe("scribe");
    await user.click(panelBots()[0]);
    await user.click(screen.getByRole("button", { name: "Switch to default" }));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(current()).toEqual(["true", null]));
  });

  it("keeps a chat started while another bot's Bot Chat is on its way, and leaves bot mode for it", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void held.push(() => lookup(r)) : lookup(r));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(held).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    await waitFor(() => expect(panelBots()).toEqual([]));
    server.handlers["session.list"] = lookup;
    held.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(panelBots()).toEqual([]);
  });

  it("keeps a chat sent while it is still starting, when the Bot Chat on its way is found first", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const create = server.handlers["session.create"];
    const lookups: (() => void)[] = [];
    const creates: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void lookups.push(() => lookup(r)) : lookup(r));
    server.handlers["session.create"] = (r) => (r.params.title ? create(r) : void creates.push(() => create(r)));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(lookups).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(creates).toHaveLength(1));
    server.handlers["session.list"] = lookup;
    lookups.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    // The owner's message is on its way to a chat of its own, so the Bot Chat found meanwhile doesn't take the pane.
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    server.handlers["session.create"] = create;
    creates.splice(0).forEach((f) => f());
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Check the disk/);
    expect(panelBots()).toEqual([]);
  });

  it("isn't in bot mode after a relaunch", async () => {
    const { hermes, user } = await launch();
    await openScribe(user);
    cleanup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
  });
});
