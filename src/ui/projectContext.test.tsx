// @vitest-environment jsdom
// A project's context files in the app (ADR 0135): what Hermes is sent when a chat in the project starts and when one
// already open sends its next message, and the project page's Context card.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { savedDefaults } from "../hermes/projectDefaults";
import { DEFAULT_LIMIT_TOKENS } from "../hermes/projectContext";
import { Main } from "../App";
import { RestError } from "../hermes/pipe";
import { setUIPrefs } from "../hermes/uiPrefs";

type DropEvent = { payload: { type: "drop"; paths: string[]; position: { x: number; y: number } } };
const dropListeners = vi.hoisted(() => new Set<(e: DropEvent) => void>());
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (fn: (e: DropEvent) => void) => {
      dropListeners.add(fn);
      return () => dropListeners.delete(fn);
    },
  }),
}));

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

const CONNECTION = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const SCOPE = projectScope(CONNECTION, "default");
const DIR = "/srv/budget/context";
const MARK = "\n\n--- Attached Context ---\n\n";
const CHANGED = 'The context files of the project "Budget Tracker" changed since this chat last got them.';

const project = (id: string, name: string, folders: string[] = []): FakeProject => ({
  id,
  slug: id,
  name,
  primary_path: folders[0] ?? null,
  archived: false,
  created_at: 1,
  folders: folders.map((path, i) => ({ path, label: null, is_primary: i === 0, added_at: 1 })),
});

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  s.projects.default = [project("p_budget", "Budget Tracker", ["/srv/budget"])];
  s.serverDirs = new Set(["/srv", "/srv/budget"]);
  s.managedFiles.nodes = { "/srv/budget": { dir: true }, [`${DIR}/notes.md`]: { text: "Rent is 900.\n" } };
  return s;
}

async function launch(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={CONNECTION} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const settle = () => act(async () => void (await hermes.idle()));
  await settle();
  const user = userEvent.setup();
  const prompts = () => s.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text));
  const send = async (text: string) => {
    const before = prompts().length;
    await user.type(screen.getByPlaceholderText("Message Hermes"), `${text}{Enter}`);
    await waitFor(() => expect(prompts()).toHaveLength(before + 1));
    await settle();
    return prompts()[before];
  };
  const reply = async () => {
    const chat = hermes.getSnapshot().chats.find((c) => c.running && c.runtimeId)!;
    act(() => {
      s.event(chat.runtimeId!, "message.start");
      s.event(chat.runtimeId!, "message.complete", { text: "Noted." });
    });
    await settle();
  };
  const pick = async (name: string) => {
    await user.click(document.querySelector<HTMLElement>(".project-btn")!);
    await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
  };
  const seeded = () => s.requests.filter((r) => r.method === "session.create").map((r) => r.params.messages as { role: string; content: string; display_kind: string }[] | undefined);
  const openPage = async (name = "Budget Tracker") => {
    await pick(name);
    await user.click(screen.getByTitle(`Project settings for ${name}`));
    await screen.findByRole("heading", { name: new RegExp(name) });
    await settle();
    return within(screen.getByRole("region", { name: "Context" }));
  };
  const add = async (item: "Upload files" | "Add text content") => {
    await user.click(screen.getByRole("button", { name: "Add context" }));
    await user.click(screen.getByRole("menuitem", { name: item }));
  };
  return { hermes, user, send, reply, pick, prompts, seeded, settle, openPage, add };
}

const cards = () => [...document.querySelectorAll(".pctx-file-name")].map((e) => e.textContent);

const START = [
  'Context files from the project "Budget Tracker". Every chat in this project has them. Each file\'s text follows its path.',
  "",
  `## ${DIR}/notes.md (13 B, MD)`,
  "Rent is 900.",
].join("\n");

