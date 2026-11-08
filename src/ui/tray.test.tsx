// @vitest-environment jsdom
// The tray and Close to tray in the signed-in app (tray.rs, ADR 0034), against a fake Hermes. The tray itself is a
// stand-in for what Rust sends and answers; the app, Settings and the chats are the real code.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import type { TrayStatus } from "../hermes/tauriTray";
import { FakeTray } from "../hermes/fakeTray";
import { Main } from "../App";
import { TraySettings } from "./TraySettings";
import { setWindowHidden } from "./windowState";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  act(() => setWindowHidden(false));
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const nowS = () => Date.now() / 1000;
let launches = 0;

async function launch() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup", last_read_at: nowS() }),
    row("notes", 0.01, { pinned: true, title: "Release notes", last_read_at: 0 }),
  ];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }] };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const tray = new FakeTray();
  const view = render(
    <Main hermes={hermes} tray={tray} connection={{ mode: "ssh", sshTarget: `liam@tray-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server, hermes, tray, view, user: userEvent.setup() };
}

const row_ = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
const chatTitle = () => document.querySelector(".chat-title span")?.textContent;

describe("The tray menu", () => {
  it("is told only how many Inbox entries need the owner, and nothing once signed out", async () => {
    const { tray, view } = await launch();
    await waitFor(() => expect(tray.counts.at(-1)).toBe(1));
    view.unmount();
    expect(tray.counts.at(-1)).toBe(0);
    expect(tray.counts.every((n) => typeof n === "number")).toBe(true);
  });

  it("starts a new chat from New chat, as the app's own New chat does", async () => {
    const { tray, hermes } = await launch();
    row_("Nightly backup").click();
    await act(async () => void (await hermes.idle()));
    expect(chatTitle()).toBe("Nightly backup");
    tray.pick("newChat");
    expect(chatTitle()).toBe("New chat");
  });

  it("opens the Inbox from Open Inbox", async () => {
    const { tray } = await launch();
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    tray.pick("inbox");
    expect(await screen.findByRole("dialog", { name: /Inbox/ })).toBeTruthy();
  });
});

describe("A window hidden to the tray", () => {
  it("shows no chat while hidden, so replies leave it Unread, and keeps the chat, its draft and focus when it comes back", async () => {
    const { hermes, user } = await launch();
    row_("Nightly backup").click();
    await act(async () => void (await hermes.idle()));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
    await user.type(composer, "half a thought");
    const leave = vi.spyOn(hermes, "leave");
    const open = vi.spyOn(hermes, "open");

    act(() => setWindowHidden(true));
    expect(leave).toHaveBeenCalledWith("backup", expect.anything());
    // Still mounted, with its draft: hiding isn't closing.
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("half a thought");

    // Hiding blurs the page in WebKitGTK; showing it again puts focus back in the composer.
    composer.blur();
    act(() => setWindowHidden(false));
    expect(open).toHaveBeenCalledWith("backup", expect.anything());
    expect(chatTitle()).toBe("Nightly backup");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText("Message Hermes")));
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("half a thought");
  });
});

describe("Settings → Close to tray", () => {
  const toggle = () => screen.getByRole("switch", { name: "Close to tray" });
  const note = () => toggle().closest("section")!.querySelector<HTMLElement>(".tray-note")!;

  it("is off by default, turns on with what Rust read back, and says the icon is showing", async () => {
    const tray = new FakeTray();
    const user = userEvent.setup();
    render(<TraySettings tray={tray} />);
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(note().textContent).toMatch(/tray icon is showing/);
    await user.click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(tray.stored.closeToTray).toBe(true);
    await user.click(toggle());
    expect(tray.stored.closeToTray).toBe(false);
  });

  it("explains a desktop with no tray, and that closing then quits, and follows the tray coming back", async () => {
    const tray = new FakeTray();
    tray.stored = { closeToTray: true, tray: "noTray" };
    render(<TraySettings tray={tray} />);
    await waitFor(() => expect(note().textContent).toMatch(/isn't showing tray icons/));
    // A problem is announced; the ordinary note isn't.
    expect(note().getAttribute("role")).toBe("status");
    expect(note().textContent).toMatch(/closing the window quits even with Close to tray on/);
    tray.change({ tray: "shown" });
    expect(note().textContent).toMatch(/tray icon is showing/);
    expect(note().getAttribute("role")).toBeNull();
  });

  it("says why the icon couldn't be made", async () => {
    const tray = new FakeTray();
    tray.stored = { closeToTray: false, tray: "unavailable", why: "libayatana-appindicator isn't installed." };
    render(<TraySettings tray={tray} />);
    await waitFor(() => expect(note().textContent).toBe("libayatana-appindicator isn't installed. Closing the window quits."));
  });

  it("keeps what Rust has when saving fails, and says why", async () => {
    const tray = new FakeTray();
    tray.failWrite = "Permission denied";
    const user = userEvent.setup();
    render(<TraySettings tray={tray} />);
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
    await user.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't turn on Close to tray: Permission denied");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("says the tray is only in the desktop app when there's no tray to ask", async () => {
    render(<TraySettings />);
    expect(note().textContent).toBe("The tray works only in the desktop app.");
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  });
});
