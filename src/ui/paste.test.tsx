// @vitest-environment jsdom
// Pasting a screenshot or files into the composer attaches them like a drop. Rust saves the pasted bytes to a temp
// file (`stage_clipboard_file`, faked here onto the fake Hermes's disk); checking, previews and sending are the real
// path against a fake Hermes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { Attachment } from "../hermes/model";
import { connect } from "../hermes/transport";
import { ChatPane, pastedName } from "./ChatPane";
import { stagedFiles } from "../hermes/unsaved";

type Invoke = (cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => Promise<unknown>;
const tauri = vi.hoisted(() => ({ invoke: (async () => undefined) as Invoke }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: Parameters<Invoke>) => tauri.invoke(...a) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  URL.createObjectURL ??= () => "blob:preview";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MiB = 1024 * 1024;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

/** A new chat's pane on a fake Hermes, with `draft` in its composer. `staged` lists what Rust was asked to save. */
async function setUp(draft = "") {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  const staged: { name: string; path: string }[] = [];
  tauri.invoke = async (cmd, args, opts) => {
    if (cmd === "hermes_read_preview") return new TextEncoder().encode(String(server.files[String((args as { path: string }).path)])).buffer;
    if (cmd !== "stage_clipboard_file") throw new Error(`unexpected command ${cmd}`);
    const name = decodeURIComponent(opts?.headers?.["x-name"] ?? "");
    const bytes = new Uint8Array(args as ArrayBuffer);
    const path = `/tmp/hermes-chat/${staged.length + 1}/${name}`;
    server.files[path] = bytes.length > MiB ? { size: bytes.length } : String.fromCharCode(...bytes);
    staged.push({ name, path });
    return path;
  };
  const onSend = vi.fn((text: string, attachments: Attachment[]) => void hermes.send(id, text, attachments));
  const onDraft = vi.fn();
  render(
    <ChatPane
      chat={hermes.getSnapshot().chats.find((c) => c.id === id)!}
      status="connected"
      draft={draft}
      onDraft={onDraft}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={(paths) => hermes.checkAttachments(paths)}
      onSend={onSend}
      onStop={() => {}}
      onAnswer={() => {}}
    />,
  );
  return { server, runtime: server.runtimeIdOf(id)!, staged, onSend, onDraft };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
/** Pastes `files` into the composer the way the webview does; false when the paste was taken over. */
const paste = (files: File[]) => fireEvent.paste(composer(), { clipboardData: { files, getData: () => "" } });
const chips = () => Array.from(document.querySelectorAll(".chip"));

describe("Pasting into the composer", () => {
  it("attaches a pasted screenshot like a dropped image, previews it and sends it to Hermes", async () => {
    const { server, runtime, staged, onSend } = await setUp("Which cable is loose?");
    // The webview names a clipboard image generically; it is saved under a timestamped name instead.
    const shot = new File([PNG], "image.png", { type: "image/png" });
    expect(paste([shot])).toBe(false);
    await waitFor(() => expect(chips()).toHaveLength(1));
    // The same screenshot again is a second file, not a duplicate dropped by the path check.
    paste([shot]);
    await waitFor(() => expect(chips()).toHaveLength(2));

    const clipboardName = expect.stringMatching(/^clipboard-\d{4}-\d\d-\d\dT\d{6}\.png$/);
    expect(staged.map((s) => s.name)).toEqual([clipboardName, clipboardName]);
    await waitFor(() => expect(document.querySelectorAll(".chip img.chip-thumb")).toHaveLength(2));
    expect(chips()[0].querySelector(".chip-name")?.textContent).toBe(staged[0].name);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const sent = staged.map(({ name, path }): Attachment => ({ path, name, size: PNG.length, kind: "image" }));
    expect(onSend).toHaveBeenCalledWith("Which cable is loose?", sent);
    await waitFor(() =>
      expect(server.requests.filter((r) => r.method === "image.attach_bytes").map((r) => r.params)).toEqual(
        staged.map(({ name }) => ({ session_id: runtime, filename: name, content_base64: PNG_B64 })),
      ),
    );
    expect(chips()).toHaveLength(0);
  });

  it("tells an update's restart which files are attached, until they're sent or the composer goes", async () => {
    await setUp("Which cable is loose?");
    paste([new File([PNG], "image.png", { type: "image/png" })]);
    await waitFor(() => expect(stagedFiles.getSnapshot()).toEqual([expect.stringMatching(/^clipboard-.*\.png$/)]));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(stagedFiles.getSnapshot()).toEqual([]));
    paste([new File([PNG], "image.png", { type: "image/png" })]);
    await waitFor(() => expect(stagedFiles.getSnapshot()).toHaveLength(1));
    cleanup();
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });

  it("holds a send until the pasted screenshot is attached, so it isn't left behind", async () => {
    const { staged, onSend } = await setUp("Which cable is loose?");
    // Saving the paste takes a while: it lands only when `land` is called.
    const save = tauri.invoke;
    let land = () => {};
    tauri.invoke = (cmd, args, opts) =>
      cmd === "stage_clipboard_file" ? new Promise((resolve) => (land = () => resolve(save(cmd, args, opts)))) : save(cmd, args, opts);

    paste([new File([PNG], "", { type: "image/png" })]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true));
    fireEvent.keyDown(composer(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();

    land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Which cable is loose?", [expect.objectContaining({ path: staged[0].path, kind: "image" })]);
  });

  it("keeps a pasted file's own name", async () => {
    const { staged } = await setUp();
    paste([new File(["sda 92%"], "disk report.txt", { type: "text/plain" })]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(staged.map((s) => s.name)).toEqual(["disk report.txt"]);
    expect(chips()[0].querySelector(".chip-name")?.textContent).toBe("disk report.txt");
  });

  it("pastes text as before", async () => {
    const { staged, onDraft } = await setUp();
    const user = userEvent.setup();
    await user.click(composer());
    await user.paste("sda 92%");
    expect(onDraft).toHaveBeenLastCalledWith("sda 92%", "change");
    expect(paste([])).toBe(true);
    expect(staged).toEqual([]);
    expect(chips()).toHaveLength(0);
  });

  it("reads a screenshot WebKitGTK leaves out of the paste event from the clipboard, and leaves text alone", async () => {
    const { staged } = await setUp();
    // WebKitGTK's paste event has no files even for an image; the async clipboard API has it.
    const read = vi.fn(async () => [{ types: ["image/png"], getType: async () => new Blob([PNG], { type: "image/png" }) }]);
    Object.defineProperty(navigator, "clipboard", { value: { read }, configurable: true });
    try {
      expect(fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "sda 92%" } })).toBe(true);
      expect(read).not.toHaveBeenCalled();

      expect(fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } })).toBe(true);
      await waitFor(() => expect(chips()).toHaveLength(1));
      expect(read).toHaveBeenCalledTimes(1);
      expect(staged.map((s) => s.name)).toEqual([expect.stringMatching(/^clipboard-.*\.png$/)]);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("refuses an oversized paste with the same note as a dropped file", async () => {
    const { staged } = await setUp();
    paste([new File([new Uint8Array(26 * MiB)], "", { type: "image/png" })]);
    const note = await screen.findByRole("alert");
    expect(note.textContent).toBe(`${staged[0].name} is 26.0 MB. Hermes takes images up to 25 MB.`);
    expect(chips()).toHaveLength(0);
  });
});

describe("A pasted file's name", () => {
  const at = new Date(2026, 10, 2, 15, 30, 0);
  it("is timestamped for a screenshot, with the extension its type gives", () => {
    expect(pastedName({ name: "", type: "image/png" }, at)).toBe("clipboard-2026-11-02T153000.png");
    expect(pastedName({ name: "image.png", type: "image/jpeg" }, at)).toBe("clipboard-2026-11-02T153000.jpeg");
    expect(pastedName({ name: "", type: "" }, at)).toBe("clipboard-2026-11-02T153000.png");
  });
  it("is the file's own when it has one", () => {
    expect(pastedName({ name: "rack.png", type: "image/png" }, at)).toBe("rack.png");
  });
});
