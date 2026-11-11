// @vitest-environment jsdom
// Edit and Regenerate on screen (issue #63, ADR 0035): the dialog opens on the original words with Save as branch and
// Cancel and says what the branch leaves out; Regenerate keeps the answer and adds a version to switch to; both are
// blocked while a reply runs; and the composer's Drafts stay where they were.
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
  s.sessions = [row("c1", 0.1, { pinned: true, title: "Disk check" })];
  s.storeMessage("c1", { role: "user", text: "How full is the NAS?" });
  s.storeMessage("c1", { role: "assistant", text: "It's 81% full." });
  s.storeMessage("c1", { role: "user", text: "Delete old snapshots" });
  s.storeMessage("c1", { role: "assistant", text: "Deleted 3 snapshots." });
  s.sessionModel.set("c1", { model: "gpt-5.2", provider: "openai", reasoning_effort: "high", fast: false });
  more?.(s);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Disk check/ }));
  await screen.findByText("Deleted 3 snapshots.");
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user };
}

const composer = () => screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement;
/** Answers the turn Hermes started in a branch, as the stub model does. */
const answer = async (s: FakeHermes, hermes: Hermes, chatId: string, text: string) => {
  const sid = s.runtimeIdOf(chatId)!;
  act(() => {
    s.event(sid, "message.start", {});
    s.event(sid, "message.complete", { text, status: "complete" });
  });
  s.storeMessage(chatId, { role: "assistant", text });
  await act(async () => void (await hermes.idle()));
};

describe("Edit", () => {
  it("opens the original words with Save as branch and Cancel, says what's left out, and keeps both Drafts", async () => {
    const { s, user } = await launch();
    await user.type(composer(), "draft in the original");
    const edits = screen.getAllByRole("button", { name: "Edit" });
    expect(edits).toHaveLength(2);
    await user.click(edits[0]);
    const dialog = await screen.findByRole("dialog", { name: "Edit message" });
    const text = (await within(dialog).findByRole("textbox", { name: "Your message" })) as HTMLTextAreaElement;
    expect(text.value).toBe("How full is the NAS?");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(dialog.textContent).toContain("Not in the new branch: 4 messages");
    expect(dialog.textContent).toContain("Your original message and what came after it stay in Disk check");
    expect(dialog.textContent).toContain("Deleted 3 snapshots.");
    expect(dialog.textContent).toContain("gpt-5.2 · openai · high reasoning");
    expect(dialog.textContent).toContain("doesn't undo anything Hermes did after your original message");

    // An edit typed and not saved survives a stray Escape.
    await user.clear(text);
    await user.type(text, "How full is the backup NAS?");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Edit message" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save as branch" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const branch = s.sessions.find((r) => r.parent_session_id === "c1")!;
    expect(s.transcripts[branch.id].map((m) => m.text)).toEqual(["How full is the backup NAS?"]);
    expect(s.transcripts.c1).toHaveLength(4);
    const note = (await screen.findByText(/Edited from/)).closest<HTMLElement>("[role=note]")!;
    expect(note.textContent).toContain("where your original message How full is the NAS? and what came after it stay");
    // The branch's composer is its own, empty; the original's Draft is still there.
    expect(composer().value).toBe("");
    await user.click(within(note).getByRole("button", { name: "Disk check" }));
    await waitFor(() => expect(composer().value).toBe("draft in the original"));
  }, 20_000);

  it("Cancel closes without sending anything", async () => {
    const { s, user } = await launch();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const dialog = await screen.findByRole("dialog", { name: "Edit message" });
    await within(dialog).findByRole("textbox", { name: "Your message" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.requests.some((r) => r.method === "session.branch" || r.method === "session.undo")).toBe(false);
  });
});

describe("Regenerate", () => {
  it("keeps the answer, adds a version per regeneration, and switches between them with the model each ran on", async () => {
    const { s, hermes, user } = await launch();
    const regenerate = () => screen.getAllByRole("button", { name: "Regenerate" });
    // Under each turn's last reply.
    expect(regenerate()).toHaveLength(2);
    for (const reply of ["Deleted 5 snapshots.", "Deleted 4 snapshots."]) {
      const note = screen.queryByText(/Another answer to your message/)?.closest<HTMLElement>("[role=note]");
      if (note) {
        await user.click(within(note).getByRole("button", { name: "Disk check" }));
        await screen.findByText("Deleted 3 snapshots.");
      }
      await user.click(regenerate()[1]);
      const dialog = await screen.findByRole("dialog", { name: "Regenerate reply" });
      await within(dialog).findByText("Stays in this chat");
      expect(dialog.textContent).toContain("Deleted 3 snapshots.");
      await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await screen.findByText(/Another answer to your message/);
      const id = s.sessions.filter((r) => r.parent_session_id === "c1").at(-1)!.id;
      await answer(s, hermes, id, reply);
    }
    // In the second regeneration: the third of three versions of the turn.
    let nav = await screen.findByRole("group", { name: "Versions of this turn" });
    expect(nav.textContent).toContain("3 / 3");
    expect(nav.textContent).toContain("Regenerated · gpt-5.2 · openai · high reasoning");
    await user.click(within(nav).getByRole("button", { name: "Previous version" }));
    await screen.findByText("Deleted 5 snapshots.");
    nav = screen.getByRole("group", { name: "Versions of this turn" });
    expect(nav.textContent).toContain("2 / 3");
    await user.click(within(nav).getByRole("button", { name: "Previous version" }));
    await screen.findByText("Deleted 3 snapshots.");
    nav = screen.getByRole("group", { name: "Versions of this turn" });
    expect(nav.textContent).toContain("1 / 3");
    expect(nav.textContent).toContain("Original · gpt-5.2 · openai · high reasoning (the chat's model now)");
    await waitFor(() => expect(document.querySelector(".msg.jumped")).not.toBeNull());
    // The original kept its four messages.
    expect(s.transcripts.c1).toHaveLength(4);
  }, 20_000);
});

describe("Blocked", () => {
  it("says why while a reply is running, and offers no way to send", async () => {
    const { s, hermes, user } = await launch();
    act(() => s.event(s.runtimeIdOf("c1")!, "message.start", {}));
    await act(async () => void (await hermes.idle()));
    const edit = screen.getAllByRole("button", { name: "Edit" })[0];
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.title).toContain("Stop the reply, or wait for it to end");
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Edit message" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("its tools may still be running");
    expect(within(dialog).queryByRole("button", { name: "Save as branch" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(s.requests.some((r) => r.method === "session.branch")).toBe(false);
  });
});
