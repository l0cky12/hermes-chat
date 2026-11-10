// A Voice conversation's turns, the parts that aren't UI: when the owner has finished speaking, whether what Hermes
// heard is its own reply coming back through the microphone, and why a conversation can't start (ADR 0111).
//
// Hermes has no server-side turn detection on the routes this app uses (`POST /api/audio/transcribe` takes a finished
// recording). Its own voice mode ends a turn where the microphone is, by loudness: `AudioRecorder._track_speech` and
// `_should_auto_stop` in `tools/voice_mode.py`, tuned by the profile's `voice.silence_threshold`,
// `voice.silence_duration` and `voice.max_recording_seconds` (`hermes_cli/cli_voice_mixin.py`). `TurnDetector` is that
// same detector, fed with this computer's microphone.
import type { VoiceSetup } from "./pipe";
import type { ConnectionStatus } from "./model";
import { MAX_RECORDING_SECONDS, dictationBlocked } from "./voice";
import { DEFAULT_STT_PREFS, inRoute, type SttPrefs } from "./sttRoute";

/** Hermes's defaults for the three settings (`hermes_cli/config_defaults.py`, `tools/voice_mode.py`). */
export const HERMES_SILENCE_THRESHOLD = 200;
export const HERMES_SILENCE_SECONDS = 3;
export const HERMES_MAX_RECORDING_SECONDS = 120;

/** Hermes's own speech checks: this long above the threshold confirms speech; a dip this long is a real pause. */
const MIN_SPEECH_SECONDS = 0.3;
const MAX_DIP_SECONDS = 0.3;

/**
 * How a turn ends. `threshold`: below this RMS of 16-bit samples a moment is quiet. `silenceSeconds`: this much quiet
 * after speech ends the turn. `maxSeconds`: the longest one turn may be, never more than a Dictation recording.
 * `fromProfile`: which of them the profile set, rather than Hermes's defaults.
 */
export type TurnSettings = {
  threshold: number;
  silenceSeconds: number;
  maxSeconds: number;
  fromProfile: { threshold: boolean; silence: boolean; max: boolean };
};

const usable = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The profile's turn settings, as Hermes's voice mode takes them: a number that isn't positive falls back to Hermes's
 * default, except `voice.max_recording_seconds`, where 0 or less means Hermes sets no limit. This app then still stops
 * at its own Dictation limit, so a recording always fits what Hermes will transcribe. The quiet is kept between half a
 * second and 30 seconds, so a typo can neither cut every word off nor keep the microphone listening for minutes.
 */
export function turnSettings(setup: VoiceSetup | undefined): TurnSettings {
  const threshold = usable(setup?.silenceThreshold) && setup.silenceThreshold > 0 ? Math.min(setup.silenceThreshold, 32_767) : undefined;
  const silence = usable(setup?.silenceDuration) && setup.silenceDuration > 0 ? Math.min(Math.max(setup.silenceDuration, 0.5), 30) : undefined;
  const rawMax = usable(setup?.maxRecordingSeconds) ? setup.maxRecordingSeconds : undefined;
  const max = rawMax === undefined ? HERMES_MAX_RECORDING_SECONDS : rawMax <= 0 ? MAX_RECORDING_SECONDS : Math.min(rawMax, MAX_RECORDING_SECONDS);
  return {
    threshold: threshold ?? HERMES_SILENCE_THRESHOLD,
    silenceSeconds: silence ?? HERMES_SILENCE_SECONDS,
    maxSeconds: Math.max(max, 1),
    fromProfile: { threshold: threshold !== undefined, silence: silence !== undefined, max: rawMax !== undefined },
  };
}

/** The RMS of mono float samples on the 16-bit scale Hermes's threshold uses. */
export function rms16(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1)) * 32_768;
}

/** Why `TurnDetector.push` ended a turn: quiet after speech, or the length limit. */
export type TurnEnd = "silence" | "limit";

/**
 * Hermes's voice-mode turn detector (`AudioRecorder._track_speech` and `_should_auto_stop`), block by block. Speech is
 * confirmed after 0.3 s above the threshold, riding out dips shorter than 0.3 s; once confirmed, only sustained speech
 * resets the quiet. Time is the caller's, in seconds, so it can be the sample clock.
 */
export class TurnDetector {
  private speechStart = 0;
  private dipStart = 0;
  private silenceStart = 0;
  private resumeStart = 0;
  private resumeDipStart = 0;
  private spoken = false;
  /** When the current attempt at speech began, on the caller's clock: the turn's own start, for its length limit. */
  private began?: number;

  constructor(private readonly settings: TurnSettings) {}

