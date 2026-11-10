// @vitest-environment jsdom
// A reply streaming in one chat redraws that chat's row, not the whole list, while every row still acts on the
// list's latest props and redraws its age as time passes.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Chat } from "../hermes/model";
import { LocaleContext, localeFor, type Locale } from "../i18n/locale";
import { ChatList } from "./Sidebar";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

const english = localeFor("en", []);
let agesWritten = 0;
const counting: Locale = { ...english, fmt: { ...english.fmt, age: (ms, now) => (agesWritten++, english.fmt.age(ms, now)) } };

const chats = (n: number): Chat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, source: "app", settled: false, updatedAt: Date.now() - (i + 5) * 60_000, items: [] }));

type Props = Partial<ComponentProps<typeof ChatList>> & { chats: Chat[] };
// As App.tsx renders it: fresh callbacks and per-chat objects on every render.
const list = (p: Props) => (
  <LocaleContext value={counting}>
    <ChatList
      profile="default"
      status="connected"
      others={{ byName: {} }}
      selectedId={null}
      onOpen={() => {}}
      onSettle={() => {}}
      onArchive={() => {}}
      onDelete={() => {}}
      onRename={async () => {}}
      onRegenTitle={async () => {}}
      onListProfiles={async () => ["default"]}
      onCheckOthers={() => {}}
      onSwitchProfile={() => {}}
      onRetrySwitch={() => {}}
      onPin={() => {}}
      onSnooze={() => {}}
      onWake={() => {}}
      tagsOf={() => ({ list: [{ id: "t1", name: "infra" }], of: [], onToggle: () => {}, onManage: () => {} })}
      {...p}
    />
  </LocaleContext>
);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!;

it("redraws only the chat that changed when the list renders again", () => {
  const before = chats(50);
  const { rerender } = render(list({ chats: before }));
  agesWritten = 0;
  const after = before.map((c) => (c.id === "c3" ? { ...c, title: "Renamed" } : c));
  rerender(list({ chats: after }));
  expect(rowOf("c3").textContent).toContain("Renamed");
  expect(agesWritten).toBe(1);
});

it("calls the list's latest callbacks from a row that skipped a render", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const toggled = vi.fn();
  const shown = chats(3);
  const { rerender } = render(list({ chats: shown, onOpen: first }));
  rerender(
    list({
      chats: shown,
      onOpen: latest,
      tagsOf: (id) => ({ list: [{ id: "t1", name: "infra" }], of: [], onToggle: (tag, on) => toggled(id, tag, on), onManage: () => {} }),
    }),
  );
  fireEvent.click(rowOf("c1"));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith("c1");
  fireEvent.contextMenu(rowOf("c2"), { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /infra/ }));
  expect(toggled).toHaveBeenCalledWith("c2", "t1", true);
});

it("shows a tag put on meanwhile in a menu that is open", () => {
  const shown = chats(3);
  const tagged = (of: string[]) => () => ({ list: [{ id: "t1", name: "infra" }], of, onToggle: () => {}, onManage: () => {} });
  const { rerender } = render(list({ chats: shown, tagsOf: tagged([]) }));
  fireEvent.contextMenu(rowOf("c0"), { clientX: 10, clientY: 10 });
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitemcheckbox", { name: /infra/ }).getAttribute("aria-checked")).toBe("false");
  rerender(list({ chats: shown, tagsOf: tagged(["t1"]) }));
  expect(within(menu).getByRole("menuitemcheckbox", { name: /infra/ }).getAttribute("aria-checked")).toBe("true");
});

it("redraws a chat's age when the list renders again minutes later", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const shown = chats(1);
  const { rerender } = render(list({ chats: shown }));
  expect(rowOf("c0").querySelector(".row-meta")!.textContent).toBe("5m");
  vi.setSystemTime(Date.now() + 2 * 60_000);
  rerender(list({ chats: shown }));
  expect(rowOf("c0").querySelector(".row-meta")!.textContent).toBe("7m");
});
