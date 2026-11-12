// Usage analytics (GLOSSARY.md "Usage analytics", ADR 0026): the usage and cost Hermes stored for each chat, added up
// across chats, models, projects and profiles, for chats started in a period.
//
// The figures are the same stored session totals a chat's own usage shows (usage.ts, ADR 0008), read from dashboard
// REST `GET /api/sessions?order=created`, newest first, a bounded number of pages per profile. A chat Hermes compressed
// onto a fresh session is listed once, with its first segment's counts (`_project_compression_tips` at `bf0203a`), so
// its other segments are read one by one and added in. Nothing is multiplied by a price: a cost is only what Hermes
// recorded, by Hermes's own status, and the total says how much of the usage it covers.
//
// Hermes's own sums (`GET /api/analytics/usage?days=`) can't be filtered by project, model, time zone or a custom
// range, and have no cache writes or cost status, so they only cross-check a rolling period and give the usage of
// Hermes's helper tasks, which no chat carries.
import { chatUsageOf, costLabel, tokens as shortTokens, usd, type ChatUsage, type Cost } from "./usage";
import { instantsOf, isoIn, knownZone } from "./schedule";
import { statusOf } from "./pipe";
import { errorText, nonEmptyText } from "./values";

const DAY = 86_400_000;
/** Dashboard REST caps `GET /api/sessions` pages at 100. */
export const PAGE = 100;
/** Pages read per profile at most: 5,000 chats. A period reaching further back is read in part, and says so. */
export const MAX_PAGES = 50;
/** Compression segments read one by one, at most, per refresh. */
export const MAX_SEGMENT_READS = 300;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** How the app reads Hermes for analytics. Every call names the profile it reads. */
export type UsageIo = {
  /** A page of `GET /api/sessions?profile=&order=created&archived=include`: newest started first. */
  page(profile: string, offset: number, limit: number): Promise<{ rows: unknown[]; total: number }>;
  /** `GET /api/sessions/{id}?profile=`: one stored session row. */
  session(profile: string, id: string): Promise<unknown>;
  /** `GET /api/analytics/usage?days=&profile=`: Hermes's own sums for sessions started in the last `days` days. */
  hermesTotals(profile: string, days: number): Promise<unknown>;
};

export const COUNT_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "calls"] as const;
export type CountField = (typeof COUNT_FIELDS)[number];
export type Counts = Record<CountField, number>;
const zero = (): Counts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 });

/** All a chat's tokens: input, cache read and written, and output. Reasoning is part of output, so it isn't added. */
export const totalOf = (c: Counts) => c.input + c.cacheRead + c.cacheWrite + c.output;

/** One stored session's usage: a chat's, or one segment of a compressed chat. */
export type Segment = { id: string; usage?: ChatUsage };

/**
 * One chat, as analytics counts it: every segment Hermes stored for it, added up. `model`: the model it used last, as
 * Hermes keeps it. `missing`: segments that couldn't be read, so its counts are short by them. `unreported`: counts
 * Hermes didn't send for some segment that has usage.
 */
export type UsageChat = {
  profile: string;
  id: string;
  title: string;
  /** Hermes's own name for where the chat started (`sessions.source`). */
  source: string;
  /** When it started, Unix ms. Its whole usage counts on this day. */
  startedAt: number;
  model?: string;
  provider?: string;
  archived: boolean;
  pinned: boolean;
  segments: Segment[];
  missing: number;
  counts: Counts;
  unreported: CountField[];
  /** No segment has any usage recorded. */
  noUsage: boolean;
};

/** What Hermes's own sums said for a profile and rolling period (`/api/analytics/usage`). */
export type HermesTotals = {
  days: number;
  sessions?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  calls?: number;
  estimatedUsd?: number;
  actualUsd?: number;
  /** Hermes's helper tasks (titling, background review, compression, ...): in no chat's totals. */
  helpers: Helper[];
};
export type Helper = { task: string; input: number; output: number; calls: number; estimatedUsd: number; models: string[] };

