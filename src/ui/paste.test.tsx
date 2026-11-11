// @vitest-environment jsdom
// Pasting a screenshot or files into the composer, or dropping files on the pane on Windows, attaches them like picked files. Rust
// saves the bytes to a temp file (`stage_clipboard_file`, faked here onto the fake Hermes's disk); checking, previews
// and sending are the real path against a fake Hermes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { Attachment } from "../hermes/model";
import { connect } from "../hermes/transport";
import { ChatPane, pastedName, refuseStrayFileDrops } from "./ChatPane";
import { stagedFiles } from "../hermes/unsaved";
import { ScreenshotDesk } from "../hermes/screenshots";

type Invoke = (cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => Promise<unknown>;
const tauri = vi.hoisted(() => ({ invoke: (async () => undefined) as Invoke }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: Parameters<Invoke>) => tauri.invoke(...a) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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
async function setUp(draft = "", screenshots?: ScreenshotDesk) {
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
      screenshots={screenshots}
    />,
  );
  return { server, runtime: server.runtimeIdOf(id)!, staged, onSend, onDraft };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
/** Pastes `files` into the composer the way the webview does; false when the paste was taken over. */
const paste = (files: File[]) => fireEvent.paste(composer(), { clipboardData: { files, getData: () => "" } });
const chips = () => Array.from(document.querySelectorAll(".chip"));
const pane = () => document.querySelector<HTMLElement>(".chat")!;
const overlay = () => screen.queryByText("Drop files to attach");
/** A drag carrying `files` from outside the app, as the webview reports it; false when the pane took it over. */
const fileDrag = (type: "dragEnter" | "dragOver" | "drop", files: File[]) =>
  fireEvent[type](pane(), { dataTransfer: { types: ["Files"], files, dropEffect: "none" } });

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

  it("deletes a pasted file once it is removed from the composer, or the composer goes", async () => {
    const discard = vi.fn(async () => {});
    const desk = new ScreenshotDesk({ capture: async () => Promise.reject(new Error("no captures here")), discard });
    const { staged } = await setUp("", desk);
    paste([new File([PNG], "a.png", { type: "image/png" })]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Remove"));
    await waitFor(() => expect(discard).toHaveBeenCalledWith(staged[0].path));

    paste([new File([PNG], "b.png", { type: "image/png" })]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(discard).toHaveBeenCalledTimes(1);
    cleanup();
    expect(discard).toHaveBeenLastCalledWith(staged[1].path);
  });

  it("deletes a paste that is saved after its composer has gone", async () => {
    const discard = vi.fn(async () => {});
    const { staged } = await setUp("", new ScreenshotDesk({ capture: async () => Promise.reject(new Error("no captures here")), discard }));
    const save = tauri.invoke;
    let land: (() => void) | undefined;
    tauri.invoke = (cmd, args, opts) =>
      cmd === "stage_clipboard_file" ? new Promise((resolve) => (land = () => resolve(save(cmd, args, opts)))) : save(cmd, args, opts);
    paste([new File([PNG], "a.png", { type: "image/png" })]);
    await waitFor(() => expect(land).toBeDefined());
    cleanup();
    land!();
    await waitFor(() => expect(discard).toHaveBeenCalledWith(staged[0].path));
  });

  it("deletes the files already saved when a paste fails part-way", async () => {
    const discard = vi.fn(async () => {});
    const { staged } = await setUp("", new ScreenshotDesk({ capture: async () => Promise.reject(new Error("no captures here")), discard }));
    const save = tauri.invoke;
    let saves = 0;
    tauri.invoke = (cmd, args, opts) =>
      cmd === "stage_clipboard_file" && ++saves === 2 ? Promise.reject(new Error("disk full")) : save(cmd, args, opts);
    paste([new File([PNG], "a.png", { type: "image/png" }), new File([PNG], "b.png", { type: "image/png" })]);
    await screen.findByText("Couldn't attach the files: disk full");
    expect(staged).toHaveLength(1);
    await waitFor(() => expect(discard).toHaveBeenCalledWith(staged[0].path));
    expect(chips()).toHaveLength(0);
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

describe("Dropping files on the pane (HTML5, as on Windows)", () => {
  it("attaches a dropped file, from anywhere on the pane, and keeps its name", async () => {
    const { staged, onSend } = await setUp("Here's the report");
    expect(fileDrag("drop", [new File(["sda 92%"], "disk report.txt", { type: "text/plain" })])).toBe(false);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0].querySelector(".chip-name")?.textContent).toBe("disk report.txt");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("Here's the report", [{ path: staged[0].path, name: "disk report.txt", size: 7, kind: "file" }]);
  });

  it("shows the drop overlay while files are over the pane, until they leave or drop", async () => {
    await setUp();
    expect(fileDrag("dragEnter", [])).toBe(false);
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(pane(), { dataTransfer: { types: ["text/uri-list"], files: [] } });
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(pane(), { dataTransfer: { types: ["Files"], files: [] } });
    expect(overlay()).toBeNull();
    expect(fileDrag("dragOver", [])).toBe(false);
    expect(overlay()).not.toBeNull();
    fileDrag("drop", [new File(["x"], "a.txt")]);
    expect(overlay()).toBeNull();
    await waitFor(() => expect(chips()).toHaveLength(1));
  });

  it("keeps a dropped file's own name, even one a paste would take for a screenshot", async () => {
    const { staged } = await setUp();
    fileDrag("drop", [new File(["png"], "image.png", { type: "image/png" })]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(staged.map((s) => s.name)).toEqual(["image.png"]);
    expect(chips()[0].querySelector(".chip-name")?.textContent).toBe("image.png");
  });

  it("leaves a dragged chat to the pane's chat drop target", async () => {
    const { staged } = await setUp();
    const chat = { types: ["application/x-hermes-chat"], files: [], getData: () => "nas" };
    expect(fireEvent.dragOver(pane(), { dataTransfer: chat })).toBe(true);
    expect(overlay()).toBeNull();
    expect(fireEvent.drop(pane(), { dataTransfer: chat })).toBe(true);
    expect(staged).toEqual([]);
  });

  it("refuses a file over Hermes's limit without reading it, and attaches the rest", async () => {
    const { staged } = await setUp();
    const huge = new File(["x"], "disk.img");
    Object.defineProperty(huge, "size", { value: 300 * MiB });
    const read = vi.spyOn(huge, "arrayBuffer");
    fileDrag("drop", [huge, new File(["sda 92%"], "report.txt")]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toBe("disk.img is 300.0 MB. Hermes takes files up to 256 MB.");
    expect(read).not.toHaveBeenCalled();
    expect(staged.map((s) => s.name)).toEqual(["report.txt"]);
  });

  it("says why when only files over the limit were dropped", async () => {
    const { staged } = await setUp();
    const huge = new File(["x"], "disk.img");
    Object.defineProperty(huge, "size", { value: 300 * MiB });
    fileDrag("drop", [huge]);
    expect((await screen.findByRole("alert")).textContent).toBe("disk.img is 300.0 MB. Hermes takes files up to 256 MB.");
    expect(staged).toEqual([]);
    expect(chips()).toHaveLength(0);
  });
});

describe("A file dropped where no pane takes it", () => {
  it("is turned down, so the webview doesn't open it in place of the app", () => {
    const target = new EventTarget() as unknown as Window;
    refuseStrayFileDrops(target);
    const drag = (type: string, types: string[], taken = false) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types, dropEffect: "copy" } });
      if (taken) e.preventDefault();
      target.dispatchEvent(e);
      return e;
    };
    for (const type of ["dragover", "drop"]) {
      const files = drag(type, ["Files"]);
      expect([files.defaultPrevented, files.dataTransfer.dropEffect]).toEqual([true, "none"]);
      expect(drag(type, ["Files"], true).dataTransfer.dropEffect).toBe("copy");
      expect(drag(type, ["application/x-hermes-chat"]).defaultPrevented).toBe(false);
    }
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
