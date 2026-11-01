// The pipe under the frontend Hermes transport: JSON-RPC text frames in and out of `/api/ws`, plus
// signed-in dashboard REST calls. In the app it is the Rust side (tauriPipe.ts); in tests it is FakeHermes.

export type PipeEvent = { kind: "frame"; text: string } | { kind: "closed"; reason: string };

export interface Pipe {
  send(frame: string): Promise<void>;
  /**
   * One dashboard REST call with the sign-in cookies, e.g. `request("GET", "api/sessions?order=recent")`.
   * `body` is JSON text. Resolves to the response body text on 2xx; rejects with a readable message otherwise.
   */
  request(method: "GET" | "PATCH", pathAndQuery: string, body?: string): Promise<string>;
  close(): Promise<void>;
}

/** Opens the pipe. Frames may arrive on `onEvent` before the returned promise resolves. */
export type OpenPipe = (onEvent: (e: PipeEvent) => void) => Promise<Pipe>;
