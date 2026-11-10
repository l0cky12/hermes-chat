// @vitest-environment jsdom
// Following the window's visibility from Rust (windowState.ts, ADR 0034).
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The app has no Node types; the tests run in Node. (Vitest empties a CSS import, ?raw included.)
import { readFileSync } from "node:fs";

const rust = vi.hoisted(() => ({
  hidden: false,
  handler: undefined as undefined | ((e: { payload: { hidden: boolean } }) => void),
  beforeAnswer: undefined as undefined | (() => void),
  focused: true,
  onFocus: undefined as undefined | ((e: { payload: boolean }) => void),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: typeof rust.handler) => {
    rust.handler = fn;
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (fn: typeof rust.onFocus) => {
      rust.onFocus = fn;
      return () => {};
    },
    isFocused: async () => rust.focused,
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    rust.beforeAnswer?.();
    return rust.hidden;
  },
}));

import { followWindowFocus, followWindowVisibility, setWindowHidden, useWindowHidden } from "./windowState";
import { renderHook, act } from "@testing-library/react";

afterEach(() => {
  act(() => setWindowHidden(false));
  rust.hidden = false;
  rust.beforeAnswer = undefined;
  document.body.innerHTML = "";
});

describe("The window's visibility", () => {
  it("counts a window hidden before the page started listening as hidden", async () => {
    rust.hidden = true;
    const { result } = renderHook(() => useWindowHidden());
    await act(() => followWindowVisibility());
    expect(result.current).toBe(true);
    act(() => rust.handler!({ payload: { hidden: false } }));
    expect(result.current).toBe(false);
  });

  it("lets an event that came while asking win over the answer", async () => {
    rust.hidden = false;
    rust.beforeAnswer = () => rust.handler!({ payload: { hidden: true } });
    const { result } = renderHook(() => useWindowHidden());
    await act(() => followWindowVisibility());
    expect(result.current).toBe(true);
  });

  it("puts focus back where it was, or in the active pane's composer if that is gone", async () => {
    document.body.innerHTML = `<section class="pane active"><textarea data-composer></textarea></section><input id="search" />`;
    const search = document.getElementById("search")!;
    search.focus();
    setWindowHidden(true);
    search.blur();
    setWindowHidden(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(search));

    setWindowHidden(true);
    search.remove();
    setWindowHidden(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-composer]")));
  });
});

describe("Endless animations", () => {
  const css: string = readFileSync("src/styles.css", "utf8");

  it("pause while the window is unfocused and play again once it has the focus back", async () => {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.append(sheet);
    document.body.innerHTML = `<span class="spinner"></span><span class="conn-dot reconnecting"></span><div class="thinking"><span></span></div>`;
    const states = () => [...document.body.querySelectorAll<HTMLElement>(".spinner, .conn-dot, .thinking span")].map((e) => getComputedStyle(e).animationPlayState);
    try {
      rust.focused = false;
      await followWindowFocus();
      expect(states()).toEqual(["paused", "paused", "paused"]);
      rust.onFocus!({ payload: true });
      expect(states()).not.toContain("paused");
      rust.onFocus!({ payload: false });
      expect(states()).toEqual(["paused", "paused", "paused"]);
    } finally {
      rust.focused = true;
      sheet.remove();
      document.documentElement.removeAttribute("data-unfocused");
    }
  });

  it("are all in the rule that pauses them", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const endless = [...rules.matchAll(/([^{}@]+)\{[^{}]*\binfinite\b[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
    const paused = css.match(/^:root\[data-unfocused\] :is\(([^)]*)\)/m)?.[1].split(",").map((s) => s.trim());
    expect(endless.length).toBeGreaterThan(0);
    expect(new Set(paused)).toEqual(new Set(endless));
  });
});
