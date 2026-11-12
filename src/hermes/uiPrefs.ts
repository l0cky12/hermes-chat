// Display preferences for this computer: the theme, whether the last chat reopens at launch and which chat each profile
// had open, whether reasoning shows, the model last picked and the starred models, which items the status bar shows,
// the screenshot shortcut and preview pane width, which computer the Terminal opens on, what sending does while a
// reply runs, Idle compaction, which of the chat list's sections show and which are collapsed, how the agent office shows,
// and the keyboard shortcuts the owner changed. All preferences live in one versioned localStorage document.
// it (chatCache.ts) and later settings add fields here rather than new keys. Nothing here goes to Hermes. Every
// settings feature reads and writes through this module.

import { fromKey, isEffort, type ModelPick } from "./models";
import { SECTION_KEYS, isSectionKey, type SectionKey } from "./sectionKeys";
import { toTemplates, type Template } from "./templates";
import type { TerminalKind } from "./terminal";
import { nonEmptyText } from "./values";

export const UI_PREFS_KEY = "hermes-ui-prefs";
/** The shape the document has now. Bump it, and add a step to UI_PREFS_MIGRATIONS, when a field changes meaning. */
export const UI_PREFS_VERSION = 3;

export type Theme = "light" | "dark" | "system";
export const THEMES: readonly Theme[] = ["light", "dark", "system"];

/**
 * The model picked last, kept so the next new chat starts with it (models.ts). `profile`: the profile it was picked in;
 * in another profile the composer starts from that profile's own model instead. It never becomes the profile's default.
 */
export type StickyModelPick = ModelPick & { profile?: string };

export type UIPrefs = {
  theme: Theme;
  /** Open the chat that was on screen when the app last closed. */
  reopenLastChat: boolean;
  /** Ask GitHub, or the update server, for a newer version as the app starts (updates.ts). */
  checkUpdatesOnLaunch: boolean;
  /** Each profile's chat on screen last, kept as the owner moves between chats; a profile on the New chat pane has none. */
  lastOpenChat: Record<string, string>;
  /** null: no sticky pick, so Hermes's default model is used. */
  modelPicker: StickyModelPick | null;
  /** Picks kept separately for each connection/profile, including the one not currently on screen. */
  modelPicks: Record<string, ModelPick>;
  /** Starred models, as `provider/model`, listed first in the model picker. Kept even when Hermes no longer lists them. */
  modelFavorites: string[];
  /** The status bar items shown, in order (StatusBar.tsx). Empty: the bar is hidden. */
  statusBar: string[];
  /** The in-app shortcut that takes a screenshot for the composer, like `Ctrl+Shift+S` (ui/shortcut.ts); null: off. */
  screenshotShortcut: string | null;
  /** How wide the owner made the preview pane, in px; null until they resize it. */
  previewWidth: number | null;
  /** The owner's message templates (templates.ts, ADR 0028). */
  templates: Template[];
  /** The Terminal's shell picked last: the Hermes server's, through ssh, or this computer's (ADR 0051). */
  terminalKind: TerminalKind;
  /**
   * What Enter does with a message while the chat's reply runs (ADR 0057): `queue` it for after the reply (ADR 0018),
   * or `steer` it into the running reply. Ctrl+Enter does the other.
   */
  followUp: FollowUp;
  /** Idle compaction: compact a chat open on Hermes here once it has sat idle with its context window this full (ADR 0119). */
  idleCompact: IdleCompactPrefs;
  /** The chat list's sections that show, in their own order (ADR 0063). Never empty: at least one stays on. */
  chatSectionsShown: SectionKey[];
  /** The chat list's sections the owner collapsed, kept across restarts (ADR 0063). */
  chatSectionsCollapsed: SectionKey[];
  /** How the agent office shows the agents at work: as a 3D building (ADR 0122), as a list, or not at all, with no rail button (ADR 0077). */
  agentOffice: OfficeView;
  /** How much the office's building may cost to draw (ADR 0122). */
  officeQuality: OfficeQuality;
  /** How many days a finished entry stays in the inbox before it is dismissed on its own, as if by hand; null: never. */
  inboxAutoDismissDays: number | null;
  /**
   * The keyboard shortcuts the owner changed (ui/keybindings.ts, ADR 0147): each command's chords, by command id. Only
   * overrides, so a command never changed takes whatever default this version gives it. Checked for shape here only;
   * keybindings.ts drops an id or chord it doesn't accept.
   */
  keybindings: Record<string, string[]>;
};

