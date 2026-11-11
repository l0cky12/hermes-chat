// Usage analytics (usageAnalytics.ts, ADR 0026): reading every chat started in a period, adding up Hermes's stored
// totals without counting anything twice, labelling costs by how Hermes got them, and the CSV.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type SessionRow } from "./fakeHermes";
import { connect } from "./transport";
import {
  CSV_COLUMNS,
  MAX_PAGES,
  MAX_SEGMENT_READS,
  NO_PROJECT,
  StaleRead,
  chatCost,
  collectUsage,
  coverage,
  crossCheck,
  csvField,
  dayIn,
  dayStart,
  filterChats,
  groupBy,
  periodOf,
  recordedUsd,
  reportedNowhere,
  sortChats,
  sortGroups,
  tallyLabel,
  totalOf,
  totalsOf,
  usageCsv,
  type UsageChat,
  type UsageIo,
} from "./usageAnalytics";
import { RestError } from "./pipe";

const DAY = 86_400;
const H = 3_600_000;

/** Stored totals as the deployed `bf0203a` keeps them (shapes read from its `state.db`, 2026-11-03; figures made up). */
const usage = (
  input: number,
  output: number,
  more: Partial<SessionRow> & { cost?: [status: string | null, estimated: number | null, actual?: number | null] } = {},
): Partial<SessionRow> => {
  const { cost = ["estimated", input / 1e6], ...rest } = more;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    api_call_count: 1,
    cost_status: cost[0],
    estimated_cost_usd: cost[1],
    actual_cost_usd: cost[2] ?? null,
    cost_source: cost[0] === "estimated" ? "provider_models_api" : null,
    ...rest,
  };
};

/** A fixture spanning two models, every cost status, a compressed chat, a subagent run and a pinned old chat. */
function fixture(): FakeHermes {
  const server = new FakeHermes();
  server.sessions = [
    row("glm-1", 1, { title: "Disk alerts", source: "gui", model: "z-ai/glm-5.3-flash", ...usage(40_000, 1_000, { cache_read_tokens: 60_000, reasoning_tokens: 200, api_call_count: 3 }) }),
    row("glm-2", 2, { title: "Backups", source: "telegram", model: "z-ai/glm-5.3-flash", ...usage(10_000, 500, { cost: ["unknown", 0.02] }) }),
    row("gpt-1", 3, { title: "Refactor", source: "desktop", model: "gpt-6.1-terra", ...usage(5_000, 2_000, { cache_write_tokens: 1_000, cost: ["actual", 0.5, 0.5] }) }),
    row("sub-1", 3, { title: "Included", source: "cli", model: "claude-sonnet", ...usage(3_000, 100, { cost: ["included", 0] }) }),
    row("cron-1", 4, { title: "Nightly report", source: "cron", model: "gpt-6.1-terra", ...usage(800, 50, { cost: [null, null], api_call_count: 1 }) }),
    // An empty chat: no model calls, nothing to price.
    row("empty", 4, { title: "Empty", source: "gui", ...usage(0, 0, { cost: [null, null], api_call_count: 0 }) }),
    // Compressed: the list row carries the first segment's counts under the last segment's id.
    row("root", 5, {
      title: "Long chat", source: "desktop", model: "gpt-6.1-terra", _lineage_ids: ["root", "tip"],
      listedAs: { id: "tip", model: "gpt-6.1-terra" }, ...usage(600_000, 30_000, { cost: ["estimated", 0] }),
    }),
    row("tip", 4.9, { unlisted: true, ...usage(400_000, 10_000, { cost: ["estimated", 3.2] }) }),
    // A subagent run: Hermes counts it, no chat list shows it.
    row("delegate", 1, { unlisted: true, source: "desktop", ...usage(9_000, 900) }),
    // Out of the period, but pinned: on every page.
    row("old-pinned", 40, { pinned: true, title: "Old", ...usage(1, 1) }),
    row("old", 40, { title: "Old too", ...usage(1, 1) }),
  ];
  return server;
}

