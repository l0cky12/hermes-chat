// The pipe under the frontend Hermes transport: JSON-RPC text frames in and out of `/api/ws`, plus
// signed-in dashboard REST calls, the local files the owner attaches, and the dashboard's audio routes for Dictation
// and Read aloud. In the app it is the Rust side (tauriPipe.ts); in tests it is FakeHermes.
import type { AttemptTrace } from "./attempts";
import type { McpEdit } from "./mcp";
import type { Downloaded, PickedUpload, TransferProgress } from "./remoteFiles";
import type { SavedKey } from "./setup";
import type { OpenScreenSocket } from "./screen";
import type { RouteVia } from "./routes";

/** A local file as `statFiles` finds it: its size, or why it can't be attached (e.g. "it's a folder"). */
export type LocalFile = { path: string; name: string; size?: number; error?: string };

/** What Hermes heard in a recording: `text` is empty when it heard no speech. `provider`: the one that transcribed it. */
export type Transcript = { text: string; provider?: string };

/** A reply read aloud: an audio file's bytes and MIME type, such as `audio/mpeg`. */
export type Speech = { mime: string; audio: Uint8Array; provider?: string };

/**
 * A profile's voice set-up as far as the app can tell: whether the server has the transcription and speech routes, and
 * which providers the profile's config names. `sttEnabled` and the providers are missing when the config couldn't be
 * read. The config itself never reaches the webview, since its provider sections can hold API keys. `silenceThreshold`,
 * `silenceDuration` and `maxRecordingSeconds` are the profile's `voice.*` turn settings, when it sets them to numbers;
 * a Voice conversation ends a turn with them as Hermes's own voice mode does (voiceTurns.ts).
 */
export type VoiceSetup = {
  transcribe: boolean;
  speak: boolean;
  sttEnabled?: boolean;
  sttProvider?: string;
  ttsProvider?: string;
  silenceThreshold?: number;
  silenceDuration?: number;
  maxRecordingSeconds?: number;
  /** `stt.language`: the language hint for every speech-to-text provider without its own. */
  sttLanguage?: string;
  /**
   * Each provider's model, voice and language, by its config section (`stt.<section>.<key>`, `tts.<section>.<key>`), for
   * Settings → Voice. Rust passes only those keys (`VOICE_SETTING_KEYS`), and only text: never an API key.
   */
  sttSettings?: Record<string, Record<string, string>>;
  ttsSettings?: Record<string, Record<string, string>>;
  /**
   * Set when speech to text runs on this computer first (ADR 0067, 0065): the engine's name, or why it can't run, and
   * whether Hermes is the backup. Not from Hermes: the app adds it from the owner's choice.
   */
  sttLocal?: { label?: string; problem?: string; backup?: boolean };
};

/**
 * What Settings → Toolsets needs from a profile's config besides the toolset list, read in Rust since the config can
 * hold API keys. `noMcp`: platforms whose toolset list names `no_mcp`, which Hermes clears on any toolset change.
 * `codingFocus`: `agent.coding_context` is focus, so Hermes picks a coding toolset in code workspaces.
 * `disabledEverywhere`: the names in `agent.disabled_toolsets`, which Hermes turns off on every platform; turning one of
 * them on removes it from that list. `disabledUnclear`: that list is saved in a form Rust can't read for certain, so any
 * toolset may be on it. `noMcpUnclear`: likewise for platforms whose toolset list may name `no_mcp`. `savedLists`: platforms
 * whose list the profile has saved; any other platform not in `noMcpUnclear` inherits Hermes's default list.
 */
export type ToolsetGuards = { noMcp: string[]; noMcpUnclear: string[]; savedLists: string[]; codingFocus: boolean; disabledEverywhere: string[]; disabledUnclear: boolean };

export type PipeEvent = { kind: "frame"; text: string } | { kind: "closed"; reason: string };

/**
 * How the pipe reaches the dashboard: through an SSH tunnel, or straight to the URL the owner typed. For a URL whose
 * host is a name, `addresses` are the IP addresses Rust resolved it to.
 */
export type Route = ({ kind: "ssh"; target: string } | { kind: "url"; url: string; addresses: string[] }) & {
  /** The server's id, a hash of its Hermes install id, when its status named one (ADR 0056). */
  server?: string;
  /** Which of the connection's routes this is, when it has more than one (routes.ts). */
  via?: RouteVia;
};

