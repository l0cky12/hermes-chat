// @vitest-environment jsdom
// Appearance settings: what is kept, what reaches the page as CSS, and the Settings section driving both.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettingsApi } from "../hermes/modelSettings";
import { DEFAULT_APPEARANCE, UI_SIZES, appearanceStore, cssFamily, loadAppearance } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingsScreen } from "./Settings";
import { BUILTIN_THEMES } from "./themes";

const KEY = "hermes-chat.appearance";

function memoryStorage(saved?: unknown) {
  const items = new Map<string, string>();
  if (saved !== undefined) items.set(KEY, typeof saved === "string" ? saved : JSON.stringify(saved));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

afterEach(cleanup);

describe("Kept appearance", () => {
  it("is the default when nothing, or nothing readable, is kept", () => {
    expect(loadAppearance(memoryStorage())).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(memoryStorage("{not json"))).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(memoryStorage("null"))).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps the owner's choices and puts anything not on offer back to its default", () => {
    const kept = { ...DEFAULT_APPEARANCE, uiFont: "Noto Sans", uiSize: 16, monoFont: "Fira Code", monoSize: 15, wordWrap: true };
    expect(loadAppearance(memoryStorage(kept))).toEqual(kept);
    expect(loadAppearance(memoryStorage({ uiFont: 3, uiSize: 99, monoFont: "a\nb", monoSize: "13", wordWrap: "yes" }))).toEqual(DEFAULT_APPEARANCE);
  });

  it("survives a restart", () => {
    const storage = memoryStorage();
    appearanceStore(storage, document.createElement("html")).set({ monoFont: "Fira Code", wordWrap: true });
    expect(appearanceStore(storage, document.createElement("html")).get()).toMatchObject({ monoFont: "Fira Code", wordWrap: true });
  });
});

describe("Applied appearance", () => {
  it("sets the root's fonts, sizes and wrapping, and removes a font set back to the default", () => {
    const root = document.createElement("html");
    const store = appearanceStore(memoryStorage(), root);
    expect(root.style.fontSize).toBe("14px");
    expect(root.style.getPropertyValue("--mono-size")).toBe("13px");
    expect(root.style.getPropertyValue("--ui-font")).toBe("");
    expect(root.classList.contains("wrap-code")).toBe(false);

    store.set({ uiFont: "Noto Sans", uiSize: 17, monoSize: 15, wordWrap: true });
    expect(root.style.fontSize).toBe("17px");
    expect(root.style.getPropertyValue("--ui-font")).toBe('"Noto Sans"');
    expect(root.style.getPropertyValue("--mono-size")).toBe("15px");
    expect(root.classList.contains("wrap-code")).toBe(true);

    store.set({ uiFont: "", wordWrap: false });
    expect(root.style.getPropertyValue("--ui-font")).toBe("");
    expect(root.classList.contains("wrap-code")).toBe(false);
  });

  it("scales icons with the interface size, leaving them as drawn at the default", () => {
    const root = document.createElement("html");
    const store = appearanceStore(memoryStorage(), root);
    expect(root.style.getPropertyValue("--ui-scale")).toBe("1");
    for (const uiSize of UI_SIZES) {
      store.set({ uiSize });
      // A 14px icon is as big as 14px text at this size.
      expect(14 * Number(root.style.getPropertyValue("--ui-scale"))).toBeCloseTo(uiSize, 6);
    }
  });

  it("quotes a family name so quotes and backslashes in it stay part of the name", () => {
    expect(cssFamily('Odd "Font" \\ Name')).toBe('"Odd \\"Font\\" \\\\ Name"');
  });
});