async function io(server: FakeHermes): Promise<UsageIo> {
  return (await connect(server.openPipe)).usageIo();
}

const NOW = Date.now();
const week = (now = NOW) => periodOf({ kind: "rolling", days: 7 }, "UTC", now) as { from: number; to: number; days: number };

afterEach(() => vi.useRealTimers());

describe("Reading a period", () => {
  it("adds up every chat started in it, compressed chats' segments once each, and leaves out what's older", async () => {
    const server = fixture();
    const data = await collectUsage(await io(server), ["default"], week());
    const ids = data.chats.map((c) => c.id).sort();
    expect(ids).toEqual(["cron-1", "empty", "glm-1", "glm-2", "gpt-1", "sub-1", "tip"]);
    const long = data.chats.find((c) => c.id === "tip")!;
    // Both segments: the first from the list row, the later one read by its id.
    expect(long.segments.map((s) => s.id)).toEqual(["root", "tip"]);
    expect(long.counts.input).toBe(1_000_000);
    expect(long.counts.output).toBe(40_000);
    expect(data.profiles).toEqual([expect.objectContaining({ profile: "default", state: "ok" })]);
    const t = totalsOf(data.chats);
    expect(t.counts.input).toBe(40_000 + 10_000 + 5_000 + 3_000 + 800 + 0 + 1_000_000);
    expect(t.counts.cacheRead).toBe(60_000);
    expect(t.counts.cacheWrite).toBe(1_000);
    expect(t.counts.reasoning).toBe(200);
    expect(totalOf(t.counts)).toBe(t.counts.input + 60_000 + 1_000 + t.counts.output);
  });

  it("asks Hermes for chats newest started first, archived ones and every source included, and stops once past the period", async () => {
    const server = fixture();
    await collectUsage(await io(server), ["default"], week());
    const lists = server.restRequests.filter((r) => r.path === "/api/sessions");
    expect(lists).toHaveLength(1);
    expect(Object.fromEntries(lists[0].query)).toEqual({ profile: "default", order: "created", archived: "include", limit: "100", offset: "0" });
  });

  it("compares the chats with Hermes's own sums, which count subagent runs no chat list shows", async () => {
    const server = fixture();
    const data = await collectUsage(await io(server), ["default"], week());
    const [check] = crossCheck(data);
    // Hermes: every stored session started in the 7 days, the subagent run and both segments included.
    expect(check.hermes.sessions).toBe(9);
    expect(check.hermes.input! - check.input).toBe(9_000);
    expect(check.chats).toBe(7);
    expect(check.sessions).toBe(8);
  });

  it("shows Hermes's helper tasks apart, and says when this Hermes has no sums of its own", async () => {
    const server = fixture();
    server.helperUsage.default = [{ task: "title_generation", input_tokens: 900, output_tokens: 20, estimated_cost: 0.001, api_calls: 7, models: ["deepseek/deepseek-v4-flash"] }];
    let data = await collectUsage(await io(server), ["default"], week());
    expect(data.profiles[0].hermes).toEqual({ state: "ok", totals: expect.objectContaining({ helpers: [expect.objectContaining({ task: "title_generation", calls: 7 })] }) });
    server.analyticsRefused = { status: 404, detail: "Not Found" };
    data = await collectUsage(await io(server), ["default"], week());
    expect(data.profiles[0].hermes).toEqual({ state: "unsupported" });
    // The chats are read all the same.
    expect(data.chats).toHaveLength(7);
    server.analyticsRefused = { status: 503, detail: "Session store is busy" };
    data = await collectUsage(await io(server), ["default"], week());
    expect(data.profiles[0].hermes).toMatchObject({ state: "failed", error: expect.stringContaining("503") });
  });

  it("doesn't take a server error whose text quotes a 404 for a missing route (#486)", async () => {
    const server = fixture();
    server.analyticsRefused = { status: 500, detail: "upstream answered 404: Not Found" };
    const data = await collectUsage(await io(server), ["default"], week());
    expect(data.profiles[0].hermes).toMatchObject({ state: "failed", error: expect.stringContaining("500") });
  });

  it("doesn't ask for Hermes's sums for a custom period, which they can't cover", async () => {
    const server = fixture();
    const p = periodOf({ kind: "custom", from: dayIn("UTC", NOW - 3 * DAY * 1000), to: dayIn("UTC", NOW) }, "UTC", NOW);
    const data = await collectUsage(await io(server), ["default"], p as { from: number; to: number });
    expect(data.profiles[0].hermes).toBeUndefined();
    expect(server.restRequests.some((r) => r.path.startsWith("/api/analytics"))).toBe(false);
  });

  it("keeps the profiles it could read when another fails, and says which", async () => {
    const server = fixture();
    server.otherProfiles = { work: [] };
    const base = await io(server);
    const failing: UsageIo = { ...base, page: (profile, o, l) => (profile === "work" ? Promise.reject(new RestError(503, "busy")) : base.page(profile, o, l)) };
    const data = await collectUsage(failing, ["default", "work"], week());
    expect(data.profiles.map((p) => [p.profile, p.state])).toEqual([
      ["default", "ok"],
      ["work", "failed"],
    ]);
    expect(data.profiles[1].error).toMatch(/503/);
    expect(data.chats).toHaveLength(7);
  });

  it("counts a segment it couldn't read as missing, and the chat as partial", async () => {
    const server = fixture();
    const base = await io(server);
    const data = await collectUsage({ ...base, session: () => Promise.reject(new RestError(500, "x")) }, ["default"], week());
    const long = data.chats.find((c) => c.id === "tip")!;
    expect(long.missing).toBe(1);
    expect(data.missingSegments).toBe(1);
    expect(totalsOf(data.chats).partialChats).toBe(1);
    expect(chatCost(long).short).toMatch(/\+$/);
  });

  it("stops at its page limit over a long period, and says it read only part", async () => {
    const rows = (offset: number) => Array.from({ length: 100 }, (_, i) => ({ id: `c${offset + i}`, started_at: NOW / 1000 - (offset + i) * 60, input_tokens: 1, output_tokens: 1 }));
    const page = vi.fn(async (_p: string, offset: number) => ({ rows: rows(offset), total: 1_000_000 }));
    const data = await collectUsage({ page, session: vi.fn(), hermesTotals: vi.fn(async () => ({})) }, ["default"], { from: 0, to: NOW + 1 });
    expect(page).toHaveBeenCalledTimes(MAX_PAGES);
    expect(data.profiles[0].state).toBe("capped");
    expect(data.chats).toHaveLength(MAX_PAGES * 100);
  });

  it("stops, and throws, once a newer read replaces it", async () => {
    const ac = new AbortController();
    let pages = 0;
    const page = async (_p: string, offset: number) => {
      pages++;
      if (pages === 2) ac.abort();
      return { rows: [{ id: `c${offset}`, started_at: NOW / 1000, input_tokens: 1 }], total: 1000 };
    };
    await expect(collectUsage({ page, session: vi.fn(), hermesTotals: vi.fn() }, ["default", "work"], { from: 0, to: NOW + 1 }, { signal: ac.signal })).rejects.toBeInstanceOf(StaleRead);
    expect(pages).toBe(2);
  });

  it("keeps each pinned chat once across pages, and leaves out the old ones every page carries", async () => {
    const at = (daysAgo: number) => NOW / 1000 - daysAgo * DAY;
    const r = (id: string, daysAgo: number, pinned = false) => ({ id, started_at: at(daysAgo), pinned, input_tokens: 10, output_tokens: 1 });
    // Pinned rows come on every page, out of order: one in the period, one long before it.
    const pinned = [r("pin-new", 2, true), r("pin-old", 60, true)];
    const pages = [
      [...Array.from({ length: 100 }, (_, i) => r(`a${i}`, 1 + i / 100)), ...pinned],
      [r("b0", 3), r("b1", 6), r("past", 8), ...pinned],
      [r("never", 9)],
    ];
    const page = vi.fn(async (_p: string, offset: number) => ({ rows: pages[offset / 100], total: 202 }));
    const data = await collectUsage({ page, session: vi.fn(), hermesTotals: async () => ({ totals: {} }) }, ["default"], week());
    expect(page).toHaveBeenCalledTimes(2);
    const ids = data.chats.map((c) => c.id);
    expect(ids.filter((id) => id === "pin-new")).toHaveLength(1);
    expect(ids).not.toContain("pin-old");
    expect(ids).not.toContain("past");
    expect(ids).toHaveLength(103);
  });

  it("says when this Hermes's chat list carries no usage at all", async () => {
    const page = async () => ({ rows: [{ id: "a", started_at: NOW / 1000, title: "x" }], total: 1 });
    const data = await collectUsage({ page, session: vi.fn(), hermesTotals: vi.fn(async () => ({})) }, ["default"], week());
    expect(data.unsupported).toBe(true);
    expect(data.chats[0].noUsage).toBe(true);
  });
});

