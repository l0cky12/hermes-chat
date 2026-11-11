// @vitest-environment jsdom
// A long transcript renders in memoized chunks, so a streamed delta or a dismissed side question touches one chunk and
// leaves the rest of the chat as it was.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat, Item, SideQuestion } from "../hermes/model";
import { ChatPane, type FindTarget } from "./ChatPane";
import { chunkBlocks } from "./transcriptChunks";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const sideRenders = vi.hoisted(() => [] as string[]);
vi.mock("./SideQuestions", async (actual) => {
  const real = await actual<typeof import("./SideQuestions")>();
  return {
    ...real,
    SideQuestionPair: (props: Parameters<typeof real.SideQuestionPair>[0]) => {
      sideRenders.push(`Side question: ${props.question.question}`);
      return <real.SideQuestionPair {...props} />;
    },
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  sideRenders.length = 0;
});

const chatOf = (items: Item[], over: Partial<Chat> = {}): Chat => ({ id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, ...over });

function pane(chat: Chat, findTarget?: FindTarget) {
  const el = (c: Chat, t?: FindTarget) => (
    <ChatPane
      chat={c}
      findTarget={t}
      status="connected"
      draft=""
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
      onDismissSideQuestion={(id) => dismissed.push(id)}
    />
  );
  const dismissed: string[] = [];
  const r = render(el(chat, findTarget));
  return { dismissed, show: (c: Chat) => act(() => r.rerender(el(c))) };
}

/** `turns` turns of the owner's message and its reply, with a side question asked after every tenth reply. */
function longChat(turns: number) {
  const items: Item[] = [];
  const sideQuestions: SideQuestion[] = [];
  for (let t = 0; t < turns; t++) {
    items.push({ kind: "user", id: `u-${t}`, text: `Question ${t}` }, { kind: "assistant", id: `a-${t}`, text: `Answer ${t}` });
    if (t % 10 === 5) sideQuestions.push({ id: `btw-${t}`, question: `Aside ${t}?`, after: `a-${t}`, state: "answered", answer: `Aside ${t}.` });
  }
  return { items, sideQuestions };
}

const messages = () => [...document.querySelectorAll<HTMLElement>(".msg[data-item]")];
const pairs = () => [...document.querySelectorAll<HTMLElement>("article.side-q")];
/** The ids of the elements in `now` that aren't the very element at their place in `before`: remounted ones. */
const remounted = (before: HTMLElement[], now: HTMLElement[]) =>
  now.filter((el, i) => el !== before[i]).map((el) => el.dataset.item ?? el.getAttribute("aria-label"));

describe("chunkBlocks", () => {
  const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `m-${from + i}` }));
  const firsts = (chunks: { id: string }[][]) => chunks.map((c) => c[0].id);
  const sameChunks = (a: { id: string }[], b: { id: string }[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
  const notIn = (a: { id: string }[][], b: { id: string }[][]) => a.filter((x) => !b.some((y) => sameChunks(x, y)));

  it("keeps every block once, in order, in more than one chunk for a long chat", () => {
    const blocks = ids(2000);
    const chunks = chunkBlocks(blocks);
    expect(chunks.flat()).toEqual(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("changes only the chunk that holds a removed block", () => {
    const blocks = ids(2000);
    const before = chunkBlocks(blocks);
    for (const at of [1, 500, 1001, 1999]) {
      const after = chunkBlocks(blocks.filter((_, i) => i !== at));
      expect(notIn(after, before)).toHaveLength(1);
      const startedOne = firsts(before).includes(blocks[at].id);
      expect(notIn(before, after)).toHaveLength(startedOne ? 2 : 1);
      expect(firsts(after)).toEqual(firsts(before).filter((id) => id !== blocks[at].id));
    }
  });

  it("changes only the chunk a block is added to, or the one it starts", () => {
    const blocks = ids(2000);
    const before = chunkBlocks(blocks);
    for (const added of ids(200, 10_000)) {
      const after = chunkBlocks([...blocks.slice(0, 700), added, ...blocks.slice(700)]);
      expect(notIn(before, after)).toHaveLength(1);
      expect(notIn(after, before)).toHaveLength(firsts(after).includes(added.id) ? 2 : 1);
    }
  });
});

describe("A long transcript", { timeout: 20_000 }, () => {
  it("re-renders only the streaming reply's chunk on a streamed delta, and keeps every other message's element", () => {
    const { items, sideQuestions } = longChat(400);
    const { show } = pane(chatOf(items, { running: true, sideQuestions }));
    expect(document.querySelectorAll(".transcript-chunk").length).toBeGreaterThan(10);
    const live = document.querySelector('[data-item="a-399"]')!;
    const liveChunkPairs = within(live.closest<HTMLElement>(".transcript-chunk")!)
      .queryAllByRole("article")
      .map((p) => p.getAttribute("aria-label"));
    const before = messages();
    sideRenders.length = 0;

    const grown = items.map((i) => (i.id === "a-399" ? { ...i, text: "Answer 399, and more" } : i));
    show(chatOf(grown, { running: true, sideQuestions }));

    expect(document.querySelector('[data-item="a-399"]')?.textContent).toContain("Answer 399, and more");
    expect(remounted(before, messages())).toEqual([]);
    expect(sideRenders).toEqual(liveChunkPairs);
    expect(sideRenders.length).toBeLessThan(sideQuestions.length);
  });

  it("keeps every other message's element when a side question in the middle is dismissed", () => {
    const { items, sideQuestions } = longChat(400);
    const { dismissed, show } = pane(chatOf(items, { sideQuestions }));
    const gone = screen.getByRole("article", { name: "Side question: Aside 205?" });
    const before = [...messages(), ...pairs().filter((p) => p !== gone)];

    fireEvent.click(within(gone).getByRole("button", { name: "Dismiss side question" }));
    expect(dismissed).toEqual(["btw-205"]);
    show(chatOf(items, { sideQuestions: sideQuestions.filter((q) => q.id !== "btw-205") }));

    expect(gone.isConnected).toBe(false);
    expect(remounted(before, [...messages(), ...pairs()])).toEqual([]);
  });

  it("shows the streaming cursor when a side question asked after the reply starts a chunk of its own", () => {
    const n = Array.from({ length: 1000 }, (_, i) => i).find((i) => chunkBlocks([{ id: "a-0" }, { id: `btw-${i}` }]).length === 2);
    const items: Item[] = [
      { kind: "user", id: "u-0", text: "Run the backup" },
      { kind: "assistant", id: "a-0", text: "Running restic" },
    ];
    pane(chatOf(items, { running: true, sideQuestions: [{ id: `btw-${n}`, question: "Which repo?", after: "a-0", state: "asking" }] }));
    expect(document.querySelectorAll(".transcript-chunk")).toHaveLength(2);
    expect(document.querySelector('[data-item="a-0"] .cursor')).not.toBeNull();
  });

  it("counts find matches in every chunk", () => {
    const { items } = longChat(300);
    pane(chatOf(items), { query: "question", at: 1 });
    expect(screen.getByText("1 of 300")).toBeTruthy();
  });
});
