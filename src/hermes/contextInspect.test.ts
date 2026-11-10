// The context inspector's reading of Hermes (ADR 0025): totals keep Hermes's provenance, categories are estimates,
// compactions come only from stored summary rows and compacted rows, and nothing is counted twice.
import { describe, expect, it } from "vitest";
import { compactResultOf, compactionsOf, readingOf, summaryText, type CompactionRow } from "./contextInspect";

/** `session.context_breakdown` as the deployed `bf0203a` answers for a built agent. */
const BREAKDOWN = {
  categories: [
    { color: "var(--context-usage-system)", id: "system_prompt", label: "System prompt", tokens: 6_210 },
    { color: "var(--context-usage-tools)", id: "tool_definitions", label: "Tool definitions", tokens: 8_904 },
    { color: "var(--context-usage-memory)", id: "memory", label: "Memory", tokens: 512 },
    { color: "var(--context-usage-conversation)", id: "conversation", label: "Conversation", tokens: 30_100 },
  ],
  context_max: 200_000,
  context_percent: 23,
  context_used: 46_000,
  context_source: "provider_usage_plus_estimate",
  context_estimated: true,
  estimated_total: 45_726,
  model: "claude-opus-5-5",
  context_files: [
    { label: "AGENTS.md", path: "/srv/app/AGENTS.md", chars: 4_000, est_tokens: 1_000, loaded: true, status: "loaded" },
    { label: "CLAUDE.md", path: "/srv/app/CLAUDE.md", chars: 40, est_tokens: 10, loaded: false, status: "shadowed" },
    { label: "broken", chars: 1 },
  ],
};

describe("A context reading", () => {
  it("keeps a category's colour only when it is a CSS variable or a hex colour", () => {
    const colors = ["var(--context-usage-system)", "#a78bfa", "#FFF", "url(https://example.com/beacon.png)", "red; background-image: url(x)", "image-set('x.png' 1x)", "var(--x), url(y)"];
    const r = readingOf({ categories: colors.map((color, i) => ({ id: `c${i}`, label: "Part", tokens: 1, color })) }, 0);
    expect(r.parts.map((p) => p.color)).toEqual(["var(--context-usage-system)", "#a78bfa", "#FFF", undefined, undefined, undefined, undefined]);
  });

  it("keeps Hermes's total and how it counted it, apart from its estimate by category", () => {
    const r = readingOf(BREAKDOWN, 1_000);
    expect(r).toMatchObject({ measuredAt: 1_000, model: "claude-opus-5-5", used: 46_000, max: 200_000, percent: 23, source: "provider_usage_plus_estimate", built: true, estimatedTotal: 45_726 });
    // The total is Hermes's measure, never the categories added up.
    expect(r.parts.reduce((a, p) => a + p.tokens, 0)).not.toBe(r.used);
    expect(r.parts.map((p) => p.id)).toEqual(["system_prompt", "tool_definitions", "memory", "conversation"]);
    expect(r.files).toEqual([
      { label: "AGENTS.md", path: "/srv/app/AGENTS.md", tokens: 1_000, loaded: true, status: "loaded" },
      { label: "CLAUDE.md", path: "/srv/app/CLAUDE.md", tokens: 10, loaded: false, status: "shadowed" },
    ]);
  });

  it("is unbuilt, with no total, before Hermes builds the chat's agent", () => {
    // The deployed answer for a session whose agent isn't built: empty categories and zeroes.
    const r = readingOf({ categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0, context_estimated: false, context_source: "provider_usage", model: "" }, 5);
    expect(r).toEqual({ measuredAt: 5, source: "provider_usage", parts: [], files: [], built: false });
  });

  it("drops malformed categories and labels a source it doesn't know as unlabelled", () => {
    const r = readingOf({ categories: [{ id: "x", tokens: "lots" }, { id: "y", label: "Y", tokens: -1 }, "junk"], context_max: 100, context_used: 7, context_source: "vibes" }, 0);
    expect(r.parts).toEqual([]);
    expect(r).toMatchObject({ used: 7, max: 100, percent: 7, source: "other", built: false });
    expect(readingOf({ context_estimated: true }, 0).source).toBe("local_estimate");
    expect(readingOf(null, 0)).toMatchObject({ parts: [], files: [], built: false });
  });
});

/** Stored rows of an in-place compaction as the live server holds them: the protected head and tail kept as copies. */
function rows(): CompactionRow[] {
  return [
    { id: 1, role: "user", content: "Set up the backup", timestamp: 100, active: 1, compacted: 0, message_uid: "u1" },
    // The head message, compacted, with an active copy kept: still read, so not taken out.
    { id: 2, role: "user", content: "head", timestamp: 101, active: 0, compacted: 1, message_uid: "head" },
    { id: 3, role: "assistant", content: "a", timestamp: 102, active: 0, compacted: 1, message_uid: "m3" },
    { id: 4, role: "tool", content: "b", timestamp: 103, active: 0, compacted: 1, message_uid: "m4" },
    { id: 5, role: "assistant", content: "c", timestamp: 104, active: 0, compacted: 1, message_uid: "m5" },
    {
      id: 6,
      role: "assistant",
      content:
        "[PRIOR CONTEXT — for reference only; not a new message]\nThe tail.\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.\n## Goal\nBack up the NAS.\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\nnext ask",
      timestamp: 200,
      active: 1,
      compacted: 0,
      _compressed_summary: 1,
      message_uid: "s1",
    },
    { id: 7, role: "user", content: "head", timestamp: 101, active: 1, compacted: 0, message_uid: "head" },
    { id: 8, role: "user", content: "and now?", timestamp: 300, active: 1, compacted: 0, message_uid: "u8" },
  ];
}

