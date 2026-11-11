// Drafts and outboxes whose last write to localStorage failed (the store is full, say). Their stores keep them in
// memory until the app closes; this keeps the latest value by key too, so a restart for an update still saves them
// (updates.ts `snapshotDrafts`). null: the key was being deleted.
export const unsaved = new Map<string, string | null>();

/**
 * Messages on their way that no outbox holds yet (a New chat send, while its chat is started), each with the draft key
 * it was taken from. An update's restart keeps them as that draft (updates.ts `snapshotDrafts`), and marks them
 * `captured`: such a message never goes, since the restarted app has it as a draft.
 */
export type Sending = { key: string; text: string; captured?: boolean };
export const sending = new Set<Sending>();

/**
 * Set while an update's restart is under way, from the moment it takes its snapshot: no queued message goes
 * meanwhile, since the restarted app puts back the queue as the snapshot had it (ADR 0018). Cleared if the restart fails.
 */
export const restartHold = { on: false };

/** Writes `value` under `key` (null deletes it), and notes it here if the write fails or there's no storage. False: it failed. */
export function persist(storage: () => Pick<Storage, "setItem" | "removeItem">, key: string, value: string | null): boolean {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.set(key, value);
    return false;
  }
}

/**
 * Files staged in every chat's composer and not sent yet, by screenshot desk (one for each signed-in window), whether
 * or not the chat is on screen. An update's restart doesn't keep them (a draft is text only, and a screenshot staged
 * there is deleted at the next launch), so Settings names them before the owner restarts (UpdateSettings).
 */
export const stagedFiles = (() => {
  const by = new Map<object, readonly { name: string }[]>();
  const listeners = new Set<() => void>();
  let names: readonly string[] = [];
  const changed = () => {
    names = [...by.values()].flatMap((files) => files.map((f) => f.name));
    listeners.forEach((fn) => fn());
  };
  return {
    /** `files` is what `desk` has staged now; none forgets it. */
    set(desk: object, files: readonly { name: string }[]) {
      if (!files.length && !by.has(desk)) return;
      if (files.length) by.set(desk, files);
      else by.delete(desk);
      changed();
    },
    getSnapshot: () => names,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
})();
