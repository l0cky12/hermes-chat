// @vitest-environment jsdom
// Which keys undo and redo, which fields take them as text undo, and where the caret goes after a step.
import { describe, expect, it } from "vitest";
import { caretAfter, editStep, inputKind, isTextField } from "./editKeys";

const key = (key: string, mods: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, ...mods });

describe("Edit keys", () => {
  it("reads Ctrl+Z as undo, and Ctrl+Shift+Z and Ctrl+Y as redo, with Cmd for Ctrl", () => {
    expect(editStep(key("z", { ctrlKey: true }))).toBe("undo");
    expect(editStep(key("Z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(editStep(key("y", { ctrlKey: true }))).toBe("redo");
    expect(editStep(key("z", { metaKey: true }))).toBe("undo");
    expect(editStep(key("z"))).toBeUndefined();
    expect(editStep(key("z", { ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(editStep(key("x", { ctrlKey: true }))).toBeUndefined();
  });

  it("takes text inputs, textareas and editable content as text fields, and nothing else", () => {
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(isTextField(el("<textarea></textarea>"))).toBe(true);
    expect(isTextField(el("<input>"))).toBe(true);
    expect(isTextField(el('<input type="search">'))).toBe(true);
    expect(isTextField(el('<input type="date">'))).toBe(true);
    expect(isTextField(el('<input type="datetime-local">'))).toBe(true);
    expect(isTextField(el('<input type="time">'))).toBe(true);
    expect(isTextField(el('<input type="checkbox">'))).toBe(false);
    expect(isTextField(el('<input type="range">'))).toBe(false);
    expect(isTextField(el("<button>Undo</button>"))).toBe(false);
    expect(isTextField(document.body)).toBe(false);
  });

  it("counts typing and deleting as typing, and a paste or drop as a change of its own", () => {
    const input = (inputType: string) => new InputEvent("input", { inputType });
    expect(inputKind(input("insertText"))).toBe("typing");
    expect(inputKind(input("deleteContentBackward"))).toBe("typing");
    expect(inputKind(input("insertFromPaste"))).toBe("change");
    expect(inputKind(input("insertFromDrop"))).toBe("change");
    expect(inputKind(new Event("input"))).toBe("change");
  });

  it("puts the caret at the end of the part a step changed", () => {
    expect(caretAfter("hello world", "hello")).toBe(5);
    expect(caretAfter("hello", "hello world")).toBe(11);
    expect(caretAfter("hello world", "hello there world")).toBe(12);
    expect(caretAfter("hello there world", "hello world")).toBe(6);
    expect(caretAfter("aaa", "aaaa")).toBe(4);
    expect(caretAfter("", "")).toBe(0);
  });
});
