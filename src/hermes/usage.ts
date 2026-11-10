// Token usage and cost, as Hermes counts them: research doc "Token usage and cost", ADR 0008.
//
// Two sources, never added together:
// - Per reply: Hermes's live session counters (`server._get_usage`, on `message.complete`, `session.info` and a live
//   `session.resume`) are running totals since the session's agent was built. A reply's usage is how far they moved
//   during its turn. Hermes reports no cost there.
// - Per chat: the stored session row (dashboard REST `GET /api/sessions/{id}`), which Hermes keeps for every model
//   call in the chat from any client, across model switches and retries, with its own cost figure and how it got it.
//   Each read replaces the last, so nothing is counted twice.
// This app keeps no price list: a cost shows only as Hermes recorded it, labelled the way Hermes labelled it.

import { sameFields } from "./model";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * Hermes's running counters for one live session: every model call since its agent was built. `prompt`: all the input,
 * uncached plus read from or written to the provider's prompt cache. `input`: the uncached part, or undefined when
 * Hermes's figure can't be trusted (below). `reasoning` is part of `output`. `model`: the model of the latest call.
 */
export type UsageCounters = { prompt: number; input?: number; output: number; reasoning: number; calls: number; model?: string };

/**
 * One reply's usage: what Hermes's counters moved by during its turn, over every model call the turn made. `input` and
 * `cache` split `prompt` into uncached and cached (read or written; the live feed doesn't tell the two apart), and are
 * both undefined when that split isn't known.
 */
export type ReplyUsage = { prompt: number; input?: number; cache?: number; output: number; reasoning: number; calls: number; model?: string };

export const ZERO_COUNTERS: UsageCounters = { prompt: 0, input: 0, output: 0, reasoning: 0, calls: 0 };

/**
 * The counters in a `usage` object from `_get_usage`, or undefined if it isn't one. An empty object is a session whose
 * agent isn't built yet: all zero. Hermes sends `input` as the uncached part of `prompt`, except that while that part is
 * still zero it sends `prompt` instead (`g("session_input_tokens", "session_prompt_tokens")`). So `input` equal to a
 * non-zero `prompt` while Hermes saw cache reads (it sends `cache_hit_pct`, perhaps rounded to 0, only then) means none
 * of it was uncached. Without cache reads it could be all uncached or all cache writes, so it is left unknown.
 */
export function countersOf(v: unknown): UsageCounters | undefined {
  const u = obj(v);
  if (!u) return undefined;
  const sent = num(u.input) ?? 0;
  const prompt = num(u.prompt) ?? sent;
  const model = typeof u.model === "string" && u.model ? u.model : undefined;
  const input = sent !== prompt || prompt === 0 ? sent : num(u.cache_hit_pct) !== undefined ? 0 : undefined;
  return {
    prompt,
    ...(input !== undefined && { input }),
    output: num(u.output) ?? 0,
    reasoning: num(u.reasoning) ?? 0,
    calls: num(u.calls) ?? 0,
    ...(model && { model }),
  };
}

/** Counters that only ever grow while the session's agent lives. */
const RUNNING = ["prompt", "output", "reasoning", "calls"] as const;

/** A reply's usage as this app saved it, or undefined if it isn't one. */
export function replyUsageOf(v: unknown): ReplyUsage | undefined {
  const u = obj(v);
  if (!u || !RUNNING.every((k) => num(u[k]) !== undefined)) return undefined;
  const [input, cache] = [num(u.input), num(u.cache)];
  const split = input !== undefined && cache !== undefined && input + cache === u.prompt;
  const model = typeof u.model === "string" && u.model ? u.model : undefined;
  return {
    prompt: u.prompt as number,
    ...(split && { input, cache }),
    output: u.output as number,
    reasoning: u.reasoning as number,
    calls: u.calls as number,
    ...(model && { model }),
  };
}

/**
 * The newer of two reads of a chat's usage. Hermes's stored counts only ever grow, so a read with fewer model calls than
 * the one shown was taken before it, and loses.
 */
export function newerChatUsage(shown: ChatUsage | undefined, read: ChatUsage | undefined): ChatUsage | undefined {
  if (!read) return shown;
  if (shown && (read.calls ?? 0) < (shown.calls ?? 0)) return shown;
  return read;
}