/** How reading one profile went. */
export type ProfileRead = {
  profile: string;
  state: "ok" | "failed" | "capped";
  error?: string;
  /** Chats read (in the period or not). */
  read: number;
  /** Hermes's own sums: read, unsupported by this Hermes, failed, or not asked (a custom period). */
  hermes?: { state: "ok"; totals: HermesTotals } | { state: "unsupported" } | { state: "failed"; error: string };
};

export type Period = { from: number; to: number; /** A rolling period of whole days back from now, as Hermes's sums take it. */ days?: number };

export type UsageDataset = {
  period: Period;
  profiles: ProfileRead[];
  chats: UsageChat[];
  /** Compression segments that couldn't be read, across all chats. */
  missingSegments: number;
  /** Segments left unread because the refresh reached its limit. */
  segmentsSkipped: number;
  /** No row carried token counts: this Hermes doesn't store usage per session. */
  unsupported: boolean;
  readAt: number;
};

/** Thrown when a newer read has replaced this one. */
export class StaleRead extends Error {
  constructor() {
    super("A newer read replaced this one.");
  }
}

function checkLive(signal?: AbortSignal) {
  if (signal?.aborted) throw new StaleRead();
}

/** A session row's usage counts with every missing one at zero, and which were missing. */
function countsOf(u: ChatUsage | undefined): { counts: Counts; unreported: CountField[] } {
  const counts = zero();
  const unreported: CountField[] = [];
  if (!u) return { counts, unreported };
  for (const f of COUNT_FIELDS) {
    const v = u[f];
    if (v === undefined) unreported.push(f);
    else counts[f] = v;
  }
  return { counts, unreported };
}

function addCounts(a: Counts, b: Counts): Counts {
  const out = zero();
  for (const f of COUNT_FIELDS) out[f] = a[f] + b[f];
  return out;
}

/** Recomputes a chat's totals from its segments. */
function withSegments(c: Omit<UsageChat, "counts" | "unreported" | "noUsage">): UsageChat {
  let counts = zero();
  const unreported = new Set<CountField>();
  for (const s of c.segments) {
    const r = countsOf(s.usage);
    counts = addCounts(counts, r.counts);
    // A segment with no usage recorded at all reports none of its counts.
    (s.usage ? r.unreported : COUNT_FIELDS).forEach((f) => unreported.add(f));
  }
  return { ...c, counts, unreported: [...unreported], noUsage: c.segments.every((s) => !s.usage) };
}

/** Whether a list row carries usage at all, as a Hermes that stores it does (`input_tokens` may be 0, never absent). */
const hasUsageFields = (r: Record<string, unknown>) => "input_tokens" in r || "output_tokens" in r;

/**
 * A chat from a `GET /api/sessions` row. A compressed chat's row has its last segment's id and model, and its first
 * segment's counts (`_lineage_root_id`), with every segment's id in `_lineage_ids`; the rest are read separately.
 */
export function chatOfRow(profile: string, row: unknown, readAt: number): { chat: UsageChat; others: string[] } | undefined {
  const r = obj(row);
  const id = r && nonEmptyText(r.id);
  const started = r && num(r.started_at);
  if (!r || !id || started === undefined) return undefined;
  const root = nonEmptyText(r._lineage_root_id) ?? id;
  const lineage = Array.isArray(r._lineage_ids) ? r._lineage_ids.filter((x): x is string => typeof x === "string") : [];
  const others = lineage.filter((x) => x !== root);
  const chat = withSegments({
    profile,
    id,
    title: nonEmptyText(r.title) ?? nonEmptyText(r.preview)?.slice(0, 80) ?? id,
    source: nonEmptyText(r.source) ?? "unknown",
    startedAt: started * 1000,
    model: nonEmptyText(r.model),
    provider: nonEmptyText(r.billing_provider),
    archived: !!r.archived,
    pinned: !!r.pinned,
    segments: [{ id: root, usage: chatUsageOf(r, readAt) }],
    missing: 0,
  });
  return { chat, others };
}

