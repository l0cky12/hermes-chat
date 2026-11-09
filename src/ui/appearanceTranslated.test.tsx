// @vitest-environment jsdom
// The Appearance tab is a converted screen (#353): every word on it, in every state it can show, comes from the
// catalogue. Rendered under a pseudo-locale that marks each catalogue string, so a literal left in a component stands out.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { MAX_CUSTOM_THEMES, appearanceStore } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingRow, SettingsSearching } from "./SettingRows";
import { BUILTIN_THEMES } from "./themes";

const p = pseudoLocale();
const [ocean] = BUILTIN_THEMES;
const mine = (n: number) => ({ id: `custom-${n}`, name: `Mine ${n}`, light: ocean.light, dark: ocean.dark });
const fonts = async () => ({ all: ["Inter", "Fira Code"], mono: ["Fira Code"] });

function memoryStorage(saved: unknown) {
  const items = new Map([["hermes-chat.appearance", JSON.stringify(saved)]]);
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function shown(saved: unknown) {
  const languages = { tags: () => ["en-US"], subscribe: () => () => {} };
  const store = appearanceStore(memoryStorage(saved), document.createElement("html"), undefined, languages);
  render(
    <LocaleContext value={p}>
      {/* Searching opens every folded help, so its words are checked too. */}
      <SettingsSearching.Provider value={true}>
        <AppearanceSettings store={store} listFonts={fonts} />
      </SettingsSearching.Provider>
    </LocaleContext>,
  );
}

afterEach(cleanup);

it("shows only catalogue words on the Appearance tab, in each state it can show", async () => {
  const user = userEvent.setup();
  // Off the defaults, so every reset shows; a font no longer installed; a theme of the owner's own.
  shown({ customThemes: [mine(1)], themeId: "custom-1", contrast: 70, chatWidth: 0, uiFont: "Gone Sans", monoFont: "Fira Code", monoSize: 16 });
  await screen.findAllByRole("option", { name: "Inter" });
  expect(untranslated(document.body)).toEqual([]);

  await user.click(screen.getByRole("button", { name: p.appearance.themes.create }));
  await user.click(screen.getByRole("button", { name: p.appearance.editor.copy }));
  await user.clear(screen.getByRole("textbox", { name: p.appearance.editor.name }));
  await user.type(screen.getByRole("textbox", { name: p.appearance.editor.name }), "Mine 1");
  expect(screen.getByText(p.appearance.editor.taken)).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.click(screen.getByRole("button", { name: p.common.cancel }));

  await user.click(screen.getByRole("button", { name: p.appearance.themes.add }));
  await user.type(screen.getByRole("textbox", { name: p.appearance.import.json }), "not json");
  await user.click(within(screen.getByRole("group", { name: p.appearance.import.group })).getByRole("button", { name: p.appearance.import.add }));
  expect((await screen.findByRole("alert")).textContent).toBe(p.appearance.import.notJson);
  expect(untranslated(document.body)).toEqual([]);
  await user.clear(screen.getByRole("textbox", { name: p.appearance.import.json }));
  await user.paste("{}");
  await user.click(within(screen.getByRole("group", { name: p.appearance.import.group })).getByRole("button", { name: p.appearance.import.add }));
  expect((await screen.findByRole("alert")).textContent).toBe(p.appearance.import.notTheme);
  await user.click(screen.getByRole("button", { name: p.common.cancel }));

  await user.click(screen.getByRole("button", { name: p.appearance.themes.delete("Mine 1") }));
  expect(screen.getByText(p.appearance.themes.confirmDelete("Mine 1"))).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
});

it("shows only catalogue words once the owner has as many themes as are kept", () => {
  shown({ customThemes: Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => mine(i)) });
  expect(screen.getByRole("button", { name: p.appearance.themes.duplicate("Ocean") }).title).toBe(p.appearance.themes.duplicateFull(MAX_CUSTOM_THEMES));
  expect(untranslated(document.body)).toEqual([]);
});

it("reports a word that didn't come from the catalogue, so a clean tab means something", () => {
  render(
    <LocaleContext value={p}>
      <SettingRow name="Word wrap" hint={p.appearance.wordWrap.hint} more={<p>{p.appearance.statusBar.more}</p>} control={<button title="Back">x</button>} />
    </LocaleContext>,
  );
  expect(untranslated(document.body)).toEqual(["Word wrap (text)", "Back (title)", "x (text)"]);
});
