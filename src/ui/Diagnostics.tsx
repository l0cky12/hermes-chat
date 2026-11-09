// Connection diagnostics (Settings → Diagnostics), and the note a screen shows in place of itself when the connected
// Hermes lacks what it needs (`CapabilityGate`). Both read the one capability store the transport keeps
// (src/hermes/capabilities.ts, ADR 0044).
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ArrowLeft, BookOpen, Check, ClipboardCopy, RefreshCw, Stethoscope } from "lucide-react";
import {
  CAPABILITIES,
  type CapabilityId,
  type CapabilitySnapshot,
  type CapabilityState,
  type CapabilityStore,
  authLine,
  guideUrl,
  protocolText,
  reportText,
  sourceText,
  specOf,
  stateText,
  versionLine,
} from "../hermes/capabilities";
import { BROWSER_FIX, browserOf, isUnavailable, type ScreenApi, type ServerBrowser } from "../hermes/screen";
import { CopyCommand, Spinner, ago, storedTime } from "./bits";
import { useLocale } from "../i18n/locale";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

/** Opens a compatibility guide page in the owner's browser. */
export type OpenGuide = (url: string) => void;

export const useCapabilities = (store: CapabilityStore): CapabilitySnapshot => useSyncExternalStore(store.subscribe, store.getSnapshot);

const BADGE: Record<CapabilityState, string> = { supported: "cap-ok", unsupported: "cap-no", unknown: "cap-unknown", unreachable: "cap-unknown" };

function StateBadge({ state }: { state: CapabilityState }) {
  return <span className={`badge cap-badge ${BADGE[state]}`}>{stateText(state)}</span>;
}

/** "Checked 2 min ago", with the exact time on hover. */
function Checked({ at, prefix = "Checked" }: { at?: number; prefix?: string }) {
  const l = useLocale();
  // Re-renders each minute so the relative time stays right.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (at === undefined) return <span>Not checked yet</span>;
  const since = ago(l, at);
  return (
    <time dateTime={new Date(at).toISOString()} title={storedTime(at)}>
      {prefix ? `${prefix} ${since}` : since}
    </time>
  );
}

/** The line above the feature list: checking, never checked, couldn't check, or when it was checked. */
function CheckStatus({ snap, connected }: { snap: CapabilitySnapshot; connected: boolean }) {
  if (snap.checking)
    return (
      <>
        <Spinner /> Checking what this Hermes server supports…
      </>
    );
  if (snap.checkedAt === undefined) return <>{connected ? "Checks start a moment after the connection opens." : "Connect to Hermes to check what it supports."}</>;
  if (!connected)
    return (
      <>
        Not connected: as last checked. <Checked at={snap.checkedAt} />.
      </>
    );
  return (
    <>
      <Checked at={snap.checkedAt} />. Checked again on each reconnect, and whenever Hermes reports another build.
    </>
  );
}

/**
 * Settings → Diagnostics: what the connected Hermes says it is, how this app signs in, and each capability's state with
 * how it was learnt and when. Check again reads it all afresh; Copy report puts a report with nothing secret on the
 * clipboard.
 */