export function hermesTotalsOf(v: unknown, days: number): HermesTotals | undefined {
  const r = obj(v);
  const t = obj(r?.totals);
  if (!r || !t) return undefined;
  const helpers = (Array.isArray(r.by_task) ? r.by_task : []).flatMap((h): Helper[] => {
    const o = obj(h);
    const task = o && nonEmptyText(o.task);
    if (!o || !task) return [];
    return [
      {
        task,
        input: num(o.input_tokens) ?? 0,
        output: num(o.output_tokens) ?? 0,
        calls: num(o.api_calls) ?? 0,
        estimatedUsd: num(o.estimated_cost) ?? 0,
        models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === "string") : [],
      },
    ];
  });
  return {
    days,
    sessions: num(t.total_sessions),
    input: num(t.total_input),
    output: num(t.total_output),
    cacheRead: num(t.total_cache_read),
    reasoning: num(t.total_reasoning),
    calls: num(t.total_api_calls),
    estimatedUsd: num(t.total_estimated_cost),
    actualUsd: num(t.total_actual_cost),
    helpers,
  };
}

/** Runs `fn` on each item, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export type Progress = { profile: string; read: number };

/**
 * Reads every chat started in `period` in each profile: newest first, until a page passes the period's start, at most
 * `MAX_PAGES` pages. Each page also carries every pinned chat, out of order; those are kept only when in the period.
 * A profile that can't be read is said so and the others are kept. With `signal` aborted, it stops at the next request
 * and throws `StaleRead`.
 */
export async function collectUsage(
  io: UsageIo,
  profiles: string[],
  period: Period,
  { signal, onProgress, now = Date.now }: { signal?: AbortSignal; onProgress?: (p: Progress) => void; now?: () => number } = {},
): Promise<UsageDataset> {
  const chats: UsageChat[] = [];
  const reads: ProfileRead[] = [];
  const toRead: { chat: UsageChat; others: string[] }[] = [];
  let sawUsageFields = false;
  let sawRows = false;
  for (const profile of profiles) {
    checkLive(signal);
    const seen = new Map<string, { chat: UsageChat; others: string[] }>();
    let state: ProfileRead["state"] = "ok";
    let error: string | undefined;
    let read = 0;
    try {
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) {
          state = "capped";
          break;
        }
        const offset = page * PAGE;
        const res = await io.page(profile, offset, PAGE);
        checkLive(signal);
        let passed = false;
        for (const row of res.rows) {
          const r = obj(row);
          if (!r) continue;
          sawRows = true;
          if (hasUsageFields(r)) sawUsageFields = true;
          const c = chatOfRow(profile, r, now());
          if (!c) continue;
          if (!r.pinned && c.chat.startedAt < period.from) passed = true;
          if (!seen.has(c.chat.id)) read++;
          seen.set(c.chat.id, c);
        }
        onProgress?.({ profile, read });
        if (passed || res.rows.length === 0 || offset + PAGE >= res.total) break;
      }
    } catch (e) {
      if (e instanceof StaleRead) throw e;
      checkLive(signal);
      state = "failed";
      error = errorText(e);
    }
    const inPeriod = [...seen.values()].filter(({ chat }) => chat.startedAt >= period.from && chat.startedAt < period.to);
    for (const c of inPeriod) {
      chats.push(c.chat);
      if (c.others.length) toRead.push(c);
    }
    let hermes: ProfileRead["hermes"];
    if (period.days !== undefined) {
      try {
        const totals = hermesTotalsOf(await io.hermesTotals(profile, period.days), period.days);
        hermes = totals ? { state: "ok", totals } : { state: "unsupported" };
      } catch (e) {
        checkLive(signal);
        hermes = statusOf(e) === 404 ? { state: "unsupported" } : { state: "failed", error: errorText(e) };
      }
    }
    reads.push({ profile, state, read, ...(error && { error }), ...(hermes && { hermes }) });
  }

  // The other segments of compressed chats, a few at a time, within the limit.
  let budget = MAX_SEGMENT_READS;
  let missingSegments = 0;
  let segmentsSkipped = 0;
  const index = new Map(chats.map((c, i) => [`${c.profile}\n${c.id}`, i]));
  await eachLimited(toRead, 4, async ({ chat, others }) => {
    const segments = [...chat.segments];
    let missing = 0;
    for (const id of others) {
      checkLive(signal);
      if (budget <= 0) {
        missing++;
        segmentsSkipped++;
        continue;
      }
      budget--;
      try {
        const row = await io.session(chat.profile, id);
        checkLive(signal);
        segments.push({ id, usage: chatUsageOf(row, now()) });
      } catch (e) {
        if (e instanceof StaleRead) throw e;
        checkLive(signal);
        missing++;
      }
    }
    missingSegments += missing;
    chats[index.get(`${chat.profile}\n${chat.id}`)!] = withSegments({ ...chat, segments, missing });
  });
  checkLive(signal);
  return { period, profiles: reads, chats, missingSegments, segmentsSkipped, unsupported: sawRows && !sawUsageFields, readAt: now() };
}

