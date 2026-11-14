// @vitest-environment jsdom
// Keyboard paths through the signed-in app, driven the way the owner would drive them, against a fake Hermes. Each
// test checks what reached Hermes (answers, interrupts, deletes), not which handler ran.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const focused = () => document.activeElement;
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const deletes = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "DELETE");

/** Lets Hermes's answers land and React render them. */
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** Signed in with two Active chats and the draft on screen, focus in its composer. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks", source: "telegram" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
  };
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

/** A new chat whose reply is running, focus in its composer. */
async function replying() {
  const s = await signedIn();
  await s.user.type(composer(), "Clean up the logs{Enter}");
  await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
  const runtime = String(prompts(s.server)[0].params.session_id);
  act(() => s.server.event(runtime, "message.start"));
  await settle(s.hermes);
  return { ...s, runtime };
}

/** A reply waiting on an Approval card, focus in the composer. */
async function waiting() {
  const s = await replying();
  let id: string | undefined;
  act(() => void ({ id } = s.server.askApproval(s.runtime)));
  await screen.findByRole("button", { name: "Approve once" });
  await settle(s.hermes);
  return { ...s, approvalId: id! };
}

/** Nothing answered, the card still waiting, and the reply still running. */
async function untouched({ server, hermes }: { server: FakeHermes; hermes: Hermes }) {
  await settle(hermes);
  expect(server.approvalAnswers).toEqual([]);
  expect(server.openRequests.size).toBe(1);
  expect(interrupts(server)).toEqual([]);
  expect(button("Approve once")).toBeTruthy();
}

