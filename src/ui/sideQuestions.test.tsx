// @vitest-environment jsdom
// Side questions (`/btw`, ADR 0070) in the running app, against a fake Hermes: offered by Hermes's catalog, asked while a
// reply runs or the chat is idle, and shown in the transcript where they were asked, marked as outside it (ADR 0086).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
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

let launches = 0;

/** The app signed in to a fake Hermes, with the chat "Nightly backup" open. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nginx", 2, { pinned: true, title: "Rotate nginx logs" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@btw-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user, runtime: server.runtimeIdOf("backup")! };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const options = () => within(screen.getByRole("listbox", { name: "Commands" })).getAllByRole("option");
const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
const pairs = () => screen.queryAllByRole("article", { name: /^Side question:/ });
/** Whether `a` comes before `b` in the page. */
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const reply = (text: RegExp) => [...document.querySelectorAll(".msg.assistant:not(.side)")].find((m) => text.test(m.textContent ?? ""))!;

describe("/btw in the menu", () => {
  it("is offered when Hermes lists it, as a command Hermes runs", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("/bt");
    expect(options().map((o) => o.querySelector(".cmd-name")!.textContent)).toEqual(["/btw"]);
    expect(options()[0].textContent).toMatch(/<question>.*Hermes.*Ask a side question about this chat without interrupting the reply/);
    expect(options()[0].querySelector(".cmd-why")).toBeNull();
  });

  it("is marked unavailable, saying why, when this Hermes doesn't list it, and asks nothing", async () => {
    const { server, user } = await launch((s) => (s.commandCatalog = ["steer", "context"]));
    await user.click(composer());
    await user.keyboard("/bt");
    expect(options()[0].querySelector(".cmd-why")!.textContent).toBe("This Hermes doesn't list it, so it may not have it. Updating Hermes may add it.");
    await user.keyboard("{Enter}Which repo?{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/^\/btw can't run: This Hermes doesn't list it/);
    expect(composer().value).toBe("/btw Which repo?");
    expect(server.requests.some((r) => r.method === "prompt.btw")).toBe(false);
    expect(pairs()).toEqual([]);
  });
});

