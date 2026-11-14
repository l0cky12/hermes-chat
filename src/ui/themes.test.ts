// Themes: the colors worked out from a theme's four, what contrast does to them, and reading a pasted theme.
import { describe, expect, it } from "vitest";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";
import { BUILTIN_THEMES, contrastRatio, freeName, mix, parseTheme, readThemeJson, resolveMode, themeJson, themeVars } from "./themes";

const newId = () => "custom-new";
const hermes = BUILTIN_THEMES[0];

describe("Theme colors", () => {
  it("are the stylesheet's original colors for Hermes in dark at the default contrast, muted and faint text lifted to AA", () => {
    expect(themeVars(hermes.dark, "dark")).toMatchObject({
      "--bg": "#1b1c20",
      "--sidebar": "#18191d",
      "--raised": "#222328",
      "--text": "#d6d7dc",
      "--muted": "#9a9ba0",
      "--faint": "#9a9ba0",
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
        expect(ratio(0, key)).toBeLessThanOrEqual(ratio(50, key));
        expect(ratio(0, key)).toBeLessThan(ratio(100, key));
      }
      expect(ratio(0, "--text")).toBeLessThan(ratio(50, "--text"));
      expect(ratio(50, "--text")).toBeLessThan(ratio(100, "--text"));
    }
  });

  // What text sits on: the page, the list panel, cards and their two raised steps, code blocks, and the selected chat
  // in the list (the strongest hover tint over the list panel).
  const surfaces = (v: Record<string, string>) => {
    const [r, g, b, a] = v["--hover-2"].match(/[\d.]+/g)!.map(Number);
    const tint = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    return {
      ...Object.fromEntries(["--bg", "--sidebar", "--raised", "--raised-2", "--raised-3", "--code-bg"].map((key) => [key, v[key]])),
      "selected chat row": mix(v["--sidebar"], tint, a),
    };
  };
  const readableEverywhere = (contrast: number) => {
    for (const theme of BUILTIN_THEMES)
      for (const mode of ["light", "dark"] as const) {
        const v = themeVars(theme[mode], mode, contrast);
        for (const key of ["--faint", "--muted"])
          for (const [on, surface] of Object.entries(surfaces(v)))
            expect(contrastRatio(v[key], surface), `${theme.name} ${mode} ${key} on ${on} at contrast ${contrast}`).toBeGreaterThanOrEqual(4.5);
      }
  };

  it("keep faint and muted text at AA on every surface at the lowest contrast", () => readableEverywhere(0));
  it("keep faint and muted text at AA on every surface at the highest contrast", () => readableEverywhere(100));
  it("keep faint and muted text at AA on every surface at every contrast setting", () => {
    for (let c = 0; c <= 100; c++) readableEverywhere(c);
  });

  it("keep faint and muted text at AA for a custom palette whose own text is too faint", () => {
    const dim = { background: "#000000", surface: "#000000", text: "#555555", accent: "#d08b6e" };
    const light = { background: "#ffffff", surface: "#ffffff", text: "#aaaaaa", accent: "#d08b6e" };
    for (const [palette, mode] of [[dim, "dark"], [light, "light"]] as const)
      for (const c of [0, 50, 100]) {
        const v = themeVars(palette, mode, c);
        for (const key of ["--faint", "--muted"])
          for (const [on, surface] of Object.entries(surfaces(v)))
            expect(contrastRatio(v[key], surface), `${mode} ${key} on ${on} at contrast ${c}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("go toward black for a dark-mode palette on a mid grey, where black stands out more than white", () => {
    // Dark mode darkens code blocks to #6d6d6d, where black reaches 4.06:1 and nothing reaches AA on both it and #888.
    const grey = { background: "#888888", surface: "#888888", text: "#999999", accent: "#d08b6e" };
    for (const c of [0, 50, 100]) {
      const v = themeVars(grey, "dark", c);
      for (const key of ["--bg", "--sidebar", "--raised", "--raised-2", "--raised-3"])
        expect(contrastRatio(v["--faint"], v[key]), `${key} at contrast ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never draw muted text fainter than faint text", () => {
    for (const theme of BUILTIN_THEMES)
      for (const mode of ["light", "dark"] as const)
        for (const c of [0, 25, 50, 75, 100]) {
          const v = themeVars(theme[mode], mode, c);
          expect(contrastRatio(v["--muted"], v["--bg"])).toBeGreaterThanOrEqual(contrastRatio(v["--faint"], v["--bg"]));
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
