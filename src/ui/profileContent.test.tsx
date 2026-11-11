// @vitest-environment jsdom
// Settings → Skills, Memory and Persona for any profile (ADR 0118), in the whole app against the fake dashboard: each
// tab picks the profile it shows; skills are copied, moved and deleted (archived) in Select mode, each read back;
// memory entries are deleted several at a time; SOUL.md is copied over another profile's; and picking another profile
// with an unsaved edit asks first. Every skill, entry and persona here is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { PersonaStore, personaKey } from "../hermes/personaStore";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { RestError } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

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
const SPARE = `${HOME}/profiles/spare`;
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nWhen asked.\n`;
const NOTES = skill("release-notes", "Write release notes from merged PRs.");
const SOUL = "# Default\n\nYou are terse.\n";
const SPARE_SOUL = "# Spare\n\nYou are chatty.\n";

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}

let launches = 0;
async function launch() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { spare: [] };
  s.learningRoutes = true;
  s.skills.add("default", { dir: `${HOME}/skills/writing/release-notes`, source: "agent", category: "writing" }, NOTES);
  s.skills.add("default", { dir: `${HOME}/skills/github`, source: "bundled" }, skill("github", "Work with GitHub."));
  s.skills.add("spare", { dir: `${SPARE}/skills/scratch`, source: "agent" }, skill("scratch", "The spare profile's own skill."));
  s.memory = {
    default: { memory: ["Project Falcon uses Postgres 16."], profile: ["Works in UTC+1."] },
    spare: { memory: ["Spare note one.", "Spare note two.", "Spare note three."], profile: [] },
  };
  s.souls = { default: SOUL, spare: SPARE_SOUL };
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  const store = new PersonaStore(memoryStorage());
  const connection = { mode: "ssh" as const, sshTarget: `liam@hermes-profiles-${++launches}`, url: "", username: "liam" };
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} personaStore={store} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Settings/ }));
  return { s, hermes, store, connection, user };
}

type User = ReturnType<typeof userEvent.setup>;
const skillsList = () => screen.getByRole("list", { name: "Skills" });
const rowOf = (name: string) => within(skillsList()).getByText(name, { selector: ".mono" }).closest("li")! as HTMLElement;
const listed = () => within(skillsList()).getAllByText(/./, { selector: ".skill-name > .mono" }).map((e) => e.textContent);

async function openSkills(user: User) {
  await user.click(screen.getByRole("tab", { name: /Skills/ }));
  await screen.findByRole("list", { name: "Skills" });
}

/** Turns on Select mode and picks `names`. */
async function select(user: User, ...names: string[]) {
  await user.click(screen.getByRole("button", { name: "Select" }));
  for (const n of names) await user.click(within(rowOf(n)).getByRole("checkbox"));
}

describe("Settings → Skills for any profile", () => {
  it("shows the picked profile's skills, starting on the app's, without switching the app", async () => {
    const { hermes, user } = await launch();
    await openSkills(user);
    const pick = screen.getByRole<HTMLSelectElement>("combobox", { name: "Profile whose skills are shown" });
    await waitFor(() => expect([...pick.options].map((o) => o.textContent)).toEqual(["default (in use)", "spare"]));
    expect(listed()).toEqual(["release-notes", "github"]);
    await user.selectOptions(pick, "spare");
    await waitFor(() => expect(listed()).toEqual(["scratch"]));
    expect(hermes.profile).toBe("default");
  });

  it("copies the selected skills to another profile, each read back, and leaves them here", async () => {
    const { s, user } = await launch();
    await openSkills(user);
    await select(user, "release-notes", "github");
    expect(screen.getByText("2 skills selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Copy to…/ }));
    const ask = screen.getByRole("alertdialog", { name: "Copy the selected skills?" });
    expect(within(ask).getByRole<HTMLSelectElement>("combobox", { name: "To profile" }).value).toBe("spare");
    expect(ask.textContent).toMatch(/Only SKILL.md is copied/);
    await user.click(within(ask).getByRole("button", { name: "Copy 2 skills" }));
    const done = await screen.findByText("Copied 2 of 2 skills to spare.");
    expect(done.closest(".skills-bulk-result")!.textContent).toMatch(/release-notes: Copied to spare, and read back from Hermes there/);
    expect(s.skills.file(`${SPARE}/skills/writing/release-notes`)).toBe(NOTES);
    expect(s.skills.file(`${SPARE}/skills/github`)).toContain("Work with GitHub.");
    expect(listed()).toEqual(["release-notes", "github"]);
  });

  it("moves only Local skills: the copy reads back first, then the original is archived", async () => {
    const { s, user } = await launch();
    await openSkills(user);
    await select(user, "release-notes", "github");
    expect(screen.getByText(/Hermes won't archive github, so Move and Delete leave it out; Copy still works/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Move to…/ }));
    const ask = screen.getByRole("alertdialog", { name: "Move the selected skills?" });
    await user.click(within(ask).getByRole("button", { name: "Move 1 skill" }));
    await screen.findByText("Moved 1 of 1 skill to spare.");
    expect(s.skills.file(`${SPARE}/skills/writing/release-notes`)).toBe(NOTES);
    expect(s.skills.archived.default.map((k) => k.dir)).toEqual([`${HOME}/skills/writing/release-notes`]);
    await waitFor(() => expect(listed()).toEqual(["github"]));
    // github stays here, still picked; release-notes went, so it isn't.
    expect(screen.getByText("1 skill selected")).toBeTruthy();
    expect(screen.getByText(/curator restore/)).toBeTruthy();
  });

  it("keeps a move's original when Hermes refuses the copy", async () => {
    const { s, user } = await launch();
    s.skills.add("spare", { dir: `${SPARE}/skills/release-notes`, source: "agent" }, skill("release-notes", "Spare's own."));
    await openSkills(user);
    await select(user, "release-notes");
    await user.click(screen.getByRole("button", { name: /Move to…/ }));
    await user.click(screen.getByRole("button", { name: "Move 1 skill" }));
    const result = (await screen.findByText("Moved 0 of 1 skill to spare.")).closest(".skills-bulk-result")!;
    expect(result.getAttribute("role")).toBe("alert");
    expect(result.textContent).toMatch(/A skill named 'release-notes' already exists/);
    expect(s.skills.archived.default ?? []).toEqual([]);
    expect(listed()).toContain("release-notes");
  });

  it("moves nothing, and archives nothing, for a skill whose category a copy couldn't keep", async () => {
    const { s, user } = await launch();
    s.skills.add("default", { dir: `${HOME}/skills/DevOps/deploy`, source: "agent", category: "DevOps" }, skill("deploy", "Deploy."));
    await openSkills(user);
    await select(user, "deploy");
    await user.click(screen.getByRole("button", { name: /Move to…/ }));
    await user.click(screen.getByRole("button", { name: "Move 1 skill" }));
    const result = (await screen.findByText("Moved 0 of 1 skill to spare.")).closest(".skills-bulk-result")!;
    expect(result.textContent).toMatch(/the category "DevOps"/);
    expect(s.restRequests.some((r) => r.method === "POST" || r.method === "DELETE")).toBe(false);
    expect(listed()).toContain("deploy");
  });

  it("deletes the selected Local skills by archiving them, after asking", async () => {
    const { s, user } = await launch();
    await openSkills(user);
    await select(user, "release-notes");
    await user.click(screen.getByRole("button", { name: /Delete…/ }));
    const ask = screen.getByRole("alertdialog", { name: "Delete the selected skills?" });
    expect(ask.textContent).toMatch(/Hermes archives each one/);
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(s.restRequests.some((r) => r.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: /Delete…/ }));
    await user.click(screen.getByRole("button", { name: "Delete 1 skill" }));
    await screen.findByText("Archived 1 of 1 skill.");
    await waitFor(() => expect(listed()).toEqual(["github"]));
    expect(s.skills.archived.default).toHaveLength(1);
  });

  it("offers no Move or Delete for skills Hermes won't archive", async () => {
    const { user } = await launch();
    await openSkills(user);
    await select(user, "github");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Move to…/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Delete…/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Copy to…/ }).disabled).toBe(false);
  });

  it("offers no Move or Delete for a skill listed by its path, which Hermes can't archive by name", async () => {
    const { s, user } = await launch();
    s.skills.add("default", { dir: `${HOME}/skills/writing/notes`, source: "agent", category: "writing" }, skill("notes", "Writing notes."));
    s.skills.add("default", { dir: `${HOME}/skills/devops/notes`, source: "agent", category: "devops" }, skill("notes", "Ops notes."));
    await openSkills(user);
    await select(user, "writing/notes");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Move to…/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Delete…/ }).disabled).toBe(true);
    expect(screen.getByText(/a skill listed by its folder path/)).toBeTruthy();
    // Picked with a Local one, only that one moves.
    await user.click(within(rowOf("release-notes")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Move to…/ }));
    expect(screen.getByRole("button", { name: "Move 1 skill" })).toBeTruthy();
  });

  it("asks before picking another profile drops an unsaved skill edit", async () => {
    const { user } = await launch();
    await openSkills(user);
    await user.click(within(rowOf("release-notes")).getByRole("button", { name: "Edit" }));
    const text = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: /SKILL\.md/ });
    await user.type(text, "Unsaved.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile whose skills are shown" }), "spare");
    const dialog = screen.getByRole("alertdialog", { name: "Discard your skill edit?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: /SKILL\.md/ }).value).toBe(`${NOTES}Unsaved.`);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Profile whose skills are shown" }).value).toBe("default");
  });
});

describe("Settings → Memory for any profile", () => {
  const entries = () => within(screen.getByRole("list", { name: /entries$/ })).getAllByRole("listitem").map((li) => li.textContent);

  it("shows another profile's memory and deletes several entries at once", async () => {
    const { s, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await screen.findByText(/Project Falcon/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile whose memory is shown" }), "spare");
    await screen.findByText("Spare note one.");
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByText(/Entries can't be copied or moved to another profile/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Spare note one/ }));
    await user.click(screen.getByRole("checkbox", { name: /Spare note three/ }));
    await user.click(screen.getByRole("button", { name: /Delete…/ }));
    const ask = screen.getByRole("alertdialog", { name: "Delete the selected entries?" });
    expect(ask.textContent).toMatch(/Remove 2 entries from MEMORY.md in the spare profile/);
    await user.click(within(ask).getByRole("button", { name: "Remove 2 entries" }));
    await screen.findByText(/Removed 2 of 2 entries/);
    expect(s.memory.spare.memory).toEqual(["Spare note two."]);
    expect(s.memory.default.memory).toEqual(["Project Falcon uses Postgres 16."]);
    await waitFor(() => expect(entries()).toEqual([expect.stringContaining("Spare note two.")]));
  });
});

describe("Settings → Memory selection after a partial removal", () => {
  it("keeps a refused entry picked, though its position moved, and removes it on a second try", async () => {
    const { s, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Profile whose memory is shown" }), "spare");
    await screen.findByText("Spare note one.");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("checkbox", { name: /Spare note one/ }));
    await user.click(screen.getByRole("checkbox", { name: /Spare note three/ }));
    // Hermes takes the first removal and refuses the second.
    let writes = 0;
    s.beforeLearningRest = () => {
      if (++writes === 2) s.learningRestRefusal = { status: 400, detail: "MEMORY.md is busy" };
    };
    await user.click(screen.getByRole("button", { name: /Delete…/ }));
    await user.click(screen.getByRole("button", { name: "Remove 2 entries" }));
    await screen.findByText(/Removed 1 of 2 entries/);
    expect(s.memory.spare.memory).toEqual(["Spare note two.", "Spare note three."]);
    // "Spare note three." moved from third to second, and is still the one picked.
    expect(screen.getByText("1 entry selected")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Spare note three/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Spare note two/ }).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: /Delete…/ }));
    await user.click(screen.getByRole("button", { name: "Remove 1 entry" }));
    await screen.findByText(/Removed 1 of 1 entry/);
    expect(s.memory.spare.memory).toEqual(["Spare note two."]);
  });
});

describe("Settings → Persona for any profile", () => {
  const soul = (profile: string) => screen.findByRole<HTMLTextAreaElement>("textbox", { name: `SOUL.md for the ${profile} profile` });

  it("shows the picked profile's SOUL.md, and copies the saved one over another profile's after asking", async () => {
    const { s, store, connection, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    expect((await soul("default")).value).toBe(SOUL);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "spare");
    expect((await soul("spare")).value).toBe(SPARE_SOUL);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "default");
    await soul("default");
    await user.click(screen.getByRole("button", { name: /Copy…/ }));
    const ask = await screen.findByRole("alertdialog", { name: "Replace spare's SOUL.md?" });
    await waitFor(() => expect(ask.textContent).toMatch(/Replace spare's SOUL.md \(25 characters\) with default's \(26 characters\)/));
    await user.click(within(ask).getByRole("button", { name: "Replace spare's" }));
    await screen.findByText(/Copied to spare, and read back from Hermes/);
    expect(s.souls.spare).toBe(SOUL);
    expect(s.souls.default).toBe(SOUL);
    // What spare had is kept with spare's own earlier versions.
    expect(store.earlier(personaKey(connection, "spare")).map((v) => v.content)).toEqual([SPARE_SOUL]);
  });

  it("keeps what the other profile had when a copy's outcome can't be told, and says it may have been written", async () => {
    const { s, store, connection, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    await soul("default");
    await user.click(screen.getByRole("button", { name: /Copy…/ }));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Replace spare's SOUL.md?" }).textContent).toMatch(/25 characters/));
    // Hermes writes it, then the answer is lost, and reading it back fails too.
    s.soulWriteLost = "Can't reach the Hermes dashboard: connection reset";
    s.afterSoulWrite = () => (s.soulReadError = new RestError(500, `{"detail":"read failed"}`));
    await user.click(screen.getByRole("button", { name: "Replace spare's" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes may have written the copy to spare, but it couldn't be confirmed/);
    expect(s.souls.spare).toBe(SOUL);
    expect(store.earlier(personaKey(connection, "spare")).map((v) => v.content)).toEqual([SPARE_SOUL]);
  });

  it("waits for a save to the other profile already under way, and won't copy over one that starts meanwhile", async () => {
    const { s, store, connection, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    await soul("default");
    const key = personaKey(connection, "spare");
    let finish = () => {};
    store.trackSave(key, new Promise<void>((r) => (finish = r)));
    await user.click(screen.getByRole("button", { name: /Copy…/ }));
    const ask = screen.getByRole("alertdialog", { name: "Replace spare's SOUL.md?" });
    expect(ask.textContent).toMatch(/Reading spare's SOUL.md…/);
    expect(s.restRequests.filter((r) => r.method === "GET" && r.path === "/api/profiles/spare/soul")).toHaveLength(0);
    await act(async () => finish());
    await waitFor(() => expect(ask.textContent).toMatch(/Replace spare's SOUL.md \(25 characters\)/));
    // Another save to spare starts after the question was answered.
    store.trackSave(key, new Promise<void>(() => {}));
    await user.click(screen.getByRole("button", { name: "Replace spare's" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/A save to spare's persona is still under way, so nothing was copied/);
    expect(s.souls.spare).toBe(SPARE_SOUL);
  });

  it("drops the copy question once the owner starts editing", async () => {
    const { s, user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    await user.click(screen.getByRole("button", { name: /Copy…/ }));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Replace spare's SOUL.md?" }).textContent).toMatch(/25 characters/));
    await user.type(await soul("default"), "More.");
    expect(screen.queryByRole("alertdialog", { name: "Replace spare's SOUL.md?" })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Copy…/ }).disabled).toBe(true);
    expect(s.souls.spare).toBe(SPARE_SOUL);
  });

  it("copies nothing while there's an unsaved edit, and the question before leaving names the profile edited", async () => {
    const { user } = await launch();
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    await soul("default");
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "spare");
    await user.type(await soul("spare"), "More.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Copy…/ }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    const dialog = screen.getByRole("alertdialog", { name: /without saving the persona/ });
    expect(dialog.textContent).toMatch(/SOUL.md for the spare profile/);
  });
});
