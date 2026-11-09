// Test support for converted screens (#353): a locale that marks every word it gives, and a check that finds the
// words on a page that carry no mark, so came from somewhere other than the catalogue.
import { en } from "./en";
import { localeFor, type Formats, type Locale } from "./locale";

const OPEN = "⟦";
const CLOSE = "⟧";
const marked = (s: string) => `${OPEN}${s}${CLOSE}`;

function mark(v: unknown): unknown {
  if (typeof v === "string") return marked(v);
  if (typeof v === "function") return (...args: unknown[]) => marked(v(...args));
  return Object.fromEntries(Object.entries(v as object).map(([k, inner]) => [k, mark(inner)]));
}

/** English with each catalogue string, each string a catalogue function returns, and each formatted value in ⟦ ⟧. */
export function pseudoLocale(): Locale {
  const english = localeFor("en", []);
  return { ...(mark(en) as typeof en), language: "en", tag: "en", fmt: mark(english.fmt) as Formats };
}

const READ = ["aria-label", "title", "placeholder", "alt", "label", "aria-valuetext"];

/**
 * Each text a person can see or hear under `root` that holds a letter or digit outside ⟦ ⟧, as "text (where)". Text
 * nodes count hidden or not, so folded help is read. A subtree marked translate="no" is data (a font or theme name,
 * sample code) and is skipped; a textarea's text is what was typed into it.
 */
export function untranslated(root: Element): string[] {
  const found: string[] = [];
  const check = (text: string, where: string) => {
    let rest = text;
    for (let prev = ""; prev !== rest; ) [prev, rest] = [rest, rest.replace(/⟦[^⟦⟧]*⟧/g, "")];
    if (/[\p{L}\p{N}]/u.test(rest)) found.push(`${text.trim()} (${where})`);
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return check(node.textContent ?? "", "text");
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.getAttribute("translate") === "no") return;
    for (const a of READ) {
      const v = el.getAttribute(a);
      if (v !== null) check(v, a);
    }
    if (el.tagName !== "TEXTAREA") el.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
