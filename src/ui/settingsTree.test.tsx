// @vitest-environment jsdom
// Settings' sidebar tree (ADR 0160): General, Memory and Diagnostics show one section at a time, picked under the page
// in the tree; a search shows every section of every page; and Memory's External memory picks its profile in the page
// header.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { HONCHO } from "../hermes/fakeMemoryProviders";
import { connect, type Hermes } from "../hermes/transport";
import type { MemoryProvidersApi } from "../hermes/memoryProviders";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const highlights = new Map<string, { ranges: Range[] }>();
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  (CSS as unknown as { highlights: typeof highlights }).highlights = highlights;
  (globalThis as unknown as { Highlight: typeof FakeHighlight }).Highlight = FakeHighlight;
});
afterAll(() => {
  delete (CSS as unknown as { highlights?: unknown }).highlights;
  delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  highlights.clear();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function Shell({ hermes, guard, providers = false, providersApi, toolsets = false }: { hermes: Hermes; guard?: (go: () => void) => void; providers?: boolean; providersApi?: MemoryProvidersApi; toolsets?: boolean }) {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status="connected"
      route={{ kind: "ssh", target: "liam@hermes" }}
      unsecure={false}
      username="liam"
      passwordSaved
      profile="default"
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      listProfiles={() => hermes.profiles()}
      modelSettings={hermes.modelSettings}
      memory={hermes.memory}
      memoryProviders={providersApi ?? (providers ? hermes.memoryProviders : undefined)}
      toolsets={toolsets ? hermes.toolsets : undefined}
      guard={guard}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown(opts: { guard?: (go: () => void) => void; providers?: boolean; server?: FakeHermes; slowUse?: Promise<void>; toolsets?: boolean } = {}) {
  const s = opts.server ?? new FakeHermes();
  s.memory = { default: { memory: ["Owner prefers short answers."], profile: ["Name: Sam."] } };
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  // A provider change that answers only once `slowUse` settles; the rest of the API is the real one.
  const providersApi = opts.slowUse
    ? (Object.create(hermes.memoryProviders, { use: { value: (...a: Parameters<MemoryProvidersApi["use"]>) => opts.slowUse!.then(() => hermes.memoryProviders.use(...a)) } }) as MemoryProvidersApi)
    : undefined;
  render(<Shell hermes={hermes} guard={opts.guard} providers={opts.providers} providersApi={providersApi} toolsets={opts.toolsets} />);
  return { s, hermes, user: userEvent.setup() };
}

/** The open page's sections, under its tab in the tree. */
const sections = (page: string) => screen.getByRole("group", { name: `${page}: sections` });
const item = (page: string, name: string) => within(sections(page)).getByRole("button", { name });
const names = (page: string) => within(sections(page)).getAllByRole("button").map((b) => b.textContent);
const current = (page: string) => within(sections(page)).getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent);
const heading = (name: string | RegExp) => screen.queryByRole("heading", { name });
/** The page header's title, and the page it is a section of. */
const head = () => {
  const h = document.querySelector("header.page-head")!;
  return { title: h.querySelector(".page-title")!.textContent, eyebrow: h.querySelector(".page-eyebrow")?.textContent };
};
const externalPicker = () => screen.getByRole("combobox", { name: "Profile whose external memory is shown" }) as HTMLSelectElement;

describe("Settings → General sections", () => {
  it("shows one section at a time, Connection first, and lists them under General in the tree", async () => {
    await shown();
    expect(names("General")).toEqual(["Connection", "Chats", "Launch, tray & updates", "Screenshots", "Storage & data"]);
    expect(current("General")).toEqual(["Connection"]);
    expect(head()).toEqual({ title: "Connection", eyebrow: "General" });
    expect(heading("Connection in use")).toBeTruthy();
    expect(heading("Local cache")).toBeNull();
    expect(heading("On launch")).toBeNull();
    // Only the open page has sections under it.
    expect(screen.getByRole("group", { name: /: sections$/ })).toBe(sections("General"));
  });

  it("picks a section by click; Up, Down, Home and End move the focus among them without picking", async () => {
    const { user } = await shown();
    await user.click(item("General", "Storage & data"));
    expect(heading("Local cache")).toBeTruthy();
    expect(heading("History")).toBeTruthy();
    expect(heading("Connection in use")).toBeNull();
    expect(current("General")).toEqual(["Storage & data"]);
    expect(head()).toEqual({ title: "Storage & data", eyebrow: "General" });

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("General", "Screenshots"));
    // The focus moved, not the page: Storage & data is still the one shown, and General is still the tab.
    expect(current("General")).toEqual(["Storage & data"]);
    expect(heading("Local cache")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(current("General")).toEqual(["Screenshots"]);
    expect(head().title).toBe("Screenshots");
    expect(heading("Local cache")).toBeNull();

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(item("General", "Connection"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("General", "Connection"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(item("General", "Storage & data"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("General", "Storage & data"));
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(item("General", "Connection"));
    expect(current("General")).toEqual(["Screenshots"]);
    await user.keyboard(" ");
    expect(current("General")).toEqual(["Connection"]);
    expect(heading("Connection in use")).toBeTruthy();
  });

  it("keeps every tab's and section's name, and a narrow window's bar names the page and section shown (#154)", async () => {
    // A window 900 px wide or less draws a bar in place of the sidebar.
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 900px)", media: q, addEventListener() {}, removeEventListener() {} }));
    const { user } = await shown();
    // Every tab is named by its drawn label, so a clipped label still has its whole name.
    const labels = screen.getAllByRole("tab").map((t) => t.querySelector(".settings-tab-label")!.textContent!);
    expect(labels).toEqual(["General", "Appearance", "Keyboard Shortcuts", "Model", "Memory"]);
    for (const label of labels) expect(screen.getByRole("tab", { name: label }).querySelector(".settings-tab-label")!.textContent).toBe(label);
    // The bar names the page and its section, and opens the tree as a sheet.
    const crumb = screen.getByRole("button", { name: "General › Connection" });
    expect(crumb.getAttribute("aria-haspopup")).toBe("dialog");
    // Under the bar, the sections are a row of chips with the same names; the tree's list has them too.
    const groups = screen.getAllByRole("group", { name: "General: sections" });
    expect(groups.map((g) => within(g).getAllByRole("button").map((b) => b.textContent))).toEqual([
      ["Connection", "Chats", "Launch, tray & updates", "Screenshots", "Storage & data"],
      ["Connection", "Chats", "Launch, tray & updates", "Screenshots", "Storage & data"],
    ]);
    await user.click(within(groups[0]).getByRole("button", { name: "Storage & data" }));
    expect(screen.getByRole("button", { name: "General › Storage & data" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "General › Storage & data" }));
    const sheet = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(sheet).getByRole("tab", { name: "Memory" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Memory › Agent notes" })).toBeTruthy();
    expect(screen.getAllByRole("group", { name: "Memory: sections" }).map((g) => within(g).getAllByRole("button").map((b) => b.textContent))).toEqual([
      ["Agent notes", "User profile"],
      ["Agent notes", "User profile"],
    ]);
  });

  it("keeps the narrow sheet modal: focus starts on the page shown, Tab stays in it, Escape closes it back to the bar", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 900px)", media: q, addEventListener() {}, removeEventListener() {} }));
    const { user } = await shown();
    const crumb = screen.getByRole("button", { name: "General › Connection" });
    await user.click(crumb);
    const sheet = screen.getByRole("dialog", { name: "Settings" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(sheet).getByRole("tab", { name: "General" }));
    // Shift+Tab from the first stop wraps to the sheet's last one, never to the page behind.
    within(sheet).getByRole("button", { name: "Close the list of settings" }).focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(sheet.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "General › Connection" }));
  });

  it("moves the focus through the narrow sheet's tabs with the arrows, and picks only on Enter or a click", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 900px)", media: q, addEventListener() {}, removeEventListener() {} }));
    const s = new FakeHermes();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    // A guard that always asks, as App's does over an unsaved edit: stepping through the list must never ask.
    let asked = 0;
    render(<Shell hermes={hermes} guard={(go) => (asked++, go())} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "General › Connection" }));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const sheet = screen.getByRole("dialog", { name: "Settings" });
    const keys = within(sheet).getByRole("tab", { name: "Keyboard Shortcuts" });
    expect(document.activeElement).toBe(keys);
    expect(keys.getAttribute("aria-selected")).toBe("false");
    expect(asked).toBe(0);
    // The focused tab is the sheet's Tab stop: from the last tab, Tab wraps inside the sheet, never to the page behind.
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(within(sheet).getByRole("tab", { name: "Memory" }));
    await user.keyboard("{Tab}");
    expect(sheet.contains(document.activeElement)).toBe(true);
    keys.focus();
    await user.keyboard("{Enter}");
    expect(asked).toBe(1);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keyboard Shortcuts" })).toBeTruthy();
  });

  it("leaves the focus in a question that a pick from the narrow sheet asks first (an unsaved edit)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 900px)", media: q, addEventListener() {}, removeEventListener() {} }));
    const s = new FakeHermes();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    // App's question before leaving an unsaved edit: a modal dialog whose button takes the focus as it opens.
    function Guarded() {
      const [ask, setAsk] = useState<{ go: () => void }>();
      return (
        <>
          <Shell hermes={hermes} guard={(go) => setAsk({ go })} />
          {ask && (
            <div role="alertdialog" aria-modal="true" aria-label="Leave the unsaved edit?">
              <button autoFocus onClick={() => setAsk(undefined)}>
                Keep editing
              </button>
            </div>
          )}
        </>
      );
    }
    render(<Guarded />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "General › Connection" }));
    await user.click(within(screen.getByRole("dialog", { name: "Settings" })).getByRole("tab", { name: "Memory" }));
    const question = screen.getByRole("alertdialog", { name: "Leave the unsaved edit?" });
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Keep editing" }));
  });

  it("shows every section of every page while searching, and the section picked again after", async () => {
    const { user } = await shown();
    await user.click(item("General", "Chats"));
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "cache");
    // No section is picked while searching: the tree has no sections, and Storage & data shows though Chats was picked.
    expect(screen.queryByRole("group", { name: "General: sections" })).toBeNull();
    expect(heading("Local cache")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    expect(current("General")).toEqual(["Chats"]);
    expect(head().title).toBe("Chats");
    expect(heading("Local cache")).toBeNull();
    expect(heading("Connection in use")).toBeNull();
  });
});

