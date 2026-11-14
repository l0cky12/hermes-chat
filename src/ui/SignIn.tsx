// Sign-in over SSH (ADR 0003) or straight to a dashboard URL, built from the prototype's first-run screen and its
// connection form. With more than one saved connection (ADR 0112) the recent-connection picker beside the form picks
// which one the form is for; nothing is picked on its own, so with none picked the form waits for the owner. The
// form offers the sign-in methods the server advertises (ADR 0058); with one, it looks as it always did.
import { useEffect, useRef, useState } from "react";
import { CircleAlert, KeyRound, PlugZap, Trash2 } from "lucide-react";
import type { Methods, SignInDetails } from "../hermes/tauriPipe";
import { type SavedConnection, addressLabel } from "../hermes/connections";
import { explainSignIn, signInErrorText, type SignInError } from "../hermes/setup";
import { RoutesFailedError } from "../hermes/routes";
import { isPicked, methodsNote, offered, withMethod } from "../hermes/signInMethods";
import { ServerFields, withHeaders } from "./Onboarding";
import { RouteSummary } from "./Routes";
import { routesSummary } from "../hermes/connections";
import { ConnectionPicker } from "./Connections";
import type { LiveSummary } from "../hermes/liveConnections";
import { MethodPicker, TokenField } from "./SignInMethods";

