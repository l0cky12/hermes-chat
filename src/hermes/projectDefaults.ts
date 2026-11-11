// A project's defaults for its new chats (GLOSSARY.md "Project defaults", ADR 0017): instructions, a model with its
// reasoning effort, and a working folder on the server. Hermes keeps projects, but has nowhere to keep these (its
// `projects.update` takes only a name, description, icon, colour and board), so this computer keeps them, for each
// connection and profile, in their own document: `project-defaults.json` in the app's data folder, which every running
// instance shares. It changes only by compare-and-swap under a file lock (defaults_file.rs): a save is written only
// over the document it was checked against, so no instance's save silently replaces another's.
//
// A new chat takes each value from the first of: what the owner chose for that chat, the project's default, and the
// profile's own. The defaults go to Hermes only when a chat starts, through `session.create`: `model`, `provider` and
// `reasoning_effort`; `cwd` with `cwd_explicit`; and the instructions as one hidden seeded message (`messages` with
// `display_kind: "hidden"`), since `session.create` has no instructions field. Changing a default never changes a chat
// that has started.
import { invoke } from "@tauri-apps/api/core";
import { findOption, isEffort, shortName, type Effort, type ModelCatalog, type ModelPick } from "./models";
import { errorText, isObj } from "./values";

/**
 * One project's defaults as this computer keeps them. `rev` counts the saves, so a save made from a screen opened
 * before another save is refused rather than overwriting it. A field left out is inherited from the profile.
 */
export type ProjectDefaults = { rev: number; instructions?: string; model?: ModelPick; folder?: string };

/** The defaults the owner edits: everything but the revision. */
export type DefaultsDraft = Omit<ProjectDefaults, "rev">;

/** The longest instructions kept. They go to the model with every new chat's first message, so a novel is a mistake. */
export const INSTRUCTIONS_MAX = 20_000;

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);

/** A stored model pick, checked; undefined if it isn't one. */
function toPick(v: unknown): ModelPick | undefined {
  if (!isObj(v)) return undefined;
  const provider = str(v.provider, 200);
  const model = str(v.model, 200);
  if (!provider || !model) return undefined;
  return { provider, model, ...(isEffort(v.effort) && { effort: v.effort }) };
}

/** One project's stored defaults, checked; anything that isn't valid is left out, and inherits. */
export function toDefaults(v: unknown): ProjectDefaults | undefined {
  if (!isObj(v) || !Number.isSafeInteger(v.rev) || (v.rev as number) < 1) return undefined;
  const instructions = str(v.instructions, INSTRUCTIONS_MAX);
  const model = toPick(v.model);
  const folder = typeof v.folder === "string" && v.folder.startsWith("/") && v.folder.length <= 4096 ? v.folder : undefined;
  return { rev: v.rev as number, ...(instructions && { instructions }), ...(model && { model }), ...(folder && { folder }) };
}

/** What is wrong with the draft, if anything, said to the owner. */
export function draftProblem(d: DefaultsDraft): string | undefined {
  const n = d.instructions?.trim().length ?? 0;
  if (n > INSTRUCTIONS_MAX) return `Keep the instructions under ${INSTRUCTIONS_MAX.toLocaleString("en")} characters; they're ${n.toLocaleString("en")}.`;
  return undefined;
}

/** The draft as it is kept: blank instructions are none, and effort is kept only with a model. Never throws. */
export function cleanDraft(d: DefaultsDraft): DefaultsDraft {
  const instructions = d.instructions?.trim() ? d.instructions.trim() : undefined;
  return {
    ...(instructions && { instructions }),
    ...(d.model && { model: { provider: d.model.provider, model: d.model.model, ...(d.model.effort && { effort: d.model.effort }) } }),
    ...(d.folder && { folder: d.folder }),
  };
}

export const sameDraft = (a: DefaultsDraft, b: DefaultsDraft) => JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b));

/** Another save landed since the defaults being edited were read. `saved`: the defaults as they are kept now. */
export class DefaultsConflict extends Error {
  constructor(readonly saved: ProjectDefaults | undefined) {
    super("These defaults were changed elsewhere since you opened them, for example in another Hermes Chat window.");
  }
}

/** The stored document was written by a newer Hermes Chat, whose defaults this version might not keep whole. */
export class NewerDefaultsError extends Error {
  constructor() {
    super("A newer version of Hermes Chat saved these projects. Update this one to change the defaults.");
  }
}

/** Where a new chat's value comes from: chosen for it, the project's default, the owner's model pick, or the profile. */
export type Origin = "chat" | "project" | "pick" | "profile";
/** A value and where it comes from. `value` undefined: Hermes's own for the profile, which this app doesn't read. */
export type Resolved<T> = { value?: T; from: Origin };

/** What a new chat starts with, and where each value comes from. */
export type NewChatSettings = {
  model: Resolved<ModelPick>;
  effort: Resolved<Effort>;
  instructions: Resolved<string>;
  folder: Resolved<string>;
  /** The project whose defaults apply, if any. */
  project?: string;
};

