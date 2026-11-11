// @vitest-environment jsdom
// Settings' search box against the fake dashboard: it shows the sections of every tab whose text holds the query,
// fills in tabs that read from Hermes, names the editor tabs instead of mounting them, and ends where the owner picks.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";
import { HIGHLIGHT_NAME, applySearch, queryWords, textMatches } from "./settingsSearch";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

/** A stand-in for the WebView's CSS highlight registry, which jsdom lacks. */
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

function Shell({ hermes, guard }: { hermes: Hermes; guard?: (go: () => void) => void }) {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status="connected"
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
      capabilities={hermes.capabilities}
      guard={guard}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown(guard?: (go: () => void) => void) {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  render(<Shell hermes={hermes} guard={guard} />);
  return { user };
}

const box = () => screen.getByRole<HTMLInputElement>("searchbox", { name: "Search settings" });
/** Whether the section a heading heads is on screen: neither it nor its tab's group is hidden by the search. */
const showing = (heading: string) => !screen.getByRole("heading", { name: heading, level: 2 }).closest("[data-search-miss]");
const status = () => screen.getByRole("status").textContent;

describe("queryWords and textMatches", () => {
  it("matches every word, in any order and case", () => {
    expect(queryWords("  Close   TRAY ")).toEqual(["close", "tray"]);
    expect(textMatches("Close to tray: closing the window hides it", ["tray", "close"])).toBe(true);
    expect(textMatches("Close to tray", ["tray", "dock"])).toBe(false);
  });

  it("marks a word whose lower case is longer than it, at its place in the original text", () => {
    // "İ" lower-cases to two code units, so offsets in the lower-cased text run one past the original's.
    const root = document.createElement("div");
    root.innerHTML = "<div data-search-group><section><h2>Profile İpek, then Ipek</h2></section></div>";
    const shown = applySearch(root, queryWords("İpek"));
    expect(shown).toBe(1);
    expect(highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString())).toEqual(["İpek"]);
    expect(applySearch(root, queryWords("then"))).toBe(1);
    expect(highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString())).toEqual(["then"]);
  });

  it("marks whatever it matches when lower-casing depends on where a letter stands (Greek final sigma)", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div data-search-group><section><h2>Signed in as ΟΣ and ος</h2></section></div>";
    for (const q of ["ΟΣ", "ος", "οσ"]) {
      expect(applySearch(root, queryWords(q))).toBe(1);
      expect(highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString())).toEqual(["ΟΣ", "ος"]);
    }
  });
});

