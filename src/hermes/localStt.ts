// Speech to text on this computer, and where each recording goes (#220 and #192; ADR 0067 and ADR 0065). Rust finds
// the engines, downloads Whisper models for whisper.cpp, keeps the choice in the app's config folder, and decides
// inside `hermes_transcribe` where a recording is transcribed (src-tauri/src/local_stt.rs), so with this computer alone
// a recording can't reach Hermes. The webview only picks among what Rust found, or has Rust open a file dialog.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";
import { DEFAULT_STT_PREFS, SttCancelled, sttFailed, untilAborted, type HeardTranscript, type SttPrefs, type SttSide } from "./sttRoute";

export type LocalSttKind = "whisper-cpp" | "faster-whisper" | "openai-whisper" | "vosk";
export type LocalEngine = { kind: LocalSttKind; binary: string; model?: string | null };

/**
 * The choice: `onThisComputer` makes this computer the primary, else Hermes is; `backup` makes the other one the
 * backup after `timeoutSeconds`. `problem`: why the engine here can't run now. `language`: `auto` or a Whisper code.
 */
export type LocalSttState = {
  onThisComputer: boolean;
  engine?: LocalEngine | null;
  label?: string | null;
  problem?: string | null;
  backup?: boolean;
  timeoutSeconds?: number;
  language?: string;
};

/** A change to the choice; what is left out stays as it is. Rust refuses it whole if any of it is out of range. */
export type LocalSttChange = { onThisComputer?: boolean; engine?: LocalEngine; backup?: boolean; timeoutSeconds?: number; language?: string };

/** An engine found on PATH, its `--version` line if it gave one, and the models found in its usual folders. */
export type FoundEngine = { kind: LocalSttKind; label: string; binary: string; version?: string | null; models: string[] };

/** A Whisper size this app can download for whisper.cpp: whether it is there at its exact size, and where it goes. */
export type LocalModel = { name: string; bytes: number; downloaded: boolean; path: string };
export type DownloadProgress = { name: string; done: number; total: number };
export type LocalModels = { dir: string; models: LocalModel[]; downloading?: DownloadProgress | null };

/** A recording to transcribe where the owner chose. `side`: one side alone (Settings' Test). `signal`: drops it. */
/** `connection`: the live connection's name (`Hermes.connectionId`), which a transcription on Hermes must give (#474). */
export type TranscribeRequest = { audio: Uint8Array; mime: string; profile?: string; connection?: string; side?: SttSide; signal?: AbortSignal };

export type LocalSttApi = {
  state: () => Promise<LocalSttState>;
  detect: () => Promise<FoundEngine[]>;
  /** `change.engine`: one found by `detect` (or the one already chosen). Answers the choice as read back. */
  set: (change: LocalSttChange) => Promise<LocalSttState>;
  /** The native Open dialog for an engine's program, or its model. Undefined: cancelled. */
  pickProgram: () => Promise<LocalSttState | undefined>;
  pickModel: () => Promise<LocalSttState | undefined>;
  models: () => Promise<LocalModels>;
  download: (name: string, onProgress: (p: DownloadProgress) => void) => Promise<LocalModels>;
  cancelDownload: () => Promise<void>;
  remove: (name: string) => Promise<LocalModels>;
  /** Transcribes where the owner chose; aborting `signal` stops it, and nothing more is tried with the recording. */
  transcribe: (request: TranscribeRequest) => Promise<HeardTranscript>;
  /** Calls `fn` after every change made here; returns its unsubscribe. */
  onChange: (fn: () => void) => () => void;
};

const listeners = new Set<() => void>();
const changed = <T>(v: T) => {
  for (const fn of listeners) fn();
  return v;
};

let runs = 0;

export const tauriLocalStt: LocalSttApi = {
  state: () => invoke<LocalSttState>("local_stt_state").catch(asError),
  detect: () => invoke<FoundEngine[]>("local_stt_detect").catch(asError),
  set: (change) => invoke<LocalSttState>("local_stt_set", { change }).then(changed, asError),
  pickProgram: () => invoke<LocalSttState | null>("local_stt_pick_program").then((s) => changed(s ?? undefined), asError),
  pickModel: () => invoke<LocalSttState | null>("local_stt_pick_model").then((s) => changed(s ?? undefined), asError),
  models: () => invoke<LocalModels>("local_stt_models").catch(asError),
  download: (name, onProgress) => {
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<LocalModels>("local_stt_download", { name, onProgress: channel }).catch(asError);
  },
  cancelDownload: () => invoke<void>("local_stt_cancel_download").catch(asError),
  remove: (name) => invoke<LocalModels>("local_stt_delete", { name }).catch(asError),
  // The recording goes as the raw body, as it does to Hermes (tauriPipe.ts); the run id lets a cancel reach Rust.
  transcribe: ({ audio, mime, profile, connection, side, signal }) => {
    const run = `${Date.now().toString(36)}-${++runs}`;
    const headers: Record<string, string> = { "x-mime": encodeURIComponent(mime), "x-stt-run": run };
    if (profile) headers["x-profile"] = encodeURIComponent(profile);
    if (connection) headers["x-attempt"] = connection;
    if (side) headers["x-stt-side"] = side;
    // Dropped before it went: nothing to send, and nothing for Rust to stop.
    if (signal?.aborted) return Promise.reject(new SttCancelled());
    const cancel = () => void invoke("local_stt_cancel", { run }).catch(() => {});
    return untilAborted(invoke<HeardTranscript>("hermes_transcribe", audio, { headers }).catch(sttFailed), signal, cancel);
  },
  onChange: (fn) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** The route a read-back choice makes. */
export const prefsOf = (s: LocalSttState | undefined): SttPrefs =>
  s ? { primary: s.onThisComputer ? "local" : "server", backup: !!s.backup, timeoutSeconds: s.timeoutSeconds ?? DEFAULT_STT_PREFS.timeoutSeconds } : { ...DEFAULT_STT_PREFS };

/** The last part of a path: a model's file or folder name. */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The Whisper sizes, as Settings → Voice describes them. */
export const MODEL_NOTES: Record<string, string> = {
  tiny: "Fastest, least accurate",
  base: "Fast, good for clear speech",
  small: "Slower, more accurate",
  medium: "Slow without a fast CPU",
  "large-v3": "Most accurate, needs a fast computer",
};

/** Languages offered by name; any other Whisper code read back is shown as it is. */
export const LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "auto", label: "Detect it" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
];

/** "75 MB", "1.5 GB". */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
