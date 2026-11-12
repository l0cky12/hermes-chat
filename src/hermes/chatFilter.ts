// Chat filters: narrowing the profile's chats by words, Tag, Source, model, last activity and state (GLOSSARY.md
// "Chat filter", ADR 0106). Words go to Hermes's own search; with none, the profile's chats are listed from Hermes,
// however old. Hermes can narrow either read by Source; Tags are kept on this computer (tags.ts), and Hermes's search
// can't narrow by model, date or state, so those are checked here, on what Hermes answered. When Hermes answered as
// many chats as it would, the outcome says more may match rather than claiming the list is complete.
import type { Found, Source } from "./model";
import { optionalText } from "./values";

/** Which chats, by state: Active, Settled, Archived, or all of them; undefined is Active and Settled, as the list. */
export type ChatState = "active" | "settled" | "archived" | "all";

/**
 * A chat filter. A chat matches every part given: the words (Hermes's search), every tag in `tags` (by id), any source
 * in `sources`, a model whose name holds `model`, last active between `from` and `to` (local days, YYYY-MM-DD), and
 * `state`. It always applies to the profile on screen.
 */
export type ChatFilter = {
  text?: string;
  tags?: string[];
  sources?: Source[];
  model?: string;
  from?: string;
  to?: string;
  state?: ChatState;
};

export const STATE_LABEL: Record<ChatState, string> = {
  active: "Active",
  settled: "Settled",
  archived: "Archived",
  all: "All, archived too",
};

const SOURCES: readonly Source[] = ["app", "telegram", "discord", "cli", "desktop", "other"];
const STATES: readonly ChatState[] = ["active", "settled", "archived", "all"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The filter with blanks dropped, so the same filter saves and compares the same however it was typed. */
export function tidyFilter(f: ChatFilter): ChatFilter {
  const text = f.text?.trim();
  const model = f.model?.trim();
  return {
    ...(text && { text }),
    ...(f.tags?.length && { tags: [...new Set(f.tags)] }),
    ...(f.sources?.length && { sources: SOURCES.filter((s) => f.sources!.includes(s)) }),
    ...(model && { model }),
    ...(f.from && DAY.test(f.from) && { from: f.from }),
    ...(f.to && DAY.test(f.to) && { to: f.to }),
    ...(f.state && STATES.includes(f.state) && { state: f.state }),
  };
}

export const isEmptyFilter = (f: ChatFilter) => Object.keys(tidyFilter(f)).length === 0;

/** A stored filter, checked; anything that isn't one is left out. */
export function toFilter(v: unknown): ChatFilter {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && i.length > 0 && i.length <= 100) : undefined);
  return tidyFilter({
    text: optionalText(o.text, 500),
    tags: list(o.tags),
    sources: list(o.sources)?.filter((s): s is Source => SOURCES.includes(s as Source)),
    model: optionalText(o.model, 200),
    from: optionalText(o.from, 10),
    to: optionalText(o.to, 10),
    state: STATES.find((s) => s === o.state),
  });
}

/** Local midnight at the start of `day`, and of the day after it. */
const startOf = (day: string, after = 0) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + after).getTime();
};

/** How a filter reaches Hermes: its search, and its list of the profile's chats (transport.ts). */
export type FilterIo = {
  searchPage(text: string, opts: { archived: boolean; sources?: Source[]; limit: number }): Promise<{ found: Found[]; capped: boolean }>;
  browse(opts: { archived: "exclude" | "only" | "include"; sources?: Source[] }): Promise<{ found: Found[]; capped: boolean }>;
};

/** The tags this computer keeps, as far as a filter needs them. */
export type TagLookup = { exists(tagId: string): boolean; of(chatId: string): readonly string[] };

/**
 * What a filter found. `capped`: Hermes answered as many chats as it would, its best `limit` for words ("search") or
 * its most recent pages ("list"), so more chats may match. `noModel`: chats that matched everything else, but whose
 * model Hermes didn't record, so a model filter can't tell. `noSource`: the same for a source filter, for chats Hermes
 * stored as local without saying which app started them. `missingTags`: tags the filter names that were deleted, so
 * no chat can match.
 */
export type FilterOutcome = { found: Found[]; capped?: "search" | "list"; noModel: number; noSource: number; missingTags: string[] };

/** How many chats a search with filters asks Hermes for: the most it gives. */
export const FILTER_SEARCH_LIMIT = 100;
/** A search with words only asks for this many, as the search palette always did. */
export const WORDS_SEARCH_LIMIT = 50;

/** Runs `filter` in the profile on screen. Reads only: no chat's state changes, and nothing is put in the list. */
export async function runFilter(filter: ChatFilter, io: FilterIo, tags: TagLookup): Promise<FilterOutcome> {
  const f = tidyFilter(filter);
  const missingTags = (f.tags ?? []).filter((t) => !tags.exists(t));
  if (isEmptyFilter(f) || missingTags.length) return { found: [], noModel: 0, noSource: 0, missingTags };
  const archivedWanted = f.state === "archived" || f.state === "all";
  const onlyWords = Object.keys(f).every((k) => k === "text");
  const page = f.text
    ? await io.searchPage(f.text, { archived: archivedWanted, sources: f.sources, limit: onlyWords ? WORDS_SEARCH_LIMIT : FILTER_SEARCH_LIMIT })
    : await io.browse({ archived: f.state === "archived" ? "only" : f.state === "all" ? "include" : "exclude", sources: f.sources });
  const from = f.from ? startOf(f.from) : -Infinity;
  const to = f.to ? startOf(f.to, 1) : Infinity;
  const model = f.model?.toLocaleLowerCase();
  let noModel = 0;
  let noSource = 0;
  const found = page.found.filter((c) => {
    const inState =
      f.state === "all" ? true : f.state === "archived" ? !!c.archived : !c.archived && (f.state === undefined || (f.state === "settled") === c.settled);
    const of = f.tags?.length ? tags.of(c.chatId) : [];
    const others = inState && (f.tags ?? []).every((t) => of.includes(t)) && c.updatedAt >= from && c.updatedAt < to;
    const modelOk = !model || !!c.model?.toLocaleLowerCase().includes(model);
    if (others && f.sources && c.sourceUnknown && modelOk) noSource++;
    const sourceOk = !f.sources || (!c.sourceUnknown && f.sources.includes(c.source));
    if (others && sourceOk && model && !c.model) noModel++;
    return others && sourceOk && modelOk;
  });
  return { found, ...(page.capped && { capped: f.text ? "search" : "list" }), noModel, noSource, missingTags };
}
