// The text a message can start with when `hermes-chat --show` or `--toggle` brings the window forward from another app
// (ADR 0172): what is selected there (the PRIMARY selection, on Linux) if it changed since the window last lost focus,
// or else what was copied there if that changed. Text that hasn't changed is what the owner already had here, so it
// never starts a message twice. It goes into the composer and nowhere else until the owner sends it.

/** What Rust read: `undefined` where empty, unreadable, too long or marked as a password. */
export type Selections = { primary?: string; clipboard?: string };

/** What the selections held when last read, to tell new text from text the owner already had. */
export class SelectionWatch {
  private last: Selections = {};

  remember(now: Selections) {
    this.last = now;
  }

  /** The selection that changed since the last read, PRIMARY first; `now` is remembered either way. */
  take(now: Selections): string | undefined {
    const last = this.last;
    this.last = now;
    if (now.primary !== undefined && now.primary !== last.primary) return now.primary;
    if (now.clipboard !== undefined && now.clipboard !== last.clipboard) return now.clipboard;
    return undefined;
  }
}

/** `text` as a quote for a message to start with: each line after `> `, then a blank line for the owner's question. */
export function quoted(text: string): string {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .replace(/^(?:[ \t]*\n)+/u, "")
    .trimEnd()
    .split("\n");
  return `${lines.map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Resolves once the window has focus, or after `ms`: on Wayland an app reads the selections only while it has focus. */
export function untilFocused(ms = 1500): Promise<void> {
  return new Promise((done) => {
    if (document.hasFocus()) return done();
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("focus", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    window.addEventListener("focus", finish);
  });
}
