// The terminals, through Rust (src-tauri/src/terminal.rs): ssh to the server, or the owner's own shell on this computer,
// runs there in a pseudo-terminal, and its output arrives here as base64 bytes.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "../hermes/tauriPipe";
import type { TerminalApi, TerminalEvent } from "../hermes/terminal";

type RawEvent = { kind: "output"; data: string } | { kind: "exit"; code: number | null };

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function channelFor(onEvent: (e: TerminalEvent) => void) {
  const onRaw = new Channel<RawEvent>();
  onRaw.onmessage = (e) => onEvent(e.kind === "output" ? { kind: "output", data: fromBase64(e.data) } : e);
  return onRaw;
}

export const tauriTerminal: TerminalApi = {
  open: (target, cols, rows, onEvent, folder) => invoke<number>("terminal_open", { target, cols, rows, folder, onEvent: channelFor(onEvent) }).catch(asError),
  write: (id, data) => invoke<void>("terminal_write", { id, data }).catch(asError),
  resize: (id, cols, rows) => invoke<void>("terminal_resize", { id, cols, rows }).catch(asError),
  close: (id) => void invoke("terminal_close", { id }).catch(() => {}),
};

/** A shell on this computer: Rust starts the owner's own login shell; the target only labels it (ADR 0039). */
export const tauriLocalTerminal: TerminalApi = {
  ...tauriTerminal,
  open: (_target, cols, rows, onEvent, folder) => invoke<number>("terminal_open_local", { cols, rows, folder, onEvent: channelFor(onEvent) }).catch(asError),
};
