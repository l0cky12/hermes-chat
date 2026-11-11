// @vitest-environment jsdom
// Projects in the app: the switcher under the profile's name, a chat's menu, and the project screen, against a fake
// Hermes that answers `projects.*`, `GET /api/fs/list` and `GET /api/git/worktrees` as the deployed server did.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { PROJECTS_KEY, PROJECTS_VERSION, projectLinks, projectScope } from "../hermes/projectLinks";
import { savedDefaults, type DefaultsDraft } from "../hermes/projectDefaults";
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

const project = (id: string, name: string, folders: string[] = []): FakeProject => ({
  id,
  slug: id,
  name,
  primary_path: folders[0] ?? null,
  archived: false,
  created_at: 1,
  folders: folders.map((path, i) => ({ path, label: null, is_primary: i === 0, added_at: 1 })),
});

/** Three Active chats and two Settled ones, one of each unread; a project that already exists; a repo with a worktree. */
function server() {
  const s = new FakeHermes();
  s.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks", last_read_at: 0 }),
    row("login", 3, { pinned: true, title: "Login page" }),
    row("old", 5, { title: "Old notes", last_read_at: 0 }),
    row("deps", 6, { title: "Dependency bump" }),
  ];
  s.projects.default = [project("p_budget", "Budget Tracker", ["/srv/budget"])];
  s.serverDirs = new Set(["/srv", "/srv/app", "/srv/app-feature", "/srv/budget"]);
  s.serverFiles = { "/srv/readme.md": "" };
  for (const dir of s.serverDirs) s.managedFiles.nodes[dir] = { dir: true };
  s.repos = [[{ path: "/srv/app", branch: "main" }, { path: "/srv/app-feature", branch: "feature/login" }]];
  return s;
}

async function launch(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const switcher = () => document.querySelector<HTMLElement>(".project-btn")!;
const listedTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);
/** The Active chats the list shows: the Inbox and Working (ADR 0063), not Settled, which is in the same scroll. */
const activeTitles = () =>
  [...document.querySelectorAll('.sb-scroll .row:is([data-section="inbox"], [data-section="working"]) .row-open .row-title')].map((e) => e.textContent);
const onScreen = () => document.querySelector(".chat-title span")?.textContent;

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(switcher());
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

type Part = "Folders" | "Defaults for new chats" | "Rename" | "Delete project";
async function openPart(user: ReturnType<typeof userEvent.setup>, part: Part) {
  await user.click(screen.getByRole("button", { name: "Project settings" }));
  await user.click(screen.getByRole("menuitem", { name: part }));
}

async function putInProject(user: ReturnType<typeof userEvent.setup>, chat: string, name: string) {
  const open = screen.getByRole("button", { name: new RegExp(chat) });
  await user.pointer({ keys: "[MouseRight]", target: open });
  await user.click(await screen.findByRole("menuitemcheckbox", { name }));
}

