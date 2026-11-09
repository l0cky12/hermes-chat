// A connection's routes on screen (ADR 0120): Setup's list to add, remove, reorder, turn off and test them, and the
// read-only list the sign-in screen shows. Each route is a LAN, Tailscale or web address, or an SSH target; the first
// that works is used, in this order.
import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, CircleAlert, Globe, Minus, Plus, ShieldCheck, Terminal, X } from "lucide-react";
import {
  KIND_LABEL,
  ROUTES_MAX,
  ROUTE_KINDS,
  newRouteId,
  normalizeTarget,
  routeProblem,
  routeTargetLabel,
  routesOf,
  withRoutes,
  type RouteDetails,
  type RouteKind,
} from "../hermes/routes";
import { testReach, type ReachOutcome, type RouteTest } from "../hermes/setup";
import type { ExtraHeader, Reached, SignInDetails } from "../hermes/tauriPipe";

/** Reaches one route without signing in (`tauriReach`); rejects with a `ProbeFailure`. */
export type Reach = (d: SignInDetails, expect: string | undefined) => Promise<Reached>;

const PLACEHOLDER: Record<RouteKind, string> = {
  lan: "192.168.1.10:9119",
  tailscale: "hermes.tail1234.ts.net:9119",
  web: "https://hermes.example.com",
  ssh: "liam@hermes",
};

const HINT: Record<RouteKind, string> = {
  lan: "An IP address or host name on your network, and the port. Plain http:// stays on the LAN.",
  tailscale: "A MagicDNS name or 100.x address, and the port. Tailscale encrypts it, and needs Tailscale running here.",
  web: "An https:// address, such as one behind Cloudflare Access. Plain http:// isn't used over the internet.",
  ssh: "A user and host, or an alias from ~/.ssh/config. Uses your ssh-agent; the dashboard is on the server's port 9119.",
};

export const kindIcon = (kind: RouteKind, size = 13) =>
  kind === "ssh" ? <Terminal size={size} aria-hidden /> : kind === "web" ? <Globe size={size} aria-hidden /> : <ShieldCheck size={size} aria-hidden />;

/** The field's label for a route: as before routes, with one; numbered, with more. */
function targetLabel(r: RouteDetails, n: number, many: boolean) {
  const what = r.kind === "ssh" ? "SSH target" : "Dashboard URL";
  return many ? `Route ${n}: ${what}` : what;
}

/**
 * The owner's routes as the editor leaves them for testing and saving: each address with its scheme and port, header
 * rows left blank dropped, and a connection with one route that its address alone says (an SSH target, or an
 * address whose kind its host gives) kept without a list or a server id, as connections were before routes.
 */
export function finishRoutes(d: SignInDetails): SignInDetails {
  // The owner types the password in setup, so it is for every route: none stays locked (account.ts `savedSignIn`).
  const routes = routesOf(d).map(({ locked: _locked, ...r }) => ({
    ...r,
    target: normalizeTarget(r.kind, r.target),
    ...(r.kind !== "ssh" && { headers: (r.headers ?? []).filter((h) => h.name.trim() || h.value.trim()) }),
  }));
  const done = withRoutes(d, routes);
  const [only] = routes;
  if (routes.length === 1 && !only.off && routesOf({ ...done, routes: undefined })[0].kind === only.kind) {
    // Nor is it held to one server: that is for a connection with several routes (ADR 0120).
    const { routes: _r, server: _s, ...single } = done;
    return single;
  }
  return done;
}

/** Whether every route that is on has an address it can use, and at least one is on. */
export const routesReady = (d: SignInDetails) => {
  const on = routesOf(d).filter((r) => !r.off);
  return on.length > 0 && on.every((r) => !routeProblem(r));
};

type Tested = { state: "testing" } | { state: "done"; outcome: ReachOutcome };

/**
 * Setup's Routes list: each route's kind and address, with Test (reaches it without the password), up and down, Use
 * (on or off) and Remove, and its extra request headers when it is a web address. `set` gets the sign-in with its new
 * routes. Header values filled in from the keyring belong to the route's address as it was; once that changes, they
 * are cleared, names kept, so a gateway's secrets never go to another server.
 */
