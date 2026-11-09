// The Logs screen's sources (ADR 0033). Two kinds:
//
// - This app: the app's own diagnostics (connection changes, failures it showed, uncaught errors, console warnings),
//   kept in memory for this run of the app only, in `appLog`.
// - Hermes logs: the dashboard's `GET /api/logs?file=&lines=&profile=` (hermes_cli/web_routers/status.py at `bf0203a`),
//   which answers `{file, lines}`: the last `lines` lines (at most 500) of one of the profile's log files under
//   `$HERMES_HOME/logs/`. It has no cursor and no stream, so following polls it, and each answer is matched against
//   the one before to find the lines that are new (`since`). When the two don't overlap, lines may have been missed,
//   and the screen says so rather than guessing.
//
// Every line loses its terminal color codes, is redacted (`redact`) and has its other control characters written out
// (`visible`) before it is kept, so neither
// the screen nor an export ever holds the raw text. Redaction knows common secret shapes; it can't promise to find
// every secret in free text, and the screen says that too.

import { failureOf } from "./toolsets";

export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export const LEVELS: readonly Level[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const RANK: Record<Level, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };

/** One kept line, or a note the app put between lines: where reading stopped, or where lines may be missing. */
export type Entry =
  | { seq: number; kind: "line"; text: string; level?: Level; at: number; redacted?: string[] }
  | { seq: number; kind: "mark"; text: string; at: number };

// ---------- redaction ----------

type Rule = { kind: string; re: RegExp; to: string };
/** The shapes of the AI providers', GitHub's, Slack's and cloud API keys, as a RegExp source. Also flags them in an export (secrets.ts). */
export const PROVIDER_KEY =
  "(?:sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|r8_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,})";
