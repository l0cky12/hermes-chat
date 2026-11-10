// The context inspector's reading of Hermes (ADR 0025): what fills a chat's context window, and the compactions Hermes
// stored for it. Only what Hermes reports: the total keeps Hermes's own provenance, the categories are always Hermes's
// estimates, and a compaction is known only by the summary row Hermes stored and the rows it marked compacted. Nothing
// here is kept on this computer.

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * Where Hermes's total came from (`agent/context_breakdown.py` at `bf0203a`): the provider's count for the latest call,
 * that count plus Hermes's estimate of what was added since, or Hermes's estimate alone. Any other value is `other`.
 */
export type ContextSource = "provider_usage" | "provider_usage_plus_estimate" | "local_estimate" | "other";

/** How sure a figure is: exact as the provider counted it, estimated (in part) by Hermes, or not reported. */
export type Certainty = "exact" | "estimated" | "unavailable";

export const SOURCE_NOTE: Record<ContextSource, { certainty: Certainty; label: string; note: string }> = {
  provider_usage: { certainty: "exact", label: "Exact", note: "The provider's own count for the latest model call." },
  provider_usage_plus_estimate: {
    certainty: "estimated",
    label: "Partly estimated",
    note: "The provider's count for the latest model call, plus Hermes's estimate of the messages added since.",
  },
  local_estimate: { certainty: "estimated", label: "Estimated", note: "Hermes's own estimate; the provider hasn't counted this yet." },
  other: { certainty: "estimated", label: "Not labelled", note: "Hermes didn't say how it counted this." },
};

/** One category Hermes splits the window into. Always Hermes's estimate, about four characters a token. */
export type ContextPart = { id: string; label: string; tokens: number; color?: string };

/**
 * An instruction file Hermes considered for the chat (`agent/context_file_sources.py`): its path on the server, its
 * estimated size, and whether it was read in. `status`: Hermes's word for why (`FILE_STATUS`).
 */
export type ContextFile = { label: string; path: string; tokens: number; loaded: boolean; status: string };

/** What Hermes's file statuses mean, from `_STATUS_DISPLAY` at `bf0203a`. */
export const FILE_STATUS: Record<string, string> = {
  loaded: "Read in",
  truncated: "Read in, cut short: it's over Hermes's size limit for instruction files",
  flagged: "Read in, though it matched a prompt-injection pattern; review the file",
  shadowed: "Not read: a higher-priority kind of instruction file wins",
  blocked: "Not read: blocked by Hermes's prompt-injection scan",
  empty: "Not read: the file is empty",
  unreadable: "Not read: Hermes couldn't read it",
  suppressed: "Not read: the chat's folder fell back to Hermes's own install folder",
};

/**
 * A reading of `session.context_breakdown`. `measuredAt`: when Hermes answered (Unix ms); Hermes doesn't timestamp
 * its measure. `used`/`max`/`percent` are Hermes's total, undefined when it has none. `parts` and `files` are empty
 * before Hermes builds the chat's agent (`built` false), when it has nothing to split.
 */
export type ContextReading = {
  measuredAt: number;
  model?: string;
  used?: number;
  max?: number;
  percent?: number;
  source: ContextSource;
  parts: ContextPart[];
  estimatedTotal?: number;
  files: ContextFile[];
  built: boolean;
};

const SOURCES = new Set<string>(["provider_usage", "provider_usage_plus_estimate", "local_estimate"]);

