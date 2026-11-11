// A Voice conversation in the chat pane (ADR 0111): the Start voice conversation button beside Dictation's, and the
// panel above the composer while one is on. The conversation itself is conversation.ts.
import { forwardRef, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { AudioLines, Mic, MicOff, PhoneOff, RotateCcw, Send, Settings2, Square, Trash2, Volume2 } from "lucide-react";
import type { VoiceSetup } from "../hermes/pipe";
import type { ConnectionStatus, Item } from "../hermes/model";
import type { Delivery } from "../hermes/transport";
import { clock, sttProvider, ttsProvider } from "../hermes/voice";
import { type TurnSettings, conversationBlocked, turnSettings } from "../hermes/voiceTurns";
import type { SttPrefs } from "../hermes/sttRoute";
import { type ConversationState, type Heard, VoiceConversation } from "./conversation";
import type { AudioEnv } from "./recorder";
import type { Speaker } from "./speaker";
import type { VoiceApi } from "./Voice";
import { Spinner } from "./bits";

const subscribePage = (fn: () => void) => {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
};
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** The page is hidden: the window is minimized, or on another workspace, as the webview reports it. */
export const usePageHidden = () => useSyncExternalStore(subscribePage, pageHidden, () => false);

/**
 * Why a conversation that is on must pause now, or undefined (ADR 0111's policy). It pauses rather than carrying on
 * whenever the owner can't see it: Hermes disconnected, the window hidden to the tray or minimized, or the pane no
 * longer the focused one (the other pane, Settings, or another screen in front). Nothing resumes it but the owner.
 */
export function conversationAway(o: { status: ConnectionStatus; windowHidden: boolean; pageHidden: boolean; active: boolean }): string | undefined {
  if (o.status !== "connected") return "Hermes disconnected, so the conversation paused and the microphone closed. It won't restart by itself: resume once Hermes is back.";
  if (o.windowHidden) return "The window was hidden to the tray, so the conversation paused and the microphone closed.";
  if (o.pageHidden) return "The window was minimized, so the conversation paused and the microphone closed.";
  if (!o.active) return "You moved to another pane or screen, so the conversation paused and the microphone closed.";
  return undefined;
}

/**
 * The chat pane's Voice conversation: made once the pane has its Speaker, and ended when the pane goes (another chat,
 * profile or server). It follows the chat, and pauses as `conversationAway` says.
 */
export function useVoiceConversation(o: {
  voice?: VoiceApi;
  speaker?: Speaker;
  send?: (text: string) => Promise<{ delivery: Delivery; itemId?: string }>;
  stopReply: () => void;
  chat: { running?: boolean; items: Item[] };
  away?: string;
  env?: AudioEnv;
}): VoiceConversation | undefined {
  const latest = useRef(o);
  latest.current = o;
  const [conversation, setConversation] = useState<VoiceConversation>();
  useEffect(() => {
    if (!o.speaker || !o.voice) return;
    const c = new VoiceConversation({
      // The signal goes on, so End or a pause stops the router before it tries the backup (ADR 0065).
      transcribe: (audio, mime, signal) => latest.current.voice!.transcribe(audio, mime, signal),
      send: (text) =>
        latest.current.send ? latest.current.send(text) : Promise.resolve({ delivery: { delivery: "unsent", reason: "This chat can't take messages now." } }),
      stopReply: () => latest.current.stopReply(),
      speaker: o.speaker,
      env: o.env,
    });
    setConversation(c);
    return () => c.dispose();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [o.speaker, !o.voice]);
  useEffect(() => conversation?.observe({ running: !!o.chat.running, items: o.chat.items }), [conversation, o.chat.running, o.chat.items]);
  useEffect(() => conversation?.setAway(o.away), [conversation, o.away]);
  return conversation;
}

/** The composer's Start voice conversation button. `blocked`: why it can't start now; clicking then says why. */
export const StartConversationButton = forwardRef<HTMLButtonElement, { blocked?: string; onStart: () => void; onBlocked: (why: string) => void }>(
  function StartConversationButton({ blocked, onStart, onBlocked }, ref) {
    return (
      <button
        ref={ref}
        className="icon-btn"
        aria-label="Start voice conversation"
        title={blocked ?? "Start voice conversation: talk with Hermes hands-free, and hear its replies"}
        aria-disabled={!!blocked}
        onClick={() => (blocked ? onBlocked(blocked) : onStart())}
      >
        <AudioLines size={16} />
      </button>
    );
  },
);

/** What the conversation is doing, as one sentence for the status line. */
function statusText(s: ConversationState, settings: TurnSettings, playing: boolean): string {
  const quiet = `${settings.silenceSeconds} s`;
  switch (s.phase) {
    case "starting":
      return "Opening the microphone…";
    case "listening":
      if (s.waitingOn === "approval") return "Hermes is waiting for your approval above. Listening starts again once it's answered.";
      if (s.waitingOn === "question") return "Hermes is waiting for your answer above. Listening starts again once it's answered.";
      if (s.waitingOn === "other-reply") return "Hermes is replying to another message. Listening starts again when it's done.";
      if (s.muted) return "Muted: Hermes hears nothing until you unmute.";
      if (playing) return "Not listening while audio plays.";
      return s.hearing ? `Hearing you. Pause for ${quiet} to send, or press Send now.` : `Listening. Speak, then pause for ${quiet} to send.`;
    case "transcribing":
      return "Hermes is transcribing what you said…";
    case "sending":
      return "Sending what you said to the chat…";
    case "thinking":
      return s.waitingOn === "approval" ? "Hermes is waiting for your approval above." : s.waitingOn === "question" ? "Hermes is waiting for your answer above." : "Hermes is thinking…";
    case "speaking":
      return "Hermes is speaking. The microphone is shut until it finishes.";
    case "paused":
      return "Paused. The microphone is closed.";
    default:
      return "";
  }
}

const HEARD_STATE: Record<Heard["state"], string> = {
  sending: "Sending…",
  sent: "Sent",
  failed: "Not delivered",
  unknown: "May not have arrived",
  "not-sent": "Not sent",
};

/** Listening, Thinking and Speaking, with the one under way marked. */
function Steps({ s }: { s: ConversationState }) {
  const at =
    s.phase === "listening" || s.phase === "starting"
      ? "listening"
      : s.phase === "transcribing" || s.phase === "sending" || s.phase === "thinking"
        ? "thinking"
        : s.phase === "speaking"
          ? "speaking"
          : undefined;
  const step = (key: string, label: string) => (
    <li className={`conv-step ${at === key ? "on" : ""}`} aria-current={at === key ? "step" : undefined}>
      {label}
    </li>
  );
  return (
    <ol className="conv-steps" aria-label="Conversation steps">
      {step("listening", "Listening")}
      {step("thinking", "Thinking")}
      {step("speaking", "Speaking")}
    </ol>
  );
}

/**
 * The conversation's panel: the microphone and what the conversation is doing, the controls for each step, what
 * reached Hermes, and what is recorded and where it goes. Focus lands on it as it opens; Esc stops the reply's audio.
 */
export function ConversationPanel({
  conversation,
  setup,
  onEnd,
  onSettings,
}: {
  conversation: VoiceConversation;
  setup?: VoiceSetup;
  onEnd: () => void;
  /** Opens Settings → Voice, to change the providers; the conversation pauses as its pane goes out of focus. */
  onSettings?: () => void;
}) {
  const s = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const settings = turnSettings(setup);
  const ref = useRef<HTMLElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => ref.current?.focus(), []);
  // The level meter and the turn's clock move while listening.
  useEffect(() => {
    if (s.phase !== "listening") return;
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [s.phase]);
  const playing = s.playing;
  const level = conversation.level();
  const micOpen = s.phase !== "paused" && s.phase !== "starting";
  const stt = setup ? sttProvider(setup) : undefined;
  const tts = setup ? ttsProvider(setup) : undefined;

  return (
    <section
      ref={ref}
      className="conversation"
      aria-label="Voice conversation"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && s.playing) {
          e.preventDefault();
          e.stopPropagation();
          conversation.stopSpeaking();
        }
      }}
    >
      <div className="conv-head">
        <span className={`conv-mic ${micOpen && !s.muted ? "open" : ""}`} title={micOpen ? (s.muted ? "Microphone muted" : "Microphone on") : "Microphone closed"}>
          {micOpen && !s.muted ? <Mic size={14} aria-hidden /> : <MicOff size={14} aria-hidden />}
          <span>{micOpen ? (s.muted ? "Muted" : "Mic on") : "Mic closed"}</span>
        </span>
        <Steps s={s} />
        {s.phase === "listening" && !s.muted && !s.waitingOn && (
          <span className="level" aria-hidden>
            <span style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        )}
        {s.phase === "listening" && s.hearing && <span className="dictation-clock">{clock(conversation.turnSeconds())}</span>}
      </div>
      <div className="conv-status" role="status" aria-live="polite">
        {(s.phase === "starting" || s.phase === "transcribing" || s.phase === "sending" || s.phase === "thinking") && <Spinner />}
        {s.phase === "speaking" && <Volume2 size={13} aria-hidden />}
        <span>{statusText(s, settings, playing)}</span>
      </div>
      {s.paused && (
        <div className="voice-note" role="alert">
          <span>{s.paused.why}</span>
          {s.paused.canRetry && (
            <button className="link-btn" aria-disabled={!!s.away} title={s.away} onClick={() => conversation.retry()}>
              <RotateCcw size={12} /> Try again
            </button>
          )}
          <button className="link-btn" aria-disabled={!!s.away} title={s.away ?? "Opens the microphone again"} onClick={() => conversation.resume()}>
            <Mic size={12} /> Resume listening
          </button>
        </div>
      )}
      {s.note && !s.paused && (
        <div className="voice-note" role="status">
          <span>{s.note}</span>
        </div>
      )}
      <div className="conv-controls">
        {s.phase === "listening" && (
          <>
            <button className="btn" onClick={() => conversation.sendNow()} aria-disabled={!s.hearing} title="End your turn now and send it, without waiting for the pause">
              <Send size={13} /> Send now
            </button>
            {s.hearing && (
              <button className="btn" onClick={() => conversation.discard()} title="Drop what was heard of this turn and keep listening">
                <Trash2 size={13} /> Discard
              </button>
            )}
          </>
        )}
        {(s.phase === "sending" || s.phase === "thinking") && (
          <button className="btn" onClick={() => conversation.stopReply()} title="Stop Hermes's reply itself, not just its audio">
            <Square size={11} fill="currentColor" /> Stop reply
          </button>
        )}
        {s.playing && (
          <button className="btn" onClick={() => conversation.stopSpeaking()} title="Stop the audio only (Esc): the reply stays in the chat">
            <Volume2 size={13} /> Stop speaking
          </button>
        )}
        {s.phase !== "paused" && (
          <button className="btn" aria-pressed={s.muted} onClick={() => conversation.toggleMute()}>
            {s.muted ? <Mic size={13} /> : <MicOff size={13} />} {s.muted ? "Unmute" : "Mute"}
          </button>
        )}
        <label className="conv-device">
          <span>Microphone</span>
          <select value={s.deviceId ?? ""} onChange={(e) => conversation.pickDevice(e.target.value)}>
            <option value="">System default{s.deviceLabel && !s.deviceId ? ` (${s.deviceLabel})` : ""}</option>
            {s.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
            {s.deviceId && !s.devices.some((d) => d.id === s.deviceId) && <option value={s.deviceId}>Picked microphone (not found)</option>}
          </select>
        </label>
        <span className="dictation-fill" />
        <button className="btn danger" onClick={onEnd}>
          <PhoneOff size={13} /> End conversation
        </button>
      </div>
      <div className="conv-heard-wrap">
        <div className="conv-heard-title">What Hermes got</div>
        {s.heard.length === 0 ? (
          <p className="muted small conv-empty">Nothing said yet. What you say shows here as the text sent to the chat.</p>
        ) : (
          <ol className="conv-heard" aria-label="What Hermes got">
            {s.heard.map((h) => (
              <li key={h.id} className={`conv-heard-${h.state}`}>
                <span className="conv-heard-text">“{h.text}”</span>
                <span className="conv-heard-state">
                  {HEARD_STATE[h.state]}
                  {h.why ? `: ${h.why}` : ""}
                </span>
                {h.via && <span className="conv-heard-via">{h.via}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {onSettings && (
        <div className="conv-settings">
          <span className="muted small">
            Hearing you with {stt?.label ?? "the profile's speech-to-text provider"}, speaking with {tts?.label ?? "the profile's text-to-speech provider"}.
          </span>
          <button className="link-btn" onClick={onSettings} title="Pick the speech providers, their voice, model and language, in Settings → Voice. The conversation pauses meanwhile.">
            <Settings2 size={12} aria-hidden /> Change voice settings
          </button>
        </div>
      )}
      <details className="conv-about">
        <summary>What is recorded, and where it goes</summary>
        <p>
          While the conversation is on, the microphone on this computer is open. Only what you say while it's listening is kept, in memory, one turn
          at a time; it's thrown away while Hermes speaks, while muted, and once sent.{" "}
          {setup?.sttLocal
            ? `Each turn is transcribed by ${stt?.label}: the audio never leaves this computer, and only the text goes to this chat as your message.`
            : `Each turn goes to Hermes, which transcribes it with ${stt?.label ?? "the profile's speech-to-text provider"} and puts the text in this chat as your message.`}{" "}
          Replies are spoken with{" "}
          {tts?.label ?? "the profile's text-to-speech provider"}. A cloud provider gets the audio or text from the Hermes server. The audio is never
          saved on this computer. The text sent is a chat message like any other, kept on this computer as typed messages are: in the chat's Saved
          copy, and as a Failed message if Hermes didn't take it.
        </p>
        <p>
          A turn ends after {settings.silenceSeconds} s of quiet{settings.fromProfile.silence ? "" : " (Hermes's default)"} and lasts at most{" "}
          {Math.round(settings.maxSeconds)} s. The profile's <span className="mono">voice.silence_duration</span>,{" "}
          <span className="mono">voice.silence_threshold</span> and <span className="mono">voice.max_recording_seconds</span> set them.
        </p>
        {stt && <p>{stt.needs}</p>}
      </details>
    </section>
  );
}

/** Why the conversation can't start in this chat now, for the Start button. */
export function startBlocked(status: ConnectionStatus, setup: VoiceSetup | undefined, started: boolean, dictating: boolean, stt?: Readonly<SttPrefs>): string | undefined {
  return conversationBlocked(status, setup, started, stt) ?? (dictating ? "Finish or cancel the dictation first." : undefined);
}