describe("Days and time zones", () => {
  it("starts a custom period at midnight on the chosen zone's clock, across a clock change", () => {
    // America/Chicago went back an hour at 2:00 on 2026-11-01: that day is 25 hours long.
    const p = periodOf({ kind: "custom", from: "2026-11-01", to: "2026-11-01" }, "America/Chicago", NOW) as { from: number; to: number };
    expect(new Date(p.from).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(p.to - p.from).toBe(25 * H);
    expect(periodOf({ kind: "custom", from: "2026-11-03", to: "2026-11-01" }, "UTC", NOW)).toEqual({ error: "The end date is before the start date." });
    expect(dayStart("2026-02-30", "UTC")).toBeUndefined();
  });

  it("puts a chat on the day it started on the chosen zone's clock", () => {
    const at = Date.UTC(2026, 10, 3, 3, 30); // 03:30 UTC is still Nov 2 in Chicago
    expect(dayIn("UTC", at)).toBe("2026-11-03");
    expect(dayIn("America/Chicago", at)).toBe("2026-11-02");
    const chat = { ...base("a"), startedAt: at };
    const ctx = { zone: "America/Chicago", projectsOf: () => new Set<string>(), projectName: () => undefined };
    expect(groupBy([chat], "day", ctx).map((g) => g.key)).toEqual(["2026-11-02"]);
    expect(groupBy([chat], "day", { ...ctx, zone: "Asia/Tokyo" }).map((g) => g.key)).toEqual(["2026-11-03"]);
  });
});

/** A chat with one segment and the given usage. */
function base(id: string, over: Partial<UsageChat> = {}, row: Partial<SessionRow> = usage(1000, 100)): UsageChat {
  const counts = { input: row.input_tokens ?? 0, cacheRead: row.cache_read_tokens ?? 0, cacheWrite: row.cache_write_tokens ?? 0, output: row.output_tokens ?? 0, reasoning: row.reasoning_tokens ?? 0, calls: row.api_call_count ?? 0 };
  const status = row.cost_status;
  const est = row.estimated_cost_usd ?? 0;
  const cost =
    status === "actual" ? { kind: "actual" as const, usd: row.actual_cost_usd ?? 0 } : status === "estimated" ? { kind: "estimated" as const, usd: est } : status === "included" ? { kind: "included" as const } : status === "unknown" && est ? { kind: "partial" as const, usd: est } : { kind: "unknown" as const, why: "unrecorded" as const };
  return {
    profile: "default",
    id,
    title: `Chat ${id}`,
    source: "gui",
    startedAt: NOW,
    archived: false,
    pinned: false,
    segments: [{ id, usage: { ...counts, cost, readAt: NOW } }],
    missing: 0,
    counts,
    unreported: [],
    noUsage: false,
    ...over,
  };
}

describe("Completeness", () => {
  it("marks a total short when some chat didn't report part of it, or reported nothing", () => {
    const noCacheWrite = base("a", {}, { ...usage(1000, 100), cache_write_tokens: undefined });
    const chats = [
      { ...noCacheWrite, segments: [{ id: "a", usage: { input: 1000, output: 100, cacheRead: 0, reasoning: 0, calls: 1, cost: { kind: "estimated" as const, usd: 0.001 }, readAt: NOW } }], unreported: ["cacheWrite" as const] },
      { ...base("b"), segments: [{ id: "b" }], counts: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 }, unreported: ["input", "cacheRead", "cacheWrite", "output", "reasoning", "calls"] as never, noUsage: true },
      base("c"),
    ];
    const t = totalsOf(chats);
    expect(t.unreported.cacheWrite).toBe(2);
    expect(t.unreported.input).toBe(1);
    expect(t.totalShort).toBe(2);
    expect(t.noUsage).toBe(1);
  });

  it("reads a list row with no usage at all as reporting none of its counts", async () => {
    const page = async () => ({ rows: [{ id: "x", started_at: NOW / 1000, input_tokens: 5, output_tokens: 1 }, { id: "y", started_at: NOW / 1000 }], total: 2 });
    const data = await collectUsage({ page, session: vi.fn(), hermesTotals: async () => ({ totals: {} }) }, ["default"], week());
    const y = data.chats.find((c) => c.id === "y")!;
    expect(y.noUsage).toBe(true);
    expect(y.unreported).toEqual(["input", "cacheRead", "cacheWrite", "output", "reasoning", "calls"]);
    expect(totalsOf(data.chats).totalShort).toBe(2); // x has no cache counts either
  });

  it("never claims full coverage when a compressed chat's segment couldn't be read", () => {
    const root = base("tip", { missing: 1 }, usage(1000, 100, { cost: ["actual", 1, 1] }));
    const label = tallyLabel(totalsOf([root, base("other", {}, usage(10, 1, { cost: ["actual", 0.5, 0.5] }))]).cost);
    expect(label.short).toBe("$1.50+");
    expect(label.detail).toMatch(/1 chat has usage that couldn't be read or wasn't recorded/);
    expect(label.detail).toMatch(/of the tokens read/);
    expect(chatCost(root).short).toBe("$1.00+");
  });
});

