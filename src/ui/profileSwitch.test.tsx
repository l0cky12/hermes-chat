// @vitest-environment jsdom
// Switching profile in the running app, against a fake Hermes: what it asks first, what it shows while the new
// profile connects or if it can't, and that nothing of one profile turns up in the other.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type RestRequest } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

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

// Drafts are kept in memory once read, across tests; a connection of its own keeps each test's apart.
let launches = 0;

async function launch() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user: userEvent.setup() };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");

async function pickProfile(user: ReturnType<typeof userEvent.setup>, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(profile) }));
}

async function switched(hermes: Hermes, profile: string) {
  await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile, status: "connected" }));
  await waitFor(() => expect(hermes.getSnapshot().switching).toBeUndefined());
  await act(async () => void (await hermes.idle()));
}

describe("Switching profile in the app", () => {
  it("says in the switcher's tooltip how long ago the other profiles were checked, as of when it shows", async () => {
    const { hermes, user } = await launch();
    await act(async () => void (await hermes.checkOtherProfiles()));
    const button = document.querySelector<HTMLElement>(".profile-btn")!;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 180_000 });
    try {
      await user.hover(button);
      expect(button.title).toMatch(/; last 3m ago$/);
      await user.unhover(button);
      await act(async () => void (await hermes.checkOtherProfiles()));
      await user.hover(button);
      expect(button.title).toMatch(/; last just now$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks before leaving a profile where an Approval is waiting, and stays when the owner says so", async () => {
    const { server, hermes, user } = await launch();
    await act(async () => {
      const id = await hermes.newChat();
      await hermes.send(id, "Clean up the logs");
      server.askApproval(server.runtimeIdOf(id)!);
    });

    await pickProfile(user, "work");
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/An approval is waiting in default/);
    expect(ask.textContent).toMatch(/switch back and open the chat to answer it/);
    expect(screen.getByRole("button", { name: "Stay" })).toBe(document.activeElement);
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await pickProfile(user, "work");
    await user.click(await screen.findByRole("button", { name: "Switch anyway" }));
    await switched(hermes, "work");
  });

  it("says a reply is still running before leaving its profile", async () => {
    const { hermes, user } = await launch();
    await act(async () => {
      const id = await hermes.newChat();
      await hermes.send(id, "Summarise the logs");
    });
    await pickProfile(user, "work");
    expect((await screen.findByRole("alertdialog")).textContent).toMatch(/A reply is still running in default\. Hermes keeps it going/);
  });

  it("keeps the question open if the reply finishes meanwhile, and puts focus back on the switcher on Stay", async () => {
    const { server, hermes, user } = await launch();
    let id = "";
    await act(async () => {
      id = await hermes.newChat();
      await hermes.send(id, "Summarise the logs");
    });
    await pickProfile(user, "work");
    const ask = await screen.findByRole("alertdialog");
    expect(ask.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(ask.getAttribute("aria-describedby")!)?.textContent).toMatch(/A reply is still running/);
    act(() => server.event(server.runtimeIdOf(id)!, "message.complete", { text: "Done." }));
    expect(screen.getByRole("alertdialog")).toBe(ask);

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(document.activeElement).toBe(document.querySelector(".profile-btn"));
    expect(document.querySelector(".profile-btn")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the switch under way, then the new profile's chats", async () => {
    const { server, hermes, user } = await launch();
    const list = server.rest["GET /api/sessions"];
    let release!: () => void;
    server.rest["GET /api/sessions"] = (req: RestRequest) =>
      new Promise((resolve) => (release = () => ((server.rest["GET /api/sessions"] = list), resolve(list(req)))));

    await pickProfile(user, "work");
    expect((await screen.findByRole("status", { name: "Switching profile" })).textContent).toMatch(/Loading work's chats/);
    release();
    await switched(hermes, "work");
    expect(screen.queryByRole("status", { name: "Switching profile" })).toBeNull();
    expect(screen.getByRole("button", { name: /Deploy plan/ })).toBeTruthy();
  });

  it("says why when the new profile can't be opened, and goes back to the old one", async () => {
    const { server, hermes, user } = await launch();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    await pickProfile(user, "work");
    const status = await screen.findByRole("status", { name: "Switching profile" });
    await waitFor(() => expect(status.textContent).toMatch(/Couldn't open work: ssh: connect to host hermes port 22: Connection refused/));

    server.refuse = undefined;
    await user.click(screen.getByRole("button", { name: "Back to default" }));
    await switched(hermes, "default");
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
  });

  it("tries the new profile again when asked", async () => {
    const { server, hermes, user } = await launch();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    await pickProfile(user, "work");
    await screen.findByText(/Couldn't open work/);
    server.refuse = undefined;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await switched(hermes, "work");
  });

  it("keeps each profile's New chat draft to itself", async () => {
    const { hermes, user } = await launch();
    await user.type(composer(), "for default");
    await pickProfile(user, "work");
    await switched(hermes, "work");
    expect(composer().value).toBe("");
    await user.type(composer(), "for work");

    await pickProfile(user, "default");
    await switched(hermes, "default");
    expect(composer().value).toBe("for default");
    await pickProfile(user, "work");
    await switched(hermes, "work");
    expect(composer().value).toBe("for work");
  });

  it("keeps a chat that was starting as the owner switched out of the new profile, and its text in the old one", async () => {
    const { server, hermes, user } = await launch();
    const create = server.handlers["session.create"];
    let answer!: () => void;
    server.handlers["session.create"] = (r) => void (answer = () => create(r));
    await user.type(composer(), "start something{Enter}");
    await pickProfile(user, "work");
    act(() => answer());
    await switched(hermes, "work");

    expect(document.querySelector(".chat-title span")?.textContent).toBe("New chat");
    expect(composer().value).toBe("");
    expect(screen.queryByText(/Couldn't start a chat/)).toBeNull();

    server.handlers["session.create"] = create;
    await pickProfile(user, "default");
    await switched(hermes, "default");
    expect(composer().value).toBe("start something");
  });
});
