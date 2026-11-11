// Every keyboard shortcut of the app, as one table of commands (ADR 0143): each command's title, the Settings group it
// is listed under, the scope its keys work in, the When condition the page shows, and its default chords. The owner's
// overrides live in the display preferences (uiPrefs.ts `keybindings`), as a diff from the defaults, so a later
// version's new default still reaches an owner who never changed that command. Each handler keeps its own guards and
// asks `pick` which of its scope's commands a key press is; there is no central dispatcher. A chord matches only when
// exactly its modifiers are held, so Enter and Shift+Enter, Ctrl+Tab and Ctrl+Shift+Tab, are different commands.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { composing } from "./bits";

declare const chordBrand: unique symbol;
/** A key press written down: modifiers in the order Ctrl, Alt, Shift, then one key, like `Ctrl+Shift+PageUp`. */
export type Chord = string & { readonly [chordBrand]: true };

/** Where a command's keys work. `app`: a window listener, anywhere in the app. The rest: one control's own handler. */
export type Scope = "app" | "composer" | "find" | "palette" | "chatRow" | "rename" | "profileMenu";
export type Group = "chat" | "threads" | "navigation" | "panels" | "approvals";
export const GROUPS: readonly { id: Group; title: string }[] = [
  { id: "chat", title: "Chat / Composer" },
  { id: "threads", title: "Threads / History" },
  { id: "navigation", title: "Navigation" },
  { id: "panels", title: "Sidebar / Panels" },
  { id: "approvals", title: "Approvals / Inbox" },
];

type Command = { title: string; group: Group; scope: Scope; when: string; defaults: readonly string[] };

/** In the order the Settings page lists them, which is also the order a tie between two defaults is broken in. */
export const COMMANDS = {
  send: { title: "Send", group: "chat", scope: "composer", when: "composerFocus", defaults: ["Enter"] },
  sendOther: { title: "Send the other way (queue or steer) while a reply runs", group: "chat", scope: "composer", when: "composerFocus && replyRunning", defaults: ["Ctrl+Enter"] },
  newLine: { title: "New line", group: "chat", scope: "composer", when: "composerFocus", defaults: ["Shift+Enter"] },
  findNext: { title: "Next match", group: "chat", scope: "find", when: "findFocus", defaults: ["Enter", "ArrowDown"] },
  findPrev: { title: "Previous match", group: "chat", scope: "find", when: "findFocus", defaults: ["Shift+Enter", "ArrowUp"] },
  findClose: { title: "Close the find bar", group: "chat", scope: "find", when: "findFocus", defaults: ["Escape"] },
  newChat: { title: "New chat", group: "threads", scope: "app", when: "Always", defaults: ["Ctrl+N"] },
  chatBelow: { title: "Open the chat below", group: "threads", scope: "app", when: "chatOnScreen", defaults: ["Alt+ArrowDown"] },
  chatAbove: { title: "Open the chat above", group: "threads", scope: "app", when: "chatOnScreen", defaults: ["Alt+ArrowUp"] },
  rowDown: { title: "Next chat in the list", group: "threads", scope: "chatRow", when: "chatRowFocus", defaults: ["ArrowDown"] },
  rowUp: { title: "Previous chat in the list", group: "threads", scope: "chatRow", when: "chatRowFocus", defaults: ["ArrowUp"] },
  rowMenu: { title: "Open the chat's menu", group: "threads", scope: "chatRow", when: "chatRowFocus", defaults: ["Shift+F10", "ContextMenu"] },
  rowDelete: { title: "Delete the chat", group: "threads", scope: "chatRow", when: "chatRowFocus && !replyRunning", defaults: ["Delete", "Backspace"] },
  renameSave: { title: "Confirm a rename", group: "threads", scope: "rename", when: "renameFocus", defaults: ["Enter"] },
  renameCancel: { title: "Cancel a rename", group: "threads", scope: "rename", when: "renameFocus", defaults: ["Escape"] },
  search: { title: "Search all chats", group: "navigation", scope: "app", when: "Always", defaults: ["Ctrl+K"] },
  find: { title: "Find in the chat, or in Settings", group: "navigation", scope: "app", when: "chatOpen || settingsOpen", defaults: ["Ctrl+F"] },
  settings: { title: "Open Settings", group: "navigation", scope: "app", when: "Always", defaults: ["Ctrl+,"] },
  toggleList: { title: "Hide or show the chat list", group: "panels", scope: "app", when: "Always", defaults: ["Ctrl+B"] },
  toggleSplit: { title: "Split the chat, or close the split", group: "panels", scope: "app", when: "Always", defaults: ["Ctrl+\\"] },
  focusLeft: { title: "Focus the left (or top) pane", group: "panels", scope: "app", when: "split", defaults: ["Ctrl+1"] },
  focusRight: { title: "Focus the right (or bottom) pane", group: "panels", scope: "app", when: "split", defaults: ["Ctrl+2"] },
  nextTab: { title: "Next tab", group: "panels", scope: "app", when: "chatOnScreen", defaults: ["Ctrl+Tab"] },
  prevTab: { title: "Previous tab", group: "panels", scope: "app", when: "chatOnScreen", defaults: ["Ctrl+Shift+Tab"] },
  moveTabLeft: { title: "Move the tab left", group: "panels", scope: "app", when: "chatOnScreen", defaults: ["Ctrl+Shift+PageUp"] },
  moveTabRight: { title: "Move the tab right", group: "panels", scope: "app", when: "chatOnScreen", defaults: ["Ctrl+Shift+PageDown"] },
  paletteDown: { title: "Next search result", group: "panels", scope: "palette", when: "paletteFocus", defaults: ["ArrowDown"] },
  paletteUp: { title: "Previous search result", group: "panels", scope: "palette", when: "paletteFocus", defaults: ["ArrowUp"] },
  paletteOpen: { title: "Open the search result", group: "panels", scope: "palette", when: "paletteFocus", defaults: ["Enter"] },
  paletteClose: { title: "Close search", group: "panels", scope: "palette", when: "paletteOpen", defaults: ["Escape"] },
  profilePick: { title: "Pick the first matching profile", group: "panels", scope: "profileMenu", when: "profileFilterFocus", defaults: ["Enter"] },
  profileClose: { title: "Close the profile menu", group: "panels", scope: "profileMenu", when: "profileMenuOpen", defaults: ["Escape"] },
} as const satisfies Record<string, Command>;