describe("Approval card by keyboard", () => {
  it("is reached with Shift+Tab from the composer, and Enter on Approve once approves the command once", async () => {
    const s = await waiting();
    expect(focused()).toBe(composer());

    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Deny"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Always allow…"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Allow for this chat…"));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Approve once"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);

    expect(s.server.approvalAnswers.map((a) => [a.id, a.choice])).toEqual([[s.approvalId, "once"]]);
    expect(screen.getByText("Approved once")).toBeTruthy();
    // Focus stays on the answered card, so the owner keeps their place, and Tab carries on to the composer.
    expect(focused()?.classList.contains("approval")).toBe(true);
    await s.user.tab();
    expect(focused()).toBe(composer());
  });

  it("denies with Space on a focused Deny", async () => {
    const s = await waiting();
    await s.user.tab({ shift: true });
    await s.user.keyboard(" ");
    await settle(s.hermes);
    expect(s.server.approvalAnswers.map((a) => a.choice)).toEqual(["deny"]);
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("is never answered by Escape, and Escape doesn't stop the reply", async () => {
    const s = await waiting();
    button("Approve once").focus();
    await s.user.keyboard("{Escape}");
    await untouched(s);
    expect(focused()).toBe(button("Approve once"));
  });

  it("is never answered by bare number or letter keys, wherever focus is", async () => {
    const s = await waiting();
    button("Approve once").focus();
    await s.user.keyboard("1234yna");
    button("Deny").focus();
    await s.user.keyboard("1234yna");
    (focused() as HTMLElement).blur();
    expect(focused()).toBe(document.body);
    await s.user.keyboard("1234yna{Enter}{Escape}");
    await untouched(s);
  });

  it("is never answered by typing in the composer, Enter included", async () => {
    const s = await waiting();
    await s.user.type(composer(), "1y{Enter}");
    await untouched(s);
    // The reply is still running, so Enter queues the words for after it (ADR 0018) and sends nothing now.
    expect(composer().value).toBe("");
    expect(s.hermes.getSnapshot().queues[s.hermes.getSnapshot().chats[0].id]?.items.map((i) => i.text)).toEqual(["1y"]);
    expect(prompts(s.server)).toHaveLength(1);
  });

  it("is never answered by IME composition in the composer", async () => {
    const s = await waiting();
    fireEvent.compositionStart(composer());
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.keyDown(composer(), { key: "1", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(composer());
    await untouched(s);
    expect(prompts(s.server)).toHaveLength(1);
  });

  it("keeps focus on the card when Hermes stops waiting while Approve once has focus, so Enter answers nothing", async () => {
    const s = await waiting();
    button("Approve once").focus();
    act(() => s.server.cancelRequest(s.approvalId, "timeout"));
    await settle(s.hermes);

    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(focused()?.classList.contains("approval")).toBe(true);
    await s.user.keyboard("{Enter} 1");
    await settle(s.hermes);
    expect(s.server.approvalAnswers).toEqual([]);
    expect(interrupts(s.server)).toEqual([]);
  });

  it("asks again before a broader grant: Back takes focus, and going back keeps focus on the card", async () => {
    const s = await waiting();
    button("Allow for this chat…").focus();
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(button("Back"));
    await s.user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(focused()?.classList.contains("approval")).toBe(true);
    await untouched(s);

    button("Allow for this chat…").focus();
    await s.user.keyboard("{Enter}");
    await s.user.tab({ shift: true });
    expect(focused()).toBe(button("Yes, allow for this chat"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.approvalAnswers.map((a) => a.choice)).toEqual(["session"]);
    expect(focused()?.classList.contains("approval")).toBe(true);
  });

  it("keeps Approve once focusable but inert while offline", async () => {
    const s = await waiting();
    button("Approve once").focus();
    act(() => s.server.drop());
    await waitFor(() => expect(button("Approve once").getAttribute("aria-disabled")).toBe("true"));
    expect(focused()).toBe(button("Approve once"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.approvalAnswers).toEqual([]);
    // Nothing was even tried: a refused answer would have left an error in the chat.
    expect(screen.queryByText(/Couldn't answer Hermes/)).toBeNull();
    expect(screen.getByText("Hermes wants to run a command")).toBeTruthy();
  });
});

describe("Interrupting by keyboard", () => {
  it("never stops a running reply on Escape, from the composer or anywhere else", async () => {
    const s = await replying();
    await s.user.keyboard("{Escape}");
    (focused() as HTMLElement).blur();
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    expect(interrupts(s.server)).toEqual([]);
    expect(button("Stop")).toBeTruthy();
  });

  it("never stops a running reply on Escape in the find bar", async () => {
    const s = await replying();
    await s.user.keyboard("{Control>}f{/Control}");
    await waitFor(() => expect(focused()).toBe(screen.getByPlaceholderText("Find in chat")));
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    expect(screen.queryByPlaceholderText("Find in chat")).toBeNull();
    expect(interrupts(s.server)).toEqual([]);
  });

  it("stops the reply with Enter on the focused Stop button", async () => {
    const s = await replying();
    await s.user.tab(); // Attach files
    await s.user.tab();
    expect(focused()).toBe(button("Reference a chat"));
    await s.user.tab();
    expect(focused()).toBe(button("Dictate"));
    await s.user.tab();
    expect(focused()).toBe(button("Start voice conversation"));
    await s.user.tab();
    expect(focused()).toBe(button("Attach a screenshot"));
    await s.user.tab();
    expect(focused()).toBe(button(/^Model:/));
    await s.user.tab();
    expect(focused()).toBe(button(/^Reasoning effort:/));
    await s.user.tab();
    expect(focused()).toBe(button("Stop"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(interrupts(s.server).map((r) => r.params)).toEqual([{ session_id: s.runtime }]);
  });
});

describe("Composer by keyboard", () => {
  it("doesn't send on the Enter that confirms an IME candidate, and sends on the next one", async () => {
    const s = await signedIn();
    await s.user.type(composer(), "nihao");
    fireEvent.compositionStart(composer());
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(composer());
    await settle(s.hermes);
    expect(prompts(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await waitFor(() => expect(prompts(s.server).map((r) => r.params.text)).toEqual(["nihao"]));
  });

  it("still puts a new line on Shift+Enter", async () => {
    const s = await signedIn();
    await s.user.type(composer(), "one{Shift>}{Enter}{/Shift}two");
    expect(composer().value).toBe("one\ntwo");
    expect(prompts(s.server)).toEqual([]);
  });
});

describe("Search palette by keyboard", () => {
  it("opens on Ctrl+K from the composer, and Escape closes it with focus back in the composer", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    const input = screen.getByPlaceholderText("Search all chats, including Settled");
    expect(focused()).toBe(input);
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("closes on Ctrl+K again, with focus back where it was", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("closes on Escape from a focused result too", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("backup");
    const hit = await screen.findByRole("button", { name: /Nightly backup.*Why did the backup fail/ });
    await s.user.tab();
    expect(focused()).toBe(screen.getByRole("button", { name: "Filters" }));
    await s.user.tab();
    expect(focused()).toBe(hit);
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(focused()).toBe(composer());
  });

  it("opens the picked chat on Enter", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("restic");
    await screen.findByRole("button", { name: /Nightly backup.*restic/ });
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(s.server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["backup"]);
  });

  it("never answers a waiting card while typing or pressing Enter in it", async () => {
    const s = await waiting();
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.keyboard("1{Enter}y{Enter}");
    fireEvent.keyDown(focused()!, { key: "Enter", isComposing: true, keyCode: 229 });
    await s.user.keyboard("{Escape}");
    await untouched(s);
    expect(focused()).toBe(composer());
  });
});

describe("Profile menu by keyboard", () => {
  const profileButton = () => button(/default/);

  it("opens on Enter at its filter, and Escape closes it with focus back on the profile button", async () => {
    const s = await signedIn();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(screen.getByPlaceholderText("Filter profiles"));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Profiles" })).toBeNull();
    expect(focused()).toBe(profileButton());
  });

  it("closes on Escape from a focused option too", async () => {
    const s = await signedIn();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "default" });
    await s.user.tab();
    expect(focused()).toBe(screen.getByRole("option", { name: "default" }));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Profiles" })).toBeNull();
    expect(focused()).toBe(profileButton());
  });

  it("never answers a waiting card while typing or pressing Enter in it", async () => {
    const s = await waiting();
    profileButton().focus();
    await s.user.keyboard("{Enter}");
    await s.user.keyboard("1{Enter}");
    await s.user.keyboard("{Escape}");
    await untouched(s);
  });
});

describe("Chat list by keyboard", () => {
  const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });

  it("reaches each chat with Tab, and Enter opens it", async () => {
    const s = await signedIn();
    button(/default/).focus();
    // Hide chats ends the profile's row; New chat and Search, labeled, come next.
    await s.user.tab();
    expect(focused()).toBe(button("Hide chats (Ctrl+B)"));
    await s.user.tab();
    expect(focused()).toBe(button("New chat"));
    await s.user.tab();
    expect(focused()).toBe(button("Search chats"));
    // The project switcher sits under the profile's name, before the chats.
    await s.user.tab();
    expect(focused()).toBe(button(/All chats/));
    // Then the Inbox section's header, which collapses it, its Settle all, and its chats.
    await s.user.tab();
    expect(focused()).toBe(document.querySelector('[data-section-head="inbox"]'));
    await s.user.tab();
    expect(focused()).toBe(button("Settle all"));
    await s.user.tab();
    expect(focused()).toBe(rowButton("Nightly backup"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["backup"]);
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
  });

  it("opens the Active chat below or above with Alt+Down and Alt+Up, from anywhere", async () => {
    const s = await signedIn();
    const resumed = () => s.server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id);
    composer().focus();
    await s.user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(s.hermes);
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
    await s.user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(s.hermes);
    expect(rowButton("NAS disks").getAttribute("aria-current")).toBe("true");
    // The last one stays put.
    await s.user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await s.user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await settle(s.hermes);
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
    expect(resumed()).toEqual(["backup", "nas"]);
  });

  it("opens the chat below with Alt+Down from a focused chat row, where plain arrows only move focus", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    await s.user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(s.hermes);
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBe("true");
  });

  it("leaves Alt+arrows alone while another screen covers the chat", async () => {
    const s = await signedIn();
    await s.user.click(button("Settings"));
    await screen.findByRole("heading", { name: "Settings" });
    await s.user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(s.hermes);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(s.server.requests.filter((r) => r.method === "session.resume")).toEqual([]);
  });

  it("starts a new chat and opens search from the list's labeled buttons", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    await s.user.click(button("New chat"));
    expect(composer().value).toBe("");
    expect(rowButton("Nightly backup").getAttribute("aria-current")).toBeNull();
    await s.user.click(button("Search chats"));
    expect(screen.getByPlaceholderText("Search all chats, including Settled")).toBeTruthy();
  });

  it("opens Settings with Ctrl+Comma", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>},{/Control}");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  });

  it("moves between chats with the arrow keys without opening them", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    await s.user.keyboard("{ArrowDown}");
    expect(focused()).toBe(rowButton("NAS disks"));
    await s.user.keyboard("{ArrowDown}");
    expect(focused()).toBe(rowButton("NAS disks"));
    await s.user.keyboard("{ArrowUp}");
    expect(focused()).toBe(rowButton("Nightly backup"));
    await settle(s.hermes);
    expect(s.server.requests.filter((r) => r.method === "session.resume")).toEqual([]);
  });

  it("reaches Settle, Archive and Delete with Tab; Escape or Cancel keeps the chat with focus back on Delete", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    // Settle is how a chat is cleared from the Inbox (ADR 0090); there is no separate Clear.
    await s.user.tab();
    expect(focused()).toBe(screen.getAllByRole("button", { name: "Settle" })[0]);
    await s.user.tab();
    expect(focused()).toBe(screen.getAllByRole("button", { name: /^Archive:/ })[0]);
    await s.user.tab();
    const trash = screen.getAllByRole("button", { name: "Delete" })[0];
    expect(focused()).toBe(trash);

    await s.user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog", { name: "Delete “Nightly backup”?" })).toHaveProperty(
      "textContent",
      expect.stringContaining("in every Hermes client, on every computer. It can't be undone."),
    );
    expect(focused()).toBe(button("Cancel"));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(focused()).toBe(trash);
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await s.user.keyboard("{Enter}"); // on the focused Cancel
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(focused()).toBe(trash);
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    await s.user.keyboard("{Enter}");
    await s.user.tab();
    expect(focused()).toBe(button("Delete chat"));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(deletes(s.server).map((r) => r.path)).toEqual(["/api/sessions/backup"]);
  });

  it("asks before deleting when Delete or Backspace is pressed on a focused chat, and Cancel keeps it", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    await s.user.keyboard("{Delete}");
    expect(screen.getByRole("alertdialog", { name: "Delete “Nightly backup”?" })).toBeTruthy();
    expect(focused()).toBe(button("Cancel"));
    await s.user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(focused()).toBe(rowButton("Nightly backup"));
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    rowButton("NAS disks").focus();
    await s.user.keyboard("{Backspace}");
    await s.user.click(button("Delete chat"));
    await settle(s.hermes);
    expect(deletes(s.server).map((r) => r.path)).toEqual(["/api/sessions/nas"]);
    expect(screen.queryByRole("button", { name: /^NAS disks/ })).toBeNull();
  });

  it("doesn't ask to delete a chat whose reply is running", async () => {
    const s = await replying();
    const running = document.querySelector<HTMLButtonElement>(".row-open[aria-current]")!;
    running.focus();
    await s.user.keyboard("{Delete}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.contextMenu(running);
    expect(screen.queryByRole("menuitem", { name: "Delete chat…" })).toBeNull();
  });

  it("offers Delete chat… in a chat's right-click menu; it asks first, then deletes", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").focus();
    fireEvent.contextMenu(rowButton("Nightly backup"));
    await s.user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(button("Cancel"));
    await s.user.keyboard("{Escape}");
    expect(focused()).toBe(rowButton("Nightly backup"));
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    fireEvent.contextMenu(rowButton("Nightly backup"));
    await s.user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    await s.user.click(button("Delete chat"));
    await settle(s.hermes);
    expect(deletes(s.server).map((r) => r.path)).toEqual(["/api/sessions/backup"]);
  });

  it("takes the header's Delete question away when a reply starts, and doesn't bring it back when the reply ends", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    const runtime = s.server.runtimeIdOf("backup")!;
    await s.user.click(within(document.querySelector<HTMLElement>(".chat-head")!).getByRole("button", { name: "More" }));
    await s.user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    act(() => s.server.event(runtime, "message.start"));
    await settle(s.hermes);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => s.server.event(runtime, "message.complete", { text: "Done" }));
    await settle(s.hermes);
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(deletes(s.server)).toEqual([]);
  });

  it("offers Delete chat… in the open chat's header menu; it asks first, then deletes", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    const more = within(document.querySelector<HTMLElement>(".chat-head")!).getByRole("button", { name: "More" });
    await s.user.click(more);
    await s.user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    expect(screen.getByRole("alertdialog", { name: "Delete “Nightly backup”?" })).toBeTruthy();
    await s.user.click(button("Cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(focused()).toBe(more);
    await settle(s.hermes);
    expect(deletes(s.server)).toEqual([]);

    await s.user.click(more);
    await s.user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    await s.user.click(button("Delete chat"));
    await settle(s.hermes);
    expect(deletes(s.server).map((r) => r.path)).toEqual(["/api/sessions/backup"]);
    expect(screen.queryByRole("button", { name: /^Nightly backup/ })).toBeNull();
  });

  it("opens a chat's menu from the keyboard; Escape closes it, and renaming from it, with focus back on the chat", async () => {
    const s = await signedIn();
    // The Menu key or Shift+F10 fires contextmenu on the focused chat, with no pointer position.
    rowButton("Nightly backup").focus();
    fireEvent.contextMenu(rowButton("Nightly backup"));
    expect(focused()).toBe(screen.getByRole("menuitem", { name: "Rename…" }));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(rowButton("Nightly backup"));

    fireEvent.contextMenu(rowButton("Nightly backup"));
    await s.user.keyboard("{Enter}");
    expect(focused()).toBe(screen.getByRole("textbox", { name: "Chat title" }));
    await s.user.keyboard("Restic backup{Enter}");
    await waitFor(() => expect(focused()).toBe(rowButton("Restic backup")));
    expect(s.server.restRequests.filter((r) => r.method === "PATCH").map((r) => r.body?.title)).toEqual(["Restic backup"]);
  });
});

