// Shortcuts the owner sets: how a key press is written down, and which ones are refused or warned about.
import { describe, expect, it } from "vitest";
import { isShortcut } from "../hermes/uiPrefs";
import { bindingsOf } from "./keybindings";
import { checkShortcut, shortcutLabel, shortcutOf } from "./shortcut";

const press = (key: string, code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe("Writing a key press down", () => {
  it("names modifiers in one order, then the key", () => {
    expect(shortcutOf(press("S", "KeyS", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    expect(shortcutOf(press("s", "KeyS", { meta: true, alt: true, ctrl: true, shift: true }))).toBe("Ctrl+Alt+Shift+Super+S");
    expect(shortcutOf(press("F12", "F12", { alt: true }))).toBe("Alt+F12");
    expect(shortcutOf(press("PrintScreen", "PrintScreen"))).toBe("PrintScreen");
  });

  it("goes by the letter on the owner's layout, and digits by their key", () => {
    // Dvorak: the key where QWERTY has S types O.
    expect(shortcutOf(press("O", "KeyS", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+O");
    // With Shift held, the 1 key types "!".
    expect(shortcutOf(press("!", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    // A layout that gives no letter with Ctrl+Alt falls back to the key's position, as does a Cyrillic layout.
    expect(shortcutOf(press("ß", "KeyS", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+S");
    expect(shortcutOf(press("Ы", "KeyS", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    // A virtual keyboard (wtype, remappers) may give a key with no usable code.
    expect(shortcutOf(press("S", "", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    expect(shortcutOf(press("S", "Unidentified", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    expect(shortcutOf(press("F5", "", {}))).toBe("F5");
  });

  it("has no shortcut for a modifier alone or a key it can't use", () => {
    expect(shortcutOf(press("Control", "ControlLeft", { ctrl: true }))).toBeUndefined();
    expect(shortcutOf(press("Tab", "Tab", { ctrl: true }))).toBeUndefined();
    expect(shortcutOf(press("Enter", "Enter", { ctrl: true }))).toBeUndefined();
  });

  it("writes down only shapes the preferences keep", () => {
    for (const s of ["Ctrl+Shift+S", "Alt+F12", "Ctrl+Alt+Shift+Super+9", "PrintScreen"]) expect(isShortcut(s)).toBe(true);
    expect(shortcutLabel("Super+PrintScreen")).toBe("Super+Print Screen");
  });
});

describe("Shortcuts that clash", () => {
  it("refuses a bare letter or digit, which typing would set off", () => {
    expect(checkShortcut("S").error).toMatch(/Add Ctrl, Alt or Super/);
    expect(checkShortcut("Shift+S").error).toMatch(/Add Ctrl, Alt or Super/);
    expect(checkShortcut("F9")).toEqual({});
  });

  it("refuses Hermes Chat's own shortcuts as they are now, with Super read as Ctrl", () => {
    expect(checkShortcut("Ctrl+K").error).toBe("Ctrl+K already runs Search all chats in Hermes Chat (Settings → Keyboard Shortcuts).");
    expect(checkShortcut("Super+F").error).toMatch(/Find in the chat/);
    expect(checkShortcut("Ctrl+1").error).toMatch(/left/);
    expect(checkShortcut("Super+2").error).toMatch(/right/);
    expect(checkShortcut("Ctrl+Shift+PageUp").error).toMatch(/Move the tab left/);
    expect(checkShortcut("Ctrl+Shift+N")).toEqual({});
    expect(checkShortcut("Ctrl+Alt+B")).toEqual({});
    expect(checkShortcut("Ctrl+Shift+1")).toEqual({});
    const moved = bindingsOf({ search: ["Ctrl+J"] }, null);
    expect(checkShortcut("Ctrl+K", moved)).toEqual({});
    expect(checkShortcut("Ctrl+J", moved).error).toMatch(/Search all chats/);
  });

  it("refuses editing shortcuts and the desktop's own fixed ones", () => {
    expect(checkShortcut("Ctrl+V").error).toMatch(/pastes while you type/);
    expect(checkShortcut("Ctrl+Shift+Z").error).toMatch(/undoes/);
    expect(checkShortcut("Ctrl+Alt+F2").error).toMatch(/text console/);
    expect(checkShortcut("Alt+F4").error).toMatch(/closes the window/);
    // With Alt, Ctrl+C isn't an editing shortcut.
    expect(checkShortcut("Ctrl+Alt+C")).toEqual({});
  });

  it("warns about keys the desktop usually takes for itself", () => {
    expect(checkShortcut("PrintScreen").warning).toMatch(/desktop's own screenshot key/);
    expect(checkShortcut("Super+Shift+S").warning).toMatch(/Super shortcuts/);
    expect(checkShortcut("Ctrl+Shift+S")).toEqual({});
  });
});