/** A category colour the swatch may use. A `url()` would load from anywhere. */
const SWATCH = /^(?:var\(--[\w-]+\)|#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8}))$/i;

/** A `session.context_breakdown` answer, as far as it says anything. Malformed rows are left out, never guessed at. */
export function readingOf(res: unknown, measuredAt: number): ContextReading {
  const r = obj(res) ?? {};
  const parts = (Array.isArray(r.categories) ? r.categories : []).flatMap((v): ContextPart[] => {
    const p = obj(v);
    const tokens = num(p?.tokens);
    return p && typeof p.id === "string" && typeof p.label === "string" && tokens !== undefined
      ? [{ id: p.id, label: p.label, tokens, ...(typeof p.color === "string" && SWATCH.test(p.color) && { color: p.color }) }]
      : [];
  });
  const files = (Array.isArray(r.context_files) ? r.context_files : []).flatMap((v): ContextFile[] => {
    const f = obj(v);
    return f && typeof f.path === "string" && f.path
      ? [{ label: typeof f.label === "string" && f.label ? f.label : f.path, path: f.path, tokens: num(f.est_tokens) ?? 0, loaded: f.loaded === true, status: typeof f.status === "string" ? f.status : "" }]
      : [];
  });
  const max = num(r.context_max) || undefined;
  const used = max ? num(r.context_used) : undefined;
  const source = typeof r.context_source === "string" && SOURCES.has(r.context_source) ? (r.context_source as ContextSource) : r.context_estimated === true ? "local_estimate" : "other";
  const estimatedTotal = num(r.estimated_total);
  return {
    measuredAt,
    ...(typeof r.model === "string" && r.model && { model: r.model }),
    ...(max && used !== undefined && { used, max, percent: num(r.context_percent) ?? Math.round((used / max) * 100) }),
    source,
    parts,
    ...(estimatedTotal && { estimatedTotal }),
    files,
    built: parts.length > 0 || !!estimatedTotal,
  };
}

/** What each of Hermes's categories holds, in words, by its id. Hermes's own label is shown beside it. */
export const PART_HINT: Record<string, string> = {
  system_prompt: "Hermes's own instructions to the model",
  tool_definitions: "Descriptions of the tools the model can call",
  rules: "Instruction files such as AGENTS.md (listed below)",
  skills: "The list of skills Hermes can load",
  mcp: "Tools from MCP servers",
  subagent_definitions: "Tools for starting subagents",
  memory: "What Hermes remembers, read in when the chat started",
  conversation: "The messages, with tool calls and what they returned",
};

/** Hermes's categories that it leaves out when they hold nothing, and what that means. */
export const OPTIONAL_PARTS: Record<string, string> = { rules: "Instruction files", skills: "Skills", mcp: "MCP tools", subagent_definitions: "Subagent tools", memory: "Memory" };

// ---- Compactions ----

/** A row of dashboard REST `GET /api/sessions/{id}/messages?include_compacted=true`, as far as compactions read it. */
export type CompactionRow = {
  id: number;
  role?: string;
  content?: unknown;
  timestamp?: number | null;
  active?: number | boolean | null;
  compacted?: number | boolean | null;
  _compressed_summary?: number | boolean | null;
  message_uid?: string | null;
};

/**
 * One compaction Hermes stored: its summary row (`rowId`), when Hermes stored it (`at`, Unix ms), the summary the model
 * reads in place of what it took out, and how many earlier messages it took out of what the model reads (`removed`).
 * `inContext`: the summary is still what the model reads; a later compaction can take an earlier summary out too.
 */
export type Compaction = { rowId: number; at?: number; summary: string; removed: number; inContext: boolean };

/**
 * A chat's compaction history. `events`: oldest first. `unmarked`: messages Hermes marked compacted after the last
 * summary it stored, or with no summary row at all (older Hermes versions stored none): how many, and the stored time
 * of the newest of them. `truncated`: the chat has more rows than were read.
 */
export type CompactionHistory = { events: Compaction[]; unmarked?: { removed: number; before?: number }; inContext: number; truncated: boolean; readAt: number };

/** The markers Hermes wraps a compaction summary in (`agent/context_compressor.py` at `bf0203a`). */
const SUMMARY_START = /\[CONTEXT COMPACTION[^\]]*\]|\[CONTEXT SUMMARY\]:/;
const SUMMARY_END = "--- END OF CONTEXT SUMMARY";
const PRIOR_CONTEXT_END = "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

const flag = (v: unknown) => v === true || v === 1;
const text = (v: unknown) =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map((p) => (typeof p === "string" ? p : typeof obj(p)?.text === "string" ? (obj(p)!.text as string) : "")).join("")
      : "";

/** Whether a stored row is a compaction summary: Hermes's flag, or its marker at the start, as Hermes itself tells. */
export function isSummaryRow(r: CompactionRow): boolean {
  if (flag(r._compressed_summary)) return true;
  const t = text(r.content).trimStart();
  return t.startsWith("[CONTEXT COMPACTION") || t.startsWith("[CONTEXT SUMMARY]:") || (t.startsWith("[PRIOR CONTEXT") && t.includes(PRIOR_CONTEXT_END));
}

