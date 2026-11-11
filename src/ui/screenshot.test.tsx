// @vitest-environment jsdom
// Screenshots in the signed-in app, driven the way the owner would, against a fake Hermes. Only the Rust side of a
// capture is faked: the attach check, the chip, sending and the upload are the real code. Each test checks what reached
// Hermes and which captures were deleted.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { localChatCache, outboxAttachmentPaths, subscribeOutbox } from "../hermes/chatCache";
import { setUIPrefs } from "../hermes/uiPrefs";
import type { Captured } from "../hermes/screenshots";
import { stagedFiles } from "../hermes/unsaved";
import { Main, type Screenshots } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
const dialog = vi.hoisted(() => ({ picked: [] as string[] }));
vi.mock("@tauri-apps/api/core", async (actual) => {
  const core = await actual<typeof import("@tauri-apps/api/core")>();
  return { ...core, invoke: async (cmd: string, ...rest: never[]) => (cmd === "attach_picked_files" ? dialog.picked : core.invoke(cmd, ...rest)) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const stopOutboxes: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stopOutboxes.splice(0)) stop();
  localStorage.clear();
  vi.unstubAllGlobals();
  dialog.picked = [];
});

const MiB = 1024 * 1024;
const PNG = "\x89PNG\r\n\x1a\nscreen";
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** The Rust side of screenshots: each capture waits until the test lands it, on the fake Hermes's disk. */
function fakeRust(server: FakeHermes) {
  const names: string[] = [];
  const discarded: string[] = [];
  const attached = vi.fn();
  let desktopShortcut: (() => void) | undefined;
  let pending: { resolve: (c: Captured) => void; reject: (e: unknown) => void } | undefined;
  let n = 0;
  let retained = new Set<string>();
  const remove = (path: string) => {
    if (server.files[path] === undefined) return;
    discarded.push(path);
    delete server.files[path];
  };
  const syncOutbox = async () => {
    const next = new Set(outboxAttachmentPaths());
    for (const path of retained) if (!next.has(path)) remove(path);
    retained = next;
  };
  stopOutboxes.push(subscribeOutbox(() => { queueMicrotask(() => { void syncOutbox(); }); }));
  const wiring: Screenshots = {
    api: {
      capture: (name) => {
        names.push(name);
        return new Promise((resolve, reject) => (pending = { resolve, reject }));
      },
      discard: async (path) => {
        if (!retained.has(path)) remove(path);
      },
    },
    syncOutbox,
    onDesktopShortcut: (fn) => {
      desktopShortcut = fn;
      return () => (desktopShortcut = undefined);
    },
    attached,
    support: async () => ({ ok: true, summary: "Screenshots use slurp and grim: drag to select a region, or click a window." }),
  };
  return {
    wiring,
    names,
    discarded,
    attached,
    pressDesktopShortcut: () => act(() => desktopShortcut!()),
    /** The owner picks a region: the capture is saved as `bytes` (or just a size) and handed back. */
    land: async (bytes: string | { size: number } = PNG, note?: string) => {
      const path = `/run/user/1000/hermes-chat/captures/4242/${n++}/${names.at(-1)}.png`;
      server.files[path] = bytes;
      await act(async () => pending!.resolve({ path, note }));
      return path;
    },
    fail: (e: unknown) => act(async () => pending!.reject(e)),
  };
}

/** Signed in with one Active chat and the New chat pane on screen, focus in its composer. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "Which disk is failing?" }] };
  const hermes = await connect(server.openPipe, undefined, localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }));
  const rust = fakeRust(server);
  const user = userEvent.setup();
  const view = render(
    <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} screenshots={rust.wiring} />,
  );
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  composer().focus();
  return { server, hermes, rust, user, view };
}

/** The screenshots staged in the composer (not the names shown on sent messages). */
const chips = () =>
  [...document.querySelectorAll(".composer .chip")].filter((c) => /screenshot-\d{4}-\d\d-\d\d-\d{6}\.png/.test(c.textContent ?? ""));

