// The pipe under the frontend Hermes transport: JSON-RPC text frames in and out of `/api/ws`.
// In the app it is the Rust side (tauriPipe.ts); in tests it is FakeHermes.

export type PipeEvent = { kind: "frame"; text: string } | { kind: "closed"; reason: string };

export interface Pipe {
  send(frame: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens the pipe. Frames may arrive on `onEvent` before the returned promise resolves. */
export type OpenPipe = (onEvent: (e: PipeEvent) => void) => Promise<Pipe>;