describe("Usage Hermes didn't record", () => {
  it("doesn't let a row with no usage pass for one that made no calls", () => {
    const none = { ...base("old"), segments: [{ id: "old" }], counts: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 }, unreported: ["input", "cacheRead", "cacheWrite", "output", "reasoning", "calls"] as never, noUsage: true };
    const label = tallyLabel(totalsOf([base("a", {}, usage(1000, 100, { cost: ["actual", 1, 1] })), none]).cost);
    expect(label.short).toBe("$1.00+");
    expect(label.detail).toMatch(/usage that couldn't be read or wasn't recorded/);
  });

  it("keeps Hermes's own sums for a profile whose chats couldn't all be read, without comparing them", async () => {
    const page = vi.fn(async (_p: string, offset: number) => {
      if (offset) throw new RestError(503, "busy");
      return { rows: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, started_at: NOW / 1000 - i, input_tokens: 1, output_tokens: 1 })), total: 500 };
    });
    const hermesTotals = async () => ({ totals: { total_sessions: 500, total_input: 500 }, by_task: [{ task: "title_generation", api_calls: 3 }] });
    const data = await collectUsage({ page, session: vi.fn(), hermesTotals }, ["default"], week());
    expect(data.profiles[0].state).toBe("failed");
    const [check] = crossCheck(data);
    expect(check.complete).toBe(false);
    expect(check.hermes.helpers.map((h) => h.task)).toEqual(["title_generation"]);
  });
});

