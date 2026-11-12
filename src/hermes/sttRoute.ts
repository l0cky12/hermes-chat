// Where speech to text runs (ADR 0065, building on ADR 0067), as the webview sees it. The owner picks a Primary,
// Hermes or this computer, and may make the other one its Backup, which transcribes the same recording when the primary
// fails or takes longer than the time set. Rust decides (`hermes_transcribe`, src-tauri/src/local_stt.rs): the webview
// never sends a recording anywhere itself, and with this computer alone a recording can't reach Hermes. The transcript
// Rust answers says where it ran (`ran`) and, when the backup gave it, why the primary didn't (`fellBack`).
//
// Dictation and voice conversations both transcribe through that one command, so they behave the same.

import type { Transcript } from "./pipe";
import { errorText } from "./values";

export type SttSide = "server" | "local";

/** The route, as Rust last read it back: where first, whether the other is the backup, and its time. */
export type SttPrefs = { primary: SttSide; backup: boolean; timeoutSeconds: number };

export const DEFAULT_STT_PREFS: Readonly<SttPrefs> = Object.freeze({ primary: "server", backup: false, timeoutSeconds: 30 });
/** The timeout choices Settings → Voice offers, in seconds. */
export const STT_TIMEOUTS = [10, 20, 30, 60, 120] as const;

export const other = (side: SttSide): SttSide => (side === "server" ? "local" : "server");

/** Whether `side` may transcribe a recording with this route. */
export const inRoute = (route: Readonly<SttPrefs>, side: SttSide) => route.primary === side || route.backup;

/** "Hermes", "this computer": where a transcript came from, as the chat says it. */
export const sideLabel = (side: SttSide) => (side === "server" ? "Hermes" : "this computer");

/** A transcript as Dictation and voice conversations get it: where it ran, and why the primary didn't give it. */
export type HeardTranscript = Transcript & { ran?: SttSide; fellBack?: { from: SttSide; why: string } };

/** "Hermes couldn't transcribe it: …", as Rust says it (`couldnt` in local_stt.rs). `why`: the reason alone. */
export function couldnt(side: SttSide, why: string): string {
  const who = side === "server" ? "Hermes" : "This computer";
  return `${who} couldn't transcribe it: ${why}${[".", "!", "?"].some((end) => why.endsWith(end)) ? "" : "."}`;
}

/** What the chat says under a transcript that came from the backup: which side, and why the primary didn't. */
export function fellBackOf(t: HeardTranscript): string | undefined {
  if (!t.fellBack || !t.ran) return undefined;
  return `Transcribed on ${sideLabel(t.ran)}. ${couldnt(t.fellBack.from, t.fellBack.why)}`;
}

/**
 * A recording `hermes_transcribe` couldn't transcribe. Rust words the message and names the side that failed, "Hermes
 * couldn't transcribe it: …", so it is shown as it is (#517).
 */
export class SttFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttFailed";
  }
}

/** `hermes_transcribe`'s rejection as an `SttFailed`. */
export const sttFailed = (e: unknown): Promise<never> => Promise.reject(new SttFailed(errorText(e)));

/** The recording was dropped (Cancel, the chat closed, the conversation ended or paused) before it was transcribed. */
export class SttCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "SttCancelled";
  }
}

/** `p`, or a rejection with `SttCancelled` as soon as `signal` aborts, after calling `onAbort` (which tells Rust). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(new SttCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      onAbort?.();
      reject(new SttCancelled());
    };
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

// The route as Rust last read it back, for what must be known without Hermes: whether the microphone can be used
// offline, and whether a voice conversation needs Hermes's own speech to text. Set by Main, and by Settings on a change.
// Each read or read-back is numbered, so an older read that answers late never replaces a newer one.
let current: Readonly<SttPrefs> = DEFAULT_STT_PREFS;
let latest = 0;
const listeners = new Set<() => void>();

function apply(next: Readonly<SttPrefs>) {
  if (next.primary === current.primary && next.backup === current.backup && next.timeoutSeconds === current.timeoutSeconds) return;
  current = Object.freeze({ ...next });
  for (const fn of listeners) fn();
}

export const sttRoute = {
  get: (): Readonly<SttPrefs> => current,
  /** The route as just read back from Rust: newer than any read still on its way. */
  set(next: Readonly<SttPrefs>) {
    latest++;
    apply(next);
  },
  /** Reads the route; its answer is taken unless something newer came meanwhile. */
  async refresh(read: () => Promise<Readonly<SttPrefs>>) {
    const mine = ++latest;
    const next = await read();
    if (mine === latest) apply(next);
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