// --- Periods and days ---------------------------------------------------------------------------------------------

export type RangeChoice = { kind: "rolling"; days: number } | { kind: "custom"; from: string; to: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant a calendar day starts in `zone` (`2026-11-03`), or undefined for a date that isn't one. */
export function dayStart(date: string, zone: string): number | undefined {
  const m = DATE.exec(date);
  if (!m || !knownZone(zone)) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(wall).getUTCDate() !== Number(m[3])) return undefined;
  return instantsOf(zone, wall)[0];
}

/** The day after `date` (`2026-11-03` → `2026-11-04`). */
export function nextDate(date: string): string {
  const m = DATE.exec(date)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

/** The calendar day `ms` falls on in `zone`. */
export const dayIn = (zone: string, ms: number) => isoIn(zone, ms, false).slice(0, 10);

/**
 * The period a choice stands for. Rolling: the last `days` × 24 hours, as Hermes's own sums count them. Custom: from
 * the start of the first day to the end of the last, on `zone`'s clock. Undefined, with why, when it isn't a period.
 */
export function periodOf(choice: RangeChoice, zone: string, now: number): Period | { error: string } {
  if (choice.kind === "rolling") return { from: now - choice.days * DAY, to: now + 1, days: choice.days };
  const from = dayStart(choice.from, zone);
  const end = DATE.test(choice.to) ? dayStart(nextDate(choice.to), zone) : undefined;
  if (from === undefined) return { error: "Pick a start date." };
  if (end === undefined) return { error: "Pick an end date." };
  if (end <= from) return { error: "The end date is before the start date." };
  return { from, to: end };
}

// --- Filters ------------------------------------------------------------------------------------------------------

/** `NO_PROJECT`: chats in no project. `NO_MODEL`: chats Hermes recorded no model for. */
export const NO_PROJECT = "\u0000none";
export const NO_MODEL = "\u0000none";

export type UsageFilters = { model?: string; project?: string };
/** Which projects a chat of the shown profile is in, by id; undefined for another profile's chat. */
export type ProjectsOf = (chat: UsageChat) => Set<string> | undefined;

export function filterChats(chats: UsageChat[], f: UsageFilters, projectsOf: ProjectsOf): UsageChat[] {
  return chats.filter((c) => {
    if (f.model !== undefined && (c.model ?? NO_MODEL) !== f.model) return false;
    if (f.project !== undefined) {
      const of = projectsOf(c);
      // Project membership is known only for the shown profile's chats.
      if (!of) return false;
      if (f.project === NO_PROJECT ? of.size > 0 : !of.has(f.project)) return false;
    }
    return true;
  });
}

// --- Cost ---------------------------------------------------------------------------------------------------------

export const COST_KINDS = ["actual", "estimated", "partial", "included", "unknown"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const COST_KIND_LABEL: Record<CostKind, string> = {
  actual: "Reported by the provider",
  estimated: "Estimated by Hermes",
  partial: "At least (latest call unpriced)",
  included: "Included in a subscription",
  unknown: "Unknown",
};

export type CostTally = {
  kinds: Record<CostKind, { chats: number; tokens: number; usd: number }>;
  /** Tokens in segments that made model calls. */
  tokens: number;
  /**
   * Chats with usage not in any figure here: a segment that couldn't be read, or one with no usage recorded at all,
   * which can't show that it made no calls.
   */
  incomplete: number;
};

const segmentTokens = (u: ChatUsage) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
const madeCalls = (u: ChatUsage | undefined): u is ChatUsage => !!u && (segmentTokens(u) > 0 || (u.calls ?? 0) > 0);

/** The kind and dollars of one segment's recorded cost. */
function kindOf(c: Cost): { kind: CostKind; usd: number } {
  switch (c.kind) {
    case "actual":
    case "estimated":
    case "partial":
      return { kind: c.kind, usd: c.usd };
    case "included":
      return { kind: "included", usd: 0 };
    case "unknown":
      return { kind: "unknown", usd: 0 };
  }
}

/**
 * The recorded cost of `chats`, by how Hermes got it. Each segment that made model calls counts under its own kind;
 * a segment without calls has nothing to price. A compressed chat can count under two kinds.
 */
export function tallyCost(chats: UsageChat[]): CostTally {
  const kinds = Object.fromEntries(COST_KINDS.map((k) => [k, { chats: 0, tokens: 0, usd: 0 }])) as CostTally["kinds"];
  let tokens = 0;
  let incomplete = 0;
  for (const chat of chats) {
    if (chat.missing || chat.segments.some((s) => !s.usage)) incomplete++;
    const counted = new Set<CostKind>();
    for (const s of chat.segments) {
      if (!madeCalls(s.usage)) continue;
      const { kind, usd: dollars } = kindOf(s.usage.cost);
      const t = segmentTokens(s.usage);
      kinds[kind].tokens += t;
      kinds[kind].usd += dollars;
      tokens += t;
      if (!counted.has(kind)) kinds[kind].chats++, counted.add(kind);
    }
  }
  return { kinds, tokens, incomplete };
}

export const recordedUsd = (t: CostTally) => t.kinds.actual.usd + t.kinds.estimated.usd + t.kinds.partial.usd;

/** The share of tokens whose cost Hermes recorded in full: reported, estimated or included. 1 when nothing was used. */
export function coverage(t: CostTally): number {
  if (!t.tokens) return 1;
  return (t.kinds.actual.tokens + t.kinds.estimated.tokens + t.kinds.included.tokens) / t.tokens;
}

/**
 * A tally in a few characters, never as a bill: `~` when any of it is Hermes's estimate, `+` when some usage has no
 * price or only part of one, so the true cost is higher. Its detail says so in words.
 */
export function tallyLabel(
  t: CostTally,
  { partial = false }: { /** Chats that should be here weren't read at all: a profile failed, or past the page limit. */ partial?: boolean } = {},
): { short: string; detail: string; kind: CostKind | "mixed" | "none" } {
  const used = COST_KINDS.filter((k) => t.kinds[k].tokens > 0 || t.kinds[k].chats > 0);
  const short = t.incomplete > 0 || partial;
  const unread = [
    t.incomplete
      ? `${t.incomplete.toLocaleString()} ${t.incomplete === 1 ? "chat has" : "chats have"} usage that couldn't be read or wasn't recorded: its cost isn't here at all, and the share covered is of the usage read.`
      : "",
    partial ? "Some chats couldn't be read at all, so their cost isn't here either, and the share covered is of the usage read." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tail = unread && ` ${unread}`;
  if (!used.length) return short ? { short: "?", detail: `Nothing read made model calls.${tail}`, kind: "none" } : { short: "—", detail: "No model calls, so nothing to price.", kind: "none" };
  if (used.length === 1 && used[0] === "included" && !short)
    return { short: "Included", detail: "Hermes counts all of it as included in a subscription, and recorded no charge.", kind: "included" };
  if (used.length === 1 && used[0] === "unknown") return { short: "Cost unknown", detail: `Hermes recorded no cost for any of it.${tail}`, kind: "unknown" };
  const dollars = recordedUsd(t);
  // An estimate is an estimate even when it comes to $0.
  const approx = t.kinds.estimated.chats + t.kinds.partial.chats > 0 ? "~" : "";
  const lower = t.kinds.partial.tokens + t.kinds.unknown.tokens > 0 || short;
  const pct = Math.round(coverage(t) * 100);
  const detail = [
    `Recorded by Hermes, not a bill: ${pct}% of the tokens${short ? " read" : ""} have a cost Hermes recorded in full.`,
    approx && "Part of it is Hermes's own estimate, so your provider's bill may differ.",
    lower && "Some usage has no price, or only part of one, so the true cost is higher.",
    "A call Hermes couldn't price leaves no mark when a later one in the same chat could be.",
    unread,
  ]
    .filter(Boolean)
    .join(" ");
  return { short: `${approx}${usd(dollars)}${lower ? "+" : ""}`, detail, kind: used.length === 1 ? used[0] : "mixed" };
}

/** A chat's cost: as its own usage shows it for a chat in one segment, else as a tally of its segments. */
export function chatCost(chat: UsageChat): { short: string; detail: string; kind: CostKind | "mixed" | "none" } {
  const used = chat.segments.filter((s) => madeCalls(s.usage));
  if (used.length === 1 && chat.segments.length === 1 && !chat.missing) {
    const c = used[0].usage!.cost;
    return { ...costLabel(c), kind: kindOf(c).kind };
  }
  return tallyLabel(tallyCost([chat]));
}

// --- Totals and breakdowns ----------------------------------------------------------------------------------------

export type Totals = {
  chats: number;
  counts: Counts;
  /** For each count, how many chats with usage didn't report it. */
  unreported: Partial<Record<CountField, number>>;
  noUsage: number;
  /** Chats short of segments that couldn't be read. */
  partialChats: number;
  /** Chats whose total tokens are short: a segment unread, or input, cache or output not reported. */
  totalShort: number;
  cost: CostTally;
};

/**
 * No segment of the chat reported this count, so nothing is known of it. A count some segments reported is known in
 * part: their sum, short by the rest (`unreported`).
 */
export const reportedNowhere = (c: UsageChat, f: CountField) => c.segments.every((s) => !s.usage || s.usage[f] === undefined);

/** A chat's total tokens are short of the truth: a segment unread, or a part of the total not reported. */
export const chatTotalShort = (c: UsageChat) => c.missing > 0 || c.unreported.some((f) => f !== "reasoning" && f !== "calls");

export function totalsOf(chats: UsageChat[]): Totals {
  let counts = zero();
  const unreported: Partial<Record<CountField, number>> = {};
  let noUsage = 0;
  let partialChats = 0;
  let totalShort = 0;
  for (const c of chats) {
    if (chatTotalShort(c)) totalShort++;
    counts = addCounts(counts, c.counts);
    for (const f of c.unreported) unreported[f] = (unreported[f] ?? 0) + 1;
    if (c.noUsage) noUsage++;
    if (c.missing) partialChats++;
  }
  return { chats: chats.length, counts, unreported, noUsage, partialChats, totalShort, cost: tallyCost(chats) };
}

export type Dimension = "model" | "source" | "profile" | "project" | "day";

export const DIMENSION_LABEL: Record<Dimension, string> = { model: "Model", source: "Where it started", profile: "Profile", project: "Project", day: "Day" };

/** Hermes's `sessions.source` names, as this app says them (GLOSSARY.md "Source"). */
const SOURCE_NAMES: Record<string, string> = {
  gui: "Hermes Chat",
  "hermes-chat": "Hermes Chat",
  desktop: "Hermes desktop app",
  cli: "Command line",
  tui: "Command line",
  telegram: "Telegram",
  discord: "Discord",
  matrix: "Matrix",
  signal: "Signal",
  cron: "Scheduled jobs",
  webui: "Web dashboard",
  api_server: "API server",
  oneshot: "One-off calls",
  subagent: "Subagents",
};
export const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;

export type Group = { key: string; label: string; chats: UsageChat[]; totals: Totals };

export type GroupContext = { zone: string; projectsOf: ProjectsOf; projectName: (id: string) => string | undefined };

function keysOf(c: UsageChat, dim: Dimension, ctx: GroupContext): { key: string; label: string }[] {
  switch (dim) {
    case "model":
      return [{ key: c.model ?? NO_MODEL, label: c.model ?? "No model recorded" }];
    case "source":
      // `gui` and `hermes-chat`, `cli` and `tui`, are the same place.
      return [{ key: sourceName(c.source), label: sourceName(c.source) }];
    case "profile":
      return [{ key: c.profile, label: c.profile }];
    case "day": {
      const d = dayIn(ctx.zone, c.startedAt);
      return [{ key: d, label: d }];
    }
    case "project": {
      const of = ctx.projectsOf(c);
      if (!of) return [{ key: "\u0000other", label: "Another profile (projects unknown)" }];
      const named = [...of].flatMap((id) => {
        const name = ctx.projectName(id);
        return name ? [{ key: id, label: name }] : [];
      });
      return named.length ? named : [{ key: NO_PROJECT, label: "No project" }];
    }
  }
}

/** `chats` grouped by `dim`. A chat in two projects is in both groups, so project groups can add up to more. */
export function groupBy(chats: UsageChat[], dim: Dimension, ctx: GroupContext): Group[] {
  const groups = new Map<string, { label: string; chats: UsageChat[] }>();
  for (const c of chats)
    for (const { key, label } of keysOf(c, dim, ctx)) {
      const g = groups.get(key) ?? { label, chats: [] };
      g.chats.push(c);
      groups.set(key, g);
    }
  return [...groups].map(([key, g]) => ({ key, label: g.label, chats: g.chats, totals: totalsOf(g.chats) }));
}

export type SortKey = "label" | "chats" | CountField | "total" | "cost" | "coverage" | "started";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

function groupValue(g: Group, key: SortKey): number | string {
  switch (key) {
    case "label":
      return g.label.toLowerCase();
    case "chats":
      return g.totals.chats;
    case "total":
      return totalOf(g.totals.counts);
    case "cost":
      return recordedUsd(g.totals.cost);
    case "coverage":
      return coverage(g.totals.cost);
    case "started":
      return 0;
    default:
      return g.totals.counts[key];
  }
}

function chatValue(c: UsageChat, key: SortKey): number | string {
  switch (key) {
    case "label":
      return c.title.toLowerCase();
    case "chats":
      return 1;
    case "total":
      return totalOf(c.counts);
    case "cost":
      return recordedUsd(tallyCost([c]));
    case "coverage":
      return coverage(tallyCost([c]));
    case "started":
      return c.startedAt;
    default:
      return c.counts[key];
  }
}

const compare = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortGroups(groups: Group[], s: Sort): Group[] {
  const sign = s.dir === "asc" ? 1 : -1;
  return [...groups].sort((a, b) => sign * compare(groupValue(a, s.key), groupValue(b, s.key)) || compare(a.label, b.label));
}

export function sortChats(chats: UsageChat[], s: Sort): UsageChat[] {
  const sign = s.dir === "asc" ? 1 : -1;
  return [...chats].sort((a, b) => sign * compare(chatValue(a, s.key), chatValue(b, s.key)) || b.startedAt - a.startedAt);
}

// --- The cross-check with Hermes's own sums --------------------------------------------------------------------------

/**
 * How the chats read for a profile compare with Hermes's own sums for the same rolling period. Hermes counts every
 * stored session started in it: subagent runs and compression segments too, which no chat list shows as chats.
 */
export type CrossCheck = {
  profile: string;
  hermes: HermesTotals;
  chats: number;
  /** Segments counted in the chats here, compressed chats' included. */
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
  /** Every chat in the period was read, every segment of it, with every count compared: the figures compare. */
  complete: boolean;
  /** Why they don't, when they don't. */
  incomparable?: "chats" | "segments" | "counts";
};

/** Hermes's own sums for each profile that gave them, beside its chats' when all of them were read. */
export function crossCheck(data: UsageDataset): CrossCheck[] {
  return data.profiles.flatMap((p) => {
    if (p.hermes?.state !== "ok") return [];
    const mine = data.chats.filter((c) => c.profile === p.profile);
    const t = totalsOf(mine);
    // A missing segment or count would show as a difference Hermes's own figures don't have.
    const compared: CountField[] = ["input", "output", "cacheRead", "calls"];
    const incomparable =
      p.state !== "ok" ? ("chats" as const) : mine.some((c) => c.missing) ? ("segments" as const) : mine.some((c) => c.unreported.some((f) => compared.includes(f))) ? ("counts" as const) : undefined;
    return [
      {
        profile: p.profile,
        hermes: p.hermes.totals,
        chats: mine.length,
        sessions: mine.reduce((n, c) => n + c.segments.length, 0),
        input: t.counts.input,
        output: t.counts.output,
        cacheRead: t.counts.cacheRead,
        calls: t.counts.calls,
        complete: !incomparable,
        ...(incomparable && { incomparable }),
      },
    ];
  });
}

// --- CSV ----------------------------------------------------------------------------------------------------------

/**
 * One CSV field: quoted when it holds a comma, quote or line break, and a text that a spreadsheet would run as a
 * formula (`=`, `+`, `-`, `@`, tab, carriage return first) starts with `'`.
 */
export function csvField(v: string | number | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "profile",
  "chat_id",
  "title",
  "source",
  "started_at_utc",
  "started_at_local",
  "time_zone",
  "model_last_used",
  "billing_provider",
  "projects",
  "archived",
  "input_tokens_uncached",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens_in_output",
  "total_tokens",
  "model_calls",
  "recorded_cost_usd",
  "cost_kind",
  "cost_label",
  "usage_source",
  "coverage",
] as const;

function coverageLabel(c: UsageChat): string {
  if (!c.missing && !c.segments.some((s) => madeCalls(s.usage))) return c.noUsage ? "no usage recorded" : "no model calls recorded";
  const notes: string[] = [];
  if (c.missing) notes.push(`partial: ${c.missing} of ${c.segments.length + c.missing} segments unreadable`);
  if (c.unreported.length) notes.push(`not reported: ${c.unreported.join(" ")}`);
  const cost = tallyCost([c]);
  if (cost.kinds.partial.tokens) notes.push("cost is a lower bound");
  if (cost.kinds.unknown.tokens) notes.push("cost unknown for some usage");
  return notes.length ? notes.join("; ") : "complete";
}

/** The chats as CSV, one row each, with where each figure came from and how complete it is. */
export function usageCsv(chats: UsageChat[], zone: string, projectNames: (c: UsageChat) => string[] | undefined): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const c of chats) {
    const cost = chatCost(c);
    const t = tallyCost([c]);
    const names = projectNames(c);
    const cells: (string | number | undefined)[] = [
      c.profile,
      c.id,
      c.title,
      c.source,
      new Date(c.startedAt).toISOString(),
      isoIn(zone, c.startedAt),
      zone,
      c.model,
      c.provider,
      names === undefined ? "unknown (another profile)" : names.join("; "),
      c.archived ? "yes" : "no",
      ...(["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const).map((f) => (reportedNowhere(c, f) ? undefined : c.counts[f])),
      totalOf(c.counts),
      reportedNowhere(c, "calls") ? undefined : c.counts.calls,
      cost.kind === "none" || cost.kind === "unknown" || cost.kind === "included" ? undefined : Number(recordedUsd(t).toFixed(8)),
      cost.kind,
      cost.short,
      c.segments.length + c.missing > 1 ? `Hermes stored session totals, ${c.segments.length + c.missing} compression segments added` : "Hermes stored session totals",
      coverageLabel(c),
    ];
    lines.push(cells.map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export const csvFileName = (from: number, to: number, zone: string) => `hermes-usage-${dayIn(zone, from)}-to-${dayIn(zone, to - 1)}.csv`;

/** A count in a few characters, for tables. */
export const short = shortTokens;
