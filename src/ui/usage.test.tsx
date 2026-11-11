// @vitest-environment jsdom
// Token usage and cost in the chat pane: a compact line under each measured reply and the chat's totals by its title,
// each with a breakdown on demand. Unknown counts and costs say so.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { chatUsageOf } from "../hermes/usage";
import { ChatPane } from "./ChatPane";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";
import { REPLY_NOTES } from "./Usage";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const chatOf = (items: Item[], over: Partial<Chat> = {}): Chat => ({ id: "c", runtimeId: "rt", title: "Disk", source: "app", settled: false, updatedAt: 0, items, ...over });

function pane(chat: Chat, onUsage = () => {}) {
  return render(
    <ChatPane
      chat={chat}
      status="connected"
      draft="" draftKey="draft" screenshots={new ScreenshotDesk(noScreenshots)}
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
      onQuestion={() => {}}
      onUsage={onUsage}
    />,
  );
}

const measured = { prompt: 61394, input: 1234, cache: 60160, output: 1006, reasoning: 183, calls: 3, model: "z-ai/glm-5.3-flash" };
const stored = {
  input_tokens: 42298,
  output_tokens: 1006,
  cache_read_tokens: 60160,
  cache_write_tokens: 0,
  reasoning_tokens: 183,
  api_call_count: 3,
  estimated_cost_usd: 0.0030129068,
  cost_status: "estimated",
  cost_source: "provider_models_api",
};

