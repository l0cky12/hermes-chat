// @vitest-environment jsdom
// The page gives up the height the Windows touch keyboard covers (touchKeyboard.ts, ADR 0103).
import { afterEach, describe, expect, it, vi } from "vitest";

const rust = vi.hoisted(() => ({
  covered: 0,
  handlers: new Map<string, (e: { payload: { covered: number } }) => void>(),
  beforeAnswer: undefined as undefined | (() => void),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, fn: (e: { payload: { covered: number } }) => void) => {
    rust.handlers.set(event, fn);
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command !== "touch_keyboard_covered") throw new Error(`unexpected command ${command}`);
    rust.beforeAnswer?.();
    return rust.covered;
  },
}));

import { followTouchKeyboard } from "./touchKeyboard";

const cover = () => document.documentElement.style.getPropertyValue("--touch-keyboard");
const send = (covered: number) => rust.handlers.get("touch-keyboard")!({ payload: { covered } });

afterEach(() => {
  document.documentElement.removeAttribute("style");
  rust.covered = 0;
  rust.handlers.clear();
  rust.beforeAnswer = undefined;
});

describe("The touch keyboard over the window", () => {
  it("shortens the page by what the keyboard covers, and gives it all back once it doesn't", async () => {
    await followTouchKeyboard();
    expect(cover()).toBe("");
    send(226);
    expect(cover()).toBe("226px");
    send(180.5);
    expect(cover()).toBe("180.5px");
    send(0);
    expect(cover()).toBe("");
  });

  it("makes room for a keyboard that was already up when the page started listening", async () => {
    rust.covered = 226;
    await followTouchKeyboard();
    expect(cover()).toBe("226px");
  });

  it("keeps an event that came while asking over the older answer", async () => {
    rust.covered = 226;
    rust.beforeAnswer = () => send(0);
    await followTouchKeyboard();
    expect(cover()).toBe("");
  });
});
