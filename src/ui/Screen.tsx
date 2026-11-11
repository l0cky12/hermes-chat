// The side panel's Screen (ADR 0039): Hermes's Bot Desktop for the profile shown, the screen on the server where the
// agent's computer use and its browser run. The owner watches it live, takes over for something only they should type
// (a sign-in, a 2FA code, a CAPTCHA) and hands back. Hermes keeps who may drive it (the lease): while the owner holds
// it, Hermes's computer use waits, and only the holder's keys and pointer reach the screen. noVNC draws the stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Hand, MonitorPlay, MousePointer2, Play, RefreshCw } from "lucide-react";
import {
  BROWSER_FIX,
  CLOSE_CONTROL_TAKEN,
  CLOSE_SCREEN_GONE,
  RelayedSocket,
  browserOf,
  heldBy,
  isOlder,
  isUnavailable,
  phaseOf,
  viewerHash,
  type DisplayLease,
  type DisplayStatus,
  type ScreenApi,
} from "../hermes/screen";
import { CopyCommand, Spinner } from "./bits";
import { errorText } from "../hermes/values";

/** What the Screen needs of noVNC's RFB client. */
export type RfbClient = {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  background: string;
  qualityLevel: number;
  addEventListener(type: "connect" | "disconnect", handler: (e: { detail?: { clean?: boolean } }) => void): void;
  disconnect(): void;
  focus(): void;
};
export type RfbConstructor = new (target: HTMLElement, channel: RelayedSocket, options: { shared: boolean }) => RfbClient;

/**
 * noVNC loads only when a screen is first shown. As it loads it asks WebCodecs whether H.264 decodes (a top-level await
 * in `core/util/browser.js`). In WebKitGTK 2.54 without an H.264 GStreamer decoder, `VideoDecoder.isConfigSupported`
 * crashes the page's web process, the whole app's page. So noVNC loads with no `VideoDecoder` to find, and it then
 * never asks for H.264, which Hermes's Xvnc doesn't send anyway. It is put back once noVNC has loaded.
 */
export async function loadNoVnc(): Promise<RfbConstructor> {
  const global = globalThis as Record<string, unknown>;
  const decoder = Object.getOwnPropertyDescriptor(global, "VideoDecoder");
  if (decoder?.configurable) delete global.VideoDecoder;
  try {
    return (await import("@novnc/novnc")).default as RfbConstructor;
  } finally {
    if (decoder?.configurable) Object.defineProperty(global, "VideoDecoder", decoder);
  }
}

/** Takeovers by someone else this soon after attaching, this many times in a row, stop the re-attaching. */
const EVICTION_WINDOW_MS = 5_000;
const MAX_EVICTIONS = 3;

type Conn = { kind: "idle" } | { kind: "attaching" } | { kind: "live" } | { kind: "lost"; why: string };