describe("Searching Settings", () => {
  it("shows only the sections that hold every word, from General and Appearance together, and marks the words", async () => {
    const { user } = await shown();
    await user.type(box(), "tray");
    expect(showing("Tray")).toBe(true);
    expect(showing("Local cache")).toBe(false);
    expect(showing("Fonts")).toBe(false);
    // No tab is selected while results from all of them show.
    expect(screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true")).toEqual([]);
    const marked = highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString().toLowerCase());
    expect(marked.length).toBeGreaterThan(0);
    expect(new Set(marked)).toEqual(new Set(["tray"]));

    await user.clear(box());
    await user.type(box(), "interface font");
    expect(showing("Fonts")).toBe(true);
    expect(showing("Tray")).toBe(false);
    // General has no section left, so its group is hidden whole.
    expect(screen.getByRole("group", { name: "General" }).hasAttribute("data-search-miss")).toBe(true);
    expect(screen.getByRole("group", { name: "Appearance" }).hasAttribute("data-search-miss")).toBe(false);
  });

  it("has no global shortcut section, and a search finds where to bind hermes-chat --toggle instead (#169)", async () => {
    const { user } = await shown();
    expect(screen.queryByRole("heading", { name: "Show Hermes Chat from anywhere" })).toBeNull();
    expect(screen.queryByText(/Global shortcut/i)).toBeNull();
    await user.click(box());
    await user.paste("toggle");
    await waitFor(() => expect(showing("Screenshots")).toBe(true));
    expect(showing("Tray")).toBe(false);
    expect(screen.getAllByText("hermes-chat --toggle").length).toBeGreaterThan(0);
  });

  it("finds words in a row's folded help and opens it, and folds it again when the search ends (#174)", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("button", { name: "Launch, tray & updates" }));
    const about = () => screen.getByRole("button", { name: "About Close to tray" });
    const help = () => document.getElementById(about().getAttribute("aria-controls")!)!;
    expect(help().hidden).toBe(true);
    // Only the folded help says this.
    await user.type(box(), "always exits");
    expect(showing("Tray")).toBe(true);
    expect(showing("On launch")).toBe(false);
    expect(help().hidden).toBe(false);
    expect(highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString())).toEqual(["always", "exits"]);
    await user.clear(box());
    expect(help().hidden).toBe(true);
  });

  it("finds a section by a control's name that shows only to assistive technology", async () => {
    const { user } = await shown();
    // "Interface font size" is the size picker's aria-label; the section's text says neither "size" nor the pair.
    await user.type(box(), "font size");
    expect(showing("Fonts")).toBe(true);
    expect(showing("Tray")).toBe(false);
  });

  it("finds a section of the Model tab once Hermes has answered its read", async () => {
    const { user } = await shown();
    await user.type(box(), "subagents");
    await waitFor(() => expect(showing("Subagents")).toBe(true));
    expect(showing("Main model")).toBe(false);
    // General's agent office setting is about subagents too (ADR 0077); its other sections aren't.
    expect(showing("Agent office")).toBe(true);
    expect(showing("Sending while Hermes replies")).toBe(false);
  });

  it("names the Memory tab rather than mounting it, and opening it ends the search", async () => {
    const { user } = await shown();
    await user.type(box(), "remembers");
    expect(screen.queryByRole("group", { name: "Memory" })).toBeNull();
    // The result's own text is marked too.
    expect(highlights.get(HIGHLIGHT_NAME)!.ranges.map((r) => r.toString())).toEqual(["remembers"]);
    await user.click(screen.getByRole("button", { name: "Open Memory" }));
    expect(box().value).toBe("");
    expect(screen.getByRole("tab", { name: /Memory/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("settings-panel-memory")).not.toBeNull();
  });

  it("names the Diagnostics tab, and opening it ends the search there", async () => {
    const { user } = await shown();
    await user.type(box(), "protocol");
    // General's Connection in use section holds the button that also says so, and stays in the results.
    expect(showing("Connection in use")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open Diagnostics" }));
    expect(box().value).toBe("");
    expect(screen.getByRole("tab", { name: /Diagnostics/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("settings-panel-diagnostics")).not.toBeNull();
  });

  it("says when nothing matches", async () => {
    const { user } = await shown();
    await user.type(box(), "zzqx");
    expect(status()).toBe("No settings match “zzqx”.");
  });

  it("ends with Escape, Clear search or a tab, and Ctrl+F finds the box from anywhere in Settings", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("tab", { name: /Appearance/ }));
    screen.getByRole("button", { name: /Back to chat/ }).focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(box());

    await user.keyboard("tray");
    expect(screen.queryByRole("tabpanel")).toBeNull();
    await user.keyboard("{Escape}");
    expect(box().value).toBe("");
    // The tab shown before the search comes back.
    expect(screen.getByRole("tabpanel").id).toBe("settings-panel-appearance");
    expect(highlights.has(HIGHLIGHT_NAME)).toBe(false);

    await user.type(box(), "tray");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box().value).toBe("");

    await user.type(box(), "tray");
    await user.click(screen.getByRole("tab", { name: /Model/ }));
    expect(box().value).toBe("");
    expect(screen.getByRole("tabpanel").id).toBe("settings-panel-model");
  });

  it("ends with Escape when the focus has moved into the results", async () => {
    const { user } = await shown();
    await user.type(box(), "tray");
    screen.getByRole("switch", { name: "Close to tray" }).focus();
    await user.keyboard("{Escape}");
    expect(box().value).toBe("");
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole("tabpanel").id).toBe("settings-panel-general");
  });

  it("moves with the arrows from the focused tab while searching, not the one shown before", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("tab", { name: /Appearance/ }));
    await user.type(box(), "tray");
    screen.getByRole("tab", { name: /General/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(box().value).toBe("");
    expect(screen.getByRole("tabpanel").id).toBe("settings-panel-appearance");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Appearance/ }));
  });

  it("asks before starting a search over a tab with an unsaved edit, and starts it only once agreed", async () => {
    let pending: (() => void) | undefined;
    const { user } = await shown((go) => void (pending = go));
    await user.type(box(), "t");
    expect(box().value).toBe("");
    expect(pending).toBeDefined();
    act(() => pending!());
    expect(box().value).toBe("t");
    expect(within(screen.getByRole("group", { name: "General" })).getByRole("heading", { name: "Tray" })).toBeTruthy();
  });
});