describe("the project switcher", () => {
  it("lists the profile's projects in Hermes, and shows every chat until one is picked", async () => {
    const s = server();
    await launch(s);
    expect(switcher().textContent).toContain("All chats");
    expect(s.requests.filter((r) => r.method === "projects.list").map((r) => r.params)).toEqual([{ profile: "default" }]);
    expect(activeTitles()).toEqual(["Nightly backup", "NAS disks", "Login page"]);
    const user = userEvent.setup();
    await user.click(switcher());
    const options = within(screen.getByRole("listbox", { name: "Projects" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All chats", "Budget Tracker"]);
    // Two unread chats in the list: one Active, one Settled.
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("narrows the list to the project's chats, keeping Active, Settled and Unread", async () => {
    const s = server();
    const { user, hermes } = await launch(s);
    await putInProject(user, "Nightly backup", "Budget Tracker");
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    await putInProject(user, "Old notes", "Budget Tracker");
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    await pick(user, "Budget Tracker");
    expect(switcher().textContent).toContain("Budget Tracker");
    expect(activeTitles()).toEqual(["Nightly backup"]);
    // The Settled drawer counts and dots only the project's Settled chats.
    const settled = screen.getByRole("button", { name: /Settled/ });
    expect(settled.textContent).toContain("1");
    expect(settled.querySelector(".dot")).not.toBeNull();
    // NAS disks is unread and not shown: the switcher says so.
    expect(switcher().querySelector(".dot")).not.toBeNull();
    expect(switcher().title).toContain("1 unread chat isn't shown");

    // Settling inside the project works as it does in the full list.
    await user.click(within(screen.getByRole("button", { name: /Nightly backup/ }).parentElement!).getByTitle("Settle"));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(activeTitles()).toEqual([]));
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    expect(listedTitles()).toEqual(expect.arrayContaining(["Nightly backup", "Old notes"]));

    await pick(user, "All chats");
    expect(activeTitles()).toEqual(["NAS disks", "Login page"]);
  });

  it("makes a project in Hermes, shows it, and opens its screen", async () => {
    const s = server();
    const { user } = await launch(s);
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /New project/ }));
    await user.type(screen.getByRole("textbox", { name: "New project name" }), "Home lab{Enter}");
    await screen.findByRole("heading", { name: /Home lab/ });
    expect(s.requests.filter((r) => r.method === "projects.create").map((r) => r.params)).toEqual([{ profile: "default", name: "Home lab" }]);
    expect(s.projects.default.map((p) => p.name)).toEqual(["Budget Tracker", "Home lab"]);
    expect(switcher().textContent).toContain("Home lab");
    expect(activeTitles()).toEqual([]);
  });

  it("is kept across a restart, with which chats are in each project", async () => {
    const s = server();
    const first = await launch(s);
    await putInProject(first.user, "Login page", "Budget Tracker");
    await pick(first.user, "Budget Tracker");
    cleanup();
    await Promise.all(running.splice(0).map((h) => h.close()));
    expect(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).v).toBe(PROJECTS_VERSION);

    await launch(s);
    expect(switcher().textContent).toContain("Budget Tracker");
    expect(activeTitles()).toEqual(["Login page"]);
  });
});

describe("a chat's menu", () => {
  it("puts a chat in a project and takes it out, on this computer only, with Undo", async () => {
    const s = server();
    const { user } = await launch(s);
    const writes = () => s.restRequests.filter((r) => r.method !== "GET").length;
    const before = writes();
    await putInProject(user, "NAS disks", "Budget Tracker");
    expect(screen.getByRole("status").textContent).toContain("Put in Budget Tracker: NAS disks");
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getByRole("menuitemcheckbox", { name: "Budget Tracker" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getByRole("menuitemcheckbox", { name: "Budget Tracker" }).getAttribute("aria-checked")).toBe("false");
    expect(writes()).toBe(before);
  });

  it("offers no projects when the profile has none", async () => {
    const s = server();
    s.projects.default = [];
    const { user } = await launch(s);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Rename…",
      "Regenerate title",
      "Copy chat link",
      "Open in a new tab",
      "Open in a second pane",
      // Pin (ADR 0085), with its key
      "PinP",
      // Settle, which clears it from the Inbox (ADR 0090)
      "Settle",
      // Snooze (ADR 0036)
      "1 hour",
      "3 hours",
      "Tomorrow",
      "Next week",
      "Custom…",
      "Add a tag…",
      "Delete chat…",
    ]);
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  });
});

describe("a chat started while a project is shown", () => {
  it("uses the project selected at Send when creation finishes after switching projects", async () => {
    const s = server();
    s.projects.default.push(project("p_lab", "Lab"));
    const create = s.handlers["session.create"];
    let finish!: () => void;
    s.handlers["session.create"] = (r) => { finish = () => create(r); };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Plan the budget{Enter}");
    await waitFor(() => expect(finish).toBeDefined());
    await pick(user, "Lab");
    await act(async () => finish());
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    expect(scopes[0].chats.p_budget).toHaveLength(1);
    expect(scopes[0].chats.p_lab).toBeUndefined();
  });

  it("goes in the project and stays in the list", async () => {
    const s = server();
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    expect(document.querySelector(".chat-title")?.textContent).toContain("Budget Tracker");
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Plan the budget{Enter}");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const before = new Set(["backup", "nas", "login", "old", "deps"]);
    const id = hermes.getSnapshot().chats.find((c) => !before.has(c.id))!.id;
    expect(activeTitles().length).toBe(1);
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    expect(scopes.map((sc) => sc.chats.p_budget)).toEqual([[id]]);
  });
});

