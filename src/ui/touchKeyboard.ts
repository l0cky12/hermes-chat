// The Windows touch keyboard over the bottom of the window (touch_keyboard.rs, ADR 0130). Windows lays the docked
// keyboard over the window without resizing it, so the page's root gives up the height it covers (`--touch-keyboard`
// in styles.css) and the composer sits just above it. Nothing else tells the page where the keyboard is (#375).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Shortens the page by `covered` CSS pixels at the bottom, or back to the full window at 0. */
function setTouchKeyboardCover(covered: number, root: HTMLElement = document.documentElement) {
  if (covered > 0) root.style.setProperty("--touch-keyboard", `${covered}px`);
  else root.style.removeProperty("--touch-keyboard");
}

/**
 * Follows what the keyboard covers, from Rust. Called once, at startup; only Windows sends it. Once listening, it asks
 * Rust how things stand, so a keyboard already up when the page started (or reloaded) is made room for too.
 */
export async function followTouchKeyboard(): Promise<void> {
  try {
    let heard = false;
    await listen<{ covered: number }>("touch-keyboard", (e) => {
      heard = true;
      setTouchKeyboardCover(e.payload.covered);
    });
    const now = await invoke<number>("touch_keyboard_covered");
    // An event that came while asking is newer than the answer.
    if (!heard) setTouchKeyboardCover(now);
  } catch {
    // Outside the desktop app there is no window for a keyboard to cover.
  }
}