export type OfficeView = "building" | "list" | "off";
export const OFFICE_VIEWS: readonly OfficeView[] = ["building", "list", "off"];

export type OfficeQuality = "normal" | "low";
export const OFFICE_QUALITIES: readonly OfficeQuality[] = ["normal", "low"];

export type FollowUp = "queue" | "steer";

/**
 * Idle compaction (idleCompact.ts, ADR 0119). `enabled`: off until the owner turns it on, since a compaction is a model
 * call. `percent`: how full the context window must be, as Hermes measured it. `idleMinutes`: how long the chat must
 * have had nothing happen in it.
 */
export type IdleCompactPrefs = { enabled: boolean; percent: number; idleMinutes: number };
/** The fullness choices Settings → Model offers, in percent. */
export const IDLE_COMPACT_PERCENTS = [50, 60, 70, 75, 80, 85, 90] as const;
/** The idle-time choices Settings → Model offers, in minutes. */
export const IDLE_COMPACT_MINUTES = [5, 10, 15, 30, 60, 120] as const;

/** The shape of a stored shortcut: modifiers in order, then one key (ui/shortcut.ts writes them). */
const SHORTCUT = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Super\+)?(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|PrintScreen|Pause|ScrollLock|Insert)$/;
export const isShortcut = (s: unknown): s is string => typeof s === "string" && SHORTCUT.test(s);
/** Every status bar item, in the bar's order; all shown until the owner picks otherwise. */
export const STATUS_BAR_ITEMS = ["context", "model", "status"] as const;

export const DEFAULT_UI_PREFS: Readonly<UIPrefs> = Object.freeze({
  theme: "system",
  reopenLastChat: true,
  checkUpdatesOnLaunch: true,
  lastOpenChat: Object.freeze({}) as Record<string, string>,
  modelPicker: null,
  modelPicks: {},
  modelFavorites: [],
  statusBar: [...STATUS_BAR_ITEMS],
  screenshotShortcut: "Ctrl+Shift+S",
  previewWidth: null,
  templates: [],
  terminalKind: "server",
  followUp: "queue",
  idleCompact: Object.freeze({ enabled: false, percent: 70, idleMinutes: 15 }),
  chatSectionsShown: SECTION_KEYS.filter((k) => k !== "archived"),
  chatSectionsCollapsed: ["snoozed", "archived", "settled"] as SectionKey[],
  agentOffice: "building",
  officeQuality: "normal",
  inboxAutoDismissDays: null,
  keybindings: Object.freeze({}) as Record<string, string[]>,
});

/** A stored document as read, before its fields are checked. */
export type UIPrefsDoc = Record<string, unknown>;
/** Turns a document of version `n` into one of version `n + 1`; keyed by `n`. */
export type UIPrefsMigrations = Readonly<Record<number, (doc: UIPrefsDoc) => UIPrefsDoc>>;

export const UI_PREFS_MIGRATIONS: UIPrefsMigrations = {
  // Version 0 is a document written without `v`; its fields already have version 1's shape.
  0: (doc) => doc,
  // Pinned is new in version 2 (ADR 0085): a list of shown sections from before it shows Pinned too.
  1: (doc) => (toShown(doc.chatSectionsShown) ? { ...doc, chatSectionsShown: ["pinned", ...(doc.chatSectionsShown as unknown[])] } : doc),
  // The building replaces the Desks and Scene views in version 3 (ADR 0122): whoever picked either sees the building.
  2: (doc) => (doc.agentOffice === "desks" || doc.agentOffice === "scene" ? { ...doc, agentOffice: "building" } : doc),
};

const isDoc = (v: unknown): v is UIPrefsDoc => typeof v === "object" && v !== null && !Array.isArray(v);
/** A document's version: no `v` is version 0; anything that isn't a whole number isn't trusted at all. */
const versionOf = (doc: UIPrefsDoc) => (doc.v === undefined ? 0 : Number.isInteger(doc.v) ? (doc.v as number) : -1);

/**
 * `raw` brought up to version `to`, one step at a time. A document from a newer app is read as it is: its fields are
 * checked like any other, so the ones this version knows still apply. Anything that isn't a document is empty.
 */