describe("Taking a screenshot for the composer", () => {
  it("routes captures to the focused pane and retains each pane's staged captures across focus changes", async () => {
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    await user.click(within(left).getByRole("button", { name: "Attach a screenshot" }));
    await rust.land();
    await waitFor(() => expect(left.querySelectorAll(".chip")).toHaveLength(1));
    expect(right.querySelectorAll(".chip")).toHaveLength(0);
    await user.click(within(right).getByRole("button", { name: "Attach a screenshot" }));
    await rust.land();
    await waitFor(() => expect(right.querySelectorAll(".chip")).toHaveLength(1));
    expect(left.querySelectorAll(".chip")).toHaveLength(1);
    expect(rust.discarded).toEqual([]);
    // Closing a pane leaves its chat's captures staged in the chat (#443).
    await user.click(within(left).getByRole("button", { name: "Close the left pane" }));
    expect(chips()).toHaveLength(1);
    expect(rust.discarded).toEqual([]);
    await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.discarded).toEqual([]);
  });

  it("moves a capture to the newly focused pane if attachment validation finishes after focus changes", async () => {
    const { hermes, rust, user } = await signedIn();
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    const check = hermes.checkAttachments.bind(hermes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checking = vi.spyOn(hermes, "checkAttachments").mockImplementationOnce(async (paths) => {
      await gate;
      return check(paths);
    });
    await user.click(within(left).getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(checking).toHaveBeenCalledTimes(1));
    await user.click(within(right).getByPlaceholderText("Message Hermes"));
    await act(async () => release());
    await waitFor(() => expect(right.querySelectorAll(".chip")).toHaveLength(1));
    expect(left.querySelectorAll(".chip")).toHaveLength(0);
    expect(rust.discarded).not.toContain(path);
    checking.mockRestore();
  });

  it("attaches the capture for review, then sends it to Hermes and deletes it", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    expect(rust.names).toHaveLength(1);
    expect(rust.names[0]).toMatch(/^screenshot-\d{4}-\d\d-\d\d-\d{6}$/);
    expect(screen.getByRole("status").textContent).toMatch(/Taking a screenshot: select a region or window, or press Esc to cancel/);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Attach a screenshot" }).disabled).toBe(true);

    const path = await rust.land();
    await screen.findByText(`${rust.names[0]}.png`);
    expect(screen.queryByText(/Taking a screenshot/)).toBeNull();
    // Nothing went to Hermes yet: it waits in the composer for the owner.
    expect(server.requests.map((r) => r.method)).not.toContain("image.attach_bytes");
    expect(rust.discarded).toEqual([]);

    await user.type(composer(), "What's wrong in this dialog?{Enter}");
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    await settle(hermes);
    const sent = server.requests.filter((r) => ["image.attach_bytes", "prompt.submit"].includes(r.method));
    expect(sent.map((r) => r.method)).toEqual(["image.attach_bytes", "prompt.submit"]);
    expect(sent[0].params).toMatchObject({ filename: `${rust.names[0]}.png`, content_base64: btoa(PNG) });
    expect(sent[1].params).toMatchObject({ text: "What's wrong in this dialog?" });
    expect(rust.attached).not.toHaveBeenCalled();
  });

  it("keeps the capture in the failed message for Retry when Hermes rejects it", async () => {
    const { server, hermes, rust, user } = await signedIn();
    server.handlers["image.attach_bytes"] = (r) => server.fail(r.id, 4004, "unknown method image.attach_bytes");
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "What's wrong here?{Enter}");
    await settle(hermes);

    await screen.findByRole("button", { name: /Retry/ });
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(hermes.getSnapshot().chats.flatMap((c) => c.items).some((i) => i.kind === "user" && i.outgoing?.attachments?.length === 1)).toBe(true);
    expect(server.requests.map((r) => r.method)).not.toContain("prompt.submit");
  });

  it.each(["image.attach_bytes", "prompt.submit"])("keeps the capture after a disconnect during %s, then lets the owner dismiss it", async (method) => {
    const { server, hermes, rust, user } = await signedIn();
    server.handlers[method] = () => server.drop("closed during send");
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "What's wrong here?{Enter}");
    await settle(hermes);

    await screen.findByRole("button", { name: /Retry/ });
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    expect(server.requests.filter((r) => r.method === method)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.files[path]).toBeUndefined();
  });

  it("retries the failed message with its screenshot after leaving and returning to the chat", async () => {
    const { server, hermes, rust, user } = await signedIn();
    const accept = server.handlers["image.attach_bytes"];
    server.handlers["image.attach_bytes"] = (r) => server.fail(r.id, 4004, "unknown method image.attach_bytes");
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "Explain the screen{Enter}");
    await screen.findByRole("button", { name: /Retry/ });
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    await user.click(screen.getByRole("button", { name: /Explain the screen/ }));
    server.handlers["image.attach_bytes"] = accept;
    await user.click(await screen.findByRole("button", { name: /Retry/ }));
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(2);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1);
  });

  it("deletes a capture the owner removes before sending", async () => {
    const { rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([path]);
  });

  it("says nothing when the owner cancels, and why when the desktop won't take one", async () => {
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await rust.fail({ kind: "cancelled" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Taking a screenshot/)).toBeNull();

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await rust.fail({ kind: "denied", message: "Your desktop didn't allow Hermes Chat to take a screenshot. Check the screenshot permission in its privacy settings." });
    expect((await screen.findByRole("alert")).textContent).toContain("Your desktop didn't allow Hermes Chat to take a screenshot.");

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await rust.fail({ kind: "unsupported", message: "No screenshot portal is running. Install xdg-desktop-portal and the backend for your desktop." });
    expect(screen.getAllByRole("alert").at(-1)!.textContent).toContain("Screenshots don't work on this desktop yet. No screenshot portal is running.");
    expect(chips()).toHaveLength(0);
  });

  it("refuses a capture too large for Hermes, and deletes it", async () => {
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    const path = await rust.land({ size: 26 * MiB });
    expect((await screen.findByRole("alert")).textContent).toContain(`${rust.names[0]}.png is 26.0 MB. Hermes takes images up to 25 MB.`);
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([path]);
  });

  it("shows what the desktop said about the capture", async () => {
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await rust.land(PNG, "Your desktop also saved its own copy at /home/liam/Pictures/Screenshot.png.");
    expect(await screen.findByText(/also saved its own copy/)).toBeTruthy();
    expect(chips()).toHaveLength(1);
  });

  it("deletes a capture still staged when the window signs out", async () => {
    const { rust, user, view } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    view.unmount();
    expect(rust.discarded).toEqual([path]);
  });

  it("takes a desktop shortcut's screenshot into the chat on screen, out of Settings", async () => {
    const { rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Screenshots" }));
    expect(document.querySelector(".panes.covered")?.hasAttribute("inert")).toBe(true);

    rust.pressDesktopShortcut();
    expect(rust.names).toHaveLength(1);
    await screen.findByPlaceholderText("Message Hermes");
    expect(document.activeElement).toBe(composer());
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.attached).toHaveBeenCalledTimes(1);
  });

  it("reveals the attachment and capture errors when a narrow preview covers the composer", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    });
    const { rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(true);

    rust.pressDesktopShortcut();
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("aside.preview:not([hidden])")).toBeNull();
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Show the side panel" }));
    rust.pressDesktopShortcut();
    await rust.fail({ kind: "denied", message: "Screenshot permission denied" });
    expect((await screen.findByRole("alert")).textContent).toContain("Screenshot permission denied");
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
  });

  it.each(["desktop", "app"])("closes Search for the %s screenshot shortcut so review and errors stay visible", async (shortcut) => {
    const { rust, user } = await signedIn();
    const capture = async () => {
      if (shortcut === "desktop") rust.pressDesktopShortcut();
      else await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    };
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeTruthy();
    await capture();
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await user.keyboard("{Control>}k{/Control}");
    await capture();
    await rust.fail({ kind: "denied", message: "Screenshot permission denied" });
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("Screenshot permission denied");
  });

  it("reveals the composer for a desktop screenshot while project settings are open", async () => {
    const { server, rust, user } = await signedIn();
    await user.click(document.querySelector<HTMLElement>(".project-btn")!);
    await user.click(screen.getByRole("button", { name: /New project/ }));
    await user.type(screen.getByRole("textbox", { name: "New project name" }), "Capture review{Enter}");
    await screen.findByRole("heading", { name: "Capture review" });
    expect(document.querySelector(".panes.covered")?.hasAttribute("inert")).toBe(true);

    rust.pressDesktopShortcut();
    await screen.findByPlaceholderText("Message Hermes");
    expect(document.activeElement).toBe(composer());
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.attached).toHaveBeenCalledTimes(1);
    expect(server.requests.some((r) => r.method === "image.attach_bytes")).toBe(false);
  });

  it("does nothing on the shortcut once it is turned off", async () => {
    setUIPrefs({ screenshotShortcut: null });
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(rust.names).toEqual([]);
    // The button still works.
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    expect(rust.names).toHaveLength(1);
  });
});