/**
 * The summary in a summary row: from Hermes's compaction marker to its end marker. A carried tail of real messages
 * before it, and the ask restated after it, aren't the summary and are left out. A row without the markers is shown
 * whole: it is what Hermes stored.
 */
export function summaryText(content: unknown): string {
  let t = text(content);
  const prior = t.indexOf(PRIOR_CONTEXT_END);
  if (prior >= 0) t = t.slice(prior + PRIOR_CONTEXT_END.length);
  const start = t.search(SUMMARY_START);
  if (start >= 0) t = t.slice(start);
  const end = t.indexOf(SUMMARY_END);
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

const ms = (s: number | null | undefined) => (typeof s === "number" && s > 0 ? Math.round(s * 1000) : undefined);

/**
 * The compactions in a chat's stored rows (`include_compacted=true`), oldest row first. A message counts as taken out
 * when Hermes marked its row compacted and no row the model still reads has the same message (`message_uid`): Hermes
 * keeps copies of the messages at the head and tail of a compaction. A message is counted once, at its last stored
 * copy: a copy one compaction kept and a later one took out is put down to the later one only. Each is put down to the
 * first summary stored after it.
 */
export function compactionsOf(rows: CompactionRow[], truncated: boolean, readAt: number): CompactionHistory {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const live = new Set(sorted.filter((r) => flag(r.active) && r.message_uid).map((r) => r.message_uid));
  const lastCopy = new Map<string, number>();
  for (const r of sorted) if (r.message_uid) lastCopy.set(r.message_uid, r.id);
  const events: Compaction[] = [];
  let pending = new Set<string>();
  let anonymous = 0;
  let newest: number | undefined;
  for (const r of sorted) {
    if (isSummaryRow(r)) {
      events.push({ rowId: r.id, ...(ms(r.timestamp) && { at: ms(r.timestamp) }), summary: summaryText(r.content), removed: pending.size + anonymous, inContext: flag(r.active) || r.active == null });
      pending = new Set();
      anonymous = 0;
      newest = undefined;
      continue;
    }
    if (!flag(r.compacted) || (r.message_uid && (live.has(r.message_uid) || lastCopy.get(r.message_uid) !== r.id))) continue;
    if (r.message_uid) pending.add(r.message_uid);
    else anonymous++;
    newest = ms(r.timestamp) ?? newest;
  }
  const left = pending.size + anonymous;
  return {
    events,
    ...(left && { unmarked: { removed: left, ...(newest && { before: newest }) } }),
    inContext: sorted.filter((r) => flag(r.active) && !isSummaryRow(r)).length,
    truncated,
    readAt,
  };
}

/** A `session.compress` answer (`SessionCompressResult` at `bf0203a`), as the inspector reports it. */
export type CompactResult =
  | { kind: "compacted"; beforeMessages?: number; afterMessages?: number; beforeTokens?: number; afterTokens?: number; headline?: string }
  | { kind: "nothing"; headline?: string }
  | { kind: "pending" | "busy"; message: string };

export function compactResultOf(res: unknown): CompactResult {
  const r = obj(res) ?? {};
  const s = obj(r.summary);
  const headline = typeof s?.headline === "string" && s.headline.trim() ? s.headline.trim() : undefined;
  if (r.lock_held === true || r.compressed === false)
    return { kind: "busy", message: typeof r.message === "string" && r.message ? r.message : "Hermes is already compacting this chat." };
  if (r.status === "pending")
    return { kind: "pending", message: typeof r.message === "string" && r.message ? r.message : "Hermes is still compacting this chat in the background." };
  if (r.status === "aborted" || s?.noop === true || s?.aborted === true) return { kind: "nothing", ...(headline && { headline }) };
  return {
    kind: "compacted",
    ...(num(r.before_messages) !== undefined && { beforeMessages: num(r.before_messages) }),
    ...(num(r.after_messages) !== undefined && { afterMessages: num(r.after_messages) }),
    ...(num(r.before_tokens) !== undefined && { beforeTokens: num(r.before_tokens) }),
    ...(num(r.after_tokens) !== undefined && { afterTokens: num(r.after_tokens) }),
    ...(headline && { headline }),
  };
}
