// Dictation and Read aloud, the parts that aren't UI: what the profile's voice providers are and need, why the
// microphone can't be used, and the WAV a recording is sent as. Hermes does the transcribing and the speaking with
// the profile's own providers, on the server (research doc, "Voice"); this app only records and plays.
import type { VoiceSetup } from "./pipe";
import { errorText } from "./values";

/** A provider as the Settings screen names it, and what it needs on the server. */
export type ProviderInfo = { label: string; needs: string };

/** Hermes's speech-to-text providers (`_NATIVE_STT_LABELS`, `tools/voice_mode.py` at the deployed `bf0203a`). */
const STT: Record<string, ProviderInfo> = {
  local: { label: "Local Whisper", needs: "Runs on the Hermes server. It needs the faster-whisper package there; the model downloads on first use." },
  local_command: { label: "A local command", needs: "Runs the command set in the profile's stt settings on the Hermes server." },
  groq: { label: "Groq Whisper", needs: "Needs GROQ_API_KEY in the profile's .env on the Hermes server." },
  openai: { label: "OpenAI", needs: "Needs an OpenAI key (VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY) on the Hermes server." },
  nous: { label: "OpenAI through Nous", needs: "Needs a Nous subscription signed in on the Hermes server." },
  mistral: { label: "Mistral Voxtral", needs: "Needs MISTRAL_API_KEY in the profile's .env on the Hermes server." },
  xai: { label: "xAI", needs: "Needs XAI_API_KEY in the profile's .env on the Hermes server." },
  elevenlabs: { label: "ElevenLabs Scribe", needs: "Needs ELEVENLABS_API_KEY in the profile's .env on the Hermes server." },
  deepinfra: { label: "DeepInfra", needs: "Needs DEEPINFRA_API_KEY in the profile's .env on the Hermes server." },
};

/** Hermes's text-to-speech providers (`tools/tts_tool.py` at the deployed `bf0203a`; `edge` is its default). */
const TTS: Record<string, ProviderInfo> = {
  edge: { label: "Microsoft Edge TTS", needs: "Free, with no key. It needs the edge-tts package on the Hermes server." },
  elevenlabs: { label: "ElevenLabs", needs: "Needs ELEVENLABS_API_KEY in the profile's .env on the Hermes server." },
  openai: { label: "OpenAI TTS", needs: "Needs an OpenAI key (VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY) on the Hermes server." },
  minimax: { label: "MiniMax", needs: "Needs MINIMAX_API_KEY on the Hermes server." },
  xai: { label: "xAI", needs: "Needs XAI_API_KEY on the Hermes server." },
  mistral: { label: "Mistral Voxtral", needs: "Needs MISTRAL_API_KEY on the Hermes server." },
  gemini: { label: "Google Gemini TTS", needs: "Needs GEMINI_API_KEY or GOOGLE_API_KEY on the Hermes server." },
  deepinfra: { label: "DeepInfra", needs: "Needs DEEPINFRA_API_KEY on the Hermes server." },
  neutts: { label: "NeuTTS", needs: "Runs on the Hermes server. It needs the neutts package there." },
  kittentts: { label: "KittenTTS", needs: "Runs on the Hermes server. It needs the kittentts package there." },
  piper: { label: "Piper", needs: "Runs on the Hermes server. It needs the piper-tts package there." },
};

const other = (name: string): ProviderInfo => ({ label: name, needs: "A provider set up on the Hermes server; see its own instructions." });

/** The speech-to-text provider the profile names; none named means Hermes picks, Local Whisper first. */
export function sttProvider(setup: VoiceSetup): ProviderInfo {
  if (setup.sttLocal)
    return {
      label: `${setup.sttLocal.label ?? "An engine"} on this computer`,
      needs: "Runs on this computer: the recording never leaves it, and only the text goes to Hermes.",
    };
  const name = setup.sttProvider?.toLowerCase();
  if (!name) return { label: "Picked by Hermes", needs: "Hermes uses Local Whisper if it's installed on the server, else the first cloud provider with a key." };
  return STT[name] ?? other(setup.sttProvider!);
}

/** The text-to-speech provider the profile names; none named means Hermes's default, Edge TTS. */
export function ttsProvider(setup: VoiceSetup): ProviderInfo {
  const name = setup.ttsProvider?.toLowerCase() || "edge";
  return TTS[name] ?? other(setup.ttsProvider!);
}

/** Why Dictation can't be used with this set-up, or undefined if it can be tried. */
export function dictationBlocked(setup: VoiceSetup | undefined): string | undefined {
  if (!setup) return undefined;
  // This computer first: its problem blocks Dictation only with no backup; with Hermes as backup, it can be tried.
  if (setup.sttLocal) return setup.sttLocal.problem && !setup.sttLocal.backup ? `${setup.sttLocal.problem} See Settings → Voice.` : undefined;
  if (!setup.transcribe) return "This Hermes server can't transcribe recordings. Updating Hermes adds it.";
  if (setup.sttEnabled === false) return "Speech-to-text is turned off for this profile in Hermes (stt.enabled is false).";
  return undefined;
}

/** Why Read aloud can't be used with this set-up, or undefined if it can be tried. */
export function readAloudBlocked(setup: VoiceSetup | undefined): string | undefined {
  if (setup && !setup.speak) return "This Hermes server can't read replies aloud. Updating Hermes adds it.";
  return undefined;
}

/** The longest Dictation recording: it stops by itself then. Five minutes of 16 kHz WAV is 9.6 MB, well under Hermes's 25 MB. */
export const MAX_RECORDING_SECONDS = 300;

/** The rate a recording is sent at: what Whisper and the cloud transcribers work at. */
export const WAV_RATE = 16_000;

/** What `getUserMedia` failing means for the owner, by the error's name. */
export function micProblem(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e && typeof e.name === "string" ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Hermes Chat wasn't allowed to use the microphone. Allow it in your desktop's privacy or sound settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Plug one in or pick an input device in your sound settings, then try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone couldn't be opened. Another app may be using it, or the sound server isn't running.";
    default:
      return `The microphone couldn't be started: ${errorText(e)}`;
  }
}

/** Mono 32-bit float samples at `inRate` as 16-bit PCM WAV at `outRate`, averaging the samples each output one covers. */
export function toWav(chunks: Float32Array[], inRate: number, outRate = WAV_RATE): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = inRate / outRate;
  const frames = Math.floor(total / ratio);
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, frames * 2, true);

  // Walk the chunks as one stream of samples.
  let chunk = 0;
  let at = 0;
  let consumed = 0;
  const next = () => {
    while (chunk < chunks.length && at >= chunks[chunk].length) {
      chunk++;
      at = 0;
    }
    consumed++;
    return chunk < chunks.length ? chunks[chunk][at++] : 0;
  };
  for (let f = 0; f < frames; f++) {
    const end = Math.round((f + 1) * ratio);
    let sum = 0;
    let n = 0;
    while (consumed < end) {
      sum += next();
      n++;
    }
    const v = Math.max(-1, Math.min(1, n ? sum / n : 0));
    view.setInt16(44 + f * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

/** "0:07", "4:59". */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The composer's text with a transcript added at the end, a space between them if needed. */
export function withTranscript(draft: string, transcript: string): string {
  if (!draft) return transcript;
  return /\s$/.test(draft) ? draft + transcript : `${draft} ${transcript}`;
}
