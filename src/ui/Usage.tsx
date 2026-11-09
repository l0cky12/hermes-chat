// Token usage and cost (ADR 0008): one compact line under each reply this app measured, and a chat's totals beside its
// title. Either opens its breakdown. Counts Hermes didn't report say so; costs say how Hermes got them.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Chat } from "../hermes/model";
import { costLabel, tokens, totalTokens, type ChatUsage, type ReplyUsage } from "../hermes/usage";
import { useReturnFocus } from "./bits";
import { useLocale, type Formats } from "../i18n/locale";

const counter = (fmt: Formats) => (n: number | undefined) => (n === undefined ? "Not reported" : fmt.number(n));

/** One row of a breakdown. `sub`: a part of the row above it. */
function Row({ label, value, sub }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className={`usage-row ${sub ? "sub" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Why a reply's breakdown has no cache split, or never a cost (issue #53). Hermes's live counts (`usage.ts`
 * `countersOf`) have no cache read or write fields: the uncached part is told apart only once the cache was read, and
 * they carry no cost. The chat's stored usage has both.
 */
export const REPLY_NOTES = {
  unsplit:
    "Hermes didn't say how much of this input was cached. Until the cache has been read from, Hermes's live count looks the same whether input was sent uncached or written to the cache, so it isn't guessed.",
  split: "Hermes's live count doesn't tell cache reads from cache writes.",
  cost: "Hermes prices the whole chat, not each reply. The chat's usage, beside its title, shows its cost and splits cache reads from cache writes.",
};

/** The tokens one reply's turn took: a line under the reply, and its breakdown when clicked. */
export function ReplyUsageLine({ usage }: { usage: ReplyUsage }) {
  const full = counter(useLocale().fmt);
  const [open, setOpen] = useState(false);
  const id = useId();
  const split = usage.input !== undefined;
  // Without the split, all the input shows as "in".
  const parts =
    usage.input === undefined
      ? [`${tokens(usage.prompt)} in`, `${tokens(usage.output)} out`]
      : [`${tokens(usage.input)} in`, ...(usage.cache ? [`${tokens(usage.cache!)} cache`] : []), `${tokens(usage.output)} out`];
  return (
    <div className="reply-usage">
      <button
        className="usage-line"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Tokens for this reply: ${parts.join(", ")}. ${open ? "Hide" : "Show"} breakdown`}
        onClick={() => setOpen((o) => !o)}
      >
        {parts.join(" · ")}
      </button>
      {open && (
        <div className="usage-breakdown" id={id} ref={(el) => el?.scrollIntoView?.({ block: "nearest" })}>
          <dl className="usage-table">
            <Row label="Input" value={full(usage.prompt)} />
            {/* Unknown, not "Not reported" or 0: Hermes sent a count, one that doesn't say how much was cached. */}
            <Row label="not cached" value={split ? full(usage.input) : "Unknown"} sub />
            <Row label="cache read or written" value={split ? full(usage.cache) : "Unknown"} sub />
            <Row label="Output" value={full(usage.output)} />
            <Row label="of which reasoning" value={full(usage.reasoning)} sub />
            <Row label="Model calls" value={full(usage.calls)} />
            {usage.model && <Row label="Model" value={usage.model} />}
            <Row label="Cost" value="Not reported per reply" />
          </dl>
          <p className="usage-note">
            {split ? REPLY_NOTES.split : REPLY_NOTES.unsplit} {REPLY_NOTES.cost}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The chat's tokens and cost so far, as Hermes recorded them, beside its title. Clicking shows the breakdown and reads
 * Hermes again (`onRefresh`). Nothing shows until Hermes has been read, unless that failed.
 */
export function ChatUsageButton({ chat, onRefresh }: { chat: Pick<Chat, "usage" | "usageError">; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => wrap.current?.contains(e.target as Node) || close();
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open, close]);
  const { usage, usageError } = chat;
  if (!usage && !usageError) return null;
  const total = usage && totalTokens(usage);
  const cost = usage && costLabel(usage.cost);
  // A count Hermes didn't report is left out here; the breakdown says so.
  const counts =
    total !== undefined
      ? [`${tokens(total)} tokens`]
      : [...(usage?.input !== undefined ? [`${tokens(usage.input)} in`] : []), ...(usage?.output !== undefined ? [`${tokens(usage.output)} out`] : [])];
  const label = !usage ? "Usage unknown" : [...counts, cost!.short].join(" · ");
  return (
    <div className="chat-usage" ref={wrap}>
      <button
        className={`usage-pill ${open ? "on" : ""} ${usageError ? "warn" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Usage for this chat: ${label}`}
        onClick={() => {
          if (!open) onRefresh();
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && <ChatUsagePopover usage={usage} error={usageError} onClose={close} />}
    </div>
  );
}

function ChatUsagePopover({ usage, error, onClose }: { usage?: ChatUsage; error?: string; onClose: () => void }) {
  const { fmt } = useLocale();
  const full = counter(fmt);
  useReturnFocus();
  const cost = usage && costLabel(usage.cost);
  return (
    <div
      className="usage-popover"
      role="dialog"
      aria-label="Usage for this chat"
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="usage-title">Usage for this chat</div>
      {usage && (
        <>
          <dl className="usage-table">
            <Row label="Input, not cached" value={full(usage.input)} />
            <Row label="Cache read" value={full(usage.cacheRead)} />
            <Row label="Cache written" value={full(usage.cacheWrite)} />
            <Row label="Output" value={full(usage.output)} />
            <Row label="of which reasoning" value={full(usage.reasoning)} sub />
            <Row label="Total" value={full(totalTokens(usage))} />
            <Row label="Model calls" value={full(usage.calls)} />
          </dl>
          <div className="usage-cost">
            <span className="usage-cost-value">{cost!.short}</span>
            <span className="usage-cost-detail">{cost!.detail}</span>
          </div>
          <p className="usage-note">
            Hermes's own totals for every model call in this chat, from any client and across model changes. Its helper
            tasks, such as titling, aren't included. Read {fmt.time(usage.readAt)}.
          </p>
        </>
      )}
      {error && (
        <p className="usage-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
