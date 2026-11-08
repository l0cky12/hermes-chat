// @vitest-environment jsdom
// The command table: how a key press is written down as a chord, what a stored override may be, which command a press
// is when two share a chord, which bindings clash, and which chords a command refuses.
import { afterEach, describe, expect, it } from "vitest";
import { setUIPrefs } from "../hermes/uiPrefs";
import {
  COMMANDS,
  COMMAND_IDS,
  DEFAULT_BINDINGS,
  ariaKeys,
  bindingsOf,
  checkChord,
  chordLabel,
  chordOf,
  chordParts,
  conflicts,
  isCustom,
  parseChord,
  pick,
  pickApp,
  rebind,
  resetAll,
  resetBinding,
  type Chord,
} from "./keybindings";

afterEach(() => localStorage.clear());

const chord = (s: string) => parseChord(s)!;
const press = (key: string, code = "", mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) =>
  new KeyboardEvent("keydown", { key, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta });

describe("Writing a key press down as a chord", () => {
  it("names modifiers in one order, with Cmd as Ctrl, then the key", () => {
    expect(chordOf(press("k", "KeyK", { ctrl: true }))).toBe("Ctrl+K");
    expect(chordOf(press("k", "KeyK", { meta: true }))).toBe("Ctrl+K");
    expect(chordOf(press("K", "KeyK", { shift: true, alt: true, ctrl: true }))).toBe("Ctrl+Alt+Shift+K");
    expect(chordOf(press("Enter", "Enter", { shift: true }))).toBe("Shift+Enter");
    expect(chordOf(press("Tab", "Tab", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Tab");
    expect(chordOf(press(" ", "Space"))).toBe("Space");
    expect(chordOf(press("F10", "F10", { shift: true }))).toBe("Shift+F10");
    expect(chordOf(press("ContextMenu", "ContextMenu"))).toBe("ContextMenu");
  });

  it("goes by the key's position for a shifted digit, punctuation and another layout's letter", () => {
    expect(chordOf(press("!", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    expect(chordOf(press("|", "Backslash", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+\\");
    expect(chordOf(press("<", "Comma", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+,");
    expect(chordOf(press("ы", "KeyS", { ctrl: true }))).toBe("Ctrl+S");
    // A virtual keyboard reports no position: the key typed is used.
    expect(chordOf(press(",", ""))).toBe(",");
  });

  it("has no chord for a modifier alone, or a key no chord can name", () => {
    expect(chordOf(press("Control", "ControlLeft", { ctrl: true }))).toBeUndefined();
    expect(chordOf(press("Shift", "ShiftLeft", { shift: true }))).toBeUndefined();
    expect(chordOf(press("Dead", "Quote"))).toBe("'");
    expect(chordOf(press("Unidentified", ""))).toBeUndefined();
    expect(chordOf(press("CapsLock", "CapsLock"))).toBeUndefined();
  });

  it("parses only a chord's own shape", () => {
    for (const s of ["Ctrl+K", "Ctrl+Alt+Shift+K", "Shift+Enter", "ArrowUp", "Escape", "Ctrl+,", "Ctrl+\\", "F24", "Ctrl++", "ContextMenu"]) expect(parseChord(s)).toBe(s);
    for (const s of ["", "k", "ctrl+k", "Shift+Ctrl+K", "Ctrl+", "Ctrl+Meta+K", "Ctrl+KK", "Ctrl + K", "Ctrl+F25", 7, null, ["Ctrl+K"]]) expect(parseChord(s)).toBeUndefined();
  });

  it("shows a chord as chips, as a label, and as aria-keyshortcuts", () => {
    expect(chordParts(chord("Ctrl+K"))).toEqual(["Ctrl", "K"]);
    expect(chordParts(chord("Shift+Enter"))).toEqual(["Shift", "Enter"]);
    expect(chordParts(chord("ArrowUp"))).toEqual(["↑"]);
    expect(chordParts(chord("Escape"))).toEqual(["Esc"]);
    expect(chordParts(chord("Ctrl+Shift+PageUp"))).toEqual(["Ctrl", "Shift", "PgUp"]);
    expect(chordParts(chord("Ctrl++"))).toEqual(["Ctrl", "+"]);
    expect(chordLabel(chord("Ctrl+,"))).toBe("Ctrl+,");
    expect(chordLabel(chord("ArrowDown"))).toBe("↓");
    expect(ariaKeys([chord("Ctrl+K")])).toBe("Control+K");
    expect(ariaKeys([chord("Shift+F10"), chord("ContextMenu")])).toBe("Shift+F10 ContextMenu");
  });

  it("has a default for every command that is a chord", () => {
    for (const id of COMMAND_IDS) expect(DEFAULT_BINDINGS[id].length, id).toBeGreaterThan(0);
    expect(DEFAULT_BINDINGS.search).toEqual(["Ctrl+K"]);
    expect(DEFAULT_BINDINGS.findNext).toEqual(["Enter", "ArrowDown"]);
  });
});

describe("Stored overrides", () => {
  it("fall back to the defaults for an unknown command, a string that isn't a chord, or a chord the command refuses", () => {
    const b = bindingsOf({ search: ["Ctrl+J"], gone: ["Ctrl+G"], newChat: ["ctrl+n"], find: ["K"], toggleList: ["Ctrl+Shift+B", "nope", "Ctrl+V"] }, "Ctrl+Shift+S");
    expect(b.search).toEqual(["Ctrl+J"]);
    expect(b.newChat).toEqual(DEFAULT_BINDINGS.newChat);
    expect(b.find).toEqual(DEFAULT_BINDINGS.find);
    expect(b.toggleList).toEqual(["Ctrl+Shift+B"]);
    expect(Object.keys(b)).toEqual(COMMAND_IDS);
    expect(isCustom(b, "search")).toBe(true);
    expect(isCustom(b, "newChat")).toBe(false);
  });

  it("never put a bare key, or the screenshot shortcut, on an app-wide command", () => {
    const b = bindingsOf({ search: ["J"], newChat: ["Shift+N"], settings: ["Ctrl+Shift+S"] }, "Ctrl+Shift+S");
    expect(b.search).toEqual(["Ctrl+K"]);
    expect(b.newChat).toEqual(["Ctrl+N"]);
    expect(b.settings).toEqual(["Ctrl+,"]);
    expect(bindingsOf({ settings: ["Ctrl+Shift+S"] }, null).settings).toEqual(["Ctrl+Shift+S"]);
  });

  it("are written as a diff from the defaults, and a rebind back to the default forgets the override", () => {
    rebind("search", chord("Ctrl+J"));
    rebind("newChat", chord("Ctrl+N"));
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).keybindings).toEqual({ search: ["Ctrl+J"] });
    rebind("search", chord("Ctrl+K"));
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).keybindings).toEqual({});
    rebind("search", chord("Ctrl+J"));
    rebind("find", chord("Ctrl+G"));
    resetBinding("search");
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).keybindings).toEqual({ find: ["Ctrl+G"] });
    resetAll();
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).keybindings).toEqual({});
  });
});

describe("Which command a key press is", () => {
  it("is the one whose chord matches exactly: extra modifiers match nothing", () => {
    expect(pickApp(press("k", "KeyK", { ctrl: true }))).toBe("search");
    expect(pickApp(press("k", "KeyK", { meta: true }))).toBe("search");
    expect(pickApp(press("k", "KeyK", { ctrl: true, shift: true }))).toBeUndefined();
    expect(pickApp(press("k", "KeyK"))).toBeUndefined();
    expect(pickApp(press("Tab", "Tab", { ctrl: true }))).toBe("nextTab");
    expect(pickApp(press("Tab", "Tab", { ctrl: true, shift: true }))).toBe("prevTab");
    expect(pick(press("Enter", "Enter"), "composer")).toBe("send");
    expect(pick(press("Enter", "Enter", { shift: true }), "composer")).toBe("newLine");
    expect(pick(press("Enter", "Enter", { alt: true }), "composer")).toBeUndefined();
    expect(pick(press("Enter", "Enter"), "find")).toBe("findNext");
    expect(pick(press("Enter", "Enter"), "app")).toBeUndefined();
  });

  it("is never one while an IME composes", () => {
    const e = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, isComposing: true });
    expect(pickApp(e)).toBeUndefined();
  });

  it("follows a rebind at once, and the old chord then does nothing", () => {
    setUIPrefs({ keybindings: { search: ["Ctrl+J"] } });
    expect(pickApp(press("j", "KeyJ", { ctrl: true }))).toBe("search");
    expect(pickApp(press("k", "KeyK", { ctrl: true }))).toBeUndefined();
  });

  it("prefers the command the owner changed when two share a chord, then the first in the table", () => {
    setUIPrefs({ keybindings: { toggleList: ["Ctrl+K"] } });
    expect(pickApp(press("k", "KeyK", { ctrl: true }))).toBe("toggleList");
    setUIPrefs({ keybindings: { toggleList: ["Ctrl+Shift+K"], search: ["Ctrl+Shift+K"] } });
    expect(pickApp(press("k", "KeyK", { ctrl: true, shift: true }))).toBe("search");
    setUIPrefs({ keybindings: { rowDelete: ["ArrowDown"] } });
    expect(pick(press("ArrowDown", "ArrowDown"), "chatRow")).toBe("rowDelete");
  });
});

describe("Bindings that clash", () => {
  it("are two with one chord in the same scope, or one of them app-wide; different local scopes don't", () => {
    expect(conflicts(DEFAULT_BINDINGS, "Ctrl+Shift+S")).toEqual(new Map());
    const b = bindingsOf({ toggleList: ["Ctrl+K"], findNext: ["Ctrl+Enter"], paletteClose: ["Ctrl+B"] }, "Ctrl+Shift+S");
    expect(conflicts(b, "Ctrl+Shift+S")).toEqual(
      new Map([
        ["search", [COMMANDS.toggleList.title]],
        ["toggleList", [COMMANDS.search.title]],
      ]),
    );
    expect(conflicts(bindingsOf({ findNext: ["Ctrl+Enter"] }, null), null)).toEqual(new Map());
  });

  it("include the screenshot shortcut, with Super read as Ctrl", () => {
    const b = bindingsOf({ send: ["Ctrl+S"] }, null);
    expect(conflicts(b, "Super+S")).toEqual(new Map([["send", ["the screenshot shortcut"]]]));
  });
});

describe("Chords a command refuses", () => {
  const ok = (id: keyof typeof COMMANDS, s: string) => checkChord(id, chord(s), "Ctrl+Shift+S");

  it("a printable key without Ctrl or Alt, which typing would set off", () => {
    expect(ok("send", "K")).toMatch(/Typing K would run it/);
    expect(ok("send", "Shift+K")).toMatch(/Typing Shift\+K/);
    expect(ok("send", "Space")).toMatch(/Typing Space/);
    expect(ok("send", "Ctrl+Shift+K")).toBeUndefined();
    expect(ok("send", "Alt+Enter")).toBeUndefined();
  });

  it("a bare key on an app-wide command, unless it's a function key", () => {
    expect(ok("search", "Enter")).toMatch(/needs Ctrl or Alt/);
    expect(ok("search", "Shift+Escape")).toMatch(/needs Ctrl or Alt/);
    expect(ok("search", "F9")).toBeUndefined();
    expect(ok("search", "Shift+F10")).toBeUndefined();
    expect(ok("findClose", "Escape")).toBeUndefined();
  });

  it("Tab and Shift+Tab, editing keys, and the desktop's own", () => {
    expect(ok("findNext", "Tab")).toMatch(/moves between controls/);
    expect(ok("findNext", "Shift+Tab")).toMatch(/moves between controls/);
    expect(ok("nextTab", "Ctrl+Tab")).toBeUndefined();
    expect(ok("search", "Ctrl+V")).toMatch(/pastes while you type/);
    expect(ok("search", "Ctrl+Shift+Z")).toMatch(/undoes/);
    expect(ok("search", "Ctrl+Y")).toMatch(/redoes/);
    expect(ok("search", "Ctrl+Shift+V")).toBeUndefined();
    expect(ok("search", "Ctrl+Alt+C")).toBeUndefined();
    expect(ok("search", "Ctrl+Alt+F2")).toMatch(/text console/);
    expect(ok("search", "Alt+F4")).toMatch(/closes the window/);
  });

  it("the screenshot shortcut as it is now", () => {
    expect(ok("search", "Ctrl+Shift+S")).toMatch(/screenshot shortcut/);
    expect(checkChord("search", chord("Ctrl+Shift+S"), "Super+Shift+S")).toMatch(/screenshot shortcut/);
    expect(checkChord("search", chord("Ctrl+Shift+S"), null)).toBeUndefined();
  });

  it("never a clash with another command, which is saved and warned about", () => {
    expect(ok("toggleList", "Ctrl+K")).toBeUndefined();
    const c: Chord = chord("Ctrl+K");
    expect(c).toBe("Ctrl+K");
  });
});