describe("A side question", () => {
  it("asked while a reply runs shows below the text streamed so far, waits, then shows its answer, and the reply goes on below it", async () => {
    const { server, hermes, user, runtime } = await launch();
    await user.type(composer(), "Run the backup{Enter}");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
    act(() => server.event(runtime, "message.delta", { text: "Running restic" }));

    await user.type(composer(), "/btw which repo was locked?{Enter}");
    const pair = await screen.findByRole("article", { name: "Side question: which repo was locked?" });
    expect(pair.closest(".transcript-inner")).toBeTruthy();
    expect(before(reply(/Running restic/), pair)).toBe(true);
    const [asked, answer] = pair.querySelectorAll(".msg");
    expect(asked.matches(".msg.user") && answer.matches(".msg.assistant")).toBe(true);
    for (const m of [asked, answer]) expect(m.textContent).toMatch(/Side question · not part of the conversation/);
    expect(asked.textContent).toMatch(/which repo was locked\?$/);
    expect(within(pair).getByRole("status").textContent).toMatch(/Hermes is answering from a snapshot of this chat/);
    await waitFor(() => expect(composer().value).toBe(""));
    expect(server.last("prompt.btw")?.params).toEqual({ session_id: runtime, text: "which repo was locked?" });
    // Never queued, steered or sent as a message.
    expect(sent(server)).toEqual(["Run the backup"]);
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();

    // The reply goes on: its text grows above the side question, and its next steps show below it.
    act(() => server.event(runtime, "message.delta", { text: " on the NAS" }));
    act(() => server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal", context: "restic unlock" }));
    act(() => server.event(runtime, "message.delta", { text: "Unlocked it." }));
    await waitFor(() => expect(reply(/Unlocked it/)).toBeTruthy());
    expect(before(reply(/Running restic on the NAS/), pair)).toBe(true);
    expect(before(pair, reply(/Unlocked it/))).toBe(true);

    const taskId = "btw_000001";
    act(() => server.event(runtime, "btw.complete", { task_id: taskId, question: "which repo was locked?", text: "The **restic** repo on the NAS." }));
    await waitFor(() => expect(within(pair).getByText("restic").tagName).toBe("STRONG"));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true);

    // Nothing in it can be edited, regenerated, branched from or read aloud: it isn't part of the chat.
    expect(within(pair).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Dismiss side question", "Copy"]);

    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    await user.click(within(pair).getByRole("button", { name: "Copy" }));
    expect(copied).toEqual(["The **restic** repo on the NAS."]);

    await user.click(within(pair).getByRole("button", { name: "Dismiss side question" }));
    expect(pairs()).toEqual([]);
    expect(document.activeElement).toBe(composer());
  });

  it("stays below the reply it was asked during when Hermes sends the reply's reasoning only as the turn ends", async () => {
    const { server, hermes, user, runtime } = await launch();
    await user.type(composer(), "Think about the lock, then run the backup again{Enter}");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
    act(() => server.event(runtime, "message.delta", { text: "Checking the lock" }));
    await user.type(composer(), "/btw is the NAS online?{Enter}");
    const pair = await screen.findByRole("article", { name: "Side question: is the NAS online?" });

    act(() => server.event(runtime, "message.complete", { status: "complete", text: "Checking the lock", reasoning: "The lock may be stale." }));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(false));
    const thought = [...document.querySelectorAll(".thought-label")].find((t) => t.textContent === "Thought")!;
    expect(before(thought, reply(/Checking the lock/))).toBe(true);
    expect(before(reply(/Checking the lock/), pair)).toBe(true);
  });

  it("whose message went when the chat was read again stays where it was shown, above what comes after", async () => {
    const { server, hermes, user, runtime } = await launch((s) => (s.sideAnswer = (q) => `Answer to ${q}`));
    await user.type(composer(), "Run it again{Enter}");
    act(() => server.event(runtime, "message.delta", { text: "Ran it again" }));
    act(() => server.event(runtime, "message.complete", { status: "complete", text: "Ran it again" }));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(false));
    await user.type(composer(), "/btw which snapshot?{Enter}");
    const pair = () => screen.getByRole("article", { name: "Side question: which snapshot?" });
    await waitFor(() => expect(pair()).toBeTruthy());
    expect(before(reply(/Ran it again/), pair())).toBe(true);

    // Another Hermes client took the last turn back while this one was away: the chat is read again without it.
    server.transcripts.backup = server.transcripts.backup.slice(0, 2);
    await act(async () => server.drop());
    await act(async () => void (await hermes.reconnect()));
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"));
    await act(async () => void (await hermes.open("backup")));
    await waitFor(() => expect(reply(/Ran it again/)).toBeUndefined());
    expect(before(reply(/restic repo was locked/), pair())).toBe(true);

    await user.type(composer(), "Try again{Enter}");
    const runtimeNow = server.runtimeIdOf("backup")!;
    act(() => server.event(runtimeNow, "message.delta", { text: "Trying again" }));
    await waitFor(() => expect(reply(/Trying again/)).toBeTruthy());
    const tryAgain = [...document.querySelectorAll(".msg.user:not(.side)")].find((m) => /Try again/.test(m.textContent ?? ""))!;
    expect(before(pair(), tryAgain)).toBe(true);
    expect(before(pair(), reply(/Trying again/))).toBe(true);
  });

  it("asked with the chat idle starts no turn, and stays with its chat across a switch", async () => {
    const { server, user } = await launch((s) => (s.sideAnswer = (q) => `Answer to ${q}`));
    await user.click(composer());
    await user.keyboard("/btw what was the error?{Enter}");
    expect(await screen.findByText("Answer to what was the error?")).toBeTruthy();
    expect(sent(server)).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Rotate nginx logs/ }));
    await waitFor(() => expect(pairs()).toEqual([]));
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(await screen.findByText("Answer to what was the error?")).toBeTruthy();
  });

  it("shows three at most, each after the messages there were when it was asked", async () => {
    const { server, user, runtime } = await launch((s) => (s.sideAnswer = (q) => `Answer to ${q}`));
    await user.click(composer());
    for (const q of ["one", "two", "three", "four"]) {
      await user.keyboard(`/btw ${q}{Enter}`);
      await screen.findByText(`Answer to ${q}`);
    }
    expect(pairs().map((c) => c.getAttribute("aria-label"))).toEqual(["Side question: two", "Side question: three", "Side question: four"]);
    expect(before(reply(/restic repo was locked/), pairs()[0])).toBe(true);

    await user.keyboard("Run it again{Enter}");
    act(() => server.event(runtime, "message.delta", { text: "Running it again" }));
    await waitFor(() => expect(reply(/Running it again/)).toBeTruthy());
    expect(before(pairs().at(-1)!, reply(/Running it again/))).toBe(true);
    // The composer keeps its place below the transcript; nothing stands between them.
    expect(document.querySelector(".side-questions")).toBeNull();
  }, 20_000);

  it("shows Hermes's refusal as its answer, not as a failed message, and keeps the words typed", async () => {
    const { server, user } = await launch();
    server.handlers["prompt.btw"] = (r) => server.fail(r.id, 4001, "session not found");
    await user.click(composer());
    await user.keyboard("/btw anything?{Enter}");
    const card = await screen.findByRole("article", { name: "Side question: anything?" });
    expect(within(card).getByRole("alert").textContent).toBe("No answer: session not found");
    expect(composer().value).toBe("/btw anything?");
    expect([...document.querySelectorAll(".msg.user:not(.side)")].map((m) => m.textContent)).not.toContainEqual(expect.stringMatching(/anything/));
  });

  it("shows in its answer that the connection dropped before it came", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/btw still there?{Enter}");
    const card = await screen.findByRole("article", { name: "Side question: still there?" });
    act(() => server.drop());
    await waitFor(() => expect(within(card).getByRole("alert").textContent).toBe("No answer: The connection to Hermes dropped before it answered."));
  });
});

describe("Asking a side question", () => {
  it("scrolls the transcript to the bottom, where it shows, as sending a message does", async () => {
    const { user } = await launch();
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    let top = 0;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          top = Math.max(0, Math.min(v, 900));
        },
      },
    });
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    await user.click(composer());
    await user.keyboard("/btw anything?{Enter}");
    await screen.findByRole("article", { name: "Side question: anything?" });
    expect(transcript.scrollTop).toBe(900);
  });
});