describe("Attachments staged in each chat (#443)", () => {
  const openChat = async (user: ReturnType<typeof userEvent.setup>, hermes: Hermes, title: RegExp) => {
    await user.click(screen.getByRole("button", { name: title }));
    await settle(hermes);
  };
  const rowOf = (title: RegExp) => screen.getByRole("button", { name: title }).closest(".row") as HTMLElement;

  it("keeps a chat's capture while another chat is opened and sent in, and sends it with that chat's next message", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await openChat(user, hermes, /NAS disks/);
    expect(chips()).toHaveLength(0);
    await user.type(composer(), "Check sda{Enter}");
    await settle(hermes);
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    expect(stagedFiles.getSnapshot()).toEqual([`${rust.names[0]}.png`]);

    await openChat(user, hermes, /Nightly backup/);
    expect(chips()).toHaveLength(1);
    await user.type(composer(), "Here is the error{Enter}");
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    const attached = server.requests.filter((r) => r.method === "image.attach_bytes");
    expect(attached).toHaveLength(1);
    expect(attached[0].params).toMatchObject({ filename: `${rust.names[0]}.png`, content_base64: btoa(PNG) });
    expect(chips()).toHaveLength(0);
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });

  it("keeps the New chat pane's capture while a chat is open in its place", async () => {
    const { rust, user, hermes } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /Nightly backup/);
    expect(chips()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.discarded).not.toContain(path);
  });

  it("shows a chat's capture in both panes on it, as they share its Draft, and sends it once", async () => {
    const { server, rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await user.keyboard("{Control>}\\{/Control}");
    await settle(hermes);
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    await user.click(within(left).getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(left.querySelectorAll(".chip")).toHaveLength(1));
    expect(right.querySelectorAll(".chip")).toHaveLength(1);
    await user.type(within(right).getByPlaceholderText("Message Hermes"), "From the right{Enter}");
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(document.querySelectorAll(".composer .chip")).toHaveLength(0);
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(1);
  });

  it("deletes a capture once the owner removes it from its chat, even after switching away and back", async () => {
    const { rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /NAS disks/);
    await openChat(user, hermes, /Nightly backup/);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([path]);
  });

  it("moves a capture the owner picks from the captures folder into the chat they pick it in, so no chip outlives its file", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await openChat(user, hermes, /NAS disks/);
    dialog.picked = [path];
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "Same dialog here{Enter}");
    await settle(hermes);
    // Hermes confirmed it, so Rust lets go of the file with the outbox row.
    await waitFor(() => expect(server.files[path]).toBeUndefined());
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(1);

    for (const title of [/NAS disks/, /Nightly backup/]) {
      await openChat(user, hermes, title);
      const missing = chips().map((c) => c.textContent).filter((text) => !Object.keys(server.files).some((p) => text?.includes(p.split("/").pop()!)));
      expect(missing).toEqual([]);
    }
    expect(chips()).toHaveLength(0);
  });

  it("deletes a chat's captures when the chat is deleted", async () => {
    const { server, rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /NAS disks/);
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /Nightly backup/);
    expect(rust.discarded).toEqual([]);
    await user.click(within(rowOf(/NAS disks/)).getByTitle("Delete"));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat" }));
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.sessions.some((s) => s.id === "nas")).toBe(false);
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });

  it("deletes a chat's captures when the chat is archived", async () => {
    const { rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /NAS disks/);
    await user.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /Nightly backup/);
    await user.click(within(rowOf(/NAS disks/)).getByTitle(/^Archive:/));
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });
});

