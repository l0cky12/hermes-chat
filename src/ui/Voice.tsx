// Dictation (the composer's microphone) and Read aloud (under each reply), plus the Voice section of Settings.
// Hermes transcribes and speaks on the server with the profile's own providers; see src/hermes/voice.ts.
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Check, Mic, RotateCcw, Square, Volume2, X } from "lucide-react";
import type { Speech, VoiceSetup } from "../hermes/pipe";
import type { ConnectionStatus } from "../hermes/model";
import { MAX_RECORDING_SECONDS, clock, dictationBlocked, readAloudBlocked, sttProvider, ttsProvider } from "../hermes/voice";
import { conversationBlocked, turnSettings } from "../hermes/voiceTurns";
import { DEFAULT_STT_PREFS, fellBackOf, inRoute, sttRoute, type HeardTranscript, type SttPrefs } from "../hermes/sttRoute";
import { type AudioEnv, type Capture, CaptureAborted, type Recording, startCapture } from "./recorder";
import type { Speaker } from "./speaker";
import { Spinner } from "./bits";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { errorText } from "../hermes/values";

/** What the chat pane needs for voice: the profile's set-up, and Hermes's transcribing and speaking. */
export type VoiceApi = {
  setup: () => Promise<VoiceSetup>;
  /**
   * Transcribes where the owner chose (Rust decides; sttRoute.ts); `ran` and `fellBack` say where it did. Aborting `signal` drops the
   * recording: nothing more is tried with it.
   */
  transcribe: (audio: Uint8Array, mime: string, signal?: AbortSignal) => Promise<HeardTranscript>;
  speak: (text: string) => Promise<Speech>;
  /** Calls `fn` whenever the set-up may have changed on Hermes (a Settings → Voice save); returns its unsubscribe. */
  onChange?: (fn: () => void) => () => void;
  /** Opens Settings → Voice, to change the providers. */
  openSettings?: () => void;
};

/** A count that goes up each time the voice set-up may have changed on Hermes, to read it again. */
export function useVoiceChanges(voice: Pick<VoiceApi, "onChange"> | undefined): number {
  const [changes, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => voice?.onChange?.(bump), [voice]);
  return changes;
}

