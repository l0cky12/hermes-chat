// @vitest-environment jsdom
// Settings → Skills on screen, against the fake dashboard: the list with source, scope and state, search, switches
// read back, the editor's file identity, validation errors that keep the edit, missing referenced files, a concurrent
// edit kept beside the owner's and merged, restoring a version saved over here, inert skill text, and asking before an
// unsaved edit is dropped. Every skill here is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import type { ConnectionStatus } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { appearanceStore } from "./appearance";
import { SettingsSearching } from "./SettingRows";
import { SettingsScreen } from "./Settings";
import { queryWords, searchText, textMatches } from "./settingsSearch";
import { SkillSettings } from "./SkillSettings";

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

const HOME = "/home/liam/.hermes";
const DIR = `${HOME}/skills/writing/release-notes`;
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\nx-custom: keep\n---\n\n${body}`;
const NOTES = skill("release-notes", "Write release notes from merged PRs.", "## When to Use\n\nFollow references/style.md.\n");

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { spare: [row("notes", 1, { pinned: true, title: "Reading notes" })] };
  s.skills.add("default", { dir: DIR, source: "agent", category: "writing" }, NOTES, { "references/style.md": "Short." });
  s.skills.add("default", { dir: `${HOME}/skills/github`, source: "bundled" }, skill("github", "Work with GitHub.", "Use gh.\n"));
  s.skills.add("default", { dir: "/srv/shared-skills/house-style", source: "external" }, skill("house-style", "The team's <b>house</b> style.", "<img src=x onerror=alert(1)>\n"));
  s.skills.add("default", { dir: `${HOME}/skills/hermes-agent`, source: "bundled" }, skill("hermes-agent", "Hermes itself.", "Docs.\n"));
  s.skills.add("spare", { dir: `${HOME}/profiles/spare/skills/scratch`, source: "agent" }, skill("scratch", "The spare profile's skill.", "Body.\n"));
  return s;
}

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function Shell({ hermes, profile, status }: { hermes: Hermes; profile: string; status: ConnectionStatus }) {
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
      skills={hermes.skills}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown({ s = server(), profile = "default", status = "connected" as ConnectionStatus } = {}) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  const view = render(<Shell hermes={hermes} profile={profile} status={status} />);
  await user.click(screen.getByRole("tab", { name: /Skills/ }));
  await screen.findByRole("list", { name: "Skills" });
  return { s, hermes, user, view };
}

const list = () => screen.getByRole("list", { name: "Skills" });
const rowOf = (name: string) => within(list()).getByText(name, { selector: ".mono" }).closest("li")! as HTMLElement;
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /SKILL\.md/ });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const puts = (s: FakeHermes) => s.restRequests.filter((r) => r.method === "PUT" && r.path === "/api/skills/content");

/** Opens `name` in the editor. */
async function openSkill(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(rowOf(name)).getByRole("button", { name: "Edit" }));
  await screen.findByRole("group", { name: `Edit ${name}` });
}

/** Replaces the editor's text (typing it would be slow and treats braces as keys). */
async function setText(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(editor());
  await user.click(editor());
  await user.paste(text);
}

describe("Settings → Skills list", () => {
  it("lists each skill with its source, scope and state, and a switch that is read back", async () => {
    const { s, user } = await shown();
    expect(within(list()).getAllByRole("listitem").map((li) => li.querySelector(".mono")?.textContent)).toEqual(["release-notes", "house-style", "github", "hermes-agent"]);
    expect(within(rowOf("release-notes")).getByText("Local")).toBeTruthy();
    expect(within(rowOf("release-notes")).getByText("writing")).toBeTruthy();
    expect(within(rowOf("github")).getByText("Built in")).toBeTruthy();
    expect(within(rowOf("house-style")).getByText("Shared folder")).toBeTruthy();
    expect(within(rowOf("hermes-agent")).getByText("Always on")).toBeTruthy();
    expect(within(rowOf("hermes-agent")).queryByRole("switch")).toBeNull();
    const sw = within(rowOf("github")).getByRole("switch", { name: "github" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    expect((await within(rowOf("github")).findByRole("status")).textContent).toMatch(/Turned off, and read back from Hermes. .*refuses to load it in any chat, even one already going/);
    expect(within(rowOf("github")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect([...s.skills.disabled.default]).toEqual(["github"]);
    expect(screen.getByText(/4 skills, 1 off/)).toBeTruthy();
  });

  it("says when reading back doesn't show the switch's change", async () => {
    const s = server();
    const { user } = await shown({ s });
    // Another client turns it straight back on between the write and the read-back.
    s.skills.toggleLost = undefined;
    const route = s.skills.route.bind(s.skills);
    s.skills.route = (req) => {
      const h = route(req);
      return h && req.path === "/api/skills/toggle" ? () => (h(), s.skills.disabled.default?.delete("github"), { ok: true }) : h;
    };
    await user.click(within(rowOf("github")).getByRole("switch"));
    expect((await within(rowOf("github")).findByRole("alert")).textContent).toMatch(/reading back shows github on, so the change didn't take/);
  });

  it("finds skills by name, description or category", async () => {
    const { user } = await shown();
    await user.type(screen.getByRole("searchbox", { name: "Search skills" }), "WRITING");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/1 of 4 skills/)).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search skills" }));
    await user.type(screen.getByRole("searchbox", { name: "Search skills" }), "nothing like this");
    expect(screen.getByText(/No skills match/)).toBeTruthy();
  });

  it("marks a skill a per-platform list keeps off in this app's chats", async () => {
    const s = server();
    s.skills.platformDisabled.default = { tui: ["release-notes"] };
    await shown({ s });
    expect(within(rowOf("release-notes")).getByText("Off in this app's chats")).toBeTruthy();
    expect(within(rowOf("release-notes")).getByText(/skills\.platform_disabled\.tui/)).toBeTruthy();
  });

  it("shows another profile's skills only, and an unsupported server plainly", async () => {
    const { s } = await shown({ profile: "spare" });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    expect(s.restRequests.filter((r) => r.path === "/api/skills").every((r) => r.query.get("profile") === "spare")).toBe(true);
    cleanup();
    const old = server();
    old.skills.routes = false;
    const hermes = await connect(old.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    render(<Shell hermes={hermes} profile="default" status="connected" />);
    await user.click(screen.getByRole("tab", { name: /Skills/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/This Hermes server can't manage skills.*GET \/api\/skills/);
  });

  it("renders skill text as inert text", async () => {
    const { user } = await shown();
    // The description is on its line and again in the hover tip, both as text.
    expect(within(rowOf("house-style")).getAllByText("The team's <b>house</b> style.")).toHaveLength(2);
    expect(document.querySelector("b, img")).toBeNull();
    await openSkill(user, "house-style");
    expect(editor().value).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("Settings → Skills editor", () => {
  it("names the file it edits, saves only on Save, and reads it back", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    const group = screen.getByRole("group", { name: "Edit release-notes" });
    expect(within(group).getByText(`${DIR}/SKILL.md`)).toBeTruthy();
    expect(within(group).getByText("This profile")).toBeTruthy();
    await user.type(editor(), "More.");
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(puts(s)).toEqual([]);
    await user.click(button("Save"));
    expect((await screen.findByText(/Saved, and read back from Hermes/)).textContent).toMatch(/next load, in any chat, gets this text/);
    expect(s.skills.file(DIR)).toBe(`${NOTES}More.`);
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("shows what to fix for malformed front matter, keeps the edit, and lets Hermes's own refusal through", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    await setText(user, NOTES.replace("\n---\n\n## When", "\n\n## When"));
    expect(within(screen.getByRole("alert", { name: "Fix before saving" })).getByText(/front matter isn't closed/)).toBeTruthy();
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    await setText(user, NOTES.replace("name: release-notes", "name: notes-v2"));
    expect(screen.getByText(/Renaming a skill isn't supported here/)).toBeTruthy();
    // A refusal the screen can't foresee (a security scan) is shown as Hermes words it.
    await setText(user, `${NOTES}More.\n`);
    s.skills.writeRefusal = { status: 400, detail: "Security scan blocked this skill (dangerous findings)" };
    await user.click(button("Save"));
    expect((await screen.findByText(/Security scan blocked this skill/)).textContent).toMatch(/Your edit is still here/);
    expect(editor().value).toBe(`${NOTES}More.\n`);
    expect(s.skills.file(DIR)).toBe(NOTES);
  });

  it("stops a save that names files the skill's folder doesn't have, until the owner chooses", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    await setText(user, NOTES.replace("references/style.md", "references/style.md and templates/missing.md"));
    await user.click(button("Save"));
    const problems = await screen.findByRole("alert", { name: "Fix before saving" });
    expect(within(problems).getByText("templates/missing.md")).toBeTruthy();
    expect(puts(s)).toEqual([]);
    await user.click(within(problems).getByRole("button", { name: "Save with missing files" }));
    await screen.findByText(/Saved, and read back/);
    expect(s.skills.file(DIR)).toContain("templates/missing.md");
    // A path out of the folder is never saved.
    await setText(user, `${NOTES}See references/../../../etc/passwd\n`);
    await user.click(button("Save"));
    expect(await screen.findByText(/leads out of the skill's folder/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save with missing files" })).toBeNull();
    expect(puts(s)).toHaveLength(1);
  });

  it("keeps both versions when the skill changed elsewhere, and merges them", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    await setText(user, NOTES.replace("Follow references/style.md.", "Always follow references/style.md."));
    const theirs = NOTES.replace("x-custom: keep", "x-custom: keep\nversion: 2.0.0");
    s.skills.write(DIR, theirs);
    await user.click(button("Save"));
    expect((await screen.findByText(/changed on the server since you opened it, so nothing was saved/)).textContent).toBeTruthy();
    expect(s.skills.file(DIR)).toBe(theirs);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "The version on the server now" }).value).toBe(theirs);
    expect(editor().value).toContain("Always follow");
    await user.click(button(/Merge into my edit/));
    expect(editor().value).toContain("version: 2.0.0");
    expect(editor().value).toContain("Always follow");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.skills.file(DIR)).toBe(editor().value);
  });

  it("keeps the conflict's actions off while a save is under way, so its answer can't replace a merge", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    await setText(user, NOTES.replace("Follow", "Always follow"));
    s.skills.write(DIR, NOTES.replace("x-custom: keep", "x-custom: keep\nversion: 2.0.0"));
    await user.click(button("Save"));
    await screen.findByRole("group", { name: "The version on the server now" });
    let release!: () => void;
    s.skills.readGate = new Promise<void>((r) => (release = r));
    await user.click(button("Save"));
    expect((button(/Merge into my edit/) as HTMLButtonElement).disabled).toBe(true);
    expect((button("Use the server's version") as HTMLButtonElement).disabled).toBe(true);
    await user.click(button(/Merge into my edit/));
    expect(editor().value).toContain("Always follow");
    expect(editor().value).not.toContain("version: 2.0.0");
    release();
    s.skills.readGate = undefined;
    await waitFor(() => expect((button(/Merge into my edit/) as HTMLButtonElement).disabled).toBe(false));
    await user.click(button(/Merge into my edit/));
    expect(editor().value).toContain("version: 2.0.0");
    expect(editor().value).toContain("Always follow");
  });

  it("edits a skill listed by its category path without calling it a rename", async () => {
    const s = server();
    s.skills.add("default", { dir: `${HOME}/skills/notes/release-notes`, source: "agent" }, skill("release-notes", "The other one.", "Body.\n"));
    const { user } = await shown({ s });
    await openSkill(user, "writing/release-notes");
    await user.type(editor(), "More.");
    expect(screen.queryByText(/Renaming a skill/)).toBeNull();
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.skills.file(DIR)).toBe(`${NOTES}More.`);
  });

  it("gives each skill its own element ids, so a switch is named for its own skill", async () => {
    const s = server();
    s.skills.add("default", { dir: `${HOME}/skills/x/example`, source: "agent" }, skill("example", "One.", "Body.\n"));
    s.skills.add("default", { dir: `${HOME}/skills/y/example`, source: "agent" }, skill("example", "Two.", "Body.\n"));
    s.skills.add("default", { dir: `${HOME}/skills/x_example`, source: "agent" }, skill("x_example", "Three.", "Body.\n"));
    await shown({ s });
    expect(screen.getByRole("switch", { name: "x/example" })).not.toBe(screen.getByRole("switch", { name: "x_example" }));
    expect(new Set([...document.querySelectorAll("[id^=skill-]")].map((e) => e.id)).size).toBe(document.querySelectorAll("[id^=skill-]").length);
  });

  it("lists a skill named constructor without mistaking it for a platform list entry", async () => {
    const s = server();
    s.skills.add("default", { dir: `${HOME}/skills/constructor`, source: "agent" }, skill("constructor", "Odd name.", "Body.\n"));
    await shown({ s });
    expect(within(rowOf("constructor")).queryByText("Off in this app's chats")).toBeNull();
  });

  it("restores the version a save from here replaced, to check and save again", async () => {
    const { s, user } = await shown();
    await openSkill(user, "release-notes");
    expect(screen.queryByRole("button", { name: /Restore previous version/ })).toBeNull();
    await user.type(editor(), "Oops.");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    await user.click(button(/Restore previous version/));
    expect(editor().value).toBe(NOTES);
    expect(s.skills.file(DIR)).toBe(`${NOTES}Oops.`);
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.skills.file(DIR)).toBe(NOTES);
  });

  it("keeps the edit when disconnected, with Save and Reload off", async () => {
    const s = server();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<Shell hermes={hermes} profile="default" status="connected" />);
    await user.click(screen.getByRole("tab", { name: /Skills/ }));
    await screen.findByRole("list", { name: "Skills" });
    await openSkill(user, "release-notes");
    await user.type(editor(), "Kept.");
    view.rerender(<Shell hermes={hermes} profile="default" status="offline" />);
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    // The editor's Reload (SKILL.md) and the page header's (the list) are both off.
    const edit = screen.getByRole("group", { name: "Edit release-notes" });
    expect((within(edit).getByRole("button", { name: /Reload/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(document.querySelector(".page-actions") as HTMLElement).getByRole("button", { name: /Reload/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(editor().value).toBe(`${NOTES}Kept.`);
  });

  it("asks before Cancel drops an unsaved edit, and returns focus to the skill", async () => {
    const { user } = await shown();
    await openSkill(user, "release-notes");
    await user.type(editor(), "Draft.");
    await user.click(button("Cancel"));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your edit?" })).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${NOTES}Draft.`);
    await user.click(button("Cancel"));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your edit?" })).getByRole("button", { name: "Discard edit" }));
    await waitFor(() => expect(document.activeElement).toBe(within(rowOf("release-notes")).getByRole("button", { name: "Edit" })));
  });
});