export function migrateUIPrefs(raw: unknown, migrations: UIPrefsMigrations = UI_PREFS_MIGRATIONS, to: number = UI_PREFS_VERSION): UIPrefsDoc {
  if (!isDoc(raw)) return { v: to };
  let v = versionOf(raw);
  if (v < 0) return { v: to };
  let doc = raw;
  while (v < to) {
    const step = migrations[v];
    // A version with no way forward can't be read safely; start over from the defaults.
    if (!step) return { v: to };
    doc = step(doc);
    v++;
  }
  return { ...doc, v: Math.max(v, to) };
}

function toModelPick(v: unknown): StickyModelPick | null | undefined {
  if (v === null) return null;
  if (!isDoc(v)) return undefined;
  const provider = nonEmptyText(v.provider, 200);
  const model = nonEmptyText(v.model, 200);
  if (provider === undefined || model === undefined) return undefined;
  const profile = nonEmptyText(v.profile, 200);
  return {
    provider,
    model,
    ...(isEffort(v.effort) && { effort: v.effort }),
    ...(typeof v.fast === "boolean" && { fast: v.fast }),
    ...(profile !== undefined && { profile }),
  };
}

function toModelPicks(v: unknown): Record<string, ModelPick> | undefined {
  if (!isDoc(v)) return undefined;
  return Object.fromEntries(Object.entries(v).slice(-100).flatMap(([scope, raw]) => {
    const pick = toModelPick(raw);
    if (!nonEmptyText(scope, 200) || !pick) return [];
    const { profile: _, ...model } = pick;
    return [[scope, model]];
  }));
}

function toFavorites(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.filter((k): k is string => nonEmptyText(k, 400) !== undefined && !!fromKey(k)))];
}

function toStatusBar(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((i): i is string => nonEmptyText(i, 60) !== undefined);
  return [...new Set(items)];
}

/** A preview width, in px, that a window could have. */
const toPreviewWidth = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isInteger(v) && v >= 200 && v <= 8000 ? v : undefined;

/**
 * Idle compaction's prefs as stored, each field checked on its own; undefined when it isn't a document. A percent or
 * time that a newer app or a hand edit put outside the choices offered is kept if it is still sane.
 */
function toIdleCompact(v: unknown, d: IdleCompactPrefs): IdleCompactPrefs | undefined {
  if (!isDoc(v)) return undefined;
  const whole = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    percent: whole(v.percent, 10, 99) ? (v.percent as number) : d.percent,
    idleMinutes: whole(v.idleMinutes, 1, 24 * 60) ? (v.idleMinutes as number) : d.idleMinutes,
  };
}

/**
 * Sections as stored, each once and in the list's order; undefined when it isn't a list. A key this version doesn't
 * know is left out, as Unsettled is since ADR 0090.
 */
function toSections(v: unknown): SectionKey[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return SECTION_KEYS.filter((k) => v.some((x) => isSectionKey(x) && x === k));
}

/** The sections shown, as stored: never none, so a list with none of them is no value at all. */
const toShown = (v: unknown) => {
  const shown = toSections(v);
  return shown?.length ? shown : undefined;
};

/** The most profiles `lastOpenChat` keeps; a document edited by hand can't grow the prefs without end. */
const LAST_OPEN_LIMIT = 100;

function toLastOpenChat(v: unknown): Record<string, string> | undefined {
  if (!isDoc(v)) return undefined;
  const entries = Object.entries(v).filter(([profile, id]) => nonEmptyText(profile, 200) !== undefined && nonEmptyText(id, 200) !== undefined);
  return Object.fromEntries(entries.slice(0, LAST_OPEN_LIMIT)) as Record<string, string>;
}

const KEYBINDINGS_LIMIT = 100;
const CHORDS_LIMIT = 8;

function toKeybindings(v: unknown): Record<string, string[]> | undefined {
  if (!isDoc(v)) return undefined;
  const entries = Object.entries(v)
    .filter(([id, chords]) => nonEmptyText(id, 60) !== undefined && Array.isArray(chords) && chords.length > 0 && chords.every((c) => nonEmptyText(c, 60) !== undefined))
    .map(([id, chords]) => [id, (chords as string[]).slice(0, CHORDS_LIMIT)]);
  return Object.fromEntries(entries.slice(0, KEYBINDINGS_LIMIT));
}

