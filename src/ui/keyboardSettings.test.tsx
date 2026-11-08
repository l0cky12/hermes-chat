// @vitest-environment jsdom
// Keyboard shortcuts the owner changed, driven through the signed-in app against a fake Hermes: a rebound chord works
// and the old one doesn't, two commands on one chord run one, an IME never fires one, the Keyboard Shortcuts page
// changes, keeps, resets and warns, hints show the current chord, and the screenshot recorder follows the table.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY, setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const focused = () => document.activeElement;
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const palette = () => screen.queryByRole("dialog", { name: "Search chats" });
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const stored = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}") as { keybindings?: Record<string, string[]>; screenshotShortcut?: string | null };
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** Signed in with two Active chats and the draft on screen, focus in its composer; `keybindings` as if from a restart. */
async function signedIn(keybindings: Record<string, string[]> = {}) {
  setUIPrefs({ keybindings });
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "How full is the NAS?" }] };
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

/** Settings open at the Keyboard Shortcuts tab. */
async function onKeyboardPage(s: Awaited<ReturnType<typeof signedIn>>) {
  await s.user.click(button("Settings"));
  await screen.findByRole("heading", { name: "Settings" });
  await s.user.click(screen.getByRole("tab", { name: "Keyboard Shortcuts" }));
  await screen.findByRole("heading", { name: "Navigation" });
}

