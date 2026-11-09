// How the app looks on this computer: the color scheme and theme (themes.ts), contrast, how wide chats grow, the
// interface and code fonts and their sizes, whether code blocks wrap long lines, and the interface language. Kept in localStorage and applied to the root element as CSS variables (styles.css), so it holds from launch,
// sign-in screen included. Nothing here goes to Hermes.

import {
  BUILTIN_THEMES,
  DEFAULT_CONTRAST,
  DEFAULT_THEME_ID,
  newThemeId,
  parseTheme,
  resolveMode,
  themeVars,
  type Mode,
  type Scheme,
  type Theme,
} from "./themes";
import { htmlLang, localeFor, parseLanguageChoice, systemLanguages, type LanguageChoice, type Locale, type SystemLanguages } from "../i18n/locale";

/**
 * An empty font is the app's own default. Sizes are in CSS pixels. `themeId` is a built-in theme's or one of
 * `customThemes`. `contrast` runs 0–100. `chatWidth` is one of CHAT_WIDTHS, 0 being the full width of the window.
 */
export type Appearance = {
  scheme: Scheme;
  themeId: string;
  customThemes: Theme[];
  contrast: number;
  chatWidth: number;
  uiFont: string;
  uiSize: number;
  monoFont: string;
  monoSize: number;
  wordWrap: boolean;
  language: LanguageChoice;
};

export const DEFAULT_APPEARANCE: Appearance = {
  scheme: "dark",
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  contrast: DEFAULT_CONTRAST,
  chatWidth: 740,
  uiFont: "",
  uiSize: 14,
  monoFont: "",
  monoSize: 13,
  wordWrap: false,
  language: "system",
};
export const CHAT_WIDTHS = [600, 680, 740, 820, 900, 1000, 1100, 1200, 0];
/** More than anyone needs; the editor stops offering new themes here. */
export const MAX_CUSTOM_THEMES = 50;
export const UI_SIZES = [12, 13, 14, 15, 16, 17, 18, 20];
export const MONO_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];

export const APPEARANCE_KEY = "hermes-chat.appearance";
const KEY = APPEARANCE_KEY;
/** Longer than any real family name; anything past it is not a font. */
const MAX_FONT = 120;

export type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

/** A family name as fc-list gives it, or empty: no control characters, trimmed. */
const cleanFont = (f: unknown): string => (typeof f === "string" && f.length <= MAX_FONT && !/[\0-\x1f\x7f]/.test(f) ? f.trim() : "");
const pickSize = (n: unknown, sizes: number[], fallback: number) => (typeof n === "number" && sizes.includes(n) ? n : fallback);

/** What `storage` holds, with anything missing or not one of the choices back at its default. */
export function loadAppearance(storage: AppearanceStorage): Appearance {
  let saved: Partial<Record<keyof Appearance, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // Unreadable: the defaults.
  }
  const d = DEFAULT_APPEARANCE;
  const customThemes = (Array.isArray(saved.customThemes) ? saved.customThemes : [])
    .slice(0, MAX_CUSTOM_THEMES)
    .map((t) => parseTheme(t, newThemeId))
    .filter((t): t is Theme => !!t)
    .filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i);
  const themeIds = [...BUILTIN_THEMES, ...customThemes].map((t) => t.id);
  return {
    scheme: saved.scheme === "system" || saved.scheme === "light" || saved.scheme === "dark" ? saved.scheme : d.scheme,
    themeId: typeof saved.themeId === "string" && themeIds.includes(saved.themeId) ? saved.themeId : d.themeId,
    customThemes,
    contrast: typeof saved.contrast === "number" && Number.isInteger(saved.contrast) && saved.contrast >= 0 && saved.contrast <= 100 ? saved.contrast : d.contrast,
    chatWidth: pickSize(saved.chatWidth, CHAT_WIDTHS, d.chatWidth),
    uiFont: cleanFont(saved.uiFont),
    uiSize: pickSize(saved.uiSize, UI_SIZES, d.uiSize),
    monoFont: cleanFont(saved.monoFont),
    monoSize: pickSize(saved.monoSize, MONO_SIZES, d.monoSize),
    wordWrap: typeof saved.wordWrap === "boolean" ? saved.wordWrap : d.wordWrap,
    language: parseLanguageChoice(saved.language),
  };
}