  /** Speech has been confirmed in this turn. */
  get hasSpoken(): boolean {
    return this.spoken;
  }

  /** Something loud enough to be speech is under way or was confirmed: the audio since `startedAt` is the turn. */
  get attempting(): boolean {
    return this.spoken || this.speechStart > 0;
  }

  /** When the turn's audio began, while `attempting`. */
  get startedAt(): number | undefined {
    return this.attempting ? this.began : undefined;
  }

  /** Forgets everything: the next block starts a new turn. */
  reset(): void {
    this.speechStart = this.dipStart = this.silenceStart = this.resumeStart = this.resumeDipStart = 0;
    this.spoken = false;
    this.began = undefined;
  }

  /** One block's loudness (`rms16`) at `now` seconds. Returns how the turn ended, if this block ended it. */
  push(rms: number, now: number): TurnEnd | undefined {
    // A clock that starts at 0 would read as "not started"; Hermes's monotonic clock never does.
    const t = now + 1;
    const loud = rms > this.settings.threshold;
    if (loud) {
      this.dipStart = 0;
      if (this.speechStart === 0) {
        this.speechStart = t;
        this.began ??= now;
      } else if (!this.spoken && t - this.speechStart >= MIN_SPEECH_SECONDS) this.spoken = true;
      if (!this.spoken) this.silenceStart = 0;
      else {
        this.resumeDipStart = 0;
        if (this.resumeStart === 0) this.resumeStart = t;
        else if (t - this.resumeStart >= MIN_SPEECH_SECONDS) {
          this.silenceStart = 0;
          this.resumeStart = 0;
        }
      }
    } else if (this.spoken) {
      if (this.resumeStart > 0) {
        if (this.resumeDipStart === 0) this.resumeDipStart = t;
        else if (t - this.resumeDipStart >= MAX_DIP_SECONDS) this.resumeStart = this.resumeDipStart = 0;
      }
    } else if (this.speechStart > 0) {
      if (this.dipStart === 0) this.dipStart = t;
      else if (t - this.dipStart >= MAX_DIP_SECONDS) {
        // Not speech after all: the next attempt starts the turn afresh.
        this.speechStart = this.dipStart = 0;
        this.began = undefined;
      }
    }

    if (this.spoken && !loud) {
      if (this.silenceStart === 0) this.silenceStart = t;
      else if (t - this.silenceStart >= this.settings.silenceSeconds) return "silence";
    }
    if (this.began !== undefined && this.attempting && now - this.began >= this.settings.maxSeconds) return "limit";
    return undefined;
  }
}

/** Lower-case words, without punctuation, for comparing what was heard with what was spoken. */
const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Fewer words than this are never taken as an echo: a short answer such as "yes, go ahead" can repeat the reply. */
export const ECHO_MIN_WORDS = 4;

/**
 * Whether `heard` is the reply Hermes just spoke coming back through the microphone: at least `ECHO_MIN_WORDS` words,
 * all of them, in order, a run of the spoken reply's words. The microphone is shut while anything plays, so this only
 * catches what leaks past that, such as speakers still sounding after the audio element says it ended.
 */
export function isEcho(heard: string, spoken: string | undefined): boolean {
  if (!spoken) return false;
  const h = words(heard);
  if (h.length < ECHO_MIN_WORDS) return false;
  const s = words(spoken);
  outer: for (let i = 0; i + h.length <= s.length; i++) {
    for (let j = 0; j < h.length; j++) if (s[i + j] !== h[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Why a Voice conversation can't be started in this chat now, or undefined. It needs Hermes connected, both audio
 * routes (it transcribes what the owner says and speaks the replies), and a chat that has started: a new chat's first
 * message makes it, and opening that chat would end the conversation. With this computer in the speech-to-text route
 * (`stt`), Hermes's transcribing isn't needed.
 */
export function conversationBlocked(
  status: ConnectionStatus,
  setup: VoiceSetup | undefined,
  started: boolean,
  stt: Readonly<SttPrefs> = DEFAULT_STT_PREFS,
): string | undefined {
  if (status !== "connected") return "Connect to Hermes to talk with it: it transcribes what you say and speaks its replies.";
  if (!setup) return "Checking this Hermes's voice set-up…";
  // With this computer in the route, Hermes's own speech-to-text isn't needed to start (ADR 0065).
  const sttBlocked = inRoute(stt, "local") ? undefined : dictationBlocked(setup);
  if (sttBlocked) return sttBlocked;
  if (!setup.speak) return "This Hermes server can't speak its replies. Updating Hermes adds it.";
  if (!started) return "Send this chat's first message, then talk: a voice conversation needs a chat that has started.";
  return undefined;
}
