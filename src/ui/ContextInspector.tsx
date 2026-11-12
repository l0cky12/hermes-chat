// The context inspector (ADR 0025), opened from the status bar's context meter: what fills the chat's context window
// as Hermes measures it, the compactions Hermes stored for the chat, and Compact now where Hermes can. Every figure is
// Hermes's, labelled exact, estimated or unavailable; nothing is worked out from the meter's percentage, and nothing is
// kept on this computer. Summaries and paths show as plain text, never as Markdown or HTML.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import {
  FILE_STATUS,
  OPTIONAL_PARTS,
  PART_HINT,
  SOURCE_NOTE,
  type Certainty,
  type CompactResult,
  type Compaction,
  type CompactionHistory,
  type ContextReading,
} from "../hermes/contextInspect";
import { useOpenPreview } from "./previewContext";
import { useShowInChat } from "./showInChat";
import { Spinner } from "./bits";
import { clockTimeWithSeconds, errorText } from "../hermes/values";

/** What the inspector asks Hermes, for the chat on screen. */
export type ContextApi = {
  inspect: () => Promise<ContextReading>;
  history: () => Promise<CompactionHistory>;
  compact: () => Promise<CompactResult>;
  /** This connection's Hermes said it can't compact a chat. */
  cannotCompact: () => boolean;
  /** Opens Settings → Memory, where the memory read into new chats is edited. */
  openMemory?: () => void;
};

type Load<T> = { state: "loading" } | { state: "done"; value: T } | { state: "failed"; error: string };

const n = (tokens: number) => tokens.toLocaleString();
const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * Loads `fetch` now and whenever `again` changes. An answer that comes after a newer ask, or after the inspector
 * closed, is dropped. `run` loads it again by hand.
 */
