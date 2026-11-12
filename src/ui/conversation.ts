// A Voice conversation (ADR 0111): the owner talks, Hermes answers out loud, and it goes round until the owner ends it.
// Each turn is the tested Dictation and Read aloud contracts in a loop: this computer's microphone records until the
// owner stops speaking (voiceTurns.ts), Hermes transcribes the recording (`POST /api/audio/transcribe`), the text goes
// to the chat as the owner's message, and Hermes's reply is spoken with the chat's Speaker (`POST /api/audio/speak`).
//
// Safety rules this class keeps:
// - The microphone opens only when the owner starts or resumes the conversation, and closes when it pauses or ends.
//   Nothing reopens it by itself: not a reconnect, not the window coming back.
// - It is half-duplex. While anything plays in the pane, and for a moment after, the microphone's samples are thrown
//   away, so Hermes's own voice can't become the owner's next turn; a transcript that repeats the reply just spoken
//   is not sent either.
// - Audio lives in memory only, and only one turn's worth: the quiet before speech is trimmed to half a second, and a
//   turn stops at its length limit.
// - Each recording is sent to Hermes at most once, and late answers from before a pause or End are dropped.
import { SttFailed, fellBackOf, type HeardTranscript } from "../hermes/sttRoute";
import type { Delivery } from "../hermes/transport";
import { type Item, isWaiting } from "../hermes/model";
import { toWav } from "../hermes/voice";
import { TurnDetector, type TurnEnd, type TurnSettings, isEcho, rms16 } from "../hermes/voiceTurns";
import { type AudioEnv, CaptureAborted, type Microphone, type Recording, browserEnv, openMicrophone } from "./recorder";
import type { Speaker } from "./speaker";
import { errorText } from "../hermes/values";

/** Quiet kept before speech starts, so its first syllable isn't cut off. */
export const PREROLL_SECONDS = 0.5;
/** After anything stops playing, the microphone stays shut this long: speakers sound a little after the audio ends. */
export const ECHO_TAIL_SECONDS = 0.6;
/** Speech starting this soon after playback ends is checked against what was played, as a possible echo. */
export const ECHO_WINDOW_SECONDS = 3;
/** The most entries "What Hermes got" keeps; older ones drop off. */
export const HEARD_LIMIT = 20;
/** A manual Send needs at least this much of a turn. */
const MIN_TURN_SECONDS = 0.3;

/** What a waiting Question in `items` holds the conversation for: an Approval, or any other Question. */
const waitingOnOwner = (items: Item[]) => {
  const asked = items.find(isWaiting);
  return asked && (asked.kind === "approval" ? ("approval" as const) : ("question" as const));
};

/**
 * Where the conversation is. `starting`: the microphone is opening. `listening`: waiting for the owner, or hearing
 * them. `transcribing`: Hermes is turning the turn into text. `sending`: the text is on its way to the chat.
 * `thinking`: Hermes is replying. `speaking`: the reply is being fetched as audio or played. `paused`: the microphone
 * and audio are let go of until the owner resumes.
 */
export type ConversationPhase = "off" | "starting" | "listening" | "transcribing" | "sending" | "thinking" | "speaking" | "paused";

/**
 * One thing the owner said that became text: what was sent, or wasn't, and what became of it. `sending`, `sent` (Hermes
 * took it), `failed` (it didn't), `unknown` (it may have: the chat settles it), `not-sent` (kept back, `why` says why).
 */
export type Heard = { id: number; text: string; state: "sending" | "sent" | "failed" | "unknown" | "not-sent"; why?: string; via?: string };

export type MicDevice = { id: string; label: string };

/**
 * What the owner sees. `hearing`: speech has been heard in this turn. `waitingOn`: what the conversation waits for
 * before it listens or speaks: Hermes's reply to the owner, an Approval, or a reply it didn't ask for (a typed or queued
 * message). `paused.canRetry`: a recording Hermes couldn't transcribe is held to try again. `note`: the last thing to
 * know that didn't stop the conversation. `deviceId`: the microphone picked, or the system's default. `playing`: audio
 * is loading or playing in the pane, the conversation's or a Read aloud, so the microphone is shut. `away`: why it
 * can't resume now (Hermes disconnected, the window hidden, another pane focused); it stays paused until that clears
 * and the owner resumes.
 */
