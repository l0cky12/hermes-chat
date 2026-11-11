// The real pipe: Rust signs in to the dashboard, through an SSH tunnel (ADR 0003) or straight to a URL, and relays
// `/api/ws` frames and REST calls. It also reads the files the owner attaches, so their bytes never pass through the
// webview.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { CustomEndpoint, EndpointSave, ProviderSignIn } from "./accounts";
import { RestError, type LocalFile, type OpenPipe, type Pipe, type PipeEvent, type Route, type ToolsetGuards, type Transcript, type VoiceSetup } from "./pipe";
import type { GitExclude } from "./projectContextFiles";
import type { Downloaded, PickedUpload, TransferProgress } from "./remoteFiles";
import type { Probe, Probed, ProbeFailure, SavedKey } from "./setup";
import { routedPipe, type ReachRoute, type RouteDetails, type RoutedHooks } from "./routes";
import type { SignInWay } from "./connections";
import type { Step } from "./attempts";

/**
 * A failed command rejects with the Rust error's text, not an Error; one that calls the dashboard with a `RelayError`,
 * whose status and body, when the dashboard answered, make a `RestError`.
 */
export const asError = (e: unknown) => {
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    const { message, status, body } = e as { message: string; status?: unknown; body?: unknown };
    return Promise.reject(typeof status === "number" ? new RestError(status, typeof body === "string" ? body : "", message) : new Error(message));
  }
  return Promise.reject(new Error(String(e)));
};

/** Base64 to bytes. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An extra request header for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0104). */
export type ExtraHeader = { name: string; value: string };

/**
 * `mode` picks which of `sshTarget` and `url` is used. `headers` go with every request to a URL, never through the SSH
 * tunnel; Rust checks them. Like the password, they are kept in the system keyring, never beside the rest.
 */
export type SignInDetails = SignInWay & {
  mode: "ssh" | "url";
  sshTarget: string;
  url: string;
  username: string;
  password: string;
  headers?: ExtraHeader[];
  /**
   * The connection's routes, tried in order (routes.ts, ADR 0120); the address above is then the first route's. Absent
   * on a sign-in with one route, which is its address.
   */
  routes?: RouteDetails[];
  /** The server every route must reach, once known: a hash of its Hermes install id (ADR 0120). */
  server?: string;
  /** A token typed now (ADR 0058). Rust takes it in the connect or test command and never gives it back. */
  token?: string;
  /**
   * Set when a token is saved for this connection: its keyring id, `null` for the migrated connection. With no token
   * typed, Rust loads that one, and sends it only to an address it was saved for. The webview never sees it.
   */
  savedToken?: string | null;
};

/** A sign-in method a dashboard offers and Hermes Chat supports (src-tauri `transport::SignInMethod`, ADR 0058). */
export type SignInMethod = { method: "password"; provider: string; label: string } | { method: "token" };

/**
 * The methods a dashboard offers, never empty (src-tauri `transport::Methods`). `note`: why they are a guess, Password
 * as before: `unread`, the server's answer couldn't be read; `gate-off`, its sign-in is off; `none-supported`, it
 * lists only methods Hermes Chat doesn't sign in with.
 */
export type Methods = { methods: SignInMethod[]; note?: "unread" | "gate-off" | "none-supported" };

/** What Rust signs in with: the password, or a token typed now or saved (src-tauri `SignInWith`). */
const credentialOf = (d: SignInDetails) =>
  d.method === "token"
    ? { method: "token", token: d.token?.trim() || null, connection: d.savedToken ?? null }
    : { method: "password", username: d.username, password: d.password, provider: d.provider ?? null };

const targetOf = (d: SignInDetails) =>
  d.mode === "ssh" ? { kind: "ssh", target: d.sshTarget } : { kind: "url", url: d.url, headers: d.headers ?? [] };

const asProbeFailure = (e: unknown): ProbeFailure => (e && typeof e === "object" ? (e as ProbeFailure) : { stage: "address", message: String(e) });

/** Setup's connection test (src-tauri `hermes_probe`): it rejects with a `ProbeFailure`, not an Error. One route only. */
export const tauriProbe: Probe = {
  run: (d, profile, quick = false) =>
    invoke<Probed>("hermes_probe", { target: targetOf(d), credential: credentialOf(d), profile, expectServer: d.server ?? null, quick }).catch(
      (e: unknown) => Promise.reject<Probed>(asProbeFailure(e)),
    ),
  cancel: () => void invoke("hermes_probe_cancel").catch(() => {}),
};