describe("what Hermes is sent for a chat in a project with context files", () => {
  it("starts a new chat with the files' text as a hidden message after the instructions, and doesn't send it again", async () => {
    const s = server();
    await savedDefaults.save(SCOPE, "p_budget", 0, { instructions: "Use metric units." });
    const app = await launch(s);
    await app.pick("Budget Tracker");
    expect(await app.send("What's the rent?")).toBe("What's the rent?");
    const [messages] = app.seeded();
    expect(messages).toEqual([
      { role: "user", display_kind: "hidden", content: expect.stringContaining("Use metric units.") },
      { role: "user", display_kind: "hidden", content: START },
    ]);
    await app.reply();
    expect(await app.send("Thanks")).toBe("Thanks");
  });

  it("tells an open chat of a file added since, with its text, on its next message and not on the one after", async () => {
    const s = server();
    const app = await launch(s);
    await app.pick("Budget Tracker");
    await app.send("What's the rent?");
    await app.reply();

    s.managedFiles.nodes[`${DIR}/plan.md`] = { text: "Save more." };
    expect(await app.send("And the plan?")).toBe(`And the plan?${MARK}${CHANGED}\n\nAdded: ${DIR}/plan.md (10 B, MD)\nSave more.`);
    expect(screen.getByText("And the plan?")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Attached Context");
    await app.reply();
    expect(await app.send("Thanks")).toBe("Thanks");
  });

  it("tells an open chat that a file was replaced, with its new text, and that one was removed", async () => {
    const s = server();
    s.managedFiles.nodes[`${DIR}/old.md`] = { text: "Old." };
    const app = await launch(s);
    await app.pick("Budget Tracker");
    await app.send("Hello");
    await app.reply();

    s.managedFiles.nodes[`${DIR}/notes.md`] = { text: "Rent is 950.\n", mtime: 1_793_000_500 };
    delete s.managedFiles.nodes[`${DIR}/old.md`];
    expect(await app.send("What changed?")).toBe(`What changed?${MARK}${CHANGED}\n\nReplaced: ${DIR}/notes.md (13 B, MD)\nRent is 950.\n\nRemoved: ${DIR}/old.md`);
  });

  it("past 100% sends the files' paths instead of their text, and their text again once they fit", async () => {
    const s = server();
    s.managedFiles.nodes[`${DIR}/big.txt`] = { text: "x".repeat(DEFAULT_LIMIT_TOKENS * 4 + 4) };
    const app = await launch(s);
    await app.pick("Budget Tracker");
    await app.send("Hello");
    const LIST = `Context files from the project "Budget Tracker" are too large to include here. They are in ${DIR}. Open the ones you need with your file tools:`;
    expect(app.seeded()[0]).toEqual([{ role: "user", display_kind: "hidden", content: `${LIST}\n- ${DIR}/big.txt (390.6 KB, TXT)\n- ${DIR}/notes.md (13 B, MD)` }]);
    expect(s.context.reads).toEqual([]);
    await app.reply();

    delete s.managedFiles.nodes[`${DIR}/big.txt`];
    expect(await app.send("And now?")).toBe(`And now?${MARK}${CHANGED}\n\nAdded: ${DIR}/notes.md (13 B, MD)\nRent is 900.\n\nRemoved: ${DIR}/big.txt`);
    await app.reply();

    s.managedFiles.nodes[`${DIR}/big.txt`] = { text: "y".repeat(DEFAULT_LIMIT_TOKENS * 4 + 4) };
    expect(await app.send("Again?")).toBe(`Again?${MARK}${LIST}\n- ${DIR}/big.txt (390.6 KB, TXT)\n- ${DIR}/notes.md (13 B, MD)`);
  });

  it("follows membership: a chat put in the project gets every file, and one taken out gets no more", async () => {
    const s = server();
    const app = await launch(s);
    s.transcripts.nas = [
      { role: "user", text: "Which disks?" },
      { role: "assistant", text: "Two of them." },
    ];
    const menu = async () => app.user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    await app.user.click(screen.getByRole("button", { name: /NAS disks/ }));
    expect(await app.send("Before")).toBe("Before");
    await app.reply();

    await menu();
    await app.user.click(await screen.findByRole("menuitemcheckbox", { name: "Budget Tracker" }));
    expect(await app.send("In the project")).toBe(`In the project${MARK}${CHANGED}\n\nAdded: ${DIR}/notes.md (13 B, MD)\nRent is 900.`);
    await app.reply();

    await menu();
    await app.user.click(await screen.findByRole("menuitemcheckbox", { name: "Budget Tracker" }));
    s.managedFiles.nodes[`${DIR}/plan.md`] = { text: "Save more." };
    expect(await app.send("Out of it")).toBe("Out of it");
  });

  it("sends the message as typed when the folder can't be read, and tells the chat on a later one", async () => {
    const s = server();
    const app = await launch(s);
    await app.pick("Budget Tracker");
    const list = s.rest["GET /api/files"];
    s.rest["GET /api/files"] = () => {
      throw new RestError(500, `{"detail":"disk on fire"}`);
    };
    expect(await app.send("Hello")).toBe("Hello");
    expect(app.seeded()[0]).toBeUndefined();
    await app.reply();
    s.rest["GET /api/files"] = list;
    expect(await app.send("Again")).toBe(`Again${MARK}${CHANGED}\n\nAdded: ${DIR}/notes.md (13 B, MD)\nRent is 900.`);
  });

  it("doesn't show what rode below a message when the chat's history is read back", async () => {
    const s = server();
    s.transcripts.nas = [
      { role: "user", text: `What's the rent?${MARK}${CHANGED}\n\nAdded: ${DIR}/notes.md (13 B, MD)\nRent is 900.` },
      { role: "assistant", text: "It's 900." },
    ];
    const app = await launch(s);
    await app.user.click(screen.getByRole("button", { name: /NAS disks/ }));
    expect(await screen.findByText("It's 900.")).toBeTruthy();
    expect(screen.getByText("What's the rent?")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Rent is 900.");
  });
});

describe("the project page", () => {
  it("starts a chat in the project from its composer, as the New chat pane would", async () => {
    const s = server();
    await savedDefaults.save(SCOPE, "p_budget", 0, { instructions: "Use metric units.", folder: "/srv/budget" });
    const app = await launch(s);
    await app.openPage();
    await app.user.type(screen.getByRole("textbox", { name: "Message to start a new chat in Budget Tracker" }), "What's the rent?");
    await app.user.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(app.prompts()).toEqual(["What's the rent?"]));
    await app.settle();
    const [create] = s.requests.filter((r) => r.method === "session.create").map((r) => r.params);
    expect(create).toMatchObject({ cwd: "/srv/budget", cwd_explicit: true });
    expect(create.messages).toEqual([
      { role: "user", display_kind: "hidden", content: expect.stringContaining("Use metric units.") },
      { role: "user", display_kind: "hidden", content: START },
    ]);
    expect(document.querySelector(".chat-title span")?.textContent).toBe("What's the rent?");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    expect(within(screen.getByRole("region", { name: "Chats" })).getByRole("button", { name: /What's the rent\?/ })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message to start a new chat in Budget Tracker" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("starts a chat on Send's chord as the owner set it, where Enter then only breaks the line (#285)", async () => {
    setUIPrefs({ keybindings: { send: ["Ctrl+J"] } });
    const s = server();
    const app = await launch(s);
    await app.openPage();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message to start a new chat in Budget Tracker" });
    await app.user.type(box, "What's the rent?{Enter}in euros");
    expect(box.value).toBe("What's the rent?\nin euros");
    expect(app.prompts()).toEqual([]);
    await app.user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(app.prompts()).toEqual(["What's the rent?\nin euros"]));
  });

  it("shows the start of the instructions, and the pencil opens their editor", async () => {
    const s = server();
    await savedDefaults.save(SCOPE, "p_budget", 0, { instructions: "Use metric units." });
    const app = await launch(s);
    await app.openPage();
    const card = within(screen.getByRole("region", { name: "Instructions" }));
    expect(card.getByText("Use metric units.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
    await app.user.click(card.getByRole("button", { name: "Edit instructions" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
  });

  it("is worked by keyboard: the menu takes arrows and Escape, and the main column comes before the cards", async () => {
    const app = await launch(server());
    await app.openPage();
    const more = screen.getByRole("button", { name: "Project settings" });
    await app.user.click(more);
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Folders", "Defaults for new chats", "Rename", "Delete project"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Folders" }));
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Defaults for new chats" }));
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);

    const order = [
      screen.getByRole("textbox", { name: "Message to start a new chat in Budget Tracker" }),
      screen.getByRole("button", { name: "Edit instructions" }),
      screen.getByRole("button", { name: "Add context" }),
      screen.getByRole("button", { name: "Remove notes.md" }),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order.every((el) => el.tabIndex === 0)).toBe(true);
  });

  it("opens a chat of the project from its list", async () => {
    const s = server();
    const app = await launch(s);
    await app.user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    await app.user.click(await screen.findByRole("menuitemcheckbox", { name: "Budget Tracker" }));
    await app.openPage();
    await app.user.click(within(screen.getByRole("region", { name: "Chats" })).getByRole("button", { name: /NAS disks/ }));
    await waitFor(() => expect(document.querySelector(".chat-title span")?.textContent).toBe("NAS disks"));
  });
});

describe("the Context card", () => {
  it("shows each file's name, size and type, and how much of the project's capacity they use", async () => {
    const s = server();
    s.managedFiles.nodes[`${DIR}/logo.png`] = { bytes: "\x89PNG\0\0", mime: "image/png" };
    const app = await launch(s);
    const card = await app.openPage();
    expect(cards()).toEqual(["logo.png", "notes.md"]);
    const notes = card.getByRole("button", { name: /^notes\.md/ });
    expect(notes.textContent).toContain("13 B");
    expect(notes.textContent).toContain("MD");
    expect(card.getByRole("button", { name: /^logo\.png/ }).textContent).toContain("Path only");
    expect(card.getByRole("progressbar", { name: "Project capacity used" }).getAttribute("aria-valuetext")).toBe("0% of project capacity used");
    expect(card.getByText("0% of project capacity used")).toBeTruthy();
    expect(card.getByText(/100% is 100,000 tokens, as this project has no default model\./)).toBeTruthy();
    expect(card.queryByText("List mode")).toBeNull();
  });

  it("marks a project past 100% as in list mode", async () => {
    const s = server();
    s.managedFiles.nodes[`${DIR}/big.txt`] = { text: "x".repeat(440_000) };
    const app = await launch(s);
    const card = await app.openPage();
    expect(card.getByText("List mode")).toBeTruthy();
    expect(card.getByText("110% of project capacity used")).toBeTruthy();
    expect(card.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("says what to do when the project has no context files yet", async () => {
    const s = server();
    delete s.managedFiles.nodes[`${DIR}/notes.md`];
    const app = await launch(s);
    const card = await app.openPage();
    expect(card.getByText("Add files to give every chat in this project the same context")).toBeTruthy();
    expect(card.getByText(DIR)).toBeTruthy();
    expect(card.queryByRole("button", { name: "Search context files" })).toBeNull();
  });

  it("filters the file cards by name", async () => {
    const s = server();
    s.managedFiles.nodes[`${DIR}/plan.md`] = { text: "Save more." };
    const app = await launch(s);
    const card = await app.openPage();
    await app.user.click(card.getByRole("button", { name: "Search context files" }));
    await app.user.type(card.getByRole("searchbox", { name: "Filter context files by name" }), "PLA");
    expect(cards()).toEqual(["plan.md"]);
    await app.user.keyboard("{Escape}");
    expect(cards()).toEqual(["notes.md", "plan.md"]);
  });

  it("uploads the files picked, refusing one over 30 MB by name while the rest go", async () => {
    const s = server();
    s.files["/home/me/plan.md"] = "Save more.";
    s.files["/home/me/logo.png"] = "\x89PNG\0\0";
    s.files["/home/me/movie.mkv"] = { size: 31 * 1024 * 1024 };
    s.context.dialog = () => ["/home/me/plan.md", "/home/me/movie.mkv", "/home/me/logo.png"];
    const app = await launch(s);
    const card = await app.openPage();
    await app.add("Upload files");
    await waitFor(() => expect(cards()).toEqual(["logo.png", "notes.md", "plan.md"]));
    expect(s.managedFiles.nodes[`${DIR}/plan.md`]).toMatchObject({ bytes: "Save more." });
    expect(s.managedFiles.nodes[`${DIR}/movie.mkv`]).toBeUndefined();
    expect(card.getByRole("alert").textContent).toContain("movie.mkv wasn't added: it's 31.0 MB, over the 30.0 MB a context file can be.");
  });

  it("asks before replacing a file of the same name, and changes it only on Replace", async () => {
    const s = server();
    s.files["/home/me/notes.md"] = "Rent is 950 now.";
    s.context.dialog = () => ["/home/me/notes.md"];
    const app = await launch(s);
    await app.openPage();
    await app.add("Upload files");
    const asked = within(await screen.findByRole("dialog", { name: "Replace context file" }));
    expect(asked.getByText(/There's already a/).textContent).toContain("notes.md, 13 B, in this project's context files. Replace it with the one you picked, 16 B?");
    await app.user.click(asked.getByRole("button", { name: "Keep the one there" }));
    expect(s.context.writes).toEqual([]);

    await app.add("Upload files");
    await app.user.click(within(await screen.findByRole("dialog", { name: "Replace context file" })).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(s.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ bytes: "Rent is 950 now." }));
    expect(s.context.writes).toEqual([{ path: `${DIR}/notes.md`, overwrite: true }]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^notes\.md/ }).textContent).toContain("16 B"));
  });

  it("saves text content as <title>.md, asking before it replaces one", async () => {
    const s = server();
    const app = await launch(s);
    await app.openPage();
    await app.add("Add text content");
    const form = within(screen.getByRole("dialog", { name: "Add text content" }));
    await app.user.type(form.getByRole("textbox", { name: "Title" }), "Style guide");
    await app.user.type(form.getByRole("textbox", { name: "Content" }), "Write plainly.");
    await app.user.click(form.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(cards()).toEqual(["notes.md", "Style guide.md"]));
    expect(s.managedFiles.nodes[`${DIR}/Style guide.md`]).toMatchObject({ bytes: "Write plainly." });

    await app.add("Add text content");
    const again = within(screen.getByRole("dialog", { name: "Add text content" }));
    await app.user.type(again.getByRole("textbox", { name: "Title" }), "notes");
    await app.user.type(again.getByRole("textbox", { name: "Content" }), "New notes.");
    await app.user.click(again.getByRole("button", { name: "Add" }));
    expect(again.getByRole("alert").textContent).toContain("There's already a notes.md in this project's context files. Replace it?");
    expect(s.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ text: "Rent is 900.\n" });
    await app.user.click(again.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(s.managedFiles.nodes[`${DIR}/notes.md`]).toMatchObject({ bytes: "New notes." }));
  });

  it("removes a file from the server only after asking", async () => {
    const s = server();
    const app = await launch(s);
    const card = await app.openPage();
    await app.user.click(card.getByRole("button", { name: "Remove notes.md" }));
    const asked = within(screen.getByRole("dialog", { name: "Remove context file" }));
    expect(asked.getByText(`${DIR}/notes.md`)).toBeTruthy();
    await app.user.click(asked.getByRole("button", { name: "Cancel" }));
    expect(s.managedFiles.nodes[`${DIR}/notes.md`]).toBeDefined();

    await app.user.click(card.getByRole("button", { name: "Remove notes.md" }));
    await app.user.click(within(screen.getByRole("dialog", { name: "Remove context file" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(cards()).toEqual([]));
    expect(s.managedFiles.nodes[`${DIR}/notes.md`]).toBeUndefined();
    expect(s.context.removed).toEqual([`${DIR}/notes.md`]);
  });

  it("previews a file as Server files does", async () => {
    const s = server();
    const app = await launch(s);
    const card = await app.openPage();
    await app.user.click(card.getByRole("button", { name: /^notes\.md/ }));
    const preview = within(await screen.findByRole("dialog", { name: "Preview of notes.md" }));
    expect(await preview.findByText("Rent is 900.")).toBeTruthy();
    expect(preview.getByText(`${DIR}/notes.md`)).toBeTruthy();
    await app.user.click(preview.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes files dropped on it", async () => {
    const s = server();
    s.files["/home/me/plan.md"] = "Save more.";
    const app = await launch(s);
    await app.openPage();
    await act(async () => {
      for (const drop of dropListeners) drop({ payload: { type: "drop", paths: ["/home/me/plan.md"], position: { x: 0, y: 0 } } });
    });
    await waitFor(() => expect(cards()).toEqual(["notes.md", "plan.md"]));
    expect(s.managedFiles.nodes[`${DIR}/plan.md`]).toMatchObject({ bytes: "Save more." });
  });

  it("makes a folder for a project that has none with the first file, and it becomes the main folder", async () => {
    const s = server();
    s.projects.default.push(project("p_read", "Reading list"));
    s.files["/home/me/books.md"] = "Dune.";
    s.context.dialog = () => ["/home/me/books.md"];
    const app = await launch(s);
    const card = await app.openPage("Reading list");
    expect(card.getByText("/home/liam/.hermes/projects/reading-list")).toBeTruthy();
    await app.add("Upload files");
    await waitFor(() => expect(cards()).toEqual(["books.md"]));
    expect(s.managedFiles.nodes["/home/liam/.hermes/projects/reading-list/context/books.md"]).toMatchObject({ bytes: "Dune." });
    expect(s.projects.default[1].folders).toMatchObject([{ path: "/home/liam/.hermes/projects/reading-list", is_primary: true }]);
  });

  it("notes that context/ is ignored in the main folder's Git repository", async () => {
    const s = server();
    s.repos = [[{ path: "/srv/budget", branch: "main" }]];
    const app = await launch(s);
    const card = await app.openPage();
    expect(card.getByText("context/ is ignored locally in this Git repository")).toBeTruthy();
    expect([...s.context.excluded]).toEqual(["/srv/budget"]);
  });

  it("says what the server lacks, and offers nothing that couldn't work", async () => {
    const s = server();
    delete s.rest["GET /api/files"];
    delete s.rest["GET /api/files/read"];
    const app = await launch(s);
    await waitFor(() => expect(app.hermes.capabilities.get("serverFiles").state).toBe("unsupported"), { timeout: 6000 });
    const card = await app.openPage();
    expect(card.getByText(/This Hermes server can't keep context files for this profile/)).toBeTruthy();
    expect(card.getByText(/Server files: The dashboard's managed-files routes/)).toBeTruthy();
    expect(card.queryByRole("button", { name: "Add context" })).toBeNull();
  });

  it("on an SSH profile takes text files only, refuses a binary one with the stated message, and offers no Remove", async () => {
    const s = server();
    s.terminalBackend.default = "ssh";
    s.serverDirs.add(DIR);
    s.serverFiles[`${DIR}/notes.md`] = "Rent is 900.";
    s.files["/home/me/plan.md"] = "Save more.";
    s.files["/home/me/photo.jpg"] = "\xff\xd8\0\0";
    s.context.dialog = () => ["/home/me/plan.md", "/home/me/photo.jpg"];
    const app = await launch(s);
    const card = await app.openPage();
    expect(card.getByText(/This profile's tools run over SSH/)).toBeTruthy();
    expect(card.queryByRole("button", { name: "Remove notes.md" })).toBeNull();
    await app.add("Upload files");
    await waitFor(() => expect(cards()).toEqual(["notes.md", "plan.md"]));
    expect(s.serverFiles[`${DIR}/plan.md`]).toBe("Save more.");
    expect(card.getByRole("alert").textContent).toContain("photo.jpg: can't add this file to a project on an SSH profile yet");
  });

  it("drops an answer for a main folder the project no longer has", async () => {
    const s = server();
    s.projects.default = [project("p_budget", "Budget Tracker", ["/srv/budget", "/srv/app"])];
    s.serverDirs.add("/srv/app");
    s.managedFiles.nodes["/srv/app/context/app.md"] = { text: "App notes." };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const list = s.rest["GET /api/files"];
    s.rest["GET /api/files"] = async (req) => {
      if (req.query.get("path") === DIR) await held;
      return list(req);
    };
    const app = await launch(s);
    await app.pick("Budget Tracker");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await app.user.click(screen.getByRole("button", { name: "Project settings" }));
    await app.user.click(screen.getByRole("menuitem", { name: "Folders" }));
    await app.user.click(screen.getByRole("button", { name: "Remove /srv/budget from the project" }));
    await waitFor(() => expect(cards()).toEqual(["app.md"]));
    await act(async () => release());
    await app.settle();
    expect(cards()).toEqual(["app.md"]);
  });
});
