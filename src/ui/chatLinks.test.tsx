// @vitest-environment jsdom
// Chat links in the running app (ADR 0037), against a fake Hermes: a link opens its chat in its profile, says what
// it is doing meanwhile, asks before leaving a reply running, and when it can't open changes nothing on screen. Links
// never send anything, and Copy chat link copies only ids.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import type { SavedSignIn } from "../hermes/account";
import { connectionRefs, formatChatLink, parseChatLink, type ConnectionRefs } from "../hermes/chatLinks";
import { linkInbox, type LinkInbox } from "../hermes/tauriLinks";
import { Main } from "../App";
import { RestError } from "../hermes/pipe";

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

/** Main fed by a link inbox, as App feeds it. */
function WithLinks({ hermes, connection, inbox, refs }: { hermes: Hermes; connection: SavedSignIn; inbox: LinkInbox; refs: ConnectionRefs }) {
  const arrived = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot);
  const parsed = arrived && parseChatLink(arrived.raw);
  return (
    <Main
      hermes={hermes}
      connection={connection}
      refs={refs}
      link={parsed && parsed.ok ? { link: parsed.link, at: arrived.at } : undefined}
      linkSuperseded={parsed && !parsed.ok ? arrived.at : undefined}
      onLinkTaken={(at) => inbox.clear(at)}
      onSetUp={() => {}}
      onSignOut={async () => {}}
    />
  );
}

