// Logs, in Settings → Diagnostics (ADR 0033, 0087): one source at a time, this app's own diagnostics, its record of
// recent connection attempts (kept on disk, #270), or one of the profile's Hermes logs, followed as lines arrive or
// paused to read. Filters, copy and export act on what's shown; the
// support bundle gathers the sources read here into one file, after showing what goes in it and what was redacted.
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Copy, Download, LifeBuoy, Pause, Play } from "lucide-react";
import {
  LEVELS,
  LogFollower,
  REDACTION_LIMITS,
  REMOTE_LOGS,
  appLog,
  asText,
  bundleText,
  countsText,
  passes,
  redactionCounts,
  stamp,
  type BundlePart,
  type Level,
  type LogBuffer,
  type ReadState,
  type RemoteLog,
  type Snapshot,
  type TimeFormat,
} from "../hermes/logs";
import { KEEP } from "../hermes/attempts";
import { useModal } from "./modal";
import { Spinner } from "./bits";

type Source = "app" | "attempts" | RemoteLog;
const SOURCES: Source[] = ["app", "attempts", ...(Object.keys(REMOTE_LOGS) as RemoteLog[])];
const titleOf = (s: Source) => (s === "app" ? "This app" : s === "attempts" ? "Connection attempts" : `${REMOTE_LOGS[s].label} (${REMOTE_LOGS[s].file})`);
const isRemote = (s: Source): s is RemoteLog => s in REMOTE_LOGS;
const IDLE: ReadState = { kind: "idle" };
const noSubscribe = () => () => {};
const idle = () => IDLE;
const fileStamp = (at: number) => new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

/** What Logs needs from the app, for the profile in use. */
export type LogsWiring = {
  /** How the app reaches Hermes, as the support bundle names it. */
  connection: string;
  /** `GET /api/logs` for the profile: one log's last `lines` lines. */
  read: (file: RemoteLog, lines: number) => Promise<unknown>;
  /** Saves text where the owner picks; the path, or null when they cancelled. */
  save: (text: string, fileName: string) => Promise<string | null>;
  /** How often a shown Hermes log is read, in ms: every 2 s unless a test asks for less. */
  pollMs?: number;
  /** The record of recent connection attempts (attempts.ts `AttemptLog`), read again from disk each time Logs opens. */
  attempts?: { readonly capacity: number; load(): Promise<void>; getSnapshot(): Snapshot; subscribe(fn: () => void): () => void };
};

