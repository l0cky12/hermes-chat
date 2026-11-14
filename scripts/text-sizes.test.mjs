import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sizePx, smallText, textSizes } from "./text-sizes.mjs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("Text sizes in the stylesheet", () => {
  it("work out each form of size at a 14px interface and 13px code", () => {
    expect(sizePx("calc(11.5rem / 14)")).toBe(11.5);
    expect(sizePx("12px")).toBe(12);
    expect(sizePx("calc(var(--mono-size) * 0.85)")).toBeCloseTo(11.05);
    expect(sizePx("calc(var(--mono-size, 12.5px) - 0.5px)")).toBe(12.5);
    expect(sizePx("max(calc(12rem / 14), calc(var(--mono-size) * 0.85))")).toBe(12);
    expect(sizePx("0.86em")).toBeUndefined();
    expect(sizePx("inherit")).toBeUndefined();
  });

  it("find sizes in rules, media blocks and the font shorthand", () => {
    const sample = ".a { font-size: calc(11rem / 14); }\n@media (max-width: 9px) {\n  .b { color: red; font: calc(10rem / 14) / 1.5 var(--mono); }\n}\n.c { font-size: 13px }";
    expect(textSizes(sample)).toEqual([
      { line: 1, selector: ".a", value: "calc(11rem / 14)", px: 11 },
      { line: 3, selector: ".b", value: "calc(10rem / 14)", px: 10 },
      { line: 5, selector: ".c", value: "13px", px: 13 },
    ]);
    expect(smallText(sample).map((s) => s.selector)).toEqual([".a", ".b"]);
  });

  it("never set text under 12px at the default interface and code sizes", () => {
    expect(smallText(css).map((s) => `${s.line} ${s.selector}: ${s.value}`)).toEqual([]);
  });
});
