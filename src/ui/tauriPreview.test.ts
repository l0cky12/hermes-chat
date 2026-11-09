// The Preview's native page view as the pane drives it through Tauri (ADR 0081): Rust gets the view's commands in
// the order the pane made them, whatever order their answers would come back in.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = () => {};
  },
}));
import { tauriNativePages } from "./tauriPreview";
import type { ViewUrl } from "../hermes/preview";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => invoke.mockReset());

describe("The native page view's commands", () => {
  it("reach Rust one at a time, in order, though an earlier one is slow or fails", async () => {
    const answers: (() => void)[] = [];
    invoke.mockImplementation((command: string) =>
      command === "preview_page_open" && answers.length === 0
        ? new Promise<void>((_, fail) => answers.push(() => fail(new Error("no window"))))
        : Promise.resolve(),
    );
    const failed: unknown[] = [];
    const first = tauriNativePages.open((e) => failed.push(e));
    first.go("https://www.google.com/" as ViewUrl);
    first.place({ rect: { x: 800, y: 137, width: 480, height: 683 }, holes: [] });
    first.reload();
    first.close();
    const second = tauriNativePages.open(() => {});
    second.go("https://example.com/" as ViewUrl);
    second.close();
    await flush();
    // The first open hasn't answered: nothing after it has been sent.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(["preview_page_open"]);

    answers[0]();
    await flush();
    expect(invoke.mock.calls.map(([c, a]) => [c, (a as { url?: string }).url ?? ""])).toEqual([
      ["preview_page_open", ""],
      ["preview_page_go", "https://www.google.com/"],
      ["preview_page_place", ""],
      ["preview_page_reload", ""],
      ["preview_page_close", ""],
      ["preview_page_open", ""],
      ["preview_page_go", "https://example.com/"],
      ["preview_page_close", ""],
    ]);
    const keys = invoke.mock.calls.map(([, a]) => (a as { key: string }).key);
    expect(new Set(keys.slice(0, 5)).size).toBe(1);
    expect(keys[5]).not.toBe(keys[0]);
    expect(new Set(keys.slice(5)).size).toBe(1);
    expect(failed).toEqual([{ kind: "failed", message: "Error: no window" }]);
  });
});
