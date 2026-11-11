// @vitest-environment jsdom
// The Export dialog (ExportChat.tsx, ADR 0076): what the owner picks and redacts is what the saved bytes hold.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import type { ImagePage } from "../hermes/exportImage";
import { ExportChatDialog } from "./ExportChat";

const tauri = vi.hoisted(() => ({
  saved: [] as { text: string; fileName: string; format: string }[],
  invoke: async (cmd: string, args?: { text: string; fileName: string; format: string }) => {
    if (cmd !== "chat_export") throw new Error(`${cmd} isn't available in tests`);
    tauri.saved.push(args!);
    return `/home/liam/exports/${args!.fileName}`;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  tauri.saved = [];
});

const KEY = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
const preview = () => screen.getByLabelText("The file, exactly as it will be saved");

describe("Exporting from the chat's More menu", () => {
  it("opens the Export dialog, leaves out tool calls and a likely key at first, and saves exactly the preview", async () => {
    const s = new FakeHermes();
    s.sessions = [row("c1", 0.1, { pinned: true, title: "Deploy keys" })];
    s.storeMessage("c1", { role: "user", text: `The deploy fails with ${KEY}` });
    s.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
    s.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", context: "cat /srv/.env", result: "DB_HOST=10.0.0.12" });
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
    await user.click(screen.getByRole("menuitem", { name: "Export…" }));
    const dialog = screen.getByRole("dialog", { name: "Export “Deploy keys”" });
    expect((within(dialog).getByRole("checkbox", { name: /Tool calls and Approvals/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole("checkbox", { name: /Redact API key/ }) as HTMLInputElement).checked).toBe(true);
    expect(preview().textContent).not.toContain(KEY);
    expect(preview().textContent).not.toContain("DB_HOST");
    expect(preview().textContent).toContain("The deploy fails with [redacted]");

    await user.click(within(dialog).getByRole("button", { name: "Save…" }));
    expect(tauri.saved).toHaveLength(1);
    expect(tauri.saved[0]).toMatchObject({ fileName: "Deploy keys.md", format: "markdown" });
    expect(tauri.saved[0].text).not.toContain(KEY);
    expect(tauri.saved[0].text).not.toContain("DB_HOST");
    expect((await screen.findByRole("status")).textContent).toContain("Exported to /home/liam/exports/Deploy keys.md.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
  });
});

const chat = (more: Partial<Chat> = {}): Chat => ({
  id: "c1",
  runtimeId: "rt-1",
  title: "Moving house",
  source: "app",
  settled: false,
  updatedAt: 0,
  items: [
    { kind: "user", id: "u1", text: "Ship the boxes to 14 Larch Lane, Duluth.", attachments: ["lease.pdf"] },
    { kind: "assistant", id: "a1", text: "Booked for 14 Larch Lane. The movers' portal password: Mov3rs!2026" },
    { kind: "user", id: "u2", text: "Also, what's a good pizza place there?" },
    { kind: "tool", id: "t1", name: "web_search", args: { q: "pizza Duluth" }, status: "done", result: "Sammy's Pizza" },
  ],
  ...more,
});

function open(c = chat()) {
  const saves: [string, string, string][] = [];
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const drawn: ImagePage[] = [];
  const pictures: [string, string][] = [];
  const props = {
    save: async (text: string, name: string, format: string) => (saves.push([text, name, format]), `/x/${name}`),
    draw: async (page: ImagePage) => (drawn.push(page), `PNG${drawn.length}`),
    saveAsImage: async (png: string, name: string) => (pictures.push([png, name]), `/x/${name}`),
    onSaved,
    onClose,
  };
  const view = render(<ExportChatDialog chat={c} {...props} />);
  return {
    saves,
    drawn,
    pictures,
    onSaved,
    onClose,
    rerender: (next: Chat) => view.rerender(<ExportChatDialog chat={next} {...props} />),
    user: userEvent.setup(),
  };
}

/** Selects the first `text` in the preview, across its marked parts, as a drag would. */
function select(text: string) {
  const at = preview().textContent!.indexOf(text);
  if (at < 0) throw new Error(`"${text}" isn't in the preview`);
  const range = document.createRange();
  const walker = document.createTreeWalker(preview(), NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent!.length;
    if (seen <= at && at < seen + len) range.setStart(node, at - seen);
    if (seen < at + text.length && at + text.length <= seen + len) range.setEnd(node, at + text.length - seen);
    seen += len;
  }
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

describe("The Export dialog", () => {
  it("redacts selected text everywhere, and the saved bytes don't hold it", async () => {
    const { saves, user } = open();
    const redact = screen.getByRole("button", { name: "Redact" });
    expect((redact as HTMLButtonElement).disabled).toBe(true);
    select("14 Larch Lane");
    expect((screen.getByRole("textbox", { name: "Text to redact" }) as HTMLInputElement).value).toBe("14 Larch Lane");
    await user.click(redact);
    expect(within(screen.getByRole("list", { name: "Text you redacted" })).getByText("2 places")).toBeTruthy();
    expect(preview().textContent).not.toContain("Larch");

    await user.click(screen.getByRole("button", { name: "Save…" }));
    const [[bytes]] = saves;
    expect(bytes).toBe(preview().textContent);
    expect(bytes).not.toContain("Larch");
    expect(bytes).not.toContain("Mov3rs!2026");
    expect(bytes).toContain("Ship the boxes to [redacted], Duluth.");
  });

  it("puts back a redaction the owner takes back, and a flagged secret the owner keeps", async () => {
    const { user } = open();
    select("Duluth");
    await user.click(screen.getByRole("button", { name: "Redact" }));
    expect(preview().textContent).not.toContain("Duluth");
    await user.click(screen.getByRole("button", { name: "Keep Duluth in the file" }));
    expect(preview().textContent).toContain("Duluth");

    await user.click(screen.getByRole("checkbox", { name: /Redact password or key/ }));
    expect(preview().textContent).toContain("password: Mov3rs!2026");
  });

  it("redacts text typed from the keyboard, with Enter", async () => {
    const { user } = open();
    await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
    await user.paste("pizza place");
    await user.keyboard("{Enter}");
    expect(preview().textContent).toContain("what's a good [redacted] there?");
    expect((screen.getByRole("textbox", { name: "Text to redact" }) as HTMLInputElement).value).toBe("");
  });

  it("won't redact a selection with [redacted] in it, and says why", async () => {
    const { user } = open();
    select("password: [redacted]");
    expect((screen.getByRole("button", { name: "Redact" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Leave \[redacted\] out/)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("list", { name: "Text you redacted" })).toBeNull();
  });

  it("leaves out an unticked message, and adds tool calls and attachment names only when ticked", async () => {
    const { saves, user } = open();
    expect(preview().textContent).not.toContain("Sammy's Pizza");
    expect(preview().textContent).not.toContain("lease.pdf");
    await user.click(screen.getByRole("checkbox", { name: /pizza place/ }));
    expect(screen.getByRole("group", { name: "Messages: 2 of 3" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Tool calls and Approvals/ }));
    await user.click(screen.getByRole("checkbox", { name: /Names of attached files/ }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const [[bytes]] = saves;
    expect(bytes).not.toContain("pizza place");
    expect(bytes).toContain("Sammy's Pizza");
    expect(bytes).toContain("`lease.pdf`");
  });

  it("saves JSON with each message's time and the tool call whole, and nothing redacted is left in the bytes", async () => {
    const timed = chat({
      items: [
        { kind: "user", id: "u1", text: `Ship the boxes to 14 Larch Lane. The movers' key is ${KEY}`, at: 1_762_075_800_000 },
        { kind: "tool", id: "t1", callId: "call_9", name: "web_search", args: { q: "pizza Duluth" }, status: "done", result: "Sammy's Pizza" },
        { kind: "assistant", id: "a1", text: "Booked for 14 Larch Lane.", at: 1_762_075_805_500 },
      ],
    });
    const { saves, user } = open(timed);
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(screen.getByRole("checkbox", { name: /Tool calls and Approvals/ }));
    await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
    await user.paste("Larch Lane");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Save…" }));

    const [[bytes, name, format]] = saves;
    expect(name).toBe("Moving house.json");
    expect(format).toBe("json");
    expect(bytes).toBe(preview().textContent);
    expect(bytes).not.toContain(KEY);
    expect(bytes).not.toContain("Larch Lane");
    const [session] = JSON.parse(bytes) as { messages: Record<string, unknown>[] }[];
    const rows = session.messages;
    expect(rows.find((r) => r.role === "user")).toMatchObject({ content: "Ship the boxes to 14 [redacted]. The movers' key is [redacted]", timestamp: 1_762_075_800 });
    expect(rows.find((r) => r.role === "assistant" && r.content)).toMatchObject({ content: "Booked for 14 [redacted].", timestamp: 1_762_075_805.5 });
    const call = rows.find((r) => Array.isArray(r.tool_calls))!.tool_calls as { id: string; function: { name: string; arguments: string } }[];
    expect(call).toHaveLength(1);
    expect(call[0].function.name).toBe("web_search");
    expect(JSON.parse(call[0].function.arguments)).toEqual({ q: "pizza Duluth" });
    expect(rows.find((r) => r.role === "tool")).toMatchObject({ tool_call_id: call[0].id, tool_name: "web_search", content: "Sammy's Pizza" });
  });

  it("draws the chosen messages as a picture with redactions applied, and saves the picture it shows", async () => {
    const { drawn, pictures, user } = open();
    await user.click(screen.getByRole("radio", { name: "Image" }));
    await user.click(screen.getByRole("checkbox", { name: /pizza place/ }));
    await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
    await user.paste("Larch Lane");
    await user.keyboard("{Enter}");
    const picture = screen.getByLabelText("The picture, exactly as it will be saved");
    await waitFor(() => expect(within(picture).getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,PNG${drawn.length}`));

    const page = drawn.at(-1)!;
    expect(page.title).toBe("Moving house");
    expect(page.caption).toMatch(/· 3 places redacted$/);
    expect(page.blocks).toEqual([
      { who: "You", text: "Ship the boxes to 14 [redacted], Duluth." },
      { who: "Hermes", text: "Booked for 14 [redacted]. The movers' portal password: [redacted]" },
    ]);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect(pictures).toEqual([[`PNG${drawn.length}`, "Moving house.png"]]);
  });

  it("says why when the picture can't be drawn, and won't save one", async () => {
    const user = userEvent.setup();
    const draw = async () => {
      throw new Error("This image would be 40000 px tall. Leave some messages out and try again.");
    };
    render(<ExportChatDialog chat={chat()} draw={draw} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Image" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Leave some messages out");
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("can't save an empty file", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "None" }));
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Tool calls and Approvals/ }));
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the HTML page in a sandboxed frame holding exactly the bytes it saves, with typed redactions gone", async () => {
    const { saves, user } = open();
    await user.click(screen.getByRole("radio", { name: "HTML page" }));
    await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
    await user.paste("Larch Lane");
    await user.keyboard("{Enter}");
    const frame = screen.getByTitle("The page, exactly as it will be saved");
    expect(frame.localName).toBe("iframe");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText(/everywhere it appears in the page/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save…" }));
    const [[bytes, name, format]] = saves;
    expect(format).toBe("html");
    expect(name).toBe("Moving house.html");
    expect(bytes).toBe(frame.getAttribute("srcdoc"));
    expect(bytes.startsWith("<!doctype html>")).toBe(true);
    expect(bytes).not.toContain("Larch");
    expect(bytes).not.toContain("Mov3rs!2026");
    expect(bytes).toContain("Ship the boxes to 14 [redacted], Duluth.");
  });

  it("won't save an HTML page that would still show a redaction formatting splits, and says why", async () => {
    const { saves, user } = open(chat({ items: [{ kind: "user", id: "u1", text: "The gate code is 48*21*93." }] }));
    await user.click(screen.getByRole("radio", { name: "HTML page" }));
    await user.click(screen.getByRole("textbox", { name: "Text to redact" }));
    await user.paste("482193");
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("splits text you redacted");
    expect(screen.queryByTitle("The page, exactly as it will be saved")).toBeNull();
    const save = screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(saves).toEqual([]);
  });

  it("keeps the chat as it was when it opened", () => {
    const { rerender } = open();
    const before = preview().textContent;
    rerender(chat({ items: [...chat().items, { kind: "user", id: "u3", text: "One more thing" }] }));
    expect(preview().textContent).toBe(before);
  });

  it("starts with focus inside when there's no message to tick, keeps Tab there, and gives focus back on Escape", async () => {
    const user = userEvent.setup();
    const toolsOnly = chat({ items: [{ kind: "tool", id: "t1", name: "web_search", args: { q: "pizza" }, status: "done", result: "Sammy's" }] });
    function Host() {
      const [shown, setShown] = useState(false);
      const button = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={button} onClick={() => setShown(true)}>
            More
          </button>
          {shown && <ExportChatDialog chat={toolsOnly} returnTo={button} onSaved={() => {}} onClose={() => setShown(false)} />}
        </>
      );
    }
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Text to redact" }));
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
  });

  it("stays open and says why when saving fails, and stays open when the Save dialog is cancelled", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    let fail = true;
    render(<ExportChatDialog chat={chat()} save={async () => (fail ? Promise.reject(new Error("Read-only file system")) : null)} onSaved={() => {}} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save: Read-only file system");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