export function SignIn({
  initial,
  error,
  connection,
  connections = [],
  live = [],
  onSignIn,
  onSetUp,
  onRerunSetup,
  onPick,
  onRemove,
  readMethods,
}: {
  /** The saved sign-in; the password is filled in when launch couldn't sign in with it. */
  initial: SignInDetails;
  error?: SignInError;
  /** The saved connection the form is for; none when the owner hasn't picked one. */
  connection?: SavedConnection;
  /** Every saved connection, most recently used first, for the picker. */
  connections?: SavedConnection[];
  /** The live connections (ADR 0125): picking one makes it the one in use, without signing in again. */
  live?: LiveSummary[];
  onSignIn: (d: SignInDetails) => Promise<void>;
  /** Opens setup, to test and save a new connection step by step. */
  onSetUp?: () => void;
  /** Runs setup again for the connection the form is for, starting from what is saved for it. */
  onRerunSetup?: (c: SavedConnection) => void;
  /** The owner picked another saved connection in the picker. */
  onPick?: (c: SavedConnection) => void;
  /** Asks to remove the connection the form is for. */
  onRemove?: (c: SavedConnection) => void;
  /** Reads which sign-in methods the server offers (signInMethods.ts `readMethods`). Without it, the password only. */
  readMethods?: (d: SignInDetails) => Promise<Methods>;
}) {
  const [d, setD] = useState<SignInDetails>(initial);
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState<Methods>();
  // Read for the address the form holds: at once when it opens, and again a moment after the address is edited. An
  // answer for an address the form has moved on from is dropped.
  const address = JSON.stringify([d.mode, d.sshTarget.trim(), d.url.trim(), d.mode === "url" ? (d.headers ?? []) : []]);
  const firstRead = useRef(true);
  useEffect(() => {
    if (!connection || !readMethods) return;
    let live = true;
    const first = firstRead.current;
    firstRead.current = false;
    if (!first) setMethods(undefined);
    const timer = setTimeout(
      () =>
        void readMethods(d).then((got) => {
          if (!live) return;
          setMethods(got);
          // The method this connection used, if the server still offers it; otherwise the first it does.
          setD((was) => {
            const list = offered(got, was);
            return list.some((m) => isPicked(m, was)) ? was : withMethod(was, list[0]);
          });
        }),
      first ? 0 : 700,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
  // A password filled in from the keyring is for the address it was saved with. Once the address changes it is
  // cleared, as the header values are (ServerFields), so it never goes to another server. A saved token is Rust's,
  // which refuses it for another address anyway; the form stops counting on it.
  const [restored, setRestored] = useState(!!initial.password);
  const [cleared, setCleared] = useState(false);
  const set = (patch: Partial<SignInDetails>) => {
    const next = { ...d, ...patch };
    const moved = next.mode !== initial.mode || next.sshTarget.trim() !== initial.sshTarget.trim() || next.url.trim() !== initial.url.trim() || next.username.trim() !== initial.username.trim();
    if (restored && moved && patch.password === undefined) {
      next.password = "";
      setRestored(false);
      setCleared(true);
    }
    if (moved && next.savedToken !== undefined) delete next.savedToken;
    setD(next);
  };
  // A connection with several routes shows them, to be changed in setup; one with a single route, its address here.
  const routed = !!d.routes;
  const token = d.method === "token";
  const list = offered(methods, d);
  const note = methodsNote(methods, d, connection?.method);
  // Typing the password unlocks the routes it wasn't saved for (account.ts `savedSignIn`).
  const ready =
    (routed || (d.mode === "ssh" ? d.sshTarget : d.url).trim()) && (token ? !!d.token?.trim() || d.savedToken !== undefined : d.username.trim() && d.password);
  const why = error ? explainSignIn(error, d) : undefined;
  const picker = connections.length > 1 || (!connection && connections.length > 0);
  return (
    <div className="first-run">
      <div className={`first-run-card ${picker ? "with-picker" : ""}`}>
        <div className="rail-brand big">H</div>
        <h1>{connection ? `Connect to ${connection.name}` : "Connect to Hermes"}</h1>
        <p className="muted">
          {connection ? (
            <>
              {routed ? (
                <>Sign in to the dashboard over {routesSummary(connection)}.</>
              ) : (
                <>
                  Sign in to the dashboard at <span className="mono">{addressLabel(connection)}</span>.
                </>
              )}
            </>
          ) : (
            "Pick a saved connection, or set up a new one."
          )}
        </p>
        {picker && onPick && <ConnectionPicker connections={connections} live={live} selectedId={connection?.id} onPick={onPick} disabled={busy} />}
        {connection && (
          <form
            className="conn-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!ready || busy) return;
              setBusy(true);
              try {
                await onSignIn(withHeaders(routed ? { ...d, routes: d.routes!.map(({ locked: _locked, ...r }) => r) } : d));
              } finally {
                setBusy(false);
              }
            }}
          >
            {routed ? <RouteSummary d={d} /> : <ServerFields d={d} set={set} />}
            <MethodPicker list={list} d={d} disabled={busy} onPick={(m) => setD((was) => withMethod(was, m))} />
            {note && (
              <p className="field-hint block">
                {note}
              </p>
            )}
            {token ? (
              <TokenField d={d} set={set} autoFocus />
            ) : (
              <>
                <label className="field">
                  <span className="field-label">Dashboard username</span>
                  <input spellCheck={false} value={d.username} onChange={(e) => set({ username: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Dashboard password</span>
                  <input type="password" autoFocus value={d.password} onChange={(e) => set({ password: e.target.value })} />
                  <span className="field-hint block">
                    <KeyRound size={12} />{" "}
                    {`${
                      routed
                        ? "Sent only over a route that reaches this connection's Hermes server."
                        : d.mode === "ssh"
                          ? "Sent to the server through the SSH tunnel."
                          : "Sent to the dashboard at this URL."
                    } Saved in your system keyring, for this connection only.`}
                  </span>
                  {cleared && (
                    <span className="field-hint block" role="status">
                      The address changed, so the saved password was cleared. Type the password for this address.
                    </span>
                  )}
                </label>
              </>
            )}
            {why && (
              <div className="sign-in-error" role="alert">
                <div>
                  <CircleAlert size={12} /> {why.problem}
                </div>
                {/* Every route's failure is listed below already (routes.ts `RoutesFailedError`). */}
                {error && signInErrorText(error) !== why.problem && !(error instanceof RoutesFailedError) && <div className="small sign-in-raw">{signInErrorText(error)}</div>}
                {why.fixes.length > 0 && (
                  <ul className="sign-in-fixes">
                    {why.fixes.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={!ready || busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            {onRerunSetup && (
              <button type="button" className="link setup-link" disabled={busy} onClick={() => onRerunSetup(connection)}>
                <PlugZap size={12} /> Run setup again…
              </button>
            )}
            {onRemove && (
              <button type="button" className="link setup-link" disabled={busy} onClick={() => onRemove(connection)}>
                <Trash2 size={12} /> Remove this connection…
              </button>
            )}
          </form>
        )}
        {onSetUp && (
          <button type="button" className="link setup-link" disabled={busy} onClick={onSetUp}>
            {connections.length ? "Set up a new connection…" : "Set up a different server…"}
          </button>
        )}
      </div>
    </div>
  );
}