export type ConversationState = {
  phase: ConversationPhase;
  muted: boolean;
  hearing: boolean;
  playing: boolean;
  waitingOn?: "reply" | "approval" | "question" | "other-reply";
  paused?: { why: string; canRetry: boolean };
  note?: string;
  heard: Heard[];
  devices: MicDevice[];
  deviceId?: string;
  deviceLabel?: string;
  away?: string;
};

/** What a conversation needs from the chat pane. `send` puts text in the chat as the owner's message. */
export type ConversationDeps = {
  transcribe: (audio: Uint8Array, mime: string, signal?: AbortSignal) => Promise<HeardTranscript>;
  send: (text: string) => Promise<{ delivery: Delivery; itemId?: string }>;
  /** Stops Hermes's reply (the composer's Stop), not just its audio. */
  stopReply: () => void;
  speaker: Speaker;
  env?: AudioEnv;
};

/** The chat as the conversation follows it. */
export type ChatView = { running: boolean; items: Item[] };

/** A turn on its way to Hermes. `echo`: the reply that played just before it began, to compare. */
type Turn = { seq: number; recording: Recording; echo?: string };

/** The microphone last picked, for the rest of this run of the app only: device ids aren't stored. */
let picked: string | undefined;

const OFF: ConversationState = { phase: "off", muted: false, hearing: false, playing: false, heard: [], devices: [] };

export class VoiceConversation {
  private state: ConversationState = { ...OFF, deviceId: picked };
  private readonly listeners = new Set<() => void>();
  /** Bumped by every pause and End, so whatever was on its way from before is dropped. */
  private session = 0;
  /** Bumped by every microphone opened or closed, so a late open is closed again. */
  private micTurn = 0;
  private mic?: Microphone;
  private opening?: AbortController;
  private settings?: TurnSettings;
  private detector?: TurnDetector;
  private chunks: Float32Array[] = [];
  private chunkSeconds = 0;
  /** Seconds of microphone audio since the conversation started: the clock every timing here runs on. */
  private clock = 0;
  private loudness = 0;
  /** Aborts the transcription on its way, on End or a pause. */
  private transcribeAbort?: AbortController;
  /** The microphone is shut until this time on the clock (the echo tail). */
  private shutUntil = 0;
  /** When the pane last went quiet, and what had played: for the echo check. */
  private quietSince?: number;
  private echoText?: string;
  private wasPlaying = false;
  private seq = 0;
  private readonly sentSeqs = new Set<number>();
  private transcribing?: Turn;
  private held?: Turn;
  /** The message a turn became, while its reply is followed: its item in the chat, once Hermes took it. */
  private awaiting?: { itemId?: string; seenRunning: boolean };
  private speakingItem?: string;
  private chat: ChatView = { running: false, items: [] };
  private heardId = 0;
  private readonly unsubscribeSpeaker: () => void;
  private readonly env: AudioEnv;
  private disposed = false;

