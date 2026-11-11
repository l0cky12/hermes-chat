// @vitest-environment jsdom
// Queueing the next messages while Hermes replies (ADR 0018), driven the way the owner would, against a fake Hermes.
// Each test checks what is on screen and what reached Hermes.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
const composerIn = (el: HTMLElement) => within(el).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const queueIn = (el: HTMLElement) => within(el).queryByRole("region", { name: "Queued messages" });
const queuedTexts = (el: HTMLElement) => Array.from(el.querySelectorAll(".queue-text")).map((t) => t.textContent);
const rowsIn = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".queue-item"));
const rowOf = (el: HTMLElement, text: string) => rowsIn(el).find((r) => r.querySelector(".queue-text")?.textContent === text)!;

/** A drag's data, as in a browser readable only on drop; before, only its types. */
function transfer() {
  const data = new Map<string, string>();
  const dataTransfer = {
    readable: false,
    types: [] as string[],
    setData: (k: string, v: string) => (data.set(k, v), dataTransfer.types.push(k)),
    getData: (k: string) => (dataTransfer.readable ? (data.get(k) ?? "") : ""),
    effectAllowed: "",
    dropEffect: "",
  };
  return dataTransfer;
}
type Transfer = ReturnType<typeof transfer>;

const box = (top: number, height: number) => ({ left: 0, top, width: 600, height, right: 600, bottom: top + height, x: 0, y: top, toJSON: () => {} });

/** Lays the queue rows out 40 pixels tall from the top, in their order at the time each is measured, `scrolled` pixels
 * up. The list itself stays unmeasured unless `shown` gives how much of it is in sight from the top. */
function layOut({ scrolled = 0, shown }: { scrolled?: number; shown?: number } = {}) {
  for (const row of document.querySelectorAll<HTMLElement>(".queue-item")) {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => box(Array.from(row.parentElement!.children).indexOf(row) * 40 - scrolled, 40));
  }
  if (shown !== undefined) for (const list of document.querySelectorAll(".queue-list")) vi.spyOn(list, "getBoundingClientRect").mockReturnValue(box(0, shown));
}

// jsdom has no DragEvent, so the pointer's place is put on the event by hand.
const at = (e: Event, clientY: number) => Object.defineProperties(e, { clientX: { value: 10 }, clientY: { value: clientY } });
/** Whether `target` takes a drop there, as the browser decides it: by the dragover's default being prevented. */
const dragOver = (target: Element, clientY: number, dataTransfer: Transfer) => !fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), clientY));
const dropOn = (target: Element, clientY: number, dataTransfer: Transfer) => {
  dataTransfer.readable = true;
  fireEvent(target, at(createEvent.drop(target, { dataTransfer }), clientY));
};

/** Drags `source` over `target` with the pointer at `clientY`, and drops it there unless `drop` is false. Returns whether
 * the drop was allowed. */
function drag(source: Element, target: Element, clientY: number, { drop = true } = {}) {
  const dataTransfer = transfer();
  layOut();
  fireEvent.dragStart(source, { dataTransfer });
  const allowed = dragOver(target, clientY, dataTransfer);
  if (!drop) return allowed;
  if (allowed) dropOn(target, clientY, dataTransfer);
  fireEvent.dragEnd(source, { dataTransfer });
  return allowed;
}

/** Signed in, with "Nightly backup" open and a reply streaming in it. */
async function replying() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await settle(hermes);
  await user.type(composerIn(document.body), "Unlock it{Enter}");
  await waitFor(() => expect(prompts(server)).toEqual(["Unlock it"]));
  const runtime = server.runtimeIdOf("backup")!;
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Unlocking" });
  });
  const finish = async (payload: Record<string, unknown> = { status: "complete" }) => {
    act(() => server.event(runtime, "message.complete", payload));
    await settle(hermes);
    await act(async () => {});
  };
  return { server, hermes, user, runtime, finish };
}