/** A family name as a CSS string, so a name with quotes or backslashes stays one name. */
export const cssFamily = (font: string) => `"${font.replace(/["\\]/g, "\\$&")}"`;

/** The theme `a` names; the default if it's gone. */
export const themeOf = (a: Appearance): Theme =>
  [...BUILTIN_THEMES, ...a.customThemes].find((t) => t.id === a.themeId) ?? BUILTIN_THEMES[0];

/**
 * Sets the CSS variables styles.css reads, for the mode showing, and the root's lang for the locale. The app's default
 * fonts stay as fallbacks behind a chosen one.
 */
export function applyAppearance(a: Appearance, root: HTMLElement, mode: Mode = resolveMode(a.scheme, true), locale: Locale = localeFor(a.language, [])) {
  const theme = themeOf(a);
  for (const [name, value] of Object.entries(themeVars(theme[mode], mode, a.contrast))) root.style.setProperty(name, value);
  root.dataset.mode = mode;
  root.style.setProperty("--chat-width", a.chatWidth ? `${a.chatWidth}px` : "100vw");
  const font = (name: string, value: string) => (value ? root.style.setProperty(name, cssFamily(value)) : root.style.removeProperty(name));
  font("--ui-font", a.uiFont);
  font("--mono-font", a.monoFont);
  root.style.fontSize = `${a.uiSize}px`;
  root.style.setProperty("--mono-size", `${a.monoSize}px`);
  root.classList.toggle("wrap-code", a.wordWrap);
  root.lang = htmlLang(locale);
}

/** Whether the system prefers dark, and word when that changes. */
export type SystemDark = { matches: () => boolean; subscribe: (fn: () => void) => () => void };

/** The desktop's light or dark preference, as WebKitGTK reports it. Dark where it can't tell. */
export function prefersDark(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): SystemDark {
  const query = win?.matchMedia?.("(prefers-color-scheme: dark)");
  if (!query) return { matches: () => true, subscribe: () => () => {} };
  return {
    matches: () => query.matches,
    subscribe(fn) {
      query.addEventListener("change", fn);
      return () => query.removeEventListener("change", fn);
    },
  };
}

export type AppearanceStore = {
  get(): Appearance;
  /** The mode showing: the scheme's, or the system's for System. */
  mode(): Mode;
  /** The interface's language: the one picked, or the desktop's for System. `choice` asks what another choice gives. */
  locale(choice?: LanguageChoice): Locale;
  /** Applies the change at once and keeps it. */
  set(change: Partial<Appearance>): void;
  subscribe(fn: () => void): () => void;
};

/** The appearance kept in `storage`, applied to `root` now and on every change. */
export function appearanceStore(
  storage: AppearanceStorage,
  root: HTMLElement,
  system: SystemDark = prefersDark(),
  languages: SystemLanguages = systemLanguages(),
): AppearanceStore {
  let current = loadAppearance(storage);
  const listeners = new Set<() => void>();
  const mode = () => resolveMode(current.scheme, system.matches());
  const locale = (choice = current.language) => localeFor(choice, languages.tags());
  const apply = () => applyAppearance(current, root, mode(), locale());
  apply();
  // Follows the desktop's dark switch while System is picked, and its languages, which a picked language takes its
  // date format from too. Lives as long as the app.
  system.subscribe(() => {
    if (current.scheme !== "system") return;
    apply();
    listeners.forEach((fn) => fn());
  });
  languages.subscribe(() => {
    apply();
    listeners.forEach((fn) => fn());
  });
  return {
    get: () => current,
    mode,
    locale,
    set(change) {
      current = { ...current, ...change };
      apply();
      try {
        storage.setItem(KEY, JSON.stringify(current));
      } catch {
        // Kept until the app closes.
      }
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** The font families installed on this computer; `mono` are the fixed-width ones. */
export type Fonts = { all: string[]; mono: string[] };
