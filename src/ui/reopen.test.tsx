// @vitest-environment jsdom
// "Reopen last chat on launch": the app quits and starts again against a fake Hermes, sharing only this computer's
// storage between launches, and the test checks which chat is on screen after the restart.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache, type MemoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
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

/** A server with two Active chats in `default` and one in `work`. */
function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  s.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  return s;
}

/** The title of the chat on screen: "New chat" for the New chat pane. */
const onScreen = () => document.querySelector(".chat-title span")?.textContent;
const storedLastOpen = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").lastOpenChat;

/** The app starting: signed in, the list read from Hermes, and every answer landed. */
async function launch(s: FakeHermes, cache?: MemoryCache, { reopenLast = true } = {}) {
  const hermes = await connect(s.openPipe, undefined, cache);
  running.push(hermes);
  render(
    <Main
      hermes={hermes}
      connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }}
      reopenLast={reopenLast}
      onSignOut={async () => {}}
    />,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

/** The app closing: the window goes and the connection with it. Nothing is written on the way out. */
async function quit() {
  const before = localStorage.getItem(UI_PREFS_KEY);
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  expect(localStorage.getItem(UI_PREFS_KEY)).toBe(before);
}

const openFromList = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  await user.click(await screen.findByRole("button", { name: new RegExp(title) }));
  await waitFor(() => expect(onScreen()).toBe(title));
};

async function switchTo(user: ReturnType<typeof userEvent.setup>, hermes: Hermes, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(profile) }));
  await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile, status: "connected" }));
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
}

describe("across a restart", () => {
  it("reopens the chat that was on screen when the app closed", async () => {
    const s = server();
    const first = await launch(s);
    expect(onScreen()).toBe("New chat");
    await openFromList(first.user, "NAS disks");
    // Kept as the owner moved, not as the app closed.
    expect(storedLastOpen()).toEqual({ default: "nas" });
    await quit();

    await launch(s);
    expect(onScreen()).toBe("NAS disks");
    expect(screen.getByRole("button", { name: /NAS disks/ }).getAttribute("aria-current")).toBe("true");
  });

  it("shows the chat from the list saved on this computer before Hermes's list arrives", async () => {
    const s = server();
    const cache = memoryCache();
    const first = await launch(s, cache);
    await openFromList(first.user, "Nightly backup");
    await quit();

    const hermes = await connect(s.openPipe, undefined, cache);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} reopenLast onSignOut={async () => {}} />);
    // First render: the saved list already has it, so the New chat pane never shows.
    expect(onScreen()).toBe("Nightly backup");
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    expect(onScreen()).toBe("Nightly backup");
  });

  it("follows the last move: a chat opened after another, or the New chat pane", async () => {
    const s = server();
    const first = await launch(s);
    await openFromList(first.user, "NAS disks");
    await openFromList(first.user, "Nightly backup");
    await quit();
    const second = await launch(s);
    expect(onScreen()).toBe("Nightly backup");

    await second.user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(onScreen()).toBe("New chat"));
    expect(storedLastOpen()).toEqual({});
    await quit();
    await launch(s);
    expect(onScreen()).toBe("New chat");
  });

  it("starts on the New chat pane with the setting off, and still keeps the chat for when it's back on", async () => {
    const s = server();
    const first = await launch(s);
    await openFromList(first.user, "NAS disks");
    setUIPrefs({ reopenLastChat: false });
    await quit();

    await launch(s);
    expect(onScreen()).toBe("New chat");
    expect(storedLastOpen()).toEqual({ default: "nas" });
    await quit();

    setUIPrefs({ reopenLastChat: true });
    await launch(s);
    expect(onScreen()).toBe("NAS disks");
  });

  it("doesn't reopen anything when signing in again in the same run", async () => {
    const s = server();
    const first = await launch(s);
    await openFromList(first.user, "NAS disks");
    await quit();
    await launch(s, undefined, { reopenLast: false });
    expect(onScreen()).toBe("New chat");
  });

  it("lets the owner's own pick win over the chat waiting to reopen", async () => {
    const s = server();
    const first = await launch(s);
    await openFromList(first.user, "NAS disks");
    await quit();

    // Hermes's list is slow to come; the owner starts a new chat before it does.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rest = s.openPipe;
    s.openPipe = async (onEvent, profile) => {
      const pipe = await rest(onEvent, profile);
      const request = pipe.request.bind(pipe);
      return { ...pipe, request: async (method, path, body) => (path.includes("api/sessions?") && await gate, request(method, path, body)) } as typeof pipe;
    };
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} reopenLast onSignOut={async () => {}} />);
    await user.keyboard("{Control>}n{/Control}");
    release();
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(onScreen()).toBe("New chat");
    expect(storedLastOpen()).toEqual({});
  });
});

