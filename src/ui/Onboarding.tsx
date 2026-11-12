// Setup: connecting Hermes Chat to a Hermes server, step by step (ADR 0009). It opens by itself on a computer with no
// connection set up, from the sign-in screen to set up a different server, and from Settings to change the connection
// or give Hermes a model provider's key. Nothing is kept until a tested connection is saved.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Check, CircleAlert, Globe, KeyRound, Minus, Plus, ShieldAlert, ShieldCheck, Terminal, X } from "lucide-react";
import type { ExtraHeader, Methods, SignInDetails } from "../hermes/tauriPipe";
import type { Kept } from "../hermes/account";
import type { Hermes } from "../hermes/transport";
import { STAGES, missing, savedKeyText, stageLabel, testConnection, testRoutes, withoutKey, type Probe, type ProviderKey, type ProviderSetup, type RouteTest, type TestOutcome } from "../hermes/setup";
import { routeLabel } from "./bits";
import { NAME_MAX, defaultName, routesSummary } from "../hermes/connections";
import { RouteTests, RoutesEditor, finishRoutes, routesReady, type Reach } from "./Routes";
import { routesOf } from "../hermes/routes";
import { isPicked, methodsNote, offered, withMethod } from "../hermes/signInMethods";
import { MethodPicker, TokenField } from "./SignInMethods";
import { errorText } from "../hermes/values";

/**
 * `first-run`: nothing is set up on this computer, so there is nowhere to cancel to; Cancel starts over.
 * `sign-in`: opened from the sign-in screen, to add a connection. `reconfigure`: opened from Settings while signed in,
 * to change the connection in use or add a provider key; the connection in use carries on until the change is tested
 * and saved. `add`: adds another saved connection. `edit`: changes a saved connection (ADR 0112). Both start at the
 * Server step.
 */
export type SetupMode = "first-run" | "sign-in" | "reconfigure" | "add" | "edit";

type Step = "welcome" | "server" | "account" | "providers";
const NUMBERED: Step[] = ["server", "account", "providers"];
const STEP_LABEL: Record<Step, string> = { welcome: "Welcome", server: "Server", account: "Sign in", providers: "Model providers" };

/** A connection test. With several routes, `routes` holds each one's part, filled in as they finish. */
type Test = { state: "idle" } | { state: "testing"; routes?: RouteTest[] } | { state: "done"; outcome: TestOutcome; routes?: RouteTest[] };

