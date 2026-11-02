// The pipe under the frontend Hermes transport: JSON-RPC text frames in and out of `/api/ws`, plus
// signed-in dashboard REST calls, the local files the owner attaches, and the dashboard's audio routes for Dictation
// and Read aloud. In the app it is the Rust side (tauriPipe.ts); in tests it is FakeHermes.

/** A local file as `statFiles` finds it: its size, or why it can't be attached (e.g. "it's a folder"). */
export type LocalFile = { path: string; name: string; size?: number; error?: string };

/** What Hermes heard in a recording: `text` is empty when it heard no speech. `provider`: the one that transcribed it. */
export type Transcript = { text: string; provider?: string };

/** A reply read aloud: an audio file's bytes and MIME type, such as `audio/mpeg`. */
export type Speech = { mime: string; audio: Uint8Array; provider?: string };

/**
 * A profile's voice set-up as far as the app can tell: whether the server has the transcription and speech routes, and
 * which providers the profile's config names. `sttEnabled` and the providers are missing when the config couldn't be
 * read. The config itself never reaches the webview, since its provider sections can hold API keys.
 */
export type VoiceSetup = { transcribe: boolean; speak: boolean; sttEnabled?: boolean; sttProvider?: string; ttsProvider?: string };

export type PipeEvent = { kind: "frame"; text: string } | { kind: "closed"; reason: string };

/**
 * How the pipe reaches the dashboard: through an SSH tunnel, or straight to the URL the owner typed. For a URL whose
 * host is a name, `addresses` are the IP addresses Rust resolved it to.
 */
export type Route = { kind: "ssh"; target: string } | { kind: "url"; url: string; addresses: string[] };

/** The dashboard REST verbs the Rust side relays. POST and PUT reach only Settings → Model's two write routes. */
export type RestMethod = "GET" | "PATCH" | "DELETE" | "POST" | "PUT";

export interface Pipe {
  readonly route: Route;
  send(frame: string): Promise<void>;
  /**
   * One dashboard REST call with the sign-in cookies, e.g. `request("GET", "api/sessions?order=recent")`.
   * `body` is JSON text. Resolves to the response body text on 2xx; rejects with a readable message otherwise.
   */
  request(method: RestMethod, pathAndQuery: string, body?: string): Promise<string>;
  /**
   * A dashboard REST `GET` whose answer may be big, such as a server file's contents for the file browser. Rejects,
   * without reading the rest, once the answer passes `maxBytes`; otherwise like `request`.
   */
  getLimited(pathAndQuery: string, maxBytes: number): Promise<string>;
  statFiles(paths: string[]): Promise<LocalFile[]>;
  /**
   * Sends one frame: `head`, the file at `path` as base64, then `tail`. The bytes go from disk to Hermes
   * without passing through the webview. Rejects without sending if the file is now over `maxBytes`.
   */
  sendFile(head: string, path: string, tail: string, maxBytes: number): Promise<void>;
  /** Sends a recording to Hermes to transcribe with `profile`'s speech-to-text provider. */
  transcribe(profile: string, audio: Uint8Array, mime: string): Promise<Transcript>;
  /** Asks Hermes to read `text` aloud with `profile`'s text-to-speech provider. */
  speak(profile: string, text: string): Promise<Speech>;
  voiceSetup(profile: string): Promise<VoiceSetup>;
  close(): Promise<void>;
}

/**
 * Opens the pipe, with `/api/ws` opened for `profile`. Frames may arrive on `onEvent` before the returned promise
 * resolves. It can be called again after the pipe closes, to reconnect or to switch profile.
 */
export type OpenPipe = (onEvent: (e: PipeEvent) => void, profile: string) => Promise<Pipe>;
