// Likely secrets in a chat export (exportChat.ts `exportPreview`), for the owner to redact before saving. Logs redact
// on their own (logs.ts); here the owner decides, so a flag only has to be likely. Chat is prose and code, though, so a
// value named like a password must also look like one: `password: required` and `api_key = os.environ` aren't flagged.
import { PROVIDER_KEY } from "./logs";

/** A likely secret: its kind, and the secret itself without what names it (in `password=hunter2!`, `hunter2!`). */
export type Secret = { kind: string; text: string; start: number };

// Text that stands for a secret instead of being one: masks, template slots, environment variables, sample names.
const PLACEHOLDER =
  /^(?:[*x•.#-]+|<[^>]*>|\[[^\]]*\]|\{\{?[^}]*\}\}?|\$\{?\w+\}?|%\w+%|(?:your|my|the|example|sample|some|insert|enter|replace|change|dummy|fake|test)\b[\w-]*|(?:your|example|sample|dummy|fake)_[\w-]*|password|passwd|secret|token|api[_-]?key|changeme|redacted|string|null|none|undefined|true|false|\.\.\.)$/i;

/**
 * A value given a password-like name that also looks like a password: a letter, and a digit or symbol; or a long run.
 * A `bare` (unquoted) one that reads as a member of an object (`os.environ`) is code.
 */
function looksSecret(value: string, bare: boolean): boolean {
  if (PLACEHOLDER.test(value) || (bare && /^[A-Za-z_]\w*(?:\.\w+)+$/.test(value))) return false;
  const mixed = /[A-Za-z]/.test(value) && /[^A-Za-z_-]/.test(value);
  return value.length >= 6 && (mixed || value.length >= 16);
}

const hasDigit = (value: string) => /\d/.test(value);

// The secret is a rule's first group that matched, or the whole match. `ok` turns a match down. `\\?["']` is a quote
// as written, or escaped in JSON, as a tool call's arguments are.
const RULES: { kind: string; re: RegExp; ok?: (value: string, m: RegExpMatchArray) => boolean }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // A scheme is at most 32 characters, and the JWT can't start just after a `-`: either way, a run like `a.a.a.…` or
  // `eyJa-eyJa-…` would be scanned again from each of its words, which takes seconds on 40 KB (#490).
  { kind: "password in a link", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#@:]+:([^\s/?#@]+)@/gi, ok: (v) => !PLACEHOLDER.test(v) },
  { kind: "API key", re: new RegExp(`\\b${PROVIDER_KEY}`, "g") },
  { kind: "sign-in token (JWT)", re: /\b(?<!-)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // In a header any token counts; in prose, "Bearer" and a long word must have a digit too.
  { kind: "bearer token", re: /\bauthorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi },
  { kind: "bearer token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi, ok: hasDigit },
  { kind: "bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  {
    kind: "password or key",
    // At most eight words name it (`aws_secret_access_key`), so `a-a-a-…` isn't scanned again from each word. A quoted
    // value runs to its closing quote, past escaped characters (`\"`) in it. Inside a JSON string (`\"…\"`), an
    // escaped backslash is `\\` and an escaped quote of the inner text is `\\\"`.
    re: /\b(?:[A-Za-z0-9]+[_-]){0,8}(?:password|passwd|pwd|passphrase|secret(?:[_-]?key)?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|token)(?:\\?["'])?\s*[:=]\s*(?:\\"((?:[^"\\\n]|\\\\\\"|\\\\)+)\\"|"((?:[^"\\\n]|\\.)+)"|'((?:[^'\\\n]|\\.)+)'|(?<bare>(?:[^\s,;&"'`()[\]{}<>\\]|\\(?!["']))+))/gi,
    ok: (value, m) => looksSecret(value, m.groups?.bare !== undefined),
  },
];

/** The likely secrets in `text`, in order, none overlapping another. A match inside one already found is dropped. */
export function findSecrets(text: string): Secret[] {
  const found: (Secret & { end: number })[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const group = m.slice(1).findIndex((g) => g !== undefined);
      const value = group < 0 ? m[0] : m[group + 1];
      if (rule.ok && !rule.ok(value, m)) continue;
      // A rule's secret group is the last thing it matches but a closing quote or `@`.
      const start = m.index + (group < 0 ? 0 : m[0].lastIndexOf(value));
      found.push({ kind: rule.kind, text: value, start, end: start + value.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Secret[] = [];
  let reach = 0;
  for (const f of found) {
    if (f.start < reach) continue;
    kept.push({ kind: f.kind, text: f.text, start: f.start });
    reach = f.end;
  }
  return kept;
}
