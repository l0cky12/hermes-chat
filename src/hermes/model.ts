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

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      preview?: string;
      status: "running" | "done";
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
};

export type ConnectionStatus = "connected" | "offline";
