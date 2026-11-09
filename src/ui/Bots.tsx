// The Bots view (ADR 0066): one row per bot, which is a Hermes profile, with its picture, name, description, its Bot
// Chat's last message and what it is doing. A row opens the bot's Bot Chat, found by title every time (bots.ts); the
// pen beside it starts an ordinary chat in the bot's profile.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Loader, RefreshCw, ShieldAlert, SquarePen, X } from "lucide-react";
import { BotModeUnsupportedError, type Bot, type BotActivity } from "../hermes/bots";
import { ago, composing, storedTime, useReturnFocus } from "./bits";
import { useLocale } from "../i18n/locale";

/** How often the roster is read again while the view is open. Hermes's desktop polls every 5 seconds; this is enough. */
export const BOTS_REFRESH_MS = 15_000;

const ACTIVITY_LABEL: Record<NonNullable<BotActivity>, string> = { replying: "Replying", "needs-you": "Needs you" };

/**
 * `load`: reads the roster (`Hermes.bots`). `avatar`: a bot's picture, read once per bot that has one. `activity`: what
 * the bot is doing in its Bot Chat. `leaving`: what switching away from the shown profile leaves behind, asked about
 * before a row in another profile opens. `onUnsupported`: this Hermes turned out to have no Bot Mode.
 */
