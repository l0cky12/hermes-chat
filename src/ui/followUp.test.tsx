// @vitest-environment jsdom
// What sending does while Hermes replies (ADR 0057): queue it (ADR 0018) or steer it into the running reply, by the
// Follow-up behavior setting, with Ctrl+Enter doing the other. Driven the way the owner would, against a fake Hermes;
// each test checks what is on screen and what reached Hermes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";

const dialog = vi.hoisted(() => ({ picked: null as string[] | null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/api/core", async (actual) => {
  const core = await actual<typeof import("@tauri-apps/api/core")>();
  return { ...core, invoke: async (cmd: string, ...rest: never[]) => (cmd === "attach_picked_files" ? (dialog.picked ?? []) : core.invoke(cmd, ...rest)) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  dialog.picked = null;
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
const steers = (server: FakeHermes) => server.requests.filter((r) => r.method === "command.dispatch").map((r) => r.params.arg);
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const queued = () => Array.from(document.querySelectorAll(".queue-text")).map((t) => t.textContent);
const keys = () => document.querySelector(".composer-keys")?.textContent;
const steered = () => Array.from(document.querySelectorAll(".msg.user.steer .bubble-text")).map((t) => t.textContent);
const notes = () => Array.from(document.querySelectorAll(".attach-note")).map((n) => n.textContent);

/** Signed in, with "Nightly backup" open and a reply streaming in it. `setup` changes the fake Hermes first. */
async function replying(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await settle(hermes);
  await user.type(composer(), "Unlock it{Enter}");
  await waitFor(() => expect(prompts(server)).toEqual(["Unlock it"]));
  const runtime = server.runtimeIdOf("backup")!;
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Unlocking" });
  });
  // The check of whether this Hermes has /steer.
  await settle(hermes);
  const finish = async (payload: Record<string, unknown> = { status: "complete" }) => {
    act(() => server.event(runtime, "message.complete", payload));
    await settle(hermes);
    await act(async () => {});
  };
  return { server, hermes, user, runtime, finish };
}

describe("Follow-up behavior: Queue (the default)", () => {
  it("Enter queues as before, and Ctrl+Enter steers that one message into the running reply", async () => {
    const s = await replying();
    expect(keys()).toBe("Enter to queue · Ctrl+Enter to steer");
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();

    await s.user.type(composer(), "Then prune old snapshots{Enter}");
    expect(queued()).toEqual(["Then prune old snapshots"]);
    expect(steers(s.server)).toEqual([]);

    await s.user.type(composer(), "Skip the cache folder{Control>}{Enter}{/Control}");
    await settle(s.hermes);
    expect(steers(s.server)).toEqual(["Skip the cache folder"]);
    expect(s.server.last("command.dispatch")?.params).toEqual({ name: "steer", arg: "Skip the cache folder", session_id: s.runtime });
    expect(composer().value).toBe("");
    // In the chat, marked as a steer, and not queued or sent as a turn of its own.
    expect(steered()).toEqual(["Skip the cache folder"]);
    expect(screen.getByText("Steered into the reply")).toBeTruthy();
    expect(queued()).toEqual(["Then prune old snapshots"]);
    expect(prompts(s.server)).toEqual(["Unlock it"]);

    // The reply carries on after the steer; the queue still goes once it ends.
    act(() => s.server.event(s.runtime, "message.delta", { text: " and skipping the cache." }));
    await s.finish({ status: "complete", text: "Unlocking and skipping the cache." });
    expect(prompts(s.server)).toEqual(["Unlock it", "Then prune old snapshots"]);
  });

  it("with no reply running, Enter and Ctrl+Enter both send as they always have", async () => {
    const s = await replying();
    await s.finish();
    expect(keys()).toBe("Enter to send · Shift+Enter for a new line");
    await s.user.type(composer(), "Thanks{Control>}{Enter}{/Control}");
    await waitFor(() => expect(prompts(s.server)).toEqual(["Unlock it", "Thanks"]));
    expect(steers(s.server)).toEqual([]);
  });
});

describe("Follow-up behavior: Steer", () => {
  it("Enter steers, the button says so, and Ctrl+Enter queues", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying();
    expect(keys()).toBe("Enter to steer · Ctrl+Enter to queue");
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();

    await s.user.type(composer(), "Use the second disk");
    await s.user.click(screen.getByRole("button", { name: "Steer" }));
    await settle(s.hermes);
    await s.user.type(composer(), "Keep going{Enter}");
    await settle(s.hermes);
    expect(steers(s.server)).toEqual(["Use the second disk", "Keep going"]);
    expect(steered()).toEqual(["Use the second disk", "Keep going"]);

    await s.user.type(composer(), "Then report sizes{Control>}{Enter}{/Control}");
    expect(queued()).toEqual(["Then report sizes"]);
    expect(steers(s.server)).toHaveLength(2);
  });

  it("queues instead when this Hermes's /steer would be replaced by a quick command, and says so once", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying((server) => (server.quickCommands = { steer: "exec: ./deploy.sh" }));
    // Enter can't steer here, so the hint says what it does do, and why on hover.
    expect(keys()).toBe("Enter to queue · Shift+Enter for a new line");
    expect(document.querySelector(".composer-keys")?.getAttribute("title")).toMatch(/^Can't steer now: This Hermes has a quick or plugin command called \/steer/);
    await s.user.type(composer(), "Use the second disk{Enter}");
    expect(queued()).toEqual(["Use the second disk"]);
    expect(notes()).toEqual([expect.stringMatching(/^Your message is queued, not steered\. \/steer can't run: This Hermes has a quick or plugin command called \/steer/)]);
    await s.user.type(composer(), "And report sizes{Enter}");
    expect(queued()).toEqual(["Use the second disk", "And report sizes"]);
    expect(notes()).toEqual([]);
    expect(steers(s.server)).toEqual([]);
  });

  it("queues instead when this Hermes doesn't list /steer", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying((server) => (server.commandCatalog = ["context"]));
    await s.user.type(composer(), "Use the second disk{Enter}");
    expect(queued()).toEqual(["Use the second disk"]);
    expect(notes()).toEqual([expect.stringMatching(/\/steer can't run: This Hermes doesn't list it/)]);
    expect(steers(s.server)).toEqual([]);
  });

  it("queues a message with files, saying a steer carries only words", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying((server) => (server.files["/home/liam/df.txt"] = "sda 92%"));
    dialog.picked = ["/home/liam/df.txt"];
    await s.user.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByText("df.txt");
    expect(keys()).toBe("Enter to queue · Shift+Enter for a new line");
    await s.user.type(composer(), "Here's the disk{Enter}");
    expect(queued()).toEqual(["Here's the disk"]);
    expect(notes()).toEqual(["Your message is queued, not steered. A steer carries only words, so a message with files goes after the reply."]);
    expect(document.querySelector(".composer-keys")?.getAttribute("title")).toBeNull();
    expect(steers(s.server)).toEqual([]);
  });

  it("queues the words when Hermes had no reply to steer by the time they arrived", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying((server) => (server.steerable = false));
    await s.user.type(composer(), "Then tidy up{Enter}");
    await settle(s.hermes);
    expect(steers(s.server)).toEqual(["Then tidy up"]);
    expect(steered()).toEqual([]);
    expect(queued()).toEqual(["Then tidy up"]);
    expect(notes()).toEqual(["Hermes couldn't steer the reply just then, so your message is queued instead."]);
    expect(composer().value).toBe("");
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "Then tidy up"]);
  });

  it("keeps the words and says why when Hermes refuses the steer", async () => {
    setUIPrefs({ followUp: "steer" });
    const s = await replying();
    s.server.handlers["command.dispatch"] = (r) => s.server.fail(r.id, 4009, "session busy");
    await s.user.type(composer(), "Use the second disk{Enter}");
    await settle(s.hermes);
    expect(composer().value).toBe("Use the second disk");
    expect(notes()).toEqual([expect.stringMatching(/^Couldn't steer the reply, so nothing was sent: .*session busy/)]);
    expect(steered()).toEqual([]);
    expect(queued()).toEqual([]);
    // Drafts outlive a test in memory; the next one starts with an empty composer.
    await s.user.clear(composer());
  });
});

describe("Settings → General → Chats", () => {
  it("picks the Follow-up behavior, Queue until changed", async () => {
    const s = await replying();
    await s.user.click(screen.getByRole("button", { name: "Settings" }));
    await s.user.click(within(screen.getByRole("navigation", { name: "General" })).getByRole("button", { name: "Chats" }));
    const group = screen.getByRole("group", { name: "Follow-up behavior" });
    expect(within(group).getByRole("button", { name: "Queue" }).getAttribute("aria-pressed")).toBe("true");
    await s.user.click(within(group).getByRole("button", { name: "Steer" }));
    expect(within(group).getByRole("button", { name: "Steer" }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).followUp).toBe("steer");
  });
});

describe("A rebound Send", () => {
  it("is the key the Queue and Steer buttons name", async () => {
    const s = await replying();
    act(() => void setUIPrefs({ keybindings: { send: ["Ctrl+J"] } }));
    expect(screen.getByRole("button", { name: "Queue" }).title).toBe("Queue: send after the reply (Ctrl+J)");
    act(() => void setUIPrefs({ followUp: "steer" }));
    expect(screen.getByRole("button", { name: "Steer" }).title).toBe("Steer: add to the running reply without stopping it (Ctrl+J)");
    await s.finish();
  });
});
