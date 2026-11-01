// The real pipe: Rust signs in to the dashboard, through an SSH tunnel (ADR 0003) or straight to a URL, and relays
// `/api/ws` frames and REST calls. It also reads the files the owner attaches, so their bytes never pass through the
// webview.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalFile, OpenPipe, PipeEvent, Route } from "./pipe";

// A failed command rejects with the Rust error's text, not an Error.
const asError = (e: unknown) => Promise.reject(new Error(String(e)));

/** `mode` picks which of `sshTarget` and `url` is used. */
export type SignInDetails = { mode: "ssh" | "url"; sshTarget: string; url: string; username: string; password: string };

export function tauriPipe(d: SignInDetails): OpenPipe {
  const target = d.mode === "ssh" ? { kind: "ssh", target: d.sshTarget } : { kind: "url", url: d.url };
  return async (onEvent) => {
    const channel = new Channel<PipeEvent>();
    channel.onmessage = onEvent;
    const route = await invoke<Route>("hermes_connect", { target, username: d.username, password: d.password, onEvent: channel }).catch(asError);
    return {
      route,
      send: (frame) => invoke("hermes_send", { frame }),
      request: (method, path, body) => invoke<string>("hermes_request", { method, path, body }).catch(asError),
      statFiles: (paths) => invoke<LocalFile[]>("hermes_stat_files", { paths }),
      sendFile: (head, path, tail, maxBytes) => invoke<void>("hermes_send_file", { head, path, tail, maxBytes }).catch(asError),
      close: () => invoke("hermes_disconnect"),
    };
  };
}
