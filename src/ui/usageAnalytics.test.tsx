// @vitest-environment jsdom
// The Usage screen (UsageAnalytics.tsx, ADR 0026) against a fake Hermes whose list and analytics routes answer as the
// deployed `bf0203a` does. Every chat and figure is a fixture.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type SessionRow } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { UsageIo } from "../hermes/usageAnalytics";
import { Main } from "../App";
import { UsageAnalytics, type UsageAnalyticsProps } from "./UsageAnalytics";
import { RestError } from "../hermes/pipe";

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
});

const used = (input: number, output: number, status: string | null, est: number | null, more: Partial<SessionRow> = {}): Partial<SessionRow> => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  api_call_count: 2,
  cost_status: status,
  estimated_cost_usd: est,
  actual_cost_usd: status === "actual" ? est : null,
  ...more,
});

function server() {
  const s = new FakeHermes();
  s.sessions = [
    row("glm", 1, { title: "Disk alerts", model: "z-ai/glm-5.3-flash", ...used(40_000, 1_000, "estimated", 0.004, { cache_read_tokens: 60_000 }) }),
    row("gpt", 2, { title: "Refactor plan", source: "desktop", model: "gpt-6.1-terra", ...used(5_000, 2_000, "actual", 0.5) }),
    row("tg", 3, { title: "Backups", source: "telegram", model: "z-ai/glm-5.3-flash", ...used(10_000, 500, "unknown", 0.02) }),
    row("cron", 4, { title: "Nightly report", source: "cron", model: "gpt-6.1-terra", ...used(800, 50, null, null) }),
    row("delegate", 1, { unlisted: true, ...used(9_000, 900, "estimated", 0.001) }),
  ];
  s.otherProfiles = { work: [row("w1", 1, { title: "Work chat", model: "gpt-6.1-terra", ...used(1_000, 100, "included", 0) })] };
  s.helperUsage.default = [{ task: "title_generation", input_tokens: 900, output_tokens: 20, estimated_cost: 0.001, api_calls: 7, models: ["deepseek/deepseek-v4-flash"] }];
  return s;
}

async function launch(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Usage" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Read /));
  return { hermes, user, s };
}

const tile = (label: string) => within(screen.getByRole("region", { name: "Tokens" })).getByText(label).nextElementSibling!.textContent;