describe("Comparing with Hermes's own sums", () => {
  const lineageRow = (i: number) => ({ id: `t${i}`, started_at: NOW / 1000 - i, _lineage_root_id: `r${i}`, _lineage_ids: [`r${i}`, `t${i}`], input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, api_call_count: 1 });
  const hermesTotals = async () => ({ totals: { total_sessions: 2, total_input: 20, total_output: 2, total_cache_read: 0, total_api_calls: 2 } });

  it("doesn't compare when a segment couldn't be read, so the gap isn't put down to subagent runs", async () => {
    const data = await collectUsage({ page: async () => ({ rows: [lineageRow(0)], total: 1 }), session: () => Promise.reject(new RestError(500, "x")), hermesTotals }, ["default"], week());
    const [check] = crossCheck(data);
    expect(check).toMatchObject({ complete: false, incomparable: "segments" });
  });

  it("doesn't compare when the refresh ran out of segment reads", async () => {
    const rows = Array.from({ length: MAX_SEGMENT_READS + 1 }, (_, i) => lineageRow(i));
    const session = vi.fn(async (_p: string, id: string) => ({ id, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, api_call_count: 1 }));
    const data = await collectUsage({ page: async (_p, offset) => ({ rows: rows.slice(offset, offset + 100), total: rows.length }), session, hermesTotals }, ["default"], week());
    expect(session).toHaveBeenCalledTimes(MAX_SEGMENT_READS);
    expect(data.segmentsSkipped).toBe(1);
    expect(crossCheck(data)[0]).toMatchObject({ complete: false, incomparable: "segments" });
  });

  it("doesn't compare when a chat didn't report a count that is compared", async () => {
    const row = { ...lineageRow(0), _lineage_ids: undefined, _lineage_root_id: undefined, cache_read_tokens: undefined };
    const data = await collectUsage({ page: async () => ({ rows: [row], total: 1 }), session: vi.fn(), hermesTotals }, ["default"], week());
    expect(crossCheck(data)[0]).toMatchObject({ complete: false, incomparable: "counts" });
  });

  it("compares when everything was read", async () => {
    const session = async (_p: string, id: string) => ({ id, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, api_call_count: 1 });
    const data = await collectUsage({ page: async () => ({ rows: [lineageRow(0)], total: 1 }), session, hermesTotals }, ["default"], week());
    expect(crossCheck(data)[0]).toMatchObject({ complete: true, sessions: 2, input: 20 });
    expect(crossCheck(data)[0].incomparable).toBeUndefined();
  });
});