describe("the project screen", () => {
  it("keeps one request queue when switching away from a profile and back during a folder write", async () => {
    const s = server();
    s.otherProfiles = { work: [] };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(user, "Folders");
    const checkFolder = hermes.projects.checkFolder;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checking = vi.spyOn(hermes.projects, "checkFolder").mockImplementation(async (profile, path) => {
      if (path === "/srv/app") await gate;
      return checkFolder(profile, path);
    });
    await user.type(screen.getByRole("textbox", { name: "Add a folder on the server" }), "/srv/app{Enter}");
    expect(checking).toHaveBeenCalledWith("default", "/srv/app");
    await act(async () => { await hermes.switchProfile("work"); });
    await act(async () => { await hermes.switchProfile("default"); });
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /New project/ }));
    await user.type(screen.getByRole("textbox", { name: "New project name" }), "New lab{Enter}");
    // A new store would create now and its links could later be erased by the old folder write.
    expect(s.requests.filter((r) => r.method === "projects.create")).toHaveLength(0);
    await act(async () => release());
    await screen.findByRole("heading", { name: /New lab/ });
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await pick(user, "All chats");
    await putInProject(user, "NAS disks", "New lab");
    await pick(user, "New lab");
    expect(activeTitles()).toEqual(["NAS disks"]);
    expect(s.projects.default.find((p) => p.id === "p_budget")!.folders.map((f) => f.path)).toContain("/srv/app");
    await user.click(switcher());
    await act(async () => { await hermes.idle(); });
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    const newProject = s.projects.default.find((p) => p.name === "New lab")!;
    expect(scopes.some((scope) => scope.chats[newProject.id]?.includes("nas"))).toBe(true);
    checking.mockRestore();
  });

  it.each(["deleted", "archived"])("resumes tracking the visible chat when the project is %s elsewhere", async (change) => {
    const s = server();
    const { user, hermes } = await launch(s);
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await screen.findByRole("heading", { name: /Budget Tracker/ });
    const open = vi.spyOn(hermes, "open");
    if (change === "deleted") s.projects.default = [];
    else s.projects.default[0].archived = true;
    await user.click(switcher());
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    const paneKey = document.querySelector<HTMLElement>("[data-pane]")!.dataset.pane!;
    await waitFor(() => expect(open).toHaveBeenCalledWith("nas", paneKey));
    open.mockRestore();
  });

  async function openScreen(s = server(), part?: Part) {
    const app = await launch(s);
    await pick(app.user, "Budget Tracker");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await screen.findByRole("heading", { name: /Budget Tracker/ });
    if (part) await openPart(app.user, part);
    return { s, ...app };
  }

  it("shows each folder's connection and path on the server", async () => {
    await openScreen(server(), "Folders");
    const folder = screen.getByText("/srv/budget", { selector: ".folder-path" }).closest("li")!;
    expect(within(folder).getByText("ssh://liam@hermes")).toBeTruthy();
    expect(within(folder).getByText("Main folder")).toBeTruthy();
  });

  it("returns to the focused composer after opening Settings from Project settings", async () => {
    const { user } = await openScreen();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(document.querySelector(".panes.covered")).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Message Hermes"));
    expect(screen.queryByRole("heading", { name: /Budget Tracker/ })).toBeNull();
  });

  it("adds a folder only once the server has it, and says why it refused one", async () => {
    const { s, user } = await openScreen(server(), "Folders");
    const input = screen.getByRole("textbox", { name: "Add a folder on the server" });
    await user.type(input, "/srv/missing{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("There's no folder at /srv/missing on the server.");
    await user.clear(input);
    await user.type(input, "/srv/readme.md{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("/srv/readme.md is a file on the server, not a folder."));
    await user.clear(input);
    await user.type(input, "srv/app{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("starting with /"));
    expect(s.requests.filter((r) => r.method === "projects.add_folder")).toEqual([]);

    await user.clear(input);
    await user.type(input, "/srv/app{Enter}");
    await screen.findByText("/srv/app", { selector: ".folder-path" });
    expect(s.projects.default[0].folders.map((f) => f.path)).toEqual(["/srv/budget", "/srv/app"]);
    // A git folder shows its branch, and the repository's other worktree is offered, not made.
    await screen.findByText(/main · the repository's main worktree/);
    await user.click(await screen.findByRole("button", { name: "Add the worktree /srv/app-feature" }));
    await screen.findByText(/feature\/login · a worktree of \/srv\/app/);
    expect(s.projects.default[0].folders.map((f) => f.path)).toEqual(["/srv/budget", "/srv/app", "/srv/app-feature"]);
    expect(s.restRequests.filter((r) => /worktree\/(add|remove)|fs\/mkdir/.test(r.path) || r.method !== "GET")).toEqual([]);
  });

  it("takes a folder out of the project and leaves it on the server", async () => {
    const { s, user } = await openScreen(server(), "Folders");
    await user.click(screen.getByRole("button", { name: "Remove /srv/budget from the project" }));
    await screen.findByText("No folders yet.");
    expect(s.projects.default[0].folders).toEqual([]);
    expect(s.serverDirs.has("/srv/budget")).toBe(true);
  });

  it("renames the project in Hermes", async () => {
    const { s, user } = await openScreen();
    await openPart(user, "Rename");
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Budget{Enter}");
    await screen.findByRole("heading", { name: /^Budget$/ });
    expect(s.projects.default[0].name).toBe("Budget");
    expect(switcher().textContent).toContain("Budget");
  });

  it("deletes the project after asking, and keeps its chats and folders", async () => {
    const s = server();
    const app = await launch(s);
    await putInProject(app.user, "NAS disks", "Budget Tracker");
    await pick(app.user, "Budget Tracker");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(app.user, "Delete project");
    const sessionWrites = () => s.restRequests.filter((r) => r.method !== "GET");
    await app.user.click(screen.getByRole("button", { name: /Delete project/ }));
    expect(screen.getByText(/Its 1 chat stay in Hermes/)).toBeTruthy();
    await app.user.click(screen.getAllByRole("button", { name: /Delete project/ }).find((b) => b.classList.contains("danger"))!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Deleted the project Budget Tracker. Its chats and folders are kept."));
    expect(s.projects.default).toEqual([]);
    expect(sessionWrites()).toEqual([]);
    expect(s.serverDirs.has("/srv/budget")).toBe(true);
    expect(switcher().textContent).toContain("All chats");
    expect(activeTitles()).toEqual(["Nightly backup", "NAS disks", "Login page"]);
    expect(onScreen()).toBe("New chat");
  });
});

describe("a project's defaults for new chats", () => {
  const SCOPE = projectScope({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }, "default");
  /** Defaults saved as another window, or an earlier run, would have. */
  const seed = (id: string, draft: DefaultsDraft, base = 0) => savedDefaults.save(SCOPE, id, base, draft);
  const opus = { provider: "anthropic", model: "claude-opus-4-5", effort: "high" as const };
  const creates = (s: FakeHermes) => s.requests.filter((r) => r.method === "session.create").map((r) => r.params);
  const startPanel = () => screen.getByRole("region", { name: "What this chat starts with" });
  const send = async (user: ReturnType<typeof userEvent.setup>, text: string) => user.type(screen.getByPlaceholderText("Message Hermes"), `${text}{Enter}`);

  it("shows what a new chat starts with and where each value comes from, then starts it so", async () => {
    const s = server();
    await seed("p_budget", { instructions: "Use metric units.\nKeep it short.", model: opus, folder: "/srv/budget" });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    const panel = startPanel().textContent!;
    expect(panel).toContain("claude-opus-4-5 (anthropic) project default (Budget Tracker)");
    expect(panel).toContain("High project default (Budget Tracker)");
    expect(panel).toContain("/srv/budget on ssh://liam@hermes project default (Budget Tracker)");
    expect(panel).toContain("Use metric units. project default (Budget Tracker)");
    // The composer shows the project's model too.
    expect(screen.getByRole("button", { name: /^Model:/ }).textContent).toContain("claude-opus-4-5");

    await send(user, "Plan the budget");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const [create] = creates(s);
    expect(create).toMatchObject({ cwd: "/srv/budget", cwd_explicit: true, model: "claude-opus-4-5", provider: "anthropic", reasoning_effort: "high" });
    expect(create.messages).toEqual([{ role: "user", display_kind: "hidden", content: expect.stringContaining("Use metric units.\nKeep it short.") }]);
    // The folder was checked on the server first, read-only.
    expect(s.restRequests.some((r) => r.path === "/api/fs/list" && r.query.get("path") === "/srv/budget")).toBe(true);
    // The instructions aren't sent again with the message.
    expect(s.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Plan the budget"]);
  });

  it("keeps two projects' chats apart, and a chat outside any project on the profile's", async () => {
    const s = server();
    s.projects.default.push(project("p_lab", "Lab", ["/srv/app"]));
    await seed("p_budget", { instructions: "Budget rules", folder: "/srv/budget", model: opus });
    await seed("p_lab", { instructions: "Lab rules", folder: "/srv/app" });
    const { user, hermes } = await launch(s);
    for (const [name, text] of [["Budget Tracker", "one"], ["Lab", "two"], ["All chats", "three"]]) {
      await pick(user, name);
      await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
      await send(user, text);
      await waitFor(() => expect(creates(s).length).toBeGreaterThan(0));
      await act(async () => void (await hermes.idle()));
    }
    const [budget, lab, none] = creates(s);
    expect([budget.cwd, budget.model, String((budget.messages as { content: string }[])[0].content)]).toEqual(["/srv/budget", "claude-opus-4-5", expect.stringContaining("Budget rules")]);
    expect([lab.cwd, lab.model, String((lab.messages as { content: string }[])[0].content)]).toEqual(["/srv/app", "claude-sonnet-4-5", expect.stringContaining("Lab rules")]);
    expect(none).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(none.cwd).toBeUndefined();
    expect(none.messages).toBeUndefined();
  });

  it("starts on a model chosen for the chat over the project's", async () => {
    const s = server();
    await seed("p_budget", { model: opus });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByRole("button", { name: /^Model:/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose a model" })).getByRole("button", { name: /^gpt-5/ }));
    expect(startPanel().textContent).toContain("gpt-5 (openai) chosen for this chat");
    await send(user, "Hi");
    await waitFor(() => expect(creates(s)).toHaveLength(1));
    await act(async () => void (await hermes.idle()));
    expect(creates(s)[0]).toMatchObject({ model: "gpt-5", provider: "openai" });
  });

  it("refuses a folder that's gone or Hermes may not open, and gives the message back", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget" });
    s.serverDirs.delete("/srv/budget");
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await screen.findByText(/Couldn't start a chat: There's no folder at \/srv\/budget on the server/);
    expect(creates(s)).toEqual([]);
    expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("Plan the budget");

    s.serverDirs.add("/srv/budget");
    s.rest["GET /api/fs/list"] = () => ({ entries: [], error: "EACCES" });
    await user.click(screen.getByTitle("Send"));
    await screen.findByText(/Hermes isn't allowed to open \/srv\/budget/);
    expect(creates(s)).toEqual([]);
  });

  it("starts nothing when the profile changes while the folder is being checked", async () => {
    const s = server();
    s.otherProfiles = { work: [] };
    await seed("p_budget", { folder: "/srv/budget", instructions: "Budget only" });
    const list = s.rest["GET /api/fs/list"];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.rest["GET /api/fs/list"] = async (req) => {
      await gate;
      return list(req);
    };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await waitFor(() => expect(s.restRequests.some((r) => r.path === "/api/fs/list")).toBe(true));
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    expect(creates(s)).toEqual([]);
  });

  it("says when the instructions are too long, without losing them", async () => {
    const s = server();
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(user, "Defaults for new chats");
    const box = screen.getByRole("textbox", { name: "Instructions" });
    await user.click(box);
    await user.paste("x".repeat(20_001));
    expect(screen.getByRole("alert").textContent).toContain("Keep the instructions under 20,000 characters; they're 20,001.");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toHaveLength(20_001);
  });

  it("refuses a chat Hermes quietly started in another folder", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget", instructions: "x" });
    const create = s.handlers["session.create"];
    s.handlers["session.create"] = (r) => create({ ...r, params: { ...r.params, cwd: "/elsewhere" } });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await screen.findByText(/Hermes didn't start it in \/srv\/budget: it would have worked in \/home\/hermes/);
    await act(async () => void (await hermes.idle()));
    expect(onScreen()).toBe("New chat");
    expect(s.requests.some((r) => r.method === "prompt.submit")).toBe(false);
    expect(s.requests.some((r) => r.method === "session.close")).toBe(true);
  });

  it("refuses a project model Hermes doesn't offer, rather than swapping it", async () => {
    const s = server();
    await seed("p_budget", { model: { provider: "anthropic", model: "claude-retired" } });
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    expect(within(startPanel()).getByRole("alert").textContent).toContain("claude-retired (anthropic), isn't offered by Hermes");
    await send(user, "Hi");
    await screen.findByText(/Couldn't start a chat: The project's default model/);
    expect(creates(s)).toEqual([]);
  });

  it("can't start a chat offline, and still shows what it would start with", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget" });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await act(async () => s.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Plan the budget{Enter}");
    expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(true);
    expect(startPanel().textContent).toContain("/srv/budget on ssh://liam@hermes");
    expect(creates(s)).toEqual([]);
  });

  it("edits the defaults with Save and Cancel, changes no chat that has started, and applies them to one only when asked", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget" });
    s.projects.default[0].folders.push({ path: "/srv/app", label: null, is_primary: false, added_at: 2 });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const started = hermes.getSnapshot().chats.find((c) => c.runtimeId)!;
    act(() => s.event(started.runtimeId!, "message.complete", { text: "Done." }));
    const before = s.requests.length;

    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(user, "Defaults for new chats");
    const instructions = screen.getByRole("textbox", { name: "Instructions" });
    await user.type(instructions, "Answer in French.");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((instructions as HTMLTextAreaElement).value).toBe("");
    await user.type(instructions, "Answer in French.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Working folder on the server" }), "/srv/app");
    expect(document.getElementById("defaults-folder-hint")!.textContent).toContain("/srv/app on ssh://liam@hermes, profile default");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    await screen.findByText(/Saved\. New chats in this project use these/);
    expect((await savedDefaults.read(SCOPE)).p_budget).toEqual({ rev: 2, instructions: "Answer in French.", folder: "/srv/app" });
    await act(async () => void (await hermes.idle()));
    // The chat that had started didn't change.
    expect(s.requests.slice(before).filter((r) => ["config.set", "session.cwd.set", "prompt.submit"].includes(r.method))).toEqual([]);

    // Apply to this chat asks first, says what changes, and leaves its instructions.
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(onScreen()).not.toBe("New chat");
    await user.click(screen.getByTitle("Apply Budget Tracker's defaults to this chat…"));
    const dialog = screen.getByRole("dialog", { name: "Apply Budget Tracker's defaults to this chat" });
    expect(dialog.textContent).toContain("moves its work to /srv/app");
    expect(dialog.textContent).toContain("Instructions: not changed");
    expect(s.requests.some((r) => r.method === "session.cwd.set")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Apply to this chat" }));
    await screen.findByText("Applied Budget Tracker's defaults to this chat.");
    expect(s.requests.filter((r) => r.method === "session.cwd.set").map((r) => r.params.cwd)).toEqual(["/srv/app"]);
    expect(s.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1);
  });

  it("holds the fields still while a save is under way, so nothing typed meanwhile is lost", async () => {
    const s = server();
    const list = s.rest["GET /api/fs/list"];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.rest["GET /api/fs/list"] = async (req) => {
      await gate;
      return list(req);
    };
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(user, "Defaults for new chats");
    await user.type(screen.getByRole("textbox", { name: "Instructions" }), "First");
    await user.selectOptions(screen.getByRole("combobox", { name: "Working folder on the server" }), "/srv/budget");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    const box = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect((screen.getByRole("combobox", { name: "Working folder on the server" }) as HTMLSelectElement).disabled).toBe(true);
    await user.type(box, " and more");
    expect(box.value).toBe("First");
    await act(async () => release());
    await screen.findByText(/Saved\./);
    expect(box.readOnly).toBe(false);
    expect((await savedDefaults.read(SCOPE)).p_budget).toEqual({ rev: 1, instructions: "First", folder: "/srv/budget" });
  });

  it("starts a chat with no project's defaults once another window shows every chat", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget", instructions: "Budget only" });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    // Another window picked All chats; this one hasn't heard yet.
    projectLinks(localStorage).select(projectScope({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }, "default"), undefined);
    await send(user, "Plan the budget");
    await waitFor(() => expect(creates(s)).toHaveLength(1));
    await act(async () => void (await hermes.idle()));
    expect(creates(s)[0].cwd).toBeUndefined();
    expect(creates(s)[0].messages).toBeUndefined();
  });

  it("starts nothing when the project shown changes while the folder is being checked", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget", instructions: "Budget only" });
    const list = s.rest["GET /api/fs/list"];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.rest["GET /api/fs/list"] = async (req) => {
      await gate;
      return list(req);
    };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await waitFor(() => expect(s.restRequests.some((r) => r.path === "/api/fs/list")).toBe(true));
    // Another window picks All chats meanwhile.
    await act(async () => {
      projectLinks(localStorage).select(projectScope({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }, "default"), undefined);
      window.dispatchEvent(new StorageEvent("storage", { key: PROJECTS_KEY }));
    });
    await act(async () => release());
    await screen.findByText(/Couldn't start a chat: The project shown changed before the chat started/);
    await act(async () => void (await hermes.idle()));
    expect(creates(s)).toEqual([]);
    expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("Plan the budget");
  });

  it("starts nothing when the project's defaults can't be read, rather than using older ones", async () => {
    const s = server();
    await seed("p_budget", { instructions: "OLD instructions" });
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    await waitFor(() => expect(screen.getByRole("region", { name: "What this chat starts with" }).textContent).toContain("OLD instructions"));
    await seed("p_budget", { instructions: "NEW instructions" }, 1);
    const getItem = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === "hermes-chat.project-defaults") throw new Error("disk unreadable");
      return getItem.call(this, key);
    });
    try {
      await send(user, "Plan the budget");
      await screen.findByText(/Couldn't start a chat: Couldn't read the project's defaults on this computer: disk unreadable/);
      expect(creates(s)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("puts focus back on its button when Apply closes", async () => {
    const s = server();
    await seed("p_budget", { folder: "/srv/budget" });
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await send(user, "Plan the budget");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const open = screen.getByTitle("Apply Budget Tracker's defaults to this chat…");
    await user.click(open);
    expect(document.activeElement?.textContent).toBe("Cancel");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Apply Budget/ })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("refuses to save over a save made in another window, and lets the owner choose", async () => {
    const s = server();
    const { user } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await openPart(user, "Defaults for new chats");
    await user.type(screen.getByRole("textbox", { name: "Instructions" }), "Mine");
    await act(async () => {
      await seed("p_budget", { instructions: "Theirs" });
      window.dispatchEvent(new Event("focus"));
    });
    // The owner's edits stay on screen.
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Mine");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    const alert = await screen.findByText(/changed elsewhere since you opened them/);
    expect(alert.closest("[role=alert]")!.textContent).toContain("Saved there: instructions");
    expect((await savedDefaults.read(SCOPE)).p_budget.instructions).toBe("Theirs");
    await user.click(screen.getByRole("button", { name: "Save mine over them" }));
    await screen.findByText(/Saved\./);
    expect((await savedDefaults.read(SCOPE)).p_budget).toEqual({ rev: 2, instructions: "Mine" });
  });
});
