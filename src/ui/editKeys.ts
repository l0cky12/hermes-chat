// Undo and redo keys. WebKitGTK, the webview on Linux, binds no key to undo or redo, so the app wires them itself
// (ADR 0095): the composer and the Artifact editor step their own histories, and every other text field steps the
// webview's.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EditKind } from "../hermes/editHistory";
import { composing } from "./bits";

export type EditStep = "undo" | "redo";

export function editStep(e: KeyboardEvent | ReactKeyboardEvent): EditStep | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return undefined;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return undefined;
}

// Every other input takes typed text, dates and times included.
const NOT_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

export function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !NOT_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable === true;
}

const TYPING = new Set([
  "insertText",
  "insertLineBreak",
  "insertCompositionText",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
]);

// The inputs whose text the webview's history holds. A date or time input is a text field for Ctrl+Z, but has none.
const HISTORY_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

// Only WebKitGTK lacks the keys. WebView2 binds them, and its own undo fires the beforeinput the guard below cancels;
// an execCommand undo there fires none, and stepped the composer from an empty Search field (#301).
const LINUX = /linux/i;

const keepsWebviewHistory = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && HISTORY_INPUTS.has(target.type)) ||
  (target instanceof HTMLElement && target.isContentEditable === true);

/** How an `input` event changed a text: typing joins the undo step under way; a cut, paste or drop is its own. */
export const inputKind = (e: Event): EditKind => (e instanceof InputEvent && TYPING.has(e.inputType) ? "typing" : "change");

/** Where the caret goes after an undo or redo turned `before` into `after`: the end of the part that changed. */
export function caretAfter(before: string, after: string): number {
  const shorter = Math.min(before.length, after.length);
  let same = 0;
  while (same < shorter && before[same] === after[same]) same++;
  let tail = 0;
  while (tail < shorter - same && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return after.length - tail;
}

/**
 * Undo or redo in a text field, which the window runs (`followEditKeys`): a dialog that keeps the app's shortcuts from
 * reaching past it lets this through.
 */
export const isTextEdit = (e: KeyboardEvent | ReactKeyboardEvent): boolean => !!editStep(e) && isTextField(e.target);

/**
 * Undo and redo in every text field that keeps no history of its own, through the webview's history: on the window,
 * for the life of the app, so the sign-in screen has it too. A field with its own history (the composer, the Artifact
 * editor) takes the key first, and the terminal keeps every key from the window (Terminal.tsx).
 */
export function followEditKeys(): void {
  window.addEventListener("keydown", (e) => {
    const step = editStep(e);
    if (!step || e.defaultPrevented || composing(e) || !keepsWebviewHistory(e.target) || !LINUX.test(navigator.userAgent)) return;
    e.preventDefault();
    document.execCommand(step);
  });
  // The webview's history is the page's, not the field's: with nothing left to undo in the focused field, its undo
  // steps whichever field changed last, the composer included. Only the focused field is stepped.
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      if (e.target instanceof Node && document.activeElement?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}