describe("Chats that weren't read at all", () => {
  it("never calls a cost Included, or complete, when a profile couldn't be read", () => {
    const t = totalsOf([base("a", {}, usage(1000, 100, { cost: ["included", 0] }))]).cost;
    expect(tallyLabel(t).short).toBe("Included");
    const label = tallyLabel(t, { partial: true });
    expect(label.short).toBe("$0.00+");
    expect(label.detail).toMatch(/of the tokens read/);
    expect(label.detail).toMatch(/Some chats couldn't be read at all/);
    // A paid total gets its "+" the same way.
    expect(tallyLabel(totalsOf([base("b", {}, usage(10, 1, { cost: ["actual", 0.25, 0.25] }))]).cost, { partial: true }).short).toBe("$0.25+");
    expect(tallyLabel(totalsOf([]).cost, { partial: true }).short).toBe("?");
  });
});

describe("A count only some segments reported", () => {
  it("keeps what the other segments reported, marked short, and leaves out only what no segment reported", async () => {
    // The first segment (the list row) has input; the later one, read by id, sent none, nor any cache counts.
    const page = async () => ({
      rows: [{ id: "tip", started_at: NOW / 1000, _lineage_root_id: "root", _lineage_ids: ["root", "tip"], input_tokens: 1000, output_tokens: 10, api_call_count: 1, cost_status: "estimated", estimated_cost_usd: 0.01 }],
      total: 1,
    });
    const session = async () => ({ id: "tip", output_tokens: 20, api_call_count: 2, cost_status: "estimated", estimated_cost_usd: 0.02 });
    const data = await collectUsage({ page, session, hermesTotals: async () => ({ totals: {} }) }, ["default"], week());
    const [c] = data.chats;
    expect(c.counts.input).toBe(1000);
    expect(c.unreported).toContain("input");
    expect(reportedNowhere(c, "input")).toBe(false);
    expect(reportedNowhere(c, "cacheRead")).toBe(true);
    // One CSV line's fields, quotes undone.
    const fields = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].slice(0, -1).map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"'));
    const row = fields(usageCsv(data.chats, "UTC", () => []).trimEnd().split("\r\n")[1]);
    expect(row).toHaveLength(CSV_COLUMNS.length);
    const col = (name: string) => row[CSV_COLUMNS.indexOf(name as never)];
    expect(col("input_tokens_uncached")).toBe("1000");
    expect(col("cache_read_tokens")).toBe("");
    expect(col("output_tokens")).toBe("30");
    for (const f of ["input", "cacheRead", "cacheWrite", "reasoning"]) expect(col("coverage")).toMatch(new RegExp(`not reported:[^;]*\\b${f}\\b`));
  });
});

