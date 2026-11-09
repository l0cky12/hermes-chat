// The language and tag a choice resolves to, English filling a translation's gaps, and the formats each locale writes.
import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import { en } from "./en";
import { LANGUAGES, fillFromEnglish, htmlLang, localeFor, parseLanguageChoice, systemLanguages, type LanguageChoice } from "./locale";

describe("A language choice", () => {
  it.each<[LanguageChoice, string[], string, string, string]>([
    // choice, desktop languages → language, tag, <html lang>
    ["system", ["es-MX", "en-US"], "es", "es-MX", "es-MX"],
    ["system", ["de-DE", "en-GB"], "en", "en-GB", "en-GB"],
    ["system", ["de-DE"], "en", "de-DE", "en"],
    ["system", [], "en", "en", "en"],
    ["es", ["en-GB"], "es", "es", "es"],
    ["es", ["en-GB", "es-AR"], "es", "es-AR", "es-AR"],
    ["en", ["es-MX", "en-US"], "en", "en-US", "en-US"],
    ["en", ["fr-FR"], "en", "en", "en"],
  ])("%s on %j is %s, tagged %s, <html lang> %s", (choice, system, language, tag, lang) => {
    const l = localeFor(choice, system);
    expect([l.language, l.tag, htmlLang(l)]).toEqual([language, tag, lang]);
  });

  it("gives the same locale for the same inputs, so React sees no change", () => {
    expect(localeFor("system", ["es-MX"])).toBe(localeFor("es", ["es-MX"]));
    expect(localeFor("es", ["es-MX"])).not.toBe(localeFor("es", []));
  });

  it("reads a kept choice, and anything else as System", () => {
    expect([parseLanguageChoice("es"), parseLanguageChoice("en"), parseLanguageChoice("fr"), parseLanguageChoice(undefined), parseLanguageChoice("toString")]).toEqual([
      "es",
      "en",
      "system",
      "system",
      "system",
    ]);
  });
});

describe("A partial translation", () => {
  it("shows English for every word it lacks", () => {
    const filled = fillFromEnglish({ appearance: { fonts: { title: "Polices" }, themes: { use: (n) => `Utiliser ${n}` } } });
    expect(filled.appearance.fonts.title).toBe("Polices");
    expect(filled.appearance.fonts.ui).toBe("Interface font");
    expect(filled.appearance.themes.use("Ocean")).toBe("Utiliser Ocean");
    expect(filled.appearance.themes.delete("Ocean")).toBe("Delete Ocean");
    expect(filled.settings).toEqual(en.settings);
  });
});

describe("Formats", () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const ago = (s: number) => now - s * 1000;

  it("write an age the way the chat list always has in English, and in Spanish's own short units", () => {
    const english = localeFor("en", []).fmt;
    const spanish = localeFor("es", []).fmt;
    const ages = [5, 59, 60, 5 * 60, 3599, 3 * 3600, 2 * 86400, 7 * 86400, 20 * 86400, -30];
    expect(ages.map((s) => english.age(ago(s), now))).toEqual(["now", "now", "1m", "5m", "59m", "3h", "2d", "1w", "2w", "now"]);
    expect(ages.map((s) => spanish.age(ago(s), now))).toEqual(["ahora", "ahora", "1min", "5min", "59min", "3h", "2d", "1sem", "2sem", "ahora"]);
  });

  it("write a day as the same date in every time zone", () => {
    expect(localeFor("en", ["en-US"]).fmt.day("2026-11-03")).toBe("Nov 3, 2026");
    expect(localeFor("es", ["es-ES"]).fmt.day("2026-01-01")).toBe("1 ene 2026");
  });

  it("write numbers for the tag", () => {
    expect(localeFor("en", []).fmt.number(12345)).toBe("12,345");
    expect(localeFor("es", []).fmt.number(12345)).toBe("12.345");
  });
});

describe("The languages", () => {
  it("are each named in the README's Languages list", () => {
    const section = readme.split("\n### Languages\n")[1].split("\n### ")[0];
    const listed = [...section.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(listed).toEqual(Object.values(LANGUAGES).map((l) => l.name));
  });
});

describe("The desktop's languages", () => {
  it("are what the webview reports, without a tag Intl can't read, and word comes when they change", () => {
    const target = new EventTarget();
    const win = {
      navigator: { languages: ["es-mx", "not a tag", "en"], language: "es-mx" } as unknown as Navigator,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    };
    const system = systemLanguages(win);
    expect(system.tags()).toEqual(["es-MX", "en"]);
    let heard = 0;
    const stop = system.subscribe(() => heard++);
    target.dispatchEvent(new Event("languagechange"));
    stop();
    target.dispatchEvent(new Event("languagechange"));
    expect(heard).toBe(1);
  });
});