export function ScreenTab({
  api,
  shown,
  connected,
  loadRfb = loadNoVnc,
  onHeld,
}: {
  api: ScreenApi;
  shown: boolean;
  connected: boolean;
  loadRfb?: () => Promise<RfbConstructor>;
  /** Whether the owner holds the screen, so the panel can say so while the tab isn't shown. */
  onHeld?: (held: boolean) => void;
}) {
  const [status, setStatus] = useState<DisplayStatus>();
  const [lease, setLease] = useState<DisplayLease>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<Conn>({ kind: "idle" });
  const [viewer, setViewer] = useState<{ id: string; hash: string }>();
  const [evicted, setEvicted] = useState(false);
  /** The browser a Check again found where there was none, said once until the next read. */
  const [found, setFound] = useState<string>();
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RfbClient | null>(null);
  // Bumped by every attach and detach, so a late answer from an earlier one does nothing.
  const generation = useRef(0);
  const evictions = useRef({ count: 0, at: 0 });
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  const held = heldBy(lease, viewer?.hash);
  // Viewers this tab held the screen as on connections since gone. Hermes keeps such a hold when a connection drops,
  // so the owner can be told it is still theirs.
  const pastHolds = useRef(new Set<string>());
  if (held && viewer) pastHolds.current.add(viewer.hash);
  const onHeldRef = useRef(onHeld);
  onHeldRef.current = onHeld;
  useEffect(() => onHeldRef.current?.(held), [held]);
  // Not cleared when the tab goes: leaving the connection hands back what the owner still holds.
  useEffect(() => api.noteHeld(held ? viewer?.id : undefined), [api, held, viewer?.id]);
  useEffect(() => () => onHeldRef.current?.(false), []);

  const noteLease = useCallback((next: DisplayLease) => setLease((known) => (isOlder(known, next) ? known : next)), []);
  const noteStatus = useCallback(
    (s: DisplayStatus) => {
      setStatus(s);
      if (s.lease) noteLease(s.lease);
    },
    [noteLease],
  );

  const refresh = useCallback(async () => {
    setFound(undefined);
    try {
      const s = await api.status();
      noteStatus(s);
      setError(undefined);
      return s;
    } catch (e) {
      if (isUnavailable(e)) setUnavailable(true);
      else setError(errorText(e));
    }
  }, [api, noteStatus]);

  /** Lets go of the stream. A normal close: Hermes hands control the owner took back to the agent. */
  const detach = useCallback(() => {
    generation.current++;
    const client = rfb.current;
    rfb.current = null;
    try {
      client?.disconnect();
    } catch {
      // Already closed itself.
    }
  }, []);

  const attach = useCallback(async () => {
    detach();
    const gen = generation.current;
    setConn({ kind: "attaching" });
    try {
      const Rfb = await loadRfb();
      // A viewer id this connection minted before keeps the lease it holds across a re-attach.
      const observed = await api.observe(viewerRef.current?.id);
      const minted = { id: observed.viewer_id, hash: await viewerHash(observed.viewer_id) };
      if (gen !== generation.current) return;
      noteStatus(observed);
      setViewer(minted);
      const socket = await RelayedSocket.open(api.openSocket, observed.ticket);
      if (gen !== generation.current || !host.current) return socket.close();
      const client = new Rfb(host.current, socket, { shared: true });
      client.scaleViewport = true;
      client.resizeSession = false;
      client.focusOnClick = true;
      client.background = "transparent";
      client.qualityLevel = 7;
      client.viewOnly = !heldBy(observed.lease, minted.hash);
      client.addEventListener("connect", () => {
        if (gen !== generation.current) return;
        setConn({ kind: "live" });
        setEvicted(false);
      });
      client.addEventListener("disconnect", (e) => {
        if (rfb.current === client) rfb.current = null;
        if (gen !== generation.current) return;
        const code = socket.closeCode;
        if (code === CLOSE_CONTROL_TAKEN) {
          // Someone else took over: watch again on a fresh ticket, unless it keeps happening straight away.
          const now = Date.now();
          evictions.current = { count: now - evictions.current.at < EVICTION_WINDOW_MS ? evictions.current.count + 1 : 1, at: now };
          if (evictions.current.count > MAX_EVICTIONS) setConn({ kind: "lost", why: "Someone else keeps taking over this screen." });
          else {
            setEvicted(true);
            setConn({ kind: "idle" });
          }
        } else if (code === CLOSE_SCREEN_GONE) {
          setConn({ kind: "idle" });
        } else {
          setConn({ kind: "lost", why: code === 1000 && e.detail?.clean ? "The stream ended." : "The stream from the server was lost." });
        }
        void refresh();
      });
      rfb.current = client;
    } catch (e) {
      if (gen === generation.current) setConn({ kind: "lost", why: errorText(e) });
    }
  }, [api, detach, loadRfb, noteStatus, refresh]);

  // What the screen is doing: asked on first show and after each reconnect to Hermes, which watches again a stream
  // the drop ended. The stream isn't let go here: a normal close would tell Hermes the owner left, and hand control
  // they hold back to the agent mid-sign-in. Rust drops it with the connection, which Hermes reads as a dropped link.
  useEffect(() => {
    if (connected) {
      setConn((c) => (c.kind === "lost" ? { kind: "idle" } : c));
      void refresh();
    }
    // A viewer id is good only on the connection that minted it.
    else setViewer(undefined);
  }, [connected, refresh]);

  useEffect(() => api.onLease((key, l) => key === status?.profile_key && noteLease(l)), [api, status?.profile_key, noteLease]);

  // A running screen is watched as soon as it can be.
  useEffect(() => {
    if (connected && status?.running && conn.kind === "idle") void attach();
  }, [connected, status?.running, conn.kind, attach]);

  // Only the lease's holder sends keys and pointer; Hermes's bridge drops anyone else's anyway.
  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.viewOnly = !held;
    if (held) rfb.current.focus();
  }, [held, conn.kind]);

  useEffect(() => () => detach(), [detach]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      noteStatus(await api.start());
      setConn({ kind: "idle" });
    });
  const checkAgain = () =>
    act(async () => {
      const s = await refresh();
      const b = s && browserOf(s);
      setFound(b?.kind === "found" ? b.path : undefined);
    });
  const takeOver = () => act(async () => viewer && noteLease(await api.takeOver(viewer.id)));
  const handBack = () => act(async () => viewer && noteLease(await api.handBack(viewer.id)));

  const phase = status && phaseOf(status);
  const heldBefore = lease?.holder === "human" && !held && !!lease.viewer_hash && pastHolds.current.has(lease.viewer_hash);
  const someoneElse = lease?.holder === "human" && !held && !heldBefore;

  let body;
  if (unavailable)
    body = <Note title="This Hermes has no screen">The Bot Desktop came with Hermes in September 2026. Update Hermes on the server to use it.</Note>;
  else if (!status)
    body = error ? (
      <Note title="Couldn't ask Hermes about its screen" bad>
        {error}
      </Note>
    ) : (
      <div className="preview-state" role="status">
        <Spinner /> {connected ? "Asking Hermes about its screen…" : "Waiting for the connection…"}
      </div>
    );
  else if (phase?.kind === "unsupported") body = <Note title="This server can't run a screen">Hermes runs its Bot Desktop only on a Linux server.</Note>;
  else if (phase?.kind === "not-installed")
    body = (
      <Note title="The screen isn't installed on the server">
        Hermes needs {phase.missing.length ? <span className="mono">{phase.missing.join(", ")}</span> : "a few desktop packages"} for it.
        {phase.command && (
          <>
            {" "}
            Run this on the server, in the Terminal tab for one, then refresh:
            <CopyCommand command={phase.command} />
          </>
        )}
      </Note>
    );
  else if (phase?.kind === "blocked") body = <Note title="The screen can't start now">{phase.why}</Note>;
  else if (phase?.kind === "stopped")
    body = (
      <div className="screen-start">
        <MonitorPlay size={28} aria-hidden />
        <p>
          Hermes's own screen on the server{status.geometry ? ` (${status.geometry})` : ""}, where its computer use and its browser run. Start it to watch
          the agent work, and take over when it needs you for a sign-in or a CAPTCHA.
        </p>
        <p className="muted small">The agent drives it with the Computer use toolset (Settings → Toolsets). Hermes stops a screen nobody has used for a while.</p>
        <button className="btn primary" disabled={busy || !connected} onClick={() => void start()}>
          {busy ? <Spinner /> : <Play size={14} />} Start the screen
        </button>
      </div>
    );

  const live = phase?.kind === "live";
  const noBrowser = !unavailable && status && browserOf(status).kind === "missing";
  return (
    <div className="screen-tab" hidden={!shown}>
      <div className="screen-bar">
        <span className={`screen-who ${held || heldBefore ? "you" : someoneElse ? "other" : ""}`} role="status">
          {!live
            ? "Bot Desktop"
            : held
              ? "You're in control. Hermes's computer use waits until you hand back."
              : heldBefore
                ? "You still have control from before the connection dropped, so Hermes's computer use is waiting. Take over to carry on here, then hand back."
                : someoneElse
                  ? "Someone else has taken over this screen."
                  : "Watching: Hermes is in control."}
        </span>
        <span className="terminal-spacer" />
        {live &&
          (held ? (
            <button className="btn primary" disabled={busy || !connected} onClick={() => void handBack()} title="Gives the screen back to Hermes">
              <Hand size={14} /> Hand back
            </button>
          ) : (
            <button className="btn" disabled={busy || !connected || !viewer || conn.kind !== "live"} onClick={() => void takeOver()} title="Your keys and pointer drive the screen; Hermes's computer use waits">
              <MousePointer2 size={14} /> Take over
            </button>
          ))}
        <button className="icon-btn" title="Ask Hermes again" aria-label="Refresh the screen" disabled={!connected} onClick={() => void refresh()}>
          <RefreshCw size={15} />
        </button>
      </div>
      {error && status && (
        <div className="attach-note" role="alert">
          {error}
        </div>
      )}
      {found && (
        <div className="attach-note screen-found" role="status">
          Hermes found a browser on the server: <span className="mono">{found}</span>
        </div>
      )}
      {noBrowser && (
        <Note title="No Chrome or Chromium on the Hermes server" className="screen-browser">
          So the agent can't open a browser on its screen. Run this on the server, in the Terminal tab for one, then check again:
          <CopyCommand command={BROWSER_FIX} />
          <div className="small">Or set browser.executable_path in this profile's config to a Chrome or Chromium on the server.</div>
          <div className="preview-state-actions">
            <button className="btn" disabled={busy || !connected} onClick={() => void checkAgain()}>
              {busy ? <Spinner /> : <RefreshCw size={14} />} Check again
            </button>
          </div>
        </Note>
      )}
      {evicted && conn.kind !== "live" && (
        <div className="attach-note" role="status">
          Someone else took over, so you're watching again.
        </div>
      )}
      {body}
      <div className={`screen-view ${held ? "held" : ""}`} hidden={!live} role="region" aria-label="Hermes's screen">
        <div className="screen-canvas" ref={host} />
        {live && conn.kind !== "live" && (
          <div className="preview-state preview-loading" role={conn.kind === "lost" ? "alert" : "status"}>
            {conn.kind === "lost" ? (
              <>
                <AlertTriangle size={18} />
                <div>
                  <div className="preview-state-title">Not showing the screen</div>
                  <div>{conn.why}</div>
                  <div className="preview-state-actions">
                    <button className="btn" disabled={!connected} onClick={() => void attach()}>
                      <RefreshCw size={14} /> Reconnect
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Spinner /> Connecting to the screen…
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Note({ title, bad, className = "", children }: { title: string; bad?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={`preview-state ${bad ? "preview-error" : ""} ${className}`} role={bad ? "alert" : "note"}>
      <AlertTriangle size={18} />
      <div>
        <div className="preview-state-title">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}
