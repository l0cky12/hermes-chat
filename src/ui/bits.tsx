// Small shared UI bits, ported from the prototype.
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, Check, Copy, EyeOff, FileInput, Globe, Monitor, RotateCcw, Send, Terminal } from "lucide-react";
import type { ConnectionStatus, Source } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { SOURCE_LABEL } from "../hermes/model";
import { useLocale, type Locale } from "../i18n/locale";

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
    ) : source === "import" ? (
      <FileInput size={size} strokeWidth={2.4} />
    ) : (
      <Globe size={size} strokeWidth={2.4} />
    );
  return (
    <span className={`src src-${source}`} title={`Imported from ${SOURCE_LABEL[source]}`}>
      {icon}
    </span>
  );
}

/**
 * Settles a chat, or unsettles a Settled one. Icon only, the same either way: hovering shows what it does.
 */
export function SettleButton({
  settled,
  size,
  className,
  onSettle,
}: {
  settled: boolean;
  size: number;
  className: string;
  onSettle: (settled: boolean) => void;
}) {
  const label = settled ? "Unsettle" : "Settle";
  return (
    <button
      className={className}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onSettle(!settled);
      }}
    >
      {settled ? <ArchiveRestore size={size} /> : <Archive size={size} />}
    </button>
  );
}

/** Archives a chat in every Hermes client, or restores an archived one. */
export function ArchiveButton({
  archived,
  size,
  className,
  onArchive,
}: {
  archived: boolean;
  size: number;
  className: string;
  onArchive: (archived: boolean) => void;
}) {
  return (
    <button
      className={className}
      title={archived ? "Restore" : "Archive: hide in every Hermes client, keeping its history"}
      onClick={(e) => {
        e.stopPropagation();
        onArchive(!archived);
      }}
    >
      {archived ? <RotateCcw size={size} /> : <EyeOff size={size} />}
    </button>
  );
}

/**
 * A key pressed while an input method is composing belongs to the IME (Enter picks a candidate), so it must not
 * send, pick or open anything. WebKitGTK reports some of these only as keyCode 229.
 */
export const composing = (e: KeyboardEvent | ReactKeyboardEvent) =>
  ("nativeEvent" in e ? e.nativeEvent : e).isComposing || e.keyCode === 229;

export function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => ref.current?.contains(e.target as Node) || close();
    window.addEventListener("mousedown", away);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("blur", close);
    };
  }, [open, close, ref]);
}

/** For a menu's `onKeyDown`: moves focus among its items with the arrow keys, Home and End. */
export function menuArrows(e: ReactKeyboardEvent<HTMLElement>) {
  const step = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 }[e.key];
  if (step === undefined) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  (e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : items[(at + step + items.length) % items.length])?.focus();
}

/**
 * For a popover: when it closes, focus goes back to what had it when the popover opened, unless the owner has
 * moved focus somewhere else meanwhile (clicked another control, or the popover's pick opened something that
 * focuses itself).
 */
export function useReturnFocus() {
  // Read while rendering, before the popover's own autoFocus moves focus into it.
  const [opener] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      const now = document.activeElement;
      if ((!now || now === document.body) && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
    [],
  );
}

/** Before which of `items`, laid out along `axis`, a drop at `at` (the pointer's clientX or clientY) lands: the first
 * whose middle is past it, or `items.length` past them all. Undefined while they aren't laid out (as in tests). Tab
 * strips and the queue reorder by it, so a drag lands the same way in both. */
export const slotAt = (items: Element[], at: number, axis: "x" | "y") => {
  const spans = items.map((el) => {
    const r = el.getBoundingClientRect();
    return axis === "x" ? { start: r.left, size: r.width } : { start: r.top, size: r.height };
  });
  if (!spans.some((s) => s.size)) return undefined;
  const i = spans.findIndex((s) => at < s.start + s.size / 2);
  return i < 0 ? spans.length : i;
};

export function Spinner() {
  return <span className="spinner" aria-label="working" />;
}

/** A command to run on the server, with a button that copies it. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"done" | "failed">();
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(undefined), copied === "done" ? 1200 : 5000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(command);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <span className="screen-command">
      <code>{command}</code>
      <button className="icon-btn" title="Copy the command" onClick={() => void copy()}>
        {copied === "done" ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {copied === "failed" && (
        <span className="copy-failed" role="alert">
          Couldn't copy it. Select the command and copy it yourself.
        </span>
      )}
    </span>
  );
}

export const AGE_TICK_MS = 60_000;

const ageClock = (() => {
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      timer ??= setInterval(() => {
        ticks++;
        for (const l of listeners) l();
      }, AGE_TICK_MS);
      return () => {
        listeners.delete(fn);
        if (listeners.size) return;
        clearInterval(timer);
        timer = undefined;
      };
    },
    ticks: () => ticks,
  };
})();

export function Age({ at }: { at: number }) {
  useSyncExternalStore(ageClock.subscribe, ageClock.ticks);
  return useLocale().fmt.age(at);
}

/** How long ago, as a phrase: "just now" (or `justNow`), "5m ago". */
export function ago(l: Locale, at: number, justNow = "just now") {
  const age = l.fmt.age(at);
  return age === l.time.now ? justNow : `${age} ago`;
}

/** A stored message time (Unix ms) as a date and time in the owner's time zone, the same way everywhere. */
export const storedTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When Hermes stored a message; nothing when that isn't known. */
export const StoredTime = ({ at }: { at?: number }) =>
  at === undefined ? null : (
    <time className="msg-time" dateTime={new Date(at).toISOString()}>
      {storedTime(at)}
    </time>
  );

export const STATUS_LABEL: Record<ConnectionStatus, string> = { connected: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting…", offline: "Offline" };

/** Where the connection goes, as the owner typed it. */
export const routeLabel = (route?: Route) => (route?.kind === "ssh" ? `ssh://${route.target}` : route?.url);

export function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wraps every case-insensitive occurrence of `query` in `<mark className={className}>`. */
export function highlight(text: string, query: string, className = "hit"): ReactNode {
  if (!query) return text;
  return text.split(new RegExp(`(${escapeRe(query)})`, "gi")).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={className}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Arrow keys, Home and End move through a tablist's tabs or a radiogroup's radios, selecting as they go, as WAI-ARIA
 * has it. For the group's onKeyDown; only the selected item is in the Tab order (tabIndex 0, the others -1).
 */
export function arrowSelect<T>(e: ReactKeyboardEvent<HTMLElement>, items: readonly T[], current: T, pick: (item: T) => void) {
  const at = items.indexOf(current);
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key in ARROW_STEP ? (at + ARROW_STEP[e.key] + items.length) % items.length : -1;
  if (next < 0) return;
  e.preventDefault();
  pick(items[next]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')[next]?.focus();
}
