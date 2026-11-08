// Keyboard shortcuts the owner sets, like the screenshot shortcut: how a key press is written down
// (`Ctrl+Shift+S`), and which ones would clash with typing, with Hermes Chat's own shortcuts, or with the desktop.
// The owner's choice is kept in the display preferences (uiPrefs.ts), which also check a stored one's shape.
import { DEFAULT_UI_PREFS } from "../hermes/uiPrefs";
import { COMMANDS, COMMAND_IDS, getBindings, screenshotChord, type Bindings } from "./keybindings";

export const DEFAULT_SCREENSHOT_SHORTCUT = DEFAULT_UI_PREFS.screenshotShortcut!;

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const OTHER_KEYS = ["PrintScreen", "Pause", "ScrollLock", "Insert"];

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * The key a press is for, as a shortcut names it: a letter (by its label on the owner's layout), a digit, F1–F24 or
 * one of a few others. Undefined for a modifier alone or a key a shortcut can't use. The key typed comes first, since
 * virtual keyboards, remappers and some input methods report no usable `code`; the key's position is the fallback, for
 * a layout or modifier that types something else there (a Cyrillic letter, or ß for Alt+S).
 */
function keyOf(e: KeyLike): string | undefined {
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  const position = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
  if (position) return position[1] ?? position[2];
  const fKey = [e.key, e.code].find((k) => /^F(?:[1-9]|1\d|2[0-4])$/.test(k));
  if (fKey) return fKey;
  if (e.key === "Print" || e.key === "PrintScreen" || e.code === "PrintScreen") return "PrintScreen";
  return [e.key, e.code].find((k) => OTHER_KEYS.includes(k));
}

/** A key press as a shortcut, or undefined while only modifiers are down or for a key a shortcut can't use. */
export function shortcutOf(e: KeyLike): string | undefined {
  const key = keyOf(e);
  if (!key) return undefined;
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Super: e.metaKey };
  return [...MODIFIERS.filter((m) => held[m]), key].join("+");
}

/** Whether a press is only modifiers, so a recorder keeps waiting for the key. */
export const onlyModifiers = (e: Pick<KeyboardEvent, "key">) => ["Control", "Shift", "Alt", "Meta", "Super", "Hyper", "OS", "AltGraph"].includes(e.key);

/** How a shortcut is shown: `Ctrl+Shift+S`, `Super+Print Screen`. */
export const shortcutLabel = (s: string) => s.replace("PrintScreen", "Print Screen").replace("ScrollLock", "Scroll Lock");

/** Ctrl shortcuts for editing text in the composer. */
const EDIT_KEYS: Record<string, string> = { A: "selects all text", C: "copies", V: "pastes", X: "cuts", Z: "undoes", Y: "redoes" };

/**
 * What's wrong with a shortcut. `error`: it can't be used, and why. `warning`: it can be, but the desktop may take the
 * press before Hermes Chat sees it. `bindings`: the app's own shortcuts as they are now (keybindings.ts), where Super
 * counts as Ctrl; a chord one of them uses is refused, and one a command gave up is free.
 */
export function checkShortcut(s: string, bindings: Bindings = getBindings()): { error?: string; warning?: string } {
  const parts = s.split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const label = shortcutLabel(s);
  if (/^[A-Z0-9]$/.test(key) && !mods.has("Ctrl") && !mods.has("Alt") && !mods.has("Super"))
    return { error: "Add Ctrl, Alt or Super, so typing that key doesn't take a screenshot." };
  const chord = screenshotChord(s);
  const taken = chord && COMMAND_IDS.find((id) => bindings[id].includes(chord));
  if (taken) return { error: `${label} already runs ${COMMANDS[taken].title} in Hermes Chat (Settings → Keyboard Shortcuts).` };
  if (mods.has("Ctrl") && !mods.has("Alt") && !mods.has("Super") && EDIT_KEYS[key])
    return { error: `${label} ${EDIT_KEYS[key]} while you type. Pick another shortcut.` };
  if (mods.has("Ctrl") && mods.has("Alt") && /^F(?:[1-9]|1[0-2])$/.test(key)) return { error: `${label} switches to a text console on Linux.` };
  if (mods.has("Alt") && key === "F4") return { error: `${label} closes the window on most desktops.` };
  if (key === "PrintScreen")
    return { warning: "Print Screen is usually your desktop's own screenshot key, so Hermes Chat may never see it. If pressing it does nothing here, pick another." };
  if (mods.has("Super"))
    return { warning: "Desktops often keep Super shortcuts for themselves. If pressing it does nothing here, pick another." };
  return {};
}
