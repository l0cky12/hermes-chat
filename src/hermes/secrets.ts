// Secrets in text (ADR 0148): one table of the shapes a secret takes, and the values a caller already knows. Every
// surface that hides secrets on its own (Logs and the support bundle, troubleshooting chats, server facts, gateway
// errors, connection attempts) replaces every shape (`redactSecrets`), so no surface shows what another hides. A chat
// export flags them instead (`findSecrets`, exportChat.ts `exportPreview`), redacted unless the owner keeps one. Chat
// is prose and code, and a flag redacts by default, so there a shape can turn down what reads as ordinary chat:
// `password: required` and `api_key = os.environ` aren't flagged.

/** Text that stands for what was taken out. */
export const REDACTED = "[redacted]";

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

const when = (ok: (value: string) => boolean) => (value: string) => (ok(value) ? value : undefined);

type Shape = {
  /** What the support bundle and the Logs screen call it. */
  kind: string;
  /** What the export dialog calls it, where that differs. */
  label?: string;
  /** The secret is the first group, or the whole match. Every one has the `d` flag. */
  re: RegExp;
  /**
   * What a chat export matches with, where it differs from `re`. A redacting surface matches with both, so what `re`
   * runs past (`get_token(password=` in `token = get_token(password="…")`) can't hide a secret after it.
   */
  chatRe?: RegExp;
  /** What takes the secret's place. */
  mark: string;
  /**
   * What of a match a chat flags, if anything: the value without its quotes, and whether it had none. Without this,
   * all of it.
   */
  flag?: (value: string, bare: boolean) => string | undefined;
};

// A secret's name and what joins it to its value. Named by up to eight words joined by `-` or `_`, or by any number
// joined by `_` (`aws_secret_access_key`).
const NAMED_VALUE = String.raw`\b(?:[A-Za-z0-9]+_)*(?:[A-Za-z0-9]+[_-]){0,8}(?:api[_-]?key|apikey|token|secret(?:[_-]?key)?|password|passwd|pwd|passphrase|credentials?|private[_-]?key|access[_-]?key|session[_-]?(?:id|token)|signature)(?:\\?["'])?\s*[:=]\s*(?!\[redacted)`;
// A quoted value runs to its closing quote, past escaped characters (`\"`) in it; failing that, to the next quote.
// Inside a JSON string (`\"…\"`), an escaped backslash is `\\` and an escaped quote of the inner text is `\\\"`.
const QUOTED_VALUE = String.raw`\\"(?:[^"\\\n]|\\\\\\"|\\\\)+\\"|"(?:[^"\\]|\\.)*"|"[^"]*"|'(?:[^'\\]|\\.)*'|'[^']*'`;

