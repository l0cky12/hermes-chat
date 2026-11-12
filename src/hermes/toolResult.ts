// What the app keeps of a tool's result (ADR 0061). Hermes sends a tool's whole result with `tool.complete`, and a
// `computer_use` capture's carries its screenshot inline, as a base64 data URL: about 590 KB of text for the 1440x900
// Bot Desktop, every step. The chat would keep it as text nobody can read, pretty-printed, and its Saved copy would
// outgrow the local limit. So inline data is swapped for a short note saying what it was, as Hermes's own history does
// with `inline_images=false`; everything else in the result is kept as it came.
import { formatBytes } from "./values";

/** Data shorter than this is left alone: it costs nothing and may be what the owner wants to read. */
const MIN_DATA_CHARS = 1024;
/** A string that is nothing but base64, with no spaces or line breaks, at least this long, is data, not text. */
const MIN_BARE_BASE64_CHARS = 4096;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** `data:<mime>[;param=value…];base64,<data>`. */
const DATA_URL = /data:([a-z]+\/[\w.+-]+)?((?:;[\w.+-]+=[\w.+-]+)*);base64,([A-Za-z0-9+/]+={0,2})/gi;

/** The note left in place of `chars` characters of base64. */
function note(mime: string | undefined, chars: number): string {
  return `[${mime ?? "data"}, ${formatBytes(Math.round((chars * 3) / 4))}, not kept in the chat]`;
}

function withoutData(s: string): string {
  if (s.length >= MIN_BARE_BASE64_CHARS && BARE_BASE64.test(s)) return note(undefined, s.length);
  if (s.length < MIN_DATA_CHARS || !/;base64,/i.test(s)) return s;
  return s.replace(DATA_URL, (whole: string, mime: string | undefined, _params: string, data: string) =>
    whole.length < MIN_DATA_CHARS ? whole : note(mime?.toLowerCase(), data.length),
  );
}

/** `value` with every inline data URL, and every long bare base64 string, swapped for a note. */
export function withoutInlineData(value: unknown): unknown {
  if (typeof value === "string") return withoutData(value);
  if (Array.isArray(value)) return value.map(withoutInlineData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutInlineData(v)]));
  return value;
}

/** A `tool.complete` result as the chat shows and keeps it: text as it came, anything else as indented JSON. */
export function toolResultText(result: unknown): string | undefined {
  if (result == null) return undefined;
  const kept = withoutInlineData(result);
  return typeof kept === "string" ? kept : JSON.stringify(kept, null, 2);
}