describe("Settings, Appearance", () => {
  const fonts = async () => ({ all: ["Fira Code", "Noto Sans"], mono: ["Fira Code"] });

  function shown(saved?: unknown) {
    const storage = memoryStorage(saved);
    const root = document.createElement("html");
    const store = appearanceStore(storage, root);
    render(<AppearanceSettings store={store} listFonts={fonts} />);
    return { storage, root, store };
  }

  it("lists the installed fonts, monospace ones first for code", async () => {
    shown();
    const code = screen.getByRole<HTMLSelectElement>("combobox", { name: "Code font" });
    await screen.findAllByRole("option", { name: "Noto Sans" });
    expect([...code.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)])).toEqual([
      ["Monospace", ["Fira Code"]],
      ["Other fonts", ["Noto Sans"]],
    ]);
  });

  it("applies and keeps a font and size as soon as they're picked", async () => {
    const { root, storage } = shown();
    await screen.findAllByRole("option", { name: "Noto Sans" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface font" }), "Noto Sans");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Code font size" }), "16");
    expect(root.style.getPropertyValue("--ui-font")).toBe('"Noto Sans"');
    expect(root.style.getPropertyValue("--mono-size")).toBe("16px");
    expect(JSON.parse(storage.items.get(KEY)!)).toMatchObject({ uiFont: "Noto Sans", monoSize: 16 });
  });

  it("keeps a saved font listed after it's uninstalled", () => {
    shown({ uiFont: "Gone Sans" });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Interface font" }).value).toBe("Gone Sans");
  });

  it("resets a font row to the default, and offers the reset only when it differs", async () => {
    const { store } = shown({ monoFont: "Fira Code", monoSize: 18 });
    expect(screen.queryByRole("button", { name: "Reset interface font" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset code font" }));
    expect(store.get()).toMatchObject({ monoFont: "", monoSize: 13 });
    expect(screen.queryByRole("button", { name: "Reset code font" })).toBeNull();
  });

  it("turns Word wrap on and off", async () => {
    const { root } = shown();
    const wrap = screen.getByRole("switch", { name: "Word wrap" });
    expect(wrap.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(wrap);
    expect(wrap.getAttribute("aria-checked")).toBe("true");
    expect(root.classList.contains("wrap-code")).toBe(true);
    await userEvent.click(wrap);
    expect(root.classList.contains("wrap-code")).toBe(false);
  });
});

describe("Settings, Appearance as cards of rows (#174, ADR 0059)", () => {
  const fonts = async () => ({ all: [], mono: [] });
  const shown = (saved?: unknown) => render(<AppearanceSettings store={appearanceStore(memoryStorage(saved), document.createElement("html"))} listFonts={fonts} />);
  const section = (heading: string) => screen.getByRole("heading", { name: heading, level: 2 }).closest("section")!;
  /** The row a setting's name heads. */
  const row = (name: string) => [...document.querySelectorAll(".set-row")].find((r) => r.querySelector(".set-name")?.textContent === name)!;

  it("draws each section as a heading and a card, each setting as a row with its control on the right, and the gallery and previews as blocks", () => {
    shown({ contrast: 70, uiSize: 16 });
    for (const h of ["Color scheme", "Themes", "Layout and contrast", "Fonts"]) {
      expect(section(h).classList.contains("set-section"), h).toBe(true);
      expect(section(h).querySelector(":scope > .set-card"), h).toBeTruthy();
    }
    const controls: [string, HTMLElement][] = [
      ["Contrast", screen.getByRole("slider", { name: "Contrast" })],
      ["Chat width", screen.getByRole("slider", { name: "Chat width" })],
      ["Interface font", screen.getByRole("combobox", { name: "Interface font" })],
      ["Interface font", screen.getByRole("combobox", { name: "Interface font size" })],
      ["Interface font", screen.getByRole("button", { name: "Reset interface font" })],
      ["Contrast", screen.getByRole("button", { name: "Reset contrast" })],
      ["Code font", screen.getByRole("combobox", { name: "Code font" })],
      ["Word wrap", screen.getByRole("switch", { name: "Word wrap" })],
      ["Status bar", screen.getByRole("switch", { name: "Status bar" })],
    ];
    for (const [name, control] of controls) expect(row(name).querySelector(".set-control")!.contains(control), name).toBe(true);
    expect(within(section("Layout and contrast")).getAllByText(/./, { selector: ".set-name" }).map((n) => n.textContent)).toEqual(["Contrast", "Chat width"]);
    // The section's buttons sit at its heading's end; the gallery, the theme cards and the previews are free-form blocks in the card.
    expect(screen.getByRole("button", { name: "Create theme" }).closest(".set-head")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Color scheme" }).closest(".set-card .set-block")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Ocean" }).closest(".set-card .set-block")).toBeTruthy();
    expect(section("Fonts").querySelectorAll(".set-card > .set-block .appearance-preview")).toHaveLength(2);
    // The scheme's one line shows under its heading.
    expect(within(section("Color scheme")).getByText("System follows your desktop's light or dark setting.").className).toBe("set-intro");
  });

  it("folds how to pick the status bar's items behind an (i) that isn't part of the switch's name", async () => {
    shown();
    const about = screen.getByRole("button", { name: "About Status bar" });
    const help = document.getElementById(about.getAttribute("aria-controls")!)!;
    expect(about.getAttribute("aria-expanded")).toBe("false");
    expect(help.hidden).toBe(true);
    expect(help.textContent).toMatch(/Right-click the bar to pick what it shows/);
    expect(screen.getByRole("switch", { name: "Status bar" }).getAttribute("aria-describedby")).toBe("status-bar-help");
    expect(document.getElementById("status-bar-help")!.textContent).toBe("Context, model and connection under the chat.");
    await userEvent.click(about);
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(help.hidden).toBe(false);
  });

  it("never folds a theme editor's problem or a delete's confirmation", async () => {
    const [ocean] = BUILTIN_THEMES;
    shown({ customThemes: [{ id: "mine", name: "Mine", light: ocean.light, dark: ocean.dark }] });
    expect(document.querySelectorAll(".set-more")).toHaveLength(1); // the status bar's, and only it
    await userEvent.click(screen.getByRole("button", { name: "Duplicate Ocean" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Theme name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Theme name" }), "Mine");
    expect(screen.getByText("Another theme is already called that.").closest(".set-more")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Mine" }));
    expect(screen.getByText("Delete Mine?").closest(".set-more, [hidden]")).toBeNull();
  });

  it("is found by Settings search through the status bar's folded help, which opens while searching", async () => {
    const user = userEvent.setup();
    render(
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="liam"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={appearanceStore(memoryStorage(), document.createElement("html"))}
        listFonts={fonts}
        modelSettings={new ModelSettingsApi(async () => Promise.reject(new Error("Not connected to Hermes.")), () => "default")}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />,
    );
    const help = () => document.getElementById(screen.getByRole("button", { name: "About Status bar" }).getAttribute("aria-controls")!)!;
    // Only the folded help says this.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "turning it on here");
    const showing = (h: string) => !screen.getByRole("heading", { name: h, level: 2 }).closest("[data-search-miss]");
    expect(showing("Fonts")).toBe(true);
    expect(showing("Color scheme")).toBe(false);
    expect(help().hidden).toBe(false);
  });
});
