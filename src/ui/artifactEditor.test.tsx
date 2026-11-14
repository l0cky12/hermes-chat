// @vitest-environment jsdom
// The artifact editor in the running app (ADR 0029, ADR 0170): a Server file shown in the preview pane, opened to edit
// beside the chat with the Preview's Edit, against a fake Hermes whose agent fs routes, write-text and `llm.oneshot` answer as the deployed `bf0203a` does.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { PersonaStore } from "../hermes/personaStore";
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

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join("");
const written = (path: string, bytes: number) => JSON.stringify({ bytes_written: bytes, dirs_created: false, resolved_path: path, files_modified: [path] });

function call(id: string, path: string, rowId: number): TranscriptMessage[] {
  const args = { path };
  return [
    { role: "assistant", text: "", row_id: rowId, timestamp: 1_790_000_000 + rowId, tool_calls: [{ id, type: "function", function: { name: "write_file", arguments: JSON.stringify(args) } }] },
    { role: "tool", name: "write_file", tool_call_id: id, args, context: path, row_id: rowId + 1, timestamp: 1_790_000_000 + rowId, result: written(path, 40) },
  ];
}

const PLAN = "# Launch plan\n\nWe will ship it in a long and winding way.\n\n<img src=x onerror=alert(1)>\n";

function server() {
  const s = new FakeHermes();
  s.sessions = [row("plan", 1, { pinned: true, title: "Launch planning" })];
  s.transcripts.plan = [{ role: "user", text: "Write the plan", row_id: 1, timestamp: 1_790_000_000 }, ...call("w1", "/srv/out/plan.md", 2)];
  s.serverFiles["/srv/out/plan.md"] = utf8(PLAN);
  return s;
}

let launches = 0;
async function launch(s = server(), onSignOut = async () => {}) {
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={onSignOut} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByText("Launch planning"));
  return { server: s, hermes, user };
}

const editor = () => screen.findByRole("textbox", { name: "Text of plan.md" }) as Promise<HTMLTextAreaElement>;
const pane = () => screen.getByRole("region", { name: "Preview" });

/** Opens plan.md in the Preview from the tool call that wrote it, then Edit in the Preview's toolbar. */
async function editPlan(user: ReturnType<typeof userEvent.setup>) {
  const tool = (await screen.findAllByRole("button", { name: /^write_file/ }))[0];
  if (tool.getAttribute("aria-expanded") === "false") await user.click(tool);
  await user.click(screen.getByRole("button", { name: "plan.md" }));
  await user.click(await within(pane()).findByRole("button", { name: "Edit" }));
}