/**
 * What a new chat starts with. `chosen`: a model the owner picked for this chat, in its New chat pane. `project`: the
 * shown project and its defaults. `sticky`: the composer's Model pick, which is the profile's model until the owner
 * picks another. `profilePick` and `profileEffort`: the profile's own model and effort, as Hermes listed them.
 */
export function resolveNewChat(o: {
  chosen?: ModelPick;
  /** A folder the owner chose for this chat: a worktree it is started in (ADR 0043). */
  chosenFolder?: string;
  project?: { name: string; defaults?: ProjectDefaults };
  sticky?: ModelPick;
  profilePick?: ModelPick;
  profileEffort?: Effort;
}): NewChatSettings {
  const d = o.project?.defaults;
  const s = o.sticky;
  const asProfile = !s || (s.provider === o.profilePick?.provider && s.model === o.profilePick.model && (!s.effort || s.effort === o.profileEffort));
  const fromSticky: Origin = asProfile ? "profile" : "pick";
  const model: Resolved<ModelPick> = o.chosen
    ? { value: o.chosen, from: "chat" }
    : d?.model
      ? { value: d.model, from: "project" }
      : { value: o.sticky ?? o.profilePick, from: fromSticky };
  const effort: Resolved<Effort> = model.value?.effort ? { value: model.value.effort, from: model.from } : { value: o.profileEffort, from: "profile" };
  return {
    model,
    effort,
    instructions: d?.instructions ? { value: d.instructions, from: "project" } : { from: "profile" },
    folder: o.chosenFolder ? { value: o.chosenFolder, from: "chat" } : d?.folder ? { value: d.folder, from: "project" } : { from: "profile" },
    ...(o.project && { project: o.project.name }),
  };
}

/**
 * Why a chat can't start on these settings, if it can't: a project's default model Hermes doesn't offer now. A
 * model is never swapped for another on the owner's behalf.
 */
export function modelProblem(s: NewChatSettings, catalog?: ModelCatalog): string | undefined {
  const pick = s.model.value;
  if (s.model.from !== "project" || !pick || catalog?.source !== "server") return undefined;
  const option = findOption(catalog, pick);
  const what = `The project's default model, ${shortName(pick.model)} (${pick.provider}),`;
  if (!option) return `${what} isn't offered by Hermes in this profile now. Pick a model for this chat, or change the project's defaults.`;
  if (!option.available) return `${what} can't be used now: Hermes lists it as unavailable. Pick a model for this chat, or change the project's defaults.`;
  return undefined;
}

/**
 * The hidden message that carries a project's instructions into a new chat. The model reads it before the owner's
 * first message, as part of the conversation, not as the system prompt; the owner doesn't see it in any Hermes client.
 */
export const instructionsMessage = (project: string, text: string) =>
  `Instructions for this chat from the project "${project}". Follow them unless a later message says otherwise.\n\n${text}`;

/** Where the defaults document is kept: its text, and a compare-and-swap that every running app instance honours. */
export type DefaultsFile = {
  read(): Promise<string | null>;
  /** Writes `next` only if the document is still `expected` (null: none yet); otherwise answers what it is now. */
  swap(expected: string | null, next: string): Promise<{ swapped: boolean; current: string | null }>;
};

/** The document's shape: `{v, scopes: {[scope]: {[projectId]: ProjectDefaults}}}`. Bump it when a field changes meaning. */
export const DEFAULTS_VERSION = 1;

/** The projects' defaults kept in a `DefaultsFile`. Every call reads it afresh. */
export type DefaultsDoc = {
  read(scope: string): Promise<Record<string, ProjectDefaults>>;
  /**
   * Keeps project `id`'s defaults over revision `base`, the one the owner started from (0: none yet), and answers
   * them as kept. Throws `DefaultsConflict` if another save landed meanwhile, `NewerDefaultsError` if a newer app wrote
   * the document, and an error if the draft is wrong or the file couldn't be written; nothing is kept then.
   */
  save(scope: string, id: string, base: number, draft: DefaultsDraft): Promise<ProjectDefaults>;
  /** Forgets one project's defaults, after this app deleted the project. Leaves a newer app's document alone. */
  forget(scope: string, id: string): Promise<void>;
  /**
   * Moves each scope to where `move` says (null: forgets it; undefined: leaves it), after a profile was renamed or
   * deleted, or the owner removed their connection. A moved scope replaces any already there. Leaves a newer app's
   * document alone.
   */
  moveScopes(move: (scope: string) => string | null | undefined): Promise<void>;
};

type Parsed = { v: number; scopes: Record<string, unknown>; rest: Record<string, unknown> };

function parse(raw: string | null): Parsed {
  let doc: unknown;
  try {
    doc = raw === null ? undefined : JSON.parse(raw);
  } catch {
    doc = undefined;
  }
  if (!isObj(doc)) return { v: DEFAULTS_VERSION, scopes: {}, rest: {} };
  const { v, scopes, ...rest } = doc;
  return { v: Number.isSafeInteger(v) ? (v as number) : DEFAULTS_VERSION, scopes: isObj(scopes) ? scopes : {}, rest };
}

