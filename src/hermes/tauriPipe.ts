// The real pipe: Rust opens the SSH tunnel, signs in to the dashboard and relays `/api/ws` frames and REST calls (ADR 0003).
// It also reads the files the owner attaches, so their bytes never pass through the webview.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalFile, OpenPipe, PipeEvent } from "./pipe";

// A failed command rejects with the Rust error's text, not an Error.
const asError = (e: unknown) => Promise.reject(new Error(String(e)));

export type SignInDetails = { sshTarget: string; username: string; password: string };

export function tauriPipe(d: SignInDetails): OpenPipe {
  return async (onEvent) => {
    const channel = new Channel<PipeEvent>();
    channel.onmessage = onEvent;
    await invoke("hermes_connect", { sshTarget: d.sshTarget, username: d.username, password: d.password, onEvent: channel });
    return {
      send: (frame) => invoke("hermes_send", { frame }),
      request: (method, path, body) => invoke<string>("hermes_request", { method, path, body }).catch(asError),
      statFiles: (paths) => invoke<LocalFile[]>("hermes_stat_files", { paths }),
      sendFile: (head, path, tail, maxBytes) => invoke<void>("hermes_send_file", { head, path, tail, maxBytes }).catch(asError),
      close: () => invoke("hermes_disconnect"),
    };
  };
}