describe("A rebound shortcut", () => {
  it("opens Search on its new chord, and the old chord does nothing", async () => {
    const s = await signedIn({ search: ["Ctrl+J"] });
    await s.user.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
    await s.user.keyboard("{Control>}j{/Control}");
    expect(focused()).toBe(screen.getByPlaceholderText("Search all chats, including Settled"));
    // Its own chord closes it too.
    await s.user.keyboard("{Control>}j{/Control}");
    expect(palette()).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("starts a new chat and finds in the chat on their new chords only", async () => {
    const s = await signedIn({ newChat: ["Ctrl+Shift+N"], find: ["Ctrl+G"] });
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    await s.user.keyboard("{Control>}n{/Control}");
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
    await s.user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
    expect(screen.getByText("New chat", { selector: ".chat-title span" })).toBeTruthy();

    await s.user.keyboard("{Control>}f{/Control}");
    expect(screen.queryByPlaceholderText("Find in chat")).toBeNull();
    await s.user.keyboard("{Control>}g{/Control}");
    await waitFor(() => expect(focused()).toBe(screen.getByPlaceholderText("Find in chat")));
  });

  it("sends from the composer on its new chord, and Enter then only breaks the line", async () => {
    const s = await signedIn({ send: ["Alt+Enter"] });
    await s.user.type(composer(), "one{Enter}two");
    await settle(s.hermes);
    expect(prompts(s.server)).toEqual([]);
    expect(composer().value).toBe("one\ntwo");
    await s.user.keyboard("{Alt>}{Enter}{/Alt}");
    await waitFor(() => expect(prompts(s.server).map((r) => r.params.text)).toEqual(["one\ntwo"]));
  });

  it("asks to delete a focused chat on its new chord, and Delete then does nothing", async () => {
    const s = await signedIn({ rowDelete: ["Shift+Delete"] });
    rowButton("Nightly backup").focus();
    await s.user.keyboard("{Delete}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await s.user.keyboard("{Shift>}{Delete}{/Shift}");
    expect(screen.getByRole("alertdialog", { name: "Delete “Nightly backup”?" })).toBeTruthy();
  });

  it("runs one command, not two, when the owner put two on one chord: the one they changed", async () => {
    const s = await signedIn({ toggleList: ["Ctrl+K"] });
    await s.user.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
    expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull();
    await s.user.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
  });

  it("never fires while an IME is composing", async () => {
    await signedIn({ search: ["Ctrl+J"] });
    fireEvent.keyDown(composer(), { key: "j", code: "KeyJ", ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(palette()).toBeNull();
  });
});

describe("The Keyboard Shortcuts page", () => {
  it("lists every group with each command's When condition and chords, and Approvals has none on purpose", async () => {
    const s = await signedIn();
    await onKeyboardPage(s);
    for (const name of ["Chat / Composer", "Threads / History", "Navigation", "Sidebar / Panels", "Approvals / Inbox"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    const search = button(/^Change Search all chats/);
    expect(search.getAttribute("aria-label")).toBe("Change Search all chats (Ctrl+K)");
    expect(within(search).getAllByText(/./, { selector: "kbd" }).map((k) => k.textContent)).toEqual(["Ctrl", "K"]);
    expect(button(/^Change Next match/).getAttribute("aria-label")).toBe("Change Next match (Enter or ↓)");
    expect(screen.getByText("chatOpen || settingsOpen", { selector: "code" })).toBeTruthy();
    expect(screen.getByText(/No key answers an Approval/)).toBeTruthy();
    expect(screen.queryByText("Custom")).toBeNull();
    expect(button("Reset all").hasAttribute("disabled")).toBe(true);
    // The screenshot shortcut is listed where it is changed, not here.
    expect(screen.getByText("Take a screenshot for the composer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Change Take a screenshot/ })).toBeNull();
  });

  it("captures a new chord on click, saves it as the owner's own, keeps it, and runs it at once", async () => {
    const s = await signedIn();
    await onKeyboardPage(s);
    await s.user.click(button(/^Change Search all chats/));
    const capture = button("New shortcut for Search all chats");
    expect(focused()).toBe(capture);
    expect(capture.textContent).toContain("Press the shortcut…");
    expect(button("Save").hasAttribute("disabled")).toBe(true);
    // Only modifiers: still waiting. The chord shows as pressed, and Search didn't open.
    await s.user.keyboard("{Control>}{/Control}");
    expect(capture.textContent).toContain("Press the shortcut…");
    await s.user.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
    await s.user.keyboard("{Control>}j{/Control}");
    expect(within(capture).getAllByText(/./, { selector: "kbd" }).map((k) => k.textContent)).toEqual(["Ctrl", "J"]);
    await s.user.click(button("Save"));

    const changed = button(/^Change Search all chats/);
    expect(changed.getAttribute("aria-label")).toBe("Change Search all chats (Ctrl+J)");
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(button("Reset Search all chats")).toBeTruthy();
    expect(button("Reset all").hasAttribute("disabled")).toBe(false);
    expect(stored().keybindings).toEqual({ search: ["Ctrl+J"] });

    await s.user.click(button("Back to chat"));
    await s.user.keyboard("{Control>}j{/Control}");
    expect(palette()).toBeTruthy();
  });

  it("refuses a chord that would clash with typing or the desktop, and Escape or Cancel keeps the old one", async () => {
    const s = await signedIn();
    await onKeyboardPage(s);
    await s.user.click(button(/^Change Search all chats/));
    await s.user.keyboard("k");
    expect(screen.getByRole("alert").textContent).toBe("Typing K would run it. Add Ctrl or Alt.");
    expect(button("Save").hasAttribute("disabled")).toBe(true);
    await s.user.keyboard("{Control>}v{/Control}");
    expect(screen.getByRole("alert").textContent).toBe("Ctrl+V pastes while you type.");
    await s.user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(screen.getByRole("alert").textContent).toMatch(/screenshot shortcut/);
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button(/^Change Search all chats/).getAttribute("aria-label")).toBe("Change Search all chats (Ctrl+K)");

    await s.user.click(button(/^Change Search all chats/));
    await s.user.keyboard("{Control>}j{/Control}");
    await s.user.click(button("Cancel"));
    expect(button(/^Change Search all chats/).getAttribute("aria-label")).toBe("Change Search all chats (Ctrl+K)");
    expect(stored().keybindings ?? {}).toEqual({});
  });

  it("binds Escape through Use Esc, since pressing it cancels", async () => {
    const s = await signedIn();
    await onKeyboardPage(s);
    await s.user.click(button(/^Change Close the find bar/));
    await s.user.click(button("Use Esc"));
    expect(button("Save").hasAttribute("disabled")).toBe(false);
    await s.user.click(button("Save"));
    expect(button(/^Change Close the find bar/).getAttribute("aria-label")).toBe("Change Close the find bar (Esc)");
    // The same as the default, so nothing is kept as an override.
    expect(stored().keybindings ?? {}).toEqual({});
    expect(screen.queryByText("Custom")).toBeNull();
  });

  it("warns on both rows when two commands share a chord, naming the other, and Reset clears one", async () => {
    const s = await signedIn();
    await onKeyboardPage(s);
    await s.user.click(button(/^Change Hide or show the chat list/));
    await s.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("alert")).toBeNull();
    await s.user.click(button("Save"));
    expect(screen.getByRole("img", { name: "Also Search all chats" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Also Hide or show the chat list" })).toBeTruthy();
    expect(stored().keybindings).toEqual({ toggleList: ["Ctrl+K"] });

    await s.user.click(button("Reset Hide or show the chat list"));
    expect(screen.queryByRole("img", { name: /^Also/ })).toBeNull();
    expect(screen.queryByText("Custom")).toBeNull();
    expect(stored().keybindings).toEqual({});
  });

  it("puts every command back with Reset all", async () => {
    const s = await signedIn({ search: ["Ctrl+J"], newChat: ["Ctrl+Shift+N"] });
    await onKeyboardPage(s);
    expect(screen.getAllByText("Custom")).toHaveLength(2);
    await s.user.click(button("Reset all"));
    expect(screen.queryByText("Custom")).toBeNull();
    expect(button("Reset all").hasAttribute("disabled")).toBe(true);
    expect(stored().keybindings).toEqual({});
    expect(button(/^Change Search all chats/).getAttribute("aria-label")).toBe("Change Search all chats (Ctrl+K)");
  });

  it("is found by Settings' search", async () => {
    const s = await signedIn();
    await s.user.click(button("Settings"));
    await screen.findByRole("heading", { name: "Settings" });
    await s.user.type(screen.getByRole("searchbox", { name: "Search settings" }), "chat below");
    await screen.findByRole("group", { name: "Keyboard Shortcuts" });
    expect(screen.getByText("Open the chat below")).toBeTruthy();
  });
});

describe("The screenshot recorder", () => {
  it("accepts Ctrl+K once Search moved off it", async () => {
    const s = await signedIn({ search: ["Ctrl+J"] });
    await s.user.click(button("Settings"));
    await screen.findByRole("heading", { name: "Settings" });
    await s.user.click(within(screen.getByRole("navigation", { name: "General" })).getByRole("button", { name: "Screenshots" }));
    const key = button("Screenshot shortcut");
    const shortcutRow = within(key.closest<HTMLElement>(".set-row")!);
    await s.user.click(key);
    await s.user.keyboard("{Control>}j{/Control}");
    expect(shortcutRow.getByRole("alert").textContent).toContain("Ctrl+J already runs Search all chats");
    await s.user.keyboard("{Control>}k{/Control}");
    expect(shortcutRow.queryByRole("alert")).toBeNull();
    expect(key.textContent).toContain("Ctrl+K");
    expect(stored().screenshotShortcut).toBe("Ctrl+K");
  });
});
