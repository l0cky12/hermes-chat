// @vitest-environment jsdom
// Settings' sub-navigation (ADR 0113): General shows one of four groups beside a sub-nav, a search shows every group,
// and the Memory tab lists the two memory files and every profile beside the detail.
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

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

const nav = (name: string) => screen.getByRole("navigation", { name });
const heading = (name: string | RegExp) => screen.queryByRole("heading", { name });

describe("Settings → General groups", () => {
  it("shows one group beside the sub-nav, Connection first", async () => {
    await shown();
    expect(within(nav("General")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Connection", "Chats", "Launch, tray & updates", "Screenshots", "Storage & data"]);
    expect(within(nav("General")).getByRole("button", { name: "Connection" }).getAttribute("aria-current")).toBe("true");
    expect(heading("Connection in use")).toBeTruthy();
    expect(heading("Local cache")).toBeNull();
    expect(heading("On launch")).toBeNull();
  });

  it("switches groups by click and by arrow keys", async () => {
    const { user } = await shown();
    await user.click(within(nav("General")).getByRole("button", { name: "Storage & data" }));
    expect(heading("Local cache")).toBeTruthy();
    expect(heading("History")).toBeTruthy();
    expect(heading("Connection in use")).toBeNull();
    await user.keyboard("{ArrowUp}");
    expect(heading("Screenshots")).toBeTruthy();
    expect(within(nav("General")).getByRole("button", { name: "Screenshots" }).getAttribute("aria-current")).toBe("true");
    await user.keyboard("{Home}");
    expect(heading("Connection in use")).toBeTruthy();
  });

  it("keeps every tab's and group's name for a narrow window, where only the shown one's label is drawn (#154)", async () => {
    await shown();
    // A narrow window hides the other labels with CSS; the name and the tip stay on the button.
    for (const tab of screen.getAllByRole("tab")) {
      const label = tab.querySelector(".settings-tab-label")!.textContent;
      expect(tab.getAttribute("aria-label")).toBe(label);
      expect(tab.getAttribute("title")).toBe(label);
    }
    expect(screen.getByRole("tab", { name: "Memory" })).toBeTruthy();
    expect(nav("General").classList.contains("compact")).toBe(true);
    const storage = within(nav("General")).getByRole("button", { name: "Storage & data" });
    expect(storage.getAttribute("title")).toBe("Storage & data");
    // Memory's profiles share one icon, so its list keeps every label.
    await userEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(nav("Memory").classList.contains("compact")).toBe(false);
    expect(within(nav("Memory")).getByRole("button", { name: "Agent notes" }).hasAttribute("title")).toBe(false);
  });

  it("shows every group's sections while searching, and the chosen group again after", async () => {
    const { user } = await shown();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "cache");
    expect(screen.queryByRole("navigation", { name: "General" })).toBeNull();
    expect(heading("Local cache")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    expect(heading("Connection in use")).toBeTruthy();
    expect(heading("Local cache")).toBeNull();
  });
});

describe("Settings → Memory list", () => {
  it("lists the two files, shows the picked one, and marks it", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(within(nav("Memory")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent notes", "User profile"]);
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Memory files" })).toBeNull();
    await user.click(within(nav("Memory")).getByRole("button", { name: "User profile" }));
    expect(within(nav("Memory")).getByRole("button", { name: "User profile" }).getAttribute("aria-current")).toBe("true");
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
    expect(screen.getByText("/home/liam/.hermes/memories/USER.md")).toBeTruthy();
  });

  it("lists every profile under External memory once read, and shows one profile's providers beside the list", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [], work: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho", work: "" };
    const { user } = await shown({ server, providers: true });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await waitFor(() => expect(within(nav("Memory")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent notes", "User profile", "default", "research", "work"]));
    expect(within(nav("Memory")).getByText("External memory")).toBeTruthy();
    // The provider part stays mounted but hidden until a profile is picked.
    expect(screen.queryByRole("list", { name: "Memory providers for default" })).toBeNull();
    await user.click(within(nav("Memory")).getByRole("button", { name: "research" }));
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for research");
    // The all-profiles table is under a fold, still there for a reader.
    expect(screen.getByText("All profiles and their stores")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Memory provider by profile", hidden: true })).toBeTruthy();
    await user.click(within(nav("Memory")).getByRole("button", { name: "Agent notes" }));
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Memory providers for research" })).toBeNull();
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
    await user.click(within(nav("Memory")).getByRole("button", { name: "User profile" }));
    // The guard holds the switch: the entry stays open and the list still shows Agent notes.
    expect(asked).toHaveLength(1);
    expect(within(nav("Memory")).getByRole("button", { name: "Agent notes" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("textbox", { name: /Entry in/ })).toBeTruthy();
    asked[0]();
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
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
    await user.click(within(nav("Memory")).getByRole("button", { name: "default" }));
    await screen.findByRole("list", { name: "Memory providers for default" });
    await user.click(screen.getByRole("button", { name: "Use for default" }));
    await user.click(within(nav("Memory")).getByRole("button", { name: "research" }));
    // The list marks research, but the detail stays on default until default's change has answered.
    expect(within(nav("Memory")).getByRole("button", { name: "research" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for default");
    release();
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for research");
    expect(within(screen.getByRole("list", { name: "Memory providers for research" })).getByText("In use").closest(".provider-row")!.textContent).toMatch(/honcho/);
    expect(fake.active).toEqual({ default: "", research: "honcho" });
  });

  it("marks in the list a profile picked from the folded table", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho" };
    const { user } = await shown({ server, providers: true });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await user.click(within(nav("Memory")).getByRole("button", { name: "default" }));
    await screen.findByRole("list", { name: "Memory providers for default" });
    const table = screen.getByRole("table", { name: "Memory provider by profile", hidden: true });
    await user.click(within(table).getByRole("button", { name: "research", hidden: true }));
    expect(within(nav("Memory")).getByRole("button", { name: "research" }).getAttribute("aria-current")).toBe("true");
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    // And back through the list: it isn't stuck on a selection it never saw.
    await user.click(within(nav("Memory")).getByRole("button", { name: "default" }));
    expect(await screen.findByRole("list", { name: "Memory providers for default" })).toBeTruthy();
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