// Order matters: header-shaped rules go first, so `Authorization: Bearer x` is one redaction, not two. A value already
// redacted isn't matched again (`(?!\[redacted)`).
const RULES: Rule[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, to: "[redacted private key]" },
  // A header's whole value: a quoted string (JSON, a Python dict), or the rest of the line (Digest has several parts).
  { kind: "authorization header", re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*)(?!\[redacted)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n]+)/gi, to: "$1[redacted]" },
  { kind: "cookie", re: /\b((?:set-)?cookie["']?\s*[:=]\s*)(?!\[redacted)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n]+)/gi, to: "$1[redacted]" },
  { kind: "bearer token", re: /\b(bearer\s+)(?!\[redacted)[A-Za-z0-9._~+/=-]{8,}/gi, to: "$1[redacted]" },
  // A token can be the user name alone (`https://sk_abc@host/`), so any user part counts, up to the last `@` before the
  // path. An SSH login alone (`ssh://liam@hermes`, how a route is named) is no secret, and support needs to see it.
  { kind: "URL credentials", re: /(\b(?!ssh:\/\/[^\s/:@]+@)[a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, to: "$1[redacted]@" },
  { kind: "URL query secret", re: /([?&](?:[a-z0-9]+[_-])*(?:ticket|token|key|auth|sig)=)(?!\[redacted)[^&\s"'#]+/gi, to: "$1[redacted]" },
  { kind: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, to: "[redacted token]" },
  {
    kind: "provider key",
    re: new RegExp(`\\b${PROVIDER_KEY}`, "g"),
    to: "[redacted key]",
  },
  { kind: "bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, to: "[redacted token]" },
  // A line that is all base64, 16 or more wide: the body of a PEM or OpenSSH key whose start wasn't read (64 and 70 wide,
  // and a shorter last row). The follower also redacts shorter rows just above an END line it reads.
  { kind: "key-like base64 line", re: /^[A-Za-z0-9+/]{16,}={0,2}$/gm, to: "[redacted base64]" },
  {
    kind: "secret value",
    re: /(\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|passphrase|credentials?|private[_-]?key|access[_-]?key|session[_-]?(?:id|token)|signature)["']?\s*[:=]\s*)(?!\[redacted)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi,
    to: "$1[redacted]",
  },
];

/** The kinds of secret `redact` looks for, as the support bundle lists them. */
export const REDACTED_KINDS = RULES.map((r) => r.kind);

/** `text` with the secrets it recognizes replaced by `[redacted]`, and the kind of each one replaced. */
export function redact(text: string): { text: string; kinds: string[] } {
  const kinds: string[] = [];
  for (const rule of RULES) {
    text = text.replace(rule.re, (...m) => {
      kinds.push(rule.kind);
      // `$n` in `to`, from the match's groups.
      return rule.to.replace(/\$(\d)/g, (_, n: string) => (m[Number(n)] as string | undefined) ?? "");
    });
  }
  return { text, kinds };
}

// C0 and C1 controls but tab and newline, DEL, and the bidi marks and overrides that can make text read in another
// order than it is.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` with terminal escapes and other control characters written out (`\x1b`), so they show and do nothing. */
export const visible = (text: string) =>
  text.replace(CONTROL, (c) => {
    const n = c.codePointAt(0)!;
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });

// A terminal's CSI sequences: colors, cursor moves, screen clears. Removed before redaction, since a color code right
// before a secret (`\x1b[1mBearer …`) would hide it from the patterns' word boundaries.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** What a line keeps: without terminal color and cursor codes, redacted, then with other controls written out. */
export function clean(raw: string): { text: string; redacted?: string[] } {
  const r = redact(raw.replace(CSI, ""));
  return { text: visible(r.text), ...(r.kinds.length && { redacted: r.kinds }) };
}

// ---------- levels and filters ----------

// Hermes's own line shape (hermes_cli/logs.py `_TS_RE`, `_LEVEL_RE`): "2026-04-05 22:35:00,123 INFO name: message".
const STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const LEVEL = /\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s/;

/** A line's level, or for a line without a time stamp (a traceback frame), the level of the record it continues. */
export function levelOf(line: string, before?: Level): Level | undefined {
  if (!STAMP.test(line)) return before;
  return (LEVEL.exec(line)?.[1] as Level | undefined) ?? undefined;
}

export type Filter = { min?: Level; text?: string };

/** Notes always pass. A line with no level passes any level, as Hermes's own filter has it. */
export function passes(e: Entry, f: Filter): boolean {
  if (e.kind === "mark") return true;
  if (f.min && e.level && RANK[e.level] < RANK[f.min]) return false;
  const needle = f.text?.trim().toLowerCase();
  return !needle || e.text.toLowerCase().includes(needle);
}

// ---------- the ring buffer ----------

export type Snapshot = { entries: readonly Entry[]; dropped: number; lines: number };

/**
 * The entries of one source, at most `capacity`: the oldest go once it's full, and `dropped` counts them. Listeners
 * hear of changes at most every `NOTIFY_MS`, so a burst of lines is one render.
 */
export class LogBuffer {
  private entries: Entry[] = [];
  private dropped = 0;
  private seq = 0;
  private lines = 0;
  private snap?: Snapshot;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(readonly capacity: number) {}

  add(items: ({ kind: "line"; text: string; level?: Level; at: number; redacted?: string[] } | { kind: "mark"; text: string; at: number })[]) {
    if (!items.length) return;
    for (const it of items) {
      this.entries.push({ ...it, seq: ++this.seq } as Entry);
      if (it.kind === "line") this.lines++;
    }
    const over = this.entries.length - this.capacity;
    if (over > 0) {
      for (const e of this.entries.splice(0, over)) if (e.kind === "line") (this.dropped++, this.lines--);
    }
    this.snap = undefined;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const fn of this.listeners) fn();
    }, NOTIFY_MS);
  }

  readonly getSnapshot = (): Snapshot => (this.snap ??= { entries: this.entries.slice(), dropped: this.dropped, lines: this.lines });
  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}

const NOTIFY_MS = 100;

// ---------- this app's diagnostics ----------

/** This app's own diagnostics, for this run only. */
export const appLog = new LogBuffer(2000);
const ENTRY_MAX = 8000;

/** Adds one diagnostic to `log` (the app's own by default), redacted and cut to a readable length. */
export function note(level: Level, text: string, log = appLog, now = Date.now()) {
  const cut = text.length > ENTRY_MAX ? `${text.slice(0, ENTRY_MAX)} … (${text.length - ENTRY_MAX} more characters)` : text;
  log.add([{ kind: "line", level, at: now, ...clean(cut) }]);
}

const shown = (v: unknown): string => {
  if (v instanceof Error) return v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ""}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * Starts keeping the app's console warnings and errors, uncaught errors and unhandled rejections in `appLog`. Called
 * once at startup (main.tsx); the console still gets everything.
 */
export function captureAppDiagnostics(win: Window = window, con: Console = console) {
  for (const [method, level] of [["error", "ERROR"], ["warn", "WARNING"]] as const) {
    const original = con[method].bind(con);
    con[method] = (...args: unknown[]) => {
      note(level, args.map(shown).join(" "));
      original(...args);
    };
  }
  win.addEventListener("error", (e) => note("ERROR", `Uncaught error: ${e.error ? shown(e.error) : e.message}`));
  win.addEventListener("unhandledrejection", (e) => note("ERROR", `Unhandled rejection: ${shown(e.reason)}`));
}

// ---------- Hermes's logs ----------

/** The log files the Logs screen reads, as `GET /api/logs` names them (hermes_cli/logs.py `LOG_FILES`). */
export const REMOTE_LOGS = {
  agent: { label: "Hermes agent", file: "agent.log" },
  errors: { label: "Hermes errors", file: "errors.log" },
  gateway: { label: "Hermes gateway", file: "gateway.log" },
  mcp: { label: "MCP servers", file: "mcp-stderr.log" },
} as const;
export type RemoteLog = keyof typeof REMOTE_LOGS;

/** Hermes answers at most this many lines (`min(lines, 500)`), so that's what each read asks for. */
export const TAIL = 500;

/**
 * Where the lines new since `prev` start in `next`, both answers for the last `limit` lines of a file. A file that only
 * grew has `prev`'s end at `next`'s start, and the longest such overlap is taken. No overlap means lines were missed:
 * the file was rotated or emptied (its whole content is shorter than `limit`), or more than `limit` lines came between
 * the reads.
 */
// ponytail: matching on line fingerprints, since Hermes gives no offsets; a run of identical lines can hide a repeat of
// itself.
export function since<T>(prev: readonly T[], next: readonly T[], limit: number): { start: number; gap?: "rotated" | "missed" } {
  if (!prev.length) return { start: 0 };
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    const from = prev.length - k;
    let i = 0;
    while (i < k && prev[from + i] === next[i]) i++;
    if (i === k) return { start: k };
  }
  return { start: 0, gap: next.length < limit ? "rotated" : "missed" };
}

/** What reading a Hermes log came to last. */
export type ReadState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "ok"; at: number }
  | { kind: "failed"; reason: string; at: number }
  /** This Hermes can't give this log; reading stops. */
  | { kind: "unsupported"; reason: string };

const clock = (at: number) => new Date(at).toLocaleTimeString();

/**
 * A 53-bit fingerprint of a raw line (cyrb53), so overlap matching tells apart lines that redact to the same text
 * without keeping the raw text.
 */
function fingerprint(line: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const BASE64_ROW = /^[A-Za-z0-9+/]+={0,2}$/;
/** A PEM block's lines are redacted up to its END line, or this many lines if none comes. */
const KEY_MAX_LINES = 200;

/**
 * Follows one of a profile's Hermes logs: reads its tail every `pollMs` while started, and keeps the lines new since
 * the read before in a `LogBuffer`. Stopping, or a read that fails, is noted in the buffer where reading picks up
 * again, with whether lines may be missing. An answer that comes after a stop is dropped.
 */
export class LogFollower {
  readonly buffer: LogBuffer;
  private state: ReadState = { kind: "idle" };
  private last: number[] = [];
  /** Lines left to redact of a private key whose BEGIN line was read and END line not yet. */
  private inKey = 0;
  private level?: Level;
  private read = false;
  private stopped?: { at: number; reason: string };
  private running = false;
  private gen = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();

  constructor(
    /** `GET /api/logs` for this log: its JSON answer. */
    private readonly get: (lines: number) => Promise<unknown>,
    readonly name: string,
    private readonly opts: { capacity?: number; pollMs?: number; now?: () => number } = {},
  ) {
    this.buffer = new LogBuffer(opts.capacity ?? 5000);
  }

  private now = () => (this.opts.now ?? Date.now)();
  readonly getState = () => this.state;
  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(s: ReadState) {
    this.state = s;
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.running || this.state.kind === "unsupported") return;
    this.running = true;
    void this.tick();
  }

  /** Stops reading; `reason` is what the note says when reading picks up again. */
  stop(reason: string) {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    clearTimeout(this.timer);
    if (this.read) this.stopped ??= { at: this.now(), reason };
    if (this.state.kind === "reading") this.set({ kind: "idle" });
  }

  private async tick() {
    const gen = this.gen;
    if (this.state.kind !== "ok") this.set({ kind: "reading" });
    try {
      const res = await this.get(TAIL);
      if (gen !== this.gen) return;
      const lines = linesOf(res);
      if (!lines) {
        this.running = false;
        return this.set({ kind: "unsupported", reason: `Hermes answered with something other than a log. This Hermes may not have the /api/logs route.` });
      }
      this.take(lines);
      this.set({ kind: "ok", at: this.now() });
    } catch (e) {
      if (gen !== this.gen) return;
      const f = failureOf(e);
      if (f.status === 405 || (f.status === 404 && f.reason === "Not Found")) {
        this.running = false;
        return this.set({ kind: "unsupported", reason: "This Hermes has no /api/logs route, so its logs can't be read here. Updating Hermes adds it." });
      }
      if (f.status === 400 && /unknown log file/i.test(f.reason)) {
        this.running = false;
        return this.set({ kind: "unsupported", reason: clean(`This Hermes doesn't have the ${this.name} log (${f.reason}).`).text });
      }
      // Hermes's or the relay's words can quote what was sent, so they're cleaned like a line.
      const reason = clean(f.status === 403 ? `Permission denied: ${f.reason}` : f.reason).text;
      if (this.read) this.stopped ??= { at: this.now(), reason };
      this.set({ kind: "failed", reason, at: this.now() });
    }
    if (this.running && gen === this.gen) this.timer = setTimeout(() => void this.tick(), this.opts.pollMs ?? 2000);
  }

  /** Takes one answer: the lines new since the last, after a note of any stop or gap. */
  private take(raw: string[]) {
    const at = this.now();
    const lines = raw.map((l) => l.replace(/\r?\n$/, ""));
    const prints = lines.map(fingerprint);
    const marks: { kind: "mark"; text: string; at: number }[] = [];
    if (this.stopped) {
      marks.push({ kind: "mark", at, text: `Not read from ${clock(this.stopped.at)} to ${clock(at)}: ${this.stopped.reason}` });
      this.stopped = undefined;
    }
    const { start, gap } = this.read ? since(this.last, prints, TAIL) : { start: 0 };
    if (gap) this.inKey = 0;
    if (gap === "rotated")
      marks.push({ kind: "mark", at, text: "The log file was rotated or emptied since the last read. Lines written just before that may be missing." });
    if (gap === "missed") marks.push({ kind: "mark", at, text: `More than ${TAIL} lines were written between two reads, so some were missed here.` });
    const fresh: { kind: "line"; at: number; level?: Level; text: string; redacted?: string[] }[] = [];
    for (const line of lines.slice(start)) {
      const plain = line.replace(CSI, "");
      // An END whose BEGIN wasn't read (the tail started inside the key): its body is the base64 rows just above.
      if (!this.inKey && KEY_END.test(plain))
        for (let i = fresh.length - 1; i >= 0 && BASE64_ROW.test(lines[start + i].replace(CSI, "")); i--)
          fresh[i] = { ...fresh[i], text: "[redacted private key]", redacted: ["private key"] };
      const c = this.cleanKeyAware(plain);
      this.level = levelOf(c.text, this.level);
      fresh.push({ kind: "line", at, level: this.level, ...c });
    }
    this.buffer.add([...marks, ...fresh]);
    this.last = prints;
    this.read = true;
  }

  /**
   * `clean`, with a private key's lines redacted from its BEGIN line to its END line, across reads. `line` is without
   * CSI codes already, so a colored delimiter is still seen.
   */
  private cleanKeyAware(line: string): { text: string; redacted?: string[] } {
    if (this.inKey) {
      this.inKey = KEY_END.test(line) ? 0 : this.inKey - 1;
      return { text: "[redacted private key]", redacted: ["private key"] };
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin && !KEY_END.test(line.slice(begin.index))) this.inKey = KEY_MAX_LINES;
    return clean(line);
  }
}

/** `{lines: string[]}` as `GET /api/logs` answers it, or undefined if it isn't that. */
function linesOf(res: unknown): string[] | undefined {
  const lines = (res as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) && lines.every((l) => typeof l === "string") ? lines : undefined;
}

// ---------- export ----------

export type TimeFormat = "local" | "utc" | "off";

export function stamp(at: number, fmt: TimeFormat): string {
  if (fmt === "off") return "";
  if (fmt === "utc") return new Date(at).toISOString();
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Entries as plain text, one per line: the time this app received it (unless `off`), then the text. Notes are marked. */
export function asText(entries: readonly Entry[], fmt: TimeFormat, dropped = 0): string {
  const head = dropped ? [`-- ${dropped} earlier line${dropped === 1 ? "" : "s"} dropped: only the latest are kept --`] : [];
  return [
    ...head,
    ...entries.map((e) => {
      const t = stamp(e.at, fmt);
      const body = e.kind === "mark" ? `-- ${e.text} --` : e.text;
      return t ? `[${t}] ${body}` : body;
    }),
  ].join("\n");
}

export type BundlePart = { title: string; detail: string; snapshot: Snapshot };

/** "3 cookies, 1 provider key": how many of each kind of secret were redacted. */
export const countsText = (counts: [string, number][]) => counts.map(([k, c]) => `${c} ${k}${c === 1 ? "" : "s"}`).join(", ");

/** How many of each kind of secret were redacted in `parts`. */
export function redactionCounts(parts: readonly BundlePart[]): [string, number][] {
  const n = new Map<string, number>();
  for (const p of parts) for (const e of p.snapshot.entries) if (e.kind === "line") for (const k of e.redacted ?? []) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

export const REDACTION_LIMITS =
  "Known secret shapes were replaced with [redacted]: " +
  `${REDACTED_KINDS.join(", ")}. A secret in another shape, such as a password written in a sentence, can still be there: read the file before sharing it.`;

/** The support bundle: a header saying what's in it and what was redacted, then each part's lines. Times are UTC. */
export function bundleText(parts: readonly BundlePart[], about: { profile?: string; connection: string; now: number }): string {
  const counts = redactionCounts(parts);
  const head = [
    "Hermes Chat support bundle",
    `Made: ${new Date(about.now).toISOString()}`,
    `Connection: ${about.connection}`,
    ...(about.profile ? [`Profile: ${about.profile}`] : []),
    "Included:",
    ...parts.map((p) => `  - ${p.title}: ${p.snapshot.lines} line${p.snapshot.lines === 1 ? "" : "s"}${p.snapshot.dropped ? `, ${p.snapshot.dropped} older dropped` : ""} (${p.detail})`),
    `Redacted: ${counts.length ? countsText(counts) : "nothing found"}.`,
    REDACTION_LIMITS,
    "Times in [brackets] are when Hermes Chat received each line, in UTC. Times inside Hermes's lines are the server's own clock and zone.",
  ];
  return [...head, ...parts.flatMap((p) => ["", `===== ${p.title} =====`, asText(p.snapshot.entries, "utc", p.snapshot.dropped)])].join("\n") + "\n";
}