/** The dashboard REST verbs the Rust side relays. POST and PUT reach only Settings → Model's two write routes, the scheduled-job writes, Settings → Toolsets' switch, Settings → Persona's save, Settings → Skills' switch and save, and Settings → Voice's provider pick and key save (ADR 0055), among others listed at `Dashboard::request` in src-tauri/src/transport.rs. */
export type RestMethod = "GET" | "PATCH" | "DELETE" | "POST" | "PUT";

export interface Pipe {
  readonly route: Route;
  /** The record of this connection attempt (attempts.ts, #270), when one is kept: `dial()` adds the wait for `gateway.ready` and how it ended. */
  readonly attempt?: AttemptTrace;
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
  /**
   * Gives Hermes a model provider's API key for `profile`, after the provider has checked it. Only an env var Hermes
   * lists as a provider's secret is written, and the key isn't kept on this computer. Rejects if the provider turns
   * it down (src-tauri `Dashboard::save_provider_key`).
   */
  saveProviderKey(profile: string, envVar: string, key: string): Promise<SavedKey>;
  /**
   * Removes a model provider's API key from `profile`'s Hermes. Only an env var Hermes lists as a provider's secret is
   * removed, one that is already gone counts as removed, and it rejects if Hermes still lists the key afterwards. The
   * window's REST relay refuses `DELETE api/env`, so this is the only way (src-tauri `Dashboard::remove_provider_key`).
   */
  removeProviderKey(profile: string, envVar: string): Promise<void>;
  /** Sends a recording to Hermes to transcribe with `profile`'s speech-to-text provider. */
  transcribe(profile: string, audio: Uint8Array, mime: string): Promise<Transcript>;
  /** Asks Hermes to read `text` aloud with `profile`'s text-to-speech provider. */
  speak(profile: string, text: string): Promise<Speech>;
  voiceSetup(profile: string): Promise<VoiceSetup>;
  toolsetGuards(profile: string): Promise<ToolsetGuards>;
  /**
   * Settings → MCP servers' edit of one server for `profile` (src-tauri `Dashboard::mcp_edit`, ADR 0068): Rust reads the
   * profile's raw config, changes that one server and writes Hermes's whole map back. Optional: without it, servers can
   * be added, removed and switched but not edited.
   */
  mcpEdit?(profile: string, edit: McpEdit): Promise<void>;
  /**
   * Downloads a Server file to where the owner picks in the native Save dialog (src-tauri `files_download`, ADR 0023).
   * Resolves to the local path, or undefined when the owner closed the dialog. Rejects with `TRANSFER_STOPPED` once
   * `cancelTransfer(id)` stops it, or the connection closes.
   */
  download(id: number, path: string, name: string, onProgress: (p: TransferProgress) => void): Promise<Downloaded | undefined>;
  /** The native Open dialog for a file to upload (src-tauri `files_pick_upload`). Undefined when the owner closed it. */
  pickUpload(): Promise<PickedUpload | undefined>;
  /** Lets go of a pick that won't be sent (src-tauri `files_discard_pick`). */
  discardUpload(token: number): Promise<void>;
  /** Uploads the picked file to the server path `path` (src-tauri `files_upload`, ADR 0023). Resolves to Hermes's answer. */
  upload(id: number, token: number, path: string, overwrite: boolean, onProgress: (p: TransferProgress) => void): Promise<string>;
  /** Writes an edit's text to the server path `path` (src-tauri `files_save_text`, ADR 0024). Resolves to Hermes's answer. */
  saveText(id: number, path: string, text: string, overwrite: boolean): Promise<string>;
  /**
   * Writes an artifact's text to `path` where `profile`'s tools run (src-tauri `fs_save_text`, `POST api/fs/write-text`,
   * ADR 0029). `session`: the chat whose sandbox the path is in, as the read named it (ADR 0062). Resolves to Hermes's
   * answer; `cancelTransfer(id)` stops it.
   */
  fsSaveText(id: number, profile: string, path: string, text: string, session?: string): Promise<string>;
  cancelTransfer(id: number): Promise<void>;
  /**
   * Opens the Screen's RFB stream with a ticket from `display.observe` (src-tauri `display_open`, ADR 0039). Rust closes
   * it with the connection. Optional: a pipe without it has no Screen.
   */
  openDisplay?: OpenScreenSocket;
  close(): Promise<void>;
}

/**
 * Opens the pipe, with `/api/ws` opened for `profile`. Frames may arrive on `onEvent` before the returned promise
 * resolves. It can be called again after the pipe closes, to reconnect or to switch profile. Aborting `signal` stops
 * an opening under way, which then rejects; once open, the pipe is closed with `close`.
 */
export type OpenPipe = (onEvent: (e: PipeEvent) => void, profile: string, signal?: AbortSignal) => Promise<Pipe>;
