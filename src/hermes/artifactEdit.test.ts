// The artifact editor's model without I/O: when Hermes's proposal applies, Unicode-safe selections,
// what Hermes is sent, and the versions kept.
import { describe, expect, it } from "vitest";
import {
  ASK_CONTEXT_CHARS,
  VERSIONS_PER_FILE,
  askInput,
  askMaxTokens,
  keep,
  proposed,
  replacementFrom,
  staleBecause,
  wholeChars,
  type KeptVersion,
  type Proposal,
} from "./artifactEdit";

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: 1,
  instruction: "shorter",
  before: "# Title\n\nA long, long paragraph.\n\nEnd.\n",
  baseRevision: "rev1",
  start: 9,
  end: 33,
  replacement: "Short.",
  lent: false,
  at: 0,
  ...o,
});

describe("Hermes's proposed edit", () => {
  it("changes only the selected text, keeping everything around it byte for byte", () => {
    const p = proposal();
    expect(p.before.slice(p.start, p.end)).toBe("A long, long paragraph.\n");
    expect(proposed(p)).toBe("# Title\n\nShort.\nEnd.\n".replace("Short.\nEnd.", "Short.\nEnd."));
    expect(proposed(p).startsWith(p.before.slice(0, p.start))).toBe(true);
    expect(proposed(p).endsWith(p.before.slice(p.end))).toBe(true);
  });

  it("applies only to exactly the text and base it was made for", () => {
    const p = proposal();
    expect(staleBecause(p, p.before, "rev1")).toBeUndefined();
    expect(staleBecause(p, p.before + "typed", "rev1")).toMatch(/text has changed/);
    expect(staleBecause(p, p.before, "rev2")).toMatch(/has changed since you asked/);
    // Even an unrelated change elsewhere makes it stale: a patch is never fitted onto newer text.
    expect(staleBecause(p, p.before.replace("End.", "End!"), "rev1")).toBeDefined();
  });

  it("takes off <selection> tags the model echoed, and nothing else", () => {
    expect(replacementFrom("<selection>New text</selection>")).toBe("New text");
    expect(replacementFrom("  <selection>\nA\n</selection>\n")).toBe("\nA\n");
    expect(replacementFrom("Keep <selection> literal")).toBe("Keep <selection> literal");
    expect(replacementFrom("")).toBe("");
  });

  it("never cuts a selection between the halves of an emoji or other astral character", () => {
    const text = "a😀b𝒳c";
    expect(wholeChars(text, 2, 5)).toEqual({ start: 1, end: 6 });
    expect(wholeChars(text, 1, 3)).toEqual({ start: 1, end: 3 });
    expect(text.slice(1, 6)).toBe("😀b𝒳");
    // Combining marks and CJK are whole UTF-16 units and stay as selected.
    expect(wholeChars("é漢字", 1, 3)).toEqual({ start: 1, end: 3 });
    expect(wholeChars("abc", -5, 99)).toEqual({ start: 0, end: 3 });
  });

  it("sends the request and the document as quoted data with its identity, cut around a big selection", () => {
    const text = "x".repeat(ASK_CONTEXT_CHARS + 10) + "PICK" + "y".repeat(ASK_CONTEXT_CHARS + 10);
    const start = ASK_CONTEXT_CHARS + 10;
    const input = askInput({ path: "/srv/out/notes.md", revision: "abcdef0123456789", text, start, end: start + 4, instruction: "  Shout it  " });
    expect(input).toContain("Request: Shout it\n");
    expect(input).toContain("Document: /srv/out/notes.md (revision abcdef012345, ");
    expect(input).toContain("<selection>PICK</selection>");
    expect(input).toContain('<before cut="start">');
    expect(input).toContain('<after cut="end">');
    expect(input.length).toBeLessThan(2 * ASK_CONTEXT_CHARS + 500);
    const whole = askInput({ path: "/a.txt", revision: "r", text: "all", start: 0, end: 3, instruction: "x" });
    expect(whole).toContain("The selection is the whole document.");
    expect(whole).toContain("<before></before>");
  });

  it("allows tokens for an answer about as long as the selection", () => {
    expect(askMaxTokens(10)).toBe(1024);
    expect(askMaxTokens(30_000)).toBe(20_512 > 16_384 ? 16_384 : 20_512);
    expect(askMaxTokens(3000)).toBeGreaterThan(1500);
  });
});

describe("kept versions", () => {
  const v = (id: number, text: string, revision = text): KeptVersion => ({ id, kind: "saved", at: id, text, revision });
  it("keeps each new version, not the same one twice in a row, and drops the oldest past the cap", () => {
    let list: KeptVersion[] = [];
    list = keep(list, v(1, "a"));
    list = keep(list, v(2, "a"));
    expect(list.map((x) => x.id)).toEqual([1]);
    for (let i = 3; i < VERSIONS_PER_FILE + 10; i++) list = keep(list, v(i, `t${i}`));
    expect(list).toHaveLength(VERSIONS_PER_FILE);
    expect(list.at(-1)!.text).toBe(`t${VERSIONS_PER_FILE + 9}`);
  });
});
