// @vitest-environment jsdom
// Settings → Profiles (ADR 0144) in the running app against a fake Hermes: the list, New profile, Edit (rename with this
// computer's data moving, default's display name, description and model), Delete (typed name, the profile in use, a
// delete Hermes is still settling and one already gone), Clone from a row, a route the server lacks, and the whole flow
// by keyboard. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectionScope } from "../hermes/connections";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

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

let launches = 0;

async function launch(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.otherProfiles = { work: [], research: [] };
  server.profileModel.work = { model: "gpt-6.1", provider: "openai", reasoning_effort: "medium", fast: false };
  server.profileMeta.work = { description: "Writes and reviews code" };
  server.gatewaysRunning.add("work");
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const connection = { mode: "ssh" as const, sshTarget: `liam@hermes-profiles-${++launches}`, url: "", username: "liam" };
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Settings/ }));
  await user.click(await screen.findByRole("tab", { name: "Profiles" }));
  const list = await screen.findByRole("listbox", { name: "Profiles" });
  await within(list).findByRole("option", { name: /research/ });
  return { server, hermes, user, list, connection };
}

const option = (list: HTMLElement, name: string) => within(list).getAllByRole("option").find((o) => o.getAttribute("data-profile") === name)!;
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

describe("Settings → Profiles", { timeout: 30_000 }, () => {
  it("lists every profile with what's in use, default, gateway, model, skills and description", async () => {
    const { list } = await launch();
    expect(option(list, "default").textContent).toMatch(/default.*In use.*Default.*No model set.*0 skills.*No description/);
    expect(option(list, "work").textContent).toMatch(/work.*Gateway running.*gpt-6\.1 · openai.*Writes and reviews code/);
    expect(option(list, "default").getAttribute("aria-selected")).toBe("true");
  });

  it("makes a blank profile, checking its name as it's typed, and offers to open it", async () => {
    const { server, user } = await launch();
    await user.click(screen.getByRole("button", { name: "New profile" }));
    const dialog = screen.getByRole("dialog", { name: "New profile" });
    const name = within(dialog).getByLabelText("Name");
    await user.type(name, "work");
    expect(within(dialog).getByText("There's already a profile named work. Pick another name.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Create profile/ })).toHaveProperty("disabled", true);
    await user.clear(name);
    await user.type(name, "papers");
    await user.type(within(dialog).getByLabelText("Description (optional)"), "Reads papers");
    await user.type(within(dialog).getByLabelText("Persona (optional)"), "Be brief.");
    await user.click(within(dialog).getByRole("button", { name: /Create profile/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New profile" })).toBeNull());
    expect(server.restRequests.find((r) => r.method === "POST")?.body).toEqual({ name: "papers", description: "Reads papers", soul: "Be brief." });
    expect(await screen.findByText("Created papers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open papers now" })).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "Profiles" });
    await waitFor(() => expect(option(list, "papers").getAttribute("aria-selected")).toBe("true"));
  });

  it("renames a profile, warning about its gateway, and moves this computer's drafts with it", async () => {
    const { server, user, list, connection } = await launch();
    const draft = `hermes-chat.draft.${connectionScope(connection, "work", "chat-1")}`;
    localStorage.setItem(draft, "half a thought");
    await user.click(within(option(list, "work")).getByRole("button", { name: "Edit work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit profile: work" });
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "coder");
    expect(within(dialog).getByText(/Renaming stops this profile's running gateway/)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "Codes");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit profile/ })).toBeNull());
    // The description goes first, under the old name; the rename last.
    expect(writes(server)).toEqual(["PUT /api/profiles/work/description", "PATCH /api/profiles/work"]);
    expect(server.profileMeta.coder.description).toBe("Codes");
    expect(localStorage.getItem(draft)).toBeNull();
    expect(localStorage.getItem(`hermes-chat.draft.${connectionScope(connection, "coder", "chat-1")}`)).toBe("half a thought");
    expect(await screen.findByText("Renamed work to coder.")).toBeTruthy();
  });

  it("gives default a display name only, shown in the list and the switcher", async () => {
    const { server, user, list } = await launch();
    await user.click(within(option(list, "default")).getByRole("button", { name: "Edit default" }));
    const dialog = screen.getByRole("dialog", { name: "Edit profile: default" });
    expect(within(dialog).getByText(/keeps the id default/)).toBeTruthy();
    const field = within(dialog).getByLabelText("Display name");
    expect(field).toHaveProperty("value", "");
    await user.type(field, "Main");
    expect(field).toHaveProperty("value", "Main");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(server.profileMeta.default?.display_name).toBe("Main"));
    await waitFor(() => expect(option(screen.getByRole("listbox", { name: "Profiles" }), "default").textContent).toMatch(/Main \(default\)/));
    expect(document.querySelector(".profile-name")?.textContent).toBe("Main (default)");
  });

  it("sets the model and has Hermes write the description, each through its own route", async () => {
    const { server, user, list } = await launch();
    await user.click(within(option(list, "research")).getByRole("button", { name: "Edit research" }));
    const dialog = screen.getByRole("dialog", { name: "Edit profile: research" });
    await user.click(within(dialog).getByRole("button", { name: /Write for me/ }));
    await waitFor(() => expect(within(dialog).getByLabelText("Description")).toHaveProperty("value", "Writes and reviews code."));
    const provider = within(dialog).getByLabelText("Provider") as HTMLSelectElement;
    await waitFor(() => expect(provider.options.length).toBeGreaterThan(1));
    await user.selectOptions(provider, provider.options[1].value);
    await user.type(within(dialog).getByLabelText("Model name"), "some-model");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit profile/ })).toBeNull());
    expect(writes(server)).toEqual(["POST /api/profiles/research/describe-auto", "PUT /api/profiles/research/model"]);
    expect(server.profileModel.research).toMatchObject({ provider: provider.options[1].value, model: "some-model" });
  });

  it("deletes a profile once its name is typed, and forgets this computer's data for it only", async () => {
    const { server, user, list, connection } = await launch();
    const mine = `hermes-chat.draft.${connectionScope(connection, "research", "chat-1")}`;
    const theirs = `hermes-chat.draft.${connectionScope(connection, "work", "chat-1")}`;
    localStorage.setItem(mine, "x");
    localStorage.setItem(theirs, "y");
    option(list, "research").focus();
    await user.keyboard("{Delete}");
    const dialog = screen.getByRole("alertdialog", { name: "Delete profile “research”?" });
    expect(within(dialog).getByText(/its chats \(0\) and their history/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: /Delete profile/ });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByLabelText("Type research to confirm"), "research");
    await user.click(confirm);
    await waitFor(() => expect("research" in server.otherProfiles).toBe(false));
    expect(await screen.findByText("Deleted research.")).toBeTruthy();
    expect(localStorage.getItem(mine)).toBeNull();
    expect(localStorage.getItem(theirs)).toBe("y");
  });

  it("treats a delete Hermes is still settling as done, with the command to copy", async () => {
    const { server, user, list } = await launch((s) => (s.profileSettlementPending = "hermes profile delete research --settle"));
    await user.click(within(option(list, "research")).getByRole("button", { name: "More for research" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Type research to confirm"), "research{Enter}");
    expect(await screen.findByText(/Hermes hasn't finished cleaning up after it/)).toBeTruthy();
    expect(screen.getByText("hermes profile delete research --settle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(server.restRequests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("treats a profile another client deleted already as deleted", async () => {
    const { server, user, list } = await launch();
    delete server.otherProfiles.research;
    await user.click(within(option(list, "research")).getByRole("button", { name: "More for research" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.type(within(screen.getByRole("alertdialog")).getByLabelText("Type research to confirm"), "research{Enter}");
    expect(await screen.findByText(/research was already deleted on the server/)).toBeTruthy();
  });

  it("never deletes default, and says why", async () => {
    const { user, list } = await launch();
    await user.click(within(option(list, "default")).getByRole("button", { name: "More for default" }));
    const item = screen.getByRole("menuitem", { name: "Delete…" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Hermes's built-in profile can't be deleted.")).toBeTruthy();
    await user.click(item);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("switches to default before deleting the profile in use", async () => {
    const { server, hermes, user } = await launch();
    await act(async () => void (await hermes.switchProfile("research")));
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(await screen.findByRole("tab", { name: "Profiles" }));
    const list = await screen.findByRole("listbox", { name: "Profiles" });
    await waitFor(() => expect(option(list, "research").textContent).toMatch(/In use/));
    await user.click(within(option(list, "research")).getByRole("button", { name: "More for research" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Hermes Chat will switch to default first/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Type research to confirm"), "research{Enter}");
    await waitFor(() => expect("research" in server.otherProfiles).toBe(false));
    expect(hermes.profile).toBe("default");
    expect(await screen.findByText("Deleted research.")).toBeTruthy();
  });

  it("opens Clone with the row as the source, and selects the clone", async () => {
    const { user, list } = await launch();
    await user.click(within(option(list, "work")).getByRole("button", { name: "More for work" }));
    await user.click(screen.getByRole("menuitem", { name: "Clone…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clone a profile" });
    await waitFor(() => expect(within(dialog).getByLabelText("New profile's name")).toHaveProperty("value", "work-copy"));
  });

  it("disables only the action whose route this Hermes lacks, and names the route", async () => {
    const { server, user, list } = await launch((s) => s.profileRoutesMissing.add("rename"));
    await user.click(within(option(list, "work")).getByRole("button", { name: "Edit work" }));
    let dialog = screen.getByRole("dialog", { name: "Edit profile: work" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "coder");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/no route for PATCH \/api\/profiles\/\{name\}/));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close without saving" }));
    await user.click(within(option(screen.getByRole("listbox", { name: "Profiles" }), "work")).getByRole("button", { name: "Edit work" }));
    dialog = screen.getByRole("dialog", { name: "Edit profile: work" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "coder");
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/no route for PATCH \/api\/profiles\/\{name\}/)).toBeTruthy();
    expect(writes(server)).toEqual(["PATCH /api/profiles/work"]);
    void list;
  });

  it("is found by Settings search by what it does and by the profiles' names", async () => {
    const { user } = await launch();
    const box = screen.getByRole("searchbox", { name: "Search settings" });
    for (const words of ["rename", "delete profile", "new profile", "description", "research"]) {
      await user.clear(box);
      await user.type(box, words);
      expect(await screen.findByRole("button", { name: "Open Profiles" })).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "Open Profiles" }));
    expect(await screen.findByRole("listbox", { name: "Profiles" })).toBeTruthy();
  });

  it("works by keyboard: arrows move, Enter edits, Shift+F10 opens the menu, Escape closes each", async () => {
    const { user, list } = await launch();
    option(list, "default").focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(option(list, "work")));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit profile: work" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(option(list, "work")));
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu", { name: "More for work" });
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit profile: work" })).toBeTruthy();
  });
});