export function Bots({
  server,
  profile,
  connected,
  load,
  avatar,
  activity,
  leaving,
  onOpen,
  onNewChat,
  onRefresh,
  onClose,
  onUnsupported,
}: {
  server: string;
  profile: string;
  connected: boolean;
  load: () => Promise<Bot[]>;
  avatar: (profile: string) => Promise<string | undefined>;
  activity: (bot: Bot, roster: readonly Bot[]) => BotActivity;
  leaving?: string;
  onOpen: (bot: Bot) => void;
  onNewChat: (bot: Bot) => void;
  onRefresh: () => void;
  onClose: () => void;
  onUnsupported?: (why: string) => void;
}) {
  const l = useLocale();
  const [bots, setBots] = useState<Bot[]>();
  const [error, setError] = useState<string>();
  /** This Hermes turned out to have no Bot Mode, and why. */
  const [unsupported, setUnsupported] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [pictures, setPictures] = useState<Record<string, string>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [asking, setAsking] = useState<{ bot: Bot; then: "open" | "new" }>();
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const headId = useId();
  const asked = useRef(new Set<string>());
  const reads = useRef(0);
  useReturnFocus();

  const read = async () => {
    const n = ++reads.current;
    setLoading(true);
    try {
      const got = await load();
      if (n !== reads.current) return;
      setBots(got);
      setError(undefined);
      setCheckedAt(Date.now());
    } catch (e) {
      if (n !== reads.current) return;
      if (e instanceof BotModeUnsupportedError) {
        setUnsupported(e.message);
        onUnsupported?.(e.message);
      } else setError((e as Error).message);
    } finally {
      if (n === reads.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!connected || unsupported) return;
    void read();
    const every = setInterval(() => void read(), BOTS_REFRESH_MS);
    return () => clearInterval(every);
  }, [connected, load, unsupported]);

  // Each picture is asked for once while the view is open; a bot without one, or one that fails, shows its initial.
  useEffect(() => {
    for (const b of bots ?? []) {
      if (!b.hasAvatar || asked.current.has(b.profile)) continue;
      asked.current.add(b.profile);
      avatar(b.profile)
        .then((url) => url && setPictures((p) => ({ ...p, [b.profile]: url })))
        .catch(() => {});
    }
  }, [bots, avatar]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target;
      if (at instanceof Node && !root.current?.contains(at) && !(at instanceof Element && at.closest(".bots-btn"))) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  // Focus goes to the first bot once the list is read, or to Close when there is none to show, so Escape closes it.
  const first = useRef(true);
  useEffect(() => {
    if (!(bots || unsupported) || !first.current) return;
    first.current = false;
    (list.current?.querySelector<HTMLElement>(".bots-open") ?? root.current?.querySelector<HTMLElement>(".bots-close"))?.focus();
  }, [bots, unsupported]);

  const go = (bot: Bot, then: "open" | "new") => {
    if (bot.profile !== profile && leaving) return setAsking({ bot, then });
    (then === "open" ? onOpen : onNewChat)(bot);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (asking) setAsking(undefined);
      else onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>(".bots-open") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  // Pinned bots first, then Hermes's order. Hidden ones wait behind a disclosure, as in Hermes's own list.
  const shown = (bots ?? []).filter((b) => !b.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const hidden = (bots ?? []).filter((b) => b.hidden);
  const row = (b: Bot) => <Row key={b.profile} bot={b} picture={pictures[b.profile]} activity={activity(b, bots ?? [])} shown={b.profile === profile} onOpen={() => go(b, "open")} onNewChat={() => go(b, "new")} />;

  return (
    <section ref={root} className="inbox bots" role="dialog" aria-labelledby={headId} onKeyDown={onKeyDown}>
      <header className="inbox-head">
        <div className="inbox-heading">
          <h2 id={headId}>Bots</h2>
          <span className="inbox-server" title="The server these bots are on">
            {server}
          </span>
        </div>
        <button
          className="icon-btn"
          title="Check now"
          aria-label="Check now"
          onClick={() => {
            onRefresh();
            void read();
          }}
          disabled={!connected || loading || !!unsupported}
        >
          <RefreshCw size={15} />
        </button>
        <button className="icon-btn bots-close" title="Close bots (Escape)" aria-label="Close bots" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <p className="inbox-note bots-about">Each bot is a profile on the server with one Bot Chat that always continues. The pen starts a separate chat with the bot.</p>
      {unsupported && (
        <p className="inbox-note bots-note err" role="alert">
          {unsupported} Hermes Chat shows no Bots button for it.
        </p>
      )}
      {!unsupported && (error || !connected) && (
        <p className={`inbox-note bots-note ${error ? "err" : ""}`} role={error ? "alert" : undefined}>
          {!connected ? "Not connected to Hermes." : `Couldn't read the bots: ${error}`}
          {checkedAt && bots ? ` Showing them as of ${ago(l, checkedAt)}.` : ""}
        </p>
      )}
      {asking && (
        <div className="confirm inbox-leave" role="alertdialog" aria-label={`Switch to ${asking.bot.profile}?`}>
          <span>{leaving}</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setAsking(undefined)}>
              Stay
            </button>
            <button className="btn primary" onClick={() => (asking.then === "open" ? onOpen : onNewChat)(asking.bot)}>
              Switch to {asking.bot.profile}
            </button>
          </div>
        </div>
      )}
      <ul className="inbox-list bots-list" ref={list} aria-label="Bots" aria-busy={!bots && loading} hidden={!!unsupported}>
        {shown.map(row)}
        {hidden.length > 0 && (
          <li className="bots-hidden">
            <button className="bots-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              Hidden in Hermes ({hidden.length})
            </button>
          </li>
        )}
        {showHidden && hidden.map(row)}
      </ul>
      {!bots && !error && !unsupported && connected && <div className="empty-hint inbox-empty">Reading the bots…</div>}
    </section>
  );
}

function Row({ bot: b, picture, activity, shown, onOpen, onNewChat }: { bot: Bot; picture?: string; activity: BotActivity; shown: boolean; onOpen: () => void; onNewChat: () => void }) {
  const l = useLocale();
  const preview = b.botChat?.preview || (b.botChat ? "No messages yet" : "No Bot Chat yet. Open it to start one.");
  const when = b.lastActive ? ago(l, b.lastActive, "now") : "";
  const state = activity ? ACTIVITY_LABEL[activity] : undefined;
  const label = [
    `${b.name}${b.profile !== b.name.toLowerCase() ? ` (profile ${b.profile})` : ""}`,
    state,
    b.description,
    b.botChat?.preview ? `Last message: ${b.botChat.preview}` : preview,
    when && `active ${when}`,
    shown && "the profile shown",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <li className={`inbox-row bots-row${activity ? ` is-${activity}` : ""}${b.hidden ? " is-hidden" : ""}`}>
      <button className="bots-open" aria-label={label} onClick={onOpen}>
        <span className={`bots-face${b.color ? " has-color" : ""}`} style={b.color ? { background: b.color } : undefined} aria-hidden>
          {picture ? <img src={picture} alt="" /> : (b.name.trim()[0] ?? "?").toUpperCase()}
        </span>
        <span className="bots-text">
          <span className="inbox-line">
            <span className="bots-name">{b.name}</span>
            {state ? (
              <span className={`bots-activity is-${activity}`}>
                {activity === "needs-you" ? <ShieldAlert size={12} aria-hidden /> : <Loader size={12} aria-hidden />}
                {state}
              </span>
            ) : (
              when && (
                <time className="inbox-time" dateTime={new Date(b.lastActive).toISOString()} title={storedTime(b.lastActive)}>
                  {when}
                </time>
              )
            )}
          </span>
          {b.description && <span className="bots-desc">{b.description}</span>}
          <span className={`bots-preview${b.botChat?.preview ? "" : " is-empty"}`}>{preview}</span>
        </span>
      </button>
      <button className="icon-btn bots-new" title={`New chat with ${b.name}`} aria-label={`New chat with ${b.name}`} onClick={onNewChat}>
        <SquarePen size={14} />
      </button>
    </li>
  );
}
