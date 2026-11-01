// Small shared UI bits, ported from the prototype.
import { Globe, Monitor, Send, Terminal } from "lucide-react";
import type { Source } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";

// Approximate brand marks; the real app should use proper icon assets.
function DiscordGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19.3 5.3A17 17 0 0 0 15 4l-.5 1a15.6 15.6 0 0 0-5 0L9 4a17 17 0 0 0-4.3 1.3C2 9.4 1.3 13.4 1.6 17.3A17.3 17.3 0 0 0 6.9 20l1.1-1.8c-.6-.2-1.2-.5-1.7-.9l.4-.3a12.2 12.2 0 0 0 10.6 0l.4.3c-.5.4-1.1.7-1.7.9L17.1 20a17.2 17.2 0 0 0 5.3-2.7c.4-4.5-.7-8.5-3.1-12zM8.7 14.9c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z" />
    </svg>
  );
}

export function SourceIcon({ source, size = 12 }: { source: Source; size?: number }) {
  if (source === "app") return null;
  const icon =
    source === "telegram" ? (
      <Send size={size - 1} strokeWidth={2.4} />
    ) : source === "discord" ? (
      <DiscordGlyph size={size} />
    ) : source === "cli" ? (
      <Terminal size={size} strokeWidth={2.4} />
    ) : source === "desktop" ? (
      <Monitor size={size} strokeWidth={2.4} />
    ) : (
      <Globe size={size} strokeWidth={2.4} />
    );
  return (
    <span className={`src src-${source}`} title={`Imported from ${SOURCE_LABEL[source]}`}>
      {icon}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="working" />;
}

export function relTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 7))}w`;
}
