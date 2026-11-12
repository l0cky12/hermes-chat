// Saved connections on screen (ADR 0112): the recent-connection picker on the sign-in screen and the rail, the
// manager in Settings → General with the live connections' overview (ADR 0125), and the questions asked before
// switching, removing and connecting past the limit. Connections are told apart by id; two can share a name, so each
// always shows its address too.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert, Globe, Pencil, Plug, PlugZap, Plus, Server, Settings2, Terminal, Trash2, TriangleAlert, Unplug, X } from "lucide-react";
import { type SavedConnection, LIVE_LIMIT_MAX, NAME_MAX, addressLabel, routesSummary } from "../hermes/connections";
import type { LiveStatus, LiveSummary } from "../hermes/liveConnections";
import { KEPT_ON_SERVER, REMOVED_LOCALLY } from "../hermes/forgetConnection";
import { stageLabel, type TestOutcome } from "../hermes/setup";
import { ago, composing, routeLabel, useReturnFocus } from "./bits";
import { useLocale, type Locale } from "../i18n/locale";
import { SettingNote, SettingsSection } from "./SettingRows";
import { errorText } from "../hermes/values";

export const lastUsedText = (c: SavedConnection, l: Locale) => (c.lastUsedAt ? `Used ${ago(l, c.lastUsedAt)}` : "Never connected");

const ModeIcon = ({ c, size = 13 }: { c: SavedConnection; size?: number }) =>
  c.mode === "ssh" ? <Terminal size={size} aria-label="SSH" /> : <Globe size={size} aria-label="URL" />;

const STATUS_TEXT: Record<LiveStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline",
  "needs-sign-in": "Needs sign-in",
};

/** A live connection's status, as a badge. */
const StatusBadge = ({ s }: { s: LiveSummary }) => (
  <span className={`badge conn-status is-${s.status}`} title={s.why}>
    {s.target ? "In use" : s.status === "connected" ? "Live" : STATUS_TEXT[s.status]}
  </span>
);

/** Why a Connect was refused at the limit. */
export const atLimitText = (limit: number) =>
  `Hermes Chat already has ${limit} connection${limit === 1 ? "" : "s"} open, the most it keeps open. Disconnect one first, or raise the limit in Settings → General → Connections.`;

