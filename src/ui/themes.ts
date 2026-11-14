// Color themes. A theme is four colors for each of light and dark: the background, the surface panels and cards sit
// on, the text, and the accent. Everything else the stylesheet colors with (the list panel, borders, muted text, code
// blocks, hover tints) is worked out from those four and the contrast setting, so a custom theme takes four picks per
// mode and still covers the whole app. Pure: appearance.ts keeps the choice and puts the result on the root element.

export type Scheme = "system" | "light" | "dark";
export type Mode = "light" | "dark";
/** Colors as #rrggbb. */
export type Palette = { background: string; surface: string; text: string; accent: string };
export type Theme = { id: string; name: string; light: Palette; dark: Palette };

export const PALETTE_KEYS = ["background", "surface", "text", "accent"] as const;

/** Contrast runs 0 to 100; at the default the Hermes theme's dark mode is the stylesheet's original colors. */
export const DEFAULT_CONTRAST = 50;
export const MAX_THEME_NAME = 40;

export const BUILTIN_THEMES: Theme[] = [
  {
    id: "hermes",
    name: "Hermes",
    dark: { background: "#1b1c20", surface: "#222328", text: "#d6d7dc", accent: "#d08b6e" },
    light: { background: "#f6f5f2", surface: "#fcfbf9", text: "#22211e", accent: "#a6563a" },
  },
  {
    id: "ocean",
    name: "Ocean",
    dark: { background: "#0f1720", surface: "#16212d", text: "#e3ecf5", accent: "#4fa3e0" },
    light: { background: "#f5f8fb", surface: "#ffffff", text: "#14202c", accent: "#1f6fb2" },
  },
  {
    id: "grove",
    name: "Grove",
    dark: { background: "#121815", surface: "#19211d", text: "#e2ece6", accent: "#4cbf87" },
    light: { background: "#f6f8f5", surface: "#ffffff", text: "#18231d", accent: "#23784c" },
  },
  {
    id: "iris",
    name: "Iris",
    dark: { background: "#15131c", surface: "#1d1a27", text: "#e9e6f3", accent: "#9d86f0" },
    light: { background: "#f8f7fc", surface: "#ffffff", text: "#1e1b2a", accent: "#6b4fd8" },
  },
  {
    id: "rose",
    name: "Rose",
    dark: { background: "#1a1316", surface: "#241a1f", text: "#f2e6ea", accent: "#e86a9a" },
    light: { background: "#fcf7f9", surface: "#ffffff", text: "#2a1a21", accent: "#c43c72" },
  },
  {
    id: "dune",
    name: "Dune",
    dark: { background: "#16150f", surface: "#1f1d16", text: "#efeadb", accent: "#e0b341" },
    light: { background: "#fbfaf4", surface: "#ffffff", text: "#25221a", accent: "#8a6405" },
  },
];
export const DEFAULT_THEME_ID = "hermes";

// ---------- color math ----------

