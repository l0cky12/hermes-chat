// Search across Settings: the screen's own rendered text and its controls' names, so there is no index to keep in step with it. A section
// shows while its text holds every word of the query; the rest are hidden, and the words are marked in what shows.

/** The words of a query, folded as the text they're found in is (`lowered`). */
export function queryWords(query: string): string[] {
  return lowered(query).low.split(/\s+/).filter(Boolean);
}

/** Whether `text` holds every one of `words`, ignoring case. */
export function textMatches(text: string, words: string[]): boolean {
  const t = lowered(text).low;
  return words.every((w) => t.includes(w));
}

/** The CSS highlight the found words are drawn with (`::highlight(settings-search)`). */
export const HIGHLIGHT_NAME = "settings-search";

/** Attribute on a section, or a group of them, that the query hides. */
export const MISS_ATTR = "data-search-miss";

/** The outermost sections under `root`: the unit search shows or hides. */
function sectionsOf(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("section")].filter((s) => {
    const outer = s.parentElement?.closest("section");
    return !outer || !root.contains(outer);
  });
}

/** Names a control carries only as an attribute, such as a size picker's "Interface font size", searched with the text. */
export const NAMED = ["aria-label", "title", "placeholder"];

/**
 * The text a section is searched by: what it shows, and its controls' names. The names are read off every element in
 * turn, not found with an attribute selector, which jsdom's selector engine makes slow enough to time tests out.
 */
export function searchText(el: Element): string {
  const names: string[] = [];
  for (const n of el.getElementsByTagName("*"))
    for (const a of NAMED) {
      const name = n.getAttribute(a);
      if (name) names.push(name);
    }
  return [el.textContent ?? "", ...names].join(" ");
}

/**
 * `text` folded for matching, with where each of its code units came from in `text`. Each character is lower-cased on
 * its own, which can change the length ("İ" becomes two code units), so offsets found in the folded text are mapped
 * back before marking. Matching, the query and marking all fold this one way, so whatever matches is marked; a final
 * sigma folds to σ, so "ος", "οσ" and "ΟΣ" find one another wherever they stand in a word.
 */
export function lowered(text: string): { low: string; start: number[]; end: number[] } {
  let low = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const ch of text) {
    const l = ch === "ς" ? "σ" : ch.toLowerCase();
    for (let k = 0; k < l.length; k++) {
      start.push(i);
      end.push(i + ch.length);
    }
    low += l;
    i += ch.length;
  }
  return { low, start, end };
}

const UNDRAWN = new Set(["OPTION", "SCRIPT", "STYLE"]);
/** Whether text node `n` sits in an element whose text isn't drawn: a walk up by tag name, as a `closest` selector is slow in jsdom. */
function undrawn(n: Node): boolean {
  for (let e = n.parentElement; e; e = e.parentElement) if (UNDRAWN.has(e.tagName)) return true;
  return false;
}

/** The ranges of each word in the text under `el`, for marking. Text inside a select's options isn't drawn, so isn't marked. */
function wordRanges(el: Element, words: string[]): Range[] {
  const ranges: Range[] = [];
  const doc = el.ownerDocument;
  const walk = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (undrawn(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const { low, start, end } = lowered(n.textContent ?? "");
    for (const w of words) {
      for (let at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + w.length)) {
        const r = doc.createRange();
        r.setStart(n, start[at]);
        r.setEnd(n, end[at + w.length - 1]);
        ranges.push(r);
      }
    }
  }
  return ranges;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : undefined;

/** Removes the marks of found words. */
export function clearMarks(): void {
  registry()?.delete(HIGHLIGHT_NAME);
}

/**
 * Shows only the sections in each group under `root` (an element with `data-search-group`) whose text holds every word,
 * hides a group left with none, and marks the words where the WebView can draw CSS highlights, in those sections and in
 * any result under `root` marked `data-search-mark`. Returns how many sections show.
 */
export function applySearch(root: Element, words: string[]): number {
  let shown = 0;
  const ranges: Range[] = [];
  for (const group of root.querySelectorAll<HTMLElement>("[data-search-group]")) {
    let inGroup = 0;
    for (const s of sectionsOf(group)) {
      const hit = textMatches(searchText(s), words);
      s.toggleAttribute(MISS_ATTR, !hit);
      if (hit) {
        inGroup++;
        ranges.push(...wordRanges(s, words));
      }
    }
    group.toggleAttribute(MISS_ATTR, inGroup === 0);
    shown += inGroup;
  }
  for (const el of root.querySelectorAll("[data-search-mark]")) ranges.push(...wordRanges(el, words));
  const highlights = registry();
  if (highlights) {
    const Highlight = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }
  return shown;
}