describe("A reply's usage", () => {
  it("shows as one line under the reply, and its breakdown on demand", async () => {
    pane(chatOf([{ kind: "user", id: "u", text: "Disk?" }, { kind: "assistant", id: "a", text: "82% used.", usage: measured }]));
    const line = screen.getByRole("button", { name: /^Tokens for this reply: 1\.2k in, 60\.2k cache, 1k out\. Show breakdown$/ });
    expect(line.textContent).toBe("1.2k in · 60.2k cache · 1k out");

    await userEvent.click(line);
    const table = document.getElementById(line.getAttribute("aria-controls")!)!;
    const rows = [...table.querySelectorAll(".usage-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);
    expect(rows).toEqual([
      ["Input", (61394).toLocaleString()],
      ["not cached", (1234).toLocaleString()],
      ["cache read or written", (60160).toLocaleString()],
      ["Output", (1006).toLocaleString()],
      ["of which reasoning", "183"],
      ["Model calls", "3"],
      ["Model", "z-ai/glm-5.3-flash"],
      ["Cost", "Not reported per reply"],
    ]);
    // Said on screen, not only in a tooltip.
    expect(table.querySelector(".usage-note")!.textContent).toBe(`${REPLY_NOTES.split} ${REPLY_NOTES.cost}`);
    expect(line.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the cache out of the line when the turn used none, and shows nothing for a reply not measured", () => {
    pane(
      chatOf([
        { kind: "assistant", id: "a", text: "Old reply" },
        { kind: "assistant", id: "b", text: "New reply", usage: { ...measured, prompt: 1234, cache: 0 } },
      ]),
    );
    expect(screen.getAllByRole("button", { name: /^Tokens for this reply/ }).map((b) => b.textContent)).toEqual(["1.2k in · 1k out"]);
  });

  it("shows all the input as in, its split as unknown and why, when Hermes's counts don't split it (#53)", async () => {
    // The reply in issue #53: one call whose live counts said nothing about the cache.
    const usage = { prompt: 59292, output: 7, reasoning: 1, calls: 1, model: "z-ai/glm-5.3-flash" };
    pane(chatOf([{ kind: "assistant", id: "a", text: "Hi", usage }]));
    const line = screen.getByRole("button", { name: /^Tokens for this reply/ });
    expect(line.textContent).toBe("59.3k in · 7 out");
    await userEvent.click(line);
    const table = document.getElementById(line.getAttribute("aria-controls")!)!;
    const rows = [...table.querySelectorAll(".usage-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);
    expect(rows).toEqual([
      ["Input", (59292).toLocaleString()],
      ["not cached", "Unknown"],
      ["cache read or written", "Unknown"],
      ["Output", "7"],
      ["of which reasoning", "1"],
      ["Model calls", "1"],
      ["Model", "z-ai/glm-5.3-flash"],
      ["Cost", "Not reported per reply"],
    ]);
    const note = table.querySelector(".usage-note")!.textContent;
    expect(note).toBe(`${REPLY_NOTES.unsplit} ${REPLY_NOTES.cost}`);
    expect(note).toContain("beside its title, shows its cost");
  });

  it("shows a cache Hermes counted as none as 0, never as unknown", async () => {
    pane(chatOf([{ kind: "assistant", id: "a", text: "Hi", usage: { prompt: 1100, input: 1100, cache: 0, output: 15, reasoning: 0, calls: 1 } }]));
    await userEvent.click(screen.getByRole("button", { name: /^Tokens for this reply/ }));
    const table = document.querySelector(".usage-breakdown")!;
    expect([...table.querySelectorAll(".usage-row dd")].slice(0, 3).map((d) => d.textContent)).toEqual([(1100).toLocaleString(), (1100).toLocaleString(), "0"]);
    expect(table.textContent).not.toContain("Unknown");
    expect(table.textContent).not.toContain(REPLY_NOTES.unsplit);
  });

  it("waits for the reply to finish", () => {
    pane(chatOf([{ kind: "assistant", id: "a", text: "Streaming", usage: measured }], { running: true }));
    expect(screen.queryByRole("button", { name: /^Tokens for this reply/ })).toBeNull();
  });

  it("shows under a failed turn's error too", () => {
    pane(chatOf([{ kind: "error", id: "e", text: "Rate limited", usage: { ...measured, output: 0 } }]));
    expect(within(screen.getByRole("alert")).getByRole("button").textContent).toBe("1.2k in · 60.2k cache · 0 out");
  });
});

describe("A chat's usage", () => {
  it("shows its totals and Hermes's estimate by the title, and the breakdown when clicked, reading Hermes again", async () => {
    const onUsage = vi.fn();
    pane(chatOf([], { usage: chatUsageOf(stored, Date.now()) }), onUsage);
    const pill = screen.getByRole("button", { name: "Usage for this chat: 103k tokens · ~$0.0030" });

    await userEvent.click(pill);
    expect(onUsage).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog", { name: "Usage for this chat" });
    const rows = [...dialog.querySelectorAll(".usage-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);
    expect(rows).toEqual([
      ["Input, not cached", (42298).toLocaleString()],
      ["Cache read", (60160).toLocaleString()],
      ["Cache written", "0"],
      ["Output", (1006).toLocaleString()],
      ["of which reasoning", "183"],
      ["Total", (103464).toLocaleString()],
      ["Model calls", "3"],
    ]);
    expect(dialog.textContent).toContain("Estimated by Hermes. Its latest call was priced from the provider's published model prices.");
    expect(dialog.textContent).toContain("A call Hermes couldn't price isn't counted.");
    expect(dialog.textContent).toContain("Its helper tasks, such as titling, aren't included.");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("says which counts and costs Hermes didn't report", async () => {
    pane(chatOf([], { usage: chatUsageOf({ input_tokens: 900, output_tokens: 40 }, Date.now()) }));
    const pill = screen.getByRole("button", { name: "Usage for this chat: 900 in · 40 out · Cost unknown" });
    await userEvent.click(pill);
    const dialog = screen.getByRole("dialog");
    expect([...dialog.querySelectorAll(".usage-row dd")].map((d) => d.textContent)).toEqual(["900", "Not reported", "Not reported", "40", "Not reported", "Not reported", "Not reported"]);
    expect(dialog.textContent).toContain("Hermes hasn't recorded a cost for this chat.");
  });

  it("leaves a count Hermes didn't report out of the line, never showing it as zero", () => {
    pane(chatOf([], { usage: chatUsageOf({ input_tokens: 900 }, Date.now()) }));
    expect(screen.getByRole("button", { name: "Usage for this chat: 900 in · Cost unknown" })).toBeTruthy();
  });

  it("shows nothing before Hermes is read, and why when reading failed", async () => {
    const { unmount } = pane(chatOf([]));
    expect(screen.queryByRole("button", { name: /^Usage for this chat/ })).toBeNull();
    unmount();

    pane(chatOf([], { usageError: "Couldn't read usage from Hermes: The dashboard answered 500" }));
    await userEvent.click(screen.getByRole("button", { name: "Usage for this chat: Usage unknown" }));
    expect(screen.getByRole("dialog").textContent).toContain("Couldn't read usage from Hermes: The dashboard answered 500");
  });

  it("isn't offered for a chat not started yet", () => {
    render(
      <ChatPane
        chat={chatOf([], { usage: chatUsageOf(stored, 0) })}
        status="connected"
        draft="" draftKey="draft" screenshots={new ScreenshotDesk(noScreenshots)}
        onDraft={() => {}}
        onDraftStep={() => undefined}
          onRetry={() => {}}
      onEdit={() => {}}
        onDismiss={() => {}}
        onAttach={async () => ({ attachments: [], refused: [] })}
        onSend={() => {}}
        onStop={() => {}}
        onAnswer={() => {}}
        onQuestion={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Usage for this chat/ })).toBeNull();
  });
});