describe("Costs", () => {
  it("keeps each kind apart and never calls an incomplete total a bill", async () => {
    const data = await collectUsage(await io(fixture()), ["default"], week());
    const t = totalsOf(data.chats).cost;
    expect(t.kinds.actual).toMatchObject({ chats: 1, usd: 0.5 });
    expect(t.kinds.included.chats).toBe(1);
    expect(t.kinds.partial).toMatchObject({ chats: 1, usd: 0.02 });
    // The empty chat made no calls, so it isn't an unknown cost; the cron one is.
    expect(t.kinds.unknown.chats).toBe(1);
    expect(t.kinds.estimated.chats).toBe(2);
    expect(recordedUsd(t)).toBeCloseTo(0.5 + 0.02 + 0.04 + 3.2, 6);
    const label = tallyLabel(t);
    expect(label.short).toBe("~$3.76+");
    expect(label.detail).toMatch(/not a bill/);
    expect(coverage(t)).toBeLessThan(1);
    expect(coverage(t)).toBeGreaterThan(0.9);
  });

  it("says Included or Unknown alone only when all of it is", () => {
    expect(tallyLabel(totalsOf([base("a", {}, usage(1, 1, { cost: ["included", 0] }))]).cost).short).toBe("Included");
    expect(tallyLabel(totalsOf([base("a", {}, usage(1, 1, { cost: [null, null] }))]).cost).short).toBe("Cost unknown");
    expect(tallyLabel(totalsOf([base("a", {}, usage(1, 1, { cost: ["actual", 0.25, 0.25] }))]).cost).short).toBe("$0.25");
    expect(tallyLabel(totalsOf([]).cost).short).toBe("—");
  });

  it("keeps an estimate of $0 an estimate", () => {
    expect(tallyLabel(totalsOf([base("a", {}, usage(10, 1, { cost: ["estimated", 0] })), base("b", {}, usage(10, 1, { cost: ["actual", 0.25, 0.25] }))]).cost).short).toBe("~$0.25");
  });

  it("labels a chat in one segment as its own usage does", () => {
    expect(chatCost(base("a", {}, usage(1, 1, { cost: ["estimated", 0.003] }))).short).toBe("~$0.0030");
  });
});