/**
 * `newerChatUsage` for a list refresh, which reads every chat's totals in passing: a read with the same totals keeps the
 * one shown, with its read time, so a refresh that finds nothing new leaves the chat as it was.
 */
export function newerListedUsage(shown: ChatUsage | undefined, read: ChatUsage | undefined): ChatUsage | undefined {
  return shown && read && sameTotals(shown, read) ? shown : newerChatUsage(shown, read);
}

function sameTotals(a: ChatUsage, b: ChatUsage): boolean {
  const { readAt: _a, cost: costA, ...countsA } = a;
  const { readAt: _b, cost: costB, ...countsB } = b;
  return sameFields(countsA, countsB) && sameFields(costA, costB);
}

/**
 * A reply's usage: the counters at the end of its turn less those at its start. A running counter that went down means
 * Hermes built the session's agent again, which starts its counters from zero, so the end counters are the reply's own.
 * The uncached part is split out only when both ends know theirs and it fits. Undefined when the turn made no call.
 */
export function replyUsage(start: UsageCounters, end: UsageCounters): ReplyUsage | undefined {
  const restarted = RUNNING.some((k) => end[k] < start[k]);
  const from = restarted ? ZERO_COUNTERS : start;
  const [prompt, output, reasoning, calls] = RUNNING.map((k) => end[k] - from[k]);
  if (prompt === 0 && output === 0 && reasoning === 0 && calls === 0) return undefined;
  const input = end.input !== undefined && from.input !== undefined ? end.input - from.input : undefined;
  const split = input !== undefined && input >= 0 && input <= prompt;
  return { prompt, ...(split && { input, cache: prompt - input }), output, reasoning, calls, ...(end.model && { model: end.model }) };
}

/**
 * What a chat cost, as Hermes recorded it. Every kind covers only the calls Hermes could price: Hermes keeps one status,
 * its latest call's, so an earlier call it couldn't price adds nothing and leaves no mark. `actual`: the provider
 * reported every priced call's cost. `estimated`: Hermes worked some or all of it out from prices it holds (`source`
 * says where from). `partial`: as estimated, and the latest call couldn't be priced, so the chat cost at least this.
 * `included`: the model used last is in a subscription, and Hermes recorded no charge. `unknown`: no price for the
 * latest call and nothing recorded before it (`unpriced`), or no cost recorded at all (`unrecorded`).
 */
export type Cost =
  | { kind: "actual"; usd: number }
  | { kind: "estimated" | "partial"; usd: number; source?: string; pricingVersion?: string }
  | { kind: "included" }
  | { kind: "unknown"; why: "unpriced" | "unrecorded" };

/**
 * A chat's usage over its whole life, from Hermes's stored session row. A count Hermes didn't send is undefined, not
 * zero. Hermes's helper tasks (titling, background review) are kept apart from it and aren't included.
 */
export type ChatUsage = {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  calls?: number;
  cost: Cost;
  /** When Hermes was read, Unix ms. */
  readAt: number;
};

/** The usage in a stored session row, or undefined when the row has no token counts at all. */
export function chatUsageOf(row: unknown, readAt: number): ChatUsage | undefined {
  const r = obj(row);
  if (!r) return undefined;
  const counts = {
    input: num(r.input_tokens),
    cacheRead: num(r.cache_read_tokens),
    cacheWrite: num(r.cache_write_tokens),
    output: num(r.output_tokens),
    reasoning: num(r.reasoning_tokens),
    calls: num(r.api_call_count),
  };
  if (counts.input === undefined && counts.output === undefined) return undefined;
  const defined = Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== undefined));
  return { ...defined, cost: costOf(r), readAt };
}

/**
 * The cost in a stored session row. `estimated_cost_usd` sums every call Hermes priced, the provider's own figures
 * included; `actual_cost_usd` sums only the provider's; `cost_status` is the latest call's. So the total is called
 * actual only when the provider's figures are all of the priced part, and an unpriced latest call makes it a lower
 * bound. Nothing in the row tells whether an earlier call went unpriced; the labels say so.
 */