/**
 * What `hermes_reach` found: how the route went, the dashboard's `/api/status` body, if it answered one, and the
 * sign-in methods it offers.
 */
export type Reached = { route: Route; status: string; methods?: Methods };

/**
 * Reaches one route without signing in (src-tauri `hermes_reach`): the tunnel or address opens, and `/api/status`
 * answers as the Hermes `expectServer` names. `methods`: also read the sign-in methods it offers. Rejects with a
 * `ProbeFailure`. No password goes anywhere.
 */
export const tauriReach = (d: SignInDetails, expectServer: string | undefined, quick = true, methods = false): Promise<Reached> =>
  invoke<Reached>("hermes_reach", { target: targetOf(d), expectServer: expectServer ?? null, quick, methods }).catch((e: unknown) =>
    Promise.reject<Reached>(asProbeFailure(e)),
  );

export const reachRoute: ReachRoute = (d, expectServer) => tauriReach(d, expectServer);

/** The pipe for a connection: its routes, tried in order (routes.ts `routedPipe`), each opened by Rust. */
export function tauriPipe(d: SignInDetails, hooks?: RoutedHooks): OpenPipe {
  return routedPipe(d, (one, opts) => routePipe(one, opts), hooks);
}

/** One route's pipe. `expectServer`, `quick`, `sshRoute` and `onStep`: see routes.ts `OpenRoute`. */
function routePipe(d: SignInDetails, opts: { expectServer?: string; quick: boolean; sshRoute?: string; onStep?: (s: Step, at?: number) => void }): OpenPipe {
  const target = targetOf(d);
  return async (onEvent, profile, signal) => {
    const args = { target, credential: credentialOf(d), profile, expectServer: opts.expectServer ?? null, quick: opts.quick, sshRoute: opts.sshRoute ?? null };
    // Names this connection: every command below names it too, so one sent after it was replaced reaches nothing (#474).
    const attempt = crypto.randomUUID();
    const route = await opening<Route>("hermes_connect", args, onEvent, signal, opts.onStep, attempt);
    const pipe: Pipe = {
      route,
      connectionId: attempt,
      send: (frame) => invoke("hermes_send", { attempt, frame }),
      request: (method, path, body) => invoke<string>("hermes_request", { attempt, method, path, body }).catch(asError),
      getLimited: (path, maxBytes) => invoke<string>("hermes_get_limited", { attempt, path, maxBytes }).catch(asError),
      statFiles: (paths) => invoke<LocalFile[]>("hermes_stat_files", { paths }),
      sendFile: (head, path, tail, maxBytes) => invoke<void>("hermes_send_file", { attempt, head, path, tail, maxBytes }).catch(asError),
      saveProviderKey: (profile, key, value) => invoke<SavedKey>("hermes_save_provider_key", { attempt, profile, key, value }).catch(asError),
      removeProviderKey: (profile, key) => invoke<void>("hermes_remove_provider_key", { attempt, profile, key }).catch(asError),
      providerSignIns: (profile) => invoke<ProviderSignIn[]>("hermes_provider_sign_ins", { attempt, profile }).catch(asError),
      customEndpoints: (profile) => invoke<CustomEndpoint[]>("hermes_custom_endpoints", { attempt, profile }).catch(asError),
      saveEndpoint: (profile, form, anyway) => invoke<EndpointSave>("hermes_save_endpoint", { attempt, profile, form, anyway }).catch(asError),
      // The recording goes as the raw body, not as a JSON list of numbers.
      transcribe: (profile, audio, mime) =>
        invoke<Transcript>("hermes_transcribe", audio, {
          headers: { "x-mime": encodeURIComponent(mime), "x-profile": encodeURIComponent(profile), "x-attempt": attempt },
        }).catch(asError),
      speak: async (profile, text) => {
        const got = await invoke<{ mime: string; audio: string; provider?: string }>("hermes_speak", { attempt, profile, text }).catch(asError);
        return { ...got, audio: fromBase64(got.audio) };
      },
      voiceSetup: (profile) => invoke<VoiceSetup>("hermes_voice_setup", { attempt, profile }).catch(asError),
      toolsetGuards: (profile) => invoke<ToolsetGuards>("hermes_toolset_guards", { attempt, profile }).catch(asError),
      mcpEdit: (profile, edit) => invoke<void>("hermes_mcp_edit", { attempt, profile, edit }).catch(asError),
      download: (id, path, name, onProgress) => {
        const channel = new Channel<TransferProgress>();
        channel.onmessage = onProgress;
        return invoke<Downloaded | null>("files_download", { attempt, id, path, name, onProgress: channel }).then((got) => got ?? undefined, asError);
      },
      pickUpload: () => invoke<PickedUpload | null>("files_pick_upload").then((p) => p ?? undefined, asError),
      discardUpload: (token) => invoke<void>("files_discard_pick", { token }),
      upload: (id, token, path, overwrite, onProgress) => {
        const channel = new Channel<TransferProgress>();
        channel.onmessage = onProgress;
        return invoke<string>("files_upload", { attempt, id, token, path, overwrite, onProgress: channel }).catch(asError);
      },
      saveText: (id, path, text, overwrite) => invoke<string>("files_save_text", { attempt, id, path, text, overwrite }).catch(asError),
      fsSaveText: (id, profile, path, text, session) => invoke<string>("fs_save_text", { attempt, id, profile, path, text, session: session ?? null }).catch(asError),
      cancelTransfer: (id) => invoke("files_cancel", { id }),
      context: {
        pick: () => invoke<LocalFile[]>("context_pick").catch(asError),
        localFiles: (paths) => invoke<LocalFile[]>("context_local_files", { paths }).catch(asError),
        upload: (id, local, serverPath, overwrite, sshProfile, onProgress) => {
          const channel = new Channel<TransferProgress>();
          channel.onmessage = onProgress;
          return invoke<void>("context_upload", { attempt, id, local, serverPath, overwrite, sshProfile: sshProfile ?? null, onProgress: channel }).catch(asError);
        },
        writeText: (serverPath, text, overwrite, sshProfile) => invoke<void>("context_write_text", { attempt, serverPath, text, overwrite, sshProfile: sshProfile ?? null }).catch(asError),
        mkdir: (path) => invoke<string>("context_mkdir", { attempt, path }).catch(asError),
        remove: (serverPath) => invoke<void>("context_remove", { attempt, serverPath }).catch(asError),
        readText: (serverPath, size, sshProfile) =>
          invoke<string | null>("context_read_text", { attempt, serverPath, size, sshProfile: sshProfile ?? null }).then((text) => text ?? undefined, asError),
        sshFile: (serverPath, sshProfile) =>
          invoke<{ size: number; text: string | null }>("context_ssh_file", { attempt, serverPath, sshProfile }).then(({ size, text }) => (text === null ? { size } : { size, text }), asError),
        gitExclude: (mainFolder, sshProfile) => invoke<GitExclude>("context_git_exclude", { attempt, mainFolder, sshProfile: sshProfile ?? null }).catch(asError),
      },
      openDisplay: async (ticket, onData, onClose) => {
        // RFB bytes arrive raw, as an ArrayBuffer; the close, once, as JSON.
        const channel = new Channel<ArrayBuffer | { code: number; reason: string }>();
        channel.onmessage = (m) => (m instanceof ArrayBuffer ? onData(m) : onClose(m.code, m.reason));
        const id = await invoke<number>("display_open", { attempt, ticket, onEvent: channel }).catch(asError);
        return {
          // The owner's keys and pointer go as the raw body.
          send: (bytes) => void invoke("display_send", bytes, { headers: { "x-display-id": String(id) } }).catch(() => {}),
          close: () => void invoke("display_close", { id }).catch(() => {}),
        };
      },
      reopen: async (onEvent, profile, signal, onStep) => {
        await opening<void>("hermes_reopen", { profile, connection: attempt }, onEvent, signal, onStep);
        return pipe;
      },
      close: () => invoke("hermes_disconnect"),
    };
    return pipe;
  };
}

/** Runs `command`, which opens `/api/ws`, with `args`: frames go to `onEvent`, each step as it starts to `onStep`, and
 * aborting `signal` stops it. */
async function opening<T>(
  command: string,
  args: Record<string, unknown>,
  onEvent: (e: PipeEvent) => void,
  signal?: AbortSignal,
  onStep?: (s: Step, at?: number) => void,
  attempt: string = crypto.randomUUID(),
): Promise<T> {
  const channel = new Channel<PipeEvent>();
  channel.onmessage = onEvent;
  // src-tauri connect_steps.rs `Started`.
  const steps = new Channel<{ step: Step; at: number }>();
  steps.onmessage = (s) => onStep?.(s.step, s.at);
  // `attempt` names this opening, so stopping it can't stop a later one (src-tauri `hermes_connect_cancel`).
  const stop = () => void invoke("hermes_connect_cancel", { attempt }).catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return invoke<T>(command, { ...args, attempt, onEvent: channel, onStep: steps })
    .catch(asError)
    .finally(() => signal?.removeEventListener("abort", stop));
}
