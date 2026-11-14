// How the window learns it was brought forward by `hermes-chat --show`, `--toggle`, a second launch or a chat link
// (src-tauri/src/summon.rs), so the cursor goes back in the composer. There is no global shortcut in the app; a key is
// bound in the desktop's own config to run `hermes-chat --toggle`. The text selected in the app the owner came from
// can start a message (selection.ts, ADR 0172).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Selections } from "./selection";

/** `fromElsewhere`: another app had focus and the owner asked for the window itself, not a chat link. */
export type Summoned = { fromElsewhere: boolean };

export type SummonApi = {
  /** Calls `fn` each time the window is brought forward. */
  onSummoned: (fn: (s: Summoned) => void) => () => void;
  /** The text selected and copied in other apps, as Rust reads it (selection.rs); none where it can't be read. */
  readSelection?: () => Promise<Selections>;
};

export const tauriSummon: SummonApi = {
  onSummoned: (fn) => {
    const stop = listen<Summoned | null>("summoned", (e) => fn({ fromElsewhere: e.payload?.fromElsewhere === true })).catch(() => undefined);
    return () => void stop.then((s) => s?.());
  },
  readSelection: () => invoke<{ primary?: string | null; clipboard?: string | null }>("read_selection").then((s) => ({ primary: s.primary ?? undefined, clipboard: s.clipboard ?? undefined })),
};

/** The real one in the desktop app; none in a browser. */
export const desktopSummon: SummonApi | undefined =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriSummon : undefined;