/** The profile's voice set-up, read once connected and again after it changes; undefined until read, or if it couldn't be. */
export function useVoiceSetup(voice: VoiceApi | undefined, connected: boolean): VoiceSetup | undefined {
  const [setup, setSetup] = useState<VoiceSetup>();
  const changes = useVoiceChanges(voice);
  useEffect(() => {
    if (!voice || !connected) return;
    let live = true;
    voice.setup().then(
      (s) => live && setSetup(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [voice, connected, changes]);
  return setup;
}

/** A recording shorter than this is taken as a slip of the button. */
const MIN_SECONDS = 0.3;

type Phase = { phase: "idle" } | { phase: "starting" } | { phase: "recording"; capture: Capture } | { phase: "transcribing"; seconds: number };

/**
 * A note above the composer about the last recording. `retry`: the recording is still held, to transcribe again.
 * `info`: not a problem, such as the backup having done the transcribing.
 */
type DictationNote = { text: string; retry?: Recording; info?: boolean };

/**
 * Dictation's state: open the microphone, stop and transcribe, or cancel. The transcript goes to `onTranscript`; a
 * recording Hermes couldn't transcribe is held so it can be sent again without speaking it again. Closing the chat
 * closes the microphone and drops everything, a transcript still on its way included.
 */
export function useDictation(transcribe: VoiceApi["transcribe"] | undefined, onTranscript: (text: string) => void, env?: AudioEnv) {
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const [note, setNote] = useState<DictationNote>();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  // `turn` is bumped by every start, stop and cancel, so a late answer for an earlier one is dropped.
  // `starting` aborts a microphone still opening, so Cancel or closing the chat closes it at once.
  // `sending` aborts a transcription on its way, so a dropped recording never goes on to the backup.
  const live = useRef<{ capture?: Capture; starting?: AbortController; sending?: AbortController; turn: number }>({ turn: 0 });
  const latest = useRef({ transcribe, onTranscript });
  latest.current = { transcribe, onTranscript };

  useEffect(() => {
    const now = live.current;
    return () => {
      now.turn++;
      now.starting?.abort();
      now.sending?.abort();
      now.capture?.cancel();
      now.capture = undefined;
    };
  }, []);

  const send = async (recording: Recording) => {
    const turn = ++live.current.turn;
    live.current.sending?.abort();
    const sending = new AbortController();
    live.current.sending = sending;
    setNote(undefined);
    setState({ phase: "transcribing", seconds: recording.seconds });
    try {
      const got = await latest.current.transcribe!(recording.audio, recording.mime, sending.signal);
      if (turn !== live.current.turn) return;
      setState({ phase: "idle" });
      const fellBack = fellBackOf(got);
      if (got.text) latest.current.onTranscript(got.text);
      if (got.text && fellBack) setNote({ text: fellBack, info: true });
      else if (!got.text) setNote({ text: `${got.ran === "local" ? "This computer" : "Hermes"} heard no speech in the recording.${fellBack ? ` ${fellBack}` : ""}` });
    } catch (e) {
      if (turn !== live.current.turn) return;
      setState({ phase: "idle" });
      setNote({ text: errorText(e), retry: recording });
    }
  };

  const stop = () => {
    const capture = live.current.capture;
    if (!capture) return;
    live.current.capture = undefined;
    const recording = capture.stop();
    if (recording.seconds < MIN_SECONDS) {
      live.current.turn++;
      setState({ phase: "idle" });
      setNote({ text: "The recording was too short to transcribe." });
      return;
    }
    void send(recording);
  };

  // The clock and level meter move while recording, and a recording stops by itself at the limit.
  useEffect(() => {
    if (state.phase !== "recording") return;
    const id = setInterval(() => (state.capture.seconds() >= MAX_RECORDING_SECONDS ? stop() : tick()), 200);
    return () => clearInterval(id);
  }, [state]);

  const start = async () => {
    if (state.phase !== "idle" || !latest.current.transcribe) return;
    const turn = ++live.current.turn;
    const starting = new AbortController();
    live.current.starting = starting;
    setNote(undefined);
    setState({ phase: "starting" });
    try {
      const capture = await startCapture(
        (why) => {
          if (turn !== live.current.turn) return;
          live.current.capture = undefined;
          live.current.turn++;
          setState({ phase: "idle" });
          setNote({ text: why });
        },
        starting.signal,
        env,
      );
      if (turn !== live.current.turn) return capture.cancel();
      live.current.capture = capture;
      setState({ phase: "recording", capture });
    } catch (e) {
      if (turn !== live.current.turn || e instanceof CaptureAborted) return;
      setState({ phase: "idle" });
      setNote({ text: errorText(e) });
    } finally {
      if (live.current.starting === starting) live.current.starting = undefined;
    }
  };

  const cancel = () => {
    live.current.turn++;
    live.current.starting?.abort();
    live.current.sending?.abort();
    live.current.capture?.cancel();
    live.current.capture = undefined;
    setState({ phase: "idle" });
  };

  return {
    state,
    note,
    start,
    stop,
    cancel,
    retry: () => note?.retry && void send(note.retry),
    dismiss: () => setNote(undefined),
    active: state.phase !== "idle",
  };
}

export type Dictation = ReturnType<typeof useDictation>;

/** The composer's microphone button. `blocked`: why Dictation can't be used now. */
export function MicButton({ dictation, blocked }: { dictation: Dictation; blocked?: string }) {
  return (
    <button
      className="icon-btn"
      title={blocked ?? "Dictate a message: records until you stop, then puts the text here to edit"}
      aria-label="Dictate"
      aria-disabled={!!blocked}
      onClick={() => !blocked && void dictation.start()}
    >
      <Mic size={16} />
    </button>
  );
}

/** What's happening with a recording, in place of the composer's key hints, with its Stop and Cancel buttons. */
export function DictationStrip({ dictation }: { dictation: Dictation }) {
  const { state } = dictation;
  if (state.phase === "idle") return null;
  // While waiting, focus sits on Cancel: the button that started this is gone, and Esc has to reach the composer.
  const cancel = (
    <button
      className="icon-btn"
      title="Cancel (Esc)"
      aria-label={state.phase === "recording" ? "Cancel recording" : "Cancel"}
      autoFocus={state.phase !== "recording"}
      onClick={dictation.cancel}
    >
      <X size={15} />
    </button>
  );
  if (state.phase === "starting")
    return (
      <div className="dictation" role="status">
        <Spinner /> <span>Waiting for the microphone…</span>
        <span className="dictation-fill" />
        {cancel}
      </div>
    );
  if (state.phase === "transcribing")
    return (
      <div className="dictation" role="status">
        <Spinner /> <span>Transcribing {clock(state.seconds)} of audio…</span>
        <span className="dictation-fill" />
        {cancel}
      </div>
    );
  const level = state.capture.level();
  return (
    <div className="dictation recording" role="status" aria-label="Recording">
      <span className="rec-dot" aria-hidden />
      <span>Recording</span>
      <span className="dictation-clock">
        {clock(state.capture.seconds())} / {clock(MAX_RECORDING_SECONDS)}
      </span>
      <span className="level" aria-hidden>
        <span style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
      <span className="dictation-fill" />
      {cancel}
      {/* The microphone button it replaces had focus; Enter here finishes, Esc cancels. */}
      <button className="btn dictation-stop" title="Stop and transcribe" autoFocus onClick={dictation.stop}>
        <Check size={14} /> Done
      </button>
    </div>
  );
}

/** The last recording's problem above the composer, with Try again when the recording is still held. */
export function DictationNoteView({ dictation }: { dictation: Dictation }) {
  const { note } = dictation;
  if (!note) return null;
  return (
    <div className={`voice-note${note.info ? " info" : ""}`} role={note.info ? "status" : "alert"}>
      <span>{note.text}</span>
      {note.retry && (
        <button className="link-btn" onClick={dictation.retry}>
          <RotateCcw size={12} /> Try again
        </button>
      )}
      <button className="link-btn" onClick={dictation.dismiss} aria-label={note.retry ? "Discard the recording" : "Dismiss"}>
        {note.retry ? "Discard" : "Dismiss"}
      </button>
    </div>
  );
}

/** Read aloud under a reply. `blocked`: why it can't be used now; a reply already playing can still be stopped. */
export function ListenButton({ speaker, itemId, text, blocked }: { speaker: Speaker; itemId: string; text: string; blocked?: string }) {
  const now = useSyncExternalStore(speaker.subscribe, () => speaker.of(itemId));
  const busy = now?.phase === "loading" || now?.phase === "playing";
  const off = !!blocked && !busy;
  return (
    <div className={`msg-actions ${now ? "active" : ""}`}>
      <button
        className="msg-action"
        title={off ? blocked : busy ? "Stop reading aloud" : "Have Hermes read this reply aloud"}
        aria-disabled={off}
        aria-pressed={busy}
        onClick={() => !off && speaker.toggle(itemId, text)}
      >
        {now?.phase === "loading" ? <Spinner /> : busy ? <Square size={10} fill="currentColor" /> : <Volume2 size={13} />}
        <span>{now?.phase === "loading" ? "Getting audio…" : busy ? "Stop" : "Read aloud"}</span>
      </button>
      {now?.phase === "failed" && (
        <span className="msg-action-error" role="alert">
          {now.why}
        </span>
      )}
    </div>
  );
}

/** Why Read aloud can't be used now, or undefined. */
export function listenBlocked(status: ConnectionStatus, setup: VoiceSetup | undefined): string | undefined {
  if (status !== "connected") return "Connect to Hermes to read replies aloud.";
  return readAloudBlocked(setup);
}

/**
 * Why Dictation can't be started now, or undefined. When this computer transcribes, first or as backup, it can be
 * tried without Hermes: if it isn't set up, the recording's note says why.
 */
export function micBlocked(status: ConnectionStatus, setup: VoiceSetup | undefined, stt: Readonly<SttPrefs> = DEFAULT_STT_PREFS): string | undefined {
  if (inRoute(stt, "local")) return undefined;
  if (status !== "connected") return "Connect to Hermes to dictate: it does the transcribing.";
  return dictationBlocked(setup);
}

/** How a Voice conversation's turns end with this profile's `voice.*` settings, as a Settings row says it. */
function conversationTurns(setup: VoiceSetup): { label: string; needs: string; more: string } {
  const t = turnSettings(setup);
  const source = (fromProfile: boolean) => (fromProfile ? "the profile's" : "Hermes's default");
  return {
    label: `Ends a turn after ${t.silenceSeconds} s of quiet`,
    needs: "Needs Dictation and Read aloud. Hands-free: you speak, Hermes answers aloud, in turn.",
    more:
      `A turn ends after ${t.silenceSeconds} s of quiet (voice.silence_duration, ${source(t.fromProfile.silence)}), ` +
      `below loudness ${t.threshold} (voice.silence_threshold, ${source(t.fromProfile.threshold)}), and lasts at most ${Math.round(t.maxSeconds)} s ` +
      `(voice.max_recording_seconds, ${source(t.fromProfile.max)}).`,
  };
}

/** Settings → Voice: what the profile's providers are and need, and where recordings go. */
export function VoiceSettings({
  status,
  profile,
  setup,
  changes = 0,
}: {
  status: ConnectionStatus;
  profile: string;
  setup?: () => Promise<VoiceSetup>;
  /** Goes up each time the set-up may have changed, to read it again. */
  changes?: number;
}) {
  const [got, setGot] = useState<{ setup?: VoiceSetup; error?: string }>();
  const connected = status === "connected";
  useEffect(() => {
    if (!setup || !connected) return;
    let live = true;
    setup().then(
      (s) => live && setGot({ setup: s }),
      (e) => live && setGot({ error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [setup, connected, profile, changes]);

  const s = got?.setup;
  const stt = useSyncExternalStore(sttRoute.subscribe, sttRoute.get);
  const row = (name: string, blocked: string | undefined, provider: { label: string; needs: string; more?: string }) => (
    <SettingRow
      name={name}
      hint={blocked ?? provider.needs}
      more={provider.more}
      control={blocked ? <span className="badge warn">Unavailable</span> : <span className="badge">{provider.label}</span>}
    />
  );

  return (
    <SettingsSection
      title="Dictation and Read aloud"
      intro={
        <>
          Dictation, Read aloud and voice conversations use the <span className="mono">{profile}</span> profile's speech providers on Hermes, or this
          computer for speech to text.
        </>
      }
      more={
        <>
          <p>
            Dictate a message with the microphone in the composer: the text lands in the composer for you to edit before sending. Read aloud, under a
            reply, has Hermes speak it. Start voice conversation, beside the microphone, does both in turn, hands-free, until you end it. Hermes does
            them on the server, so the providers' keys never reach this app, unless you have this computer do the speech to text (below).
          </p>
          <p>
            Change the providers under Speech providers, below. The microphone is
            open only while you record, or while a voice conversation is on; a conversation pauses when you leave its chat pane or hide the window,
            and only you can resume it. Recordings stay in memory here and go to Hermes, and on to the provider if it's a cloud one; Hermes deletes
            its copy once it has the text. Transcribed on this computer, they never leave it; with This computer and no backup, they never go to
            Hermes. Recordings stop by themselves after {MAX_RECORDING_SECONDS / 60} minutes.
          </p>
        </>
      }
    >
      {!connected ? (
        <SettingNote>Connect to Hermes to see this profile's voice set-up.</SettingNote>
      ) : got?.error ? (
        <SettingNote tone="bad" role="alert">
          Couldn't read the voice set-up: {got.error}
        </SettingNote>
      ) : !s ? (
        <SettingNote>
          <Spinner /> Reading the voice set-up…
        </SettingNote>
      ) : (
        <>
          {row("Dictation", inRoute(stt, "local") ? undefined : dictationBlocked(s), sttProvider(s))}
          {row("Read aloud", readAloudBlocked(s), ttsProvider(s))}
          {row("Voice conversation", conversationBlocked(status, s, true, stt), conversationTurns(s))}
        </>
      )}
    </SettingsSection>
  );
}
