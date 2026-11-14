#!/usr/bin/env node
// Lists every rule in src/styles.css whose text size works out under a floor at the default sizes (14px interface,
// 13px code), so a change to the type scale can be counted before and after. `node scripts/text-sizes.mjs [floor]`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_PX = 14;
const MONO_PX = 13;

/** A font-size value in px at the default sizes, or undefined when it depends on the parent (em, %, inherit). */
export function sizePx(value) {
  const expr = value
    .replace(/var\(--mono-size(?:,[^)]*)?\)/g, `${MONO_PX}px`)
    .replace(/(\d*\.?\d+)rem\b/g, (_, n) => `${n * ROOT_PX}px`)
    .replace(/\bcalc\(/g, "(")
    .replace(/\b(max|min)\(/g, "Math.$1(");
  if (/\d(em|%)|inherit|var\(/.test(expr)) return undefined;
  const js = expr.replace(/(\d*\.?\d+)px\b/g, "$1");
  if (!/^[\d.\s+\-*/(),]+$/.test(js.replace(/Math\.(max|min)/g, ""))) return undefined;
  return Function(`return (${js});`)();
}

/** The size part of a `font:` shorthand: the token before the optional `/ line-height` and the family. */
const shorthandSize = (value) => value.match(/(?:^|\s)((?:calc|max|min)\([^;]*?\)|[\d.]+(?:px|rem|em|%))(?=\s*\/|\s+[\w"'-])/)?.[1];

/** Every declared text size in `css`, with its rule's selector, the line it's on, and its px at the default sizes. */
export function textSizes(css) {
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      i = css.indexOf("*/", i + 2) + 1;
      start = i + 1;
    } else if (ch === "{") {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}" || (ch === ";" && stack.length)) {
      const decl = css.slice(start, i).trim();
      const m = decl.match(/^(font-size|font)\s*:\s*([\s\S]+)$/);
      if (m) {
        const raw = m[1] === "font" ? shorthandSize(m[2]) : m[2].trim();
        if (raw) {
          const line = css.slice(0, start + css.slice(start).indexOf(m[0])).split("\n").length;
          out.push({ line, selector: stack.at(-1).replace(/\s+/g, " "), value: raw, px: sizePx(raw) });
        }
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** The sizes in `css` that work out under `floor` px. */
export const smallText = (css, floor = 12) => textSizes(css).filter((s) => s.px !== undefined && s.px < floor - 1e-9);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const floor = Number(process.argv[2] ?? 12);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const small = smallText(css, floor);
  for (const s of small) console.log(`${String(s.line).padStart(5)}  ${s.px.toFixed(2).padStart(6)}px  ${s.value.padEnd(34)} ${s.selector}`);
  const relative = textSizes(css).filter((s) => s.px === undefined && s.value !== "inherit");
  for (const s of relative) console.log(`${String(s.line).padStart(5)}  relative  ${s.value.padEnd(34)} ${s.selector}`);
  console.log(`${small.length} rules under ${floor}px at a 14px interface and 13px code; ${relative.length} relative to their parent`);
}
