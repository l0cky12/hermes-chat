// @vitest-environment jsdom
// Spell checking where a message to Hermes is written (#578): on until Settings → General → Chats → Check spelling turns
// it off, for the composer and a queued message alike. The webview draws the underline; this checks what the app asks
// of it.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
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

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const queue = () => screen.getByRole("region", { name: "Queued messages" });

/** Signed in, with "Nightly backup" open, a reply running in it and one message queued behind it. */
async function queued() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await settle(hermes);
  await user.type(composer(), "Unlock it{Enter}");
  await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
  act(() => server.event(server.runtimeIdOf("backup")!, "message.start"));
  await settle(hermes);
  await user.type(composer(), "Then rerun it{Enter}");
  await user.click(within(queue()).getByRole("button", { name: "Edit queued message 1" }));
  return { user, edit: () => within(queue()).getByRole("textbox", { name: "Edit queued message 1" }) };
}

describe("Check spelling", () => {
  it("is on in the composer and a queued message until turned off in Settings, and stays off", async () => {
    const s = await queued();
    expect(composer().getAttribute("spellcheck")).toBe("true");
    expect(s.edit().getAttribute("spellcheck")).toBe("true");

    await s.user.click(screen.getByRole("button", { name: "Settings" }));
    await s.user.click(within(screen.getByRole("group", { name: "General: sections" })).getByRole("button", { name: "Chats" }));
    const toggle = screen.getByRole("switch", { name: "Check spelling" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await s.user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).spellCheck).toBe(false);

    await s.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(composer().getAttribute("spellcheck")).toBe("false");
    expect(s.edit().getAttribute("spellcheck")).toBe("false");
  });
});
