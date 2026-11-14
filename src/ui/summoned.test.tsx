// @vitest-environment jsdom
// Where the cursor goes when `hermes-chat --show`, `--toggle`, a second launch or a chat link brings the window forward
// (src-tauri/src/summon.rs emits `summoned`). Rust is faked by a stand-in for the `summoned` event.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { Selections } from "../hermes/selection";
import type { SummonApi, Summoned } from "../hermes/summon";
import { setUIPrefs } from "../hermes/uiPrefs";
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

/**
 * Rust's `summoned` event: `summon()` is the window being brought forward from another app. `selections` is what Rust
 * reads from the selection and the clipboard (selection.rs); `reads` counts how often it was asked.
 */
function fakeRust() {
  const fns = new Set<(s: Summoned) => void>();
  const api: SummonApi = {
    onSummoned: (fn) => (fns.add(fn), () => fns.delete(fn)),
    readSelection: async () => (fake.reads++, { ...fake.selections }),
  };
  const summon = async (s: Summoned = { fromElsewhere: true }) => {
    await act(async () => fns.forEach((fn) => fn(s)));
    // The selection is read once the window has focus, then lands in the composer.
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };
  /** The owner leaves for another app. */
  const leave = () => act(async () => void window.dispatchEvent(new Event("blur")));
  const fake = { api, summon, leave, selections: {} as Selections, reads: 0 };
  return fake;
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

let launches = 0;

describe("Starting a message with the text selected in another app (ADR 0172)", () => {
  afterEach(() => void setUIPrefs({ summonSelection: true }));
  const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");

  async function onNewChat(selections: Selections = {}) {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const rust = fakeRust();
    rust.selections = selections;
    const user = userEvent.setup();
    // A server of its own each time, so no Draft is left from another test.
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} summon={rust.api} onSignOut={async () => {}} />);
    await act(async () => void (await hermes.idle()));
    return { hermes, rust, user };
  }

  it("quotes what was selected there after the draft, puts the cursor after it, and sends nothing", async () => {
    const { hermes, rust, user } = await onNewChat({ primary: "old", clipboard: "copied before" });
    await user.click(composer());
    await user.keyboard("Why does this fail?");
    await rust.leave();
    composer().blur();
    rust.selections = { primary: "error: disk full\n  at /var/log", clipboard: "copied before" };
    await rust.summon();
    expect(composer().value).toBe("Why does this fail?\n\n> error: disk full\n>   at /var/log\n\n");
    expect(document.activeElement).toBe(composer());
    expect(composer().selectionStart).toBe(composer().value.length);
    expect(hermes.getSnapshot().chats).toEqual([]);
    // Undo takes it back out, as one step.
    await user.keyboard("{Control>}z{/Control}");
    expect(composer().value).toBe("Why does this fail?");
  }, 30_000);

  it("uses what was copied there when nothing new was selected", async () => {
    const { rust } = await onNewChat({ primary: "same", clipboard: "old copy" });
    await rust.leave();
    rust.selections = { primary: "same", clipboard: "https://ci.example/run/42" };
    await rust.summon();
    expect(composer().value).toBe("> https://ci.example/run/42\n\n");
  }, 30_000);

  it("only brings the window forward when nothing changed, nothing can be read, or for a chat link", async () => {
    const { rust } = await onNewChat({ primary: "seen", clipboard: "seen too" });
    await rust.leave();
    await rust.summon();
    expect(composer().value).toBe("");
    expect(document.activeElement).toBe(composer());

    rust.selections = {};
    await rust.summon();
    expect(composer().value).toBe("");

    rust.selections = { primary: "selected before a chat link" };
    await rust.summon({ fromElsewhere: false });
    expect(composer().value).toBe("");
  }, 30_000);

  it("starts a message once, not again on the next summon", async () => {
    const { rust } = await onNewChat();
    rust.selections = { primary: "df -h" };
    await rust.summon();
    await rust.summon();
    expect(composer().value).toBe("> df -h\n\n");
  }, 30_000);

  it("never reads the selection once Settings turns it off", async () => {
    const { rust, user } = await onNewChat();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Launch, tray & updates" }));
    const toggle = await screen.findByRole("switch", { name: "Start a message with the selected text" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    rust.reads = 0;
    rust.selections = { primary: "secret-ish" };
    await rust.leave();
    await rust.summon();
    expect(rust.reads).toBe(0);
    expect(composer().value).toBe("");
    expect(document.activeElement).toBe(composer());
  }, 30_000);
});