/** The prefs `doc` holds, each field that is missing or not a valid value taken from `d`: the defaults, unless given. */
export function readUIPrefs(doc: UIPrefsDoc, d: Readonly<UIPrefs> = DEFAULT_UI_PREFS): UIPrefs {
  const pick = toModelPick(doc.modelPicker);
  const previewWidth = toPreviewWidth(doc.previewWidth);
  return {
    theme: THEMES.includes(doc.theme as Theme) ? (doc.theme as Theme) : d.theme,
    reopenLastChat: typeof doc.reopenLastChat === "boolean" ? doc.reopenLastChat : d.reopenLastChat,
    checkUpdatesOnLaunch: typeof doc.checkUpdatesOnLaunch === "boolean" ? doc.checkUpdatesOnLaunch : d.checkUpdatesOnLaunch,
    lastOpenChat: toLastOpenChat(doc.lastOpenChat) ?? { ...d.lastOpenChat },
    modelPicker: pick === undefined ? (d.modelPicker && { ...d.modelPicker }) : pick,
    modelPicks: toModelPicks(doc.modelPicks) ?? (pick?.profile ? { ...d.modelPicks, ...toModelPicks({ [pick.profile]: pick }) } : { ...d.modelPicks }),
    modelFavorites: toFavorites(doc.modelFavorites) ?? [...d.modelFavorites],
    statusBar: toStatusBar(doc.statusBar) ?? [...d.statusBar],
    screenshotShortcut: doc.screenshotShortcut === null || isShortcut(doc.screenshotShortcut) ? doc.screenshotShortcut : d.screenshotShortcut,
    previewWidth: previewWidth === undefined ? d.previewWidth : previewWidth,
    templates: toTemplates(doc.templates) ?? [...d.templates],
    terminalKind: doc.terminalKind === "server" || doc.terminalKind === "local" ? doc.terminalKind : d.terminalKind,
    followUp: doc.followUp === "queue" || doc.followUp === "steer" ? doc.followUp : d.followUp,
    idleCompact: toIdleCompact(doc.idleCompact, d.idleCompact) ?? { ...d.idleCompact },
    chatSectionsShown: toShown(doc.chatSectionsShown) ?? [...d.chatSectionsShown],
    chatSectionsCollapsed: toSections(doc.chatSectionsCollapsed) ?? [...d.chatSectionsCollapsed],
    agentOffice: OFFICE_VIEWS.includes(doc.agentOffice as OfficeView) ? (doc.agentOffice as OfficeView) : d.agentOffice,
    officeQuality: OFFICE_QUALITIES.includes(doc.officeQuality as OfficeQuality) ? (doc.officeQuality as OfficeQuality) : d.officeQuality,
    inboxAutoDismissDays:
      doc.inboxAutoDismissDays === null || (typeof doc.inboxAutoDismissDays === "number" && Number.isFinite(doc.inboxAutoDismissDays) && doc.inboxAutoDismissDays > 0)
        ? doc.inboxAutoDismissDays
        : d.inboxAutoDismissDays,
    keybindings: toKeybindings(doc.keybindings) ?? { ...d.keybindings },
  };
}

export type UIPrefsListener = (prefs: Readonly<UIPrefs>) => void;

/** The storage the prefs are kept in: localStorage in the app. Looked up on each use, so tests can swap it. */
const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
function readRaw(): string | null {
  try {
    return storage()?.getItem(UI_PREFS_KEY) ?? null;
  } catch {
    return null;
  }
}
function parse(raw: string | null): { doc: UIPrefsDoc; prefs: UIPrefs } {
  let parsed: unknown;
  try {
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    // Unreadable: the defaults.
  }
  const doc = migrateUIPrefs(parsed);
  return { doc, prefs: readUIPrefs(doc) };
}

// What was read last, so getUIPrefs returns the same object until the stored document changes (useSyncExternalStore
// needs that). A change that couldn't be stored is kept here, and holds until the app closes or another window writes.
let cachedRaw: string | null | undefined;
/** The last change couldn't be stored: `cached` holds prefs that storage doesn't. The next set tries again. */
let unstored = false;
let cached: { doc: UIPrefsDoc; prefs: UIPrefs } = { doc: { v: UI_PREFS_VERSION }, prefs: readUIPrefs({}) };

