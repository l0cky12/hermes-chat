// @vitest-environment jsdom
// Settings in three tabs, and the Appearance tab's color scheme, themes, theme editor, contrast and chat width.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettingsApi } from "../hermes/modelSettings";
import { appearanceStore, loadAppearance, type SystemDark } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingsScreen } from "./Settings";
import { BUILTIN_THEMES, themeJson } from "./themes";

const KEY = "hermes-chat.appearance";

function memoryStorage(saved?: unknown) {
  const items = new Map<string, string>();
  if (saved !== undefined) items.set(KEY, JSON.stringify(saved));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

/** A desktop whose light or dark preference the test flips. */
function desktop(dark: boolean) {
  const listeners = new Set<() => void>();
  const system: SystemDark & { flip: (d: boolean) => void } = {
    matches: () => dark,
    subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    flip: (d) => {
      dark = d;
      listeners.forEach((fn) => fn());
    },
  };
  return system;
}

const fonts = async () => ({ all: [], mono: [] });

function shown(saved?: unknown, system = desktop(true)) {
  const storage = memoryStorage(saved);
  const root = document.createElement("html");
  const store = appearanceStore(storage, root, system);
  render(<AppearanceSettings store={store} listFonts={fonts} />);
  return { storage, root, store, system };
}

const kept = (storage: ReturnType<typeof memoryStorage>) => loadAppearance(storage);
const accent = (root: HTMLElement) => root.style.getPropertyValue("--accent");

afterEach(cleanup);

describe("Settings tabs", () => {
  function settings() {
    const store = appearanceStore(memoryStorage(), document.createElement("html"), desktop(true));
    render(
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="liam"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={store}
        listFonts={fonts}
        modelSettings={new ModelSettingsApi(async () => Promise.reject(new Error("Not connected to Hermes.")), () => "default")}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />,
    );
  }

  it("open on General, with the connection, cache and history", () => {
    settings();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Connection in use" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Color scheme" })).toBeNull();
  });

  it("move with the arrow keys, Home and End, with only the selected tab in the Tab order", async () => {
    settings();
    const [general, appearance, keyboard, model] = screen.getAllByRole("tab");
    expect([general.tabIndex, appearance.tabIndex, keyboard.tabIndex, model.tabIndex]).toEqual([0, -1, -1, -1]);
    general.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(appearance.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(appearance);
    expect([general.tabIndex, appearance.tabIndex, keyboard.tabIndex, model.tabIndex]).toEqual([-1, 0, -1, -1]);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(keyboard);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(model);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(general);
    await userEvent.keyboard("{End}");
    expect(model.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Home}");
    expect(general.getAttribute("aria-selected")).toBe("true");
  });

  it("show the appearance settings, and only them, on Appearance", async () => {
    settings();
    await userEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Color scheme" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fonts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connection in use" })).toBeNull();
  });
});

describe("Color scheme", () => {
  it("is Dark until picked, and Light switches the app to the theme's light colors", async () => {
    const { root, storage } = shown();
    expect(root.dataset.mode).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(root.dataset.mode).toBe("light");
    expect(root.style.getPropertyValue("--bg")).toBe(BUILTIN_THEMES[0].light.background);
    expect(kept(storage).scheme).toBe("light");
  });

  it("moves with the arrow keys like a radio group", async () => {
    const { root } = shown();
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    dark.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(root.dataset.mode).toBe("light");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  });

  it("follows the desktop while System is picked", async () => {
    const { root, system } = shown();
    await userEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(root.dataset.mode).toBe("dark");
    system.flip(false);
    expect(root.dataset.mode).toBe("light");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    system.flip(true);
    system.flip(false);
    expect(root.dataset.mode).toBe("dark");
  });
});