export function RoutesEditor({
  d,
  set,
  reach,
  onTrust,
}: {
  d: SignInDetails;
  set: (patch: Partial<SignInDetails>) => void;
  reach?: Reach;
  /** The owner said the server a route reached is theirs now (a reinstall): the connection forgets the one it knew. */
  onTrust?: () => void;
}) {
  const routes = routesOf(d);
  const many = routes.length > 1;
  // The address each route's restored header values were saved for.
  const restored = useRef(new Map(routes.filter((r) => r.headers?.some((h) => h.value)).map((r) => [r.id, r.target.trim()])));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [tests, setTests] = useState<Record<string, Tested>>({});
  // What each route held for the other mode, so switching between SSH and an address and back keeps both, as the two
  // fields before routes did. Seeded with the connection's own other field.
  const stash = useRef(new Map<string, string>(routes[0] ? [[`${routes[0].id}:${routes[0].kind === "ssh" ? "url" : "ssh"}`, routes[0].kind === "ssh" ? d.url : d.sshTarget]] : []));
  const runs = useRef(new Map<string, number>());

  const put = (next: RouteDetails[]) => set(withRoutes(d, next));
  const forget = (id: string) => {
    runs.current.set(id, (runs.current.get(id) ?? 0) + 1);
    setTests(({ [id]: _, ...rest }) => rest);
  };
  const change = (id: string, patch: Partial<RouteDetails>) => {
    forget(id);
    put(
      routes.map((r) => {
        if (r.id !== id) return r;
        let next = { ...r, ...patch };
        const from = r.kind === "ssh" ? "ssh" : "url";
        const to = next.kind === "ssh" ? "ssh" : "url";
        if (from !== to && patch.target === undefined) {
          stash.current.set(`${id}:${from}`, r.target);
          next = { ...next, target: stash.current.get(`${id}:${to}`) ?? "" };
        }
        const was = restored.current.get(id);
        if (was !== undefined && (next.target.trim() !== was || next.kind !== r.kind)) {
          restored.current.delete(id);
          setCleared((c) => new Set(c).add(id));
          return { ...next, headers: (next.headers ?? []).map((h) => ({ ...h, value: "" })) };
        }
        return next;
      }),
    );
  };
  const move = (i: number, by: number) => {
    const next = [...routes];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    put(next);
  };
  const test = async (r: RouteDetails) => {
    if (!reach) return;
    const n = (runs.current.get(r.id) ?? 0) + 1;
    runs.current.set(r.id, n);
    setTests((t) => ({ ...t, [r.id]: { state: "testing" } }));
    const route = { ...r, target: normalizeTarget(r.kind, r.target) };
    const outcome = await testReach(reach, d, route);
    if (runs.current.get(r.id) === n) setTests((t) => ({ ...t, [r.id]: { state: "done", outcome } }));
  };

  return (
    <fieldset className="routes">
      <legend className="field-label">Routes</legend>
      <span className="field-hint block">
        {many
          ? "Tried in this order. The first that reaches Hermes and signs in is used; if it drops, the next takes over."
          : "How Hermes Chat reaches the server. Add another route, such as Tailscale or SSH, for when this one can't."}
      </span>
      <ol className="route-list">
        {routes.map((r, i) => (
          <RouteRow
            key={r.id}
            r={r}
            n={i + 1}
            many={many}
            first={i === 0}
            last={i === routes.length - 1}
            onlyOn={!r.off && routes.filter((x) => !x.off).length === 1}
            tested={tests[r.id]}
            cleared={cleared.has(r.id)}
            canTest={!!reach}
            canTrust={!!d.server && !!onTrust}
            onChange={(patch) => change(r.id, patch)}
            onMove={(by) => move(i, by)}
            onRemove={() => {
              forget(r.id);
              put(routes.filter((x) => x.id !== r.id));
            }}
            onTest={() => void test(r)}
            onTrust={() => {
              setTests({});
              onTrust?.();
            }}
          />
        ))}
      </ol>
      {routes.length < ROUTES_MAX && (
        <button
          type="button"
          className="btn add-header"
          onClick={() => put([...routes, { id: newRouteId(), kind: routes.some((r) => r.kind === "tailscale") ? "ssh" : "tailscale", target: "" }])}
        >
          <Plus size={14} /> Add a route
        </button>
      )}
    </fieldset>
  );
}