  constructor(private readonly deps: ConversationDeps) {
    this.env = deps.env ?? browserEnv();
    this.unsubscribeSpeaker = deps.speaker.subscribe(this.onSpeaker);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  /** How loud the microphone is now, 0 to 1, while it's listening. */
  level(): number {
    return this.listeningNow() ? this.loudness : 0;
  }

  /** Seconds of the turn heard so far. */
  turnSeconds(): number {
    return this.detector?.attempting ? this.chunkSeconds : 0;
  }

  get on(): boolean {
    return this.state.phase !== "off";
  }

  /** Starts listening, with the profile's turn settings. Only from off: a paused conversation is resumed instead. */
  start(settings: TurnSettings): void {
    if (this.disposed || this.state.phase !== "off") return;
    this.settings = settings;
    this.detector = new TurnDetector(settings);
    this.clock = this.shutUntil = 0;
    this.quietSince = this.echoText = undefined;
    this.wasPlaying = this.playing();
    this.env.mediaDevices?.addEventListener?.("devicechange", this.refreshDevices);
    this.set({ ...OFF, devices: this.state.devices, deviceId: this.state.deviceId, phase: "starting", playing: this.wasPlaying, away: this.state.away });
    this.openMic();
  }

  /** Ends the conversation: the microphone closes, audio stops, and nothing on its way is used. */
  end(): void {
    if (this.state.phase === "off") return;
    this.session++;
    this.transcribeAbort?.abort();
    // Forgotten first, so the speaker stopping below doesn't read as the reply ending and listen again.
    this.speakingItem = undefined;
    this.held = this.transcribing = this.awaiting = undefined;
    this.closeMic();
    this.deps.speaker.stop();
    this.dropTurn();
    this.env.mediaDevices?.removeEventListener?.("devicechange", this.refreshDevices);
    this.set({ ...OFF, devices: this.state.devices, deviceId: this.state.deviceId, away: this.state.away });
  }

  /** Ends it and lets go of everything: the chat closed, or the profile or server changed. */
  dispose(): void {
    this.end();
    this.disposed = true;
    this.unsubscribeSpeaker();
    this.listeners.clear();
  }

  /**
   * Pauses: the microphone closes and audio stops, until the owner resumes. A turn being transcribed is held, to try
   * again. A message already on its way still goes, and its fate still shows; its reply isn't spoken.
   */
  pause(why: string): void {
    const phase = this.state.phase;
    if (phase === "off" || phase === "paused") return;
    this.session++;
    // A held turn is sent again on resume; the run on its way stops here, so it never goes on to the backup meanwhile.
    this.transcribeAbort?.abort();
    this.speakingItem = undefined;
    if (this.transcribing) this.held = this.transcribing;
    this.transcribing = this.awaiting = undefined;
    this.closeMic();
    if (phase === "speaking" || this.playing()) this.deps.speaker.stop();
    this.dropTurn();
    this.set({ phase: "paused", paused: { why, canRetry: !!this.held }, waitingOn: undefined, hearing: false });
  }

  /**
   * Why the owner can't be talking with it now, or undefined once they can. A reason pauses the conversation; its
   * clearing resumes nothing (ADR 0111: no automatic restart).
   */
  setAway(why: string | undefined): void {
    if (why === this.state.away) return;
    this.set({ away: why });
    if (why) this.pause(why);
  }

  /** Listens again after a pause, dropping a held recording. Not while away. */
  resume(): void {
    if (this.state.phase !== "paused" || this.state.away) return;
    this.held = undefined;
    this.set({ phase: "starting", paused: undefined, note: undefined });
    this.openMic();
  }

  /** After a pause for a turn Hermes couldn't transcribe: sends that recording again, and listens again after. */
  retry(): void {
    const turn = this.held;
    if (this.state.phase !== "paused" || !turn || this.state.away) return;
    this.held = undefined;
    this.set({ paused: undefined, note: undefined });
    this.openMic();
    void this.transcribe(turn);
  }

  /** Ends the turn now and sends it, without waiting for the quiet. */
  sendNow(): void {
    if (this.state.phase !== "listening" || !this.listeningNow()) return;
    if (!this.detector?.attempting || this.chunkSeconds < MIN_TURN_SECONDS) {
      this.set({
        note: "Nothing to send yet: nothing loud enough to be speech was heard. If you spoke, this microphone may be quieter than the profile's voice.silence_threshold.",
      });
      return;
    }
    this.finishTurn("manual");
  }

  /** Drops what has been heard of this turn, and keeps listening. */
  discard(): void {
    if (this.state.phase !== "listening") return;
    this.dropTurn();
    this.set({ hearing: false });
  }

  /** Mutes or unmutes the microphone. Muted, it hears nothing and the turn so far is dropped. */
  toggleMute(): void {
    if (this.state.phase === "off") return;
    const muted = !this.state.muted;
    this.mic?.setEnabled(!muted);
    if (muted) this.dropTurn();
    this.set({ muted, hearing: muted ? false : this.state.hearing });
  }

  /** Stops the reply's audio only: Hermes's reply stays in the chat, and the conversation listens again. */
  stopSpeaking(): void {
    if (this.playing()) this.deps.speaker.stop();
  }

  /** Stops Hermes's reply itself, as the composer's Stop does. Its words so far stay in the chat and aren't spoken. */
  stopReply(): void {
    if (this.state.phase === "thinking" || this.state.phase === "sending") this.deps.stopReply();
  }

  /** Opens another microphone, or the system's default with "". */
  pickDevice(id: string): void {
    picked = id || undefined;
    this.set({ deviceId: picked });
    if (!this.mic && !this.opening) return;
    this.closeMic();
    this.dropTurn();
    this.openMic();
  }

  /** The chat changed: follows Hermes's reply to a turn, and stops listening while the chat is busy otherwise. */
  observe(chat: ChatView): void {
    this.chat = chat;
    if (this.awaiting && chat.running) this.awaiting.seenRunning = true;
    if (this.state.phase === "thinking") this.followReply();
    else if (this.state.phase === "listening") this.updateBusy();
  }

  // ---- the microphone ----

  private openMic() {
    const turn = ++this.micTurn;
    const opening = new AbortController();
    this.opening = opening;
    openMicrophone((data) => this.onChunk(turn, data), (why) => this.onLost(turn, why), { signal: opening.signal, env: this.env, deviceId: this.state.deviceId }).then(
      (mic) => {
        if (this.opening === opening) this.opening = undefined;
        if (turn !== this.micTurn) return mic.close();
        this.mic = mic;
        mic.setEnabled(!this.state.muted);
        this.set({ deviceLabel: mic.device?.label });
        void this.refreshDevices();
        if (this.state.phase === "starting") this.enterListening();
      },
      (e) => {
        if (this.opening === opening) this.opening = undefined;
        if (turn !== this.micTurn || e instanceof CaptureAborted) return;
        this.pause(errorText(e));
      },
    );
  }

  private closeMic() {
    this.micTurn++;
    this.opening?.abort();
    this.opening = undefined;
    this.mic?.close();
    this.mic = undefined;
    this.loudness = 0;
  }

  private onLost(turn: number, why: string) {
    if (turn !== this.micTurn) return;
    this.mic = undefined;
    this.pause(`${why} Plug it back in or pick another microphone, then resume.`);
  }

  private refreshDevices = async () => {
    const list = this.env.mediaDevices?.enumerateDevices;
    if (!list) return;
    try {
      const all = await list.call(this.env.mediaDevices);
      const devices = all
        .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      if (!this.disposed) this.set({ devices });
    } catch {
      // The list is a convenience; the default microphone still works without it.
    }
  };

  private playing(): boolean {
    const now = this.deps.speaker.current();
    return !!now && now.phase !== "failed";
  }

  /** Whether samples are heard now: listening, unmuted, nothing playing or just played, and the chat not busy. */
  private listeningNow(): boolean {
    const s = this.state;
    return s.phase === "listening" && !s.muted && !s.waitingOn && !this.playing() && this.clock >= this.shutUntil;
  }

  private onChunk(turn: number, data: Float32Array) {
    const mic = this.mic;
    if (turn !== this.micTurn || !mic || !this.detector) return;
    const seconds = data.length / mic.rate;
    this.clock += seconds;
    const rms = rms16(data);
    this.loudness = Math.min(1, (rms / 32_768) * 4);
    if (!this.listeningNow()) {
      if (this.chunks.length || this.detector.attempting) {
        this.dropTurn();
        if (this.state.hearing) this.set({ hearing: false });
      }
      return;
    }
    this.chunks.push(data);
    this.chunkSeconds += seconds;
    const end = this.detector.push(rms, this.clock);
    if (!this.detector.attempting) {
      // Only the moment before speech is kept while waiting for it.
      while (this.chunks.length > 1 && this.chunkSeconds - this.chunks[0].length / mic.rate >= PREROLL_SECONDS) {
        this.chunkSeconds -= this.chunks.shift()!.length / mic.rate;
      }
    }
    if (this.detector.hasSpoken !== this.state.hearing) this.set({ hearing: this.detector.hasSpoken });
    if (end) this.finishTurn(end);
  }

  private dropTurn() {
    this.detector?.reset();
    this.chunks = [];
    this.chunkSeconds = 0;
  }

  private finishTurn(how: TurnEnd | "manual") {
    const mic = this.mic;
    if (this.state.phase !== "listening" || !mic || !this.detector) return;
    const began = this.detector.startedAt;
    const recording: Recording = { audio: toWav(this.chunks, mic.rate), mime: "audio/wav", seconds: this.chunkSeconds };
    // A turn that begins straight after something played may be that playing, heard again.
    const echo = this.quietSince !== undefined && began !== undefined && began - this.quietSince <= ECHO_WINDOW_SECONDS ? this.echoText : undefined;
    this.dropTurn();
    const note =
      how === "limit" ? `That turn reached the ${Math.round(this.settings?.maxSeconds ?? 0)}-second limit, so it was sent as it was.` : undefined;
    this.set({ hearing: false, note });
    void this.transcribe({ seq: ++this.seq, recording, echo });
  }

  // ---- a turn's way to Hermes and back ----

  private async transcribe(turn: Turn) {
    const session = this.session;
    this.transcribeAbort?.abort();
    const abort = new AbortController();
    this.transcribeAbort = abort;
    this.transcribing = turn;
    this.set({ phase: "transcribing" });
    let got: HeardTranscript;
    try {
      got = await this.deps.transcribe(turn.recording.audio, turn.recording.mime, abort.signal);
    } catch (e) {
      if (session !== this.session) return;
      // Rust's own errors already say what failed; others get it said.
      const why = errorText(e);
      this.pause(e instanceof SttFailed ? why : `Hermes couldn't transcribe what you said: ${why}`);
      return;
    }
    if (session !== this.session || this.transcribing !== turn) return;
    this.transcribing = undefined;
    const text = got.text.trim();
    // Said under the turn when the backup did the transcribing (ADR 0065).
    const via = fellBackOf(got);
    if (!text) {
      const who = got.ran === "local" ? "This computer" : "Hermes";
      this.set({ note: `${who} heard no words in that, so nothing was sent.${via ? ` ${via}` : ""}` });
      return this.enterListening();
    }
    if (turn.echo && isEcho(text, turn.echo)) {
      this.addHeard({ text, state: "not-sent", why: "It repeated the reply Hermes had just spoken, so it was taken as an echo from the speakers.", via });
      return this.enterListening();
    }
    if (this.chat.running || this.chat.items.some(isWaiting)) {
      this.addHeard({ text, state: "not-sent", why: "Hermes was busy with another message by then. Say it again once it's done.", via });
      return this.enterListening();
    }
    // Never twice: a recording becomes one message at most.
    if (this.sentSeqs.has(turn.seq)) return;
    this.sentSeqs.add(turn.seq);
    await this.deliver(text, via);
  }

  private async deliver(text: string, via?: string) {
    const session = this.session;
    const id = this.addHeard({ text, state: "sending", via });
    const awaiting: { itemId?: string; seenRunning: boolean } = { seenRunning: false };
    this.awaiting = awaiting;
    this.set({ phase: "sending", waitingOn: "reply" });
    let delivery: Delivery;
    try {
      const sent = await this.deps.send(text);
      delivery = sent.delivery;
      awaiting.itemId = sent.itemId;
    } catch (e) {
      delivery = { delivery: "unsent", reason: errorText(e) };
    }
    // What became of it shows even after a pause: it is what Hermes got.
    const why = delivery.delivery === "accepted" ? undefined : delivery.reason;
    this.updateHeard(id, delivery.delivery === "accepted" ? "sent" : delivery.delivery === "unknown" ? "unknown" : "failed", why);
    if (session !== this.session) return;
    if (delivery.delivery !== "accepted") {
      this.awaiting = undefined;
      this.pause(
        delivery.delivery === "unknown"
          ? `Hermes may not have what you said: ${delivery.reason}. The chat settles it once it reads its history again.`
          : `Hermes didn't take what you said: ${delivery.reason}. It's in the chat as a failed message, to retry or dismiss there.`,
      );
      return;
    }
    if (this.chat.running) awaiting.seenRunning = true;
    this.set({ phase: "thinking" });
    this.followReply();
  }

  /**
   * While thinking: has Hermes finished replying to the turn's own message, and what is there to speak? Only the items
   * between that message and the next one from the owner (a typed or queued message that went after it) are its
   * reply, so another message's reply is never spoken in its place, whatever the texts.
   */
  private followReply() {
    const a = this.awaiting;
    if (!a?.itemId) return;
    const items = this.chat.items;
    const from = items.findIndex((i) => i.id === a.itemId);
    if (from < 0) {
      // The chat was read again and the message isn't where it was: nothing here can tell which reply is its.
      if (this.chat.running) return;
      this.awaiting = undefined;
      this.set({ note: "Couldn't tell which reply was to what you said, so it isn't spoken. It's in the chat above." });
      return this.enterListening();
    }
    let to = items.findIndex((i, n) => n > from && i.kind === "user" && !i.steer);
    if (to < 0) to = items.length;
    const after = items.slice(from + 1, to);
    // Another message from the owner has gone since: this turn's reply is over, whether or not the chat still runs.
    const over = to < items.length;
    if (this.chat.running && !over) {
      const waitingOn = waitingOnOwner(after) ?? "reply";
      if (waitingOn !== this.state.waitingOn) this.set({ waitingOn });
      return;
    }
    if (!over && !a.seenRunning && !after.some((i) => i.kind === "assistant" || i.kind === "error")) return;
    this.awaiting = undefined;
    // A stopped reply is marked on its last reply, which is empty when it was stopped during a tool call: checked
    // before empty replies are skipped, so the words from before the tool aren't spoken as if it had finished.
    if (after.some((i) => i.kind === "assistant" && i.interrupted)) {
      this.set({ note: "The reply was stopped, so it isn't spoken. What it said so far is in the chat." });
      return this.enterListening();
    }
    const last = [...after].reverse().find((i) => i.kind === "error" || (i.kind === "assistant" && i.text.trim()));
    if (!last) {
      this.set({ note: "Hermes's reply had no words to speak." });
      return this.enterListening();
    }
    if (last.kind === "error") {
      this.set({ note: `Hermes's reply failed: ${last.text}` });
      return this.enterListening();
    }
    if (last.kind !== "assistant") return this.enterListening();
    this.speakingItem = last.id;
    this.set({ phase: "speaking", waitingOn: undefined, note: undefined });
    this.deps.speaker.play(last.id, last.text);
  }

  private onSpeaker = () => {
    const now = this.deps.speaker.current();
    const playing = !!now && now.phase !== "failed";
    if (this.wasPlaying && !playing) {
      // Just went quiet: shut the microphone a moment longer, and remember what played.
      this.shutUntil = this.clock + ECHO_TAIL_SECONDS;
      this.quietSince = this.clock;
      this.echoText = this.deps.speaker.lastSpoken();
    }
    this.wasPlaying = playing;
    if (playing !== this.state.playing) this.set({ playing });
    if (this.state.phase !== "speaking" || !this.speakingItem) return;
    if (now?.itemId === this.speakingItem && playing) return;
    if (now?.itemId === this.speakingItem && now.phase === "failed")
      this.set({ note: `Couldn't speak the reply: ${now.why} It's in the chat above.` });
    this.speakingItem = undefined;
    this.enterListening();
  };

  private enterListening() {
    if (this.state.phase === "off" || this.state.phase === "paused") return;
    this.speakingItem = undefined;
    this.dropTurn();
    if (!this.mic) {
      this.set({ phase: "starting", hearing: false, waitingOn: undefined });
      if (!this.opening) this.openMic();
      return;
    }
    this.set({ phase: "listening", hearing: false });
    this.updateBusy();
  }

  private updateBusy() {
    const waitingOn = this.chat.running ? "other-reply" : waitingOnOwner(this.chat.items);
    if (waitingOn !== this.state.waitingOn) {
      if (waitingOn) this.dropTurn();
      this.set({ waitingOn, hearing: waitingOn ? false : this.state.hearing });
    }
  }

  // ---- state ----

  private addHeard(h: Omit<Heard, "id">): number {
    const id = ++this.heardId;
    this.set({ heard: [...this.state.heard, { id, ...h }].slice(-HEARD_LIMIT) });
    return id;
  }

  private updateHeard(id: number, state: Heard["state"], why?: string) {
    if (!this.state.heard.some((h) => h.id === id)) return;
    this.set({ heard: this.state.heard.map((h) => (h.id === id ? { ...h, state, why } : h)) });
  }

  private set(patch: Partial<ConversationState>) {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
