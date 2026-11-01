// The real pipe: Rust opens the SSH tunnel, signs in to the dashboard and relays `/api/ws` frames and REST calls (ADR 0003).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { OpenPipe, PipeEvent } from "./pipe";

export type SignInDetails = { sshTarget: string; username: string; password: string };

export function tauriPipe(d: SignInDetails): OpenPipe {
  return async (onEvent) => {
    const channel = new Channel<PipeEvent>();
    channel.onmessage = onEvent;
    await invoke("hermes_connect", { sshTarget: d.sshTarget, username: d.username, password: d.password, onEvent: channel });
    return {
      send: (frame) => invoke("hermes_send", { frame }),
      // A failed command rejects with the Rust error's text, not an Error.
      request: (method, path, body) =>
        invoke<string>("hermes_request", { method, path, body }).catch((e) => Promise.reject(new Error(String(e)))),
      close: () => invoke("hermes_disconnect"),
    };
  };
}
