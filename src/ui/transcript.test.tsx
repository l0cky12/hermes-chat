// @vitest-environment jsdom
// The transcript renders each block memoized, so a streamed delta re-renders only what it changed, and marks find
// matches in the background. These check what that must not change.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalChoice, Chat, Item } from "../hermes/model";
import { ChatPane, type FindTarget } from "./ChatPane";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;

const chatOf = (items: Item[], over: Partial<Chat> = {}): Chat => ({ id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, ...over });

/** The pane, and `show` to render it again with a changed chat, find target or answer handler, as App does. */
function pane(chat: Chat, findTarget?: FindTarget, onAnswer: Answer = () => {}) {
  const el = (c: Chat, t?: FindTarget, a: Answer = onAnswer) => (
    <ChatPane
      chat={c}
      findTarget={t}
      status="connected"
      draft=""
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={a}
    />
  );
  const r = render(el(chat, findTarget));
  return { show: (c: Chat, t?: FindTarget, a?: Answer) => act(() => r.rerender(el(c, t, a))) };
}

const item = (id: string) => document.querySelector(`[data-item="${id}"]`);
const approval: Item = {
  kind: "approval",
  id: "ap-1",
  requestId: "rq-1",
  command: "rm -rf build",
  description: "Clean the build",
  choices: ["once", "deny"],
  allowSession: true,
  allowPermanent: true,
};