describe("An unsaved skill edit in the app", () => {
  it("asks before leaving Settings, and stays on Keep editing", async () => {
    const s = server();
    const hermes = await connect(s.openPipe, undefined, memoryCache());
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes-skills", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(screen.getByRole("tab", { name: /Skills/ }));
    await screen.findByRole("list", { name: "Skills" });
    await openSkill(user, "release-notes");
    await user.type(editor(), "Unsaved.");
    await user.click(button(/Back to chat/));
    const dialog = screen.getByRole("alertdialog", { name: "Discard your skill edit?" });
    expect(within(dialog).getByText(/a skill in the/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${NOTES}Unsaved.`);
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your skill edit?" })).getByRole("button", { name: "Discard edit" }));
    expect(screen.getByRole("tab", { name: /General/ }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Settings → Skills as cards of rows (#174, ADR 0059)", () => {
  /** The help an (i) button opens. */
  const helpOf = (about: HTMLElement) => document.getElementById(about.getAttribute("aria-controls")!)!;
  /** Whether `el` is on screen: no folded help hides it. */
  const inView = (el: Element) => el.closest("[hidden]") === null;

  it("draws the list as a card of rows under the page header, with a skill's Edit and switch as its row's control", async () => {
    await shown();
    // In Settings the section is bare: the page header names it and holds the profile, the server and Reload (ADR 0160).
    const section = screen.getByRole("region", { name: "Skills" });
    expect(section.querySelector(":scope > .set-head")).toBeNull();
    const card = section.querySelector(":scope > .set-card")!;
    expect(card.querySelectorAll(":scope > .set-row")).toHaveLength(0);
    const head = document.querySelector("header.page-head") as HTMLElement;
    expect(within(head).getByRole("heading", { level: 2 }).textContent).toBe("Skills");
    expect(head.querySelector(".page-slot")!.textContent).toMatch(/Editing profile\s*default/);
    expect(head.querySelector(".page-slot .badge")).toBeNull();
    expect([...head.querySelectorAll(".page-meta .meta-chip")].map((c) => [c.firstElementChild!.textContent, c.querySelector("code")!.textContent])).toEqual([["Server", "ssh://liam@hermes"]]);
    expect(within(head.querySelector(".page-actions") as HTMLElement).getByRole("button", { name: /Reload/ })).toBeTruthy();
    expect(list().parentElement).toBe(card);
    expect(list().classList.contains("set-block")).toBe(true);
    const control = rowOf("github").querySelector(".set-row > .set-control") as HTMLElement;
    expect(within(control).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(control).getByRole("switch", { name: "github" })).toBeTruthy();
    // The description is the row's one-line hint.
    expect(rowOf("github").querySelector(".set-hint")!.textContent).toContain("Work with GitHub.");
    // When changes take effect is the header's summary box: one line, and its four rows behind it.
    expect(screen.queryByRole("heading", { name: "When changes take effect" })).toBeNull();
    const effect = head.querySelector("section.applies-box")!;
    expect(effect.querySelector("summary")!.textContent).toMatch(/Changes reach new chats at once\. Turning a skill off also stops chats already going from loading it\./);
    expect(effect.querySelectorAll(":scope > details > .set-card > .set-row")).toHaveLength(4);
  });

  it("opens the editor in a block of the card, under the skill's own row", async () => {
    const { user } = await shown();
    await openSkill(user, "release-notes");
    const group = screen.getByRole("group", { name: "Edit release-notes" });
    expect(group.classList.contains("set-block")).toBe(true);
    const row = group.previousElementSibling as HTMLElement;
    expect(row.classList.contains("set-row")).toBe(true);
    // The skill's name heads its editor, as a heading of its own, named by the skill alone.
    expect(within(row).getByRole("heading", { level: 3, name: "release-notes" })).toBeTruthy();
  });

  it("folds explanation behind an (i), and keeps consequences, warnings and states in view", async () => {
    const s = server();
    s.skills.platformDisabled.default = { tui: ["release-notes"] };
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<Shell hermes={hermes} profile="default" status="connected" />);
    await user.click(screen.getByRole("tab", { name: /Skills/ }));
    await screen.findByRole("list", { name: "Skills" });

    // In Settings the page header says what the page is (ADR 0160): the section's (i) ends the page's description, and
    // its help opens under it.
    const head = document.querySelector("header.page-head") as HTMLElement;
    expect(head.querySelector(".page-desc")!.textContent).toBe("Instructions Hermes loads for a kind of task. Changes apply to every client on this profile.");
    const about = within(head).getByRole("button", { name: "About Skills" });
    expect(about.getAttribute("aria-expanded")).toBe("false");
    expect(helpOf(about).hidden).toBe(true);
    expect(helpOf(about).textContent).toMatch(/loads the rest when it needs it/);
    await user.click(about);
    expect(helpOf(about).hidden).toBe(false);
    // How changes apply is one line in view; its rows open from the summary box, each row's own help behind its (i).
    const box = head.querySelector("section.applies-box details") as HTMLDetailsElement;
    expect(box.open).toBe(false);
    expect(inView(within(box).getByText(/Turning a skill off also stops chats already going from loading it/))).toBe(true);
    await user.click(box.querySelector("summary")!);
    expect(box.open).toBe(true);
    const off = within(box).getByRole("button", { name: "About Turning a skill off" });
    expect(off.getAttribute("aria-expanded")).toBe("false");
    expect(helpOf(off).hidden).toBe(true);
    expect(helpOf(off).textContent).toMatch(/skills\.disabled list, which every platform follows/);
    await user.click(off);
    expect(helpOf(off).hidden).toBe(false);
    // The (i) never joins the row's name.
    expect(within(box).getByText("Turning a skill off", { selector: ".set-name" })).toBeTruthy();

    // Never behind an (i): what an undo can't bring back, and what keeps a skill off.
    expect(inView(within(box).getByText(/earlier versions aren't kept on the server or on this computer/))).toBe(true);
    expect(inView(within(rowOf("release-notes")).getByText(/skills\.platform_disabled\.tui/))).toBe(true);
    view.rerender(<Shell hermes={hermes} profile="default" status="offline" />);
    const stale = screen.getByText(/Not connected to Hermes. These are the skills as read at/);
    expect(inView(stale)).toBe(true);
    expect(stale.closest(".set-note.warn")!.getAttribute("role")).toBe("status");
  });

  it("opens every fold while Settings is searched, and the folded words are in the text search reads", async () => {
    const hermes = await connect(server().openPipe, "default");
    running.push(hermes);
    render(
      <SettingsSearching.Provider value>
        <SkillSettings api={hermes.skills} profile="default" status="connected" server="liam@hermes" onDirtyChange={() => {}} />
      </SettingsSearching.Provider>,
    );
    await screen.findByRole("list", { name: "Skills" });
    for (const name of ["About Skills", "About Saving an edit", "About Turning a skill off"]) {
      const about = screen.getByRole("button", { name });
      expect(about.getAttribute("aria-expanded")).toBe("true");
      expect(helpOf(about).hidden).toBe(false);
    }
    const effect = screen.getByRole("heading", { name: "When changes take effect", level: 2 }).closest("section")!;
    expect(textMatches(searchText(effect), queryWords("skills.disabled every platform"))).toBe(true);
    const skills = screen.getByRole("region", { name: "Skills" });
    expect(textMatches(searchText(skills), queryWords("loads the rest"))).toBe(true);
  });

  it("is named by Settings' search, which opens the tab rather than mounting it", async () => {
    const { user } = await shown();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "SKILL.md");
    await user.click(await screen.findByRole("button", { name: "Open Skills" }));
    expect(screen.getByRole("tab", { name: /Skills/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("list", { name: "Skills" })).toBeTruthy();
  });
});
