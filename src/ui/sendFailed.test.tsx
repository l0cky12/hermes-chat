// @vitest-environment jsdom
// A message Hermes didn't take, or may not have, shows in the transcript marked so, with why and a Retry control.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat, ConnectionStatus, Item, OutgoingItem } from "../hermes/model";
import { ChatPane } from "./ChatPane";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const TEXT = "Rotate the nginx logs,\n  then restart it";
const failed: OutgoingItem = { kind: "user", id: "u-2", text: TEXT, outgoing: { state: "failed", reason: "session busy" } };
const earlier: Item[] = [
  { kind: "user", id: "h-0", text: "How full is the NAS?" },
  { kind: "assistant", id: "h-1", text: "82% used." },
];

function pane(items: Item[], { status = "connected" as ConnectionStatus, over = {} as Partial<Chat> } = {}) {
  const on = { retry: vi.fn(), edit: vi.fn(), dismiss: vi.fn() };
  render(
    <ChatPane
      chat={{ id: "c1", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, ...over }}
      status={status}
      draft=""
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={on.retry}
      onEdit={on.edit}
      onDismiss={on.dismiss}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
    />,
  );
  return on;
}

const retry = () => screen.getByRole("button", { name: /Retry/ });

describe("A failed message", () => {
  it("shows in the chat with its words, why it wasn't sent, and Retry", () => {
    const on = pane([...earlier, failed]);
    const row = document.querySelector('[data-item="u-2"]')!;
    expect(row.classList).toContain("failed");
    expect(row.querySelector(".bubble-text")!.textContent).toBe(TEXT);
    expect(screen.getByRole("alert").textContent).toContain("Not sent. Session busy.");

    fireEvent.click(retry());
    expect(on.retry).toHaveBeenCalledWith("u-2");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(on.edit).toHaveBeenCalledWith("u-2");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(on.dismiss).toHaveBeenCalledWith("u-2");
  });

  it("can't be retried while Hermes isn't connected, or while a reply is running", () => {
    pane([failed], { status: "reconnecting" });
    expect(retry()).toHaveProperty("disabled", true);
    cleanup();
    pane([failed], { over: { running: true } });
    expect(retry()).toHaveProperty("disabled", true);
  });

  it("one Hermes may have says so, and that the history settles it", () => {
    pane([{ ...failed, outgoing: { state: "unknown", reason: "The connection dropped before Hermes confirmed it (closed)." } }]);
    expect(document.querySelector('[data-item="u-2"]')!.classList).toContain("unknown");
    expect(screen.getByRole("alert").textContent).toMatch(/Hermes may already have this message.*checked against the chat's history/);
    expect(retry()).toHaveProperty("title", "Send it again: Hermes may run it twice");
  });

  it("with files offers no Edit, since the composer can't take them back", () => {
    pane([{ ...failed, attachments: ["rotate.sh"], outgoing: { ...failed.outgoing, attachments: [{ path: "/r/rotate.sh", name: "rotate.sh", size: 9, kind: "file" }] } }]);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(retry()).toBeDefined();
  });

  it("while it is still sending shows no alert or controls", () => {
    pane([{ ...failed, outgoing: { state: "sending" } }]);
    expect(document.querySelector('[data-item="u-2"]')!.classList).toContain("sending");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a stopped reply is labelled Stopped, with no failure shown", () => {
    pane([{ kind: "user", id: "u-0", text: TEXT }, { kind: "assistant", id: "a-1", text: "Rotating", interrupted: true }]);
    expect(screen.getByText("Stopped")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
