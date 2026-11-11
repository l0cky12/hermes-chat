// The app's update store, on the Rust commands in src-tauri/src/update.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";
import { clearCachedChats } from "./chatCache";
import { updater, type Progress } from "./updates";
import { errorText } from "./values";

export const appUpdates = updater({
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args).catch(asError),
  channel: (onMessage) => {
    const channel = new Channel<Progress>();
    channel.onmessage = onMessage;
    return channel;
  },
  fetch: (...args) => fetch(...args),
  storage: localStorage,
  clearCache: clearCachedChats,
});

/**
 * Puts back the drafts saved by an update's restart. Runs before the app first renders, so no draft is read before.
 * Resolves to why it couldn't finish: the saved copy is still there to be put back, so the app mustn't open for
 * editing, or the next launch would put it back over the edits.
 */
export async function restoreDraftsAfterRestart(): Promise<string | undefined> {
  if (!("__TAURI_INTERNALS__" in window)) return; // A browser, in development: nothing was saved.
  try {
    await appUpdates.restoreAfterRestart();
  } catch (e) {
    return errorText(e);
  }
}
