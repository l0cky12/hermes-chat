// @vitest-environment jsdom
// A project's context files in the app (ADR 0135): what Hermes is sent when a chat in the project starts and when one
// already open sends its next message, and the project page's Context card. The fake Hermes's `requests` are what
// Hermes received; its disks are what the server has (fakeProjectContext.ts).
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { savedDefaults } from "../hermes/projectDefaults";
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

/** A project whose main folder is /srv/budget, with one context file, and two chats outside it. */
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
  /** Types a message and waits until Hermes has it. */
  const send = async (text: string) => {
    const before = prompts().length;
    await user.type(screen.getByPlaceholderText("Message Hermes"), `${text}{Enter}`);
    await waitFor(() => expect(prompts()).toHaveLength(before + 1));
    await settle();
    return prompts()[before];
  };
  /** Hermes answers the turn under way and ends it, so the next message is a new turn. */
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
  return { hermes, user, send, reply, pick, prompts, seeded, settle };
}

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
    // The owner sees their own words, and nothing of what rode below them.
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
    // 400,004 bytes are 100,001 tokens: just over the 100,000 a project without a default model may use.
    s.managedFiles.nodes[`${DIR}/big.txt`] = { text: "x".repeat(400_004) };
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

    // Over again: an open chat gets the whole list of paths once.
    s.managedFiles.nodes[`${DIR}/big.txt`] = { text: "y".repeat(400_004) };
    expect(await app.send("Again?")).toBe(`Again?${MARK}${LIST}\n- ${DIR}/big.txt (390.6 KB, TXT)\n- ${DIR}/notes.md (13 B, MD)`);
  });

  it("follows membership: a chat put in the project gets every file, and one taken out gets no more", async () => {
    const s = server();
    const app = await launch(s);
    // A chat with nothing in it would be named by its first message.
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
      throw new Error(`The dashboard answered 500: {"detail":"disk on fire"}`);
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