describe("Settings → Memory sections", () => {
  it("lists the two files, shows the picked one, and marks it", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    // Without external memory, the two files are the sections.
    expect(names("Memory")).toEqual(["Agent notes", "User profile"]);
    expect(current("Memory")).toEqual(["Agent notes"]);
    expect(head()).toEqual({ title: "Agent notes", eyebrow: "Memory" });
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Memory files" })).toBeNull();
    await user.click(item("Memory", "User profile"));
    expect(current("Memory")).toEqual(["User profile"]);
    expect(head()).toEqual({ title: "User profile", eyebrow: "Memory" });
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
    // The header's File chip names the file shown, under ~, in full on hover.
    const file = await screen.findByTitle("/home/liam/.hermes/memories/USER.md");
    expect(file.textContent).toBe("~/.hermes/memories/USER.md");
    expect(file.closest(".meta-chip")!.textContent).toBe("File~/.hermes/memories/USER.md");
    expect(file.closest("header.page-head")).toBeTruthy();
  });

  it("has one External memory section, whose profile is picked in the header from every profile once read", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [], work: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho", work: "" };
    const { user } = await shown({ server, providers: true });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(names("Memory")).toEqual(["Agent notes", "User profile", "External memory"]);
    // The provider part stays mounted but hidden until External memory is picked, and the header has no picker for it.
    expect(screen.queryByRole("list", { name: "Memory providers for default" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Profile whose external memory is shown" })).toBeNull();
    await user.click(item("Memory", "External memory"));
    expect(current("Memory")).toEqual(["External memory"]);
    expect(head()).toEqual({ title: "External memory", eyebrow: "Memory" });
    // It opens on the profile in use, and the header's picker offers every profile once read.
    expect(await screen.findByRole("list", { name: "Memory providers for default" })).toBeTruthy();
    expect(externalPicker().closest("header.page-head")).toBeTruthy();
    expect(externalPicker().value).toBe("default");
    await waitFor(() => expect([...externalPicker().options].map((o) => o.value)).toEqual(["default", "research", "work"]));
    expect(screen.queryByText("not in use")).toBeNull();
    await user.selectOptions(externalPicker(), "research");
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for research");
    expect(externalPicker().value).toBe("research");
    expect(within(document.querySelector("header.page-head") as HTMLElement).getByText("not in use")).toBeTruthy();
    // Still one section: picking a profile doesn't add one.
    expect(names("Memory")).toEqual(["Agent notes", "User profile", "External memory"]);
    expect(current("Memory")).toEqual(["External memory"]);
    // The all-profiles table is under a fold, still there for a reader.
    expect(screen.getByText("All profiles and their stores")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Memory provider by profile", hidden: true })).toBeTruthy();
    await user.click(item("Memory", "Agent notes"));
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Memory providers for research" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Profile whose external memory is shown" })).toBeNull();
    // Back to External memory: the profile picked last.
    await user.click(item("Memory", "External memory"));
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(externalPicker().value).toBe("research");
  });

  it("asks through the same guard as a tab switch before leaving an unsaved entry", async () => {
    const asked: (() => void)[] = [];
    let unsaved = false;
    // App's guard runs at once while nothing is unsaved and asks otherwise; this one asks once the edit is typed.
    const { user } = await shown({ guard: (go) => (unsaved ? void asked.push(go) : go()) });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    const entries = await screen.findByRole("list", { name: "Agent notes entries" });
    await user.click(within(entries).getByRole("button", { name: /Owner prefers/ }));
    await user.type(screen.getByRole("textbox", { name: /Entry in/ }), " Really.");
    unsaved = true;
    await user.click(item("Memory", "User profile"));
    // The guard holds the switch: the entry stays open and the tree still marks Agent notes.
    expect(asked).toHaveLength(1);
    expect(current("Memory")).toEqual(["Agent notes"]);
    expect(head().title).toBe("Agent notes");
    expect(screen.getByRole("textbox", { name: /Entry in/ })).toBeTruthy();
    asked[0]();
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
    expect(current("Memory")).toEqual(["User profile"]);
  });

  it("shows a profile picked while a provider change runs only once the change has answered, with its own providers", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user } = await shown({ server, slowUse: gate });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await user.click(item("Memory", "External memory"));
    await screen.findByRole("list", { name: "Memory providers for default" });
    await waitFor(() => expect([...externalPicker().options].map((o) => o.value)).toEqual(["default", "research"]));
    await user.click(screen.getByRole("button", { name: "Use for default" }));
    await user.selectOptions(externalPicker(), "research");
    // The header's picker shows research, but the detail stays on default until default's change has answered.
    expect(externalPicker().value).toBe("research");
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for default");
    release();
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for research");
    expect(within(screen.getByRole("list", { name: "Memory providers for research" })).getByText("In use").closest(".provider-row")!.textContent).toMatch(/honcho/);
    expect(fake.active).toEqual({ default: "", research: "honcho" });
  });

  it("shows in the header's picker a profile picked from the folded table", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho" };
    const { user } = await shown({ server, providers: true });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await user.click(item("Memory", "External memory"));
    await screen.findByRole("list", { name: "Memory providers for default" });
    const table = screen.getByRole("table", { name: "Memory provider by profile", hidden: true });
    await user.click(within(table).getByRole("button", { name: "research", hidden: true }));
    expect(externalPicker().value).toBe("research");
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    // And back through the header's picker: it isn't stuck on a selection it never saw.
    await user.selectOptions(externalPicker(), "default");
    expect(await screen.findByRole("list", { name: "Memory providers for default" })).toBeTruthy();
    expect(externalPicker().value).toBe("default");
  });
});

describe("Settings search and folds", () => {
  it("opens a folded explanation that holds a match, so the match can be seen", async () => {
    const { user } = await shown({ toolsets: true });
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "yolo");
    const note = await screen.findByText(/Toolsets aren't Approvals/);
    // Toolsets' "How a change applies" is behind the section's (i).
    await waitFor(() => expect((note.closest(".set-more") as HTMLElement).hidden).toBe(false));
    expect(screen.getByRole("button", { name: "About Toolsets" }).getAttribute("aria-expanded")).toBe("true");
  });
});