function current() {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
    unstored = false;
  }
  return cached;
}

const listeners = new Set<UIPrefsListener>();
const notify = () => {
  const prefs = cached.prefs;
  for (const fn of [...listeners]) fn(prefs);
};

/** The prefs on this computer, the defaults filling anything unset. The same object until they change. */
export function getUIPrefs(): Readonly<UIPrefs> {
  return current().prefs;
}

/**
 * Merges `patch` into the prefs and keeps them. Each field given replaces the old value whole (`statusBar` is not
 * appended to; `modelPicker: null` forgets the pick); fields left out, or given as undefined, stay as they are.
 * Fields this version doesn't know, written by a newer app, are kept. Listeners hear of it only if something changed.
 * Answers false if the change couldn't be stored (storage full or refused); it then holds only until the app closes.
 */
export function setUIPrefs(patch: Partial<UIPrefs>): boolean {
  const { doc, prefs } = current();
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (patch.modelPicks === undefined && patch.modelPicker !== undefined) {
    const scope = patch.modelPicker?.profile ?? prefs.modelPicker?.profile;
    if (scope) {
      const picks = { ...prefs.modelPicks };
      if (patch.modelPicker) {
        const { profile: _, ...pick } = patch.modelPicker;
        delete picks[scope];
        picks[scope] = pick;
      } else delete picks[scope];
      given.modelPicks = picks;
    }
  }
  // A value that isn't valid leaves the field as it was.
  const next = readUIPrefs(given, prefs);
  const same = JSON.stringify(next) === JSON.stringify(prefs);
  if (same && !unstored) return true;
  const nextDoc: UIPrefsDoc = { ...doc, ...next, v: UI_PREFS_VERSION };
  const raw = JSON.stringify(nextDoc);
  cached = { doc: nextDoc, prefs: next };
  let kept = false;
  try {
    const s = storage();
    if (s) {
      s.setItem(UI_PREFS_KEY, raw);
      cachedRaw = raw;
      kept = true;
    }
  } catch {
    // Not kept: `cached` holds the change while the stored document is still the one last read.
  }
  unstored = !kept;
  if (!same) notify();
  return kept;
}

/** Stars a model (`provider/model`) for the model picker, or unstars a starred one. Never picks it. */
export function toggleModelFavorite(key: string): void {
  const favorites = getUIPrefs().modelFavorites;
  setUIPrefs({ modelFavorites: favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key] });
}

/** Another window changed the stored document. `key` null: that window cleared all of localStorage. */
function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== UI_PREFS_KEY) return;
  const before = cached.prefs;
  const after = current().prefs;
  if (after !== before && JSON.stringify(after) !== JSON.stringify(before)) notify();
}

/**
 * Calls `fn` with the new prefs whenever they change: by setUIPrefs in this window, or in another window of the app
 * (the `storage` event). Returns the function that stops it.
 */
export function subscribe(fn: UIPrefsListener): () => void {
  if (listeners.size === 0) {
    current();
    globalThis.addEventListener?.("storage", onStorage);
  }
  listeners.add(fn);
  return () => {
    if (!listeners.delete(fn) || listeners.size > 0) return;
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/**
 * Records `chatId` as `profile`'s chat on screen, for "Reopen last chat on launch". null: the profile is on the New chat
 * pane, so nothing reopens for it. Called as the owner moves between chats, not as the app closes, which may not run.
 */
export function rememberOpenChat(profile: string, chatId: string | null): void {
  const { lastOpenChat } = getUIPrefs();
  if ((lastOpenChat[profile] ?? null) === chatId) return;
  const next = { ...lastOpenChat };
  if (chatId === null) delete next[profile];
  else next[profile] = chatId;
  setUIPrefs({ lastOpenChat: next });
}

/** Forgets `profile`'s last open chat if it is still `chatId`: the chat is no longer in the profile's list. */
export function forgetOpenChat(profile: string, chatId: string): void {
  if (getUIPrefs().lastOpenChat[profile] === chatId) rememberOpenChat(profile, null);
}

/** The chat to reopen for `profile` at launch: its last open chat, if the owner wants it reopened. */
export function chatToReopen(profile: string): string | undefined {
  const prefs = getUIPrefs();
  return prefs.reopenLastChat ? prefs.lastOpenChat[profile] : undefined;
}
