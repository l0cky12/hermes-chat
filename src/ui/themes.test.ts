// Themes: the colors worked out from a theme's four, what contrast does to them, and reading a pasted theme.
import { describe, expect, it } from "vitest";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";
import { BUILTIN_THEMES, contrastRatio, freeName, parseTheme, readThemeJson, resolveMode, themeJson, themeVars } from "./themes";

const newId = () => "custom-new";
const hermes = BUILTIN_THEMES[0];

describe("Theme colors", () => {
  it("are the stylesheet's original colors for Hermes in dark at the default contrast", () => {
    expect(themeVars(hermes.dark, "dark")).toMatchObject({
      "--bg": "#1b1c20",
      "--sidebar": "#18191d",
      "--raised": "#222328",
      "--text": "#d6d7dc",
      "--muted": "#86878b",
      "--faint": "#5a5b5f",
      "--accent": "#d08b6e",
      "--code-bg": "#16161a",
      "--text-strong": "#e8e9ec",
    });
  });

  it("keep every built-in theme's text, muted text and accent readable on its background in both modes", () => {
    for (const theme of BUILTIN_THEMES)
      for (const mode of ["light", "dark"] as const) {
        const v = themeVars(theme[mode], mode);
        expect(contrastRatio(v["--text"], v["--bg"]), `${theme.name} ${mode} text`).toBeGreaterThan(10);
        expect(contrastRatio(v["--muted"], v["--bg"]), `${theme.name} ${mode} muted`).toBeGreaterThan(4.5);
        // Section labels and shortcut hints are muted text on the list panel.
        expect(contrastRatio(v["--muted"], v["--sidebar"]), `${theme.name} ${mode} muted on the list`).toBeGreaterThan(4.5);
        expect(contrastRatio(v["--accent"], v["--bg"]), `${theme.name} ${mode} accent`).toBeGreaterThan(4.5);
        expect(contrastRatio(v["--on-accent"], v["--accent"]), `${theme.name} ${mode} on accent`).toBeGreaterThan(4.5);
      }
  });

  it("spread further from the background as contrast goes up, and stay readable at the lowest", () => {
    for (const mode of ["light", "dark"] as const) {
      const at = (c: number) => themeVars(hermes[mode], mode, c);
      const ratio = (c: number, key: string) => contrastRatio(at(c)[key], at(c)["--bg"]);
      for (const key of ["--text", "--muted", "--faint"]) {
        expect(ratio(0, key)).toBeLessThan(ratio(50, key));
        expect(ratio(50, key)).toBeLessThan(ratio(100, key));
      }
      expect(ratio(0, "--muted")).toBeGreaterThan(2.8);
    }
  });

  it("color shortcut hints and section labels with muted text, which the checks above keep readable", () => {
    // A later rule of the same selector would win in the browser; jsdom doesn't apply the stylesheet, so read it.
    const css: string = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    for (const selector of ["kbd", ".section-label"]) {
      const rules = [...css.matchAll(/^([^{}\n]+)\{([^}]*)\}/gm)].filter((m) => m[1].split(",").map((s: string) => s.trim()).includes(selector));
      const colors = rules.flatMap((m) => [...m[2].matchAll(/(?:^|[;\s])color:\s*([^;]+)/g)].map((c) => c[1].trim()));
      expect(colors, selector).toEqual(["var(--muted)"]);
    }
  });

  it("follow the system's mode only for System", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});

describe("Custom themes", () => {
  const theme = { id: "custom-a1", name: "Mine", light: { ...hermes.light }, dark: { ...hermes.dark } };

  it("read back as they were kept, colors lowercased", () => {
    expect(parseTheme({ ...theme, dark: { ...theme.dark, accent: "#ABCDEF" } }, newId)).toEqual({
      ...theme,
      dark: { ...theme.dark, accent: "#abcdef" },
    });
  });

  it("are refused without a name or with a color that isn't #rrggbb", () => {
    expect(parseTheme({ ...theme, name: "  " }, newId)).toBeUndefined();
    expect(parseTheme({ ...theme, light: { ...theme.light, text: "red" } }, newId)).toBeUndefined();
    expect(parseTheme({ ...theme, dark: { ...theme.dark, surface: "#fff" } }, newId)).toBeUndefined();
    expect(parseTheme({ name: "No modes" }, newId)).toBeUndefined();
    expect(parseTheme("theme", newId)).toBeUndefined();
  });

  it("get a new id unless theirs is a custom one", () => {
    expect(parseTheme({ ...theme, id: "hermes" }, newId)?.id).toBe("custom-new");
    expect(parseTheme({ ...theme, id: undefined }, newId)?.id).toBe("custom-new");
  });

  it("go out as JSON and come back in, under a new id", () => {
    expect(readThemeJson(themeJson(theme), newId)).toEqual({ ...theme, id: "custom-new" });
  });

  it("say what's wrong with pasted text that isn't a theme", () => {
    expect(readThemeJson("{nope", newId)).toBe("notJson");
    expect(readThemeJson('{"name": "x"}', newId)).toBe("notTheme");
  });

  it("are named so no two share a name", () => {
    expect(freeName("Ocean copy", ["Ocean"])).toBe("Ocean copy");
    expect(freeName("Ocean copy", ["Ocean copy", "Ocean copy 2"])).toBe("Ocean copy 3");
  });
});
