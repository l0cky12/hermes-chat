// The pipe under the frontend Hermes transport: JSON-RPC text frames in and out of `/api/ws`, plus
// signed-in dashboard REST calls and the local files the owner attaches. In the app it is the Rust side
// (tauriPipe.ts); in tests it is FakeHermes.

/** A local file as `statFiles` finds it: its size, or why it can't be attached (e.g. "it's a folder"). */
export type LocalFile = { path: string; name: string; size?: number; error?: string };

export type PipeEvent = { kind: "frame"; text: string } | { kind: "closed"; reason: string };

/**
 * How the pipe reaches the dashboard: through an SSH tunnel, or straight to the URL the owner typed. For a URL whose
 * host is a name, `addresses` are the IP addresses Rust resolved it to.
 */
export type Route = { kind: "ssh"; target: string } | { kind: "url"; url: string; addresses: string[] };

export interface Pipe {
  readonly route: Route;
  send(frame: string): Promise<void>;
  /**
   * One dashboard REST call with the sign-in cookies, e.g. `request("GET", "api/sessions?order=recent")`.
   * `body` is JSON text. Resolves to the response body text on 2xx; rejects with a readable message otherwise.
   */
  request(method: "GET" | "PATCH", pathAndQuery: string, body?: string): Promise<string>;
  statFiles(paths: string[]): Promise<LocalFile[]>;
  /**
   * Sends one frame: `head`, the file at `path` as base64, then `tail`. The bytes go from disk to Hermes
   * without passing through the webview. Rejects without sending if the file is now over `maxBytes`.
   */
  sendFile(head: string, path: string, tail: string, maxBytes: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the pipe. Frames may arrive on `onEvent` before the returned promise resolves. It can be called again after
 * the pipe closes, to reconnect.
 */
export type OpenPipe = (onEvent: (e: PipeEvent) => void) => Promise<Pipe>;