export function LogsPanel({
  profile,
  connected,
  connection,
  read,
  save,
  app = appLog,
  pollMs,
  attempts,
}: LogsWiring & {
  profile: string;
  connected: boolean;
  app?: LogBuffer;
}) {
  const [source, setSource] = useState<Source>(connected ? "agent" : "app");
  // One follower per Hermes log opened while the screen is, so switching back keeps what was read.
  const followers = useRef(new Map<RemoteLog, LogFollower>());
  const followerOf = (s: RemoteLog) => {
    let f = followers.current.get(s);
    if (!f) followers.current.set(s, (f = new LogFollower((n) => read(s, n), REMOTE_LOGS[s].label, { pollMs })));
    return f;
  };
  const sources = attempts ? SOURCES : SOURCES.filter((s) => s !== "attempts");
  const remote = isRemote(source) ? followerOf(source) : undefined;
  const buffer = remote?.buffer ?? (source === "attempts" && attempts ? attempts : app);
  // Another launch, or another copy of the app, may have added attempts since: the file is read each time Logs opens.
  useEffect(() => void attempts?.load(), [attempts]);
  const live = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot);
  const state = useSyncExternalStore(remote?.subscribe ?? noSubscribe, remote?.getState ?? idle);

  // Reads only the log on screen, and only while connected. The reason is what the note says when reading resumes.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  useEffect(() => {
    if (!remote || !connected) return;
    remote.start();
    return () => remote.stop(connectedRef.current ? "another source was shown, or Logs was closed" : "the connection to Hermes was lost");
  }, [remote, connected]);

  // Paused, the screen shows what it had when paused, while reading carries on underneath.
  const [frozen, setFrozen] = useState<Snapshot>();
  const following = !frozen;
  const pause = () => following && setFrozen(buffer.getSnapshot());
  const view = frozen ?? live;
  const lastSeen = frozen?.entries.at(-1)?.seq ?? 0;
  const waiting = frozen ? live.entries.filter((e) => e.kind === "line" && e.seq > lastSeen).length : 0;

  const [min, setMin] = useState<Level | "">("");
  const [text, setText] = useState("");
  const needle = useDeferredValue(text);
  const [fmt, setFmt] = useState<TimeFormat>("local");
  const shown = useMemo(() => view.entries.filter((e) => passes(e, { min: min || undefined, text: needle })), [view, min, needle]);
  const shownLines = shown.filter((e) => e.kind === "line").length;

  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (following && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [shown, following, fmt]);

  const [note, setNote] = useState<string>();
  // The bundle's sources as they were when it opened: what it previews, counts and saves is that one moment.
  const [bundle, setBundle] = useState<(BundlePart & { id: Source })[]>();
  const bundleButton = useRef<HTMLButtonElement>(null);

  const pick = (s: Source) => {
    setSource(s);
    setFrozen(undefined);
    setNote(undefined);
  };

  const copy = async () => {
    const sel = window.getSelection();
    const inList = !!sel && !sel.isCollapsed && !!list.current?.contains(sel.anchorNode);
    try {
      await navigator.clipboard.writeText(inList ? sel.toString() : asText(shown, fmt));
      setNote(inList ? "Copied the selected text." : `Copied ${shownLines} line${shownLines === 1 ? "" : "s"}.`);
    } catch (e) {
      setNote(`Couldn't copy: ${(e as Error).message}`);
    }
  };

  const exportShown = async () => {
    const now = Date.now();
    const head = [
      `${titleOf(source)}${remote ? `, profile ${profile}` : ""}, exported ${new Date(now).toISOString()} by Hermes Chat`,
      `Shown: ${min ? `${min} and above` : "every level"}${needle.trim() ? `, containing "${needle.trim()}"` : ""}${frozen ? ", as it was when paused" : ""}.`,
      REDACTION_LIMITS,
      "",
    ].join("\n");
    try {
      const path = await save(`${head}${asText(shown, fmt, view.dropped)}\n`, `hermes-${source}-log-${fileStamp(now)}.txt`);
      setNote(path ? `Saved to ${path}.` : undefined);
    } catch (e) {
      setNote(`Couldn't save: ${(e as Error).message}`);
    }
  };

  const parts = (): (BundlePart & { id: Source })[] => [
    { id: "app", title: titleOf("app"), detail: "this computer, since the app started", snapshot: app.getSnapshot() },
    ...(attempts && attempts.getSnapshot().lines
      ? [{ id: "attempts" as const, title: titleOf("attempts"), detail: `this computer, the last ${KEEP}, kept between launches`, snapshot: attempts.getSnapshot() }]
      : []),
    ...[...followers.current]
      .filter(([, f]) => f.buffer.getSnapshot().entries.length)
      .map(([id, f]) => ({ id, title: titleOf(id), detail: `Hermes, profile ${profile}`, snapshot: f.buffer.getSnapshot() })),
  ];

  const status = (() => {
    if (source === "attempts")
      return `The last ${KEEP} times Hermes Chat opened a connection, kept on this computer between launches: each route tried, by its kind and id, the steps it reached and how long each took, and the error, with secrets and addresses taken out.`;
    if (!remote) return "This app's own diagnostics since it started: connection changes, failures it showed, uncaught errors and console warnings. Kept in memory only.";
    if (!connected) return "Not connected to Hermes. Reading starts again once Hermes Chat reconnects.";
    switch (state.kind) {
      case "reading":
        return "Reading…";
      case "ok":
        return `Read from Hermes every ${Math.round((pollMs ?? 2000) / 1000)} s, last at ${new Date(state.at).toLocaleTimeString()}. Hermes gives the last 500 lines each time.`;
      default:
        return "";
    }
  })();

  return (
    <div className="logs-panel" role="region" aria-label="Logs">
      <div className="usage-filters logs-filters" role="group" aria-label="What to show">
        <label>
          <span>Source</span>
          <select value={source} onChange={(e) => pick(e.target.value as Source)}>
            {sources.map((s) => (
              <option key={s} value={s}>
                {titleOf(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Level</span>
          <select value={min} onChange={(e) => setMin(e.target.value as Level | "")}>
            <option value="">Every level</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l} and above
              </option>
            ))}
          </select>
        </label>
        <label className="logs-search">
          <span>Containing</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to find" />
        </label>
        <label>
          <span>Received time</span>
          <select value={fmt} onChange={(e) => setFmt(e.target.value as TimeFormat)}>
            <option value="local">This computer's time</option>
            <option value="utc">UTC</option>
            <option value="off">Hidden</option>
          </select>
        </label>
      </div>

      <div className="logs-actions">
        <button className="btn" aria-pressed={!following} onClick={() => (following ? pause() : setFrozen(undefined))}>
          {following ? <Pause size={14} /> : <Play size={14} />} {following ? "Pause" : waiting ? `Follow (${waiting} new)` : "Follow"}
        </button>
        <button className="btn" onClick={() => void copy()} title="Copy the selected text, or every line shown" disabled={!shown.length}>
          <Copy size={14} /> Copy
        </button>
        <button className="btn" onClick={() => void exportShown()} disabled={!shown.length}>
          <Download size={14} /> Export shown…
        </button>
        <button className="btn" ref={bundleButton} onClick={() => setBundle(parts())}>
          <LifeBuoy size={14} /> Support bundle…
        </button>
        {note && (
          <span className="muted small" role="status">
            {note}
          </span>
        )}
      </div>

      <p className="muted small logs-status" role="status">
        {state.kind === "reading" && <Spinner />} {status}{" "}
        {view.lines} line{view.lines === 1 ? "" : "s"} kept{view.dropped ? `, ${view.dropped} older dropped` : ""}
        {shownLines !== view.lines ? `, ${shownLines} shown` : ""}.
        {remote && " Times in Hermes's lines are the server's clock; the received time is this computer's."}
      </p>
      {remote && state.kind === "failed" && (
        <p className="logs-problem" role="alert">
          <CircleAlert size={14} aria-hidden /> Couldn't read the {REMOTE_LOGS[source as RemoteLog].label} log: {state.reason}. Trying again.
        </p>
      )}
      {remote && state.kind === "unsupported" && (
        <p className="logs-problem" role="alert">
          <CircleAlert size={14} aria-hidden /> {state.reason}
        </p>
      )}
      {frozen && (
        <p className="logs-paused" role="status">
          <Pause size={13} aria-hidden /> Paused: the lines stay where they are while you read.{" "}
          {waiting ? `${waiting} new line${waiting === 1 ? "" : "s"} since. ` : ""}
          <button className="link-btn" onClick={() => setFrozen(undefined)}>
            Follow new lines
          </button>
        </p>
      )}

      <div
        ref={list}
        className="logs-list"
        role="log"
        aria-live="off"
        aria-label={`${titleOf(source)} log`}
        tabIndex={0}
        onWheel={(e) => e.deltaY < 0 && pause()}
        onPointerDown={pause}
        onKeyDown={(e) => ["ArrowUp", "PageUp", "Home"].includes(e.key) && pause()}
      >
        {view.dropped > 0 && (
          <div className="log-row log-mark">
            <span className="log-text">
              {view.dropped} older line{view.dropped === 1 ? "" : "s"} dropped: Logs keeps only the latest {buffer.capacity}.
            </span>
          </div>
        )}
        {shown.map((e) => (
          <div key={e.seq} className={`log-row ${e.kind === "mark" ? "log-mark" : `lvl-${(e.level ?? "none").toLowerCase()}`}`}>
            {fmt !== "off" && (
              <time className="log-time" dateTime={new Date(e.at).toISOString()}>
                {stamp(e.at, fmt)}
              </time>
            )}
            <span className="log-text">{e.text}</span>
          </div>
        ))}
        {!shown.length && (
          <p className="muted logs-empty">
            {view.entries.length
              ? "No lines match these filters."
              : remote
                ? state.kind === "ok"
                  ? "This log is empty, or Hermes hasn't written it yet."
                  : state.kind === "reading"
                    ? "Reading…"
                    : "Nothing read yet."
                : "Nothing yet."}
          </p>
        )}
      </div>
      {bundle && (
        <SupportBundle
          parts={bundle}
          profile={profile}
          connection={connection}
          save={save}
          returnTo={bundleButton}
          onClose={() => setBundle(undefined)}
        />
      )}
    </div>
  );
}