export function Onboarding({
  mode,
  initial,
  initialName = "",
  probe,
  reach,
  hermes,
  onConnect,
  onCancel,
  onDone,
  readMethods,
}: {
  mode: SetupMode;
  /** The sign-in to start from: the one saved, without its password. */
  initial: SignInDetails;
  /** The connection's name, when it has one already. Left empty, it is named after its host. */
  initialName?: string;
  probe: Probe;
  /** Reaches one route without signing in, for each route's Test (ADR 0120). Without it, routes have no Test. */
  reach?: Reach;
  /** The connection in use, once there is one: Settings' own, or the one setup just saved. */
  hermes?: Hermes;
  /**
   * Saves the tested sign-in and connects with it, in place of any connection in use. Rejects with why it couldn't.
   * `notSaved`: why the keyring couldn't keep the password or the extra request headers, when it couldn't, and `kept`
   * which of them it did keep. `signal` is Stop: it stops the sign-in while Hermes hasn't answered, and then this
   * rejects, with nothing saved and the connection in use before put back.
   */
  onConnect: (d: SignInDetails, name: string, signal: AbortSignal) => Promise<{ notSaved?: string; kept?: Kept }>;
  /** Leaves setup with nothing changed. Absent on first run. */
  onCancel?: () => void;
  /** Leaves setup once a connection is saved. */
  onDone: () => void;
  /** Reads which sign-in methods the server offers, for the Sign in step (ADR 0058). Without it, the password only. */
  readMethods?: (d: SignInDetails) => Promise<Methods>;
}) {
  const firstStep: Step = mode === "add" || mode === "edit" ? "server" : "welcome";
  const [step, setStep] = useState<Step>(firstStep);
  const [d, setD] = useState<SignInDetails>(initial);
  const [name, setName] = useState(initialName);
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  // Stops Save and connect while Hermes hasn't answered. `stopping`: Stop was pressed and the sign-in is winding down,
  // putting back the connection in use before, if there was one.
  const dialing = useRef<AbortController>(undefined);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  // The connection setup saved, which the providers step uses; Settings' own one when only adding a key.
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState<string>();
  // Each test gets the next number, and only the latest one's result counts; stopping one moves the number on, so a
  // late answer from a stopped test can't be taken for the next one's. `testing`: a test is under way in Rust.
  const run = useRef(0);
  const testing = useRef(false);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  // A test still running when setup closes is stopped, so its SSH tunnel goes too. Focus goes back to whatever opened
  // setup, such as Settings' Run setup again, if it is still there.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `run` is a counter, not a DOM node: the cleanup bumps its live value so a late answer for the stopped test is dropped
      run.current++;
      if (testing.current) probe.cancel();
      dialing.current?.abort();
      if (opener?.isConnected) opener.focus();
    };
  }, [probe]);
  // Each step announces itself by moving focus to its heading.
  useEffect(() => heading.current?.focus(), [step]);

  // The Sign in step offers what the server advertises, read each time the step opens, as the address may have changed.
  const [methods, setMethods] = useState<Methods>();
  useEffect(() => {
    if (step !== "account" || !readMethods) return;
    let live = true;
    setMethods(undefined);
    void readMethods(d).then((got) => {
      if (!live) return;
      setMethods(got);
      setD((was) => {
        const list = offered(got, was);
        return list.some((m) => isPicked(m, was)) ? was : withMethod(was, list[0]);
      });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, readMethods]);

  const stopTest = () => {
    run.current++;
    if (testing.current) probe.cancel();
    testing.current = false;
    setTest({ state: "idle" });
  };

  const set = (patch: Partial<SignInDetails>) => {
    setD((was) => ({ ...was, ...patch }));
    // A result is for the details it tested, and so is a test under way.
    if (test.state === "testing") stopTest();
    else if (test.state === "done") setTest({ state: "idle" });
    setConnectError(undefined);
    setStopped(false);
  };

  const startTest = async (over = d) => {
    if (missing(over).length || test.state === "testing") return;
    const mine = ++run.current;
    testing.current = true;
    setConnectError(undefined);
    const ready = withHeaders(over);
    if (!ready.routes) {
      setTest({ state: "testing" });
      const outcome = await testConnection(probe, ready);
      if (mine !== run.current) return;
      testing.current = false;
      return setTest(outcome.ok || outcome.stage !== "cancelled" ? { state: "done", outcome } : { state: "idle" });
    }
    // Each route in turn, the list filling in as they finish; from the start, every route waits its turn.
    setTest({ state: "testing", routes: routesOf(ready).filter((r) => !r.off && !r.locked).map((route) => ({ route })) });
    const routes = await testRoutes(probe, ready, (now) => mine === run.current && setTest({ state: "testing", routes: now }));
    if (mine !== run.current) return;
    testing.current = false;
    const outcomes = routes.map((t) => t.outcome).filter((o): o is TestOutcome => !!o);
    if (outcomes.some((o) => !o.ok && o.stage === "cancelled")) return setTest({ state: "idle" });
    const outcome = outcomes.find((o) => o.ok) ?? outcomes[0];
    setTest(outcome ? { state: "done", outcome, routes } : { state: "idle" });
  };

  /** The owner says the server the routes reach now is theirs (a reinstall): forget the one this connection knew. */
  const trust = () => {
    const next = { ...d, server: undefined };
    set({ server: undefined });
    if (step === "account") void startTest(next);
  };

  const connect = async () => {
    if (connecting) return;
    const stop = new AbortController();
    dialing.current = stop;
    setConnecting(true);
    setConnectError(undefined);
    setStopped(false);
    try {
      const { notSaved, kept } = await onConnect(withHeaders(d), name, stop.signal);
      setNotSaved(notSaved && `${notSaved.replace(/\.?$/, ".")} ${retypeLater(kept, d.method === "token" ? "token" : "password")}`);
      setSaved(true);
      setD((was) => ({ ...was, password: "", token: undefined }));
      setStep("providers");
    } catch (e) {
      // Stopped: the owner knows why; say what became of the connection, not a failure.
      if (stop.signal.aborted) setStopped(true);
      else setConnectError(errorText(e));
    } finally {
      if (dialing.current === stop) dialing.current = undefined;
      setConnecting(false);
      setStopping(false);
    }
  };

  /** Stop: stops Save and connect while Hermes hasn't answered. */
  const stopConnecting = () => {
    if (!dialing.current || stopping) return;
    setStopping(true);
    dialing.current.abort();
  };

  /** Cancel: leave without changes, or on first run start over, forgetting the password typed. */
  const cancel = () => {
    if (test.state === "testing") stopTest();
    if (onCancel) return onCancel();
    setD({ ...initial, password: "", token: undefined });
    setName(initialName);
    setTest({ state: "idle" });
    setConnectError(undefined);
    setStep(firstStep);
  };
  // Once a connection is saved there is nothing to cancel: leaving finishes setup.
  const canCancel = !connecting && !saved && (!!onCancel || step !== "welcome");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape while connecting stops it, as the Stop button does; it never leaves setup with a sign-in under way.
      if (connecting) {
        e.preventDefault();
        return stopConnecting();
      }
      if (!canCancel) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const n = NUMBERED.indexOf(step);
  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="setup-card">
        <div className="setup-top">
          <div className="rail-brand">H</div>
          {n >= 0 && (
            <ol className="setup-steps" aria-label="Setup steps">
              {NUMBERED.map((s, i) => (
                <li key={s} className={i < n ? "done" : i === n ? "on" : ""} aria-current={i === n ? "step" : undefined}>
                  {STEP_LABEL[s]}
                </li>
              ))}
            </ol>
          )}
          {canCancel && (
            <button className="icon-btn setup-close" aria-label={onCancel ? "Cancel setup" : "Cancel and start over"} title="Cancel" onClick={cancel}>
              <X size={16} />
            </button>
          )}
        </div>

        {step === "welcome" && (
          <Welcome
            titleId={titleId}
            heading={heading}
            mode={mode}
            canAddKey={!!hermes}
            onStart={() => setStep("server")}
            onAddKey={() => setStep("providers")}
            onCancel={onCancel}
          />
        )}

        {step === "server" && (
          <form
            className="setup-body conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (routesReady(d)) {
                setD((was) => finishRoutes(was));
                setStep("account");
              }
            }}
          >
            <h1 id={titleId} ref={heading} tabIndex={-1}>
              {mode === "edit" ? `Edit ${initialName || "the connection"}` : mode === "add" ? "Add a connection" : "Where is your Hermes server?"}
            </h1>
            <p className="muted">
              Hermes Chat talks to the Hermes dashboard running on your server.
              {(mode === "add" || mode === "edit") && hermes && " The connection in use carries on until this one is tested and saved."}
              {mode === "edit" && !hermes && " Nothing changes until the connection is tested and saved."}
            </p>
            <Field label="Name" hint="Shown in the connection list. Two connections can share a name; their addresses tell them apart.">
              {(a) => (
                <input {...a} value={name} maxLength={NAME_MAX} placeholder={defaultName(d)} spellCheck={false} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <RoutesEditor d={d} set={set} reach={reach} onTrust={trust} />
            <div className="setup-actions">
              <button type="button" className="btn" onClick={() => (firstStep === "server" ? cancel() : setStep("welcome"))}>
                {firstStep === "server" ? "Cancel" : "Back"}
              </button>
              <button type="submit" className="btn primary" disabled={!routesReady(d)}>
                Next
              </button>
            </div>
          </form>
        )}

        {step === "account" && (
          <form
            className="setup-body conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (test.state === "done" && test.outcome.ok) void connect();
              else void startTest();
            }}
          >
            <h1 id={titleId} ref={heading} tabIndex={-1}>
              Sign in to the dashboard
            </h1>
            <p className="muted">
              {d.routes ? (
                <>Over {routesSummary(d)}, tried in that order.</>
              ) : d.mode === "ssh" ? (
                <>
                  Through <span className="mono">ssh://{d.sshTarget.trim()}</span>.
                </>
              ) : (
                <>
                  At <span className="mono">{d.url.trim()}</span>.
                </>
              )}{" "}
              This is the Hermes dashboard's own login, not your SSH or computer password.
            </p>
            <MethodPicker
              list={offered(methods, d)}
              d={d}
              disabled={test.state === "testing" || connecting}
              onPick={(m) => {
                if (isPicked(m, d)) return;
                const next = withMethod(d, m);
                set({ method: next.method, provider: next.provider, token: next.token, savedToken: next.savedToken, password: next.password });
              }}
            />
            {methodsNote(methods, d, initial.method) && (
              <p className="field-hint block">
                {methodsNote(methods, d, initial.method)}
              </p>
            )}
            {d.method === "token" ? (
              <TokenField d={d} set={set} readOnly={test.state === "testing" || connecting} />
            ) : (
              <>
                <Field label="Dashboard username">
                  {(a) => (
                    <input
                      {...a}
                      value={d.username}
                      autoComplete="username"
                      spellCheck={false}
                      readOnly={test.state === "testing" || connecting}
                      onChange={(e) => set({ username: e.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Dashboard password"
                  hint={
                    <>
                      <KeyRound size={12} /> Saved in your system keyring once the connection works.
                    </>
                  }
                >
                  {(a) => (
                    <input
                      {...a}
                      type="password"
                      autoComplete="current-password"
                      value={d.password}
                      readOnly={test.state === "testing" || connecting}
                      onChange={(e) => set({ password: e.target.value })}
                    />
                  )}
                </Field>
              </>
            )}

            <div aria-live="polite">
              {test.state === "testing" && !test.routes && (
                <div className="setup-testing">
                  <span className="spinner" aria-hidden /> Testing the connection…
                </div>
              )}
              {test.state !== "idle" && test.routes && (
                <RouteTests tests={test.routes} canTrust={!!d.server && test.state === "done"} onTrust={trust} />
              )}
              {test.state === "done" && !test.routes && <TestResult outcome={test.outcome} mode={d.mode} />}
              {test.state === "done" && !test.routes && !test.outcome.ok && test.outcome.verdict === "wrong server" && d.server && /different Hermes/.test(test.outcome.problem) && (
                <p className="muted small">
                  If you reinstalled Hermes on your server,{" "}
                  <button type="button" className="link" onClick={trust}>
                    trust this server
                  </button>{" "}
                  and test again.
                </p>
              )}
              {stopping && (
                <div className="setup-testing">
                  <span className="spinner" aria-hidden /> Stopping…
                </div>
              )}
              {connectError && (
                <div className="sign-in-error" role="alert">
                  The test passed, but connecting failed: {connectError}
                </div>
              )}
              {stopped && (
                <p className="setup-warn" role="status">
                  <CircleAlert size={14} /> Connecting was stopped. Nothing was saved
                  {hermes ? ", and the connection you were using was put back." : "."}
                </p>
              )}
            </div>

            <div className="setup-actions">
              {connecting ? (
                <button type="button" className="btn" disabled={stopping} onClick={stopConnecting}>
                  Stop
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => (test.state === "testing" ? stopTest() : setStep("server"))}>
                  {test.state === "testing" ? "Stop test" : "Back"}
                </button>
              )}
              {test.state === "done" && test.outcome.ok ? (
                <>
                  <button type="button" className="btn" disabled={connecting} onClick={() => void startTest()}>
                    Test again
                  </button>
                  <button type="submit" className="btn primary" disabled={connecting}>
                    {connecting ? "Connecting…" : connectError ? "Try again" : "Save and connect"}
                  </button>
                </>
              ) : (
                <button type="submit" className="btn primary" disabled={!!missing(d).length || test.state === "testing"}>
                  {test.state === "done" ? "Try again" : "Test connection"}
                </button>
              )}
            </div>
          </form>
        )}

        {step === "providers" && hermes && (
          <ProviderKeys
            titleId={titleId}
            heading={heading}
            hermes={hermes}
            notSaved={notSaved}
            afterConnecting={saved}
            onDone={saved ? onDone : (onCancel ?? onDone)}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({
  titleId,
  heading,
  mode,
  canAddKey,
  onStart,
  onAddKey,
  onCancel,
}: {
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  mode: SetupMode;
  canAddKey: boolean;
  onStart: () => void;
  onAddKey: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="setup-body">
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        {mode === "first-run" ? "Welcome to Hermes Chat" : "Set up Hermes Chat"}
      </h1>
      <p className="muted">
        Hermes Chat is a desktop app for your own Hermes Agent server. {mode === "reconfigure" ? "You can change the connection in use, or give Hermes a model provider's API key." : "Let's connect it."}
      </p>
      <div className="setup-need">
        <div className="setup-need-title">You'll need</div>
        <ul>
          <li>
            <Terminal size={13} /> An SSH login to the server that works without a prompt,
            <br />
            <Globe size={13} /> <em>or</em> the dashboard's URL, such as <span className="mono">http://hermes:9119</span>
          </li>
          <li>
            <KeyRound size={13} /> The Hermes dashboard's username and password
          </li>
        </ul>
        <p className="muted small">Hermes Chat tests the connection before it saves anything.</p>
      </div>
      <div className="setup-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        {canAddKey && mode === "reconfigure" && (
          <button className="btn" onClick={onAddKey}>
            Add a provider key
          </button>
        )}
        <button className="btn primary" onClick={onStart}>
          {mode === "reconfigure" ? "Change connection" : "Get started"}
        </button>
      </div>
    </div>
  );
}

/** The SSH or URL choice and its field, shared with the sign-in screen. */
/** What the owner types again because the keyring couldn't keep it. */
function retypeLater(kept: Kept = { password: false, headers: true }, what: "password" | "token" = "password"): string {
  if (!kept.password && !kept.headers) return `You'll type the ${what} and the extra request headers again at the next launch.`;
  if (!kept.headers) return "You'll type the extra request headers again at the next sign-in.";
  return `You'll type the ${what} again at the next launch.`;
}

/**
 * The owner's extra request headers without the rows left blank; Rust checks the rest (ADR 0104). With routes, each
 * route's, its address completed too (`finishRoutes`).
 */
export const withHeaders = (d: SignInDetails): SignInDetails =>
  d.routes ? finishRoutes(d) : d.mode === "url" ? { ...d, headers: (d.headers ?? []).filter((h) => h.name.trim() || h.value.trim()) } : d;

/** Where the dashboard is: an SSH target, or a URL with any extra request headers. Shared with the sign-in screen. */
export function ServerFields({ d, set }: { d: SignInDetails; set: (patch: Partial<SignInDetails>) => void }) {
  const headers = d.headers ?? [];
  const setHeader = (i: number, patch: Partial<ExtraHeader>) => set({ headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  // Header values filled in from the keyring belong to the URL they were saved for (account.ts). Once the URL is
  // changed, they are cleared, names kept, so a gateway's secrets never go to another server.
  const [restoredFor, setRestoredFor] = useState(() => (d.headers?.some((h) => h.value) ? d.url.trim() : undefined));
  const [cleared, setCleared] = useState(false);
  const setUrl = (url: string) => {
    if (restoredFor === undefined || url.trim() === restoredFor) return set({ url });
    set({ url, headers: headers.map((h) => ({ ...h, value: "" })) });
    setRestoredFor(undefined);
    setCleared(true);
  };
  return (
    <>
      <div className="seg" role="group" aria-label="Connect through">
        <button type="button" className={d.mode === "ssh" ? "on" : ""} aria-pressed={d.mode === "ssh"} onClick={() => set({ mode: "ssh" })}>
          SSH
        </button>
        <button type="button" className={d.mode === "url" ? "on" : ""} aria-pressed={d.mode === "url"} onClick={() => set({ mode: "url" })}>
          URL
        </button>
      </div>
      {d.mode === "ssh" ? (
        <Field
          key="ssh"
          label="SSH target"
          block
          hint={
            <>
              <Terminal size={12} /> A user and host, or an alias from <code>~/.ssh/config</code>. Uses your ssh-agent; the key must work without
              a prompt. Hermes Chat reaches the dashboard on the server's port 9119.
            </>
          }
        >
          {(a) => <input {...a} value={d.sshTarget} onChange={(e) => set({ sshTarget: e.target.value })} placeholder="liam@hermes" spellCheck={false} />}
        </Field>
      ) : (
        <>
          <Field
            key="url"
            label="Dashboard URL"
            block
            hint={
              <>
                <Globe size={12} /> <code>http://</code> isn't encrypted unless it stays on this computer or on Tailscale.
              </>
            }
          >
            {(a) => <input {...a} value={d.url} onChange={(e) => setUrl(e.target.value)} placeholder="http://hermes:9119" spellCheck={false} />}
          </Field>
          <fieldset className="field extra-headers">
            <legend className="field-label">Extra request headers</legend>
            {headers.map((h, i) => (
              <div className="header-row" key={i}>
                <input
                  aria-label={`Header ${i + 1} name`}
                  placeholder="CF-Access-Client-Id"
                  spellCheck={false}
                  autoComplete="off"
                  value={h.name}
                  onChange={(e) => setHeader(i, { name: e.target.value })}
                />
                <input
                  aria-label={`Header ${i + 1} value`}
                  type="password"
                  placeholder="Value"
                  autoComplete="off"
                  value={h.value}
                  onChange={(e) => setHeader(i, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove header ${i + 1}`}
                  title="Remove"
                  onClick={() => set({ headers: headers.filter((_, j) => j !== i) })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn add-header" onClick={() => set({ headers: [...headers, { name: "", value: "" }] })}>
              <Plus size={14} /> Add header
            </button>
            {cleared && headers.length > 0 && (
              <span className="field-hint block" role="status">
                The URL changed, so the saved header values were cleared. Enter them for this URL.
              </span>
            )}
            <span className="field-hint block">
              <ShieldCheck size={12} /> For a gateway in front of the dashboard, such as Cloudflare Access. Sent with every request to this URL, never
              to another site. Saved in your system keyring.
            </span>
          </fieldset>
        </>
      )}
    </>
  );
}

/** A labelled control with its hint. The hint describes the control rather than naming it. */
function Field({
  label,
  hint,
  block = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  block?: boolean;
  children: (a: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-describedby": hint ? `${id}-hint` : undefined })}
      {hint && (
        <span id={`${id}-hint`} className={`field-hint${block ? " block" : ""}`}>
          {hint}
        </span>
      )}
    </div>
  );
}

function TestResult({ outcome, mode }: { outcome: TestOutcome; mode: SignInDetails["mode"] }) {
  const failedAt = outcome.ok ? STAGES.length : STAGES.indexOf(outcome.stage as (typeof STAGES)[number]);
  return (
    <div className={`setup-result ${outcome.ok ? "ok" : "bad"}`} role={outcome.ok ? "status" : "alert"}>
      <ul className="setup-checks">
        {STAGES.map((s, i) => {
          const state = i < failedAt ? "ok" : i === failedAt ? "bad" : "skip";
          return (
            <li key={s} className={state}>
              {state === "ok" ? <Check size={13} aria-label="Passed" /> : state === "bad" ? <X size={13} aria-label="Failed" /> : <Minus size={13} aria-label="Not tried" />}
              {stageLabel(s, mode)}
            </li>
          );
        })}
      </ul>
      {outcome.ok ? (
        <>
          <p className="setup-verdict">
            <Check size={14} /> Connected to Hermes{outcome.version ? ` ${outcome.version}` : ""} at <span className="mono">{routeLabel(outcome.route)}</span>.
          </p>
          {outcome.unsecure && (
            <p className="setup-warn">
              <ShieldAlert size={14} /> <span className="badge warn">Unsecure</span> Traffic to this server isn't encrypted, so the password and your
              chats can be read on the way. Connect over SSH, Tailscale or <code>https://</code> to fix that.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="setup-verdict">
            <CircleAlert size={14} /> {outcome.problem}
          </p>
          {outcome.fixes.length > 0 && (
            <ul className="setup-fixes">
              {outcome.fixes.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {outcome.detail && <p className="setup-detail mono">{outcome.detail}</p>}
        </>
      )}
    </div>
  );
}

/**
 * The providers step: which providers Hermes can use now, and a key for another, saved on the server.
 * `afterConnecting`: setup has just saved a connection, so leaving is Skip (nothing given) or Finish (a key saved);
 * otherwise it was opened only to add a key, and leaving is Done.
 */
function ProviderKeys({
  titleId,
  heading,
  hermes,
  notSaved,
  afterConnecting,
  onDone,
}: {
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  hermes: Hermes;
  /** Why the keyring couldn't keep what setup just saved, and what to type again because of it. */
  notSaved?: string;
  afterConnecting: boolean;
  onDone: () => void;
}) {
  const [setup, setSetup] = useState<ProviderSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [keySaved, setKeySaved] = useState(false);
  // The connection and profile the step reads and writes for. `scopes` moves on when either changes, and `reads` with
  // each read of the provider list. A list or its error counts only for the latest read in the same scope; a save's
  // answer counts while the scope is the same, however many reads came between. So a late answer after the
  // connection was put back or the profile changed is dropped, and a key typed for one never goes to the other.
  const scopes = useRef(0);
  const reads = useRef(0);
  const profile = useSyncExternalStore(hermes.subscribe, () => hermes.profile);
  const live = (scope: number) => scope === scopes.current;

  const load = () => {
    const scope = scopes.current;
    const read = ++reads.current;
    return hermes.providerSetup().then(
      (s) => {
        if (!live(scope) || read !== reads.current) return;
        setSetup(s);
        setLoadError(undefined);
        setChosen((c) => (c && s.keys.some((k) => k.provider === c) ? c : (s.keys.find((k) => !k.isSet) ?? s.keys[0])?.provider));
      },
      (e) => live(scope) && read === reads.current && setLoadError(errorText(e)),
    );
  };
  useEffect(() => {
    // Another connection or profile: what was read, typed or saved for the one before doesn't apply.
    scopes.current++;
    setSetup(undefined);
    setLoadError(undefined);
    setResult(undefined);
    setChosen(undefined);
    setKey("");
    setKeySaved(false);
    setSaving(false);
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset and read again only when the connection or profile changes; `load` is new every render, so listing it would read again on every render
  }, [hermes, profile]);

  const pick: ProviderKey | undefined = setup?.keys.find((k) => k.provider === chosen);
  const save = async () => {
    if (!pick || !key.trim() || saving) return;
    const scope = scopes.current;
    setSaving(true);
    setResult(undefined);
    try {
      // `saveProviderKey` writes for the profile Hermes shows; one that changed since this step read means another scope.
      if (hermes.profile !== profile) return;
      const r = await hermes.saveProviderKey(pick.envVar, key);
      if (!live(scope)) return;
      setKey("");
      setKeySaved(true);
      setResult({
        ok: true,
        text: savedKeyText(r, pick.label),
      });
    } catch (e) {
      if (live(scope)) setResult({ ok: false, text: `Not saved: ${withoutKey(errorText(e), key)}` });
      return;
    } finally {
      if (live(scope)) setSaving(false);
    }
    // Read again to show the key as saved; Finish doesn't wait for it.
    void load();
  };
  // "Skip for now" only once Hermes has said it can use no provider yet; while it is being asked, plain Skip.
  const doneLabel = !afterConnecting ? "Done" : keySaved ? "Finish" : setup && !setup.ready.length ? "Skip for now" : "Skip";

  let body: ReactNode;
  if (loadError)
    body = (
      <div className="sign-in-error" role="alert">
        Couldn't read the providers from Hermes: {loadError}{" "}
        <button type="button" className="link" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  else if (!setup)
    body = (
      <div className="setup-testing">
        <span className="spinner" aria-hidden /> Asking Hermes…
      </div>
    );
  else
    body = (
      <>
        <p className={setup.ready.length ? "setup-ok" : "setup-warn"}>
          {setup.ready.length ? <Check size={14} /> : <CircleAlert size={14} />}{" "}
          {setup.ready.length
            ? `Hermes can already use ${setup.ready.join(", ")}. You're ready to chat; a key for another provider is optional.`
            : "Hermes doesn't list a model provider it can use yet. Add a key to start chatting."}
        </p>
        {setup.unsupported || !setup.keys.length ? (
          <p className="muted small">
            This Hermes server doesn't let Hermes Chat set provider keys{setup.unsupported ? ` (${setup.unsupported})` : ""}. Set them on the server
            instead, for example on the dashboard's Keys page.
          </p>
        ) : (
          <>
            <Field label="Provider">
              {(a) => (
                <select
                  {...a}
                  value={chosen ?? ""}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setResult(undefined);
                  }}
                >
                  {setup.keys.map((k) => (
                    <option key={k.provider} value={k.provider}>
                      {k.label}
                      {k.isSet ? " (key saved)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="API key"
              block
              hint={
                <>
                  <KeyRound size={12} /> Checked with the provider, then saved by Hermes in the <span className="mono">{hermes.profile}</span> profile's{" "}
                  <code>.env</code> on the server. Hermes Chat doesn't keep it.
                  {pick?.isSet && pick.preview ? (
                    <>
                      {" "}
                      Saved now: <code>{pick.preview}</code>.
                    </>
                  ) : null}
                  {pick?.url ? (
                    <>
                      {" "}
                      Get a key at <span className="mono">{pick.url}</span>.
                    </>
                  ) : null}
                </>
              }
            >
              {(a) => (
                <input
                  {...a}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setResult(undefined);
                  }}
                  placeholder={pick?.isSet ? "Paste a new key to replace the saved one" : "Paste the key"}
                />
              )}
            </Field>
            {result && (
              <div className={result.ok ? "setup-ok" : "sign-in-error"} role={result.ok ? "status" : "alert"}>
                {result.text}
              </div>
            )}
            <p className="muted small">Providers you sign in to with an account, such as Nous Portal, are set up on the server.</p>
          </>
        )}
      </>
    );

  return (
    <form
      className="setup-body conn-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        Model providers
      </h1>
      <p className="muted">
        Hermes needs an API key for at least one model provider to answer.
        {afterConnecting && !keySaved && " This step is optional: skip it if the server already has one."}
      </p>
      {notSaved && (
        <p className="setup-warn" role="status">
          <CircleAlert size={14} /> Connected. {notSaved}
        </p>
      )}
      {body}
      <div className="setup-actions">
        {setup && !setup.unsupported && setup.keys.length > 0 && (
          <button type="submit" className="btn" disabled={!pick || !key.trim() || saving}>
            {saving ? "Checking…" : "Check and save key"}
          </button>
        )}
        <button type="button" className="btn primary" disabled={saving} onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </form>
  );
}