describe("Themes", () => {
  it("apply when picked; a sphere picks the theme and its mode", async () => {
    const { root, storage } = shown();
    await userEvent.click(screen.getByRole("button", { name: "Use Ocean" }));
    expect(accent(root)).toBe(BUILTIN_THEMES[1].dark.accent);
    await userEvent.click(screen.getByRole("button", { name: "Use Grove, light" }));
    expect(root.dataset.mode).toBe("light");
    expect(accent(root)).toBe(BUILTIN_THEMES[2].light.accent);
    expect(kept(storage)).toMatchObject({ themeId: "grove", scheme: "light" });
  });

  it("are made from the current theme, edited a color at a time, and used once created", async () => {
    const { root, storage } = shown();
    await userEvent.click(screen.getByRole("button", { name: "Create theme" }));
    const editor = screen.getByRole("group", { name: "New theme" });
    const name = within(editor).getByRole("textbox", { name: "Theme name" });
    expect((name as HTMLInputElement).value).toBe("My theme");
    await userEvent.clear(name);
    await userEvent.type(name, "Midnight");
    const hexes = within(editor).getAllByRole("textbox", { name: "Accent hex" });
    await userEvent.clear(hexes[1]);
    await userEvent.type(hexes[1], "#22aaff");
    await userEvent.click(within(editor).getByRole("button", { name: "Create theme" }));

    expect(screen.queryByRole("group", { name: "New theme" })).toBeNull();
    expect(accent(root)).toBe("#22aaff");
    const { customThemes, themeId } = kept(storage);
    expect(customThemes).toHaveLength(1);
    expect(customThemes[0]).toMatchObject({ name: "Midnight", light: BUILTIN_THEMES[0].light, dark: { ...BUILTIN_THEMES[0].dark, accent: "#22aaff" } });
    expect(themeId).toBe(customThemes[0].id);
  });

  it("start afresh when another draft is started before the first is saved", async () => {
    shown();
    await userEvent.click(screen.getByRole("button", { name: "Duplicate Ocean" }));
    await userEvent.click(screen.getByRole("button", { name: "Duplicate Grove" }));
    const editor = screen.getByRole("group", { name: "New theme" });
    expect((within(editor).getByRole("textbox", { name: "Theme name" }) as HTMLInputElement).value).toBe("Grove copy");
    expect((within(editor).getAllByRole("textbox", { name: "Accent hex" })[1] as HTMLInputElement).value).toBe(BUILTIN_THEMES[2].dark.accent);
  });

  it("stop being offered once the owner has as many as are kept", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `custom-t${i}`, name: `T${i}`, light: BUILTIN_THEMES[0].light, dark: BUILTIN_THEMES[0].dark }));
    shown({ customThemes: many });
    for (const name of ["Create theme", "Add theme", "Duplicate Ocean"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete T0" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect((screen.getByRole("button", { name: "Create theme" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("close the editor when the theme being edited is deleted", async () => {
    const mine = { id: "custom-mine", name: "Mine", light: BUILTIN_THEMES[3].light, dark: BUILTIN_THEMES[3].dark };
    const { storage } = shown({ themeId: "custom-mine", customThemes: [mine] });
    await userEvent.click(screen.getByRole("button", { name: "Edit Mine" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Mine" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("group", { name: "Edit Mine" })).toBeNull();
    expect(kept(storage)).toMatchObject({ customThemes: [], themeId: "hermes" });
  });

  it("won't take a name another theme has", async () => {
    shown();
    await userEvent.click(screen.getByRole("button", { name: "Duplicate Ocean" }));
    const editor = screen.getByRole("group", { name: "New theme" });
    const name = within(editor).getByRole("textbox", { name: "Theme name" });
    expect((name as HTMLInputElement).value).toBe("Ocean copy");
    await userEvent.clear(name);
    await userEvent.type(name, "Grove");
    expect(within(editor).getByText("Another theme is already called that.")).toBeTruthy();
    expect((within(editor).getByRole("button", { name: "Create theme" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("of the owner's own can be edited, and deleted after asking, falling back to Hermes", async () => {
    const mine = { id: "custom-mine", name: "Mine", light: BUILTIN_THEMES[3].light, dark: BUILTIN_THEMES[3].dark };
    const { root, storage } = shown({ themeId: "custom-mine", customThemes: [mine] });
    expect(accent(root)).toBe(mine.dark.accent);
    expect(screen.queryByRole("button", { name: "Edit Ocean" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit Mine" }));
    const editor = screen.getByRole("group", { name: "Edit Mine" });
    await userEvent.clear(within(editor).getAllByRole("textbox", { name: "Background hex" })[1]);
    await userEvent.type(within(editor).getAllByRole("textbox", { name: "Background hex" })[1], "000000");
    await userEvent.click(within(editor).getByRole("button", { name: "Save theme" }));
    expect(root.style.getPropertyValue("--bg")).toBe("#000000");
    expect(kept(storage).customThemes).toMatchObject([{ id: "custom-mine", dark: { background: "#000000" } }]);

    await userEvent.click(screen.getByRole("button", { name: "Delete Mine" }));
    expect(kept(storage).customThemes).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(kept(storage)).toMatchObject({ customThemes: [], themeId: "hermes" });
    expect(accent(root)).toBe(BUILTIN_THEMES[0].dark.accent);
  });

  it("can be added from pasted JSON, and say what's wrong with JSON that isn't a theme", async () => {
    const { storage } = shown();
    await userEvent.click(screen.getByRole("button", { name: "Add theme" }));
    const box = screen.getByRole("textbox", { name: "Theme JSON" });
    await userEvent.click(box);
    await userEvent.paste('{"name": "Half"}');
    const importer = screen.getByRole("group", { name: "Add a theme" });
    await userEvent.click(within(importer).getByRole("button", { name: "Add theme" }));
    expect(screen.getByRole("alert").textContent).toMatch(/needs a "name"/);

    await userEvent.clear(box);
    await userEvent.paste(themeJson({ ...BUILTIN_THEMES[4], name: "Rose" }));
    await userEvent.click(within(importer).getByRole("button", { name: "Add theme" }));
    expect(screen.queryByRole("group", { name: "Add a theme" })).toBeNull();
    expect(kept(storage).customThemes).toMatchObject([{ name: "Rose 2", light: BUILTIN_THEMES[4].light }]);
  });
});

describe("Layout and contrast", () => {
  it("contrast and chat width apply as they slide, and reset to their defaults", async () => {
    const { root, storage } = shown();
    const contrast = screen.getByRole<HTMLInputElement>("slider", { name: "Contrast" });
    const before = root.style.getPropertyValue("--muted");
    // jsdom has no slider dragging; a change event is what the browser sends.
    const slide = (el: HTMLInputElement, v: number) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    slide(contrast, 80);
    expect(kept(storage).contrast).toBe(80);
    expect(root.style.getPropertyValue("--muted")).not.toBe(before);

    const width = screen.getByRole<HTMLInputElement>("slider", { name: "Chat width" });
    expect(root.style.getPropertyValue("--chat-width")).toBe("740px");
    slide(width, 8);
    expect(root.style.getPropertyValue("--chat-width")).toBe("100vw");
    expect(await screen.findByText("Full width")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reset chat width" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset contrast" }));
    expect(kept(storage)).toMatchObject({ contrast: 50, chatWidth: 740 });
    expect(root.style.getPropertyValue("--muted")).toBe(before);
  });
});

describe("Kept appearance, themes", () => {
  it("drops custom themes that aren't themes, and a theme or setting that isn't on offer", () => {
    const mine = { id: "custom-ok", name: "Ok", light: BUILTIN_THEMES[0].light, dark: BUILTIN_THEMES[0].dark };
    expect(
      loadAppearance(
        memoryStorage({ scheme: "sepia", themeId: "gone", contrast: 101, chatWidth: 777, customThemes: [mine, { name: "Broken" }, mine, 3] }),
      ),
    ).toMatchObject({ scheme: "dark", themeId: "hermes", contrast: 50, chatWidth: 740, customThemes: [mine] });
  });
});
