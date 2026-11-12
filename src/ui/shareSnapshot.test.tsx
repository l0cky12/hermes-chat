// @vitest-environment jsdom
// Share snapshot (ExportChat.tsx in share mode, ADR 0123): what the owner picks and redacts is what Publish uploads, the
// confirm frame shows exactly those bytes, and each way publishing can end says what it means.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import type { Published, SnapshotApi, SnapshotHost } from "../hermes/snapshots";
import { ExportChatDialog, type ExportMode } from "./ExportChat";

const tauri = vi.hoisted(() => ({
  calls: [] as string[],
  invoke: async (cmd: string) => {
    tauri.calls.push(cmd);
    if (cmd === "snapshot_host") return null;
    throw new Error(`${cmd} isn't available in tests`);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
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
  tauri.calls = [];
});

const KEY = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
const HOST: SnapshotHost = { endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "liam-shares", prefix: "hermes-chat-snapshots/", keyId: "AKIAEXAMPLE" };
const URL = "https://s3.us-east-1.amazonaws.com/liam-shares/hermes-chat-snapshots/abcdefghijklmnopqrstuvwxyz.html?X-Amz-Signature=1";
const LIVE: Published = {
  outcome: "live",
  snapshot: {
    state: "live",
    id: "abcdefghijklmnopqrstuvwxyz",
    title: "Moving house",
    created: "2026-11-11T21:30:00Z",
    expires: "2026-11-12T21:30:00Z",
    url: URL,
  },
};

const chat = (more: Partial<Chat> = {}): Chat => ({
  id: "c1",
  runtimeId: "rt-1",
  title: "Moving house",
  source: "app",
  settled: false,
  updatedAt: 0,
  items: [
    { kind: "user", id: "u1", text: `Ship the boxes to 14 Larch Lane, Duluth. The movers' key is ${KEY}` },
    { kind: "thinking", id: "th1", text: "They want a pizza place near the new house." },
    { kind: "assistant", id: "a1", text: "Booked for 14 Larch Lane." },
  ],
  ...more,
});

function open({ c = chat(), mode = "share" as ExportMode, host = HOST as SnapshotHost | null, publish = vi.fn(async (): Promise<Published> => LIVE) } = {}) {
  const saves: [string, string, string][] = [];
  const api: SnapshotApi = {
    host: vi.fn(async () => host),
    saveHost: vi.fn(),
    clearHost: vi.fn(),
    testHost: vi.fn(),
    publish,
    list: vi.fn(),
    link: vi.fn(),
    revoke: vi.fn(),
  };
  const copied: string[] = [];
  const onClose = vi.fn();
  const onSnapshotSettings = vi.fn();
  const props = {
    mode,
    snapshots: api,
    copyText: async (t: string) => void copied.push(t),
    save: async (text: string, name: string, format: string) => (saves.push([text, name, format]), `/x/${name}`),
    onSaved: vi.fn(),
    onSnapshotSettings,
    onClose,
  };
  const view = render(<ExportChatDialog chat={c} {...props} />);
  return { api, saves, copied, onClose, onSnapshotSettings, publish, rerender: (next: Chat) => view.rerender(<ExportChatDialog chat={next} {...props} />), user: userEvent.setup() };
}

const publishButton = () => screen.getByRole("button", { name: "Publish…" }) as HTMLButtonElement;
const confirmFrame = () => screen.getByTitle("The page, exactly as it will be published");
/** Every text in the page the frame holds, hidden or not, as a browser would parse it. */
const pageText = (html: string) => new DOMParser().parseFromString(html, "text/html").documentElement.textContent ?? "";

async function redact(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
  await user.paste(text);
  await user.keyboard("{Enter}");
}

describe("Share snapshot", () => {
  it("publishes exactly the confirm frame's srcdoc, with a flagged key and a typed pick gone, and shows the link", async () => {
    const { publish, copied, user } = open();
    expect(screen.getByRole("dialog", { name: "Share snapshot “Moving house”" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Format" })).toBeNull();
    await redact(user, "Larch Lane");
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(publishButton());

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Publish this page?" }));
    expect(screen.getByText("s3.us-east-1.amazonaws.com")).toBeTruthy();
    expect(screen.getByText("liam-shares")).toBeTruthy();
    expect(screen.getByText("hermes-chat-snapshots/")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "1 day" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/can miss a secret written another way/)).toBeTruthy();
    expect(screen.getByText(/A copy someone saves can't be recalled/)).toBeTruthy();
    const frame = confirmFrame();
    expect(frame.localName).toBe("iframe");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(publish).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(publish).toHaveBeenCalledTimes(1);
    const [html, title, expiry] = publish.mock.calls[0] as unknown as [string, string, string];
    expect(html).toBe(frame.getAttribute("srcdoc"));
    expect(title).toBe("Moving house");
    expect(expiry).toBe("week");
    const text = pageText(html);
    expect(text).toContain("Ship the boxes to 14 [redacted], Duluth.");
    for (const gone of [KEY, "Larch Lane"]) {
      expect(text).not.toContain(gone);
      expect(html).not.toContain(gone);
    }

    const link = (await screen.findByRole("textbox", { name: "Link to the snapshot" })) as HTMLInputElement;
    expect(link.value).toBe(URL);
    expect(screen.getByRole("status").textContent).toContain("Anyone with this link can read the page until");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copied).toEqual([link.value]);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("publishes the chat as it was when the dialog opened, whatever arrives later", async () => {
    const { publish, rerender, user } = open();
    rerender(chat({ items: [...chat().items, { kind: "user", id: "u9", text: "One more thing: the gate code is 4821." }] }));
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(publishButton());
    rerender(chat({ title: "Renamed", items: [{ kind: "user", id: "u10", text: "Something else entirely" }] }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const [html] = publish.mock.calls[0] as unknown as [string];
    expect(html).toBe(confirmFrame().getAttribute("srcdoc"));
    expect(pageText(html)).toContain("Booked for 14 Larch Lane.");
    for (const later of ["One more thing", "4821", "Something else entirely", "Renamed"]) expect(pageText(html)).not.toContain(later);
  });

  it("says a refused upload wasn't published and offers to try again", async () => {
    const publish = vi.fn(async (): Promise<Published> => ({ outcome: "notPublished", reason: "The host refused the key." }));
    const { user } = open({ publish });
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(publishButton());
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not published: The host refused the key. Nothing was left in the bucket, so you can try again.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("says a page that may have been sent may have been sent, never that it wasn't, and points to Settings → Snapshots", async () => {
    const publish = vi.fn(async (): Promise<Published> => ({ outcome: "maybeSent", reason: "The host didn't answer twice." }));
    const { onSnapshotSettings, onClose, user } = open({ publish });
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(publishButton());
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The page may have been sent: The host didn't answer twice.");
    expect(alert.textContent).toContain("Check Settings → Snapshots");
    expect(alert.textContent).not.toMatch(/not published/i);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Settings → Snapshots" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSnapshotSettings).toHaveBeenCalled();
  });

  it("shows why when Publish is refused, and Back returns to the picks as they were", async () => {
    const publish = vi.fn(async (): Promise<Published> => Promise.reject(new Error("The keyring couldn't be read.")));
    const { user } = open({ publish });
    await redact(user, "Duluth");
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(screen.getByRole("checkbox", { name: /Hermes, thinking/ }));
    await user.click(publishButton());
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't publish: The keyring couldn't be read.");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(publishButton());
    expect(within(screen.getByRole("list", { name: "Text you redacted" })).getByText("Duluth")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Hermes, thinking/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Redact API key/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("goes back to the picks on Escape in the confirm step, and closes on Escape from the picks", async () => {
    const { onClose, user } = open();
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    await user.click(publishButton());
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(publishButton());
    expect(screen.queryByTitle("The page, exactly as it will be published")).toBeNull();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("starts with Hermes's thinking unticked when sharing, and ticked when exporting", async () => {
    open();
    expect((screen.getByRole("checkbox", { name: /Hermes, thinking/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("group", { name: "Messages: 2 of 3" })).toBeTruthy();
    expect(pageText(screen.getByTitle("The page, as it stands").getAttribute("srcdoc")!)).not.toContain("pizza place");
    cleanup();
    open({ mode: "export" });
    expect(screen.getByRole("dialog", { name: "Export “Moving house”" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Hermes, thinking/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Publish…" })).toBeNull();
  });

  it("with no host set up, says so, offers Settings → Snapshots, and still saves the page as a file", async () => {
    const { saves, onSnapshotSettings, onClose, api, user } = open({ host: null });
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("No snapshot host is set up");
    expect(publishButton().disabled).toBe(true);
    expect(api.publish).not.toHaveBeenCalled();

    const shown = screen.getByTitle("The page, as it stands").getAttribute("srcdoc");
    await user.click(screen.getByRole("button", { name: "Save as a file…" }));
    const [[bytes, name, format]] = saves;
    expect(format).toBe("html");
    expect(name).toBe("Moving house.html");
    expect(bytes).toBe(shown);
    expect(bytes).not.toContain(KEY);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await user.click(within(note).getByRole("button", { name: "Open Settings → Snapshots" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSnapshotSettings).toHaveBeenCalled();
  });
});

describe("Share snapshot from the chat's More menu", () => {
  it("opens the dialog in share mode, and with no host its Settings button opens Settings → Snapshots", async () => {
    const s = new FakeHermes();
    s.sessions = [row("c1", 0.1, { pinned: true, title: "Deploy keys" })];
    s.storeMessage("c1", { role: "user", text: `The deploy fails with ${KEY}` });
    s.storeMessage("c1", { role: "assistant", text: "That key was revoked; make a new one." });
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Deploy keys/ }));
    await screen.findByText("That key was revoked; make a new one.");
    await act(async () => void (await hermes.idle()));

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Share snapshot…" }));
    const dialog = screen.getByRole("dialog", { name: "Share snapshot “Deploy keys”" });
    const note = await within(dialog).findByRole("note");
    expect(tauri.calls).toContain("snapshot_host");
    await user.click(within(note).getByRole("button", { name: "Open Settings → Snapshots" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    const tab = await screen.findByRole("tab", { name: "Snapshots" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("form", { name: "Set up a snapshot host" })).toBeTruthy();
  });
});
