// @vitest-environment jsdom
// The Work page in the app (issue #595), against a fake Hermes whose kanban plugin routes behave as the official desktop
// app's Kanban view expects: the board, the workflow, a task with its comments, and the writes that change them.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

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

function server() {
  const s = new FakeHermes();
  s.kanban.add("default", { title: "Research the API", assignee: "researcher", body: "Read the docs and write notes", priority: 2 });
  s.kanban.add("default", { title: "Wait on keys", status: "blocked", latest_summary: "No API key on the host" });
  return s;
}

async function signIn(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return hermes;
}

async function launch(s = server()) {
  await signIn(s);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "Work" }));
  await waitFor(() => expect(screen.getByText("2 tasks on the current board")).toBeTruthy());
  return { user, s };
}

const column = (name: string) => screen.getByRole("region", { name });
const card = (title: string) => screen.getByText(title).closest<HTMLElement>(".work-card")!;
const dragTo = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = { setData: () => {}, getData: () => "" };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};

describe("the Work page", () => {
  it("shows one column per status, with each card's id, priority, body or block reason, and assignee", async () => {
    await launch();
    const ready = within(column("ready"));
    expect(ready.getByText("Research the API")).toBeTruthy();
    expect(ready.getByText("P2")).toBeTruthy();
    expect(ready.getByText("Read the docs and write notes")).toBeTruthy();
    expect(ready.getByText("researcher")).toBeTruthy();
    expect(within(column("blocked")).getByText("No API key on the host")).toBeTruthy();
    expect(within(column("done")).getByText("Empty")).toBeTruthy();
  });

  it("completes a dragged card only after asking what got done", async () => {
    const { user, s } = await launch();
    const id = s.kanban.boards.default.tasks[0].id;
    dragTo(card("Research the API"), column("done"));
    const dialog = await screen.findByRole("dialog", { name: "Complete Research the API" });
    expect(s.kanban.writes).toEqual([]);
    await user.type(within(dialog).getByRole("textbox", { name: "Summary" }), "Notes are in the repo");
    await user.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(within(column("done")).queryByText("Research the API")).toBeTruthy());
    expect(s.kanban.writes).toEqual([`PATCH ${id} {"status":"done","result":"Notes are in the repo","summary":"Notes are in the repo"}`]);
  });

  it("takes no drop on a column the workflow doesn't allow", async () => {
    const { s } = await launch();
    dragTo(card("Research the API"), column("running"));
    dragTo(card("Research the API"), column("triage"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.kanban.writes).toEqual([]);
    expect(within(column("ready")).getByText("Research the API")).toBeTruthy();
  });

  it("opens a task's sheet, saves only the fields changed, and posts a comment", async () => {
    const { user, s } = await launch();
    const task = s.kanban.boards.default.tasks[0];
    task.comments = [{ id: 1, author: "researcher", body: "Started reading", created_at: 1_700_000_000 }];
    await user.click(card("Research the API"));
    const sheet = await screen.findByRole("dialog", { name: "Research the API" });
    await waitFor(() => expect(within(sheet).getByText("Started reading")).toBeTruthy());
    await user.click(within(sheet).getByRole("button", { name: "Edit" }));
    const title = within(sheet).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Research the new API");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.writes).toEqual([`PATCH ${task.id} {"title":"Research the new API"}`]));
    await waitFor(() => expect(within(column("ready")).getByText("Research the new API")).toBeTruthy());
    await user.type(within(sheet).getByRole("textbox", { name: "Comment" }), "Looks good");
    await user.click(within(sheet).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(within(sheet).getByText("Looks good")).toBeTruthy());
    expect(s.kanban.writes.at(-1)).toBe(`POST ${task.id}/comments {"body":"Looks good"}`);
  });

  it("blocks from the sheet with a reason, which shows on the card", async () => {
    const { user, s } = await launch();
    await user.click(card("Research the API"));
    const sheet = await screen.findByRole("dialog", { name: "Research the API" });
    await user.click(within(sheet).getByRole("button", { name: "Block…" }));
    const ask = await screen.findByRole("dialog", { name: "Block Research the API" });
    await user.type(within(ask).getByRole("textbox", { name: "Reason" }), "Needs a login");
    await user.click(within(ask).getByRole("button", { name: "Block" }));
    await waitFor(() => expect(within(column("blocked")).getByText("Needs a login")).toBeTruthy());
    expect(s.kanban.writes.at(-1)).toMatch(/comments \{"body":"BLOCKED: Needs a login"\}$/);
  });

  it("creates a task once when Create is sent again after a lost answer", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Write the summary");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Assignee" }), "writer");
    s.kanban.failNext = "lost";
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(dialog).getByText(/It may have been created/)).toBeTruthy());
    expect(within(dialog).getByRole("textbox", { name: "Title" }).matches(":disabled")).toBe(true);
    s.kanban.createWarning = "No dispatcher is running";
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("No dispatcher is running")).toBeTruthy();
    expect(s.kanban.boards.default.tasks.filter((t) => t.title === "Write the summary")).toHaveLength(1);
    expect(new Set(s.kanban.writes.map((w) => JSON.parse(w.slice(w.indexOf("{"))).idempotency_key)).size).toBe(1);
    await waitFor(() => expect(within(column("ready")).getByText("Write the summary")).toBeTruthy());
  });

  it("isn't on the rail when the dashboard has no kanban plugin", async () => {
    const s = server();
    s.kanban.missing = true;
    const hermes = await signIn(s);
    await waitFor(() => expect(hermes.capabilities.getSnapshot().caps.kanban.state).toBe("unsupported"));
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
  });
});
