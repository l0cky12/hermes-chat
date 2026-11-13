// @vitest-environment jsdom
// Settings → Memory on screen, against the fake dashboard: what it shows in each state, editing with Save, Cancel and
// Reload, conflicts and failed saves keeping the owner's text, profile isolation, and asking before an unsaved edit is
// dropped by leaving Settings, opening a chat or switching profile. Every memory entry here is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import type { ConnectionStatus } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { connectionRefs, formatChatLink, parseChatLink } from "../hermes/chatLinks";
import { Main } from "../App";
import { appearanceStore } from "./appearance";
import { MemorySettings } from "./MemorySettings";
import { SettingsScreen } from "./Settings";
import { searchText } from "./settingsSearch";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const FALCON = "Project Falcon uses Postgres 16; migrations live in db/migrations.";
const SHORT = "Owner prefers short answers with a code sample first.";
const SAM = "Name: Sam Example. Works in UTC+1.";
const BRITISH = "Owner writes in British English.";

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { research: [row("notes", 1, { pinned: true, title: "Reading notes" })] };
  s.memory = {
    default: { memory: [FALCON, SHORT], profile: [SAM] },
    research: { memory: ["Research profile: cite sources as numbered footnotes."], profile: [] },
  };
  return s;
}

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

/** Settings on its own, opened on the Memory tab. */
function Shell({ hermes, profile, status, guard }: { hermes: Hermes; profile: string; status: ConnectionStatus; guard?: (go: () => void) => void }) {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status={status}
      route={{ kind: "ssh", target: "liam@hermes" }}
      unsecure={false}
      username="liam"
      passwordSaved
      profile={profile}
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      memory={hermes.memory}
      guard={guard}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown({ s = server(), profile = "default", status = "connected" as ConnectionStatus, wait = true, guard = undefined as ((go: () => void) => void) | undefined } = {}) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  render(<Shell hermes={hermes} profile={profile} status={status} guard={guard} />);
  await user.click(screen.getByRole("tab", { name: /Memory/ }));
  if (wait) await screen.findByRole("list", { name: "Agent notes entries" });
  return { s, hermes, user };
}

/** An entry's button in the list, named by its text (its name goes on with its character count). */
const named = (text: string | RegExp) => (typeof text === "string" ? new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : text);
const entry = (text: string | RegExp) => within(screen.getByRole("list", { name: /entries$/ })).getByRole("button", { name: named(text) });
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Entry in/ });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** A memory file's section, under the Memory tab in Settings' sidebar tree (ADR 0159). */
const file = (name: RegExp) => within(screen.getByRole("group", { name: "Memory: sections" })).getByRole("button", { name });
const current = (name: RegExp) => file(name).getAttribute("aria-current") === "page";
/** The page header Settings draws above the Memory tab (ADR 0159), and one of its labelled chips: Server or File. */
const pageHead = () => document.querySelector<HTMLElement>("header.page-head")!;
const chip = (label: string) => [...pageHead().querySelectorAll<HTMLElement>(".meta-chip")].find((c) => c.firstElementChild?.textContent === label)?.querySelector("code");
const learning = (s: FakeHermes, method?: string) => s.requests.filter((r) => (method ? r.method === method : r.method.startsWith("learning.")));