/** What a live connection has under way, in a few words, or nothing. */
export function liveCounts(s: Pick<LiveSummary, "waiting" | "running" | "failed" | "unread">): string {
  const parts = [
    s.waiting && `${s.waiting} waiting`,
    s.running && `${s.running} running`,
    s.failed && `${s.failed} failed`,
    s.unread && `${s.unread} unread`,
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The saved connections, most recently used first, to pick one. Picking only says which: the caller decides what
 * happens (fill the sign-in form, or switch after asking). Nothing is picked on its own.
 */
export function ConnectionPicker({
  connections,
  currentId,
  selectedId,
  onPick,
  label = "Recent connections",
  disabled = false,
  live = [],
}: {
  connections: SavedConnection[];
  /** The live connections (ADR 0125), each marked with its status. */
  live?: LiveSummary[];
  /** The connection in use, marked In use. */
  currentId?: string;
  /** The one the form beside the picker is for. */
  selectedId?: string;
  onPick: (c: SavedConnection) => void;
  label?: string;
  disabled?: boolean;
}) {
  const l = useLocale();
  const labelId = useId();
  if (!connections.length) return null;
  return (
    <div className="conn-picker">
      <div id={labelId} className="conn-picker-label">
        {label}
      </div>
      <ul className="conn-list" aria-labelledby={labelId}>
        {connections.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={`conn-option ${c.id === selectedId ? "on" : ""}`}
              aria-current={c.id === selectedId ? "true" : undefined}
              disabled={disabled}
              onClick={() => onPick(c)}
            >
              <span className="conn-option-icon">
                <ModeIcon c={c} />
              </span>
              <span className="conn-option-text">
                <span className="conn-option-name">
                  {c.name}
                  {live.find((s) => s.id === c.id && !(s.target && c.id === currentId)) ? (
                    <StatusBadge s={live.find((s) => s.id === c.id)!} />
                  ) : (
                    c.id === currentId && <span className="badge">In use</span>
                  )}
                </span>
                <span className="conn-option-meta">
                  <span className="mono">{addressLabel(c)}</span> · {c.username || "no username"} · {lastUsedText(c, l)}
                </span>
              </span>
              {c.id === selectedId && <Check size={14} className="conn-option-check" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The rail's connection button: the connection in use, and a popover with the recent connections to switch to, Add
 * connection and Manage connections. Escape or a click outside closes it, and focus goes back to the button.
 */
export function RailConnections({
  connections,
  currentId,
  live = [],
  onSwitch,
  onAdd,
  onManage,
}: {
  connections: SavedConnection[];
  currentId: string;
  /** The live connections (ADR 0125): the button sums what they have waiting and marks any not connected. */
  live?: LiveSummary[];
  onSwitch: (c: SavedConnection) => void;
  onAdd: () => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = connections.find((c) => c.id === currentId);
  const others = live.filter((s) => !s.target);
  const waiting = others.reduce((n, s) => n + s.waiting, 0);
  const down = others.filter((s) => s.status !== "connected");
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const tip = [
    current ? `Connection: ${current.name} (${addressLabel(current)}).` : "",
    others.length ? `${others.length} more live${waiting ? `, ${waiting} waiting for you` : ""}.` : "",
    down.length ? `${down.map((s) => `${s.name} is ${STATUS_TEXT[s.status].toLowerCase()}`).join(", ")}.` : "",
    "Switch connection",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="rail-conns" ref={box}>
      <button className={`icon-btn ${open ? "on" : ""}`} title={tip} aria-label={tip} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Server size={18} />
        {waiting > 0 && (
          <span className="conn-count" aria-hidden>
            {waiting}
          </span>
        )}
        {down.length > 0 && <span className="dot warn conn-down" aria-hidden />}
      </button>
      {open && (
        <RailConnectionsMenu
          connections={connections}
          live={live}
          currentId={currentId}
          onClose={() => setOpen(false)}
          onPick={(c) => {
            setOpen(false);
            if (c.id !== currentId) onSwitch(c);
          }}
          onAdd={() => {
            setOpen(false);
            onAdd();
          }}
          onManage={() => {
            setOpen(false);
            onManage();
          }}
        />
      )}
    </div>
  );
}

function RailConnectionsMenu({
  connections,
  live,
  currentId,
  onPick,
  onAdd,
  onManage,
  onClose,
}: {
  connections: SavedConnection[];
  live: LiveSummary[];
  currentId: string;
  onPick: (c: SavedConnection) => void;
  onAdd: () => void;
  onManage: () => void;
  onClose: () => void;
}) {
  useReturnFocus();
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => first.current?.querySelector<HTMLButtonElement>(".conn-option")?.focus(), []);
  return (
    <div
      className="conn-menu"
      role="dialog"
      aria-label="Switch connection"
      ref={first}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !composing(e)) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <ConnectionPicker connections={connections} live={live} currentId={currentId} selectedId={currentId} onPick={onPick} />
      <div className="conn-menu-actions">
        <button className="btn" onClick={onAdd}>
          <Plus size={14} /> Add connection
        </button>
        <button className="btn" onClick={onManage}>
          <Settings2 size={14} /> Manage
        </button>
      </div>
    </div>
  );
}

/** A live connection's line in the overview: its route, its last activity and what it has under way. */
function LiveLine({ s }: { s: LiveSummary }) {
  const l = useLocale();
  const counts = liveCounts(s);
  const parts = [
    s.status === "needs-sign-in" ? s.why ?? "Sign in to open it." : routeLabel(s.route),
    s.lastActivity && `last activity ${ago(l, s.lastActivity)}`,
    counts || (s.status === "connected" ? "nothing under way" : ""),
    s.blind && "this Hermes doesn't report running work",
  ].filter(Boolean);
  return <div className="conn-live-line">{parts.join(" · ")}</div>;
}

/**
 * Asked when Connect would go past the limit: the background connections, each with Disconnect. Nothing closes to make
 * room by itself, since a close drops the Approvals of every chat that connection holds.
 */
export function AtConnectionLimit({
  to,
  limit,
  live,
  onDisconnect,
  onClose,
}: {
  to: SavedConnection;
  limit: number;
  /** The background connections, the ones that can be disconnected. */
  live: LiveSummary[];
  onDisconnect: (id: string) => void;
  onClose: () => void;
}) {
  const title = useId();
  const note = useId();
  useReturnFocus();
  return (
    <div className="palette-scrim leave-scrim" onMouseDown={onClose}>
      <div
        className="leave-dialog conn-at-limit"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={note}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && onClose()}
      >
        <div id={title} className="confirm-msg leave-title">
          <TriangleAlert size={14} /> Can't connect to {to.name} yet
        </div>
        <p id={note} className="muted">
          {atLimitText(limit)} Nothing was closed.
        </p>
        <ul className="leave-list conn-at-limit-list">
          {live.map((s) => (
            <li key={s.id}>
              <span>
                {s.name} · {STATUS_TEXT[s.status]}
                {liveCounts(s) && ` · ${liveCounts(s)}`}
              </span>
              <button className="btn" onClick={() => onDisconnect(s.id)} aria-label={`Disconnect ${s.name}`}>
                <Unplug size={14} /> Disconnect
              </button>
            </li>
          ))}
        </ul>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** A connection test's answer as the manager shows it, or why it couldn't be tested. */
export type ManagerTest = { state: "testing" } | { state: "done"; outcome: TestOutcome } | { state: "cant"; why: string };

/**
 * Settings → General → Connections: every saved connection with its mode, address, username and when it was last
 * used. Each can be renamed in place, tested with its saved sign-in, edited through Setup, connected to, or removed.
 * Adding one goes through Setup too. The one in use carries on while another is tested.
 */
export function ConnectionManager({
  connections,
  currentId,
  unsaved = false,
  live = [],
  liveLimit,
  onLiveLimit,
  onUse,
  onDisconnect,
  onTest,
  onConnect,
  onEdit,
  onRemove,
  onRename,
  onAdd,
}: {
  connections: SavedConnection[];
  currentId: string;
  /** The live connections' overview (ADR 0125): status, route, last activity and counts, the target first. */
  live?: LiveSummary[];
  /** How many may be live at once, and changing it; absent, the limit isn't shown. */
  liveLimit?: number;
  onLiveLimit?: (n: number) => void;
  /** Makes a live connection the composer target, or asks to sign in to one that needs it. */
  onUse?: (c: SavedConnection) => void;
  /** Closes a background connection. */
  onDisconnect?: (c: SavedConnection) => void;
  /** This computer's storage refused the list's last change, so it lasts only until the app closes. */
  unsaved?: boolean;
  /** Tests `c` with its saved password; rejects with why it can't (no password saved). */
  onTest: (c: SavedConnection) => Promise<TestOutcome>;
  onConnect: (c: SavedConnection) => void;
  onEdit: (c: SavedConnection) => void;
  onRemove: (c: SavedConnection) => void;
  onRename: (c: SavedConnection, name: string) => void;
  onAdd: () => void;
}) {
  const l = useLocale();
  const [tests, setTests] = useState<Record<string, ManagerTest>>({});
  const [renaming, setRenaming] = useState<string>();
  const runs = useRef(new Map<string, number>());
  // A test's answer is for the connection as it was tested: one still running when it is edited or removed is dropped.
  useEffect(() => () => runs.current.clear(), []);
  const test = async (c: SavedConnection) => {
    const n = (runs.current.get(c.id) ?? 0) + 1;
    runs.current.set(c.id, n);
    setTests((t) => ({ ...t, [c.id]: { state: "testing" } }));
    let next: ManagerTest;
    try {
      next = { state: "done", outcome: await onTest(c) };
    } catch (e) {
      next = { state: "cant", why: errorText(e) };
    }
    if (runs.current.get(c.id) === n) setTests((t) => ({ ...t, [c.id]: next }));
  };
  return (
    <SettingsSection
      title="Connections"
      titleId="conn-manager-title"
      className="conn-manager"
      intro={
        liveLimit && liveLimit > 1
          ? `The Hermes servers this app can sign in to. Up to ${liveLimit} can be live at once: the one in use is where you type, and the others carry on in the background, showing their Approvals and what runs and waits there.`
          : "The Hermes servers this app can sign in to. One is in use at a time."
      }
      more="Each connection keeps its own password and extra request headers in the system keyring, and its own drafts, queued messages, profile and Saved copies on this computer. A background connection never sends, starts or searches anything: make it the one in use to work in it."
      action={
        <button className="btn" onClick={onAdd}>
          <Plus size={14} /> Add connection
        </button>
      }
    >
      {unsaved && (
        <SettingNote tone="bad" role="alert">
          This computer's storage is full, so the latest change to this list lasts only until Hermes Chat closes.
        </SettingNote>
      )}
      {liveLimit !== undefined && onLiveLimit && (
        <div className="set-row conn-limit">
          <label htmlFor="conn-limit">Live at once</label>
          <select id="conn-limit" value={liveLimit} onChange={(e) => onLiveLimit(Number(e.target.value))} aria-describedby="conn-limit-note">
            {Array.from({ length: LIVE_LIMIT_MAX }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span id="conn-limit-note" className="muted">
            {liveLimit === 1 ? "Switching closes the connection you leave." : "Each live connection keeps its own socket, and for SSH an ssh process. Lowering this closes nothing."}
          </span>
        </div>
      )}
      <ul className="conn-rows">
        {connections.map((c) => {
          const t = tests[c.id];
          const inUse = c.id === currentId;
          const s = live.find((x) => x.id === c.id);
          return (
            <li key={c.id} className={`set-row conn-row ${inUse ? "in-use" : ""}`}>
              <div className="conn-row-main">
                <span className="conn-option-icon">
                  <ModeIcon c={c} size={14} />
                </span>
                <div className="conn-row-text">
                  {renaming === c.id ? (
                    <RenameConnection
                      c={c}
                      onDone={(name) => {
                        setRenaming(undefined);
                        if (name !== undefined) onRename(c, name);
                      }}
                    />
                  ) : (
                    <div className="conn-row-name">
                      <span>{c.name}</span>
                      {s ? <StatusBadge s={s} /> : inUse && <span className="badge">In use</span>}
                      <button className="icon-btn small" title="Rename" aria-label={`Rename ${c.name}`} onClick={() => setRenaming(c.id)}>
                        <Pencil size={12} />
                      </button>
                    </div>
                  )}
                  <div className="conn-option-meta">
                    {c.routes && c.routes.length > 1 ? (
                      <span title={`Tried in order, first ${addressLabel(c)}`}>
                        {c.routes.length} routes: {routesSummary(c)}
                      </span>
                    ) : (
                      <>
                        {c.mode === "ssh" ? "SSH" : "URL"} · <span className="mono">{addressLabel(c)}</span>
                      </>
                    )}{" "}
                    · {c.username || "no username"} · {lastUsedText(c, l)}
                  </div>
                  {s && <LiveLine s={s} />}
                </div>
              </div>
              <div className="conn-row-actions">
                <button className="btn" disabled={t?.state === "testing"} onClick={() => void test(c)} aria-label={`Test ${c.name}`}>
                  <PlugZap size={14} /> {t?.state === "testing" ? "Testing…" : "Test"}
                </button>
                <button className="btn" onClick={() => onEdit(c)} aria-label={`Edit ${c.name}`}>
                  <Pencil size={14} /> Edit
                </button>
                <button className="btn" onClick={() => onRemove(c)} aria-label={`Remove ${c.name}`}>
                  <Trash2 size={14} /> Remove
                </button>
                {s && !s.target && onDisconnect && s.status !== "needs-sign-in" && (
                  <button className="btn" onClick={() => onDisconnect(c)} aria-label={`Disconnect ${c.name}`}>
                    <Unplug size={14} /> Disconnect
                  </button>
                )}
                {s && !s.target && onUse ? (
                  <button className="btn primary" onClick={() => onUse(c)} aria-label={s.status === "needs-sign-in" ? `Sign in to ${c.name}` : `Use ${c.name}`}>
                    <Plug size={14} /> {s.status === "needs-sign-in" ? "Sign in" : "Use"}
                  </button>
                ) : (
                  !inUse &&
                  !s && (
                    <button className="btn primary" onClick={() => onConnect(c)} aria-label={`Connect to ${c.name}`}>
                      <Plug size={14} /> Connect
                    </button>
                  )
                )}
              </div>
              {t && t.state !== "testing" && <ManagerTestResult test={t} c={c} onDismiss={() => setTests(({ [c.id]: _, ...rest }) => rest)} />}
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}

function RenameConnection({ c, onDone }: { c: SavedConnection; onDone: (name?: string) => void }) {
  const [name, setName] = useState(c.name);
  return (
    <form
      className="conn-rename"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name);
      }}
    >
      <input
        autoFocus
        aria-label={`New name for ${c.name}`}
        value={name}
        maxLength={NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && (e.stopPropagation(), onDone())}
      />
      <button className="btn" type="submit">
        Save
      </button>
      <button className="btn" type="button" onClick={() => onDone()}>
        Cancel
      </button>
    </form>
  );
}

function ManagerTestResult({ test, c, onDismiss }: { test: Exclude<ManagerTest, { state: "testing" }>; c: SavedConnection; onDismiss: () => void }) {
  const ok = test.state === "done" && test.outcome.ok;
  return (
    <div className={`conn-test ${ok ? "ok" : "bad"}`} role={ok ? "status" : "alert"}>
      {test.state === "cant" ? (
        <span>
          <CircleAlert size={13} /> {test.why}
        </span>
      ) : test.outcome.ok ? (
        <span>
          <Check size={13} /> The connection works: {routeLabel(test.outcome.route)}
          {test.outcome.version && `, Hermes ${test.outcome.version}`}.{test.outcome.unsecure && " Its traffic isn't encrypted (Unsecure)."}
        </span>
      ) : (
        <div>
          <div>
            <CircleAlert size={13} /> Stopped at “{stageLabel(test.outcome.stage, c.mode)}”: {test.outcome.problem}
          </div>
          {test.outcome.detail && <div className="mono small conn-test-detail">{test.outcome.detail}</div>}
          {test.outcome.fixes.length > 0 && (
            <ul className="conn-test-fixes">
              {test.outcome.fixes.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button className="icon-btn small" aria-label="Dismiss the test result" title="Dismiss" onClick={onDismiss}>
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * Asked before switching away from a connection that has something running or waiting. Stay has focus, so a stray
 * Enter stays. `notes`: what is left behind, in words.
 */
export function SwitchConnection({ from, to, notes, onGo, onStay }: { from: SavedConnection; to: SavedConnection; notes: string[]; onGo: () => void; onStay: () => void }) {
  const title = useId();
  const note = useId();
  useReturnFocus();
  return (
    <div className="palette-scrim leave-scrim" onMouseDown={onStay}>
      <div
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={note}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && onStay()}
      >
        <div id={title} className="confirm-msg leave-title">
          <TriangleAlert size={14} /> Switch to {to.name}?
        </div>
        <div id={note}>
          <p className="muted">Work is still under way on {from.name} ({addressLabel(from)}):</p>
          <ul className="leave-list">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="muted">
            Switching closes this connection. Hermes keeps running replies going on its server, and an Approval waits only until Hermes stops
            waiting, so come back to answer it. Queued messages stay on this computer and wait until you're back.
          </p>
        </div>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Stay
          </button>
          <button className="btn primary" onClick={onGo}>
            Switch anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** Asked before Disconnect closes a background connection with a reply running or an Approval waiting. Stay has focus. */
export function DisconnectConnection({ s, onGo, onStay }: { s: LiveSummary; onGo: () => void; onStay: () => void }) {
  const title = useId();
  const note = useId();
  useReturnFocus();
  const { waiting, running } = s.underWay;
  const notes = [
    waiting && `${waiting === 1 ? "An Approval is" : `${waiting} Approvals are`} waiting for you.`,
    running && `${running === 1 ? "A reply is" : `${running} replies are`} running.`,
  ].filter((n): n is string => !!n);
  return (
    <div className="palette-scrim leave-scrim" onMouseDown={onStay}>
      <div
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={note}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && onStay()}
      >
        <div id={title} className="confirm-msg leave-title">
          <TriangleAlert size={14} /> Disconnect {s.name}?
        </div>
        <div id={note}>
          <ul className="leave-list">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="muted">
            Disconnecting closes this connection. Hermes keeps running replies going on its server, and an Approval waits only until Hermes stops
            waiting, so connect again to answer it.
          </p>
        </div>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Stay
          </button>
          <button className="btn primary" onClick={onGo}>
            Disconnect anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asked before removing a saved connection: what goes from this computer, and that the server keeps its chats.
 * Cancel has focus. A removal the keyring refuses keeps the connection and says why.
 */
export function RemoveConnection({
  c,
  inUse,
  notes = [],
  onRemove,
  onCancel,
}: {
  c: SavedConnection;
  inUse: boolean;
  /** What is running or waiting on it now, when it is in use. */
  notes?: string[];
  onRemove: () => Promise<void>;
  onCancel: () => void;
}) {
  const title = useId();
  const note = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useReturnFocus();
  const cancel = () => !busy && onCancel();
  return (
    <div className="palette-scrim leave-scrim" onMouseDown={cancel}>
      <div
        className="leave-dialog conn-remove"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={note}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !composing(e) && cancel()}
      >
        <div id={title} className="confirm-msg leave-title">
          <TriangleAlert size={14} /> Remove {c.name}?
        </div>
        <div id={note}>
          <p className="muted">
            <span className="mono">{addressLabel(c)}</span>
            {inUse && ". It's the connection in use, so you'll be signed out of it first"}. This deletes from this computer:
          </p>
          <ul className="leave-list">
            {REMOVED_LOCALLY.map((r) => (
              <li key={r}>{r[0].toUpperCase() + r.slice(1)}</li>
            ))}
          </ul>
          <p className="muted">{KEPT_ON_SERVER}</p>
          {notes.length > 0 && (
            <>
              <p className="muted">Work is still under way on it. Hermes keeps running replies going on the server:</p>
              <ul className="leave-list">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        {error && (
          <div className="sign-in-error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-actions">
          <button className="btn" autoFocus disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onRemove();
              } catch (e) {
                setError(errorText(e));
                setBusy(false);
              }
            }}
          >
            <Trash2 size={14} /> {busy ? "Removing…" : "Remove connection"}
          </button>
        </div>
      </div>
    </div>
  );
}