describe("Usage in the app", () => {
  it("adds up the chats, keeps the recorded cost apart from a bill, and compares with Hermes's own sums", async () => {
    await launch();
    expect(tile("Input, not cached")).toBe((55_800).toLocaleString());
    expect(tile("Cache read")).toBe((60_000).toLocaleString());
    expect(tile("Chats")).toBe("4");
    const cost = screen.getByRole("region", { name: "Recorded cost" });
    expect(within(cost).getByText("~$0.52+")).toBeTruthy();
    expect(cost.textContent).toMatch(/not a bill/);
    const kinds = within(cost.querySelector("table")!).getAllByRole("rowheader").map((h) => h.textContent!.trim());
    expect(kinds).toEqual(["Reported by the provider", "Estimated by Hermes", "At least (latest call unpriced)", "Unknown"]);
    const hermes = screen.getByRole("region", { name: "Hermes's own totals" });
    // The subagent run is in Hermes's sums, in no chat.
    expect(hermes.textContent).toMatch(/Hermes counts 1 more sessions/);
    expect(within(hermes).getByText("title generation")).toBeTruthy();
  });

  it("sorts the breakdown, drills into a group and opens a chat from it", async () => {
    const { user } = await launch();
    const table = () => screen.getByRole("region", { name: "Breakdown" }).querySelector("table")!;
    const firstRow = () => within(table()).getAllByRole("row")[1].querySelector("th")!.textContent;
    expect(firstRow()).toMatch(/z-ai\/glm-5.3-flash/);
    await user.click(within(table()).getByRole("button", { name: "Model" }));
    expect(within(table()).getByRole("columnheader", { name: /Model/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(firstRow()).toMatch(/gpt-6.1-terra/);
    await user.click(screen.getByRole("button", { name: "Where it started" }));
    await user.click(screen.getByRole("button", { name: /^Telegram: show its 1 chats/ }));
    const drill = screen.getByRole("heading", { name: "Where it started: Telegram" });
    expect(document.activeElement).toBe(drill);
    await user.click(screen.getByRole("button", { name: "Back to the breakdown" }));
    // Focus goes back to the row's own button, mounted again with the breakdown.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Telegram: show its 1 chats/ })));
    await user.click(screen.getByRole("button", { name: /^Hermes Chat: show its/ }));
    await user.click(screen.getByRole("button", { name: "Disk alerts" }));
    await waitFor(() => expect(document.querySelector(".usage-screen")).toBeNull());
    expect(screen.getAllByText("Disk alerts").length).toBeGreaterThan(0);
  });

  it("reads all profiles, and keeps those it could read when one fails", async () => {
    const s = server();
    const { user } = await launch(s);
    s.otherProfiles.ops = [];
    const original = s.rest["GET /api/sessions"];
    s.rest["GET /api/sessions"] = (req) => {
      if (req.query.get("profile") === "work") throw new RestError(503, '{"detail":"Session store is busy"}');
      return original(req);
    };
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "All profiles");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/partly/));
    expect(screen.getByRole("alert").textContent).toMatch(/These totals are partial.*Couldn't read the work profile.*503/s);
    // A total that is short says so, the cost too.
    expect(tile("Chats")).toBe("4+");
    const cost = screen.getByRole("region", { name: "Recorded cost" });
    expect(cost.querySelector(".usage-cost-big")!.textContent).toMatch(/\+$/);
    expect(cost.textContent).toMatch(/of the tokens read in full/);
  });

  it("shows Hermes's own sums and helper tasks for a period with no chats, only subagent runs", async () => {
    const s = new FakeHermes();
    s.sessions = [row("delegate", 1, { unlisted: true, ...used(9_000, 900, "estimated", 0.001) }), row("old", 60, { title: "Old", ...used(1, 1, "estimated", 0) })];
    s.helperUsage.default = [{ task: "background_review", input_tokens: 5000, output_tokens: 50, estimated_cost: 0.002, api_calls: 3, models: ["m"] }];
    await launch(s);
    expect(screen.getByText("No chats started in this period.")).toBeTruthy();
    const hermes = screen.getByRole("region", { name: "Hermes's own totals" });
    expect(within(hermes).getByText((9_000).toLocaleString())).toBeTruthy();
    expect(within(hermes).getByText("background review")).toBeTruthy();
  });

  it("says when Hermes has no sums of its own, and counts the chats all the same", async () => {
    const s = server();
    s.analyticsRefused = { status: 404, detail: "Not Found" };
    await launch(s);
    expect(screen.getByRole("region", { name: "Hermes's own totals" }).textContent).toMatch(/no usage sums of its own for default/);
    expect(tile("Chats")).toBe("4");
  });
});

/** An io whose list answers wait until released, to see what a late answer does. */
function gatedIo(rows: Record<string, unknown>[]) {
  const waiting: { resolve: () => void; days?: number }[] = [];
  const io: UsageIo = {
    page: () => new Promise((resolve) => waiting.push({ resolve: () => resolve({ rows, total: rows.length }) })),
    session: async () => ({}),
    hermesTotals: async () => ({ totals: {} }),
  };
  return { io, waiting };
}

function props(io: UsageIo, over: Partial<UsageAnalyticsProps> = {}): UsageAnalyticsProps {
  return {
    io,
    profile: "default",
    listProfiles: async () => ["default"],
    projects: [],
    projectChats: {},
    connected: true,
    onOpenChat: vi.fn(),
    saveCsv: vi.fn(async () => "/home/liam/usage.csv"),
    onClose: vi.fn(),
    ...over,
  };
}

const now = Date.now() / 1000;
const fixtureRow = (id: string, ago: number, input: number, more: Record<string, unknown> = {}) => ({
  id,
  title: `Chat ${id}`,
  source: "gui",
  started_at: now - ago * 86_400,
  model: "m1",
  ...used(input, 10, "estimated", input / 1e6),
  ...more,
});

describe("The Usage screen", () => {
  it("drops a read the owner has moved on from, so a late answer never replaces the newer one", async () => {
    const { io, waiting } = gatedIo([fixtureRow("recent", 1, 1000), fixtureRow("older", 20, 5000)]);
    const user = userEvent.setup();
    render(<UsageAnalytics {...props(io)} />);
    await waitFor(() => expect(waiting).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "Last 7 days");
    await waitFor(() => expect(waiting).toHaveLength(2));
    // The 7-day read answers first; then the 30-day read it replaced.
    await act(async () => waiting[1].resolve());
    await waitFor(() => expect(tile("Chats")).toBe("1"));
    await act(async () => waiting[0].resolve());
    await new Promise((r) => setTimeout(r, 20));
    expect(tile("Chats")).toBe("1");
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveProperty("value", "7");
  });

  it("filters by project as this computer keeps it, and by model, without reading Hermes again", async () => {
    const page = vi.fn(async () => ({ rows: [fixtureRow("a", 1, 1000), fixtureRow("b", 1, 2000, { model: "m2" }), fixtureRow("c", 1, 4000)], total: 3 }));
    const io: UsageIo = { page, session: vi.fn(), hermesTotals: async () => ({ totals: {} }) };
    const user = userEvent.setup();
    const p = props(io, { projects: [{ id: "p1", name: "Infra", folders: [], archived: false }], projectChats: { p1: ["a", "b"] } });
    const { rerender } = render(<UsageAnalytics {...p} />);
    await waitFor(() => expect(tile("Chats")).toBe("3"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "Infra");
    expect(tile("Chats")).toBe("2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "m2");
    expect(tile("Input, not cached")).toBe((2000).toLocaleString());
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "All models");
    // A chat added to the project meanwhile counts at once.
    rerender(<UsageAnalytics {...p} projectChats={{ p1: ["a", "b", "c"] }} />);
    expect(tile("Chats")).toBe("3");
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("exports the chats it counts as CSV, saved only where the owner picks", async () => {
    const io: UsageIo = { page: async () => ({ rows: [fixtureRow("a", 1, 1000, { title: '=cmd|"x"' }), fixtureRow("b", 1, 2000, { model: "m2" })], total: 2 }), session: vi.fn(), hermesTotals: async () => ({ totals: {} }) };
    const saveCsv = vi.fn(async () => "/home/liam/usage.csv");
    const user = userEvent.setup();
    render(<UsageAnalytics {...props(io, { saveCsv })} />);
    await waitFor(() => expect(tile("Chats")).toBe("2"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "m1");
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(saveCsv).toHaveBeenCalledTimes(1);
    const [csv, name] = saveCsv.mock.calls[0] as unknown as [string, string];
    expect(name).toMatch(/^hermes-usage-\d{4}-\d\d-\d\d-to-\d{4}-\d\d-\d\d\.csv$/);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=cmd|""x"""`);
    expect(lines[1]).toMatch(/Hermes stored session totals,complete$/);
    await waitFor(() => expect(screen.getByText("Saved 1 chats to /home/liam/usage.csv.")).toBeTruthy());
  });

  it("doesn't call a cost Included when a profile couldn't be read", async () => {
    const io: UsageIo = {
      page: async (profile) => {
        if (profile === "work") throw new RestError(503, '{"detail":"busy"}');
        return { rows: [fixtureRow("a", 1, 1000, { cost_status: "included", estimated_cost_usd: 0 })], total: 1 };
      },
      session: vi.fn(),
      hermesTotals: async () => ({ totals: {} }),
    };
    const user = userEvent.setup();
    render(<UsageAnalytics {...props(io, { listProfiles: async () => ["default", "work"] })} />);
    await waitFor(() => expect(tile("Chats")).toBe("1"));
    const big = () => screen.getByRole("region", { name: "Recorded cost" }).querySelector(".usage-cost-big")!.textContent;
    expect(big()).toBe("Included");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" }).querySelectorAll("option")).toHaveLength(3));
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "All profiles");
    await waitFor(() => expect(tile("Chats")).toBe("1+"));
    expect(big()).toBe("$0.00+");
    // Every breakdown row may lack some chats too.
    const row = within(screen.getByRole("region", { name: "Breakdown" }).querySelector("tbody")!).getAllByRole("row")[0];
    expect(row.textContent).toMatch(/1\+/);
  });

  it("shows what part of a compressed chat reported, marked short, and a dash where nothing did", async () => {
    const io: UsageIo = {
      page: async () => ({
        rows: [{ ...fixtureRow("tip", 1, 1000), _lineage_root_id: "root", _lineage_ids: ["root", "tip"], cache_read_tokens: undefined }],
        total: 1,
      }),
      session: async () => ({ id: "tip", output_tokens: 20, api_call_count: 2, cost_status: "estimated", estimated_cost_usd: 0.02 }),
      hermesTotals: async () => ({ totals: {} }),
    };
    const user = userEvent.setup();
    render(<UsageAnalytics {...props(io)} />);
    await waitFor(() => expect(tile("Chats")).toBe("1"));
    await user.click(screen.getByRole("button", { name: /^m1: show its 1 chats/ }));
    const cells = within(screen.getByRole("region", { name: /^Model: m1/ }).querySelector("tbody tr")!).getAllByRole("cell");
    // Started, model, input, cache read, output, calls, total, cost.
    expect(cells[2].textContent).toBe("1k+");
    expect(cells[3].textContent).toBe("—");
    expect(cells[4].textContent).toBe("30");
  });

  it("marks every count of a chat with an unread segment, and doesn't compare it with Hermes's sums", async () => {
    const io: UsageIo = {
      page: async () => ({ rows: [{ ...fixtureRow("tip", 1, 1000), _lineage_root_id: "root", _lineage_ids: ["root", "tip"] }], total: 1 }),
      session: () => Promise.reject(new RestError(500, "x")),
      hermesTotals: async () => ({ totals: { total_sessions: 2, total_input: 3000, total_output: 30, total_cache_read: 0, total_api_calls: 4 } }),
    };
    const user = userEvent.setup();
    render(<UsageAnalytics {...props(io)} />);
    await waitFor(() => expect(tile("Chats")).toBe("1+"));
    const groupRow = screen.getByRole("region", { name: "Breakdown" }).querySelector("tbody tr")!;
    // Input, cache read, cache written, output, reasoning, calls: all short of the unread segment.
    for (const td of [...groupRow.querySelectorAll("td")].slice(1, 7)) expect(td.textContent).toMatch(/\+$/);
    const hermes = screen.getByRole("region", { name: "Hermes's own totals" });
    expect(hermes.textContent).toMatch(/Some segments of compressed chats couldn't be read, so they don't compare/);
    expect(hermes.textContent).not.toMatch(/more sessions/);
    await user.click(screen.getByRole("button", { name: /^m1: show its 1 chats/ }));
    const cells = within(screen.getByRole("region", { name: /^Model: m1/ }).querySelector("tbody tr")!).getAllByRole("cell");
    for (const i of [2, 3, 4, 5, 6]) expect(cells[i].textContent).toMatch(/\+$/);
  });

  it("treats an archived project, a deleted one and none the same way in the breakdown, the filter and the CSV", async () => {
    const io: UsageIo = { page: async () => ({ rows: [fixtureRow("a", 1, 1000), fixtureRow("b", 1, 2000), fixtureRow("c", 1, 4000)], total: 3 }), session: vi.fn(), hermesTotals: async () => ({ totals: {} }) };
    const saveCsv = vi.fn(async () => "/tmp/u.csv");
    const user = userEvent.setup();
    // "a" is in an archived project; "b" only in one Hermes no longer has; "c" in none.
    render(<UsageAnalytics {...props(io, { saveCsv, projects: [{ id: "old", name: "Old work", folders: [], archived: true }], projectChats: { old: ["a"], gone: ["b"] } })} />);
    await waitFor(() => expect(tile("Chats")).toBe("3"));
    await user.click(screen.getByRole("button", { name: "Project" }));
    const labels = within(screen.getByRole("region", { name: "Breakdown" }).querySelector("tbody")!)
      .getAllByRole("rowheader")
      .map((h) => [h.textContent, h.closest("tr")!.querySelectorAll("td")[0].textContent]);
    expect(labels.sort()).toEqual([
      ["No project", "2"],
      ["Old work (archived)", "1"],
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "No project");
    expect(tile("Chats")).toBe("2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "Old work (archived)");
    expect(tile("Chats")).toBe("1");
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    const [csv] = saveCsv.mock.calls[0] as unknown as [string];
    expect(csv.trimEnd().split("\r\n")[1]).toContain(",Old work (archived),");
  });

  it("counts what a profile gave before its read failed, and says so", async () => {
    const page = async (_p: string, offset: number) => {
      if (offset) throw new RestError(503, '{"detail":"busy"}');
      return { rows: Array.from({ length: 100 }, (_, i) => fixtureRow(`c${i}`, 0.01 * i, 10)), total: 300 };
    };
    render(<UsageAnalytics {...props({ page, session: vi.fn(), hermesTotals: async () => ({ totals: {} }) })} />);
    await waitFor(() => expect(tile("Chats")).toBe("100+"));
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't read all of the default profile: .*503.*Only the 100 chats read before that are counted/);
  });

  it("says why a custom period isn't one, and reads nothing for it", async () => {
    const page = vi.fn(async () => ({ rows: [], total: 0 }));
    const user = userEvent.setup();
    render(<UsageAnalytics {...props({ page, session: vi.fn(), hermesTotals: vi.fn() })} />);
    await waitFor(() => expect(screen.getByText("No chats started in this period.")).toBeTruthy());
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "Dates…");
    await waitFor(() => expect(page).toHaveBeenCalledTimes(2));
    const from = screen.getByLabelText("From") as HTMLInputElement;
    await user.clear(from);
    await user.type(from, "2099-01-01");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/end date is before the start date/));
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("drops the last read's totals once the dates aren't a period, so they can't be exported as one", async () => {
    const page = vi.fn(async () => ({ rows: [fixtureRow("a", 1, 1000)], total: 1 }));
    const saveCsv = vi.fn(async () => "/tmp/u.csv");
    const user = userEvent.setup();
    render(<UsageAnalytics {...props({ page, session: vi.fn(), hermesTotals: async () => ({ totals: {} }) }, { saveCsv })} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "Dates…");
    await waitFor(() => expect(tile("Chats")).toBe("1"));
    await user.clear(screen.getByLabelText("From"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/Pick a start date/));
    expect(screen.queryByRole("region", { name: "Tokens" })).toBeNull();
    expect(screen.getByRole("button", { name: /Export CSV/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(saveCsv).not.toHaveBeenCalled();
  });

  it("stops loading when the dates stop being a period, or the connection drops, mid-read", async () => {
    const { io, waiting } = gatedIo([fixtureRow("a", 1, 1000)]);
    const user = userEvent.setup();
    const { rerender } = render(<UsageAnalytics {...props(io)} />);
    await waitFor(() => expect(waiting).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "Dates…");
    await waitFor(() => expect(waiting).toHaveLength(2));
    expect(screen.getByRole("status").textContent).toMatch(/Reading/);
    await user.clear(screen.getByLabelText("From"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    expect(screen.queryByLabelText("working")).toBeNull();
    // A late answer for the read given up has nowhere to land.
    await act(async () => waiting[1].resolve());
    expect(screen.queryByRole("region", { name: "Tokens" })).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "Last 7 days");
    await waitFor(() => expect(waiting).toHaveLength(3));
    rerender(<UsageAnalytics {...props(io, { connected: false })} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not connected to Hermes."));
    expect(screen.queryByLabelText("working")).toBeNull();
    // Its answer, arriving after the drop, is dropped too.
    await act(async () => waiting[2].resolve());
    expect(screen.queryByRole("region", { name: "Tokens" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Not connected to Hermes.");
  });

  it("says when it can't read Hermes, and when this Hermes keeps no usage per chat", async () => {
    const { unmount } = render(<UsageAnalytics {...props({ page: vi.fn(), session: vi.fn(), hermesTotals: vi.fn() }, { connected: false })} />);
    expect(screen.getByText(/Connect to Hermes to read its usage/)).toBeTruthy();
    unmount();
    render(<UsageAnalytics {...props({ page: async () => ({ rows: [{ id: "x", started_at: now, title: "Old" }], total: 1 }), session: vi.fn(), hermesTotals: async () => ({ totals: {} }) })} />);
    expect(await screen.findByText(/doesn't send token counts with its chat list/)).toBeTruthy();
  });
});