describe("Settings → Memory", () => {
  it("is a tab in Settings that names the server, profile and file it edits", async () => {
    const { user } = await shown();
    // The page header names the profile, the server and the file; the file from ~, in full on hover.
    expect(pageHead().querySelector(".page-slot")!.textContent!.trim()).toBe("Editing profile default");
    expect(chip("Server")!.textContent).toBe("ssh://liam@hermes");
    expect(chip("File")!.textContent).toBe("~/.hermes/memories/MEMORY.md");
    expect(chip("File")!.title).toBe("/home/liam/.hermes/memories/MEMORY.md");
    expect(within(pageHead()).getByText(/2 entries, \d+ characters/)).toBeTruthy();
    const files = screen.getByRole("group", { name: "Memory: sections" });
    expect(within(files).getAllByRole("button").map((t) => t.textContent)).toEqual(["Agent notes", "User profile"]);
    expect(current(/Agent notes/)).toBe(true);
    // How a saved edit reaches chats is the header's summary box.
    expect(within(pageHead()).getByText("Saved edits reach new chats. Chats already going keep the memory they started with.").closest("section.applies-box")).toBeTruthy();
    await user.click(file(/User profile/));
    expect(chip("File")!.title).toBe("/home/liam/.hermes/memories/USER.md");
    expect(entry(SAM)).toBeTruthy();
  });

  it("says it is reading, then shows the entries", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const frames = s.handlers["learning.frames"];
    s.handlers["learning.frames"] = (r) => void gate.then(() => frames(r));
    await shown({ s, wait: false });
    expect(screen.getByRole("status").textContent).toMatch(/Reading memory from Hermes/);
    release();
    expect(await screen.findByRole("button", { name: named(FALCON) })).toBeTruthy();
  });

  it("says when a file has no entries yet", async () => {
    const s = server();
    s.memory.default.profile = [];
    const { user } = await shown({ s });
    await user.click(file(/User profile/));
    expect(screen.getByText(/nothing in USER.md yet/)).toBeTruthy();
  });

  it("saves an edit only on Save, and says so once it reads back", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Owner prefers short answers.");
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(learning(s, "learning.edit")).toEqual([]);
    await user.click(button("Save"));
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved, and read back from Hermes. New chats on default start with it/);
    expect(s.memory.default.memory).toEqual([FALCON, "Owner prefers short answers."]);
    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(entry("Owner prefers short answers.")).toBeTruthy();
  });

  it("restores what a save replaced, asking first over an unsaved edit, and saves it only on Save", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    expect(screen.queryByRole("button", { name: /Restore previous version/ })).toBeNull();
    await user.clear(editor());
    await user.type(editor(), "Owner prefers short answers.");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    await user.type(editor(), " Typing.");
    await user.click(button(/Restore previous version/));
    const ask = screen.getByRole("alertdialog", { name: "Discard your edit?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe("Owner prefers short answers. Typing.");
    await user.click(button(/Restore previous version/));
    await user.click(button("Discard edit"));
    expect(editor().value).toBe(SHORT);
    expect(document.activeElement).toBe(editor());
    expect((await screen.findByRole("status")).textContent).toMatch(/replaced is in the editor\. Save to put it back on Hermes; nothing has changed there yet/);
    expect(s.memory.default.memory[1]).toBe("Owner prefers short answers.");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory[1]).toBe(SHORT);
    // Settings closed and opened again: the replaced text is still offered (it's the connection's, not the screen's).
    cleanup();
    render(<Shell hermes={hermes} profile="default" status="connected" />);
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await user.click(await screen.findByRole("button", { name: named(SHORT) }));
    await user.click(button(/Restore previous version/));
    expect(editor().value).toBe("Owner prefers short answers.");
  });

  it("won't save an entry as the exact words of another entry in the file", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.click(editor());
    await user.paste(FALCON);
    expect(screen.getByText(/Another entry in MEMORY.md already says exactly this/)).toBeTruthy();
    expect(button("Save")).toHaveProperty("disabled", true);
    expect(learning(s, "learning.edit")).toEqual([]);
  });

  it("doesn't offer to restore once the entry changed after the save", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Owner prefers short answers.");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(button(/Restore previous version/)).toBeTruthy();
    s.memory.default.memory[1] = "Owner prefers long answers (agent).";
    await user.click(button(/Reload/));
    await user.click(await screen.findByRole("button", { name: named("Owner prefers long answers (agent).") }));
    expect(screen.queryByRole("button", { name: /Restore previous version/ })).toBeNull();
  });

  it("drops an edit on Cancel and writes nothing", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " Typo");
    await user.click(button("Cancel"));
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    expect(learning(s, "learning.edit")).toEqual([]);
    expect(s.memory.default.memory[1]).toBe(SHORT);
  });

  it("keeps the edit through Reload when the entry is unchanged on the server", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " Always.");
    s.memory.default.memory[0] = "Project Falcon uses Postgres 17.";
    await user.click(button(/Reload/));
    await screen.findByRole("button", { name: named("Project Falcon uses Postgres 17.") });
    expect(editor().value).toBe(`${SHORT} Always.`);
  });

  it("finds a conflict before saving, writes nothing, and keeps the owner's edit to copy or put back", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "My careful edit");
    // The agent rewrites the entry meanwhile.
    s.memory.default.memory[1] = "Owner wants detailed answers.";
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed on the server, or was removed, since you opened it. Nothing was saved/);
    expect(learning(s, "learning.edit")).toEqual([]);
    expect(s.memory.default.memory[1]).toBe("Owner wants detailed answers.");
    const kept = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit" });
    expect(kept.value).toBe("My careful edit");
    // The owner looks at what Hermes has now, and saves their text over it on purpose.
    await user.click(entry("Owner wants detailed answers."));
    await user.click(button(/Put your kept edit in this entry/));
    await user.type(editor(), ", merged");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory[1]).toBe("My careful edit, merged");
    expect(screen.queryByRole("textbox", { name: "Your kept edit" })).toBeNull();
  });

  it("keeps typing done after a lost save to place, rather than putting it on the entry with the saved words", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "First version");
    s.dropOnLearning = "applied";
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/may or may not have saved/);
    await user.type(editor(), " and more");
    await act(async () => void (await hermes.reconnect()));
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/save may have gone through.*Your edit is kept below; nothing more was saved/);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit" }).value).toBe("First version and more");
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    expect(s.memory.default.memory[1]).toBe("First version");
  });

  it("opens the entry with the saved words, unedited, when nothing was typed after a lost save", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "First version");
    s.dropOnLearning = "applied";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.click(button(/Reload/));
    expect((await screen.findByRole("status")).textContent).toMatch(/shows an entry with the words you saved/);
    expect(editor().value).toBe("First version");
    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Your kept edit/ })).toBeNull();
    expect(s.memory.default.memory).toEqual([FALCON, "First version"]);
  });

  it("doesn't put a lost save's edit on another entry the agent gave the same words", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "New words");
    s.dropOnLearning = "lost";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.type(editor(), " and more");
    // Meanwhile the agent removes the entry being edited and gives another one the words that were sent.
    s.memory.default.memory = ["New words"];
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Your edit is kept below; nothing more was saved/);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit" }).value).toBe("New words and more");
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    expect(s.memory.default.memory).toEqual(["New words"]);
  });

  it("settles a lost save without moving another entry's draft onto it", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Saved A");
    s.dropOnLearning = "applied";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.click(button("Cancel"));
    await user.click(entry(FALCON));
    await user.type(editor(), " Draft B");
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Memory now has an entry with the words of the edit whose answer was lost/);
    expect(editor().value).toBe(`${FALCON} Draft B`);
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: named(FALCON) }).getAttribute("aria-current")).toBe("true");
    expect(s.memory.default.memory).toEqual([FALCON, "Saved A"]);
  });

  it("keeps the draft a kept edit replaces in the editor", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed it";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry(FALCON));
    await user.type(editor(), " Draft B");
    await user.click(button(/Put your kept edit in this entry/));
    expect(editor().value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 1" }).value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 2" }).value).toBe(`${FALCON} Draft B`);
  });

  it("asks through Settings' guard before opening another file over an unsaved edit, and a save meanwhile keeps the file", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const edit = s.handlers["learning.edit"];
    s.handlers["learning.edit"] = (r) => void gate.then(() => edit(r));
    const asked: (() => void)[] = [];
    let unsaved = false;
    const { user } = await shown({ s, guard: (go) => (unsaved ? void asked.push(go) : go()) });
    await user.click(entry(SHORT));
    await user.type(editor(), " Saved.");
    unsaved = true;
    await user.click(file(/User profile/));
    // The question is App's (through `guard`), as for a tab switch; the file and the edit stay until it's answered.
    expect(asked).toHaveLength(1);
    expect(current(/Agent notes/)).toBe(true);
    await user.click(button("Save"));
    release();
    await screen.findByText(/Saved, and read back/);
    expect(current(/Agent notes/)).toBe(true);
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
  });

  it("settles a lost save only in the file it was for, though the other file has the same text", async () => {
    const s = server();
    s.memory.default.profile = [SAM, "Same words in both files"];
    const { hermes, user } = await shown({ s });
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Same words in both files");
    s.dropOnLearning = "lost";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.type(editor(), " and more");
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes doesn't have your edit/);
    expect(current(/Agent notes/)).toBe(true);
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
    expect(editor().value).toBe("Same words in both files and more");
    expect(s.memory.default.memory[1]).toBe(SHORT);
    expect(s.memory.default.profile).toEqual([SAM, "Same words in both files"]);
  });

  it("doesn't take another entry with the same words for a lost save in the same file", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(FALCON));
    await user.clear(editor());
    await user.type(editor(), BRITISH);
    s.dropOnLearning = "lost";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.type(editor(), " and more");
    // Meanwhile the agent gives the other entry the words of the lost save.
    s.memory.default.memory[1] = BRITISH;
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes doesn't have your edit/);
    expect(screen.getByRole("button", { name: named(FALCON) }).getAttribute("aria-current")).toBe("true");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory).toEqual([`${BRITISH} and more`, BRITISH]);
  });

  it("keeps the edit when a lost save can't be told apart from another entry with the same words", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(FALCON));
    await user.clear(editor());
    await user.type(editor(), BRITISH);
    s.dropOnLearning = "lost";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.type(editor(), " and more");
    // The agent removes the entry being edited meanwhile, and has an entry with the lost save's words.
    s.memory.default.memory = [BRITISH];
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/save may have gone through.*Your edit is kept below; nothing more was saved/);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit" }).value).toBe(`${BRITISH} and more`);
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    expect(s.memory.default.memory).toEqual([BRITISH]);
  });

  it("still settles a kept edit put in an entry after a Reload", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed it";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry("Agent changed it"));
    await user.click(button(/Put your kept edit in this entry/));
    await user.type(editor(), ", merged");
    await user.click(button(/Reload/));
    await waitFor(() => expect(button(/Reload/)).toHaveProperty("disabled", false));
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory[1]).toBe("Edit A, merged");
    expect(screen.queryByRole("textbox", { name: /Your kept edit/ })).toBeNull();
  });

  it("keeps every edit a conflict leaves, not only the latest", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed B";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry(FALCON));
    await user.clear(editor());
    await user.type(editor(), "Edit C");
    s.memory.default.memory[0] = "Agent changed D";
    await user.click(button("Save"));
    expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 1" })).value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 2" }).value).toBe("Edit C");
    expect(s.memory.default.memory).toEqual(["Agent changed D", "Agent changed B"]);
  });

  it("holds the open entry and file still while a save is under way", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const edit = s.handlers["learning.edit"];
    s.handlers["learning.edit"] = (r) => void gate.then(() => edit(r));
    const { user } = await shown({ s });
    await user.click(entry(SHORT));
    await user.type(editor(), " Saved later.");
    await user.click(button("Save"));
    await waitFor(() => expect(s.requests.some((r) => r.method === "learning.edit")).toBe(true));
    expect(entry(FALCON)).toHaveProperty("disabled", true);
    // A file picked from the list while the save runs waits for it: the entry stays open until the save has read back.
    await user.click(file(/User profile/));
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
    expect(editor().value).toBe(`${SHORT} Saved later.`);
    release();
    await screen.findByText(/Saved, and read back/);
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
    expect(current(/User profile/)).toBe(true);
  });

  it("keeps the edit when Hermes refuses the save, with Hermes's reason", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.click(editor());
    await user.paste("x".repeat(2300));
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes didn't save it: Replacement would put memory at .*\/2,200 chars.*Your edit is still here/);
    expect(editor().value).toContain("x".repeat(2300));
    expect(s.memory.default.memory[1]).toBe(SHORT);
  });

  it("won't save an entry with a separator line in it", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), "{enter}§{enter}second");
    expect(screen.getByText(/saved as several entries/)).toBeTruthy();
    expect(button("Save")).toHaveProperty("disabled", true);
    expect(learning(s, "learning.edit")).toEqual([]);
  });

  it("asks before opening another entry over an unsaved edit", async () => {
    const { user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " More.");
    await user.click(entry(FALCON));
    const ask = screen.getByRole("alertdialog", { name: "Discard your edit?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} More.`);
    await user.click(entry(FALCON));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your edit?" })).getByRole("button", { name: "Discard edit" }));
    expect(editor().value).toBe(FALCON);
  });

  it("removes an entry after asking, and reads back that it's gone", async () => {
    const { s, user } = await shown();
    await user.click(file(/User profile/));
    await user.click(entry(SAM));
    await user.click(button("Delete"));
    await user.click(within(screen.getByRole("alertdialog", { name: "Remove this entry?" })).getByRole("button", { name: "Remove entry" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Removed, and read back/);
    expect(s.memory.default.profile).toEqual([]);
  });

  it("drops the question about removing an entry once a Reload starts, so a late removal can't close a newer edit", async () => {
    const s = server();
    const { user } = await shown({ s });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const frames = s.handlers["learning.frames"];
    s.handlers["learning.frames"] = (r) => void gate.then(() => frames(r));
    await user.click(file(/User profile/));
    await user.click(entry(SAM));
    await user.click(button("Delete"));
    expect(screen.getByRole("alertdialog", { name: "Remove this entry?" })).toBeTruthy();
    await user.click(button(/Reload/));
    expect(screen.queryByRole("alertdialog", { name: "Remove this entry?" })).toBeNull();
    s.handlers["learning.frames"] = frames;
    release();
    await waitFor(() => expect(button(/Reload/).textContent?.trim()).toBe("Reload"));
    await user.click(file(/Agent notes/));
    await user.click(entry(SHORT));
    await user.type(editor(), " Newer words.");
    expect(editor().value).toBe(`${SHORT} Newer words.`);
    expect(s.memory.default.profile).toEqual([SAM]);
  });

  it("shows memory text as plain text, never as markup", async () => {
    const s = server();
    s.memory.default.memory = ['<img src=x onerror="alert(1)"> **not bold** [link](javascript:alert(1))'];
    const { user } = await shown({ s });
    expect(document.querySelector(".memory-entries img, .memory-entries a, .memory-entries strong")).toBeNull();
    await user.click(entry(/<img src=x/));
    expect(editor().value).toBe('<img src=x onerror="alert(1)"> **not bold** [link](javascript:alert(1))');
  });
});

describe("Settings → Memory states", () => {
  it("won't show or edit another profile's memory, as Hermes's calls reach only the dashboard's own", async () => {
    const { s } = await shown({ profile: "research", wait: false });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/This profile's memory can't be edited here/);
    expect(alert.textContent).toMatch(/runs as, which is default. The research profile's memory can't be read or changed/);
    expect(screen.queryByRole("list", { name: /entries$/ })).toBeNull();
    expect(learning(s)).toEqual([]);
  });

  it("says when the server has no memory editing calls", async () => {
    const s = server();
    s.learningMethods = false;
    await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/This Hermes server can't edit memory.*Updating Hermes adds them/);
  });

  it("says when Hermes refuses for lack of permission", async () => {
    const s = server();
    s.handlers["learning.frames"] = (r) => s.fail(r.id, 5000, "learning.frames failed: [Errno 13] Permission denied: '/home/liam/.hermes/memories/MEMORY.md'");
    await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes refused.*Permission denied/);
  });

  it("says when it couldn't read, and tries again", async () => {
    const s = server();
    const frames = s.handlers["learning.frames"];
    s.handlers["learning.frames"] = (r) => s.fail(r.id, 5000, "learning.frames failed: disk I/O error");
    const { user } = await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't read memory.*disk I\/O error/);
    s.handlers["learning.frames"] = frames;
    await user.click(button(/Try again/));
    expect(await screen.findByRole("button", { name: named(FALCON) })).toBeTruthy();
  });

  it("waits for a connection before reading", async () => {
    const { s } = await shown({ status: "offline", wait: false });
    expect(screen.getByRole("status").textContent).toMatch(/Not connected to Hermes/);
    expect(learning(s)).toEqual([]);
  });
});