const ofScope = (doc: Parsed, scope: string): Record<string, unknown> => {
  const s = doc.scopes[scope];
  return isObj(s) ? s : {};
};

const withScope = (doc: Parsed, scope: string, entries: Record<string, unknown>) => {
  const scopes = { ...doc.scopes };
  if (Object.keys(entries).length) scopes[scope] = entries;
  else delete scopes[scope];
  return JSON.stringify({ ...doc.rest, v: Math.max(doc.v, DEFAULTS_VERSION), scopes });
};

/** How many times a write is tried again when another instance's write lands between reading and swapping. */
const SWAP_TRIES = 5;

export function defaultsDoc(file: DefaultsFile): DefaultsDoc {
  /** Reads, lets `change` decide from that read, and swaps it in; read again and decide again if the file moved. */
  const update = async <T>(change: (doc: Parsed) => { next?: string; result: T }): Promise<T> => {
    let raw = await file.read();
    for (let i = 0; i < SWAP_TRIES; i++) {
      const { next, result } = change(parse(raw));
      if (next === undefined) return result;
      const res = await file.swap(raw, next);
      if (res.swapped) return result;
      raw = res.current;
    }
    throw new Error("Another Hermes Chat kept changing the defaults; nothing was saved. Try again.");
  };
  return {
    read: async (scope) => {
      const out: Record<string, ProjectDefaults> = {};
      for (const [id, d] of Object.entries(ofScope(parse(await file.read()), scope))) {
        const kept = toDefaults(d);
        if (kept) out[id] = kept;
      }
      return out;
    },
    save: async (scope, id, base, draft) => {
      const problem = draftProblem(draft);
      if (problem) throw new Error(problem);
      const saved: ProjectDefaults = { rev: base + 1, ...cleanDraft(draft) };
      try {
        return await update((doc) => {
          if (doc.v > DEFAULTS_VERSION) throw new NewerDefaultsError();
          const entries = ofScope(doc, scope);
          const stored = toDefaults(entries[id]);
          if ((stored?.rev ?? 0) !== base) throw new DefaultsConflict(stored);
          return { next: withScope(doc, scope, { ...entries, [id]: saved }), result: saved };
        });
      } catch (e) {
        if (e instanceof DefaultsConflict || e instanceof NewerDefaultsError) throw e;
        throw new Error(`This computer couldn't keep them: ${errorText(e)}`);
      }
    },
    forget: (scope, id) =>
      update((doc) => {
        const entries = ofScope(doc, scope);
        if (doc.v > DEFAULTS_VERSION || !(id in entries)) return { result: undefined };
        const { [id]: _gone, ...left } = entries;
        return { next: withScope(doc, scope, left), result: undefined };
      }),
    moveScopes: (move) =>
      update((doc) => {
        const scopes = moveScopeKeys(doc.scopes, move);
        if (doc.v > DEFAULTS_VERSION || !scopes) return { result: undefined };
        return { next: JSON.stringify({ ...doc.rest, v: Math.max(doc.v, DEFAULTS_VERSION), scopes }), result: undefined };
      }),
  };
}

/**
 * `scopes` with each scope moved where `move` says (null drops it; undefined keeps it), a moved one replacing any
 * already there; undefined when nothing moves.
 */
export function moveScopeKeys<T>(scopes: Record<string, T>, move: (scope: string) => string | null | undefined): Record<string, T> | undefined {
  const moves = Object.keys(scopes).flatMap((s): [string, string | null][] => {
    const to = move(s);
    return to === undefined ? [] : [[s, to]];
  });
  if (!moves.length) return undefined;
  const next = { ...scopes };
  for (const [from] of moves) delete next[from];
  for (const [from, to] of moves) if (to !== null) next[to] = scopes[from];
  return next;
}

/** The app's file: `project-defaults.json` in its data folder, swapped under a lock every instance takes (defaults_file.rs). */
export const tauriDefaultsFile: DefaultsFile = {
  read: () => invoke<string | null>("project_defaults_read"),
  swap: (expected, next) => invoke("project_defaults_swap", { expected, next }),
};

/**
 * A stand-in kept in one webview's storage, for a browser in development and for tests. Only one webview uses it, and
 * its read-compare-write runs without a pause, so the swap holds there.
 */
export function storageDefaultsFile(storage: () => Pick<Storage, "getItem" | "setItem">, key = "hermes-chat.project-defaults"): DefaultsFile {
  return {
    read: async () => storage().getItem(key),
    swap: async (expected, next) => {
      const current = storage().getItem(key);
      if (current !== expected) return { swapped: false, current };
      storage().setItem(key, next);
      return { swapped: true, current: next };
    },
  };
}

/** The defaults the app keeps: in the app's file, or in the webview's storage outside the app. */
export const savedDefaultsFile: DefaultsFile =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriDefaultsFile : storageDefaultsFile(() => globalThis.localStorage);
export const savedDefaults = defaultsDoc(savedDefaultsFile);