describe("The artifact editor", () => {
  it("opens a Server file from the Preview beside the chat, keeps the draft off the server, and saves it after a review", async () => {
    const { server, user } = await launch();
    await editPlan(user);
    const text = await editor();
    expect(screen.getAllByRole("button", { name: /^write_file/ }).length).toBeGreaterThan(0);
    expect(text.value).toBe(PLAN);
    expect(document.querySelector(".artifact-id")!.textContent).toMatch(/Editing plan\.md.*As on the server.*Based on version [0-9a-f]{8}.*where the profile's tools run.*UTF-8, LF/);
    await user.clear(text);
    await user.type(text, "# Launch plan{enter}{enter}Ship it.{enter}");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(server.fsWrites).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Review changes…" }));
    const changes = screen.getByRole("region", { name: "Your changes" });
    expect(changes.textContent).toMatch(/added.*removed/);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved\. Hermes has your edit, read back from the server\./);
    // Saved as the Preview read it: a link from a tool call names no chat's sandbox (ADR 0062, ADR 0170).
    expect(server.fsWrites).toEqual([{ profile: "default", path: "/srv/out/plan.md", text: "# Launch plan\n\nShip it.\n" }]);
    expect(document.querySelector(".artifact-id .badge")!.textContent).toMatch(/^Saved /);
  });

  it("shows Hermes's proposed edit against the exact text it was made for, and applies it only when asked", async () => {
    const { server, user } = await launch();
    server.oneshotAnswer = "We ship it.";
    await editPlan(user);
    const text = await editor();
    const start = PLAN.indexOf("We will");
    const end = PLAN.indexOf("\n\n<img");
    text.setSelectionRange(start, end);
    fireEvent.select(text);
    expect(screen.getByText(`${end - start} characters selected`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ask Hermes to edit" }));
    await user.type(screen.getByRole("textbox", { name: "What should Hermes change in the selected text?" }), "Make it plain{enter}");
    const panel = await screen.findByRole("region", { name: "Hermes's proposed edit" });
    expect(panel.textContent).toMatch(/for “Make it plain”, made against your text as it was when you asked \(version [0-9a-f]{8}\)\. It used this chat's model\./);
    // The chat that made the file is open, so its runtime session lends its model; the call has no tools.
    const ask = server.requests.find((r) => r.method === "llm.oneshot")!;
    expect(typeof ask.params.session_id).toBe("string");
    expect(String(ask.params.input)).toContain("<selection>We will ship it in a long and winding way.</selection>");
    const diff = within(panel).getByRole("region", { name: "Hermes's proposed changes" });
    expect(diff.textContent).toContain("1 added, 1 removed");
    expect(diff.textContent).toContain("We will ship it in a long and winding way.");
    expect(diff.textContent).toContain("We ship it.");
    // Nothing changed yet.
    expect(server.fsWrites).toEqual([]);
    await user.click(within(panel).getByRole("button", { name: "Apply to the editor" }));
    expect((await editor()).value).toBe(PLAN.replace("We will ship it in a long and winding way.", "We ship it."));
    expect(screen.getByText(/Hermes's edit is in the editor, not yet saved/)).toBeTruthy();
    // The next request starts with an empty box.
    await user.click(screen.getByRole("button", { name: "Ask Hermes to edit" }));
    expect((screen.getByRole("textbox", { name: /^What should Hermes change/ }) as HTMLInputElement).value).toBe("");
    await user.keyboard("{Escape}");
    // Undo takes it out again.
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect((await editor()).value).toBe(PLAN);
  });

  it("shows the conflict when Hermes rewrote the file meanwhile, writes nothing, and merges", async () => {
    const { server, user } = await launch();
    await editPlan(user);
    const text = await editor();
    await user.click(text);
    text.setSelectionRange(0, 0);
    await user.type(text, "DRAFT ", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    // Hermes, in the chat, writes the file again.
    server.serverFiles["/srv/out/plan.md"] = utf8(PLAN.replace("<img src=x onerror=alert(1)>", "Owner: Sam"));
    await user.click(screen.getByRole("button", { name: "Review changes…" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const conflict = await screen.findByRole("region", { name: "The file changed on the server" });
    expect(conflict.textContent).toMatch(/changed on the server since this edit started, perhaps Hermes in the chat, so nothing was written\. Your edit is kept here/);
    expect(within(conflict).getByRole("region", { name: "Changes on the server since this edit started" }).textContent).toContain("Owner: Sam");
    expect(server.fsWrites).toEqual([]);
    await user.click(within(conflict).getByRole("button", { name: "Merge" }));
    expect((await editor()).value).toBe("DRAFT " + PLAN.replace("<img src=x onerror=alert(1)>", "Owner: Sam"));
  });

  it("renders the Markdown preview of the draft without raw HTML", async () => {
    const { user } = await launch();
    await editPlan(user);
    await editor();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const doc = document.querySelector(".artifact-doc")!;
    expect(doc.querySelector("h1")?.textContent).toBe("Launch plan");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("script, iframe")).toBeNull();
  });

  it("keeps the draft when the pane closes, and Edit on the same file restores it", async () => {
    const { user } = await launch();
    await editPlan(user);
    await user.type(await editor(), "!!");
    await user.click(document.querySelector<HTMLElement>(".panel-close")!);
    expect(screen.queryByRole("textbox", { name: "Text of plan.md" })).toBeNull();
    await editPlan(user);
    expect((await editor()).value).toBe(PLAN + "!!");
  });

  it("asks before Cancel drops an edit, and keeps it on Keep editing", async () => {
    const { user } = await launch();
    await editPlan(user);
    await user.type(await editor(), "!!");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const ask = screen.getByRole("alertdialog", { name: "Discard your changes to plan.md?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((await editor()).value).toBe(PLAN + "!!");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("textbox", { name: "Text of plan.md" })).toBeNull();
    await editPlan(user);
    expect((await editor()).value).toBe(PLAN);
  });

  it("undoes and redoes with the keyboard", async () => {
    const { user } = await launch();
    await editPlan(user);
    const text = await editor();
    await user.type(text, "one");
    await user.keyboard("{Control>}z{/Control}");
    expect(text.value).toBe(PLAN);
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(text.value).toBe(PLAN + "one");
  });

  it("takes webview Undo (from its menu) as the editor's own, after a proposal replaced the text box too", async () => {
    const { server, user } = await launch();
    server.oneshotAnswer = "SHORT.";
    await editPlan(user);
    await user.type(await editor(), "x");
    await user.click(screen.getByRole("button", { name: "Ask Hermes to edit" }));
    await user.type(screen.getByRole("textbox", { name: "What should Hermes change in the whole file?" }), "Shorten{enter}");
    await user.click(within(await screen.findByRole("region", { name: "Hermes's proposed edit" })).getByRole("button", { name: "Apply to the editor" }));
    const text = await editor();
    expect(text.value).toBe("SHORT.");
    const undo = new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true });
    act(() => void text.dispatchEvent(undo));
    expect(undo.defaultPrevented).toBe(true);
    expect((await editor()).value).toBe(PLAN + "x");
  });

  it("opens an unsaved edit again even once its file is gone from the server", async () => {
    const { server, user } = await launch();
    await editPlan(user);
    await user.type(await editor(), "!!");
    await user.click(document.querySelector<HTMLElement>(".panel-close")!);
    delete server.serverFiles["/srv/out/plan.md"];
    await editPlan(user);
    expect((await editor()).value).toBe(PLAN + "!!");
  });

  it("asks about an unsaved artifact edit too, after an unsaved persona was let go on closing the window", async () => {
    const s = server();
    s.souls = { default: "# Persona\n" };
    const hermes = await connect(s.openPipe, undefined, memoryCache());
    running.push(hermes);
    const close = vi.fn();
    let ask: ((close: () => void) => void) | undefined;
    render(
      <Main
        hermes={hermes}
        connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }}
        onSignOut={async () => {}}
        personaStore={new PersonaStore(memoryStorage())}
        guardClose={async (a) => {
          ask = a;
          return () => (ask = undefined);
        }}
      />,
    );
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    const user = userEvent.setup();
    await user.click(screen.getByText("Launch planning"));
    await editPlan(user);
    await user.type(await editor(), "!!");
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    const soul = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "SOUL.md for the default profile" });
    await user.click(soul);
    await user.paste("Mine. ");
    await waitFor(() => expect(ask).toBeDefined());
    act(() => ask!(close));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close anyway" }));
    const artifactAsk = await screen.findByRole("alertdialog", { name: "Close and discard your edit?" });
    expect(close).not.toHaveBeenCalled();
    await user.click(within(artifactAsk).getByRole("button", { name: "Discard edit" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("asks before signing out would drop an unsaved edit", async () => {
    const signOut = vi.fn(async () => {});
    const { user } = await launch(server(), signOut);
    await editPlan(user);
    await user.type(await editor(), "!!");
    await user.click(document.querySelector<HTMLElement>(".panel-close")!);
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    const ask = await screen.findByRole("alertdialog", { name: "Sign out and discard your edit?" });
    expect(ask.textContent).toContain("plan.md");
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(signOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Sign out and discard your edit?" })).getByRole("button", { name: "Discard edit" }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