export function DiagnosticsSettings({
  store,
  connected,
  server,
  signIn,
  headers,
  unsecure,
  profile,
  openGuide,
  focus,
  screen,
  copyText = (text) => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))),
}: {
  store: CapabilityStore;
  connected: boolean;
  /** The connection's address, as the rest of Settings shows it. */
  server?: string;
  /** How this app signs in, in words. */
  signIn: string;
  /** How many extra request headers the connection sends; their values never reach this screen. */
  headers: number;
  unsecure: boolean;
  profile: string;
  openGuide: OpenGuide;
  /** A capability to bring into view and focus, from a screen's note. */
  focus?: { id: CapabilityId };
  /** Puts text on the clipboard. */
  copyText?: (text: string) => Promise<void>;
  /** `display.status` for the profile in use, which says whether its Bot Desktop has a browser. */
  screen?: Pick<ScreenApi, "status">;
}) {
  const snap = useCapabilities(store);
  const [copied, setCopied] = useState<"done" | "failed">();
  const f = snap.facts;
  const focused = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!focus) return;
    focused.current?.scrollIntoView?.({ block: "center" });
    focused.current?.focus();
  }, [focus]);
  // "Copied" stays only until the next change, so it never describes an older report.
  useEffect(() => setCopied(undefined), [snap]);

  const copy = () => {
    const text = reportText(snap, { app: "Hermes Chat", server, signIn, headers, unsecure, profile });
    copyText(text).then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };
  const probed = CAPABILITIES.filter((c) => c.probe);
  // Every check failed to get an answer, and the version couldn't be read: the server, not a feature, is the problem.
  const failed = !snap.checking && snap.checkedAt !== undefined && !!f.versionWhy && probed.every((c) => snap.caps[c.id].state === "unreachable");

  return (
    <div className="diagnostics">
      <SettingsSection
        title="Server"
        titleId="diag-server"
        intro="What the Hermes server says about itself."
        more={<p>A version alone doesn't show what it can do, so each feature below is checked on its own.</p>}
      >
        <Fact name="Server">
          <span className="mono">{server ?? "Not connected"}</span> {unsecure && <span className="badge warn">Unsecure</span>}
        </Fact>
        <Fact name="Profile">
          <span className="mono">{profile}</span>
        </Fact>
        <Fact name="Hermes version">
          <span className={f.version || f.build ? "mono" : "muted"}>{versionLine(f)}</span>
          {f.commit && (
            <span className="muted">
              {" "}
              · commit <span className="mono">{f.commit.slice(0, 10)}</span>
            </span>
          )}
          {f.releaseDate && <span className="muted"> · released {f.releaseDate}</span>}
        </Fact>
        <Fact name="Protocol">{protocolText(f.protocol)}</Fact>
        <Fact name="Sign-in">{authLine(f, signIn)}</Fact>
        <Fact name="Feature flags">
          {f.flags ? (
            f.flags.length ? (
              <span className="mono">{f.flags.join(", ")}</span>
            ) : (
              "None turned on"
            )
          ) : (
            <span className="muted">{f.flagsWhy ?? "Not read yet"}</span>
          )}
        </Fact>
        <Fact name="Extra request headers">{headers ? `${headers}, whose values are never shown` : "None"}</Fact>
      </SettingsSection>

      {screen && <BotDesktopSection screen={screen} connected={connected} profile={profile} />}

      <SettingsSection
        title="Features"
        titleId="diag-features"
        intro={
          <>
            <span role="status" aria-live="polite">
              <CheckStatus snap={snap} connected={connected} />
            </span>
            <span className="sr-only" aria-live="polite">
              {copied === "done" ? "Report copied, with secrets taken out." : ""}
            </span>
          </>
        }
        more={
          <p>
            Checks only read: nothing is changed on the server to find out. Results are kept in memory for this sign-in, never on disk. The report holds no
            password, cookie, ticket or header value.
          </p>
        }
        action={
          <>
            <button className="btn" disabled={!connected || snap.checking} onClick={() => void store.refresh()}>
              <RefreshCw size={14} aria-hidden /> Check again
            </button>
            <button className="btn" onClick={copy}>
              {copied === "done" ? <Check size={14} aria-hidden /> : <ClipboardCopy size={14} aria-hidden />} {copied === "done" ? "Copied" : "Copy report"}
            </button>
          </>
        }
      >
        {copied === "failed" && (
          <SettingNote tone="warn" role="alert">
            <AlertTriangle size={14} aria-hidden /> Couldn't put the report on the clipboard.
          </SettingNote>
        )}
        {failed && (
          <SettingNote tone="warn" role="alert">
            <AlertTriangle size={14} aria-hidden /> Hermes didn't answer any check. {f.versionWhy} Each feature shows why below; Check again once the connection is steady.
          </SettingNote>
        )}
        <div className="set-block">
          <table className="diag-table">
            <caption className="sr-only">What this Hermes server supports, feature by feature</caption>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">State</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((spec) => {
                const cap = snap.caps[spec.id];
                const here = focus?.id === spec.id;
                return (
                  <tr key={spec.id} id={`capability-${spec.id}`} ref={here ? focused : undefined} tabIndex={here ? -1 : undefined} className={here ? "diag-focus" : undefined}>
                    <th scope="row">
                      <div>{spec.label}</div>
                      <div className="muted small">{spec.usedBy}</div>
                    </th>
                    <td>
                      <StateBadge state={cap.state} />
                      <div className="muted small">
                        {sourceText(cap.source)}
                        {cap.checkedAt !== undefined && (
                          <>
                            {", "}
                            <Checked at={cap.checkedAt} prefix="" />
                          </>
                        )}
                      </div>
                    </td>
                    <td className="small">
                      {cap.why && <div>{cap.why}</div>}
                      {cap.state !== "supported" && (
                        <div className="muted">
                          Needs: {spec.needs} Without it: {spec.without}{" "}
                          <button className="link-btn" onClick={() => openGuide(guideUrl(spec.id))} aria-label={`Compatibility guide: ${spec.label}`}>
                            Compatibility guide
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <SettingRow
          name="Compatibility guide"
          hint="What each feature needs from Hermes, and what the app does without it."
          control={
            <button className="btn" onClick={() => openGuide(guideUrl())}>
              <BookOpen size={14} aria-hidden /> Read the compatibility guide
            </button>
          }
        />
      </SettingsSection>
    </div>
  );
}

type BrowserCheck = { kind: "checking" } | { kind: "read"; browser: ServerBrowser } | { kind: "failed"; why: string };

const UNKNOWN_WHY: Record<Extract<ServerBrowser, { kind: "unknown" }>["why"], string> = {
  "older-hermes": "This Hermes doesn't report it. Updating Hermes on the server adds it.",
  "not-linux": "Hermes checks it only on a Linux server, where its Bot Desktop runs.",
  "in-sandbox": "This profile's Bot Desktop runs in the terminal's sandbox, which brings its own browser.",
};

/**
 * Whether the profile's Bot Desktop has Chrome or Chromium, read from `display.status` for the profile in use: asked
 * when the connection opens or the profile changes, and on Check again. An answer for an earlier profile is dropped.
 */
function BotDesktopSection({ screen, connected, profile }: { screen: Pick<ScreenApi, "status">; connected: boolean; profile: string }) {
  const [check, setCheck] = useState<BrowserCheck>();
  const asked = useRef(0);
  const read = useCallback(async () => {
    const ask = ++asked.current;
    setCheck({ kind: "checking" });
    let next: BrowserCheck;
    try {
      next = { kind: "read", browser: browserOf(await screen.status()) };
    } catch (e) {
      next = isUnavailable(e) ? { kind: "read", browser: { kind: "unknown", why: "older-hermes" } } : { kind: "failed", why: e instanceof Error ? e.message : String(e) };
    }
    if (ask === asked.current) setCheck(next);
  }, [screen]);
  useEffect(() => {
    if (connected) void read();
    else {
      asked.current++;
      setCheck((c) => (c?.kind === "checking" ? undefined : c));
    }
  }, [connected, profile, read]);

  const b = check?.kind === "read" ? check.browser : undefined;
  let value: ReactNode;
  if (!check) value = <span className="muted">{connected ? "Not checked yet" : "Connect to Hermes to check."}</span>;
  else if (check.kind === "checking")
    value = (
      <>
        <Spinner /> Checking…
      </>
    );
  else if (check.kind === "failed") value = <span className="muted">Couldn't check: {check.why}</span>;
  else if (b?.kind === "found") value = <span className="mono">{b.path}</span>;
  else if (b?.kind === "missing") value = <span className="badge cap-badge cap-no">Not installed</span>;
  else value = <span className="badge cap-badge cap-unknown">Unknown</span>;
  const note =
    b?.kind === "missing" ? (
      <SettingNote tone="warn">
        <div>
          No Chrome or Chromium on the Hermes server, so the agent can't open a browser on its screen. Run this on the server, then check again:
          <CopyCommand command={BROWSER_FIX} />
          <div className="muted small">Or set browser.executable_path in this profile's config to a Chrome or Chromium on the server.</div>
        </div>
      </SettingNote>
    ) : b?.kind === "unknown" ? (
      <SettingNote>{UNKNOWN_WHY[b.why]}</SettingNote>
    ) : undefined;

  return (
    <SettingsSection
      title="Bot Desktop"
      titleId="diag-bot-desktop"
      intro={`What profile ${profile}'s screen on the server has, where the agent's computer use and its browser run.`}
      action={
        <button className="btn" aria-label="Check the server's browser again" disabled={!connected || check?.kind === "checking"} onClick={() => void read()}>
          <RefreshCw size={14} aria-hidden /> Check again
        </button>
      }
    >
      <SettingRow className="diag-fact" name="Browser on the Hermes server" control={<span className="set-value" role="status">{value}</span>}>
        {note}
      </SettingRow>
    </SettingsSection>
  );
}

/** One thing the server or this connection is: its name, and its value where a setting's control would be. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return <SettingRow className="diag-fact" name={name} control={<span className="set-value">{children}</span>} />;
}

/**
 * Shows `children` unless the connected Hermes is known to lack capability `id`. Then a note says what is missing and
 * what Hermes needs, and links to diagnostics and the guide, in place of the screen, so it reads and writes nothing.
 * While the capability is supported, unknown or couldn't be checked, the screen shows and finds out for itself.
 * A screen already open when Hermes turns out to lack its feature stays, with the note above it, so an unsaved edit in
 * it isn't lost; the transport refuses its writes (capabilities.ts). `title` and `onClose` frame the note as a screen
 * of its own, for the rail's screens.
 */
export function CapabilityGate({
  store,
  id,
  openGuide,
  onDiagnostics,
  title,
  onClose,
  children,
}: {
  store: CapabilityStore;
  id: CapabilityId;
  openGuide: OpenGuide;
  /** Opens Settings → Diagnostics at this capability; left out where diagnostics can't be reached. */
  onDiagnostics?: (id: CapabilityId) => void;
  title?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const snap = useCapabilities(store);
  const cap = snap.caps[id];
  const missing = cap.state === "unsupported";
  // Whether the screen was shown when this gate opened: then it stays, whatever is learnt later.
  const [screenOpen] = useState(!missing);
  // The note's slot comes first either way, so the screen keeps its place, and its state, when the note appears.
  if (!missing)
    return (
      <>
        {null}
        {children}
      </>
    );
  const spec = specOf(id);
  const headingId = `capability-missing-${id}`;
  const note = (
    <section className="capability-missing" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <Stethoscope size={15} aria-hidden /> This Hermes server doesn't support {spec.label}
      </h2>
      <p>
        {spec.label} needs {spec.needs.replace(/^The /, "the ").replace(/\.$/, "")}. {cap.why}
      </p>
      <p className="muted">
        {spec.without} Updating Hermes on the server adds it. <Checked at={cap.checkedAt} />
        {snap.stale && " (not connected now: as last checked)"}.
      </p>
      <div className="capability-missing-actions">
        {onDiagnostics && (
          <button className="btn" onClick={() => onDiagnostics(id)}>
            <Stethoscope size={14} aria-hidden /> Connection diagnostics
          </button>
        )}
        <button className="btn" onClick={() => openGuide(guideUrl(id))} aria-label={`Compatibility guide: ${spec.label}`}>
          <BookOpen size={14} aria-hidden /> Compatibility guide
        </button>
      </div>
    </section>
  );
  if (screenOpen)
    return (
      <>
        {note}
        {children}
      </>
    );
  if (!onClose) return note;
  return (
    <div className="settings">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back to chat
        </button>
        <h1>{title ?? spec.label}</h1>
        {note}
      </div>
    </div>
  );
}