function costOf(r: Record<string, unknown>): Cost {
  const status = typeof r.cost_status === "string" ? r.cost_status : undefined;
  const estimated = num(r.estimated_cost_usd);
  const actual = num(r.actual_cost_usd);
  const source = typeof r.cost_source === "string" && r.cost_source && r.cost_source !== "none" ? r.cost_source : undefined;
  const pricingVersion = typeof r.pricing_version === "string" && r.pricing_version ? r.pricing_version : undefined;
  const from = { ...(source && { source }), ...(pricingVersion && { pricingVersion }) };
  if (status === "included" && !estimated) return { kind: "included" };
  if (status === "actual" && actual !== undefined && estimated !== undefined && Math.abs(actual - estimated) < 1e-9) return { kind: "actual", usd: actual };
  if (estimated !== undefined && (status === "estimated" || status === "actual" || status === "included")) return { kind: "estimated", usd: estimated, ...from };
  if (status === "unknown") return estimated ? { kind: "partial", usd: estimated, ...from } : { kind: "unknown", why: "unpriced" };
  return { kind: "unknown", why: "unrecorded" };
}

/** Where Hermes's prices came from (`agent/usage_pricing.py` `CostSource` at `bf0203a`). */
const SOURCE_LABEL: Record<string, string> = {
  provider_cost_api: "the provider's cost API",
  provider_generation_api: "the provider's per-request billing",
  provider_models_api: "the provider's published model prices",
  official_docs_snapshot: "a saved copy of the provider's price list",
  user_override: "prices set in your Hermes config",
  custom_contract: "your contract prices",
};

/** A US dollar amount with enough decimals to show its first two significant digits: $0.00096, $0.026, $5.12. */
export function usd(n: number): string {
  if (n === 0) return "$0.00";
  const decimals = Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(decimals)}`;
}

/** A token count in a few characters: 950, 1.2k, 42.3k, 145k, 1.2M. */
export function tokens(n: number): string {
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 100_000) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${trim((n / 1e6).toFixed(1))}M`;
}

/** What every recorded cost leaves out, since Hermes keeps only its latest call's pricing status. */
const UNPRICED_NOTE = "A call Hermes couldn't price isn't counted.";

/** The cost in a few characters, and in a sentence saying how Hermes got it. */
export function costLabel(c: Cost): { short: string; detail: string } {
  switch (c.kind) {
    case "actual":
      return { short: usd(c.usd), detail: `Reported to Hermes by the provider, for each call it priced. ${UNPRICED_NOTE}` };
    case "estimated":
    case "partial": {
      // Hermes keeps where its latest call's price came from, not each call's: for a partial cost that is the call it
      // couldn't price, so none is named.
      const version = c.pricingVersion ? ` (prices ${c.pricingVersion})` : "";
      const from = c.source ? ` Its latest call was priced from ${SOURCE_LABEL[c.source] ?? c.source}${version}.` : "";
      return c.kind === "estimated"
        ? { short: `~${usd(c.usd)}`, detail: `Estimated by Hermes.${from} Your provider's bill may differ. ${UNPRICED_NOTE}` }
        : { short: `~${usd(c.usd)}+`, detail: "At least this: Hermes estimated the calls it could price, and had no price for the latest one." };
    }
    case "included":
      return {
        short: "Included",
        detail: `Hermes counts the model this chat used last as included in a subscription, and recorded no charge. ${UNPRICED_NOTE}`,
      };
    case "unknown":
      return c.why === "unpriced"
        ? { short: "Cost unknown", detail: "Hermes has no price for the model this chat used last." }
        : { short: "Cost unknown", detail: "Hermes hasn't recorded a cost for this chat." };
  }
}

/** All the tokens a chat's or reply's model calls took in and gave out. Undefined when a part of it isn't known. */
export function totalTokens(u: Pick<ChatUsage, "input" | "cacheRead" | "cacheWrite" | "output">): number | undefined {
  const parts = [u.input, u.cacheRead, u.cacheWrite, u.output];
  return parts.every((p) => p !== undefined) ? parts.reduce((a, b) => a! + b!, 0) : undefined;
}
