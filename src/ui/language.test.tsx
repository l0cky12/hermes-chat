// @vitest-environment jsdom
// Settings → Appearance → Language (#353): picking Español turns the converted screens Spanish in place, and <html lang>
// follows; System follows the desktop's languages.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { ModelSettingsApi } from "../hermes/modelSettings";
import { LocaleContext } from "../i18n/locale";
import { appearanceStore, type AppearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

afterEach(cleanup);

/** What App does at its root: the language the appearance store resolves to, for everything under it. */
function Localized({ store, children }: { store: AppearanceStore; children: ReactNode }) {
  const locale = useSyncExternalStore(store.subscribe, store.locale);
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

function settings(desktop: string[]) {
  const items = new Map<string, string>();
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  const root = document.createElement("html");
  const store = appearanceStore(storage, root, undefined, { tags: () => desktop, subscribe: () => () => {} });
  render(
    <Localized store={store}>
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="liam"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={store}
        listFonts={async () => ({ all: [], mono: [] })}
        modelSettings={new ModelSettingsApi(async () => Promise.reject(new Error("Not connected to Hermes.")), () => "default")}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />
    </Localized>,
  );
  return { root, items };
}

it("turns the Appearance tab and the Settings tabs Spanish when Español is picked, keeping a theme being made", async () => {
  const user = userEvent.setup();
  const { root, items } = settings(["en-GB"]);
  expect(root.lang).toBe("en-GB");
  await user.click(screen.getByRole("tab", { name: "Appearance" }));
  // The page's headings are its jump links in the tree (ADR 0159); a language change renames them in place.
  const jumps = () => within(screen.getByRole("group", { name: /: on this page$/ })).getAllByRole("button").map((b) => b.textContent);
  expect(jumps()).toContain("Fonts");
  await user.click(screen.getByRole("button", { name: "Create theme" }));
  const name = screen.getByRole<HTMLInputElement>("textbox", { name: "Theme name" });
  await user.clear(name);
  await user.type(name, "Half done");

  await user.selectOptions(screen.getByRole("combobox", { name: "Interface language" }), "Español");

  expect(root.lang).toBe("es");
  expect(JSON.parse(items.get("hermes-chat.appearance")!).language).toBe("es");
  expect(screen.getByRole("heading", { name: "Ajustes", level: 1 })).toBeTruthy();
  expect(screen.getByRole("searchbox", { name: "Buscar en los ajustes" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Volver al chat" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Apariencia" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("heading", { name: "Fuentes", level: 2 })).toBeTruthy();
  await waitFor(() => expect(jumps()).toContain("Fuentes"));
  expect(jumps()).not.toContain("Fonts");
  expect(screen.getByRole("switch", { name: "Ajuste de línea" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Idioma de la interfaz" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Sistema (English)" })).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Nombre del tema" }).value).toBe("Half done");
  expect(screen.queryByText("Word wrap")).toBeNull();
});

it("follows the desktop's languages under System: Spanish on a Mexican desktop, English where there's no catalogue", async () => {
  const user = userEvent.setup();
  const { root } = settings(["es-MX", "en-US"]);
  expect(root.lang).toBe("es-MX");
  await user.click(screen.getByRole("tab", { name: "Apariencia" }));
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Idioma de la interfaz" }).value).toBe("system");
  expect(screen.getByRole("option", { name: "Sistema (Español)" })).toBeTruthy();

  await user.selectOptions(screen.getByRole("combobox", { name: "Idioma de la interfaz" }), "English");
  expect(root.lang).toBe("en-US");
  expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy();
  cleanup();

  const german = settings(["de-DE"]);
  expect(german.root.lang).toBe("en");
  expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy();
});
