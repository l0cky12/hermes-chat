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
