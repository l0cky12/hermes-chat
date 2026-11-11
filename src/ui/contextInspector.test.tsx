// @vitest-environment jsdom
// The context inspector (ADR 0025), opened from the status bar's meter and driven against a fake Hermes speaking the
// deployed `bf0203a` wire shapes: totals with and without a breakdown, after a model change, compactions stored and
// happening during a reply, Compact now only after confirming, and nothing from another session shown.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import type { PreviewTarget } from "../hermes/preview";
import { connect, type Hermes } from "../hermes/transport";
import { LinksProvider } from "./previewContext";
import { ShowInChatContext } from "./showInChat";
import { StatusBar } from "./StatusBar";
import { RestError } from "../hermes/pipe";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** `server._get_usage` as the deployed Hermes sends it for a session with a context compressor. */
const usage = (extra: Record<string, unknown> = {}) => ({
  usage: { model: "claude-opus-5-5", input: 41_000, output: 1_200, calls: 3, context_used: 46_000, context_max: 200_000, context_percent: 23, context_source: "provider_usage", context_estimated: false, compressions: 0, ...extra },
});

/** `session.context_breakdown` for a built agent at `bf0203a`. */
const BREAKDOWN = {
  categories: [
    { color: "var(--context-usage-system)", id: "system_prompt", label: "System prompt", tokens: 6_210 },
    { color: "var(--context-usage-tools)", id: "tool_definitions", label: "Tool definitions", tokens: 8_904 },
    { color: "var(--context-usage-memory)", id: "memory", label: "Memory", tokens: 512 },
    { color: "var(--context-usage-conversation)", id: "conversation", label: "Conversation", tokens: 30_100 },
  ],
  context_max: 200_000,
  context_percent: 24,
  context_used: 47_120,
  context_source: "provider_usage_plus_estimate",
  context_estimated: true,
  estimated_total: 45_726,
  model: "claude-opus-5-5",
  context_files: [
    { label: "AGENTS.md", path: "/srv/nas/AGENTS.md", chars: 4_000, est_tokens: 1_000, loaded: true, status: "loaded" },
    { label: "CLAUDE.md", path: "/srv/nas/CLAUDE.md", chars: 40, est_tokens: 10, loaded: false, status: "shadowed" },
  ],
};

/** A stored chat with one in-place compaction, its rows as the live server keeps them; times are Unix seconds. */
const STORED: TranscriptMessage[] = [
  { role: "user", text: "Check the NAS backup", row_id: 1, timestamp: 1_790_000_000, compacted: true },
  { role: "assistant", text: "Snapshot 41 GB.", row_id: 2, timestamp: 1_790_000_010, compacted: true },
  { role: "user", text: "Rotate logs", row_id: 3, timestamp: 1_790_000_020, compacted: true },
  {
    role: "assistant",
    text: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.\n## Goal\nKeep the NAS backed up <img src=x onerror="window.pwned=1">\n--- END OF CONTEXT SUMMARY — respond to the message below',
    row_id: 4,
    timestamp: 1_790_000_100,
    summary: true,
  },
  { role: "user", text: "And now the disk?", row_id: 5, timestamp: 1_790_000_200 },
];

/**
 * The bar for a stored chat opened on a fake Hermes, in a pane that can show a place in the chat and open the preview.
 * `edit`: changes the chat as the bar sees it.
 */
