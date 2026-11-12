/**
 * An error's message, also from what isn't an `Error` here (a rejected Tauri `invoke`, a JSON error body, a
 * DOMException from another realm), else the thrown value as text.
 */
export const errorText = (e: unknown): string => {
  const message = isObj(e) ? e.message : undefined;
  return typeof message === "string" && message ? message : String(e);
};

/** A plain object, not `null` or an array: what a JSON object parses to. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `n` and the word that goes with it: `plural(1, "chat")` is "1 chat", `plural(2, "reply", "replies")` is "2 replies". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `v` if it's a string, else "". */
export const textOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");

/** `v` if it's a string of at most `max` characters, empty included, else undefined. */
export const optionalText = (v: unknown, max = Infinity): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** `v` if it's a string of 1 to `max` characters, else undefined. */
export const nonEmptyText = (v: unknown, max = Infinity): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** `v`, untrimmed, if it's a string of at most `max` characters with something besides whitespace, else undefined. */
export const nonBlankText = (v: unknown, max = Infinity): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);

const SIZE_UNITS = ["KB", "MB", "GB"];

/** A byte count in 1024s, one decimal under 10: "512 B", "1.5 KB", "25 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let n = bytes / 1024;
  let unit = 0;
  while (Math.round(n) >= 1024 && unit < SIZE_UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${SIZE_UNITS[unit]}`;
}

/** A time of day, hours and minutes, as the desktop's locale writes it ("3:45 PM", "15:45"); `tag` picks another locale. */
export const clockTime = (ms: number, tag?: string) => new Date(ms).toLocaleTimeString(tag, { timeStyle: "short" });

/** A time of day with seconds, as the desktop's locale writes it ("3:45:07 PM", "15:45:07"). */
export const clockTimeWithSeconds = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { timeStyle: "medium" });