const PREVIEW_LINES = 400;

/** What a support bundle holds, before it's saved: its sources, what was redacted, and the file's text. */
function SupportBundle({
  parts,
  profile,
  connection,
  save,
  returnTo,
  onClose,
}: {
  parts: (BundlePart & { id: Source })[];
  profile: string;
  connection: string;
  save: (text: string, fileName: string) => Promise<string | null>;
  returnTo: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const [now] = useState(() => Date.now());
  const [chosen, setChosen] = useState(() => new Set(parts.map((p) => p.id)));
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const included = parts.filter((p) => chosen.has(p.id));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  const text = useMemo(() => bundleText(included, { profile, connection, now }), [chosen]);
  const counts = redactionCounts(included);
  const all = text.split("\n");
  const preview = all.slice(0, PREVIEW_LINES).join("\n");

  const doSave = async () => {
    setSaving(true);
    try {
      const path = await save(text, `hermes-chat-support-${fileStamp(now)}.txt`);
      if (path) onClose();
    } catch (e) {
      setNote(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={box}
        className="leave-dialog logs-bundle"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !saving) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <LifeBuoy size={14} aria-hidden /> Support bundle
        </h2>
        <p>
          One text file with the sources you tick, every line each had kept when you opened this, whatever the filters show. Nothing is sent anywhere: you choose
          where to save it.
        </p>
        <fieldset className="logs-bundle-sources">
          <legend>Included</legend>
          {parts.map((p, i) => (
            <label key={p.id}>
              <input
                type="checkbox"
                autoFocus={i === 0}
                checked={chosen.has(p.id)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(p.id);
                  else next.delete(p.id);
                  setChosen(next);
                }}
              />
              <span>
                {p.title}: {p.snapshot.lines} line{p.snapshot.lines === 1 ? "" : "s"}
                {p.snapshot.dropped ? `, ${p.snapshot.dropped} older dropped` : ""} <span className="muted">({p.detail})</span>
              </span>
            </label>
          ))}
          {!parts.some((p) => isRemote(p.id)) && <p className="muted small">To include a Hermes log, pick it as the source first so Logs reads it.</p>}
        </fieldset>
        <p>
          <strong>Redacted:</strong> {counts.length ? countsText(counts) : "nothing recognized as a secret"}.
        </p>
        <p className="muted small">{REDACTION_LIMITS}</p>
        <pre className="logs-bundle-preview" tabIndex={0} aria-label="The file's text">
          {preview}
          {all.length > PREVIEW_LINES ? `\n… and ${all.length - PREVIEW_LINES} more lines in the file.` : ""}
        </pre>
        {note && (
          <p role="alert" className="logs-problem">
            {note}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void doSave()} disabled={saving || !included.length}>
            <Download size={14} /> Save…
          </button>
        </div>
      </div>
    </div>
  );
}
