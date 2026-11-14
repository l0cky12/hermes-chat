// @vitest-environment jsdom
// The window's title (windowTitle.ts): the chat on screen after the unread count, in the running app against a fake
// Hermes. The Rust side copies `document.title` to the native window (main_window.rs). All chats are synthetic.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { windowTitle } from "./windowTitle";

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
  document.title = "Hermes Chat";
});

describe("the window title", () => {
  it("names the chat after the unread count, leaves out a count of none, and is the app's name with no chat open", () => {
    expect(windowTitle("Nightly backup", 2)).toBe("(2) Nightly backup - Hermes Chat");
    expect(windowTitle("Nightly backup", 0)).toBe("Nightly backup - Hermes Chat");
    expect(windowTitle(undefined, 3)).toBe("(3) Hermes Chat");
    expect(windowTitle(undefined, 0)).toBe("Hermes Chat");
    expect(windowTitle("  ", 0)).toBe("Hermes Chat");
  });

  it("follows the chat on screen and the unread chats, and is the app's name again once signed out", async () => {
    const now = Date.now() / 1000;
    const server = new FakeHermes();
    server.sessions = [
      row("backup", 1, { pinned: true, title: "Nightly backup", last_read_at: now }),
      row("notes", 0.01, { pinned: true, title: "Release notes", last_read_at: 0 }),
      row("trip", 0.02, { pinned: true, title: "Weekend in Lisbon", last_read_at: 0 }),
    ];
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    const view = render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@title", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    // Launch opens a new chat (ADR 0162): no chat yet, two unread.
    expect(document.title).toBe("(2) Hermes Chat");
    // The window has the owner's focus, so a chat opened is read.
    act(() => void window.dispatchEvent(new Event("focus")));
    const user = userEvent.setup();
    await user.click(view.getByText("Nightly backup"));
    await waitFor(() => expect(document.title).toBe("(2) Nightly backup - Hermes Chat"));
    // Opening an unread chat reads it, and the count drops.
    await user.click(view.getByText("Release notes"));
    await waitFor(() => expect(document.title).toBe("(1) Release notes - Hermes Chat"));
    view.unmount();
    expect(document.title).toBe("Hermes Chat");
  });
});
