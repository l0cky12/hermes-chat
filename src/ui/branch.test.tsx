// @vitest-environment jsdom
// Branch from here on screen (issue #81, ADR 0027): the preview says what the branch holds and leaves out, a file
// no longer on the server must be acknowledged, the branch opens with a way back, and each chat keeps its own Draft.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
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

async function launch(more?: (s: FakeHermes) => void) {
  const s = new FakeHermes();
  s.sessions = [row("c1", 0.1, { pinned: true, title: "Disk check" }), row("c2", 0.5, { pinned: true, title: "Other chat" })];
  s.serverDirs.add("/srv/uploads");
  s.storeMessage("c1", { role: "user", text: "How full is the NAS?" });
  s.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
  s.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", context: "df -h", result: "81%" });
  s.storeMessage("c1", { role: "assistant", text: "It's 81% full." });
  s.storeMessage("c1", { role: "user", text: "@file:/srv/uploads/old.csv\n\nCompare with last week" });
  s.storeMessage("c1", { role: "assistant", text: "Last week it was 79%." });
  more?.(s);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Disk check/ }));
  await screen.findByText("Last week it was 79%.");
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user };
}

const branchButtons = () => screen.getAllByRole("button", { name: "Branch from here" });

describe("Branch from here", () => {
  it("previews what the branch holds, needs the missing file acknowledged, and opens the branch with a way back", async () => {
    const { s, hermes, user } = await launch();
    // Under "Last week it was 79%.", the sixth message.
    expect(branchButtons()).toHaveLength(5);
    await user.click(branchButtons()[4]);
    const dialog = await screen.findByRole("dialog", { name: "Branch from here" });
    await within(dialog).findByText(/History it starts with: 5 messages/);
    expect(dialog.textContent).toContain("up to Hermes's reply");
    expect(dialog.textContent).toContain("1 tool call before this point. Their outputs aren't copied as context");
    expect(within(dialog).getByText("/srv/uploads/old.csv")).toBeTruthy();
    expect(dialog.textContent).toContain("No longer on the server: the branch can't read it.");
    expect(dialog.textContent).toContain("doesn't undo files Hermes changed on the server");
    const create = within(dialog).getByRole("button", { name: "Create branch" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.click(within(dialog).getByRole("checkbox", { name: /Branch anyway/ }));
    expect(create.disabled).toBe(false);
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Disk check, by week");
    await user.click(create);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branch from here" })).toBeNull());
    const branch = s.sessions.find((r) => r.parent_session_id === "c1")!;
    await waitFor(() => expect(branch.title).toBe("Disk check, by week"));
    const note = (await screen.findByText(/Branched from/)).closest<HTMLElement>("[role=note]")!;
    expect(note.textContent).toContain("Branched from Disk check after Hermes's reply");
    expect(within(note).getByRole("button", { name: "Disk check" })).toBeTruthy();
    expect(hermes.getSnapshot().chats.find((c) => c.id === branch.id)).toMatchObject({ source: "app", settled: false });
    // The original keeps all its messages.
    expect(s.transcripts.c1).toHaveLength(6);
  });

  it("keeps separate Drafts for the original and the branch", async () => {
    const { user } = await launch();
    const composer = () => screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement;
    await user.type(composer(), "draft in the original");
    await user.click(branchButtons()[0]);
    const dialog = await screen.findByRole("dialog", { name: "Branch from here" });
    await user.click(await within(dialog).findByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(screen.getByText(/Branched from/)).toBeTruthy());
    expect(composer().value).toBe("");
    await user.type(composer(), "draft in the branch");
    await user.click(within(screen.getByText(/Branched from/).closest<HTMLElement>("[role=note]")!).getByRole("button", { name: "Disk check" }));
    await waitFor(() => expect(composer().value).toBe("draft in the original"));
    await user.click(screen.getByRole("button", { name: /Disk check #2/ }));
    await waitFor(() => expect(composer().value).toBe("draft in the branch"));
  });

  it("goes back to the very message branched from, by its stored row, though another has the same words", async () => {
    const { user } = await launch((s) => {
      s.storeMessage("c1", { role: "user", text: "How full is the NAS?" });
      s.storeMessage("c1", { role: "assistant", text: "It's 81% full." });
    });
    expect(screen.getAllByText("It's 81% full.")).toHaveLength(2);
    // The last "It's 81% full." is the eighth message, under the seventh button.
    await user.click(branchButtons().at(-1)!);
    const dialog = await screen.findByRole("dialog", { name: "Branch from here" });
    await user.click(await within(dialog).findByRole("checkbox", { name: /Branch anyway/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create branch" }));
    const note = (await screen.findByText(/Branched from/)).closest<HTMLElement>("[role=note]")!;
    await user.click(within(note).getByRole("button", { name: "Disk check" }));
    await waitFor(() => expect(document.querySelector(".msg.jumped")).not.toBeNull());
    const shown = [...document.querySelectorAll<HTMLElement>(".msg.assistant")].filter((m) => m.textContent?.includes("It's 81% full."));
    expect(shown).toHaveLength(2);
    expect(shown[1].classList.contains("jumped")).toBe(true);
    expect(shown[0].classList.contains("jumped")).toBe(false);
  });

  it("says why while a reply is running, and offers no way to make the branch", async () => {
    const { s, hermes, user } = await launch();
    act(() => s.event(s.runtimeIdOf("c1")!, "message.start", {}));
    await act(async () => void (await hermes.idle()));
    expect(branchButtons()[0].getAttribute("aria-disabled")).toBe("true");
    expect(branchButtons()[0].title).toContain("Wait for the reply to finish");
    await user.click(branchButtons()[0]);
    const dialog = await screen.findByRole("dialog", { name: "Branch from here" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Wait for the reply to finish");
    expect(within(dialog).queryByRole("button", { name: "Create branch" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("explains a Hermes that can't branch", async () => {
    const { s, user } = await launch();
    s.branchMethod = false;
    await user.click(branchButtons()[1]);
    const dialog = await screen.findByRole("dialog", { name: "Branch from here" });
    await user.click(await within(dialog).findByRole("button", { name: "Create branch" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("can't branch chats: it has no session.branch");
    expect(s.sessions.some((r) => r.parent_session_id === "c1")).toBe(false);
  });
});