describe("While Hermes replies", () => {
  it("keeps the composer editable, says Enter queues, and queues with Enter or the Queue button beside Stop", async () => {
    const s = await replying();
    const box = composerIn(document.body);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Enter to queue/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    await s.user.type(box, "Then prune old snapshots{Enter}");
    await s.user.type(box, "Then check the repo");
    await s.user.click(screen.getByRole("button", { name: "Queue" }));
    expect(box.value).toBe("");
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    const queue = queueIn(document.body)!;
    expect(queuedTexts(queue)).toEqual(["Then prune old snapshots", "Then check the repo"]);
    expect(within(queue).getByText("Next")).toBeTruthy();
    expect(within(queue).getByText(/goes when this reply finishes/)).toBeTruthy();
    expect(within(queue).getByText(/only while it's open and connected/)).toBeTruthy();

    // Enter still queues while messages wait, even once the reply has ended: a new one never jumps the queue.
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "Then prune old snapshots"]);
    expect(queuedTexts(queueIn(document.body)!)).toEqual(["Then check the repo"]);
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "Then prune old snapshots", "Then check the repo"]);
    expect(queueIn(document.body)).toBeNull();
    // Idle and nothing queued: Enter sends again.
    await s.finish();
    expect(screen.getByText(/Enter to send/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("edits a queued message in place, reorders it from the keyboard, and removes it", async () => {
    const s = await replying();
    const box = composerIn(document.body);
    for (const t of ["first", "second", "third"]) await s.user.type(box, `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;

    await s.user.click(within(queue()).getByRole("button", { name: "Edit queued message 2" }));
    const edit = within(queue()).getByRole("textbox", { name: "Edit queued message 2" });
    expect(document.activeElement).toBe(edit);
    await s.user.clear(edit);
    await s.user.type(edit, "second, edited{Enter}");
    expect(queuedTexts(queue())).toEqual(["first", "second, edited", "third"]);
    // Focus goes back to the Edit button.
    await waitFor(() => expect(document.activeElement).toBe(within(queue()).getByRole("button", { name: "Edit queued message 2" })));

    // Alt+↑ on the third moves it up, twice, and focus follows it.
    const third = queue().querySelectorAll<HTMLElement>(".queue-item")[2];
    third.focus();
    await s.user.keyboard("{Alt>}{ArrowUp}{ArrowUp}{/Alt}");
    expect(queuedTexts(queue())).toEqual(["third", "first", "second, edited"]);
    expect((document.activeElement as HTMLElement).dataset.queued).toBe(third.dataset.queued);

    // Delete removes the focused one; focus goes to the one now in its place.
    await s.user.keyboard("{Delete}");
    expect(queuedTexts(queue())).toEqual(["first", "second, edited"]);
    expect(document.activeElement?.textContent).toContain("first");
    await s.user.click(within(queue()).getByRole("button", { name: "Remove queued message 2" }));

    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "first"]);
  });

  it("moves a message dragged to the top, the middle or the bottom, marking the place first", async () => {
    const s = await replying();
    for (const t of ["a", "b", "c", "d"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;
    const marks = () => rowsIn(queue()).map((r) => (r.classList.contains("insert-before") ? "^" : r.classList.contains("insert-after") ? "v" : "-")).join("");
    expect(rowsIn(queue()).every((r) => r.draggable)).toBe(true);

    expect(drag(rowOf(queue(), "d"), queue(), 5, { drop: false })).toBe(true);
    expect(marks()).toBe("^---");
    await waitFor(() => expect(rowOf(queue(), "d").classList.contains("dragging")).toBe(true));
    drag(rowOf(queue(), "d"), queue(), 5);
    expect(queuedTexts(queue())).toEqual(["d", "a", "b", "c"]);
    expect(marks()).toBe("----");
    expect(rowOf(queue(), "d").classList.contains("dragging")).toBe(false);
    expect(document.activeElement).toBe(rowOf(queue(), "d"));

    // Below the middle of the second row: in front of the third, so second.
    drag(rowOf(queue(), "d"), queue(), 70);
    expect(queuedTexts(queue())).toEqual(["a", "d", "b", "c"]);

    expect(drag(rowOf(queue(), "a"), queue(), 155, { drop: false })).toBe(true);
    expect(marks()).toBe("---v");
    drag(rowOf(queue(), "a"), queue(), 155);
    expect(queuedTexts(queue())).toEqual(["d", "b", "c", "a"]);

    // Where it already is, either side of itself: nothing is marked and the drop is refused.
    expect(drag(rowOf(queue(), "b"), queue(), 45, { drop: false })).toBe(false);
    expect(drag(rowOf(queue(), "b"), queue(), 75)).toBe(false);
    expect(marks()).toBe("----");
    expect(queuedTexts(queue())).toEqual(["d", "b", "c", "a"]);

    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "d"]);
  });

  it("puts a message dropped over the queue's foot last and over its head first, when the list scrolls", async () => {
    const s = await replying();
    for (const t of ["a", "b", "c", "d"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;
    const list = queue().querySelector<HTMLElement>(".queue-list")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 160 });
    const lifted = (source: Element, clientY: number, layout: Parameters<typeof layOut>[0]) => {
      const dataTransfer = transfer();
      layOut(layout);
      fireEvent.dragStart(source, { dataTransfer });
      const allowed = dragOver(queue(), clientY, dataTransfer);
      if (allowed) dropOn(queue(), clientY, dataTransfer);
      fireEvent.dragEnd(source, { dataTransfer });
      return allowed;
    };

    // Two rows in sight; "c" and "d" are below the foot, out of sight.
    expect(lifted(rowOf(queue(), "a"), 100, { shown: 80 })).toBe(true);
    expect(queuedTexts(queue())).toEqual(["b", "c", "d", "a"]);
    expect(list.scrollTop).toBe(160);

    // Scrolled to the end: "b" and "c" are above the head, out of sight.
    expect(lifted(rowOf(queue(), "a"), -10, { scrolled: 80, shown: 80 })).toBe(true);
    expect(queuedTexts(queue())).toEqual(["a", "b", "c", "d"]);
    expect(list.scrollTop).toBe(0);
  });

  it("refuses a queued message dropped outside the queue, and the composer takes nothing from it", async () => {
    const s = await replying();
    for (const t of ["first", "second"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = queueIn(document.body)!;
    const box = composerIn(document.body);
    expect(drag(rowOf(queue, "second"), box, 0)).toBe(false);
    expect(drag(rowOf(queue, "second"), document.querySelector(".pane-drop")!, 0)).toBe(false);
    expect(drag(rowOf(queue, "second"), document.querySelector(".tab-strip")!, 0)).toBe(false);
    expect(box.value).toBe("");
    expect(queuedTexts(queue)).toEqual(["first", "second"]);
    expect(rowsIn(queue).some((r) => r.classList.contains("dragging"))).toBe(false);
    // A chat from the list, dragged over the queue, is the pane's to take (a new tab), not the queue's: nothing is marked.
    drag(document.querySelector(".row-open")!, queue, 5, { drop: false });
    expect(queue.querySelector(".insert-before, .insert-after")).toBeNull();
  });

  it("can't drag a message while it is being edited, nor take its text selection as one", async () => {
    const s = await replying();
    for (const t of ["first", "second", "third"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;
    await s.user.click(within(queue()).getByRole("button", { name: "Edit queued message 3" }));
    const edit = within(queue()).getByRole<HTMLTextAreaElement>("textbox", { name: "Edit queued message 3" });
    expect(rowsIn(queue()).map((r) => r.draggable)).toEqual([true, true, false]);
    expect(drag(edit, queue(), 5)).toBe(false);
    expect(queuedTexts(queue())).toEqual(["first", "second"]);
    expect(edit.value).toBe("third");

    drag(rowOf(queue(), "first"), queue(), 75);
    expect(queuedTexts(queue())).toEqual(["second", "first"]);
    expect(rowsIn(queue())[2].querySelector("textarea")).toBe(edit);
  });

  it("drops nothing when the dragged message goes before the drop", async () => {
    const s = await replying();
    for (const t of ["first", "second", "third"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;
    const dataTransfer = transfer();
    layOut();
    fireEvent.dragStart(rowOf(queue(), "first"), { dataTransfer });
    expect(dragOver(queue(), 115, dataTransfer)).toBe(true);
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "first"]);
    layOut();
    // Its row is gone, so it sees no dragend; the drag still carries its type.
    expect(dragOver(queue(), 75, dataTransfer)).toBe(false);
    dropOn(queue(), 75, dataTransfer);
    expect(queuedTexts(queue())).toEqual(["second", "third"]);
    expect(queue().querySelector(".insert-before, .insert-after")).toBeNull();

    drag(rowOf(queue(), "third"), queue(), 5);
    expect(queuedTexts(queue())).toEqual(["third", "second"]);
  });

  it("goes by Tab from a message to its Edit and Remove, then to the next message", async () => {
    const s = await replying();
    for (const t of ["first", "second"]) await s.user.type(composerIn(document.body), `${t}{Enter}`);
    const queue = queueIn(document.body)!;
    rowsIn(queue)[0].focus();
    const stops: string[] = [];
    for (let i = 0; i < 5; i++) {
      stops.push((document.activeElement?.getAttribute("aria-label") ?? "").replace(/:.*/, ""));
      await s.user.tab();
    }
    expect(stops).toEqual(["Queued message 1 of 2", "Edit queued message 1", "Remove queued message 1", "Queued message 2 of 2", "Edit queued message 2"]);
    expect(within(queue).queryByRole("button", { name: /Move queued message/ })).toBeNull();
  });

  it("Escape cancels an edit, and nothing goes while one is open", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "keep me{Enter}");
    const queue = () => queueIn(document.body)!;
    await s.user.click(within(queue()).getByRole("button", { name: "Edit queued message 1" }));
    await s.user.type(within(queue()).getByRole("textbox"), " changed");
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    await waitFor(() => expect(prompts(s.server)).toEqual(["Unlock it", "keep me"]));
  });

  it("Pause holds the queue past the reply's end; Resume lets it go", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "later{Enter}");
    await s.user.click(within(queueIn(document.body)!).getByRole("button", { name: "Pause" }));
    expect(within(queueIn(document.body)!).getByText(/Paused\. You paused it\./)).toBeTruthy();
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    await s.user.click(within(queueIn(document.body)!).getByRole("button", { name: "Resume" }));
    await settle(s.hermes);
    expect(prompts(s.server)).toEqual(["Unlock it", "later"]);
  });

  it("Stop stops the reply and pauses the queue, saying so", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "next{Enter}");
    await s.user.click(screen.getByRole("button", { name: "Stop" }));
    await s.finish({ status: "interrupted", text: "Unlocking" });
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    expect(within(queueIn(document.body)!).getByText(/was stopped/)).toBeTruthy();
  });
});

describe("The same chat in both panes", () => {
  it("shares one queue: queued in one pane, it shows in both, can be removed from either, and goes once", async () => {
    const s = await replying();
    await s.user.keyboard("{Control>}\\{/Control}");
    const [left, right] = panes();
    await s.user.type(composerIn(right), "from the right{Enter}");
    await s.user.type(composerIn(left), "from the left{Enter}");
    await s.user.type(composerIn(left), "drop me{Enter}");
    expect(queuedTexts(queueIn(left)!)).toEqual(["from the right", "from the left", "drop me"]);
    expect(queuedTexts(queueIn(right)!)).toEqual(["from the right", "from the left", "drop me"]);
    await s.user.click(within(queueIn(right)!).getByRole("button", { name: "Remove queued message 3" }));
    expect(queuedTexts(queueIn(left)!)).toEqual(["from the right", "from the left"]);

    await s.finish();
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "from the right", "from the left"]);
  });

  it("shows a message dragged in one pane in its new place in both, and takes a drag from one pane's queue in the other's", async () => {
    const s = await replying();
    await s.user.keyboard("{Control>}\\{/Control}");
    const [left, right] = panes();
    for (const t of ["one", "two", "three"]) await s.user.type(composerIn(left), `${t}{Enter}`);
    drag(rowOf(queueIn(left)!, "three"), queueIn(left)!, 5);
    expect(queuedTexts(queueIn(left)!)).toEqual(["three", "one", "two"]);
    expect(queuedTexts(queueIn(right)!)).toEqual(["three", "one", "two"]);

    drag(rowOf(queueIn(left)!, "three"), queueIn(right)!, 155);
    expect(queuedTexts(queueIn(right)!)).toEqual(["one", "two", "three"]);
    expect(queuedTexts(queueIn(left)!)).toEqual(["one", "two", "three"]);

    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "one"]);
  });
});
