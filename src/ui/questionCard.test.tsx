// @vitest-environment jsdom
// Clarify, Sudo password and Secret cards (#390) in the signed-in app, driven by keyboard the way the owner would,
// against a fake Hermes that speaks the contract. Each test checks what reached Hermes, not which handler ran.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { localChatCache } from "../hermes/chatCache";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const focused = () => document.activeElement;
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
/** The card for Hermes's request `id`. */
const cardOf = (id: string) => document.querySelector<HTMLElement>(`[data-item="${id}"]`)!;

type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedState: unknown; memoizedProps: unknown };
type Hook = { memoizedState: unknown; baseState?: unknown; queue?: { lastRenderedState?: unknown } | null; next: Hook | null };
/**
 * Whether React holds `text` in a mounted component's state or an element's props, as a card holds what is typed into
 * its field. Both live on React's fibers, reached from the root's container.
 */
function reactHolds(text: string): boolean {
  const has = (v: unknown) => typeof v === "string" && v.includes(text);
  const container = [...document.body.children].find((el) => Object.keys(el).some((k) => k.startsWith("__reactContainer$")))!;
  const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"))!;
  const stack: Fiber[] = [(container as unknown as Record<string, { stateNode: { current: Fiber } }>)[key].stateNode.current];
  while (stack.length) {
    const f = stack.pop()!;
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
    const props = f.memoizedProps;
    if (has(props) || (props && typeof props === "object" && Object.values(props).some(has))) return true;
    for (let h = f.memoizedState as Hook | null; h && typeof h === "object" && "next" in h; h = h.next) if ([h.memoizedState, h.baseState, h.queue?.lastRenderedState].some(has)) return true;
  }
  return false;
}

/** A new chat whose reply is running, focus in its composer, on a Hermes whose chats this computer keeps. */
async function replying() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  const hermes = await connect(server.openPipe, undefined, localChatCache(connection));
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  await user.type(composer(), "Set up the weather skill{Enter}");
  await waitFor(() => expect(prompts(server)).toHaveLength(1));
  const runtime = String(prompts(server)[0].params.session_id);
  act(() => server.event(runtime, "message.start"));
  await settle(hermes);
  /** Hermes asks; resolves to the request id once its card shows. */
  const ask = async (asking: () => string | undefined) => {
    let id: string | undefined;
    act(() => void (id = asking()));
    await waitFor(() => expect(cardOf(id!)).toBeTruthy());
    await settle(hermes);
    return id!;
  };
  return { server, hermes, user, runtime, ask };
}

describe("Clarify card", () => {
  it("is reached from the composer, locks a picked choice and typed words one at a time, and then answers Hermes", async () => {
    const s = await replying();
    const id = await s.ask(() =>
      s.server.askClarify(s.runtime, [{ question: "Which logs should I clear?", choices: ["Only old ones (Recommended)", "All of them"] }, { question: "When?" }]),
    );
    const card = within(cardOf(id));
    expect(card.getByText("Hermes is asking")).toBeTruthy();
    expect(focused()).toBe(composer());

    // Backwards from the composer: Skip, the second question's Lock answer and field, then the first question's own-answer
    // field and choices.
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "Skip" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "Lock answer" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("textbox", { name: "Your answer" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("textbox", { name: "Or your own answer" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "All of them" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "Only old ones (Recommended)" }));
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);

    // Hermes's recommendation mark isn't part of the answer.
    expect(s.server.requests.filter((r) => r.method === "clarify.lock").map((r) => r.params)).toEqual([{ request_id: id, question_id: "q0", answer: "Only old ones" }]);
    expect(card.getByText("Only old ones")).toBeTruthy();
    expect(card.getByRole("button", { name: "Skip the rest" })).toBeTruthy();

    await s.user.type(card.getByRole("textbox", { name: "Your answer" }), "Tonight{Enter}");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([{ id, method: "clarify", result: { answers: { q0: "Only old ones", q1: "Tonight" }, outcome: "submitted" }, via: "clarify.lock" }]);
    expect(card.getByText("Answered")).toBeTruthy();
    expect(card.queryByRole("textbox")).toBeNull();
    expect(card.queryByRole("button")).toBeNull();
    // Focus stays on the answered card, so the owner keeps their place.
    expect(focused()).toBe(cardOf(id));
  });

  it("locks several ticked choices together, with words of the owner's own", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askClarify(s.runtime, [{ question: "Which folders?", choices: ["/var/log", "/tmp"], multi_select: true }]));
    const card = within(cardOf(id));
    await s.user.click(card.getByRole("checkbox", { name: "/var/log" }));
    await s.user.click(card.getByRole("checkbox", { name: "/tmp" }));
    await s.user.type(card.getByRole("textbox", { name: "Or your own answer" }), "~/.cache");
    card.getByRole("button", { name: "Lock answer" }).focus();
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.settled[0].result).toEqual({ answers: { q0: '["/var/log","/tmp","~/.cache"]' }, outcome: "submitted" });
    expect(card.getByText("/var/log, /tmp, ~/.cache")).toBeTruthy();
  });

  it("skips with Skip, which answers Hermes with no answers", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askClarify(s.runtime, [{ question: "When?" }]));
    within(cardOf(id)).getByRole("button", { name: "Skip" }).focus();
    await s.user.keyboard(" ");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([{ id, method: "clarify", result: { answers: {}, outcome: "cancelled" }, via: "request.answer" }]);
    expect(within(cardOf(id)).getByText("Skipped")).toBeTruthy();
  });

  it("closes with why when Hermes stops waiting", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askClarify(s.runtime, [{ question: "When?" }]));
    act(() => s.server.cancelRequest(id, "timeout"));
    await settle(s.hermes);
    const card = within(cardOf(id));
    expect(card.getByText("Timed out without an answer")).toBeTruthy();
    expect(card.queryByRole("textbox")).toBeNull();
    expect(card.queryByRole("button")).toBeNull();
  });
});

