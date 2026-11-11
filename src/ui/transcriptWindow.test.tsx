// @vitest-environment jsdom
// A long transcript keeps only the chunks near the view in the DOM (ADR 0138). jsdom lays nothing out, so these give
// the transcript the sizes a browser would: a 600 px view, blocks stacked with the stylesheet's gaps.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ChatPane, type FindTarget, type JumpTarget } from "./ChatPane";
import { useShowInChat } from "./showInChat";
import { chunkBlocks } from "./transcriptChunks";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const VIEW = 600;
const GAP = 22;
/** Each block's height by its item id; a test may make some taller. */
let blockHeight = (_id: string) => 100;

const scrollerOf = (el: Element) => el.closest<HTMLElement>(".transcript");
const heightOf = (el: Element): number => {
  if (el.classList.contains("transcript-gap")) return parseFloat((el as HTMLElement).style.height);
  if (el.classList.contains("transcript-chunk"))
    return [...el.children].reduce((h, c) => h + heightOf(c), 0) + (el.children.length - 1) * GAP;
  if (el.parentElement?.classList.contains("transcript-chunk")) return blockHeight(el.closest<HTMLElement>("[data-item]")?.dataset.item ?? "");
  return 20;
};
/** Where `el` starts in the transcript's content: the top of the block or chunk that holds it. */
const topOf = (el: Element): number => {
  const parent = el.parentElement!;
  const stacked = parent.classList.contains("transcript-inner") || parent.classList.contains("transcript-chunk");
  if (!stacked) return topOf(parent);
  const start = parent.classList.contains("transcript-inner") ? 28 : topOf(parent);
  let y = start;
  for (const sibling of parent.children) {
    if (sibling === el) break;
    y += heightOf(sibling) + GAP;
  }
  return y;
};
const contentHeight = (scroller: Element) => {
  const last = scroller.querySelector(".transcript-inner")?.lastElementChild;
  return last ? topOf(last) + heightOf(last) + 56 : 0;
};

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  const scrollTops = new WeakMap<Element, number>();
  const isScroller = (el: Element) => el.classList.contains("transcript");
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { get(this: HTMLElement) { return isScroller(this) ? VIEW : 0; } },
    clientWidth: { get(this: HTMLElement) { return isScroller(this) ? 800 : 0; } },
    scrollHeight: { get(this: HTMLElement) { return isScroller(this) ? contentHeight(this) : 0; } },
    scrollTop: {
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, y: number) { scrollTops.set(this, Math.max(0, Math.min(y, contentHeight(this) - VIEW))); },
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const scroller = scrollerOf(this);
    const inside = scroller && scroller !== this;
    const top = inside ? topOf(this) - scroller.scrollTop : 0;
    const height = inside ? heightOf(this) : VIEW;
    return { top, height, bottom: top + height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) };
  };
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, how?: ScrollIntoViewOptions) {
    const scroller = scrollerOf(this);
    if (!scroller) return;
    scroller.scrollTop = topOf(this) - (how?.block === "center" ? (VIEW - heightOf(this)) / 2 : 0);
    fireEvent.scroll(scroller);
  };
});
afterEach(() => {
  cleanup();
  blockHeight = () => 100;
});

const chatOf = (items: Item[], over: Partial<Chat> = {}): Chat => ({ id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, ...over });

/** `turns` turns of the owner's message and its reply, each stored a second after the one before. */
function longChat(turns: number) {
  const items: Item[] = [];
  for (let t = 0; t < turns; t++)
    items.push(
      { kind: "user", id: `u-${t}`, text: `Question ${t}`, rowId: 2 * t, at: 2000 * t },
      { kind: "assistant", id: `a-${t}`, text: `Answer ${t}`, rowId: 2 * t + 1, at: 2000 * t + 1000 },
    );
  return items;
}

function ShowButton({ at }: { at: number }) {
  const show = useShowInChat();
  return <button onClick={() => show?.(at)}>Show in chat</button>;
}

type Over = { chat?: Chat; findTarget?: FindTarget; jumpTo?: JumpTarget; showAt?: number; reveal?: { itemId?: string; approval: boolean } };

function pane(chat: Chat, over: Over = {}) {
  const onJumpMissed = vi.fn();
  const view = (over: Over) => (
    <ChatPane
      chat={over.chat ?? chat}
      findTarget={over.findTarget}
      jumpTo={over.jumpTo}
      reveal={over.reveal}
      onJumpMissed={onJumpMissed}
      footer={over.showAt === undefined ? undefined : <ShowButton at={over.showAt} />}
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
    />
  );
  const { rerender } = render(view(over));
  return { onJumpMissed, scroller: document.querySelector<HTMLElement>(".transcript")!, again: (over: Over) => rerender(view(over)) };
}

const item = (id: string) => document.querySelector<HTMLElement>(`[data-item="${id}"]`);
const messages = () => [...document.querySelectorAll<HTMLElement>(".msg[data-item]")];
const gaps = () => document.querySelectorAll(".transcript-gap");
const inView = (el: HTMLElement) => el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < VIEW;
/** Scrolls as a wheel does, and waits for the frame in which the transcript takes note of it. */
async function scrollTo(scroller: HTMLElement, y: number) {
  await act(async () => {
    scroller.scrollTop = y;
    fireEvent.scroll(scroller);
    await new Promise((r) => setTimeout(r, 40));
  });
}

