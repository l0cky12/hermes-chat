// @vitest-environment jsdom
// Usage writes its counts, times and days in the interface's language (#353).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { chatUsageOf } from "../hermes/usage";
import type { UsageIo } from "../hermes/usageAnalytics";
import { LocaleContext, localeFor } from "../i18n/locale";
import { ChatUsageButton } from "./Usage";
import { UsageAnalytics } from "./UsageAnalytics";

afterEach(cleanup);

it("writes a chat's counts and read time for the locale: Spanish groups thousands with a dot", async () => {
  const readAt = new Date(2026, 10, 8, 15, 45).getTime();
  const usage = chatUsageOf({ input_tokens: 42298, output_tokens: 1006, cache_read_tokens: 60160, cache_write_tokens: 0, api_call_count: 3 }, readAt);
  render(
    <LocaleContext value={localeFor("es", ["es-ES"])}>
      <ChatUsageButton chat={{ usage }} onRefresh={() => {}} />
    </LocaleContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Usage for this chat/ }));
  const dialog = screen.getByRole("dialog", { name: "Usage for this chat" });
  const rows = Object.fromEntries([...dialog.querySelectorAll(".usage-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]));
  expect(rows["Input, not cached"]).toBe("42.298");
  expect(rows["Total"]).toBe("103.464");
  expect(dialog.textContent).toContain("Read 15:45.");
});

it("writes a chat's start in Usage analytics as a date in the locale, and its counts with Spanish grouping", async () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const io: UsageIo = {
    page: async () => ({
      rows: [{ id: "a", title: "Chat a", source: "gui", started_at: Date.UTC(2026, 10, 3, 12) / 1000, model: "m1", input_tokens: 12345, output_tokens: 10, api_call_count: 2, cost_status: "estimated", estimated_cost_usd: 0.01 }],
      total: 1,
    }),
    session: () => Promise.reject(new Error("No segments to read.")),
    hermesTotals: async () => ({ totals: {} }),
  };
  const user = userEvent.setup();
  render(
    <LocaleContext value={localeFor("es", ["es-ES"])}>
      <UsageAnalytics io={io} profile="default" listProfiles={async () => ["default"]} projects={[]} projectChats={{}} connected onOpenChat={vi.fn()} saveCsv={vi.fn()} onClose={vi.fn()} now={() => now} />
    </LocaleContext>,
  );
  const tile = (label: string) => within(screen.getByRole("region", { name: "Tokens" })).getByText(label).nextElementSibling!.textContent;
  await waitFor(() => expect(tile("Input, not cached")).toBe("12.345"));
  await user.click(screen.getByRole("button", { name: /^m1: show its 1 chats/ }));
  const started = within(screen.getByRole("region", { name: /^Model: m1/ }).querySelector("tbody tr")!).getAllByRole("cell")[0];
  expect(started.textContent).toBe("3 nov 2026");
});
