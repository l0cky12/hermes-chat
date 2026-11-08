// @ts-expect-error The app has no Node types; the tests run in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom fires synthetic drag events whatever the window's settings, so what the real webviews do is checked here.
const read = (name: string) => JSON.parse(readFileSync(`src-tauri/${name}`, "utf8")).app.windows as Record<string, unknown>[];

describe("The app's windows", () => {
  it("turn Tauri's native drop handler off on Windows, where it takes every drag from the page", () => {
    const windows = read("tauri.windows.conf.json");
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows)
      expect(w.dragDropEnabled, `${w.title}: on Windows the native handler stops chats being dropped on a tab strip or pane`).toBe(false);
  });

  it("keep it on elsewhere, where it is the only way a dropped file arrives", () => {
    for (const w of read("tauri.conf.json"))
      expect(w.dragDropEnabled, `${w.title}: WebKitGTK gives an HTML5 drop from another app no files`).not.toBe(false);
  });

  it("are the same on Windows apart from that, since the Windows file replaces the whole list", () => {
    const strip = ({ dragDropEnabled: _, ...rest }: Record<string, unknown>) => rest;
    expect(read("tauri.windows.conf.json").map(strip)).toEqual(read("tauri.conf.json").map(strip));
  });
});
