// @vitest-environment jsdom
// Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y in the running app, against a fake Hermes: the composer's own undo across slash
// picks, chat switches and sends; other text fields through the webview's history; and Ctrl+Z outside a text field
// for the notice's Undo. Each test checks what the owner sees, not which handler ran.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { followEditKeys } from "./editKeys";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  // main.tsx does this for the app.
  followEditKeys();
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  vi.restoreAllMocks();
});

// Drafts outlive a test in memory, so each launch is its own connection, with Drafts of its own.
let launches = 0;

/** The app signed in to a fake Hermes, with the chat "Nightly backup" open. */
async function launch() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("deploy", 2, { pinned: true, title: "Deploy notes" })];
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@undo-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await open(user, hermes, "backup");
  return { server, hermes, user };
}

async function open(user: ReturnType<typeof userEvent.setup>, hermes: Hermes, id: string) {
  await user.click(document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!);
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const UNDO = "{Control>}z{/Control}";
const REDO = "{Control>}{Shift>}Z{/Shift}{/Control}";
const REDO_Y = "{Control>}y{/Control}";
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);
const notice = () => screen.queryByRole("status");

/** A stand-in for the webview's own edit commands, which jsdom lacks. */
function webviewHistory() {
  const run = vi.fn((_command: string) => true);
  Object.defineProperty(document, "execCommand", { value: run, configurable: true });
  return run;
}

describe("Undo and redo in the composer", () => {
  it("undoes typing, and Ctrl+Shift+Z and Ctrl+Y redo it", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("hello world");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
    await user.keyboard(REDO);
    expect(composer().value).toBe("hello world");
    await user.keyboard(UNDO);
    await user.keyboard(REDO_Y);
    expect(composer().value).toBe("hello world");
    expect(composer().selectionStart).toBe("hello world".length);
  });

  it("undoes a slash command pick back to the text typed before it", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("/bt");
    await user.keyboard("{Tab}");
    expect(composer().value).toBe("/btw ");
    await user.keyboard("why");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("/btw ");
    expect(composer().selectionStart).toBe(5);
    await user.keyboard(UNDO);
    expect(composer().value).toBe("/bt");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
  });

  it("undoes only the open chat's edits after switching chats and back, never showing the other chat's text", async () => {
    const { user, hermes } = await launch();
    await user.click(composer());
    await user.keyboard("alpha");
    await open(user, hermes, "deploy");
    expect(composer().value).toBe("");
    await user.click(composer());
    await user.keyboard("beta");
    await open(user, hermes, "backup");
    expect(composer().value).toBe("alpha");

    await user.click(composer());
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
    await user.keyboard(REDO);
    expect(composer().value).toBe("alpha");
  });

  it("can't bring back a message once it is sent", async () => {
    const { user, server } = await launch();
    await user.click(composer());
    await user.keyboard("Run the backup{Enter}");
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    expect(composer().value).toBe("");
    await user.keyboard("x");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
    await user.keyboard(UNDO);
    expect(composer().value).toBe("");
  });

  it("steps its own history for the webview's context menu Undo and Redo too", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("hello");
    const menu = (inputType: string) => act(() => void composer().dispatchEvent(new InputEvent("beforeinput", { inputType, cancelable: true })));
    menu("historyUndo");
    expect(composer().value).toBe("");
    menu("historyRedo");
    expect(composer().value).toBe("hello");
  });

  it("leaves the webview's own history alone", async () => {
    const run = webviewHistory();
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("hello");
    await user.keyboard(UNDO);
    await user.keyboard(UNDO);
    await user.keyboard(REDO_Y);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Ctrl+Z in other text fields", () => {
  it("undoes through the webview's history, and redoes with Ctrl+Shift+Z or Ctrl+Y", async () => {
    const run = webviewHistory();
    const { user } = await launch();
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("backup");
    await user.keyboard(UNDO);
    await user.keyboard(REDO);
    await user.keyboard(REDO_Y);
    expect(run.mock.calls).toEqual([["undo"], ["redo"], ["redo"]]);
  });

  it("undoes in a dialog's field too, though the dialog keeps the app's shortcuts in", async () => {
    const run = webviewHistory();
    const { user } = await launch();
    fireEvent.contextMenu(document.querySelector<HTMLElement>('.row-open[data-chat="deploy"]')!);
    await user.click(screen.getByRole("menuitem", { name: "Custom…" }));
    const dialog = screen.getByRole("dialog", { name: /Snooze/ });
    await user.click(within(dialog).getByRole("button", { name: "Duration" }));
    await user.type(within(dialog).getByLabelText("Snooze for"), "45");
    await user.keyboard(UNDO);
    expect(run.mock.calls).toEqual([["undo"]]);
    expect(screen.getByRole("dialog", { name: /Snooze/ })).toBeTruthy();
  });
});

describe("Ctrl+Z for the notice's Undo", () => {
  async function settled() {
    const s = await launch();
    expect(titles("inbox")).toEqual(["Nightly backup", "Deploy notes"]);
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await s.user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Settle" }));
    await act(async () => void (await s.hermes.idle()));
    expect(notice()?.textContent).toContain("Settled: Deploy notes");
    expect(titles("inbox")).toEqual(["Nightly backup"]);
    return s;
  }

  it("runs the Undo with focus outside a text field, and the notice goes", async () => {
    const { user, hermes } = await settled();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard(UNDO);
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(titles("inbox")).toEqual(["Nightly backup", "Deploy notes"]));
    expect(notice()).toBeNull();
  });

  it("never runs it from the composer", async () => {
    const { user, hermes } = await settled();
    await user.click(composer());
    await user.keyboard(UNDO);
    await act(async () => void (await hermes.idle()));
    expect(notice()?.textContent).toContain("Settled: Deploy notes");
    expect(titles("inbox")).toEqual(["Nightly backup"]);
  });

  it("never runs it from another text field", async () => {
    const run = webviewHistory();
    const { user, hermes } = await settled();
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("x");
    await user.keyboard(UNDO);
    await act(async () => void (await hermes.idle()));
    expect(run).toHaveBeenCalledWith("undo");
    expect(notice()?.textContent).toContain("Settled: Deploy notes");
    expect(titles("inbox")).toEqual(["Nightly backup"]);
  });
});
