// Asking before the window closes, for an unsaved persona edit. Registered only while there is one: while a close
// listener is registered, Tauri leaves closing to the webview.
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Calls `ask` instead of closing the window, with a function that closes it anyway. Resolves to the function that
 * stops asking.
 */
export type CloseGuard = (ask: (close: () => void) => void) => Promise<() => void>;

export const tauriCloseGuard: CloseGuard = async (ask) => {
  const win = getCurrentWindow();
  return win.onCloseRequested((e) => {
    e.preventDefault();
    ask(() => void win.destroy());
  });
};