function useLoad<T>(fetch: () => Promise<T>, again: unknown, enabled = true): [Load<T> | undefined, () => void] {
  const [load, setLoad] = useState<Load<T>>();
  const ask = useRef(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const run = useCallback(() => {
    const mine = ++ask.current;
    setLoad((l) => (l?.state === "done" ? l : { state: "loading" }));
    fetchRef.current().then(
      (value) => mine === ask.current && setLoad({ state: "done", value }),
      (e: unknown) => mine === ask.current && setLoad({ state: "failed", error: errorText(e) }),
    );
  }, []);
  useEffect(() => {
    if (enabled) run();
  }, [again, enabled, run]);
  useEffect(() => () => void ask.current++, []);
  return [load, run];
}

function Badge({ certainty, children }: { certainty: Certainty; children?: ReactNode }) {
  return <span className={`certainty ${certainty}`}>{children ?? { exact: "Exact", estimated: "Estimated", unavailable: "Unavailable" }[certainty]}</span>;
}

type Tab = "window" | "compactions";
const TABS: { id: Tab; label: string }[] = [
  { id: "window", label: "Window" },
  { id: "compactions", label: "Compactions" },
];

/** The inspector's contents, inside the status bar's popover. */
export function ContextInspector({ chat, status, api }: { chat: Chat; status: ConnectionStatus; api: ContextApi }) {
  const [tab, setTab] = useState<Tab>("window");
  const [compacted, setCompacted] = useState(0);
  // Each reply that finishes. Hermes counts an automatic compaction before it stores the summary and the compacted
  // rows, so a read the count set off can come too early; the reply's end reads both again with the rows in place.
  const [replies, setReplies] = useState(0);
  const wasRunning = useRef(!!chat.running);
  useEffect(() => {
    if (wasRunning.current && !chat.running) setReplies((r) => r + 1);
    wasRunning.current = !!chat.running;
  }, [chat.running]);
  // Hermes compacting the chat, here or on its own during a reply, changes what fills it: read both again.
  const again = `${chat.live?.compactions ?? "-"}/${compacted}/${replies}`;
  // Hermes measures only a chat it has loaded on this connection; its stored compactions can be read without that.
  const loaded = !!chat.runtimeId && status === "connected";
  const [reading, reread] = useLoad(api.inspect, again, loaded);
  // The stored history is read once its tab is first opened, then kept up to date like the window.
  const [wantHistory, setWantHistory] = useState(false);
  useEffect(() => void (tab === "compactions" && setWantHistory(true)), [tab]);
  const [history, rehistory] = useLoad(api.history, again, wantHistory);
  const id = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabsRef.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="popover-title">Context window</div>
        <button
          className="icon-btn small"
          title="Ask Hermes again"
          aria-label="Ask Hermes again"
          onClick={() => {
            if (loaded) reread();
            if (wantHistory) rehistory();
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Context inspector" ref={tabsRef} onKeyDown={move}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`${id}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${id}-${t.id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`inspector-tab${tab === t.id ? " on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === "window" ? (
          <WindowView chat={chat} status={status} loaded={loaded} reading={reading} api={api} onCompactions={() => setTab("compactions")} />
        ) : (
          <CompactionsView chat={chat} status={status} history={history} api={api} onCompacted={() => setCompacted((c) => c + 1)} />
        )}
      </div>
    </div>
  );
}

function WindowView({
  chat,
  status,
  loaded,
  reading,
  api,
  onCompactions,
}: {
  chat: Chat;
  status: ConnectionStatus;
  loaded: boolean;
  reading?: Load<ContextReading>;
  api: ContextApi;
  onCompactions: () => void;
}) {
  if (!loaded)
    return (
      <>
        <div className="inspector-note">
          <Badge certainty="unavailable" />{" "}
          {status === "connected"
            ? "Hermes hasn't loaded this chat on the server yet, so it has measured nothing for it. It does once the chat's next message goes."
            : "Connect to Hermes to see what fills this chat's window."}{" "}
          <button className="link-btn" onClick={onCompactions}>
            See compactions
          </button>
        </div>
        <CacheView chat={chat} />
      </>
    );
  if (!reading || reading.state === "loading") return <Waiting>Asking Hermes what fills the window…</Waiting>;
  if (reading.state === "failed")
    return (
      <div className="inspector-note" role="alert">
        Couldn't read the context window: {reading.error}
      </div>
    );
  const r = reading.value;
  const source = SOURCE_NOTE[r.source];
  const now = chat.model?.model;
  return (
    <>
      <section className="inspector-section" aria-label="Total">
        {r.used !== undefined && r.max !== undefined ? (
          <>
            <div className="inspector-total">
              <span>
                {n(r.used)} of {n(r.max)} tokens · {r.percent}%
              </span>
              <Badge certainty={source.certainty}>{source.label}</Badge>
            </div>
            <div className="meter wide" aria-hidden>
              <span style={{ width: `${Math.min(100, r.percent ?? 0)}%` }} />
            </div>
            <div className="muted small">
              {source.note} {n(Math.max(0, r.max - r.used))} tokens left.
            </div>
          </>
        ) : (
          <div className="inspector-total">
            <span>Not measured yet</span>
            <Badge certainty="unavailable" />
          </div>
        )}
        <div className="muted small">
          Read at {clockTimeWithSeconds(r.measuredAt)}
          {r.model && <> for {r.model}</>}. Hermes doesn't time its measure; this is when it answered.
        </div>
        {r.model && now && now !== r.model && (
          <div className="inspector-note">
            Measured for {r.model}, and the chat now uses {now}. Its window and count change with the model; the next reply measures it again.
          </div>
        )}
      </section>

      <section className="inspector-section" aria-labelledby="ctx-parts">
        <div className="inspector-subhead">
          <span id="ctx-parts">What fills it</span>
          {r.built && <Badge certainty="estimated" />}
        </div>
        {!r.built ? (
          <div className="inspector-note">
            <Badge certainty="unavailable" /> Hermes hasn't built this chat on the server yet, so it can't split the window. It does once the chat's next
            message goes.
          </div>
        ) : (
          <>
            <p className="muted small">Hermes's estimate, about four characters a token. The parts needn't add up to the total above.</p>
            <ul className="context-parts" aria-label="Breakdown by category">
              {r.parts.map((p) => (
                <li key={p.id}>
                  <span className="swatch" style={{ background: p.color ?? undefined }} aria-hidden />
                  <span className="part-main">
                    <span className="part-label">{p.label}</span>
                    {PART_HINT[p.id] && <span className="part-hint">{PART_HINT[p.id]}</span>}
                    {p.id === "conversation" && (
                      <button className="link-btn" onClick={onCompactions}>
                        See compactions
                      </button>
                    )}
                    {p.id === "memory" && api.openMemory && (
                      <button className="link-btn" onClick={api.openMemory}>
                        Open Settings → Memory
                      </button>
                    )}
                  </span>
                  <span className="part-tokens" title="Estimated by Hermes">
                    ~{n(p.tokens)}
                  </span>
                </li>
              ))}
            </ul>
            <ul className="context-parts unavailable" aria-label="Not reported separately">
              <li>
                <span className="swatch" aria-hidden />
                <span className="part-main">
                  <span className="part-label">Tool output</span>
                  <span className="part-hint">Counted in {r.parts.find((p) => p.id === "conversation")?.label ?? "the conversation"}; Hermes doesn't measure it on its own.</span>
                </span>
                <Badge certainty="unavailable" />
              </li>
            </ul>
            {(() => {
              const none = Object.entries(OPTIONAL_PARTS).filter(([id]) => !r.parts.some((p) => p.id === id));
              return none.length ? <p className="muted small">Nothing from: {none.map(([, label]) => label).join(", ")}. Hermes leaves out what holds nothing.</p> : null;
            })()}
          </>
        )}
      </section>

      {r.files.length > 0 && <FilesView files={r.files} />}
      <CacheView chat={chat} />
    </>
  );
}

function FilesView({ files }: { files: ContextReading["files"] }) {
  const open = useOpenPreview();
  return (
    <section className="inspector-section" aria-labelledby="ctx-files">
      <div className="inspector-subhead">
        <span id="ctx-files">Instruction files</span>
        <Badge certainty="estimated" />
      </div>
      <ul className="context-files" aria-label="Instruction files Hermes considered">
        {files.map((f) => (
          <li key={f.path} className={f.loaded ? "" : "not-loaded"}>
            <FileText size={13} aria-hidden />
            <span className="part-main">
              {open ? (
                <button className="link-btn file-link" title={`${f.path}\nOpens in the preview`} onClick={() => open({ kind: "server", path: f.path })}>
                  {f.label}
                </button>
              ) : (
                <span className="part-label">{f.label}</span>
              )}
              <span className="part-hint">{FILE_STATUS[f.status] ?? (f.loaded ? "Read in" : `Not read: ${f.status || "Hermes didn't say why"}`)}</span>
            </span>
            <span className="part-tokens">{f.loaded ? `~${n(f.tokens)}` : "—"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The provider's prompt cache, from the chat's stored usage (ADR 0008). These are billing counts over every model call,
 * so they are kept apart from the window's size and never added to it.
 */
function CacheView({ chat }: { chat: Chat }) {
  const u = chat.usage;
  const known = u && u.cacheRead !== undefined && u.input !== undefined;
  const prompt = known ? u.input! + u.cacheRead! + (u.cacheWrite ?? 0) : 0;
  return (
    <section className="inspector-section" aria-labelledby="ctx-cache">
      <div className="inspector-subhead">
        <span id="ctx-cache">Prompt cache (billing)</span>
        <Badge certainty={known ? "exact" : "unavailable"}>{known ? "As Hermes recorded" : undefined}</Badge>
      </div>
      {known && prompt > 0 ? (
        <>
          <div className="small">
            {Math.round((u.cacheRead! / prompt) * 100)}% of the input over {u.calls === undefined ? "this chat's" : `this chat's ${n(u.calls)}`} model calls was read from
            the provider's cache: {n(u.cacheRead!)} tokens read{u.cacheWrite !== undefined && <>, {n(u.cacheWrite)} written</>}, {n(u.input!)} not cached.
          </div>
          <p className="muted small">
            Every call sends the whole context again, so these add up over calls and can far exceed the window. They're what was billed, not what the window
            holds now, and aren't part of the total above.
          </p>
        </>
      ) : (
        <p className="muted small">{known ? "This chat hasn't sent any input yet." : "Hermes hasn't reported this chat's cache use. It shows once the chat's usage is read."}</p>
      )}
    </section>
  );
}

function CompactionsView({
  chat,
  status,
  history,
  api,
  onCompacted,
}: {
  chat: Chat;
  status: ConnectionStatus;
  history?: Load<CompactionHistory>;
  api: ContextApi;
  onCompacted: () => void;
}) {
  const count = chat.live?.compactions;
  return (
    <>
      {count !== undefined && (
        <p className="small">
          Hermes has compacted this chat {count === 0 ? "no times" : count === 1 ? "once" : `${n(count)} times`} since it last loaded it on the server.
        </p>
      )}
      {!history || history.state === "loading" ? (
        <Waiting>Reading the compactions Hermes stored…</Waiting>
      ) : history.state === "failed" ? (
        <div className="inspector-note" role="alert">
          <Badge certainty="unavailable" /> Couldn't read the compactions Hermes stored: {history.error}
        </div>
      ) : (
        <HistoryList history={history.value} />
      )}
      <CompactAction chat={chat} status={status} api={api} onCompacted={onCompacted} />
    </>
  );
}

/**
 * The compactions Hermes stored. A history cut short at `COMPACTION_ROWS` says so first and claims nothing the unread
 * rows could change: no absence, no count of messages taken out or read now (a kept copy or a summary may be past the
 * cut), and no compaction without a summary (its summary may be past the cut too).
 */
function HistoryList({ history }: { history: CompactionHistory }) {
  const { events, truncated } = history;
  const unmarked = truncated ? undefined : history.unmarked;
  const cut = truncated && (
    <div className="inspector-note" role="note">
      <Badge certainty="unavailable">Incomplete</Badge> This chat is long: only its first 10,000 stored rows were read. Compactions after them aren't
      listed, and how many messages each took out can't be counted, since what was kept may be in the rows not read.
    </div>
  );
  if (!events.length && !unmarked)
    return truncated ? (
      <>
        {cut}
        <p className="muted small">No compaction is stored in the rows read. Read {clockTimeWithSeconds(history.readAt)}.</p>
      </>
    ) : (
      <p className="inspector-note">
        Hermes has stored no compactions for this chat. The model reads its {n(history.inContext)} stored messages as they are.
      </p>
    );
  return (
    <>
      {cut}
      <p className="muted small">
        A compaction swaps older messages for a summary the model reads instead. They stay in the chat and in Hermes; only the model stops reading them word
        for word. Only the summary Hermes kept shows here.
      </p>
      <ol className="compactions" aria-label="Compactions, newest first">
        {[...events].reverse().map((e) => (
          <CompactionRow key={e.rowId} event={e} counted={!truncated} />
        ))}
        {unmarked && (
          <li className="compaction">
            <div className="compaction-head">
              <span>{unmarked.before ? `By ${when(unmarked.before)}` : "Time unknown"}</span>
              <Badge certainty="unavailable">No summary stored</Badge>
            </div>
            <div className="small">
              Took {unmarked.removed === 1 ? "1 message" : `${n(unmarked.removed)} messages`} out of what the model reads. Hermes stored no summary row for this,
              so what the model was given in their place can't be shown.
            </div>
          </li>
        )}
      </ol>
      <p className="muted small">
        {!truncated && <>The model reads {n(history.inContext)} stored messages now, besides the summaries. </>}Read {clockTimeWithSeconds(history.readAt)}.
      </p>
    </>
  );
}

/** `counted`: the history is whole, so the messages it took out can be counted. */
function CompactionRow({ event, counted }: { event: Compaction; counted: boolean }) {
  const [open, setOpen] = useState(false);
  const [missed, setMissed] = useState(false);
  const show = useShowInChat();
  const id = useId();
  return (
    <li className="compaction">
      <div className="compaction-head">
        <span>{event.at ? when(event.at) : "Time unknown"}</span>
        {!event.inContext && <span className="muted small">Itself compacted later</span>}
      </div>
      <div className="small">
        {counted ? <>Took {event.removed === 1 ? "1 earlier message" : `${n(event.removed)} earlier messages`} out of what the model reads, and put in</> : "Put in"}{" "}
        a summary of {event.summary.length.toLocaleString()} characters.
      </div>
      <div className="compaction-actions">
        <button className="link-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide summary" : "Show summary"}
        </button>
        {show && event.at && (
          <button className="link-btn" onClick={() => setMissed(!show(event.at))}>
            Show where it happened
          </button>
        )}
        {missed && <span className="muted small">That point isn't in the history loaded here.</span>}
      </div>
      {open && (
        <pre className="compaction-summary" id={id} tabIndex={0} aria-label="Summary Hermes kept">
          {event.summary || "The summary row is empty."}
        </pre>
      )}
    </li>
  );
}

/** Why Compact now can't be used for this chat, or nothing when it can. */
function compactBlocked(chat: Chat, status: ConnectionStatus, api: ContextApi): string | undefined {
  if (status !== "connected") return "Connect to Hermes to compact this chat.";
  if (api.cannotCompact()) return "This Hermes can't compact a chat from here.";
  if (!chat.runtimeId) return "Open the chat on Hermes to compact it.";
  if (chat.live?.compactions === undefined) return "Hermes hasn't said it can compact this chat, so Hermes Chat doesn't offer it.";
  if (chat.running) return "Hermes compacts only between replies. Wait for this one to finish.";
}

function CompactAction({ chat, status, api, onCompacted }: { chat: Chat; status: ConnectionStatus; api: ContextApi; onCompacted: () => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "running">("idle");
  const [result, setResult] = useState<{ ok: CompactResult } | { error: string }>();
  const blocked = compactBlocked(chat, status, api);
  const section = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The focused button goes when the step changes (Cancel, Compact, then the result). Focus moves to Compact now, or to
  // the section while that is disabled, so it stays in the popover and Escape still closes it. Focus the owner put
  // elsewhere meanwhile is left there.
  const was = useRef(step);
  useLayoutEffect(() => {
    const from = was.current;
    was.current = step;
    if (from === step || step === "confirm") return;
    const at = document.activeElement;
    if (at && at !== document.body && !section.current?.contains(at)) return;
    (button.current && !button.current.disabled ? button.current : section.current)?.focus();
  }, [step]);
  const run = () => {
    setStep("running");
    setResult(undefined);
    api.compact().then(
      (ok) => {
        setResult({ ok });
        setStep("idle");
        onCompacted();
      },
      (e: unknown) => {
        setResult({ error: errorText(e) });
        setStep("idle");
      },
    );
  };
  return (
    <section className="inspector-section" aria-label="Compact" ref={section} tabIndex={-1}>
      {step === "confirm" ? (
        <div className="inspector-confirm" role="group" aria-label="Compact this chat?">
          <div className="popover-title">Compact this chat now?</div>
          <p className="small">
            Hermes summarizes the older messages into one summary, and the model reads that instead of them from then on. Every message stays in the chat.
            Hermes uses the profile's compression model, which takes tokens. It can't be undone from Hermes Chat.
          </p>
          <div className="confirm-actions">
            {/* Cancel takes focus, so a stray Enter doesn't compact. */}
            <button className="btn" autoFocus onClick={() => setStep("idle")}>
              Cancel
            </button>
            <button className="btn primary" onClick={run}>
              Compact
            </button>
          </div>
        </div>
      ) : (
        <div className="compact-row">
          <button ref={button} className="btn" disabled={!!blocked || step === "running"} title={blocked} aria-description={blocked} onClick={() => setStep("confirm")}>
            {step === "running" ? (
              <>
                <Spinner /> Compacting…
              </>
            ) : (
              "Compact now…"
            )}
          </button>
          {blocked && <span className="muted small">{blocked}</span>}
        </div>
      )}
      {result && <CompactOutcome result={result} />}
      <p className="muted small">Hermes has no call to rebuild a chat's context, so Hermes Chat doesn't offer one.</p>
    </section>
  );
}

function CompactOutcome({ result }: { result: { ok: CompactResult } | { error: string } }) {
  if ("error" in result)
    return (
      <div className="inspector-note" role="alert">
        Couldn't compact: {result.error}
      </div>
    );
  const r = result.ok;
  const text =
    r.kind === "compacted"
      ? [
          "Compacted.",
          r.beforeMessages !== undefined && r.afterMessages !== undefined && ` ${n(r.beforeMessages)} messages became ${n(r.afterMessages)}`,
          r.beforeTokens !== undefined && r.afterTokens !== undefined && `, about ${n(r.beforeTokens)} → ${n(r.afterTokens)} tokens by Hermes's estimate`,
          r.beforeMessages !== undefined && r.afterMessages !== undefined && ".",
        ]
          .filter(Boolean)
          .join("")
      : r.kind === "nothing"
        ? "Hermes found nothing to compact."
        : r.message;
  return (
    <div className="inspector-note" role="status">
      {text}
      {"headline" in r && r.headline && <div className="muted small">Hermes: {r.headline}</div>}
    </div>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="inspector-waiting muted small" role="status">
      <Spinner /> {children}
    </div>
  );
}