describe("per profile", () => {
  it("keeps each profile's last chat apart and reopens the one for the profile shown", async () => {
    const s = server();
    const cache = memoryCache();
    const first = await launch(s, cache);
    await openFromList(first.user, "NAS disks");
    await switchTo(first.user, first.hermes, "work");
    // The switch starts a new chat in `work`, and `default` keeps its chat for the next launch.
    expect(onScreen()).toBe("New chat");
    expect(storedLastOpen()).toEqual({ default: "nas" });
    await openFromList(first.user, "Deploy plan");
    expect(storedLastOpen()).toEqual({ default: "nas", work: "deploy" });
    await quit();

    // The app starts in the profile shown last.
    const second = await launch(s, cache);
    expect(second.hermes.getSnapshot().profile).toBe("work");
    expect(onScreen()).toBe("Deploy plan");
    // Switching profile mid-run isn't a launch: the other profile starts on a new chat.
    await switchTo(second.user, second.hermes, "default");
    expect(onScreen()).toBe("New chat");
    await quit();

    await launch(s, cache);
    expect(onScreen()).toBe("NAS disks");
    expect(storedLastOpen()).toEqual({ default: "nas", work: "deploy" });
  });
});

describe("a chat that is gone", () => {
  it("falls back to the New chat pane and forgets the chat when Hermes no longer lists it", async () => {
    const s = server();
    const first = await launch(s);
    await openFromList(first.user, "NAS disks");
    await quit();

    s.sessions = s.sessions.filter((r) => r.id !== "nas"); // Deleted in another Hermes client.
    await launch(s);
    expect(onScreen()).toBe("New chat");
    expect(storedLastOpen()).toEqual({});
  });

  it("leaves the saved copy for the New chat pane once Hermes's list is read without it", async () => {
    const s = server();
    const cache = memoryCache();
    const first = await launch(s, cache);
    await openFromList(first.user, "NAS disks");
    await quit();

    s.sessions = s.sessions.filter((r) => r.id !== "nas");
    const { user } = await launch(s, cache);
    expect(onScreen()).toBe("New chat");
    expect(storedLastOpen()).toEqual({});
    expect(screen.queryByRole("button", { name: /NAS disks/ })).toBeNull();
    // It is the New chat pane, not the gone chat behind it: a message starts a new chat.
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Still there?{Enter}");
    await waitFor(() => expect(s.requests.filter((r) => r.method === "session.create")).toHaveLength(1));
  });

  it("forgets only the profile whose chat is gone", async () => {
    setUIPrefs({ lastOpenChat: { default: "gone", work: "deploy" } });
    await launch(server());
    expect(onScreen()).toBe("New chat");
    expect(getUIPrefs().lastOpenChat).toEqual({ work: "deploy" });
  });
});

describe("the Settings toggle", () => {
  it("turns reopening off and on", async () => {
    const { user } = await launch(server());
    await user.click(screen.getByRole("button", { name: /^Settings/ }));
    await user.click(await screen.findByRole("button", { name: "Launch, tray & updates" }));
    const toggle = await screen.findByRole("switch", { name: "Reopen last chat on launch" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getUIPrefs().reopenLastChat).toBe(false);
    await user.click(toggle);
    expect(getUIPrefs().reopenLastChat).toBe(true);
  });
});
