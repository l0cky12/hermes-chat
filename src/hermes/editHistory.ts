// Undo and redo for a text the owner edits, with no I/O: the artifact editor keeps one per open file (artifactEdit.ts
// `Snapshot`), the composer one per Draft (drafts.ts).

/** How long a pause in typing starts a new undo step, as editors do; anything but typing is always its own step. */
export const TYPING_PAUSE_MS = 1000;
/** Most undo steps kept, and most characters they hold in all; the oldest go first. */
export const HISTORY_MAX_STEPS = 200;
export const HISTORY_MAX_CHARS = 32 * 1024 * 1024;

/**
 * Undo and redo. `past` holds the states before each step, oldest first; `future` the states undone, the next redo
 * last. `typingAt` is when the step under way began taking typing, so a burst of typing is one step.
 */
export type History<S extends { text: string }> = { past: S[]; future: S[]; typingAt?: number };

export const emptyHistory = <S extends { text: string }>(): History<S> => ({ past: [], future: [] });

function trimmed<S extends { text: string }>(past: S[]): S[] {
  let out = past.length > HISTORY_MAX_STEPS ? past.slice(past.length - HISTORY_MAX_STEPS) : past;
  let chars = out.reduce((n, s) => n + s.text.length, 0);
  let drop = 0;
  // Always keeps the latest step, whatever its size.
  while (chars > HISTORY_MAX_CHARS && drop < out.length - 1) chars -= out[drop++].text.length;
  if (drop) out = out.slice(drop);
  return out;
}

/** `typing`: the owner typed it, so it joins the step under way unless they paused; any other change is a step of its own. */
export type EditKind = "typing" | "change";

/** The history after a change away from `before`. */
export function record<S extends { text: string }>(h: History<S>, before: S, kind: EditKind, now: number): History<S> {
  if (kind === "typing" && h.typingAt !== undefined && now - h.typingAt < TYPING_PAUSE_MS && h.past.length) return { ...h, future: [], typingAt: now };
  return { past: trimmed([...h.past, before]), future: [], typingAt: kind === "typing" ? now : undefined };
}

/** Steps back from `now`: the state to show, and the history after. Undefined when there's nothing to undo. */
export function undo<S extends { text: string }>(h: History<S>, now: S): { state: S; history: History<S> } | undefined {
  const state = h.past.at(-1);
  if (!state) return undefined;
  return { state, history: { past: h.past.slice(0, -1), future: [...h.future, now] } };
}

export function redo<S extends { text: string }>(h: History<S>, now: S): { state: S; history: History<S> } | undefined {
  const state = h.future.at(-1);
  if (!state) return undefined;
  return { state, history: { past: [...h.past, now], future: h.future.slice(0, -1) } };
}
