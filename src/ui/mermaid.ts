// Mermaid diagrams from a reply's ```mermaid fences, drawn as SVG. Mermaid is loaded only when the first diagram is
// drawn, in its own chunk. A reply carries text from web pages, files and tool output, so a prompt injection can write
// a diagram, and drawing it must never make the app fetch anything (the same threat as ADR 0099's remote images).

/** A diagram drawn, or why it isn't. */
export type Drawing = { svg: string } | { note: string };

/** CSS that fetches: `@import`, and `url(…)` or `image-set(…)` pointing anywhere but into the SVG itself (`#id`). */
const CSS_FETCH = /@import[^;]*;?|\b(?:url|image-set)\(\s*(?!['"]?#)[^)]*\)?/gi;

/** `css` with its escapes read, as a browser reads them, so `\75 rl(` is `url(`. */
const cssUnescaped = (css: string) =>
  css.replace(/\\(?:([0-9a-f]{1,6})\s?|(.))/gis, (_, hex?: string, char?: string) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char!,
  );

/**
 * Why `source` isn't drawn, for what would load while mermaid draws it, in the page, before there is an SVG to clean:
 * the image shape (`A@{ img: "https://…" }`, YAML, whose escapes could spell `img`), and styles (`classDef`, `style`).
 */
function refused(source: string): string | undefined {
  if (source.includes("@{") && /img|\\[xu]/i.test(source)) return "This diagram links an image, so it isn't drawn.";
  if (cssUnescaped(source).search(CSS_FETCH) >= 0) return "This diagram's styles link outside the app, so it isn't drawn.";
}

/** Elements that load something, or move an attribute to something that does. */
const LOADS =
  "script, image, img, feImage, iframe, frame, object, embed, video, audio, source, track, link, picture, form, animate, set, animateMotion, animateTransform";
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "srcset", "poster", "data", "action", "formaction", "background", "ping"]);
// Escapes could spell `url(` past the pattern; mermaid's own styles have none, so they all go.
const inert = (css: string) => css.replace(/\\/g, "").replace(CSS_FETCH, "none");

/**
 * `svg` with what would reach off the app taken out: elements that load, links (a click would take the app's window
 * there), and styles that fetch. Parsed in a document that loads nothing.
 */
function contained(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  doc.querySelectorAll(LOADS).forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || (URL_ATTRIBUTES.has(lower) && (el.localName === "a" || !value.trim().startsWith("#")))) el.removeAttribute(name);
      else if (lower === "style" || /[(\\]/.test(value)) el.setAttribute(name, inert(value));
    }
    if (el.localName === "style") el.textContent = inert(el.textContent ?? "");
  }
  return doc.body.innerHTML;
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/:$/, "") ?? "unknown error";

/**
 * Settings that have no default, so `defaultConfig` doesn't list them, yet a diagram's `%%{init}%%` or frontmatter
 * could set: `htmlLabels: true` would put a label's `<img>` into the page while mermaid draws. The test checks this list
 * against every key mermaid's `MermaidConfig` type declares.
 */
export const UNDEFAULTED_SETTINGS = ["htmlLabels", "dompurifyConfig", "wrap", "altFontFamily"];

/** How long one drawing may take; one that hangs then shows its source, and the diagrams after it still draw. */
const DRAW_MS = 15_000;

let drawnSoFar = 0;
// One at a time: mermaid's config is global, and each drawing sets its theme.
let queue: Promise<unknown> = Promise.resolve();

export type Theme = "dark" | "default";

async function draw(source: string, theme: Theme): Promise<Drawing> {
  const why = refused(source);
  if (why) return { note: why };
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      // Labels as SVG text, not HTML, so a label's `<img>` or Markdown image is only words.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // No `%%{init}%%` or frontmatter in the diagram can change any setting, such as themeCSS.
      secure: [...Object.keys(mermaid.mermaidAPI.defaultConfig), ...UNDEFAULTED_SETTINGS],
    });
    let late: ReturnType<typeof setTimeout> | undefined;
    const { svg } = await Promise.race([
      mermaid.render(`mermaid-${++drawnSoFar}`, source),
      new Promise<never>((_, fail) => (late = setTimeout(() => fail(new Error(`took longer than ${DRAW_MS / 1000} s`)), DRAW_MS))),
    ]).finally(() => clearTimeout(late));
    return { svg: contained(svg) };
  } catch (error) {
    return { note: `Couldn't draw this diagram: ${firstLine(error)}` };
  }
}

type Held = { drawing: Promise<Drawing>; done?: Drawing };

/** Drawings by theme and source, the last 50. */
const drawings = new Map<string, Held>();

/** The mermaid theme for the app's light or dark mode now. */
export const themeNow = (): Theme => (document.documentElement.dataset.mode === "dark" ? "dark" : "default");

/** Calls `fn` when the app switches between light and dark. */
export function subscribeTheme(fn: () => void) {
  const watch = new MutationObserver(fn);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => watch.disconnect();
}

/** `source` drawn in `theme`, if it has been already. */
export function drawnAlready(source: string, theme: Theme): Drawing | undefined {
  return drawings.get(theme + "\n" + source)?.done;
}

/** `source` drawn in `theme`. */
export function drawDiagram(source: string, theme: Theme): Promise<Drawing> {
  const key = theme + "\n" + source;
  const held = drawings.get(key);
  if (held) {
    drawings.delete(key);
    drawings.set(key, held);
    return held.drawing;
  }
  const drawing = queue.then(() => draw(source, theme));
  queue = drawing;
  const entry: Held = { drawing };
  void drawing.then((done) => (entry.done = done));
  drawings.set(key, entry);
  for (const [old] of drawings) {
    if (drawings.size <= 50) break;
    drawings.delete(old);
  }
  return entry.drawing;
}