async function inspectorFor(server = new FakeHermes(), edit: (c: Chat) => Chat = (c) => c) {
  server.sessions = [row("nas", 1, { title: "NAS" })];
  for (const m of STORED) server.storeMessage("nas", m);
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  await hermes.open("nas");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "nas")!;
  const showInChat = vi.fn(() => true);
  const preview = vi.fn<(t: PreviewTarget) => void>();
  const bar = () => (
    <LinksProvider preview={preview} web={{ openInBrowser: async () => null }} onToast={() => {}}>
      <ShowInChatContext.Provider value={showInChat}>
        <StatusBar
          chat={edit(chat())}
          status={hermes.getSnapshot().status}
          context={{ inspect: () => hermes.inspectContext("nas"), history: () => hermes.compactionHistory("nas"), compact: () => hermes.compact("nas"), cannotCompact: () => hermes.cannotCompact() }}
        />
      </ShowInChatContext.Provider>
    </LinksProvider>
  );
  const view = render(bar());
  hermes.subscribe(() => view.rerender(bar()));
  const runtime = server.runtimeIdOf("nas")!;
  return { server, hermes, runtime, chat, showInChat, preview };
}

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const dialog = () => screen.getByRole("dialog", { name: "Context window" });
async function open(hermes: Hermes, server: FakeHermes, runtime: string, extra?: Record<string, unknown>) {
  act(() => server.event(runtime, "session.usage", usage(extra)));
  await userEvent.click(screen.getByRole("button", { name: /% full/ }));
  await settle(hermes);
}
const tab = (name: string) => userEvent.click(screen.getByRole("tab", { name }));

describe("The window", () => {
  it("shows Hermes's total with how it counted it, its estimate by category, the files it read, and when it answered", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = BREAKDOWN;
    const { hermes, runtime, preview } = await inspectorFor(server);
    await open(hermes, server, runtime);

    const d = dialog();
    // The breakdown's own total, not the meter's 23% or the categories added up.
    expect(within(d).getByRole("region", { name: "Total" }).textContent).toMatch(/^47,120 of 200,000 tokens · 24%Partly estimated/);
    expect(d.textContent).toContain("152,880 tokens left");
    expect(d.textContent).toMatch(/Read at .* for claude-opus-5-5\. Hermes doesn't time its measure/);
    const parts = within(d).getByRole("list", { name: "Breakdown by category" });
    expect([...parts.querySelectorAll(".part-label")].map((l) => l.textContent)).toEqual(["System prompt", "Tool definitions", "Memory", "Conversation"]);
    expect([...parts.querySelectorAll(".part-tokens")].map((l) => l.textContent)).toEqual(["~6,210", "~8,904", "~512", "~30,100"]);
    // What Hermes doesn't measure on its own says so, rather than a number.
    expect(within(d).getByRole("list", { name: "Not reported separately" }).textContent).toContain("Tool outputCounted in Conversation; Hermes doesn't measure it on its own.Unavailable");
    expect(d.textContent).toContain("Nothing from: Instruction files, Skills, MCP tools, Subagent tools.");

    const files = within(d).getByRole("list", { name: "Instruction files Hermes considered" });
    expect(files.textContent).toContain("Not read: a higher-priority kind of instruction file wins");
    await userEvent.click(within(files).getByRole("button", { name: "AGENTS.md" }));
    expect(preview).toHaveBeenCalledWith({ kind: "server", path: "/srv/nas/AGENTS.md" });
    expect(server.last("session.context_breakdown")!.params).toEqual({ session_id: runtime });
  });

  it("says the split is unavailable before Hermes builds the chat, and when this Hermes has no breakdown at all", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server);
    // The deployed answer for a session whose agent isn't built yet.
    await open(hermes, server, runtime);
    expect(dialog().textContent).toContain("Not measured yetUnavailable");
    expect(dialog().textContent).toContain("Hermes hasn't built this chat on the server yet, so it can't split the window.");
    expect(screen.queryByRole("list", { name: "Breakdown by category" })).toBeNull();

    server.contextBreakdown = undefined;
    await userEvent.click(screen.getByRole("button", { name: "Ask Hermes again" }));
    await settle(hermes);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't read the context window: This Hermes doesn't report what fills the context window.");
  });

  it("says when the measure was for a model the chat has since left", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = { ...BREAKDOWN, model: "gpt-6.1" };
    const { hermes, runtime } = await inspectorFor(server);
    act(() => server.event(runtime, "session.info", { model: "claude-opus-5-5", provider: "anthropic" }));
    await open(hermes, server, runtime);
    expect(dialog().textContent).toContain("Measured for gpt-6.1, and the chat now uses claude-opus-5-5.");
  });

  it("keeps the provider's cache, a billing count over every call, apart from the window's size", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = BREAKDOWN;
    const { hermes, runtime } = await inspectorFor(server, (c) => ({
      ...c,
      usage: { input: 20_000, cacheRead: 900_000, cacheWrite: 80_000, output: 9_000, calls: 30, cost: { status: "unknown" } as never, readAt: 0 },
    }));
    await open(hermes, server, runtime);
    const cache = within(dialog()).getByRole("region", { name: "Prompt cache (billing)" });
    expect(cache.textContent).toContain("90% of the input over this chat's 30 model calls was read from the provider's cache: 900,000 tokens read, 80,000 written, 20,000 not cached.");
    expect(cache.textContent).toContain("aren't part of the total above");
    // 900,000 cache reads are far over the 200,000 window, and the total doesn't take them in.
    expect(within(dialog()).getByRole("region", { name: "Total" }).textContent).toContain("47,120 of 200,000");
  });

  it("says Hermes hasn't reported the cache when the chat's usage isn't known", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server, (c) => ({ ...c, usage: undefined }));
    await open(hermes, server, runtime);
    expect(within(dialog()).getByRole("region", { name: "Prompt cache (billing)" }).textContent).toContain("Unavailable");
  });
});

