// The real screenshot calls: Rust takes and stages captures (src-tauri/src/screenshot.rs), and tells the webview when
// `hermes-chat --screenshot` asks for one from a desktop shortcut (src-tauri/src/remote.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { outboxAttachmentPaths, subscribeOutbox } from "./chatCache";
import type { Captured, ScreenshotApi } from "./screenshots";

export const tauriScreenshots: ScreenshotApi = {
  // Rust rejects with `{ kind, message }`, which the desk reads as it is.
  capture: (name) => invoke<Captured>("screenshot_capture", { name }),
  discard: (path) => invoke<void>("screenshot_discard", { path }),
};

/** How screenshots are taken on this desktop, for Settings. `ok` false: a capture will fail, and `summary` says why. */
export type ScreenshotSupport = { ok: boolean; summary: string };
export const screenshotSupport = () => invoke<ScreenshotSupport>("screenshot_support");

/**
 * Calls `fn` whenever a desktop shortcut asks for a screenshot. Rust keeps the request until a window takes it, so one
 * made before this window was signed in (or one that started the app) is taken now, if it's recent.
 */
export function onDesktopScreenshot(fn: () => void): () => void {
  let live = true;
  let running = false;
  let again = false;
  const take = async () => {
    again = true;
    if (running || !live) return;
    running = true;
    try {
      while (live && again) {
        again = false;
        const id = await invoke<number | null>("screenshot_pending_request");
        // Cleanup may have run while Rust answered. No acknowledgement: the next live window will take it.
        if (!live) return;
        if (id !== null) {
          fn();
          await invoke<void>("screenshot_ack_request", { id });
        }
      }
    } catch {
      // Outside the desktop app there is no Rust to ask.
    } finally {
      running = false;
    }
  };
  // Listen before peeking, so a request made during registration is also observed.
  const stop = listen("screenshot-requested", () => void take()).then((unlisten) => {
    if (live) void take();
    return unlisten;
  }).catch(() => undefined);
  return () => {
    live = false;
    void stop.then((s) => s?.());
  };
}

/** Brings the window forward, so the owner can review a screenshot a desktop shortcut attached. */
export const showWindow = () => invoke<void>("screenshot_show_window").catch(() => {});

// Serialize reconciliation, reading the latest outboxes when the work runs. Retry removes the old row and adds the
// new one synchronously; looking after that completes never deletes a file in between those two rows.
let syncing = Promise.resolve();
export function syncScreenshotOutbox(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  syncing = syncing.catch(() => {}).then(() => invoke<void>("screenshot_sync_outbox", { paths: outboxAttachmentPaths() }));
  return syncing;
}
subscribeOutbox(() => void syncScreenshotOutbox().catch(() => {}));
