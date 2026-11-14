// What the stylesheet does for people who turn motion off, scale the interface, or sign in by keyboard. jsdom applies
// no stylesheet, so these read styles.css.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of each block opened by `prelude`, braces balanced. */
function blocks(prelude: string) {
  const out: string[] = [];
  for (let at = css.indexOf(prelude); at >= 0; at = css.indexOf(prelude, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        out.push(css.slice(open + 1, i));
        break;
      }
    }
  }
  return out;
}
/** A selector list's selectors: split at its commas, not those inside `:is(…)`. */
const selectors = (list: string) => list.split(/,(?![^(]*\))/).map((s) => s.trim());
/** The declarations of the rules in `source` whose selector list includes `selector`. */
const declarations = (source: string, selector: string) =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => selectors(m[1]).includes(selector))
    .map((m) => m[2])
    .join(";");

describe("Reduced motion", () => {
  const [still, ...more] = blocks("@media (prefers-reduced-motion: reduce)");

  it("is one block that stops every animation and transition", () => {
    expect(still).toBeDefined();
    expect(more).toEqual([]);
    const all = declarations(still, "*");
    for (const d of ["animation-duration: 0s !important", "animation-iteration-count: 1 !important", "transition-duration: 0s !important"]) expect(all).toContain(d);
  });

  // Every rule that runs an animation for ever is either a status that needs a still mark of its own, or a loading
  // indicator that still reads standing still: a spinner's ring, the thinking dots as an ellipsis.
  const STATUS = [".conn-dot.connecting", ".conn-dot.reconnecting", ".rec-dot"];
  const LOADING = [".spinner", ".thinking span", ".preview-busy svg", ".spin"];

  it("knows every animation that runs for ever", () => {
    const looping = [...css.matchAll(/([^{}]+)\{([^{}]*animation:[^;}]*infinite[^{}]*)\}/g)].flatMap((m) => selectors(m[1]));
    expect(looping.sort()).toEqual([...STATUS, ...LOADING].sort());
  });

  it("gives each status that pulsed a still mark", () => {
    for (const selector of STATUS) expect(declarations(still, selector), selector).toMatch(/box-shadow:/);
  });
});

describe("Icons", () => {
  it("scale with the interface size Appearance sets", () => {
    expect(declarations(css, "svg.lucide")).toContain("zoom: var(--ui-scale, 1)");
  });
});
