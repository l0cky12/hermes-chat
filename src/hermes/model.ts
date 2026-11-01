// What the UI renders. Terms follow GLOSSARY.md: a Chat is Active or Settled and has one Source.

export type Source = "app" | "telegram" | "discord" | "cli" | "desktop" | "other";

export const SOURCE_LABEL: Record<Source, string> = {
  app: "Hermes Chat",
  telegram: "Telegram",
  discord: "Discord",
  cli: "the command line",
  desktop: "the Hermes desktop app",
  other: "another Hermes platform",
};

/** A local file the owner is sending with a message: an image Hermes looks at, or any other file. */
export type Attachment = { path: string; name: string; size: number; kind: "image" | "file" };

/** Local files checked for attaching: the ones Hermes takes, and why each of the others can't go. */
export type AttachCheck = { attachments: Attachment[]; refused: string[] };

export type Item =
  /** `attachments`: the names of the files sent with the message. */
  | { kind: "user"; id: string; text: string; attachments?: string[] }
  /** `interrupted`: the owner, or another Hermes client, stopped this reply before it finished. */
  | { kind: "assistant"; id: string; text: string; interrupted?: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      preview?: string;
      /** `stopped`: the reply was interrupted while the tool call was running. */
      status: "running" | "done" | "stopped";
      durationS?: number;
      result?: string;
      summary?: string;
    }
  | { kind: "error"; id: string; text: string };

export type Chat = {
  /** The stored Hermes session id, as dashboard REST lists it. */
  id: string;
  /** The legacy WS runtime session id, once this app has started or resumed the chat on this connection. */
  runtimeId?: string;
  title: string;
  source: Source;
  settled: boolean;
  updatedAt: number;
  items: Item[];
  /** Its stored history is on the way (`Hermes.open`). */
  loading?: boolean;
  running?: boolean;
  /** Stop was asked for; the reply keeps running until Hermes ends the turn (`Hermes.stop`). */
  stopping?: boolean;
};

export type ConnectionStatus = "connected" | "reconnecting" | "offline";