describe("Existing shortcuts", () => {
  it("opens find in chat on Ctrl+F from the composer", async () => {
    const s = await signedIn();
    await s.user.keyboard("{Control>}f{/Control}");
    await waitFor(() => expect(focused()).toBe(screen.getByPlaceholderText("Find in chat")));
    await s.user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Find in chat")).toBeNull();
  });

  it("starts a new chat on Ctrl+N and hides and shows the list on Ctrl+B", async () => {
    const s = await signedIn();
    rowButton("Nightly backup").click();
    await settle(s.hermes);
    await s.user.keyboard("{Control>}n{/Control}");
    expect(screen.getByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
    await s.user.keyboard("{Control>}b{/Control}");
    expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull();
    await s.user.keyboard("{Control>}b{/Control}");
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
  });

  it("hides the list from the button beside the profile switcher, and Ctrl+B brings it back", async () => {
    const s = await signedIn();
    const hide = screen.getByRole("button", { name: "Hide chats (Ctrl+B)" });
    expect(hide.closest(".sb-head")?.querySelector(".profile-switch")).toBeTruthy();
    expect(hide.getAttribute("title")).toBe("Hide chats (Ctrl+B)");
    expect(hide.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    await s.user.click(hide);
    expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull();
    // A pointer click leaves no rail tip up beside the H, away from the pointer.
    expect(document.querySelector(".rail-tip")).toBeNull();
    await s.user.keyboard("{Control>}b{/Control}");
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
    // From the keyboard, focus moves to the rail's button that brings the panel back.
    screen.getByRole("button", { name: "Hide chats (Ctrl+B)" }).focus();
    await s.user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull();
    expect(focused()).toBe(screen.getByRole("button", { name: "Hide or show chats" }));
    await s.user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
    await s.user.click(screen.getByRole("button", { name: "Hide chats (Ctrl+B)" }));
    await s.user.click(screen.getByRole("button", { name: "Hide or show chats" }));
    expect(screen.getByRole("button", { name: /Nightly backup/ })).toBeTruthy();
  });

  it("ignores Ctrl+K while an IME is composing", async () => {
    await signedIn();
    fireEvent.keyDown(composer(), { key: "k", ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  });

  function rowButton(title: string) {
    return screen.getByRole("button", { name: new RegExp(`^${title}`) });
  }
});