describe("A chat's compactions", () => {
  it("are its summary rows, each taking out the compacted messages before it that no read row keeps", () => {
    const h = compactionsOf(rows(), false, 9);
    expect(h.events).toEqual([{ rowId: 6, at: 200_000, summary: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.\n## Goal\nBack up the NAS.", removed: 3, inContext: true }]);
    expect(h.unmarked).toBeUndefined();
    // The summary itself isn't a message the model reads as one.
    expect(h.inContext).toBe(3);
    expect(h).toMatchObject({ truncated: false, readAt: 9 });
  });

  it("puts each message down to the first summary after it, and a later one can take an earlier summary out", () => {
    const more: CompactionRow[] = [
      ...rows().map((r) => (r.id === 6 ? { ...r, active: 0, compacted: 1 } : r.id === 8 ? { ...r, active: 0, compacted: 1 } : r)),
      { id: 9, role: "user", content: "[CONTEXT SUMMARY]: old style", timestamp: 400, active: 1, compacted: 0, message_uid: "s2" },
    ];
    const h = compactionsOf(more, false, 0);
    expect(h.events.map((e) => [e.rowId, e.removed, e.inContext])).toEqual([
      [6, 3, false],
      [9, 1, true],
    ]);
    expect(h.events[1].summary).toBe("[CONTEXT SUMMARY]: old style");
  });

  it("counts a message one compaction kept a copy of and a later one took out once, against the later one", () => {
    // Compaction A keeps "head" as a copy (row 7); compaction B then takes that copy out too.
    const more: CompactionRow[] = [
      ...rows().map((r) => (r.id === 6 || r.id === 7 || r.id === 8 ? { ...r, active: 0, compacted: 1 } : r)),
      { id: 9, role: "user", content: "[CONTEXT SUMMARY]: B", timestamp: 400, active: 1, compacted: 0, message_uid: "s2" },
    ];
    const h = compactionsOf(more, false, 0);
    // A: m3, m4, m5. B: the head copy and u8 (A's summary going out shows as A no longer in context). "head" is not
    // counted against A as well.
    expect(h.events.map((e) => [e.rowId, e.removed, e.inContext])).toEqual([
      [6, 3, false],
      [9, 2, true],
    ]);
    expect(h.events.reduce((t, e) => t + e.removed, 0)).toBe(5);
  });

  it("reports compacted rows with no summary row as a compaction it can't show the summary of", () => {
    // As the live server's August chats: 943 rows compacted, no summary row stored.
    const legacy: CompactionRow[] = [
      { id: 1, timestamp: 10, active: 0, compacted: 1, message_uid: "a" },
      { id: 2, timestamp: 20, active: 0, compacted: 1, message_uid: "b" },
      { id: 3, timestamp: 30, active: 0, compacted: 1 },
      { id: 4, timestamp: 40, active: 1, compacted: 0, message_uid: "c" },
    ];
    const h = compactionsOf(legacy, true, 0);
    expect(h.events).toEqual([]);
    expect(h.unmarked).toEqual({ removed: 3, before: 30_000 });
    expect(h).toMatchObject({ inContext: 1, truncated: true });
  });

  it("has none when nothing was compacted", () => {
    expect(compactionsOf([{ id: 1, active: 1, compacted: 0 }], false, 0)).toEqual({ events: [], inContext: 1, truncated: false, readAt: 0 });
  });

  it("keeps a summary row without markers whole, as Hermes stored it", () => {
    expect(summaryText("just text")).toBe("just text");
    expect(summaryText([{ type: "text", text: "[CONTEXT COMPACTION — REFERENCE ONLY] parts" }])).toBe("[CONTEXT COMPACTION — REFERENCE ONLY] parts");
  });
});

describe("A compaction's result", () => {
  it("reads each of Hermes's answers", () => {
    expect(compactResultOf({ status: "compressed", before_messages: 40, after_messages: 9, before_tokens: 52_000, after_tokens: 11_000, summary: { headline: "Compressed 40 → 9" } })).toEqual({
      kind: "compacted",
      beforeMessages: 40,
      afterMessages: 9,
      beforeTokens: 52_000,
      afterTokens: 11_000,
      headline: "Compressed 40 → 9",
    });
    expect(compactResultOf({ status: "compressed", summary: { noop: true, headline: "Nothing to compress" } })).toEqual({ kind: "nothing", headline: "Nothing to compress" });
    expect(compactResultOf({ status: "aborted", summary: { aborted: true } })).toEqual({ kind: "nothing" });
    expect(compactResultOf({ compressed: false, lock_held: true, message: "Another compaction holds the lock." })).toEqual({ kind: "busy", message: "Another compaction holds the lock." });
    expect(compactResultOf({ status: "pending", turn_isolation: true, message: "still running" })).toEqual({ kind: "pending", message: "still running" });
  });
});
