// @vitest-environment jsdom
// Where the cursor goes when `hermes-chat --show`, `--toggle`, a second launch or a chat link brings the window forward
// (src-tauri/src/summon.rs emits `summoned`). Rust is faked by a stand-in for the `summoned` event.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { SummonApi } from "../hermes/summon";
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

/** Rust's `summoned` event: `summon()` is the window being brought forward. */
function fakeRust() {
  const fns = new Set<() => void>();
  const api: SummonApi = { onSummoned: (fn) => (fns.add(fn), () => fns.delete(fn)) };
  return { api, summon: () => act(() => fns.forEach((fn) => fn())) };
}

describe("Being brought forward", () => {
  const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
  const composerIn = (i: number) => within(panes()[i]).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");

  async function signedIn() {
    const server = new FakeHermes();
    server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
    server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "How full is the NAS?" }] };
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const rust = fakeRust();
    const user = userEvent.setup();
    render(
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} summon={rust.api} onSignOut={async () => {}} />,
    );
    await screen.findByRole("button", { name: /Nightly backup/ });
    await act(async () => void (await hermes.idle()));
    return { hermes, rust, user };
  }

  it("puts the cursor back in the selected pane's composer, with its draft as it was", async () => {
    const { hermes, rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /^Nightly backup/ }));
    await act(async () => void (await hermes.idle()));
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(screen.getByRole("button", { name: /^NAS disks/ }));
    await act(async () => void (await hermes.idle()));
    await user.click(composerIn(0));
    await user.keyboard("left draft");
    await user.click(composerIn(1));
    await user.keyboard("right draft");
    // The owner went to another app; focus left the composer.
    composerIn(1).blur();
    expect(document.activeElement).toBe(document.body);
    await rust.summon();
    expect(document.activeElement).toBe(composerIn(1));
    expect(composerIn(0).value).toBe("left draft");
    expect(composerIn(1).value).toBe("right draft");
    // The other pane selected: that one gets it.
    await user.keyboard("{Control>}1{/Control}");
    composerIn(0).blur();
    await rust.summon();
    expect(document.activeElement).toBe(composerIn(0));
  }, 30_000);

  it("leaves Settings open as it was, focus included", async () => {
    const { rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Screenshots" }));
    const heading = await screen.findByRole("heading", { name: "Screenshots" });
    const key = screen.getByRole("button", { name: "Screenshot shortcut" });
    key.focus();
    await rust.summon();
    expect(heading.isConnected).toBe(true);
    expect(document.activeElement).toBe(key);
  }, 30_000);
});