describe("The transcript", () => {
  it("shows every streamed delta, with the cursor only while the reply runs", () => {
    const asked: Item[] = [{ kind: "user", id: "u-0", text: "Clean up the logs" }];
    const { show } = pane(chatOf(asked));
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing" }], { running: true }));
    expect(item("a-1")?.querySelector(".cursor")).not.toBeNull();
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing **old** logs." }], { running: true }));
    expect(item("a-1")?.textContent).toBe("Removing old logs.");
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing **old** logs." }]));
    expect(document.querySelector(".cursor")).toBeNull();
  });

  it("keeps an opened tool group open as the chat changes, and shows a tool call in it finishing", () => {
    const tools: Item[] = [
      { kind: "tool", id: "t-1", name: "terminal", status: "done" },
      { kind: "tool", id: "t-2", name: "read_file", status: "running" },
    ];
    const { show } = pane(chatOf(tools, { running: true }));
    fireEvent.click(screen.getByText("2 tool calls"));
    const group = document.querySelector(".tools")!;
    expect(group.querySelector(".spinner")).not.toBeNull();

    const done = tools.map((t) => (t.id === "t-2" ? { ...t, status: "done" as const } : t));
    show(chatOf([...done, { kind: "assistant", id: "a-3", text: "Done." }], { running: true }));
    expect(group.isConnected && group.querySelector(".tool-group-body")).toBeTruthy();
    expect(group.querySelector(".spinner")).toBeNull();
  });

  it("lands a search pick on the matched message, though earlier messages match too", () => {
    const items: Item[] = ["a-0", "a-1", "a-2"].map((id) => ({ kind: "assistant", id, text: `The lock in ${id} is stale.` }));
    pane(chatOf(items), { query: "lock", itemId: "a-2", at: 1 });
    expect(document.querySelectorAll("mark.hit")).toHaveLength(3);
    expect(document.querySelector("mark.current")?.closest("[data-item]")?.getAttribute("data-item")).toBe("a-2");
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  it("counts the matches a streamed reply adds while find is open, and none once it closes", () => {
    const asked: Item[] = [{ kind: "user", id: "u-0", text: "Is the lock stale?" }];
    const { show } = pane(chatOf(asked, { running: true }), { query: "lock", itemId: "u-0", at: 1 });
    expect(screen.getByText("1 of 1")).toBeTruthy();
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "The lock" }], { running: true }));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "The lock is stale; remove the lock." }], { running: true }));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText("Find in chat"), { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(document.querySelector("mark.current")?.closest("[data-item]")?.getAttribute("data-item")).toBe("a-1");

    fireEvent.click(screen.getByTitle("Close (Esc)"));
    expect(document.querySelectorAll("mark.hit")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Find in chat" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("marks a match a reply shows through a character reference or an escape", () => {
    const items: Item[] = [
      { kind: "assistant", id: "a-0", text: "Fish &amp; chips, and 2 \\* 3." },
      { kind: "assistant", id: "a-1", text: "No match here." },
    ];
    const { show } = pane(chatOf(items), { query: "fish & chips", at: 1 });
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(item("a-0")?.querySelector("mark.hit")?.textContent).toBe("Fish & chips");
    show(chatOf(items), { query: "2 * 3", at: 2 });
    expect(screen.getByText("1 of 1")).toBeTruthy();
  });

  it("marks a footnote's number, which the reply's text doesn't hold", () => {
    pane(chatOf([{ kind: "assistant", id: "a-0", text: "See this[^note].\n\n[^note]: A note." }]), { query: "1", at: 1 });
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(document.querySelector("mark.hit")?.closest("sup")).not.toBeNull();
  });

  it("answers an Approval card through the handler App passed last", () => {
    const first = vi.fn<Answer>();
    const latest = vi.fn<Answer>();
    const chat = chatOf([approval], { running: true });
    const { show } = pane(chat, undefined, first);
    // A render that leaves the card's own props as they were.
    show({ ...chat }, undefined, latest);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(latest).toHaveBeenCalledWith("ap-1", "once", undefined);
    expect(first).not.toHaveBeenCalled();
  });

  it("still ignores a click on an Approval card just after the transcript moves", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const answered = vi.fn<Answer>();
    const items = [approval];
    const { show } = pane(chatOf(items, { running: true }), undefined, answered);
    vi.setSystemTime(Date.now() + 1000);

    show(chatOf([...items, { kind: "thinking", id: "r-1", text: "Waiting" }], { running: true }));
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).toHaveBeenCalledWith("ap-1", "once", undefined);
  });

  it("ignores a click on an Approval card just after a side question's answer above it moves it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const answered = vi.fn<Answer>();
    const items = [approval];
    const side = { id: "btw-1", question: "Which build?", taskId: "btw_1" };
    const { show } = pane(chatOf(items, { running: true, sideQuestions: [{ ...side, state: "asking" }] }), undefined, answered);
    vi.setSystemTime(Date.now() + 1000);

    show(chatOf(items, { running: true, sideQuestions: [{ ...side, state: "answered", answer: "The **nightly** one." }] }));
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).toHaveBeenCalledWith("ap-1", "once", undefined);
  });

  describe("Copy", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue();
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });
    const copyIn = (id: string) => within(item(id) as HTMLElement).getByRole("button", { name: "Copy" });
    const click = (b: HTMLElement) => act(async () => void fireEvent.click(b));

    it("copies the owner's message as they typed it", async () => {
      pane(chatOf([{ kind: "user", id: "u-0", text: "Rename **every** `*.log`\n\n  file" }]));
      await click(copyIn("u-0"));
      expect(writeText).toHaveBeenCalledWith("Rename **every** `*.log`\n\n  file");
    });

    it("copies a reply as Markdown, without the turn's thinking or tool calls", async () => {
      pane(
        chatOf([
          { kind: "user", id: "u-0", text: "Is the dashboard up?" },
          { kind: "thinking", id: "r-1", text: "Check the port first." },
          { kind: "tool", id: "t-2", name: "terminal", status: "done" },
          { kind: "assistant", id: "a-3", text: "<think>HTTPS failed.</think>\nIt's **up**, over plain HTTP:\n\n- `http://nas:9119/`" },
        ]),
      );
      expect(within(item("r-1") as HTMLElement).queryByRole("button", { name: "Copy" })).toBeNull();
      await click(copyIn("a-3"));
      expect(writeText).toHaveBeenCalledWith("It's **up**, over plain HTTP:\n\n- `http://nas:9119/`");
    });

    it("says Copied for a moment, then Copy again", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      pane(chatOf([{ kind: "assistant", id: "a-0", text: "Done." }]));
      await click(copyIn("a-0"));
      const button = within(item("a-0") as HTMLElement).getByRole("button", { name: "Copied" });
      expect(button.textContent).toBe("Copied");
      expect(button.title).toBe("Copied");
      expect(document.activeElement).toBe(button);
      act(() => void vi.advanceTimersByTime(1499));
      expect(button.textContent).toBe("Copied");
      act(() => void vi.advanceTimersByTime(1));
      expect(button.textContent).toBe("Copy");
      expect(button.title).toBe("Copy this reply");
    });

    it("says so when the clipboard can't be written", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      pane(chatOf([{ kind: "user", id: "u-0", text: "Hello" }]));
      await click(copyIn("u-0"));
      expect(screen.getByRole("status").textContent).toBe("Couldn't copy");
    });

    it("isn't offered while a reply streams, or on a message Hermes didn't take", () => {
      pane(
        chatOf(
          [
            { kind: "user", id: "u-0", text: "Retry me", outgoing: { state: "failed", reason: "offline" } },
            { kind: "assistant", id: "a-1", text: "Removing" },
          ],
          { running: true },
        ),
      );
      expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    });

    it("leaves Ctrl+C on a selection to the browser", () => {
      pane(chatOf([{ kind: "assistant", id: "a-0", text: "Done." }]));
      const copy = new Event("copy", { bubbles: true, cancelable: true });
      item("a-0")!.querySelector("p")!.dispatchEvent(copy);
      expect(copy.defaultPrevented).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });
  });
});

describe("A message that can't be drawn (#476)", () => {
  it("shows an error in its place, while the other messages and the composer keep working", () => {
    // React reports the caught error on the console, which Logs keeps.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onSend = vi.fn();
    const items: Item[] = [
      { kind: "user", id: "u-0", text: "List the backup folder." },
      { kind: "tool", id: "t-1", name: "terminal", status: "done", preview: 5 as never },
      { kind: "assistant", id: "a-2", text: "14 snapshots." },
    ];
    render(
      <ChatPane
        chat={chatOf(items)}
        status="connected"
        draft="And their sizes?"
        onDraft={() => {}}
        onDraftStep={() => undefined}
        onRetry={() => {}}
        onEdit={() => {}}
        onDismiss={() => {}}
        onAttach={async () => ({ attachments: [], refused: [] })}
        onSend={onSend}
        onStop={() => {}}
        onAnswer={() => {}}
      />,
    );
    expect(item("u-0")?.textContent).toContain("List the backup folder.");
    expect(item("a-2")?.textContent).toContain("14 snapshots.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("terminal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("And their sizes?", []);
  });
});
