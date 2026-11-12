// A stand-in for speech to text on this computer and the route `hermes_transcribe` follows (src-tauri/src/local_stt.rs),
// for tests. It follows Rust's rules: only found programs and models can be chosen, a timeout of 5 to 600 s and a
// language `auto` or a short code, a change refused whole, every change answered as read back; and a recording goes to
// the primary, then the backup, never to Hermes when this computer is alone, and nowhere more once it is cancelled.
// Rust's own tests cover the same rules against the real code.
import type { DownloadProgress, FoundEngine, LocalModels, LocalSttApi, LocalSttChange, LocalSttState, TranscribeRequest } from "./localStt";
import type { Transcript } from "./pipe";
import { SttCancelled, SttFailed, couldnt, other, untilAborted, type HeardTranscript, type SttPrefs, type SttSide } from "./sttRoute";
import { errorText } from "./values";

/** `why` without a "Hermes couldn't transcribe the recording:" start, as Rust's `reason` cuts it. */
function reason(why: string): string {
  for (const who of ["Hermes", "This computer"]) {
    const start = `${who} couldn't transcribe`;
    const colon = why.indexOf(":");
    if (why.startsWith(start) && colon >= 0) return why.slice(colon + 1).trimStart();
  }
  return why.trim();
}

export const FAKE_MODELS = [
  { name: "tiny", bytes: 77_691_713 },
  { name: "base", bytes: 147_951_465 },
  { name: "small", bytes: 487_601_967 },
  { name: "medium", bytes: 1_533_763_059 },
  { name: "large-v3", bytes: 3_095_033_483 },
];

export const WHISPER_CLI = "/usr/bin/whisper-cli";

export class FakeLocalStt implements LocalSttApi {
  /** The engines on PATH, with the models found in their usual folders (this app's downloads are added). */
  found: FoundEngine[] = [{ kind: "whisper-cpp", label: "whisper.cpp", binary: WHISPER_CLI, version: "whisper.cpp version: 1.9.5", models: [] }];
  choice: Required<Pick<LocalSttState, "onThisComputer" | "backup" | "timeoutSeconds" | "language">> & Pick<LocalSttState, "engine"> = {
    onThisComputer: false,
    engine: null,
    backup: false,
    timeoutSeconds: 30,
    language: "auto",
  };
  downloaded = new Set<string>();
  dir = "/home/liam/.local/share/hermes-chat/whisper-models";
  /** What the next transcription here hears, or the error it fails with. */
  heard: string | Error = "Check the backup logs";
  /** Holds every transcription here until it resolves. */
  gate?: Promise<void>;
  /** Holds a download until it resolves. */
  downloadGate?: Promise<void>;
  /** What the next dialog pick returns; undefined: the owner cancels. */
  picks: { program?: string; model?: string } = {};
  /** The recordings transcribed here. */
  recordings: { audio: Uint8Array }[] = [];
  /** Every `side` a transcription asked for alone (Test), in order. */
  sideAsked: (SttSide | undefined)[] = [];
  sets: LocalSttChange[] = [];
  /** Hermes's transcribing, as Rust would reach it: the test points it at the connected Hermes. */
  server: (audio: Uint8Array, mime: string) => Promise<Transcript> = () => Promise.reject(new Error("Not connected to Hermes."));
  private downloading?: DownloadProgress;
  private cancelled = false;
  private listeners = new Set<() => void>();

  modelPath = (name: string) => `${this.dir}/ggml-${name}.bin`;

  /** Has this computer transcribe with whisper.cpp and a downloaded size, as choosing it in Settings would. */
  useModel(name = "base") {
    this.downloaded.add(name);
    this.choice.engine = { kind: "whisper-cpp", binary: WHISPER_CLI, model: this.modelPath(name) };
  }

  /** Sets the route, as Settings would. */
  route(r: Partial<SttPrefs>) {
    if (r.primary) this.choice.onThisComputer = r.primary === "local";
    if (r.backup !== undefined) this.choice.backup = r.backup;
    if (r.timeoutSeconds !== undefined) this.choice.timeoutSeconds = r.timeoutSeconds;
  }

  private detected(): FoundEngine[] {
    return this.found.map((f) => (f.kind === "whisper-cpp" ? { ...f, models: [...FAKE_MODELS.filter((m) => this.downloaded.has(m.name)).map((m) => this.modelPath(m.name)), ...f.models] } : { ...f }));
  }

  private problem(): string | null {
    const e = this.choice.engine;
    if (!e) return "No speech-to-text engine is chosen on this computer.";
    if (!e.model) return "No model is chosen for whisper.cpp.";
    const size = FAKE_MODELS.find((m) => this.modelPath(m.name) === e.model);
    if (size && !this.downloaded.has(size.name)) return `The model ${e.model} isn't there any more.`;
    return null;
  }

  snapshot(): LocalSttState {
    return { ...this.choice, engine: this.choice.engine && { ...this.choice.engine }, label: this.choice.engine ? "whisper.cpp" : null, problem: this.problem() };
  }

  private changed<T>(v: T): T {
    for (const fn of this.listeners) fn();
    return v;
  }

  state = async () => this.snapshot();
  detect = async () => this.detected();