// Order breaks ties: of two that take the same text, the first's mark and kind stand. A value already redacted isn't
// matched again (`(?!\[redacted)`). `\\?["']` is a quote as written, or escaped in JSON, as a tool call's arguments are.
// No shape may scan a run again from each of its words, which takes seconds on 40 KB (#490): a scheme is at most 32
// characters, and a JWT doesn't start inside a run that one already started in.
const SHAPES: Shape[] = [
  {
    kind: "private key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/dg,
    mark: "[redacted private key]",
  },
  // A header's whole value: a quoted string (JSON, a Python dict), or the rest of the line (Digest has several parts).
  // In a chat only a scheme and one credential count: the rest of a line there is often a command's next arguments.
  {
    kind: "authorization header",
    re: /\b(?:proxy-)?authorization(?:\\?["'])?\s*[:=]\s*(?!\[redacted)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n]+)/dgi,
    mark: REDACTED,
    flag: when((v) => /^(?!bearer\b)[a-z]+ +[A-Za-z0-9._~+/-]{8,}=*$/i.test(v)),
  },
  {
    kind: "cookie",
    re: /\b(?:set-)?cookie(?:\\?["'])?\s*[:=]\s*(?!\[redacted)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n]+)/dgi,
    mark: REDACTED,
    flag: when(
      (v) =>
        /^[^\s=;]+=[^\s;]+(?:;\s*[^\s=;]+(?:=[^\s;]*)?)*;?$/.test(v) && v.split(";").some((p) => looksSecret(p.slice(p.indexOf("=") + 1), true)),
    ),
  },
  { kind: "bearer token", re: /\bauthorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)/dgi, mark: REDACTED },
  // In prose, "Bearer" and a long word must have a digit too.
  {
    kind: "bearer token",
    re: /\bbearer\s+(?!\[redacted)([A-Za-z0-9._~+/=-]{8,})/dgi,
    mark: REDACTED,
    flag: when((v) => v.replace(/=+$/, "").length >= 16 && /\d/.test(v)),
  },
  // A token can be the user name alone (`https://sk_abc@host/`), so any user part counts, up to the last `@` before the
  // path. An SSH login alone (`ssh://liam@hermes`, how a route is named) is no secret, and support needs to see it.
  {
    kind: "URL credentials",
    label: "password in a link",
    re: /\b(?!ssh:\/\/[^\s/:@]+@)[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/]+)@/dgi,
    mark: REDACTED,
    flag: when((v) => (v.includes(":") ? !PLACEHOLDER.test(v.slice(v.indexOf(":") + 1)) : looksSecret(v, true))),
  },
  {
    kind: "URL query secret",
    label: "password or key",
    re: /[?&](?:[a-z0-9]+[_-])*(?:ticket|token|key|auth|sig)=(?!\[redacted)([^&\s"'#]+)/dgi,
    mark: REDACTED,
    flag: when((v) => looksSecret(v, true)),
  },
  {
    kind: "JSON web token",
    label: "sign-in token (JWT)",
    re: /\b(?<!\beyJ[A-Za-z0-9_-]*?-)eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/dg,
    mark: "[redacted token]",
  },
  {
    // The AI providers', GitHub's, Slack's and cloud API keys.
    kind: "provider key",
    label: "API key",
    re: /\b(?:sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|r8_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,})/dg,
    mark: "[redacted key]",
  },
  // Telegram's (`123456:AA…`, right after "bot" in its API's URLs) and Discord's (three dotted base64 parts). In a chat a
  // Discord one must start with mixed-case base64 and a digit, which a dotted name in code (`app_settings.base.X`) hasn't.
  {
    kind: "bot token",
    re: /(?<!\d)\d{5,}:[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/dg,
    mark: "[redacted token]",
    flag: when((v) => v.includes(":") || /^(?=[^.]*[a-z])(?=[^.]*[A-Z])(?=[^.]*\d)[A-Za-z0-9]+\./.test(v)),
  },
  // A line that is all base64, 16 or more wide: the body of a PEM or OpenSSH key whose start wasn't read (64 and 70 wide,
  // and a shorter last row). The log follower also redacts shorter rows just above an END line it reads. Never flagged
  // in a chat, where such a line is as often a public key, a certificate or a hash.
  { kind: "key-like base64 line", re: /^[A-Za-z0-9+/]{16,}={0,2}$/dgm, mark: "[redacted base64]", flag: () => undefined },
  {
    kind: "secret value",
    label: "password or key",
    re: new RegExp(String.raw`${NAMED_VALUE}(${QUOTED_VALUE}|[^\s,;&"'}\]]+)`, "dgi"),
    // A chat's unquoted value ends before a bracket, where code goes on, so a name inside the call
    // (`token = get_token(password="…")`) is matched on its own.
    chatRe: new RegExp(String.raw`${NAMED_VALUE}(${QUOTED_VALUE}|[^\s,;&"'}\]()[{<>${"`"}]+)`, "dgi"),
    mark: REDACTED,
    flag: (v, bare) => (looksSecret(v, bare) ? v : undefined),
  },
];

/** The kinds of secret `redactSecrets` looks for, as the support bundle lists them. */
export const REDACTED_KINDS = [...new Set(SHAPES.map((s) => s.kind))];

type Match = { shape: Shape; order: number; start: number; end: number };

function matches(text: string, pick: (shape: Shape) => RegExp | undefined): Match[] {
  return SHAPES.flatMap((shape, order) => {
    const re = pick(shape);
    return [...(re ? text.matchAll(re) : [])].map((m) => {
      const [start, end] = m.indices?.[1] ?? [m.index, m.index + m[0].length];
      return { shape, order, start, end };
    });
  });
}

const firstThenLongest = <T extends { start: number; end: number }>(a: T, b: T) => a.start - b.start || b.end - a.end;

/**
 * `text` with every secret shape replaced by its mark, and the kind of each one replaced. Overlapping secrets are one
 * replacement, named for the one that starts first.
 */
export function redactSecrets(text: string): { text: string; kinds: string[] } {
  const found = [...matches(text, (s) => s.re), ...matches(text, (s) => s.chatRe)].sort((a, b) => firstThenLongest(a, b) || a.order - b.order);
  const replaced: Match[] = [];
  let out = "";
  let at = 0;
  for (let k = 0; k < found.length; ) {
    const first = found[k];
    let end = first.end;
    while (++k < found.length && found[k].start < end) end = Math.max(end, found[k].end);
    out += text.slice(at, first.start) + first.shape.mark;
    at = end;
    replaced.push(first);
  }
  replaced.sort((a, b) => a.order - b.order || a.start - b.start);
  return { text: out + text.slice(at), kinds: replaced.map((m) => m.shape.kind) };
}

/** A matched value without the quotes around it, where it starts within the match, and whether it had none. */
function unquoted(raw: string): { value: string; offset: number; bare: boolean } {
  if (raw.length >= 4 && raw.startsWith('\\"') && raw.endsWith('\\"')) return { value: raw.slice(2, -2), offset: 2, bare: false };
  if (raw.length >= 2 && /^["']/.test(raw) && raw.endsWith(raw[0])) return { value: raw.slice(1, -1), offset: 1, bare: false };
  return { value: raw, offset: 0, bare: true };
}

/** The likely secrets in `text`, in order, none overlapping another. A match inside one already found is dropped. */
export function findSecrets(text: string): Secret[] {
  const found: (Secret & { end: number })[] = [];
  for (const m of matches(text, (s) => s.chatRe ?? s.re)) {
    const { value, offset, bare } = unquoted(text.slice(m.start, m.end));
    const flagged = m.shape.flag ? m.shape.flag(value, bare) : value;
    if (!flagged) continue;
    const start = m.start + offset;
    found.push({ kind: m.shape.label ?? m.shape.kind, text: flagged, start, end: start + flagged.length });
  }
  found.sort(firstThenLongest);
  const kept: Secret[] = [];
  let reach = 0;
  for (const f of found) {
    if (f.start < reach) continue;
    kept.push({ kind: f.kind, text: f.text, start: f.start });
    reach = f.end;
  }
  return kept;
}

// What ends a word around a known value, for `word`.
const EDGE = /[\s"'(){}<>,;:/@[\]]/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * `text` with every place one of `values` stands replaced by `[redacted]`, and how many places that was. Overlapping and
 * touching places become one, so no order of values leaves part of one behind. A value under 4 characters counts only
 * where no letter or digit is beside it, so `ab` doesn't eat every word with "ab" in it, unless `anywhere` (text the
 * owner picked). With `word`, a place takes the whole word around it, up to a space, quote, bracket or `,;:/@`.
 */
export function redactValues(text: string, values: readonly string[], how: { anywhere?: boolean; word?: boolean } = {}): { text: string; places: number } {
  const spans: [number, number][] = [];
  for (const v of values) {
    if (!v) continue;
    // A place wholly inside a word already taken for `v` would take no more than that word, and walking the word again
    // for each one is quadratic in a long run of `v`.
    let taken = -1;
    for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) {
      let [start, end] = [i, i + v.length];
      if (how.word && end <= taken) continue;
      if (!how.anywhere && v.length < 4 && (ALNUM.test(text[start - 1] ?? "") || ALNUM.test(text[end] ?? ""))) continue;
      if (how.word) {
        while (start > 0 && !EDGE.test(text[start - 1])) start--;
        while (end < text.length && !EDGE.test(text[end])) end++;
        taken = end;
      }
      spans.push([start, end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  let places = 0;
  for (let k = 0; k < spans.length; places++) {
    const start = spans[k][0];
    let end = spans[k++][1];
    while (k < spans.length && spans[k][0] <= end) end = Math.max(end, spans[k++][1]);
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return { text: out + text.slice(at), places };
}
