// @vitest-environment jsdom
// The chat list writes a chat's age in the interface's language (#353): "5m" in English, "5min" in Spanish. The age
// moves on by itself, with nothing else changing (#420).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Chat } from "../hermes/model";
import { LocaleContext, localeFor, type LanguageId } from "../i18n/locale";
import { AGE_TICK_MS } from "./bits";
import { ChatList } from "./Sidebar";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function shown(language: LanguageId, updatedAt = Date.now() - 5 * 60_000 - 5_000) {
  const chat: Chat = { id: "c1", title: "Trip plans", source: "app", settled: false, updatedAt, items: [] };
  render(
    <LocaleContext value={localeFor(language, [])}>
      <ChatList
        profile="default"
        status="connected"
        others={{ byName: {} }}
        chats={[chat]}
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
      />
    </LocaleContext>,
  );
  return screen.getByText("Trip plans").closest(".row-open")!.querySelector(".row-meta")!.textContent;
}

it("writes a chat's age in English as it always has", () => {
  expect(shown("en")).toBe("5m");
});

it("writes a chat's age in Spanish", () => {
  expect(shown("es")).toBe("5min");
});

it("moves a chat's age on from now to 1m to 2m with nothing else changing", () => {
  vi.useFakeTimers();
  try {
    expect(shown("en", Date.now())).toBe("now");
    const age = () => screen.getByText("Trip plans").closest(".row-open")!.querySelector(".row-meta")!.textContent;
    act(() => vi.advanceTimersByTime(AGE_TICK_MS));
    expect(age()).toBe("1m");
    act(() => vi.advanceTimersByTime(AGE_TICK_MS));
    expect(age()).toBe("2m");
  } finally {
    vi.useRealTimers();
  }
});