describe("A chat Hermes hasn't measured", () => {
  it("still opens the inspector from the meter, says the window is unavailable, and reads the stored compactions", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = BREAKDOWN;
    // Reopened from the list, with no live session on this connection: no measure, no runtime id.
    const { hermes } = await inspectorFor(server, (c) => ({ ...c, runtimeId: undefined, live: undefined }));
    const meter = screen.getByRole("button", { name: "Context not measured" });
    expect(meter.title).toBe("Context: Hermes hasn't measured this chat's window yet. Click to see what it does report.");
    // Nothing is made up: no percentage.
    expect(screen.queryByText(/% full/)).toBeNull();

    await userEvent.click(meter);
    await settle(hermes);
    expect(dialog().textContent).toContain("Hermes hasn't loaded this chat on the server yet, so it has measured nothing for it.");
    // It doesn't ask for a breakdown of a session it has no id for.
    expect(server.last("session.context_breakdown")).toBeUndefined();

    await userEvent.click(within(dialog()).getByRole("button", { name: "See compactions" }));
    await settle(hermes);
    expect(within(dialog()).getByRole("list", { name: "Compactions, newest first" }).textContent).toContain("Took 3 earlier messages out of what the model reads");
    expect((screen.getByRole("button", { name: "Compact now…" }) as HTMLButtonElement).title).toBe("Open the chat on Hermes to compact it.");
  });
});

describe("The inspector's place", () => {
  it("stays inside a narrow right-hand pane, narrowed and moved left of the meter", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server);
    // The right pane of two in a 760px window: its bar runs from x=400 to x=760, and the meter sits at its left.
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    bar.getBoundingClientRect = () => rect(400, 360);
    act(() => server.event(runtime, "session.usage", usage()));
    const meter = screen.getByRole("button", { name: /% full/ });
    meter.parentElement!.getBoundingClientRect = () => rect(560, 90);
    await userEvent.click(meter);
    await settle(hermes);
    const box = dialog();
    // 360 less 8 each side, and its left edge at the pane's x=408: 152px left of the meter.
    expect(box.style.width).toBe("344px");
    expect(box.style.left).toBe("-152px");
  });
});

