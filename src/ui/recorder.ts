// Microphone capture, for Dictation and a Voice conversation. The microphone is opened only when the owner starts one,
// and closed as soon as they stop, cancel or end it, or the window that started it goes away. Samples stay in memory;
// nothing is written to disk. A recording becomes 16 kHz mono WAV, which every Hermes transcriber takes (a plain Web
// Audio capture, since WebKitGTK's MediaRecorder depends on which GStreamer encoders are installed).
import { micProblem, toWav } from "../hermes/voice";
import { errorText } from "../hermes/values";

export type Recording = { audio: Uint8Array; mime: "audio/wav"; seconds: number };

/** A recording under way. */
export interface Capture {
  /** Seconds recorded so far. */
  seconds(): number;
  /** How loud the last moment was, 0 to 1, so the owner can see the microphone hears them. */
  level(): number;
  /** Closes the microphone and gives the recording. */
  stop(): Recording;
  /** Closes the microphone and drops what was recorded. */
  cancel(): void;
}

/** What the capture needs from the browser, so tests can stand in for it. */
export type AudioEnv = {
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "enumerateDevices" | "addEventListener" | "removeEventListener">>;
  makeContext: () => AudioContext;
};

export const browserEnv = (): AudioEnv => ({
  mediaDevices: typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
  makeContext: () => new AudioContext(),
});

/** Why the microphone can't be used: shown to the owner as is. */
export class MicError extends Error {}

/** Thrown by `startCapture` and `openMicrophone` when `signal` aborted it; the microphone is already closed. */
export class CaptureAborted extends Error {}

/** An open microphone: its samples go to the `onChunk` it was opened with until `close`. */
export interface Microphone {
  /** Samples per second of what `onChunk` gets. */
  readonly rate: number;
  /** The input device it opened, as the system names it, when it says. */
  readonly device?: { id?: string; label?: string };
  /** Turns the track off or on again: off, the system gets silence from it. */
  setEnabled(on: boolean): void;
  /** Closes it: the track stops and the audio system is let go of. Safe to call twice. */
  close(): void;
}

/**
 * Opens the microphone and sends its samples, mono at `rate`, to `onChunk` in blocks. Rejects with a `MicError` saying
 * why when there's no microphone, it's refused or busy, or this window can't capture audio. `onLost` is called if the
 * microphone goes away afterwards, once it is already closed. Aborting `signal` while it starts closes whatever it has
 * opened at once, even while it waits on the audio system, and it then rejects with `CaptureAborted`. `deviceId`: the
 * input to open, or the system's default.
 */
export async function openMicrophone(
  onChunk: (samples: Float32Array) => void,
  onLost: (why: string) => void,
  { signal, env = browserEnv(), deviceId }: { signal?: AbortSignal; env?: AudioEnv; deviceId?: string } = {},
): Promise<Microphone> {
  const aborted = () => new CaptureAborted("The recording was cancelled.");
  if (signal?.aborted) throw aborted();
  if (!env.mediaDevices?.getUserMedia) throw new MicError("This window can't use a microphone: the system webview has audio capture turned off.");
  let stream: MediaStream;
  try {
    stream = await env.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId && { deviceId: { exact: deviceId } }) },
    });
  } catch (e) {
    throw new MicError(micProblem(e));
  }
  const tracks = stream.getAudioTracks();
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  if (signal?.aborted) {
    stopTracks();
    throw aborted();
  }
  if (!tracks.length) {
    stopTracks();
    throw new MicError(micProblem(new DOMException("no audio track", "NotFoundError")));
  }

  let ctx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: ScriptProcessorNode | undefined;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    if (node) node.onaudioprocess = null;
    node?.disconnect();
    source?.disconnect();
    for (const t of tracks) t.onended = null;
    stopTracks();
    void ctx?.close().catch(() => {});
  };
  // From here on, an abort closes the microphone straight away, not once startup finishes.
  signal?.addEventListener("abort", close, { once: true });
  // A microphone unplugged while the audio system starts is noticed too, not only once recording.
  let lostWhileStarting = false;
  for (const t of tracks) t.onended = () => void (lostWhileStarting = true);

  try {
    ctx = env.makeContext();
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but runs everywhere, WebKitGTK included, with no worklet module to load.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (open) onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(node);
    // The processor only runs while connected to the output; it writes nothing to its output, so nothing is heard.
    node.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
  } catch (e) {
    close();
    if (signal?.aborted) throw aborted();
    throw new MicError(`The microphone couldn't be recorded from: ${errorText(e)}`);
  }
  signal?.removeEventListener("abort", close);
  if (signal?.aborted || !open) {
    close();
    throw aborted();
  }
  if (lostWhileStarting || tracks.some((t) => t.readyState === "ended")) {
    close();
    throw new MicError("The microphone was disconnected before recording started. Check it's plugged in, then try again.");
  }
  for (const t of tracks)
    t.onended = () => {
      if (!open) return;
      close();
      onLost("The microphone was disconnected.");
    };

  const settings = typeof tracks[0].getSettings === "function" ? tracks[0].getSettings() : undefined;
  return {
    rate: ctx.sampleRate,
    device: { id: settings?.deviceId, label: tracks[0].label || undefined },
    setEnabled: (on) => {
      for (const t of tracks) t.enabled = on;
    },
    close,
  };
}

/**
 * Opens the microphone and starts a Dictation recording, as `openMicrophone` does. `onLost` is called if the
 * microphone goes away mid-recording, after it is closed and the recording dropped.
 */
export async function startCapture(onLost: (why: string) => void, signal?: AbortSignal, env: AudioEnv = browserEnv()): Promise<Capture> {
  let chunks: Float32Array[] = [];
  let samples = 0;
  let loudness = 0;
  let closed = false;
  const mic = await openMicrophone(
    (data) => {
      chunks.push(data);
      samples += data.length;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      loudness = Math.min(1, Math.sqrt(sum / (data.length || 1)) * 4);
    },
    () => {
      closed = true;
      chunks = [];
      onLost("The microphone was disconnected, so the recording was dropped.");
    },
    { signal, env },
  );
  const close = () => {
    closed = true;
    mic.close();
  };
  return {
    seconds: () => samples / mic.rate,
    level: () => (closed ? 0 : loudness),
    stop: () => {
      close();
      const recording: Recording = { audio: toWav(chunks, mic.rate), mime: "audio/wav", seconds: samples / mic.rate };
      chunks = [];
      return recording;
    },
    cancel: () => {
      close();
      chunks = [];
    },
  };
}