describe("Filters and breakdowns", () => {
  const chats = [
    base("a", { model: "m1", profile: "default" }),
    base("b", { model: "m2", profile: "default" }),
    base("c", { model: "m1", profile: "work" }),
    base("d", { profile: "default" }),
  ];
  const membership = new Map([["a", new Set(["p1", "p2"])], ["b", new Set(["p1"])]]);
  const projectsOf = (c: UsageChat) => (c.profile === "default" ? (membership.get(c.id) ?? new Set<string>()) : undefined);
  const ctx = { zone: "UTC", projectsOf, projectName: (id: string) => ({ p1: "Infra", p2: "Docs" })[id] };

  it("filters by model, chats with none recorded included", () => {
    expect(filterChats(chats, { model: "m1" }, projectsOf).map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterChats(chats, { model: "\u0000none" }, projectsOf).map((c) => c.id)).toEqual(["d"]);
  });

  it("filters by project with this computer's membership, as it is now", () => {
    expect(filterChats(chats, { project: "p1" }, projectsOf).map((c) => c.id)).toEqual(["a", "b"]);
    // Another profile's chats aren't in the shown profile's projects, nor known to be in none.
    expect(filterChats(chats, { project: NO_PROJECT }, projectsOf).map((c) => c.id)).toEqual(["d"]);
    membership.set("d", new Set(["p1"]));
    expect(filterChats(chats, { project: "p1" }, projectsOf).map((c) => c.id)).toEqual(["a", "b", "d"]);
    membership.delete("d");
  });

  it("counts a chat under every project it is in, so project groups can add up to more", () => {
    const groups = groupBy(chats, "project", ctx);
    expect(groups.map((g) => [g.label, g.totals.chats]).sort()).toEqual([
      ["Another profile (projects unknown)", 1],
      ["Docs", 1],
      ["Infra", 2],
      ["No project", 1],
    ]);
    expect(groups.reduce((n, g) => n + g.totals.chats, 0)).toBeGreaterThan(chats.length);
  });

  it("groups Hermes's two names for the same place together", () => {
    const groups = groupBy([base("a", { source: "gui" }), base("b", { source: "hermes-chat" }), base("c", { source: "tui" }), base("d", { source: "cli" })], "source", ctx);
    expect(groups.map((g) => [g.label, g.totals.chats]).sort()).toEqual([
      ["Command line", 2],
      ["Hermes Chat", 2],
    ]);
  });

  it("sorts groups and chats by any column, either way", () => {
    const big = base("big", { model: "m3" }, usage(90_000, 10));
    const groups = groupBy([...chats, big], "model", ctx);
    expect(sortGroups(groups, { key: "input", dir: "desc" })[0].label).toBe("m3");
    expect(sortGroups(groups, { key: "label", dir: "asc" }).map((g) => g.label)).toEqual(["m1", "m2", "m3", "No model recorded"]);
    expect(sortChats([...chats, big], { key: "total", dir: "asc" }).at(-1)!.id).toBe("big");
  });
});

describe("CSV", () => {
  it("escapes quotes, commas and line breaks, and keeps a spreadsheet from running a title as a formula", () => {
    expect(csvField('Say "hi", then\nleave')).toBe('"Say ""hi"", then\nleave"');
    expect(csvField("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-rm")).toBe("'-rm");
    expect(csvField("@sum")).toBe("'@sum");
    expect(csvField(12)).toBe("12");
    expect(csvField(undefined)).toBe("");
  });

  it("writes one row per chat with where its figures came from and how complete they are", async () => {
    const data = await collectUsage(await io(fixture()), ["default"], week());
    const csv = usageCsv(data.chats, "America/Chicago", (c) => (c.id === "glm-1" ? ["Infra, ops"] : []));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^profile,chat_id,title,source,started_at_utc,started_at_local,time_zone,model_last_used/);
    expect(lines[0]).toMatch(/recorded_cost_usd,cost_kind,cost_label,usage_source,coverage$/);
    const long = lines.find((l) => l.includes(",tip,"))!;
    expect(long).toContain("Hermes stored session totals, 2 compression segments added");
    expect(lines.find((l) => l.includes(",glm-1,"))).toContain('"Infra, ops"');
    expect(lines.find((l) => l.includes(",glm-2,"))).toContain("cost is a lower bound");
    expect(lines.find((l) => l.includes(",empty,"))).toContain("no model calls recorded");
    expect(lines.find((l) => l.includes(",gpt-1,"))).toMatch(/,0\.5,actual,\$0\.50,/);
    expect(lines.find((l) => l.includes(",cron-1,"))).toMatch(/,,unknown,Cost unknown,/);
  });
});