function RouteRow({
  r,
  n,
  many,
  first,
  last,
  onlyOn,
  tested,
  cleared,
  canTest,
  canTrust,
  onChange,
  onMove,
  onRemove,
  onTest,
  onTrust,
}: {
  r: RouteDetails;
  n: number;
  many: boolean;
  first: boolean;
  last: boolean;
  /** The only route that is on: it can't be turned off. */
  onlyOn: boolean;
  tested?: Tested;
  cleared: boolean;
  canTest: boolean;
  canTrust: boolean;
  onChange: (patch: Partial<RouteDetails>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onTest: () => void;
  onTrust: () => void;
}) {
  const id = useId();
  const name = many ? `route ${n}` : "the route";
  const problem = r.target.trim() ? routeProblem(r) : undefined;
  const headers = r.headers ?? [];
  const setHeader = (i: number, patch: Partial<ExtraHeader>) => onChange({ headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  return (
    <li className={`route-row ${r.off ? "off" : ""}`}>
      <div className="route-head">
        {many && (
          <span className="route-n" aria-hidden>
            {n}
          </span>
        )}
        <label className="sr-only" htmlFor={`${id}-kind`}>
          {many ? `Route ${n} kind` : "Connect through"}
        </label>
        <select id={`${id}-kind`} className="route-kind" value={r.kind} onChange={(e) => onChange({ kind: e.target.value as RouteKind })}>
          {ROUTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <span className="route-tools">
          {many && (
            <>
              <button type="button" className="icon-btn small" aria-label={`Move route ${n} up`} title="Try earlier" disabled={first} onClick={() => onMove(-1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="icon-btn small" aria-label={`Move route ${n} down`} title="Try later" disabled={last} onClick={() => onMove(1)}>
                <ArrowDown size={14} />
              </button>
              <label className="route-use" title={onlyOn ? "At least one route stays on" : r.off ? "Turned off: kept, but not tried" : "Tried when connecting"}>
                <input
                  type="checkbox"
                  aria-label={`Use route ${n}`}
                  checked={!r.off}
                  disabled={onlyOn}
                  onChange={(e) => onChange({ off: !e.target.checked || undefined })}
                />
                Use
              </label>
              <button type="button" className="icon-btn small" aria-label={`Remove route ${n}`} title="Remove" onClick={onRemove}>
                <X size={14} />
              </button>
            </>
          )}
        </span>
      </div>
      <div className="route-target">
        <label className={many ? "sr-only" : "field-label"} htmlFor={`${id}-target`}>
          {targetLabel(r, n, many)}
        </label>
        <input
          id={`${id}-target`}
          value={r.target}
          placeholder={PLACEHOLDER[r.kind]}
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          aria-invalid={!!problem}
          onChange={(e) => onChange({ target: e.target.value })}
          onBlur={() => r.target.trim() && r.target !== normalizeTarget(r.kind, r.target) && onChange({ target: normalizeTarget(r.kind, r.target) })}
        />
        {canTest && (
          <button type="button" className="btn" disabled={!r.target.trim() || !!problem || tested?.state === "testing"} onClick={onTest} aria-label={`Test ${name}`}>
            {tested?.state === "testing" ? "Testing…" : "Test"}
          </button>
        )}
      </div>
      <span id={`${id}-hint`} className={`field-hint block ${problem ? "err" : ""}`}>
        {problem ?? HINT[r.kind]}
      </span>
      {tested?.state === "done" && <ReachResult outcome={tested.outcome} canTrust={canTrust} onTrust={onTrust} />}
      {r.kind !== "ssh" && (
        <details className="route-headers" open={headers.length > 0}>
          <summary className="field-hint">Extra request headers{headers.length ? ` (${headers.length})` : ""}</summary>
          <fieldset className="field extra-headers">
            <legend className="sr-only">Extra request headers{many ? ` for route ${n}` : ""}</legend>
            {headers.map((h, i) => (
              <div className="header-row" key={i}>
                <input
                  aria-label={`Header ${i + 1} name${many ? `, route ${n}` : ""}`}
                  placeholder="CF-Access-Client-Id"
                  spellCheck={false}
                  autoComplete="off"
                  value={h.name}
                  onChange={(e) => setHeader(i, { name: e.target.value })}
                />
                <input
                  aria-label={`Header ${i + 1} value${many ? `, route ${n}` : ""}`}
                  type="password"
                  placeholder="Value"
                  autoComplete="off"
                  value={h.value}
                  onChange={(e) => setHeader(i, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove header ${i + 1}${many ? `, route ${n}` : ""}`}
                  title="Remove"
                  onClick={() => onChange({ headers: headers.filter((_, j) => j !== i) })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn add-header" onClick={() => onChange({ headers: [...headers, { name: "", value: "" }] })}>
              <Plus size={14} /> Add header
            </button>
            {cleared && headers.length > 0 && (
              <span className="field-hint block" role="status">
                The address changed, so the saved header values were cleared. Enter them for this address.
              </span>
            )}
            <span className="field-hint block">
              For a gateway in front of the dashboard, such as Cloudflare Access. Sent with every request to this address, never to another site.
              Saved in your system keyring.
            </span>
          </fieldset>
        </details>
      )}
    </li>
  );
}

/** A route's Test, without the password: reached and which Hermes, or how it failed. */
function ReachResult({ outcome, canTrust, onTrust }: { outcome: ReachOutcome; canTrust: boolean; onTrust: () => void }) {
  if (outcome.ok)
    return (
      <p className="route-result ok" role="status">
        <Check size={13} /> Reached Hermes{outcome.version ? ` ${outcome.version}` : ""}.{outcome.unsecure && " Its traffic isn't encrypted (Unsecure)."}
      </p>
    );
  return (
    <div className="route-result bad" role="alert">
      <p>
        <CircleAlert size={13} /> <strong className="route-verdict">{capital(outcome.verdict)}.</strong> {outcome.problem}
      </p>
      {outcome.fixes.length > 0 && (
        <ul className="setup-fixes">
          {outcome.fixes.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {outcome.detail && <p className="setup-detail mono">{outcome.detail}</p>}
      {outcome.verdict === "wrong server" && canTrust && /different Hermes/.test(outcome.problem) && (
        <button type="button" className="btn" onClick={onTrust}>
          Trust this server
        </button>
      )}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Each route's part of a connection test: how it went, or that it is waiting its turn. */
export function RouteTests({ tests, canTrust, onTrust }: { tests: RouteTest[]; canTrust: boolean; onTrust: () => void }) {
  const ok = tests.some((t) => t.outcome?.ok);
  const done = tests.every((t) => t.outcome);
  return (
    <div className={`setup-result ${!done ? "" : ok ? "ok" : "bad"}`} role={ok || !done ? "status" : "alert"}>
      <ul className="setup-checks route-checks">
        {tests.map(({ route, outcome }, i) => (
          <li key={route.id} className={!outcome ? "skip" : outcome.ok ? "ok" : "bad"}>
            {outcome ? (
              outcome.ok ? (
                <Check size={13} aria-label="Passed" />
              ) : (
                <X size={13} aria-label="Failed" />
              )
            ) : i === tests.findIndex((t) => !t.outcome) ? (
              <span className="spinner" aria-label="Testing" />
            ) : (
              <Minus size={13} aria-label="Waiting its turn" />
            )}
            <span>
              <strong>{KIND_LABEL[route.kind]}</strong> <span className="mono">{routeTargetLabel(route)}</span>
              {outcome && (
                <>
                  {" · "}
                  {outcome.ok ? `reached Hermes${outcome.version ? ` ${outcome.version}` : ""}${outcome.unsecure ? ", Unsecure" : ""}` : outcome.verdict}
                </>
              )}
              {outcome && !outcome.ok && <span className="route-why">{outcome.problem}</span>}
            </span>
          </li>
        ))}
      </ul>
      {done && (
        <p className="setup-verdict">
          {ok ? (
            <>
              <Check size={14} /> At least one route works. Connecting tries them in this order.
            </>
          ) : (
            <>
              <CircleAlert size={14} /> No route reached Hermes and signed in.
            </>
          )}
        </p>
      )}
      {canTrust && tests.some((t) => t.outcome && !t.outcome.ok && t.outcome.verdict === "wrong server" && /different Hermes/.test(t.outcome.problem)) && (
        <p className="muted small">
          A route reached a different Hermes server than this connection knew.{" "}
          <button type="button" className="link" onClick={onTrust}>
            Trust this server
          </button>{" "}
          if you reinstalled Hermes on it.
        </p>
      )}
    </div>
  );
}

/** The sign-in screen's view of a connection's routes: in order, the ones turned off marked. */
export function RouteSummary({ d }: { d: SignInDetails }) {
  return (
    <div className="field">
      <span className="field-label">Routes, tried in order</span>
      <ol className="route-summary">
        {routesOf(d).map((r) => (
          <li key={r.id} className={r.off || r.locked ? "off" : ""}>
            {kindIcon(r.kind)} <span>{KIND_LABEL[r.kind]}</span> <span className="mono">{routeTargetLabel(r)}</span>
            {r.off ? <span className="badge off">off</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