describe("A long transcript's window", { timeout: 30_000 }, () => {
  it("renders only the chunks near the bottom when a long chat opens", () => {
    const { scroller } = pane(chatOf(longChat(400)));
    expect(inView(item("a-399")!)).toBe(true);
    expect(item("u-0")).toBeNull();
    expect(messages().length).toBeLessThan(400);
    expect(gaps()).toHaveLength(1);
    // The spacer stands in for the chunks left out, so the chat is as tall as it would be whole.
    const whole = 28 + 800 * 100 + 799 * GAP + 56;
    expect(Math.abs(scroller.scrollHeight - whole)).toBeLessThan(whole / 100);
  });

  it("renders the top chunks once the view is scrolled there", async () => {
    const { scroller } = pane(chatOf(longChat(400)));
    await scrollTo(scroller, 0);
    expect(inView(item("u-0")!)).toBe(true);
    expect(item("a-399")).toBeNull();
    expect(gaps()).toHaveLength(1);
  });

  it("keeps what is in view where it was when a chunk above isn't the height it was taken for", async () => {
    blockHeight = (id) => (Number(id.slice(2)) < 330 ? 260 : 100);
    const { scroller } = pane(chatOf(longChat(400)));
    let mounted = messages().length;
    let windows = 0;
    for (let step = 0; step < 60; step++) {
      const watched = messages().find((m) => m.getBoundingClientRect().top >= 0)!;
      const was = watched.getBoundingClientRect().top;
      await scrollTo(scroller, scroller.scrollTop - 400);
      expect(watched.isConnected).toBe(true);
      expect(watched.getBoundingClientRect().top).toBe(was + 400);
      if (messages().length !== mounted) windows++;
      mounted = messages().length;
    }
    expect(windows).toBeGreaterThan(1);
    expect(item("u-329")).not.toBeNull();
  });

  it("goes to a message far from the view, without reporting it missing", async () => {
    const { onJumpMissed, scroller } = pane(chatOf(longChat(400)), { jumpTo: { rowId: 6, at: 1 } });
    const target = item("u-3")!;
    expect(target.classList.contains("jumped")).toBe(true);
    expect(inView(target)).toBe(true);
    expect(onJumpMissed).not.toHaveBeenCalled();
    expect(item("a-399")).toBeNull();
    await scrollTo(scroller, scroller.scrollTop);
    expect(item("u-3")).toBe(target);
  });

  it("goes to a tool call far from the view", () => {
    const items = longChat(400);
    items.splice(8, 0, { kind: "tool", id: "t-1", name: "terminal", status: "done", callId: "call-1" });
    const { onJumpMissed } = pane(chatOf(items), { jumpTo: { callId: "call-1", at: 1 } });
    const row = document.querySelector<HTMLElement>('[data-call="call-1"]')!;
    expect(document.activeElement).toBe(row);
    expect(onJumpMissed).not.toHaveBeenCalled();
  });

  it("reports a message that isn't in the loaded history as missing", () => {
    const { onJumpMissed } = pane(chatOf(longChat(400)), { jumpTo: { rowId: 9000, at: 1 } });
    expect(onJumpMissed).toHaveBeenCalledOnce();
  });

  it("counts the find matches of the whole chat", () => {
    pane(chatOf(longChat(400)), { findTarget: { query: "question", at: 1 } });
    expect(screen.getByText("1 of 400")).toBeTruthy();
    expect(gaps()).toHaveLength(0);
  });

  it("shows a message far from the view from the context inspector", () => {
    pane(chatOf(longChat(400)), { showAt: 6000 });
    expect(item("u-3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in chat" }));
    const target = item("u-3")!;
    expect(target.classList.contains("jumped")).toBe(true);
    expect(inView(target)).toBe(true);
    expect(document.querySelectorAll(".jumped")).toHaveLength(1);
  });

  it("renders the message an Inbox entry is about, far from the view, while the app goes to it", () => {
    pane(chatOf(longChat(400)), { reveal: { itemId: "u-3", approval: false } });
    expect(item("u-3")).not.toBeNull();
  });

  it("renders the waiting Approval an Inbox entry is about after the owner scrolled away from it", async () => {
    const items: Item[] = [...longChat(400), { kind: "approval", id: "ap-1", requestId: "req-1", command: "rm -rf build", description: "Delete the build folder", choices: ["once", "deny"], allowSession: false, allowPermanent: false }];
    const { scroller, again } = pane(chatOf(items));
    await scrollTo(scroller, 0);
    expect(item("ap-1")).toBeNull();
    again({ reveal: { approval: true } });
    expect(document.querySelector(".approval:not(.answered)")).not.toBeNull();
  });

  it("follows a reply streaming at the bottom of a long chat", async () => {
    blockHeight = (id) => (id === "a-live" ? 100 + 40 * reply.length : 100);
    let reply = "";
    const items = [...longChat(400), { kind: "user", id: "u-live", text: "Stream something." } as Item];
    const { scroller, again } = pane(chatOf(items, { running: true }));
    for (let i = 0; i < 30; i++) {
      reply += "word ";
      again({ chat: chatOf([...items, { kind: "assistant", id: "a-live", text: reply }], { running: true }) });
      await scrollTo(scroller, scroller.scrollTop);
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEW);
    }
    expect(inView(item("a-live")!)).toBe(true);
    expect(item("u-0")).toBeNull();
  });

  it("renders a chat of a few chunks whole, however tall", () => {
    const items = longChat(60);
    expect(chunkBlocks(items).length).toBeGreaterThan(1);
    expect(chunkBlocks(items).length).toBeLessThanOrEqual(4);
    pane(chatOf(items));
    expect(messages()).toHaveLength(120);
    expect(gaps()).toHaveLength(0);
  });
});