export type CommandId = keyof typeof COMMANDS;
export const COMMAND_IDS = Object.keys(COMMANDS) as readonly CommandId[];
export const isCommandId = (s: unknown): s is CommandId => typeof s === "string" && Object.hasOwn(COMMANDS, s);

const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
const NAMED_KEYS = ["Enter", "Escape", "Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete", "Backspace", "Insert", "ContextMenu"];
const PUNCTUATION_BY_CODE: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};
const F_KEY = /^F(?:[1-9]|1\d|2[0-4])$/;
const CHORD = new RegExp(`^(?:Ctrl\\+)?(?:Alt\\+)?(?:Shift\\+)?(?:[A-Z0-9]|F(?:[1-9]|1\\d|2[0-4])|${NAMED_KEYS.join("|")}|[^\\sA-Za-z0-9])$`);

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * The key a press is for. A letter or digit by what it types, else by its position (`KeyS`, `Digit1`), so Shift or
 * another layout gives the same key. Unshifted ASCII punctuation by what it types too, so Ctrl+, is the comma wherever
 * the layout puts it (AZERTY has it where US has M); shifted, or on a layout whose key there types a letter, by
 * position, so Ctrl+Shift+, is still the comma key. Undefined for a modifier alone, or a key no chord can name.
 */
function keyOf(e: KeyLike): string | undefined {
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  if (!e.shiftKey && /^[!-/:-@[-`{-~]$/.test(e.key)) return e.key;
  const position = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
  if (position) return position[1] ?? position[2];
  const punctuation = PUNCTUATION_BY_CODE[e.code];
  if (punctuation) return punctuation;
  if (e.key === " ") return "Space";
  if (NAMED_KEYS.includes(e.key) || F_KEY.test(e.key)) return e.key;
  if (F_KEY.test(e.code)) return e.code;
  return e.key.length === 1 && !/\s/.test(e.key) ? e.key : undefined;
}

/** The chord a key press is, or undefined while only modifiers are down or for a key no chord can name. Cmd is Ctrl. */
export function chordOf(e: KeyLike): Chord | undefined {
  const key = keyOf(e);
  if (!key) return undefined;
  const held = { Ctrl: e.ctrlKey || e.metaKey, Alt: e.altKey, Shift: e.shiftKey };
  return [...MODIFIERS.filter((m) => held[m]), key].join("+") as Chord;
}

/** A stored string as a chord, if it has a chord's shape. */
export const parseChord = (s: unknown): Chord | undefined => (typeof s === "string" && CHORD.test(s) ? (s as Chord) : undefined);

function chord(s: string): Chord {
  const c = parseChord(s);
  if (!c) throw new Error(`"${s}" is not a chord`);
  return c;
}

/** Keys that stay as they are, listed on the page so they can be found. */
export type FixedKey = { title: string; keys: readonly Chord[]; when: string; group: Group };
export const FIXED: readonly FixedKey[] = [
  { title: "Undo in a text field", keys: [chord("Ctrl+Z")], when: "textFieldFocus", group: "chat" },
  { title: "Redo in a text field", keys: [chord("Ctrl+Shift+Z"), chord("Ctrl+Y")], when: "textFieldFocus", group: "chat" },
  { title: "Undo what the notice offers to undo", keys: [chord("Ctrl+Z")], when: "!textFieldFocus && noticeShown", group: "chat" },
  { title: "Choose a command in the slash command menu", keys: [chord("ArrowDown"), chord("ArrowUp")], when: "slashMenuOpen", group: "chat" },
  { title: "Fill in the chosen slash command", keys: [chord("Enter"), chord("Tab")], when: "slashMenuOpen", group: "chat" },
  { title: "Move a queued message down or up", keys: [chord("Alt+ArrowDown"), chord("Alt+ArrowUp")], when: "queuedMessageFocus", group: "chat" },
  { title: "Remove a queued message", keys: [chord("Delete")], when: "queuedMessageFocus", group: "chat" },
  { title: "Save a queued message you're editing", keys: [chord("Enter")], when: "queueEditFocus", group: "chat" },
  { title: "Steer a subagent with what you typed", keys: [chord("Enter")], when: "subagentSteerFocus", group: "chat" },
  { title: "Copy or paste in the Terminal", keys: [chord("Ctrl+Shift+C"), chord("Ctrl+Shift+V")], when: "terminalFocus", group: "chat" },
  { title: "Cancel Dictation, dropping what it heard", keys: [chord("Escape")], when: "dictating", group: "chat" },
  { title: "Stop the reply being read aloud in a voice conversation; the reply stays in the chat", keys: [chord("Escape")], when: "voiceReplyPlaying", group: "chat" },
  { title: "Close the chat's menu", keys: [chord("Escape")], when: "chatMenuOpen", group: "threads" },
  { title: "Keep Tab inside the chat's menu; the letter beside an item picks it", keys: [chord("Tab")], when: "chatMenuOpen", group: "threads" },
  { title: "Make the branch", keys: [chord("Enter")], when: "branchNameFocus", group: "threads" },
  { title: "Make the replay", keys: [chord("Ctrl+Enter")], when: "replayFocus", group: "threads" },
  {
    title: "Confirm a one-line field: a new project's name, a folder for a project, a profile copy's name, an inbox setting",
    keys: [chord("Enter")],
    when: "oneLineFieldFocus",
    group: "threads",
  },
  { title: "Cancel a question, step back out of a file's review, or close a dialog, panel or popover", keys: [chord("Escape")], when: "dialogOpen", group: "navigation" },
  { title: "Stop recording a shortcut, keeping the one it had", keys: [chord("Escape")], when: "shortcutRecording", group: "navigation" },
  { title: "Cancel what you're typing: a queued message, the Preview's address, a filter", keys: [chord("Escape")], when: "fieldEditing", group: "navigation" },
  { title: "Move between a menu's items", keys: [chord("ArrowDown"), chord("ArrowUp"), chord("Home"), chord("End")], when: "menuOpen", group: "navigation" },
  { title: "Close a menu, back to its button", keys: [chord("Escape")], when: "menuOpen", group: "navigation" },
  {
    title: "Move between the rows of a list: the Inbox, Bots, the model picker, the Office, Repository",
    keys: [chord("ArrowDown"), chord("ArrowUp")],
    when: "listFocus",
    group: "navigation",
  },
  { title: "Pick the highlighted model", keys: [chord("Enter")], when: "modelPickerOpen", group: "navigation" },
  {
    title: "Move between tabs: chat tabs, pane tabs, Settings tabs and their sections, the side panel, a theme's schemes",
    keys: [chord("ArrowLeft"), chord("ArrowRight"), chord("Home"), chord("End")],
    when: "tabFocus",
    group: "panels",
  },
  { title: "Close the focused chat tab", keys: [chord("Delete")], when: "chatTabFocus", group: "panels" },
  { title: "Move the split's divider", keys: [chord("ArrowLeft"), chord("ArrowRight"), chord("ArrowUp"), chord("ArrowDown")], when: "dividerFocus", group: "panels" },
  { title: "Go up to the parent folder in Files", keys: [chord("Alt+ArrowUp")], when: "fileBrowserFocus", group: "panels" },
];

const splitChord = (c: Chord): { mods: string[]; key: string } => {
  const mods: string[] = [];
  let rest: string = c;
  for (const m of MODIFIERS) {
    if (rest.startsWith(`${m}+`) && rest.length > m.length + 1) {
      mods.push(m);
      rest = rest.slice(m.length + 1);
    }
  }
  return { mods, key: rest };
};

const KEY_LABEL: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", PageUp: "PgUp", PageDown: "PgDn", ContextMenu: "Menu" };

/** A chord as key chips: `["Ctrl", "K"]`, `["↑"]`, `["Ctrl", "Shift", "PgUp"]`. */
export function chordParts(c: Chord): string[] {
  const { mods, key } = splitChord(c);
  return [...mods, KEY_LABEL[key] ?? key];
}

/** A chord as a hint names it: `Ctrl+K`, `↑`, `Esc`. */
export const chordLabel = (c: Chord): string => chordParts(c).join("+");

/** Chords as `aria-keyshortcuts` writes them: `Control+K`, `Shift+F10`, several separated by spaces. */
export const ariaKeys = (chords: readonly Chord[]): string =>
  chords.map((c) => c.replace(/^Ctrl\+/, "Control+")).join(" ");

export type Bindings = Readonly<Record<CommandId, readonly Chord[]>>;

export const DEFAULT_BINDINGS = Object.fromEntries(COMMAND_IDS.map((id) => [id, COMMANDS[id].defaults.map(chord)])) as unknown as Bindings;

const sameChords = (a: readonly Chord[], b: readonly Chord[]) => a.length === b.length && a.every((c, i) => c === b[i]);
/** Whether the owner's chords for `id` differ from the defaults. */
export const isCustom = (b: Bindings, id: CommandId) => !sameChords(b[id], DEFAULT_BINDINGS[id]);

const EDIT_KEYS: Record<string, string> = { A: "selects all text", C: "copies", V: "pastes", X: "cuts", Z: "undoes", Y: "redoes" };

/** The screenshot shortcut (ui/shortcut.ts, where Super is its own modifier) as a chord, where Super counts as Ctrl. */
export function screenshotChord(s: string | null | undefined): Chord | undefined {
  if (!s) return undefined;
  const parts = s.split("+");
  const held = new Set(parts.slice(0, -1));
  const ctrl = held.has("Ctrl") || held.has("Super");
  return parseChord([ctrl && "Ctrl", held.has("Alt") && "Alt", held.has("Shift") && "Shift", parts[parts.length - 1]].filter(Boolean).join("+"));
}

/**
 * Why `chord` can't be `id`'s, or undefined when it can. A clash with another command is not a reason: that is saved,
 * and the page warns about it. `screenshot`: the screenshot shortcut now, which the window takes before any command.
 */
export function checkChord(id: CommandId, chord: Chord, screenshot: string | null): string | undefined {
  const { mods, key } = splitChord(chord);
  const held = new Set(mods);
  const label = chordLabel(chord);
  const ctrlOrAlt = held.has("Ctrl") || held.has("Alt");
  if ((key.length === 1 || key === "Space") && !ctrlOrAlt) return `Typing ${label} would run it. Add Ctrl or Alt.`;
  if (COMMANDS[id].scope === "app" && !ctrlOrAlt && !F_KEY.test(key)) return `${label} needs Ctrl or Alt, so a key pressed anywhere in the app can't run it by accident.`;
  if (key === "Tab" && !ctrlOrAlt) return `${label} moves between controls.`;
  if (held.has("Ctrl") && !held.has("Alt") && EDIT_KEYS[key] && (!held.has("Shift") || key === "Z")) return `${label} ${EDIT_KEYS[key]} while you type.`;
  if (held.has("Ctrl") && held.has("Alt") && /^F(?:[1-9]|1[0-2])$/.test(key)) return `${label} switches to a text console on Linux.`;
  if (held.has("Alt") && key === "F4") return `${label} closes the window on most desktops.`;
  if (chord === screenshotChord(screenshot)) return `${label} is the screenshot shortcut (Settings → General → Screenshots).`;
  return undefined;
}

/**
 * The chords in use: the owner's overrides over the defaults. An override for a command this version doesn't know is
 * left out; of a known one, a string that isn't a chord, or a chord `checkChord` refuses, is dropped, and a command
 * left with none keeps its defaults.
 */
export function bindingsOf(overrides: Readonly<Record<string, readonly string[]>>, screenshot: string | null): Bindings {
  const out = { ...DEFAULT_BINDINGS } as Record<CommandId, readonly Chord[]>;
  for (const [id, stored] of Object.entries(overrides)) {
    if (!isCommandId(id) || !Array.isArray(stored)) continue;
    const chords = stored.map(parseChord).filter((c): c is Chord => !!c && !checkChord(id, c, screenshot));
    if (chords.length) out[id] = [...new Set(chords)];
  }
  return out;
}

let cachedPrefs: ReturnType<typeof getUIPrefs> | undefined;
let cachedBindings: Bindings = DEFAULT_BINDINGS;
/** The chords in use now. The same object until the preferences change. */
export function getBindings(): Bindings {
  const prefs = getUIPrefs();
  if (prefs !== cachedPrefs) {
    cachedPrefs = prefs;
    cachedBindings = bindingsOf(prefs.keybindings, prefs.screenshotShortcut);
  }
  return cachedBindings;
}

/** The chords in use, kept current as the owner changes them, so a hint never shows a chord that no longer works. */
export const useBindings = (): Bindings => useSyncExternalStore(subscribe, getBindings);
/** `id`'s first chord as a hint names it, kept current. */
export const useChordLabel = (id: CommandId): string => chordLabel(useBindings()[id][0]);

const idsIn = (scope: Scope) => COMMAND_IDS.filter((id) => COMMANDS[id].scope === scope);

/**
 * Which of `scope`'s commands a key press is, or undefined: never one during IME composition. When the owner has put
 * two on one chord, the one they changed wins, then the first in the table.
 */
export function pick(e: KeyboardEvent | ReactKeyboardEvent, scope: Scope): CommandId | undefined {
  if (composing(e)) return undefined;
  const chord = chordOf(e);
  if (!chord) return undefined;
  const b = getBindings();
  const hits = idsIn(scope).filter((id) => b[id].includes(chord));
  return hits.find((id) => isCustom(b, id)) ?? hits[0];
}

/** For a composer's New line: Enter and Shift+Enter break the line by themselves; any other chord types the break. */
export function typeNewLine(e: KeyboardEvent | ReactKeyboardEvent): void {
  const c = chordOf(e);
  if (c === "Enter" || c === "Shift+Enter") return;
  e.preventDefault();
  document.execCommand("insertText", false, "\n");
}

/** Which app-wide command a key press is. Every window listener asks this, so one press runs one command. */
export const pickApp = (e: KeyboardEvent | ReactKeyboardEvent) => pick(e, "app");

/**
 * Each command that shares a chord with another it could both fire with (the same scope, or either app-wide), or with
 * the screenshot shortcut, and the titles of what it shares it with.
 */
export function conflicts(b: Bindings, screenshot: string | null): Map<CommandId, string[]> {
  const out = new Map<CommandId, string[]>();
  const shot = screenshotChord(screenshot);
  for (const id of COMMAND_IDS) {
    const others: string[] = COMMAND_IDS.filter(
      (o) =>
        o !== id &&
        (COMMANDS[o].scope === COMMANDS[id].scope || COMMANDS[o].scope === "app" || COMMANDS[id].scope === "app") &&
        b[o].some((c) => b[id].includes(c)),
    ).map((o) => COMMANDS[o].title);
    if (shot && b[id].includes(shot)) others.push("the screenshot shortcut");
    if (others.length) out.set(id, others);
  }
  return out;
}

/** Gives `id` the one chord `chord`. A chord equal to the defaults forgets the override instead. */
export function rebind(id: CommandId, chord: Chord): void {
  const next = { ...getUIPrefs().keybindings };
  if (sameChords([chord], DEFAULT_BINDINGS[id])) delete next[id];
  else next[id] = [chord];
  setUIPrefs({ keybindings: next });
}

export function resetBinding(id: CommandId): void {
  const { [id]: _, ...rest } = getUIPrefs().keybindings;
  setUIPrefs({ keybindings: rest });
}

export const resetAll = (): void => void setUIPrefs({ keybindings: {} });