describe("A desktop without a way to take screenshots", () => {
  it("says what to install in Settings", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const rust = fakeRust(server);
    rust.wiring.support = async () => ({ ok: false, summary: "On Hyprland, Sway and other wlroots desktops, Hermes Chat picks a region or window with slurp and grim." });
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} screenshots={rust.wiring} />);
    await settle(hermes);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Screenshots" }));
    expect((await screen.findByRole("alert")).textContent).toContain("picks a region or window with slurp and grim");
  });
});

describe("Setting the screenshot shortcut", () => {
  async function inSettings() {
    const s = await signedIn();
    await s.user.click(screen.getByRole("button", { name: "Settings" }));
    await s.user.click(await screen.findByRole("button", { name: "Screenshots" }));
    const key = screen.getByRole("button", { name: "Screenshot shortcut" });
    return { ...s, key };
  }

  it("records a new shortcut, which then takes the screenshot", async () => {
    const { rust, user, key } = await inSettings();
    expect(key.textContent).toContain("Ctrl+Shift+S");
    expect(await screen.findByText(/drag to select a region, or click a window/)).toBeTruthy();
    expect(screen.getByText("hermes-chat --screenshot", { selector: "code" })).toBeTruthy();

    await user.click(key);
    expect(key.textContent).toContain("Press the shortcut…");
    await user.keyboard("{Alt>}p{/Alt}");
    expect(key.textContent).toContain("Alt+P");
    // Recording didn't take a screenshot.
    expect(rust.names).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    composer().focus();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(rust.names).toEqual([]);
    await user.keyboard("{Alt>}p{/Alt}");
    expect(rust.names).toHaveLength(1);
  });

  it("refuses a shortcut that clashes, and keeps the old one", async () => {
    const { rust, user, key } = await inSettings();
    await user.click(key);
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("alert").textContent).toContain("Ctrl+K: Ctrl+K already opens Search in Hermes Chat.");
    // Search didn't open, and the recorder is still waiting.
    expect(screen.queryByPlaceholderText(/Search all chats/)).toBeNull();
    expect(key.textContent).toContain("Press the shortcut…");

    await user.keyboard("{Control>}v{/Control}");
    expect(screen.getByRole("alert").textContent).toContain("Ctrl+V pastes while you type.");
    await user.keyboard("s");
    expect(screen.getByRole("alert").textContent).toContain("Add Ctrl, Alt or Super");

    await user.keyboard("{Escape}");
    expect(key.textContent).toContain("Ctrl+Shift+S");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rust.names).toEqual([]);
  });

  it("warns about a shortcut the desktop is likely to take, and can be turned off", async () => {
    const { user, key } = await inSettings();
    await user.click(key);
    await user.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
    expect(key.textContent).toContain("Shift+Super+S");
    expect(screen.getByText(/Desktops often keep Super shortcuts for themselves/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(key.textContent).toContain("Off");
    await user.click(screen.getByRole("button", { name: "Use Ctrl+Shift+S" }));
    expect(key.textContent).toContain("Ctrl+Shift+S");
  });
});