async function launch() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" }), row("old", 60, { title: "Old retro" })], ops: [] };
  server.souls = { default: "# Default persona\n", work: "# Work persona\n", ops: "" };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const connection: SavedSignIn = { mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" };
  const refs = connectionRefs(localStorage);
  const inbox = linkInbox();
  render(<WithLinks hermes={hermes} connection={connection} inbox={inbox} refs={refs} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const linkTo = (profile: string, chatId: string, connectionRef = refs.refFor(connection)) => formatChatLink({ connection: connectionRef, profile, chatId });
  const open = async (raw: string) => {
    await act(async () => inbox.arrive(raw));
    await act(async () => void (await hermes.idle()));
  };
  return { server, hermes, connection, refs, inbox, linkTo, open, user: userEvent.setup() };
}

const onScreen = () => document.querySelector(".chat-title span")?.textContent;
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const notice = () => screen.queryByLabelText("Chat link");
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").length;

describe("Opening a chat link", () => {
  it("opens a chat in the profile on screen, and sends nothing", async () => {
    const { server, linkTo, open } = await launch();
    expect(onScreen()).toBe("New chat");
    await open(linkTo("default", "nas"));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    expect(notice()).toBeNull();
    expect(prompts(server)).toBe(0);
  });

  it("switches to the link's profile and opens a chat the month's list doesn't hold", async () => {
    const { server, hermes, linkTo, open } = await launch();
    await open(linkTo("work", "old"));
    await waitFor(() => expect(hermes.getSnapshot().profile).toBe("work"));
    await waitFor(() => expect(onScreen()).toBe("Old retro"));
    expect(hermes.getSnapshot().switching).toBeUndefined();
    expect(notice()).toBeNull();
    expect(prompts(server)).toBe(0);
  });

  it("asks before leaving a profile with a reply running, and Cancel leaves everything as it was", async () => {
    const { hermes, linkTo, open, user } = await launch();
    let id = "";
    await act(async () => {
      id = await hermes.newChat();
      await hermes.send(id, "Summarise the logs");
    });
    await open(linkTo("work", "deploy"));
    const asking = await screen.findByLabelText("Chat link");
    expect(asking.textContent).toMatch(/A reply is still running in default.*Switch to work to open the linked chat\?/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(notice()).toBeNull();
    expect(hermes.getSnapshot().profile).toBe("default");

    await open(linkTo("work", "deploy"));
    await user.click(await screen.findByRole("button", { name: "Switch to work" }));
    await waitFor(() => expect(onScreen()).toBe("Deploy plan"));
    expect(hermes.getSnapshot().profile).toBe("work");
  });

  it("says a deleted chat is gone and leaves the chat and draft on screen", async () => {
    const { server, hermes, linkTo, open, user } = await launch();
    await user.click(screen.getByText("Nightly backup"));
    await user.type(composer(), "half-written thought");
    await open(linkTo("work", "20261101_090000_deadbeef"));
    const said = await screen.findByRole("alert");
    expect(said.textContent).toMatch(/The work profile has no chat with this link's id\. It may have been deleted/);
    expect(onScreen()).toBe("Nightly backup");
    expect(composer().value).toBe("half-written thought");
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(prompts(server)).toBe(0);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notice()).toBeNull();
  });

  it("says a profile the server no longer has is gone, without switching", async () => {
    const { hermes, linkTo, open } = await launch();
    await open(linkTo("retired", "deploy"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no profile named retired/);
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(onScreen()).toBe("New chat");
  });

  it("won't use this connection for a link naming one it doesn't know until the owner says so", async () => {
    const { server, hermes, linkTo, open, user } = await launch();
    const looked = server.restRequests.length;
    await open(linkTo("default", "nas", "fromanothercomputer1"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection this computer doesn't know.*won't connect anywhere for it/);
    // Nothing was asked of Hermes for it.
    expect(server.restRequests.slice(looked).filter((r) => r.path.startsWith("/api/sessions/") || r.path === "/api/profiles")).toEqual([]);
    expect(onScreen()).toBe("New chat");
    await user.click(screen.getByRole("button", { name: "Open it here" }));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    // The same reference now opens without asking.
    await user.click(screen.getByText("Nightly backup"));
    await open(linkTo("default", "nas", "fromanothercomputer1"));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    expect(hermes.getSnapshot().profile).toBe("default");
  });

  it("refuses a link for another connection this computer knows, pointing to Setup", async () => {
    const { refs, linkTo, open } = await launch();
    const elsewhere = refs.refFor({ mode: "url", sshTarget: "", url: "https://lab.example.com", username: "ops" });
    await open(linkTo("default", "nas", elsewhere));
    expect((await screen.findByRole("alert")).textContent).toMatch(/This link is for lab\.example\.com \(ops\), not the connection signed in now/);
    expect(screen.getByRole("button", { name: "Open Setup" })).toBeTruthy();
    expect(onScreen()).toBe("New chat");
  });

  it("waits while Hermes is unreachable, then opens once it's back", async () => {
    const { server, hermes, linkTo, open } = await launch();
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
    await open(linkTo("default", "nas"));
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/opens once Hermes is connected\. Nothing is sent/);
    expect(onScreen()).toBe("New chat");
    server.refuse = undefined;
    await act(async () => void (await hermes.reconnect().catch(() => {})));
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 15_000 });
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    expect(notice()).toBeNull();
  }, 20_000);

  it("says why a lookup failed and tries again on request", async () => {
    const { server, linkTo, open, user } = await launch();
    const profiles = server.rest["GET /api/profiles"];
    server.rest["GET /api/profiles"] = () => {
      throw new RestError(502, "Bad Gateway");
    };
    await open(linkTo("default", "nas"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't look the linked chat up: The dashboard answered 502/);
    server.rest["GET /api/profiles"] = profiles;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
  });

  it("drops a lookup's late answer after Cancel", async () => {
    const { server, linkTo, open, user } = await launch();
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const profiles = server.rest["GET /api/profiles"];
    server.rest["GET /api/profiles"] = async (req) => (await gate, profiles(req));
    await open(linkTo("default", "nas"));
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/Opening the linked chat in default/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => answer());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(onScreen()).toBe("New chat");
    expect(notice()).toBeNull();
  });
});

describe("A chat link and what the owner does meanwhile", () => {
  /** Holds `GET /api/profiles` until `answer` is called. */
  function holdProfiles(server: FakeHermes) {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const profiles = server.rest["GET /api/profiles"];
    server.rest["GET /api/profiles"] = async (req) => (await gate, profiles(req));
    return () => {
      server.rest["GET /api/profiles"] = profiles;
      answer();
    };
  }

  it("drops a slow lookup's answer once the owner has switched profile meanwhile", async () => {
    const { server, hermes, linkTo, open } = await launch();
    const answer = holdProfiles(server);
    await open(linkTo("work", "deploy"));
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/Opening the linked chat in work/);
    await act(async () => void (await hermes.switchProfile("ops")));
    await waitFor(() => expect(hermes.getSnapshot().switching).toBeUndefined());
    answer();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await act(async () => void (await hermes.idle()));
    expect(hermes.getSnapshot().profile).toBe("ops");
    expect(notice()).toBeNull();
  });

  it("drops a slow lookup's answer once the owner has opened another chat meanwhile", async () => {
    const { server, linkTo, open, user } = await launch();
    const answer = holdProfiles(server);
    await open(linkTo("default", "nas"));
    await screen.findByLabelText("Chat link");
    await user.click(screen.getByText("Nightly backup"));
    answer();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(onScreen()).toBe("Nightly backup");
    expect(notice()).toBeNull();
  });

  it("drops a pending link, and its notice, when a newer link that can't open arrives", async () => {
    const { server, hermes, linkTo, open } = await launch();
    const answer = holdProfiles(server);
    await open(linkTo("work", "deploy"));
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/Opening the linked chat in work/);
    await open(`${linkTo("default", "nas")}&send=hello`);
    expect(notice()).toBeNull();
    answer();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await act(async () => void (await hermes.idle()));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(onScreen()).toBe("New chat");
  });

  it("drops a lookup's answer after the owner went to another chat and back", async () => {
    const { server, hermes, linkTo, open, user } = await launch();
    await user.click(screen.getByText("Nightly backup"));
    const answer = holdProfiles(server);
    await open(linkTo("work", "deploy"));
    await screen.findByLabelText("Chat link");
    await user.click(screen.getByText("NAS disks"));
    await user.click(screen.getByText("Nightly backup"));
    answer();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await act(async () => void (await hermes.idle()));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(onScreen()).toBe("Nightly backup");
    expect(notice()).toBeNull();
  });

  it("leaves what the owner opened while the link's profile was loading", async () => {
    const { server, hermes, inbox, linkTo, user } = await launch();
    // The work profile's list takes a while.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = server.rest["GET /api/sessions"];
    server.rest["GET /api/sessions"] = async (req) => (req.query.get("profile") === "work" && (await gate), list(req));
    // Not `open`, which waits for Hermes to be idle: the held list keeps it busy.
    await act(async () => inbox.arrive(linkTo("work", "old")));
    await waitFor(() => expect(hermes.getSnapshot().profile).toBe("work"));
    expect(hermes.getSnapshot().switching).toBeTruthy();
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/Switching to work/);
    // The owner starts a new chat meanwhile.
    await user.keyboard("{Control>}n{/Control}");
    release();
    await waitFor(() => expect(hermes.getSnapshot().switching).toBeUndefined());
    await act(async () => void (await hermes.idle()));
    expect(onScreen()).toBe("New chat");
    expect(notice()).toBeNull();
  });

  async function unsavedPersona(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "SOUL.md for the default profile" });
    await user.click(box);
    await user.paste("Unsaved words");
  }

  it("asks about an unsaved persona edit first, and Keep editing drops the link", async () => {
    const { hermes, linkTo, open, user } = await launch();
    await unsavedPersona(user);
    await open(linkTo("work", "deploy"));
    const ask = await screen.findByRole("alertdialog");
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(notice()).toBeNull();
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "SOUL.md for the default profile" }).value).toMatch(/Unsaved words/);
  });

  it("won't switch for a link a newer one replaced while the unsaved-edit question was open", async () => {
    const { hermes, linkTo, open, user } = await launch();
    await unsavedPersona(user);
    await open(linkTo("work", "deploy"));
    const ask = await screen.findByRole("alertdialog");
    // A newer link, which can't open, arrives while the question is up.
    await open(linkTo("default", "nas", "fromanothercomputer1"));
    await screen.findByText(/connection this computer doesn't know/);
    await user.click(within(ask).getByRole("button", { name: "Switch anyway" }));
    await act(async () => void (await hermes.idle()));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(onScreen()).not.toBe("Deploy plan");
  });
});

describe("Copy chat link", () => {
  it("copies a link with ids only, which opens the chat again", async () => {
    const { connection, open, user } = await launch();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    await user.click(screen.getByText("NAS disks"));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy chat link" }));
    await screen.findByText(/Chat link copied/);
    expect(copied).toHaveLength(1);
    const parsed = parseChatLink(copied[0]);
    expect(parsed.ok && parsed.link).toMatchObject({ profile: "default", chatId: "nas" });
    for (const leak of [connection.sshTarget, "@", "liam", "password", "token"]) expect(copied[0]).not.toContain(leak);

    await user.click(screen.getByText("Nightly backup"));
    await open(copied[0]);
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
  });

  it("is in a chat's right-click menu too", async () => {
    const { user } = await launch();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Nightly backup") });
    await user.click(await screen.findByRole("menuitem", { name: "Copy chat link" }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toMatch(/^hermes-chat:\/\/chat\?v=1&connection=[a-z2-7]{20}&profile=default&id=backup$/);
  });
});
