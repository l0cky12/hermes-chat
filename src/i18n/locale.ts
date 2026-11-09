// The interface in one language (#353, ADR 0100): the catalogue's words, the BCP 47 tag dates and numbers are written
// for, and the formatters built for that tag. Components read it with useLocale(); App provides the one the appearance
// store resolves from Settings → Appearance → Language and the desktop's languages.
import { createContext, useContext } from "react";
import { en } from "./en";
import { es } from "./es";

export type Catalogue = typeof en;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => string ? T[K] : DeepPartial<T[K]> };
/** A language's words. A missing one shows in English. */
export type Translation = DeepPartial<Catalogue>;

export const LANGUAGES = {
  en: { name: "English", strings: en },
  es: { name: "Español", strings: es },
} satisfies Record<string, { name: string; strings: Translation }>;
export type LanguageId = keyof typeof LANGUAGES;
/** What the owner picked. System follows the desktop. */
export type LanguageChoice = "system" | LanguageId;

const isLanguage = (v: unknown): v is LanguageId => typeof v === "string" && Object.hasOwn(LANGUAGES, v);
/** A kept choice, or System for anything that isn't one. */
export const parseLanguageChoice = (v: unknown): LanguageChoice => (isLanguage(v) ? v : "system");

/** `t`'s words, with English wherever it has none. */
export function fillFromEnglish(t: Translation): Catalogue {
  const fill = (base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, typeof v === "object" && v ? fill(v as Record<string, unknown>, over?.[k] as Record<string, unknown> | undefined) : (over?.[k] ?? v)]),
    );
  return fill(en, t) as Catalogue;
}

export type Formats = {
  number(n: number): string;
  /** A time of day: 3:45 PM, 15:45. */
  time(ms: number): string;
  dateTime(ms: number): string;
  /** A YYYY-MM-DD day as a date. Read in UTC, so the day never shifts with the time zone. */
  day(isoDay: string): string;
  /** How long ago, in a few characters: "now", "5m", "3h", "2d", "1w". */
  age(ms: number, now?: number): string;
};

/** The interface in one language. `language`, `tag` and `fmt` are names the catalogue can't use. */
export type Locale = Readonly<Catalogue> & { readonly language: LanguageId; readonly tag: string; readonly fmt: Formats };

function formats(tag: string, now: string): Formats {
  const number = new Intl.NumberFormat(tag);
  const time = new Intl.DateTimeFormat(tag, { timeStyle: "short" });
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" });
  const day = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone: "UTC" });
  const unit = (u: string) => new Intl.NumberFormat(tag, { style: "unit", unit: u, unitDisplay: "narrow", useGrouping: false });
  const [minutes, hours, days, weeks] = ["minute", "hour", "day", "week"].map(unit);
  return {
    number: (n) => number.format(n),
    time: (ms) => time.format(ms),
    dateTime: (ms) => dateTime.format(ms),
    day: (isoDay) => day.format(new Date(`${isoDay}T00:00:00Z`)),
    age(ms, at = Date.now()) {
      const s = (at - ms) / 1000;
      if (s < 60) return now;
      if (s < 3600) return minutes.format(Math.floor(s / 60));
      if (s < 86400) return hours.format(Math.floor(s / 3600));
      if (s < 86400 * 7) return days.format(Math.floor(s / 86400));
      return weeks.format(Math.floor(s / (86400 * 7)));
    },
  };
}

const baseOf = (tag: string) => tag.toLowerCase().split("-")[0];
const built = new Map<string, Locale>();

/**
 * The locale for `choice` on a desktop whose languages are `system`, most preferred first. For System, the language is
 * the first system language with a catalogue, else English; its tag is that system tag, or the desktop's first tag when
 * none matched, so dates keep the desktop's format. For a picked language, the tag is the first system tag of that
 * language, else the language itself. The same inputs give the same object.
 */
export function localeFor(choice: LanguageChoice, system: readonly string[]): Locale {
  let language: LanguageId;
  let tag: string;
  if (choice === "system") {
    const hit = system.find((t) => isLanguage(baseOf(t)));
    language = hit ? (baseOf(hit) as LanguageId) : "en";
    tag = hit ?? system[0] ?? "en";
  } else {
    language = choice;
    tag = system.find((t) => baseOf(t) === choice) ?? choice;
  }
  const key = `${language}|${tag}`;
  let locale = built.get(key);
  if (!locale) {
    const strings = fillFromEnglish(LANGUAGES[language].strings);
    locale = { ...strings, language, tag, fmt: formats(tag, strings.time.now) };
    built.set(key, locale);
  }
  return locale;
}

/** <html lang>: the tag when its words are in that tag's language, else the language (English words on a German desktop). */
export const htmlLang = (l: Locale) => (baseOf(l.tag) === l.language ? l.tag : l.language);

/** The desktop's languages, most preferred first, and word when they change. */
export type SystemLanguages = { tags(): readonly string[]; subscribe(fn: () => void): () => void };

/** As WebKitGTK reports them; a tag Intl can't read is left out, since every formatter is built from one. */
export function systemLanguages(
  win: Pick<Window, "navigator" | "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): SystemLanguages {
  const canonical = (t: string) => {
    try {
      return Intl.getCanonicalLocales(t);
    } catch {
      return [];
    }
  };
  return {
    tags: () => {
      const nav = win?.navigator;
      return (nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []).flatMap(canonical);
    },
    subscribe(fn) {
      win?.addEventListener("languagechange", fn);
      return () => win?.removeEventListener("languagechange", fn);
    },
  };
}

/** English, tagged "en", where nothing provides a locale. */
export const LocaleContext = createContext<Locale>(localeFor("en", []));
export const useLocale = (): Locale => useContext(LocaleContext);
