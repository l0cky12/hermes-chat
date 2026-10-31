// What the UI renders. Terms follow GLOSSARY.md: a Chat is Active or Settled and has one Source.

export type Source = "app" | "telegram" | "discord" | "cli" | "desktop";

export const SOURCE_LABEL: Record<Source, string> = {
  app: "Hermes Chat",
  telegram: "Telegram",
  discord: "Discord",
  cli: "the command line",
  desktop: "the Hermes desktop app",
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
  id: string;
  title: string;
  source: Source;
  settled: boolean;
  updatedAt: number;
  items: Item[];
  running?: boolean;
};

export type ConnectionStatus = "connected" | "offline";