describe("Sudo password and Secret cards", () => {
  it("takes the sudo password in a masked field, sends it on Enter, and keeps none of it", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askSudo(s.runtime, "sudo apt-get install -y ripgrep"));
    const card = within(cardOf(id));
    expect(card.getByText("Hermes needs the sudo password")).toBeTruthy();
    expect(card.getByText("sudo apt-get install -y ripgrep")).toBeTruthy();

    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "Skip" }));
    await s.user.tab({ shift: true });
    expect(focused()).toBe(card.getByRole("button", { name: "Send" }));
    await s.user.tab({ shift: true });
    const field = card.getByLabelText<HTMLInputElement>("Sudo password");
    expect(focused()).toBe(field);
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");

    await s.user.keyboard("hunter2{Enter}");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([{ id, method: "sudo", result: { value: "hunter2" }, via: "request.answer" }]);
    expect(card.getByText("Password sent")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("hunter2");
    expect(JSON.stringify(s.hermes.getSnapshot())).not.toContain("hunter2");
    expect(Object.keys(localStorage).length).toBeGreaterThan(0);
    expect(Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes("hunter2"))).toEqual([]);
  });

  it("sends nothing for an empty field, and Skip skips", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askSecret(s.runtime));
    const card = within(cardOf(id));
    expect(card.getByText("Hermes needs a value for OPENWEATHER_API_KEY")).toBeTruthy();
    expect(card.getByText("Enter your OpenWeather API key")).toBeTruthy();
    const field = card.getByLabelText<HTMLInputElement>("Value for OPENWEATHER_API_KEY");
    expect(field.type).toBe("password");

    await s.user.type(field, "{Enter}");
    card.getByRole("button", { name: "Send" }).focus();
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([]);

    card.getByRole("button", { name: "Skip" }).focus();
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([{ id, method: "secret", result: { value: "" }, via: "request.answer" }]);
    expect(card.getByText("Skipped")).toBeTruthy();
  });

  it("keeps no typed value once the owner skips", async () => {
    const s = await replying();
    const id = await s.ask(() => s.server.askSecret(s.runtime));
    const card = within(cardOf(id));
    await s.user.type(card.getByLabelText("Value for OPENWEATHER_API_KEY"), "sk-typed-then-skipped");
    expect(reactHolds("sk-typed-then-skipped")).toBe(true);

    card.getByRole("button", { name: "Skip" }).focus();
    await s.user.keyboard("{Enter}");
    await settle(s.hermes);
    expect(s.server.settled).toEqual([{ id, method: "secret", result: { value: "" }, via: "request.answer" }]);
    expect(card.getByText("Skipped")).toBeTruthy();
    expect(reactHolds("sk-typed-then-skipped")).toBe(false);
  });

  it.each([
    ["Hermes stops waiting", "Timed out without an answer", (s: Awaited<ReturnType<typeof replying>>, id: string) => s.server.cancelRequest(id, "timeout")],
    [
      "another Hermes app answers",
      "Answered in another Hermes client",
      (s: Awaited<ReturnType<typeof replying>>, id: string) => {
        s.server.answerElsewhere(id, "response");
        s.server.event(s.runtime, "tool.complete", { tool_id: "t1" });
      },
    ],
  ])("keeps no typed value once %s", async (_, note, close) => {
    const s = await replying();
    const id = await s.ask(() => s.server.askSudo(s.runtime));
    await s.user.type(within(cardOf(id)).getByLabelText("Sudo password"), "hunter2-typed");
    act(() => close(s, id));
    await settle(s.hermes);
    expect(within(cardOf(id)).getByText(note)).toBeTruthy();
    expect(reactHolds("hunter2-typed")).toBe(false);
    expect(s.server.settled).toEqual([]);
  });

  it("does nothing offline, and keeps what was typed for when Hermes is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = await replying();
      const id = await s.ask(() => s.server.askSecret(s.runtime));
      const card = within(cardOf(id));
      await s.user.type(card.getByLabelText("Value for OPENWEATHER_API_KEY"), "sk-weather-1");
      act(() => s.server.drop());
      await settle(s.hermes);
      card.getByRole("button", { name: "Send" }).focus();
      await s.user.keyboard("{Enter}");
      expect(s.server.settled).toEqual([]);
      expect(card.getByLabelText<HTMLInputElement>("Value for OPENWEATHER_API_KEY").value).toBe("sk-weather-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