describe("Compactions", () => {
  it("lists the compactions Hermes stored, shows the summary it kept as plain text, and goes to where it happened", async () => {
    const { server, hermes, runtime, showInChat } = await inspectorFor();
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);

    const list = screen.getByRole("list", { name: "Compactions, newest first" });
    expect(list.textContent).toContain("Took 3 earlier messages out of what the model reads");
    expect(dialog().textContent).toContain("The model reads 1 stored messages now");
    expect(server.restRequests.find((r) => r.path === "/api/sessions/nas/messages")!.query.get("include_compacted")).toBe("true");

    await userEvent.click(within(list).getByRole("button", { name: "Show summary" }));
    const summary = screen.getByLabelText("Summary Hermes kept");
    expect(summary.textContent).toContain('Keep the NAS backed up <img src=x onerror="window.pwned=1">');
    // Shown as text: no element made from it, and the end marker and what follows aren't part of it.
    expect(dialog().querySelector("img")).toBeNull();
    expect(summary.textContent).not.toContain("END OF CONTEXT SUMMARY");

    await userEvent.click(within(list).getByRole("button", { name: "Show where it happened" }));
    expect(showInChat).toHaveBeenCalledWith(1_790_000_100_000);
  });

  it("says so when Hermes stored none, and when the history can't be read", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server);
    server.transcripts.nas = server.transcripts.nas.filter((m) => !m.compacted && !m.summary);
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);
    expect(dialog().textContent).toContain("Hermes has stored no compactions for this chat.");

    server.messagesFailure = new RestError(500, `{"detail":"database is locked"}`);
    await userEvent.click(screen.getByRole("button", { name: "Ask Hermes again" }));
    await settle(hermes);
    expect(screen.getByRole("alert").textContent).toContain(`Couldn't read the compactions Hermes stored: The dashboard answered 500`);
  });

  it("reads both again when Hermes compacts the chat on its own during a reply", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = BREAKDOWN;
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);
    expect(dialog().textContent).toContain("Hermes has compacted this chat no times since it last loaded it on the server.");
    const asked = () => [server.requests.filter((r) => r.method === "session.context_breakdown").length, server.restRequests.filter((r) => r.path.endsWith("/messages")).length];
    const before = asked();

    act(() => server.event(runtime, "message.start"));
    act(() => server.event(runtime, "session.usage", usage({ compressions: 0, context_used: 180_000, context_percent: 90 })));
    await settle(hermes);
    expect(asked()).toEqual(before);
    // Hermes compacted mid-reply: its count moved.
    act(() => server.event(runtime, "session.usage", usage({ compressions: 1, context_used: 30_000, context_percent: 15 })));
    await settle(hermes);
    expect(asked()).toEqual([before[0] + 1, before[1] + 1]);
    expect(dialog().textContent).toContain("Hermes has compacted this chat once");
  });
});

describe("Compactions read after a reply", () => {
  it("are read again when the reply ends, since Hermes counts a compaction before it stores the rows", async () => {
    const server = new FakeHermes();
    server.contextBreakdown = BREAKDOWN;
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);
    const listed = () => within(dialog()).getByRole("list", { name: "Compactions, newest first" }).querySelectorAll("li").length;
    expect(listed()).toBe(1);

    act(() => server.event(runtime, "message.start"));
    // The count moves first; the summary and compacted rows aren't stored yet, so this read still finds one.
    act(() => server.event(runtime, "session.usage", usage({ compressions: 1 })));
    await settle(hermes);
    expect(listed()).toBe(1);

    server.storeMessage("nas", { role: "user", text: "And now the disk?", row_id: 6, timestamp: 1_790_000_300, compacted: true });
    server.storeMessage("nas", { role: "assistant", text: "[CONTEXT COMPACTION — REFERENCE ONLY] Second.", row_id: 7, timestamp: 1_790_000_400, summary: true });
    act(() => server.event(runtime, "message.complete", { text: "Done", usage: usage({ compressions: 1 }).usage }));
    await settle(hermes);
    // The reply's end read the stored rows again, with the second compaction in them.
    expect(listed()).toBe(2);
  });
});

describe("A long chat's history", () => {
  it("says it is incomplete and claims no absence or counts the unread rows could change", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server);
    const truncated = vi.spyOn(hermes, "compactionHistory");
    // Cut at the limit with no summary in the rows read, and compacted rows a summary past the cut may explain.
    truncated.mockResolvedValueOnce({ events: [], unmarked: { removed: 40 }, inContext: 12, truncated: true, readAt: 0 });
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);
    let d = dialog().textContent!;
    expect(d).toContain("Incomplete This chat is long: only its first 10,000 stored rows were read.");
    expect(d).toContain("No compaction is stored in the rows read.");
    expect(d).not.toContain("Hermes has stored no compactions");
    expect(d).not.toContain("No summary stored");

    // With a compaction in the rows read: listed with its summary, but with no count of what it took out.
    truncated.mockResolvedValueOnce({ events: [{ rowId: 4, at: 1_790_000_100_000, summary: "[CONTEXT SUMMARY]: s", removed: 3, inContext: true }], inContext: 12, truncated: true, readAt: 0 });
    await userEvent.click(screen.getByRole("button", { name: "Ask Hermes again" }));
    await settle(hermes);
    d = dialog().textContent!;
    expect(d).toContain("Put in a summary of 20 characters.");
    expect(d).not.toContain("earlier messages out");
    expect(d).not.toContain("stored messages now");
    expect(d).toContain("Incomplete");
  });
});