type Rgb = [number, number, number];
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (s: unknown): s is string => typeof s === "string" && HEX.test(s);

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
/** `t` of the way from `a` to `b`. */
export const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
};
const alpha = (c: string, a: number) => `rgba(${rgb(c).join(", ")}, ${Math.round(a * 1000) / 1000})`;
/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(c: string) {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrastRatio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The CSS variables styles.css colors with, for one palette in one mode. `contrast` (0–100) spreads the text shades
 * and borders further from the background, or pulls them closer.
 */
export function themeVars(p: Palette, mode: Mode, contrast = DEFAULT_CONTRAST): Record<string, string> {
  const k = clamp((contrast - 50) / 50, -1, 1);
  const dark = mode === "dark";
  const extreme = dark ? "#ffffff" : "#000000";
  const bg = p.background;
  const text = k > 0 ? mix(p.text, extreme, 0.5 * k) : mix(p.text, bg, 0.12 * -k);
  const shade = (w: number) => mix(bg, text, clamp(w, 0, 1));
  const lift = dark ? 0 : 0.02; // Light backgrounds need a little more for the same step.
  // Softer goes less far than sharper, so muted text stays readable at the lowest setting.
  const spread = (up: number, down: number) => (k > 0 ? up * k : down * k);
  const onAccent = mix(p.accent, "#000000", 0.88);
  const surfaces = {
    "--bg": bg,
    "--sidebar": dark ? mix(bg, "#000000", 0.1) : mix(bg, "#000000", 0.03),
    "--raised": p.surface,
    "--raised-2": mix(p.surface, text, 0.04 + lift),
    "--raised-3": mix(p.surface, text, 0.09 + lift),
    "--code-bg": dark ? mix(bg, "#000000", 0.2) : mix(bg, text, 0.035),
  };
  const hover2 = 0.07 + lift / 2;
  // Text sits on each surface, and on the selected chat's row: the strongest hover tint over the list panel.
  const under = [...Object.values(surfaces), mix(surfaces["--sidebar"], text, hover2)];
  const faint = Math.max((dark ? 0.335 : 0.42) + spread(0.2, 0.08), readableWeight(shade, under));
  return {
    ...surfaces,
    "--line": alpha(text, 0.07 + 0.04 * k + lift),
    "--line-2": alpha(text, 0.12 + 0.06 * k + lift),
    "--line-3": alpha(text, 0.22 + 0.08 * k),
    "--hover": alpha(text, 0.04 + lift / 2),
    "--hover-2": alpha(text, hover2),
    "--text": text,
    "--text-2": shade(0.89 + 0.08 * k),
    "--text-strong": mix(text, extreme, dark ? 0.45 : 0.6),
    // Never fainter than faint, which the floor may have lifted past muted's own shade.
    "--muted": shade(Math.max((dark ? 0.57 : 0.67) + spread(0.18, 0.1), faint)),
    "--faint": shade(faint),
    "--accent": p.accent,
    "--accent-soft": alpha(p.accent, dark ? 0.16 : 0.12),
    "--on-accent": contrastRatio(onAccent, p.accent) >= contrastRatio("#ffffff", p.accent) ? onAccent : "#ffffff",
    "--on-text": dark ? mix(bg, "#000000", 0.25) : p.surface,
    "--code-inline": mix(text, p.accent, dark ? 0.3 : 0.75),
    "--overlay": alpha(bg, 0.85),
  };
}

/** WCAG AA for body text: the least contrast any text the app shows may have against what it sits on. */
const MIN_TEXT_CONTRAST = 4.5;

/** The least shade weight whose color reads at AA on every surface, or 1 (the text color) if none does. */
function readableWeight(shade: (w: number) => string, surfaces: string[]) {
  for (let w = 0; w < 1; w += 0.01) if (surfaces.every((s) => contrastRatio(shade(w), s) >= MIN_TEXT_CONTRAST)) return w;
  return 1;
}

/** Which mode shows: the scheme picked, or the system's when it's System. */
export const resolveMode = (scheme: Scheme, systemDark: boolean): Mode => (scheme === "system" ? (systemDark ? "dark" : "light") : scheme);

// ---------- custom themes ----------

function parsePalette(x: unknown): Palette | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (!PALETTE_KEYS.every((key) => isHex(o[key]))) return undefined;
  return Object.fromEntries(PALETTE_KEYS.map((key) => [key, (o[key] as string).toLowerCase()])) as Palette;
}

const cleanName = (n: unknown) =>
  typeof n === "string" ? n.replace(/[\0-\x1f\x7f]/g, "").trim().slice(0, MAX_THEME_NAME) : "";

/** A theme from storage or a pasted file, or undefined if it isn't one. The id is kept only if it's a custom one. */
export function parseTheme(x: unknown, newId: () => string): Theme | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const [light, dark, name] = [parsePalette(o.light), parsePalette(o.dark), cleanName(o.name)];
  if (!light || !dark || !name) return undefined;
  const id = typeof o.id === "string" && /^custom-[\w-]{1,40}$/.test(o.id) ? o.id : newId();
  return { id, name, light, dark };
}

/** The theme as JSON to share; `parseTheme` reads it back. */
export const themeJson = (t: Theme) => JSON.stringify({ name: t.name, light: t.light, dark: t.dark }, null, 2);

/** What a pasted theme should be, or why it isn't one. */
export function readThemeJson(text: string, newId: () => string): Theme | "notJson" | "notTheme" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "notJson";
  }
  return parseTheme({ ...(parsed && typeof parsed === "object" ? parsed : {}), id: undefined }, newId) ?? "notTheme";
}

export const newThemeId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** A name not already taken: "Ocean copy", then "Ocean copy 2", and so on. */
export function freeName(base: string, taken: string[]) {
  const name = base.slice(0, MAX_THEME_NAME);
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) {
    const next = `${name.slice(0, MAX_THEME_NAME - String(n).length - 1)} ${n}`;
    if (!taken.includes(next)) return next;
  }
}