describe("Settings → Memory as cards of rows (ADR 0059)", () => {
  const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;
  const folded = (el: Element) => !!el.closest(".set-more");
  const names = (el: Element, rows: string) => [...el.querySelectorAll(`${rows} .set-name`)].map((n) => n.textContent);
  /** Memory under Settings' page header: its section has no heading of its own, the header says what it is. */
  const bare = () => screen.getByRole("region", { name: "Memory" });
  /** The Memory component on its own, outside Settings: it draws its own heading, rows and help. */
  async function alone() {
    const hermes = await connect(server().openPipe, "default");
    running.push(hermes);
    render(<MemorySettings api={hermes.memory} profile="default" status="connected" server="ssh://liam@hermes" onDirtyChange={() => {}} />);
    await screen.findByRole("list", { name: "Agent notes entries" });
  }

  it("draws each part as a card of rows, with each entry a row and its editor under it", async () => {
    const { user } = await shown();
    const memory = bare();
    expect(within(memory).queryByRole("heading")).toBeNull();
    const card = memory.querySelector(":scope > .set-card")!;
    // The profile, server and file are the header's (above), not rows of the card.
    expect(names(card, ":scope > .set-row")).toEqual([]);
    const list = screen.getByRole("list", { name: "Agent notes entries" });
    expect(list.parentElement).toBe(card);
    expect(screen.getByRole("button", { name: /^Reload/ }).closest(".page-actions")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Select/ }).closest(".page-actions")).toBeTruthy();
    await user.click(entry(SHORT));
    const editing = screen.getByRole("group", { name: /Edit entry in MEMORY.md/ });
    expect(editing.classList.contains("set-block")).toBe(true);
    expect(editing.closest("li")).toBe(entry(SHORT).closest("li"));
    // When edits take effect is the header's summary box: a card of its rows, and the safety check under its own sub-heading.
    const effect = pageHead().querySelector("section.applies-box")!;
    expect(screen.queryByRole("heading", { name: "When edits take effect" })).toBeNull();
    expect([...effect.querySelectorAll(".set-card")].map((c) => names(c, ".set-row"))).toEqual([["New chats", "Chats already going"], ["Entries Hermes leaves out"]]);
    expect(effect.querySelector(".applies-sub")!.textContent).toBe("Safety checks");
  });

  it("draws the profile, server and file as rows when shown on its own", async () => {
    await alone();
    const memory = section("Memory");
    const card = memory.querySelector(":scope > .set-card")!;
    expect(names(card, ":scope > .set-row")).toEqual(["Profile", "Server", "File"]);
    expect(within(memory).getByRole("button", { name: /^Reload/ }).closest(".set-head")).toBeTruthy();
    expect(names(section("When edits take effect"), ".set-row")).toEqual(["New chats", "Chats already going", "Entries Hermes leaves out"]);
  });

  it("folds the longer help behind an (i) at the end of the header's description, and says in view what Restore can't do", async () => {
    const { user } = await shown();
    const memory = bare();
    // The section's (i) and its help are the header's, under the description.
    expect(within(memory).queryByRole("button", { name: "About Memory" })).toBeNull();
    const about = within(pageHead()).getByRole("button", { name: "About Memory" });
    expect(about.closest(".page-help")).toBeTruthy();
    expect(about.getAttribute("aria-expanded")).toBe("false");
    const help = document.getElementById(about.getAttribute("aria-controls")!)!;
    expect(help.closest(".page-help-text")).toBeTruthy();
    expect(help.hidden).toBe(true);
    expect(help.textContent).toMatch(/To add a memory, ask Hermes in a chat to remember it/);
    expect(help.textContent).not.toMatch(/Restore previous version/);
    await user.click(about);
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(help.hidden).toBe(false);
    const limits = memory.querySelector<HTMLElement>(".memory-restore-limits")!;
    expect(limits.textContent).toMatch(/until you sign out or close Hermes Chat/);
    expect(limits.textContent).toMatch(/a removed entry can't be put back from here/);
    expect(folded(limits)).toBe(false);
    const effect = pageHead().querySelector<HTMLElement>("section.applies-box")!;
    const details = effect.querySelector("details")!;
    expect(details.open).toBe(false);
    await user.click(within(effect).getByText("How changes apply"));
    expect(details.open).toBe(true);
    expect(within(effect).getByRole("button", { name: "About New chats" }).getAttribute("aria-expanded")).toBe("false");
    expect(searchText(effect)).toMatch(/it never restarts Hermes/);
  });

  it("folds the longer help behind an (i) when shown on its own, where Settings search still reads it", async () => {
    const user = userEvent.setup();
    await alone();
    const memory = section("Memory");
    const about = within(memory).getByRole("button", { name: "About Memory" });
    expect(about.getAttribute("aria-expanded")).toBe("false");
    const help = memory.querySelector<HTMLElement>(".set-more")!;
    expect(help.hidden).toBe(true);
    expect(help.textContent).toMatch(/To add a memory, ask Hermes in a chat to remember it/);
    // What Restore can't do is said in view, not behind the (i).
    expect(help.textContent).not.toMatch(/Restore previous version/);
    const limits = memory.querySelector<HTMLElement>(".memory-restore-limits")!;
    expect(limits.textContent).toMatch(/until you sign out or close Hermes Chat/);
    expect(limits.textContent).toMatch(/a removed entry can't be put back from here/);
    expect(folded(limits)).toBe(false);
    expect(searchText(memory)).toMatch(/To add a memory, ask Hermes in a chat/);
    // The (i) isn't part of the heading's name.
    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
    await user.click(about);
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(help.hidden).toBe(false);
    const effect = section("When edits take effect");
    expect(within(effect).getByRole("button", { name: "About New chats" }).getAttribute("aria-expanded")).toBe("false");
    expect(searchText(effect)).toMatch(/it never restarts Hermes/);
  });

  it("never folds a conflict, a kept edit, a question before removing, or being offline", async () => {
    const { s, user } = await shown();
    await user.click(entry(FALCON));
    await user.click(button(/^Delete$/));
    expect(folded(screen.getByRole("alertdialog", { name: "Remove this entry?" }))).toBe(false);
    await user.click(button("Keep it"));
    await user.click(entry(SHORT));
    await user.type(editor(), " Mine");
    s.memory.default.memory[1] = "Owner wants detailed answers.";
    await user.click(button("Save"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Nothing was saved/);
    expect(folded(alert)).toBe(false);
    expect(alert.closest(".set-card")).toBeTruthy();
    const kept = screen.getByRole("group", { name: "Your kept edit" });
    expect(folded(kept)).toBe(false);
    expect(kept.textContent).toMatch(/not saved anywhere/);
  });

  it("keeps the open entry's editor, and what the owner did to its box, across a save that changes the entry's id", async () => {
    const { user } = await shown();
    await user.click(entry(SHORT));
    const box = editor();
    box.style.height = "321px";
    await user.type(box, " Mine");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back from Hermes/);
    // The same textarea, not a new one: its resized height and place stay.
    expect(editor()).toBe(box);
    expect(box.style.height).toBe("321px");
  });

  it("keeps the focus on an entry opened from the keyboard", async () => {
    const { user } = await shown();
    const button = entry(SHORT);
    button.focus();
    await user.keyboard("{Enter}");
    expect(editor()).toBeTruthy();
    // The same button, still focused: opening an entry doesn't remake its row.
    expect(entry(SHORT)).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("shows being offline as a note across the card", async () => {
    await shown({ status: "offline", wait: false });
    const note = screen.getByRole("status");
    expect(note.classList.contains("set-note")).toBe(true);
    expect(folded(note)).toBe(false);
  });
});

// The app around it: leaving Settings, opening a chat or switching profile with an unsaved edit asks first.
let launches = 0;
async function launchApp({ openChat = false } = {}) {
  const s = server();
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  const connection = { mode: "ssh" as const, sshTarget: `liam@hermes-mem-${++launches}`, url: "", username: "liam" };
  const refs = connectionRefs(localStorage);
  const main = (link?: Parameters<typeof Main>[0]["link"]) => <Main hermes={hermes} connection={connection} refs={refs} link={link} onSignOut={async () => {}} />;
  const view = render(main());
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  if (openChat) {
    await user.click(screen.getByText("Nightly backup"));
    await act(async () => void (await hermes.idle()));
  }
  await user.click(screen.getByRole("button", { name: /Settings/ }));
  await user.click(screen.getByRole("tab", { name: /Memory/ }));
  await screen.findByRole("list", { name: "Agent notes entries" });
  await user.click(entry(SHORT));
  await user.type(editor(), " Unsaved words.");
  /**
   * A chat link arriving from outside the app (ADR 0037), as App hands it to Main. The chat list, with its rows and
   * profile switcher, is hidden while Settings is open (ADR 0159), so a link is how a chat or profile opens from here.
   */
  const openLink = async (profile: string, chatId: string) => {
    const parsed = parseChatLink(formatChatLink({ connection: refs.refFor(connection), profile, chatId }));
    if (!parsed.ok) throw new Error("bad link");
    view.rerender(main({ link: parsed.link, at: Date.now() }));
    await act(async () => void (await hermes.idle()));
  };
  return { s, hermes, user, openLink };
}

const leaveDialog = () => screen.getByRole("alertdialog", { name: "Discard your memory edit?" });

describe("Chat beside a memory screen that can't save", () => {
  async function chatAfter(prepare: (s: FakeHermes) => void, onMemory: (user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
    const s = server();
    prepare(s);
    const hermes = await connect(s.openPipe, undefined, memoryCache());
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-mem-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await onMemory(user);
    await user.click(button(/Back to chat/));
    await user.type(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes"), "Still here?{Enter}");
    await waitFor(() => expect(s.requests.some((r) => r.method === "prompt.submit" && r.params.text === "Still here?")).toBe(true));
  }

  it("still sends after a server without the memory calls", async () => {
    await chatAfter(
      (s) => void (s.learningMethods = false),
      // The tab's own read finds no learning.* methods, so the note saying what is missing takes the editor's place (ADR 0044).
      async () => void expect(await screen.findByRole("region", { name: /This Hermes server doesn't support Memory/ })).toBeTruthy(),
    );
  });

  it("still sends after Hermes refused an oversized entry, once the edit is discarded", async () => {
    await chatAfter(
      () => {},
      async (user) => {
        await user.click(await screen.findByRole("button", { name: named(SHORT) }));
        await user.click(editor());
        await user.paste("x".repeat(2300));
        await user.click(button("Save"));
        expect((await screen.findByRole("alert")).textContent).toMatch(/2,200 chars/);
        await user.click(button(/Back to chat/));
        await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
        await user.click(screen.getByRole("button", { name: /Settings/ }));
      },
    );
  });
});

describe("An unsaved memory edit in the app", () => {
  it("asks before Back to chat, and stays on Keep editing", async () => {
    const { user } = await launchApp();
    await user.click(button(/Back to chat/));
    expect(within(leaveDialog()).getByText(/isn't saved to Hermes/)).toBeTruthy();
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    await user.click(button(/Back to chat/));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("asks before another Settings tab", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByRole("tab", { name: /General/ }));
    expect(leaveDialog()).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("tab", { name: /Memory/ }).getAttribute("aria-selected")).toBe("true");
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("asks before opening a chat", async () => {
    const { user, openLink } = await launchApp();
    expect(document.querySelector<HTMLElement>(".list-slot")!.hidden).toBe(true);
    await openLink("default", "backup");
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard your memory edit?" })).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("asks before Outputs and Scheduled jobs, which cover Settings", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByRole("button", { name: "Outputs" }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("asks before switching profile, and switches nothing on Keep editing", async () => {
    const { hermes, user, openLink } = await launchApp();
    // A link to another profile's chat switches profile, through the switcher's question.
    await openLink("research", "notes");
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard your memory edit?" })).getByRole("button", { name: "Keep editing" }));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("stays in Settings when the chat behind it leaves the list meanwhile", async () => {
    const { s, hermes } = await launchApp({ openChat: true });
    // Deleted in another client: the list read on reconnecting no longer has it, so its pane gives way to a New chat,
    // which would close Settings.
    s.sessions = s.sessions.filter((c) => c.id !== "backup");
    s.drop();
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(document.querySelector("[data-pane] .chat-title span")?.textContent).toBe("New chat"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("asks on Ctrl+\\, which closes Settings to show the split, as Settings → Persona does", async () => {
    const { user } = await launchApp({ openChat: true });
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    expect(document.querySelectorAll("[data-pane]").length).toBe(1);
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(document.querySelectorAll("[data-pane]").length).toBe(2);
  });

  it("drops the edit on Discard even when Settings stays open", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await screen.findByRole("list", { name: "Agent notes entries" });
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    await user.click(button(/Back to chat/));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes Settings as before when there's no unsaved edit", async () => {
    const { user, openLink } = await launchApp();
    await user.click(button("Cancel"));
    await openLink("default", "backup");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });
});