describe("Compact now", () => {
  it("runs only after the owner confirms, and reports what Hermes did", async () => {
    const server = new FakeHermes();
    server.compressResult = { status: "compressed", removed: 31, before_messages: 40, after_messages: 9, before_tokens: 52_000, after_tokens: 11_000, summary: { headline: "Compressed: 40 → 9 messages" } };
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime);
    await tab("Compactions");
    await settle(hermes);

    await userEvent.click(screen.getByRole("button", { name: "Compact now…" }));
    const confirm = screen.getByRole("group", { name: "Compact this chat?" });
    expect(confirm.textContent).toContain("Every message stays in the chat.");
    // Cancel has focus, so a stray Enter backs out.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await userEvent.keyboard("{Enter}");
    expect(server.last("session.compress")).toBeUndefined();
    // Focus goes back to Compact now, inside the popover, so Escape still reaches it.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Compact now…" }));

    const breakdowns = server.requests.filter((r) => r.method === "session.context_breakdown").length;
    await userEvent.click(screen.getByRole("button", { name: "Compact now…" }));
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    await settle(hermes);
    expect(server.last("session.compress")!.params).toEqual({ session_id: runtime });
    expect(screen.getByRole("status").textContent).toBe("Compacted. 40 messages became 9, about 52,000 → 11,000 tokens by Hermes's estimate.Hermes: Compressed: 40 → 9 messages");
    // What fills the window is read again.
    expect(server.requests.filter((r) => r.method === "session.context_breakdown").length).toBe(breakdowns + 1);
    // Focus never fell out of the popover: it is on Compact now again, and Escape closes the inspector.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Compact now…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isn't offered when Hermes reports no compactor, or while a reply runs", async () => {
    const server = new FakeHermes();
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime, { compressions: undefined });
    await tab("Compactions");
    const button = () => screen.getByRole("button", { name: "Compact now…" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("Hermes hasn't said it can compact this chat, so Hermes Chat doesn't offer it.");

    act(() => server.event(runtime, "session.usage", usage({ compressions: 2 })));
    expect(button().disabled).toBe(false);
    act(() => server.event(runtime, "message.start"));
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("Hermes compacts only between replies. Wait for this one to finish.");
  });

  it("stops offering it on a Hermes that can't compact", async () => {
    const server = new FakeHermes();
    server.compressResult = undefined;
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime);
    await tab("Compactions");
    await userEvent.click(screen.getByRole("button", { name: "Compact now…" }));
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    await settle(hermes);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't compact: This Hermes can't compact a chat from here.");
    expect((screen.getByRole("button", { name: "Compact now…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(hermes.cannotCompact()).toBe(true);
  });
});

describe("Another session's answer", () => {
  it("is never shown: the inspector closes with the connection, and a late answer is refused", async () => {
    const server = new FakeHermes();
    let answer = () => {};
    server.handlers["session.context_breakdown"] = (r) => (answer = () => server.respond(r.id, BREAKDOWN));
    const { hermes, runtime } = await inspectorFor(server);
    await open(hermes, server, runtime);
    expect(dialog().textContent).toContain("Asking Hermes what fills the window");

    const late = hermes.inspectContext("nas").catch((e: Error) => e);
    act(() => server.drop());
    act(() => answer());
    // The inspector is keyed to the live session, which goes with the connection: it closes, and starts afresh.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(((await late) as Error).message).toMatch(/Connection closed/);
    // Asked again with no live session, it refuses rather than ask another one.
    await expect(hermes.inspectContext("nas")).rejects.toThrow("This chat isn't open on Hermes.");
  });
});