  set = async (change: LocalSttChange) => {
    this.sets.push(change);
    const t = change.timeoutSeconds;
    if (t !== undefined && !(t >= 5 && t <= 600)) throw new Error("The time before the backup must be 5 to 600 seconds.");
    if (change.language !== undefined && !/^(auto|[a-z]{2,3})$/.test(change.language)) throw new Error("The language must be auto or a code such as en or es.");
    if (change.engine) {
      const found = this.detected().find((f) => f.binary === change.engine!.binary);
      const same = this.choice.engine?.binary === change.engine.binary ? this.choice.engine : undefined;
      if (!found && !same) throw new Error("That program wasn't found on PATH. Pick it with Choose a program instead.");
      const m = change.engine.model;
      if (m && !found?.models.includes(m) && same?.model !== m) throw new Error("That model wasn't found for this engine. Pick it with Choose a model instead.");
      this.choice.engine = { kind: found?.kind ?? same!.kind, binary: change.engine.binary, model: m ?? null };
    }
    if (t !== undefined) this.choice.timeoutSeconds = t;
    if (change.language !== undefined) this.choice.language = change.language;
    if (change.onThisComputer !== undefined) this.choice.onThisComputer = change.onThisComputer;
    if (change.backup !== undefined) this.choice.backup = change.backup;
    return this.changed(this.snapshot());
  };

  pickProgram = async () => {
    const binary = this.picks.program;
    if (!binary) return undefined;
    const model = this.choice.engine?.kind === "whisper-cpp" ? this.choice.engine.model : null;
    this.choice.engine = { kind: "whisper-cpp", binary, model };
    return this.changed(this.snapshot());
  };

  pickModel = async () => {
    if (!this.choice.engine) throw new Error("Choose an engine first.");
    const model = this.picks.model;
    if (!model) return undefined;
    this.choice.engine = { ...this.choice.engine, model };
    return this.changed(this.snapshot());
  };

  models = async (): Promise<LocalModels> => ({
    dir: this.dir,
    models: FAKE_MODELS.map((m) => ({ ...m, downloaded: this.downloaded.has(m.name), path: this.modelPath(m.name) })),
    downloading: this.downloading && { ...this.downloading },
  });

  download = async (name: string, onProgress: (p: DownloadProgress) => void) => {
    const total = FAKE_MODELS.find((m) => m.name === name)!.bytes;
    if (this.downloading) throw new Error(`The ${this.downloading.name} model is downloading already.`);
    this.cancelled = false;
    this.downloading = { name, done: Math.round(total / 2), total };
    onProgress({ ...this.downloading });
    await this.downloadGate;
    this.downloading = undefined;
    if (this.cancelled) throw new Error("Cancelled.");
    this.downloaded.add(name);
    onProgress({ name, done: total, total });
    return this.models();
  };

  cancelDownload = async () => {
    this.cancelled = true;
  };

  remove = async (name: string) => {
    if (this.downloading?.name === name) throw new Error(`The ${name} model is still downloading. Cancel it first.`);
    this.downloaded.delete(name);
    return this.models();
  };

  private async runLocal(audio: Uint8Array, mime: string): Promise<Transcript> {
    this.recordings.push({ audio });
    await this.gate;
    if (mime !== "audio/wav") throw new Error(`This computer's engine takes WAV recordings, not ${mime}.`);
    const why = this.problem();
    if (why) throw new Error(why);
    if (this.heard instanceof Error) throw this.heard;
    return { text: this.heard, provider: "whisper.cpp" };
  }

  transcribe = ({ audio, mime, side, signal }: TranscribeRequest): Promise<HeardTranscript> => untilAborted(this.route_(audio, mime, side, signal), signal);

  private async route_(audio: Uint8Array, mime: string, only: SttSide | undefined, signal?: AbortSignal): Promise<HeardTranscript> {
    this.sideAsked.push(only);
    const { onThisComputer, backup, timeoutSeconds } = this.choice;
    const primary: SttSide = onThisComputer ? "local" : "server";
    if (only === "server" && primary === "local" && !backup) throw new SttFailed("Speech to text runs only on this computer, so the recording isn't sent to Hermes.");
    const order: SttSide[] = only ? [only] : backup ? [primary, other(primary)] : [primary];
    const tried: { side: SttSide; why: string }[] = [];
    for (const [i, s] of order.entries()) {
      if (signal?.aborted) throw new SttCancelled();
      let run = s === "server" ? this.server(audio, mime) : this.runLocal(audio, mime);
      if (!only && backup && i === 0) {
        run = Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`It took longer than ${timeoutSeconds} s.`)), timeoutSeconds * 1000))]);
      }
      try {
        const got = await run;
        if (signal?.aborted) throw new SttCancelled();
        return { ...got, ran: s, ...(tried.length && { fellBack: { from: tried[0].side, why: reason(tried[0].why) } }) };
      } catch (e) {
        if (e instanceof SttCancelled) throw e;
        tried.push({ side: s, why: errorText(e) });
      }
    }
    const [a, b] = tried;
    if (!b) throw new SttFailed(only ? a.why : couldnt(a.side, reason(a.why)));
    throw new SttFailed(`${couldnt(a.side, reason(a.why))} ${couldnt(b.side, reason(b.why)).replace(" couldn't transcribe it:", " couldn't transcribe it either:")}`);
  }

  onChange = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}
