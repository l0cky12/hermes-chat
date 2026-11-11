// Routes (ADR 0120): one saved connection is one Hermes server, reached by an ordered list of routes. Each route is a
// LAN address, a Tailscale address, a web address (https://, such as one behind Cloudflare Access) or an SSH target.
// Connecting tries the routes that are on, in order, and uses the first that reaches Hermes and signs in; a connection
// that drops comes back the same way, so it moves to the next route without losing the chat state. The username and
// password belong to the connection; extra request headers belong to the route that needs them.
//
// Before a password goes over a route, Rust reads the dashboard's public `/api/status` and checks that it is a Hermes
// dashboard, and the same install the connection signed in to before (`server`, a hash of Hermes's install id). A route
// that reaches anything else is "wrong server" and gets nothing.
import type { AttemptRecorder, AttemptTrace, Step } from "./attempts";
import type { Address } from "./connections";
import type { OpenPipe, Pipe, Route } from "./pipe";
import type { ExtraHeader, SignInDetails } from "./tauriPipe";
import { errorText } from "./values";

export type RouteKind = "lan" | "tailscale" | "web" | "ssh";
export const ROUTE_KINDS: readonly RouteKind[] = ["lan", "tailscale", "web", "ssh"];
export const KIND_LABEL: Record<RouteKind, string> = { lan: "LAN", tailscale: "Tailscale", web: "Web address", ssh: "SSH" };
/** The most routes one connection keeps. */
export const ROUTES_MAX = 8;
/** The port `hermes dashboard` listens on unless told otherwise. */
export const DASHBOARD_PORT = 9119;

/** A route as the connection list keeps it: nothing here is secret. `off`: kept, but not tried. */
export type SavedRoute = { id: string; kind: RouteKind; target: string; off?: boolean };

/**
 * A route with what signing in over it needs besides the password. `headers`: its extra request headers (web
 * addresses only, ADR 0104). `locked`: the password saved in the keyring wasn't saved for this route, so connecting
 * with that saved password skips it; typing the password again unlocks it.
 */
export type RouteDetails = SavedRoute & { headers?: ExtraHeader[]; locked?: boolean };

/** Which route a connection is using, of how many that are on. */
export type RouteVia = { id: string; kind: RouteKind; index: number; of: number };

const ROUTE_ID = /^[a-z0-9-]{1,40}$/;
export const isRouteId = (v: unknown): v is string => typeof v === "string" && ROUTE_ID.test(v);
export const newRouteId = () => globalThis.crypto.randomUUID().slice(0, 8);

export const routeMode = (r: Pick<SavedRoute, "kind">): Address["mode"] => (r.kind === "ssh" ? "ssh" : "url");

/** The address a route signs in at, as one SSH-or-URL address, with the connection's username. */
export const routeAddress = (r: SavedRoute, username: string): Address => ({
  mode: routeMode(r),
  sshTarget: r.kind === "ssh" ? r.target : "",
  url: r.kind === "ssh" ? "" : r.target,
  username,
});

/** What a saved password is bound to for one route: its mode and target as typed (trimmed). */
export const routeKey = (r: SavedRoute) => JSON.stringify([routeMode(r), r.target.trim()]);

/** A route's address as shown: `ssh://target`, or the URL. */
export const routeTargetLabel = (r: SavedRoute) => (r.kind === "ssh" ? `ssh://${r.target.trim()}` : r.target.trim());

/** "via Tailscale", for the connection status. */
export const viaLabel = (via: Pick<RouteVia, "kind"> | undefined) => (via ? `via ${KIND_LABEL[via.kind]}` : undefined);

// ── kinds and addresses ─────────────────────────────────────────────────────

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const o = m?.slice(1).map(Number);
  return o?.every((x) => x <= 255) ? o : undefined;
}

const hostOf = (url: string) => {
  try {
    return new URL(url.trim()).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  } catch {
    return undefined;
  }
};

/** A Tailscale address: a MagicDNS name (*.ts.net), 100.64.0.0/10, or fd7a:115c:a1e0::/48. */
export function isTailscaleHost(host: string): boolean {
  const v4 = ipv4(host);
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  return host.endsWith(".ts.net") || /^fd7a:115c:a1e0:/i.test(host);
}

/**
 * Whether a host is on this computer or a private network as written: loopback, a private or link-local IPv4 range, a
 * unique-local or link-local IPv6 address, `.local`, `.lan`, `.home.arpa`, or a bare name such as `hermes`. A name's
 * real addresses are Rust's to check (`check_plain_http`); this is for the editor's hint and the migration's guess.
 */
export function isLocalHost(host: string): boolean {
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(":")) return host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
  return host === "localhost" || !host.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

/** The kind a URL's host suggests, for a connection made before routes existed. */
export function kindOfUrl(url: string): RouteKind {
  const host = hostOf(url);
  if (host === undefined) return "web";
  if (isTailscaleHost(host)) return "tailscale";
  return isLocalHost(host) ? "lan" : "web";
}

/**
 * What the owner typed for a route, as the address it is used at. An SSH target is kept as typed. An address without
 * a scheme gets one, http:// on a LAN or Tailscale and https:// for a web address, and a LAN or Tailscale address
 * without a port gets the dashboard's, 9119: `192.168.1.10` is `http://192.168.1.10:9119`.
 */
export function normalizeTarget(kind: RouteKind, typed: string): string {
  const text = typed.trim();
  if (kind === "ssh" || !text) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const withScheme = `${kind === "web" ? "https" : "http"}://${text}`;
  if (kind === "web") return withScheme;
  const [, authority, rest] = /^([^/?#]*)(.*)$/s.exec(text)!;
  const hasPort = /^\[.*\]:\d+$/.test(authority) || /^[^[\]:]*:\d+$/.test(authority);
  return hasPort ? withScheme : `http://${authority}:${DASHBOARD_PORT}${rest}`;
}

/** Why a route can't be used as it is, in the owner's words; undefined when it can. */
export function routeProblem(r: SavedRoute): string | undefined {
  const t = r.target.trim();
  if (!t) return r.kind === "ssh" ? "Enter an SSH target." : "Enter an address.";
  if (r.kind === "ssh") return t.startsWith("-") || /\s/.test(t) ? "An SSH target is a user and host, or an alias, with no spaces." : undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(t)) return "An address can't hold a user name, password or token, since Hermes Chat saves and shows it. Take out the part before @.";
  let u: URL;
  try {
    u = new URL(normalizeTarget(r.kind, t));
  } catch {
    return "That isn't an address Hermes Chat can use.";
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return "Use an http:// or https:// address.";
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  const plain = u.protocol === "http:" || u.protocol === "ws:";
  if (r.kind === "tailscale" && !isTailscaleHost(host) && host.includes("."))
    return "A Tailscale address is a MagicDNS name (such as hermes or hermes.tail1234.ts.net) or a 100.x address.";
  if (plain && ipv4(host) && !isLocalHost(host) && !isTailscaleHost(host))
    return "Plain http:// is only used on a LAN or Tailscale. Use https:// for an address on the internet.";
  return undefined;
}

// ── routes of a sign-in ─────────────────────────────────────────────────────

/** The one route a connection made before routes existed has. */
export function routeFromAddress(a: Address & { headers?: ExtraHeader[] }, id = "main"): RouteDetails {
  if (a.mode === "ssh") return { id, kind: "ssh", target: a.sshTarget };
  return { id, kind: kindOfUrl(a.url), target: a.url, ...(a.headers?.length && { headers: a.headers }) };
}

/** A sign-in's routes, in order: its list, or the one route its address is. */
export const routesOf = (d: Address & { routes?: RouteDetails[]; headers?: ExtraHeader[] }): RouteDetails[] => d.routes ?? [routeFromAddress(d)];

/** A route as the connection list keeps it: without headers or the keyring's lock. */
export const savedRoute = ({ id, kind, target, off }: RouteDetails): SavedRoute => ({ id, kind, target, ...(off && { off }) });

/** `d` with `routes`, its SSH-or-URL address the first route's, for everything that names a connection by its address. */
export function withRoutes<T extends Address & { headers?: ExtraHeader[] }>(d: T, routes: RouteDetails[]): T & { routes: RouteDetails[] } {
  const first = routes[0];
  if (!first) return { ...d, routes };
  // Only the first route's own field changes: the other keeps what it had, as switching between SSH and URL always did.
  return first.kind === "ssh"
    ? { ...d, mode: "ssh", sshTarget: first.target, routes }
    : { ...d, mode: "url", url: first.target, headers: first.headers ?? [], routes };
}

/** The sign-in over one route alone, as Rust opens it. */
export function singleRoute(d: SignInDetails, r: RouteDetails): SignInDetails {
  const a = routeAddress(r, d.username);
  const { method, provider, token, savedToken } = d;
  return {
    ...a,
    password: d.password,
    headers: r.kind === "ssh" ? [] : (r.headers ?? []),
    ...(d.server && { server: d.server }),
    ...(method && { method }),
    ...(provider && { provider }),
    ...(token !== undefined && { token }),
    ...(savedToken !== undefined && { savedToken }),
  };
}

/** The connection's SSH target, for the Terminal, the Repository screen and server pages: its first SSH route's. */
export function sshRouteOf(routes: SavedRoute[]): string | undefined {
  return (routes.find((r) => r.kind === "ssh" && !r.off) ?? routes.find((r) => r.kind === "ssh"))?.target.trim() || undefined;
}

/**
 * What a connection says about reaching its server over ssh, for the Terminal and the Repository (terminal.ts): an SSH
 * route's target if it has one, else its first route's web address, whose host the Terminal then uses (ADR 0055).
 */
export function sshAddressOf(c: Address & { routes?: SavedRoute[] }): { mode: "ssh" | "url"; sshTarget: string; url?: string } {
  const routes = routesOf(c);
  const ssh = sshRouteOf(routes);
  if (ssh) return { mode: "ssh", sshTarget: ssh };
  return { mode: "url", sshTarget: "", url: routes[0]?.target ?? c.url };
}

// ── connecting ──────────────────────────────────────────────────────────────

/**
 * Opens one route. `expectServer`: the install the route must reach. `quick`: give up on a dead route sooner. `onStep`:
 * told as each step of opening it starts, `at` ms after it began (attempts.ts).
 */
export type OpenRoute = (d: SignInDetails, opts: { expectServer?: string; quick: boolean; sshRoute?: string; onStep?: (s: Step, at?: number) => void }) => OpenPipe;

export const NO_ROUTES = "Every route of this connection is turned off, or needs the password typed again. Edit the connection to turn one on, or sign in again.";
/** What Rust and transport say when connecting was stopped. */
const STOPPED = "Connecting was stopped.";
/** Failures that are the same over any route: Hermes turned the sign-in down, or the owner stopped it. */
const FINAL = /^(Wrong username or password\.|Wrong token:|The dashboard took the token as|This Hermes server doesn't take a token|Too many sign-in attempts|Connecting was stopped)/;

/**
 * How the Rust side's messages start when a token sign-in can't go through as it is (ADR 0058): the dashboard turned
 * the token down (`TransportError::BadToken`) or took it as another provider's (`NotSessionToken`), the server doesn't
 * take one (`TokenNotOffered`), the route's extra headers set Authorization (`AuthorizationHeaderSet`), or no token is
 * saved for the address. Trying again won't change them, so launch asks and a reconnect stops.
 */
export const TOKEN_REFUSED = /^(Wrong token:|The dashboard took the token as|This Hermes server doesn't take a token|Token sign-in sends the token|No token is saved)/;

/** Every route failed; `failures` says how each did, in the order tried. */
export class RoutesFailedError extends Error {
  constructor(readonly failures: { route: RouteDetails; message: string }[]) {
    super(`No route reached Hermes.\n${failures.map((f) => `• ${KIND_LABEL[f.route.kind]}, ${routeTargetLabel(f.route)}: ${f.message}`).join("\n")}`);
  }
}

/**
 * How each route did lately. A route that failed in the last `coolMs` is tried after the ones that haven't, so
 * reconnecting after a drop doesn't wait on a route known to be down every time; it is still tried, last. A success, or
 * a preferred route answering again (`PreferredRoutes`), clears it. With `kept`, it starts from the failure times the
 * connection kept, and keeps each change, so the next launch tries a route that just failed last too (#269).
 */
/** Each route's last failure time, by route id, as the connection keeps it, and how to keep a change. */
export type KeptHealth = { failedAt?: Record<string, number>; save: (failedAt: Record<string, number>) => void };

export class RouteHealth {
  private failedAt = new Map<string, number>();
  constructor(
    private now: () => number = Date.now,
    readonly coolMs = 120_000,
    private kept?: KeptHealth,
  ) {
    for (const [id, at] of Object.entries(kept?.failedAt ?? {})) this.failedAt.set(id, at);
  }
  failed(id: string) {
    this.failedAt.set(id, this.now());
    this.keep();
  }
  ok(id: string) {
    if (this.failedAt.delete(id)) this.keep();
  }
  private keep() {
    this.kept?.save(Object.fromEntries(this.failedAt));
  }
  /** Whether `id` failed within the cool-down. */
  down(id: string): boolean {
    const at = this.failedAt.get(id);
    return at !== undefined && this.now() - at < this.coolMs;
  }
  /** `routes` in order, the ones down lately moved to the end, each group in the owner's order. */
  order<R extends { id: string }>(routes: R[]): R[] {
    return [...routes.filter((r) => !this.down(r.id)), ...routes.filter((r) => this.down(r.id))];
  }
}

export type RoutedHooks = {
  /** The server's id, the first time a route reports one; the connection keeps it (ADR 0120). */
  onServer?: (server: string) => void;
  health?: RouteHealth;
  /** Keeps a record of each opening: the routes tried, their steps, how it ended (attempts.ts, #270). */
  attempts?: AttemptRecorder;
};

/**
 * Opens `d`'s routes that are on, in order (those down lately last, `RouteHealth`), and uses the first that opens. A
 * wrong password, too many sign-ins or a stop ends it at once: the same Hermes would say the same over any route. With
 * one route on, its own error is passed on as it is; with more, `RoutesFailedError` lists each. The pipe's route says
 * which route it is (`via`) when the connection has more than one. Called again to reconnect, it starts from the top,
 * so a dropped connection comes back over whichever route works now.
 */
export function routedPipe(d: SignInDetails, open: OpenRoute, hooks: RoutedHooks = {}): OpenPipe {
  let expect = d.server;
  return async (onEvent, profile, signal) => {
    const attempt = hooks.attempts?.begin(d);
    try {
      const pipe = await openRoutes(attempt, onEvent, profile, signal);
      return attempt ? { ...pipe, attempt } : pipe;
    } catch (e) {
      if (signal?.aborted || (e instanceof Error && e.message === STOPPED)) attempt?.stopped();
      // Every route failed: their own errors say why, and the list of them names their addresses.
      else attempt?.failed(e instanceof RoutesFailedError ? undefined : e);
      throw e;
    }
  };

  async function openRoutes(attempt: AttemptTrace | undefined, onEvent: Parameters<OpenPipe>[0], profile: string, signal?: AbortSignal): Promise<Pipe> {
    const all = routesOf(d);
    const on = all.filter((r) => !r.off && !r.locked);
    if (!on.length) throw new Error(NO_ROUTES);
    const quick = on.length > 1;
    const sshRoute = sshRouteOf(all);
    const failures: { route: RouteDetails; message: string }[] = [];
    for (const r of hooks.health?.order(on) ?? on) {
      if (signal?.aborted) throw new Error(STOPPED);
      const trying = attempt?.route(r);
      let pipe: Pipe;
      try {
        pipe = await open(singleRoute(d, r), { ...(expect && { expectServer: expect }), quick, ...(sshRoute && { sshRoute }), ...(trying && { onStep: trying.step }) })(
          onEvent,
          profile,
          signal,
        );
      } catch (e) {
        const message = errorText(e);
        trying?.failed(e);
        if (!quick || FINAL.test(message) || signal?.aborted) throw e;
        hooks.health?.failed(r.id);
        failures.push({ route: r, message });
        continue;
      }
      hooks.health?.ok(r.id);
      const server = pipe.route.server;
      // Only a connection with several routes is held to one server; one with a single route connects as it did.
      if (server && !expect && d.routes) {
        expect = server;
        hooks.onServer?.(server);
      }
      if (!d.routes || all.length < 2) return reopenable(pipe, r);
      const route: Route = { ...pipe.route, via: { id: r.id, kind: r.kind, index: on.indexOf(r), of: on.length } };
      return reopenable({ ...pipe, route }, r);
    }
    // Every route turned the token down or couldn't use it: that is the failure, not the routes.
    if (failures.length && failures.every((f) => TOKEN_REFUSED.test(f.message))) throw new Error(failures[0].message);
    throw new RoutesFailedError(failures);
  }

  /** `pipe`, opened over `r`, whose `reopen` keeps its route and is recorded as an attempt of its own over `r`. */
  function reopenable(pipe: Pipe, r: RouteDetails): Pipe {
    const reopen = pipe.reopen;
    if (!reopen) return pipe;
    return {
      ...pipe,
      reopen: async (onEvent, profile, signal) => {
        const attempt = hooks.attempts?.begin(d);
        const trying = attempt?.route(r);
        try {
          const again = reopenable({ ...(await reopen(onEvent, profile, signal, trying?.step)), route: pipe.route }, r);
          return attempt ? { ...again, attempt } : again;
        } catch (e) {
          trying?.failed(e);
          if (signal?.aborted || (e instanceof Error && e.message === STOPPED)) attempt?.stopped();
          else attempt?.failed(e);
          throw e;
        }
      },
    };
  }
}

// ── going back to a preferred route ─────────────────────────────────────────

/** Checks one route without signing in: resolves once it reached the Hermes `expectServer` names (src-tauri `hermes_reach`). */
export type ReachRoute = (d: SignInDetails, expectServer: string | undefined) => Promise<unknown>;

/** What `PreferredRoutes` needs from the connection: its status and route, and a way to move it when nothing runs. */
export type Movable = {
  getSnapshot(): { status: string; route?: Route };
  /** Closes the connection and opens it again, only if no reply is running and nothing waits; whether it did. */
  reroute(reason: string): Promise<boolean>;
};

/**
 * While a connection is on a fallback route, checks the routes before it now and then, without the password. When one
 * answers as the same Hermes, and nothing is running, the connection is opened again, which takes the preferred route.
 * `stop` ends the checks.
 */
export class PreferredRoutes {
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  constructor(
    private hermes: Movable,
    private d: SignInDetails,
    private reach: ReachRoute,
    private health: RouteHealth,
    private server: () => string | undefined = () => d.server,
  ) {}

  start(everyMs = 90_000) {
    this.stop();
    this.timer = setInterval(() => void this.check(), everyMs);
    return () => this.stop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One check; resolves to whether the connection moved. */
  async check(): Promise<boolean> {
    const snap = this.hermes.getSnapshot();
    const via = snap.route?.via;
    if (this.checking || snap.status !== "connected" || !via || via.index === 0) return false;
    this.checking = true;
    try {
      const on = routesOf(this.d).filter((r) => !r.off && !r.locked);
      const at = on.findIndex((r) => r.id === via.id);
      for (const r of on.slice(0, at < 0 ? via.index : at)) {
        const reached = await this.reach(singleRoute(this.d, r), this.server()).then(
          () => true,
          () => false,
        );
        if (!reached) continue;
        this.health.ok(r.id);
        // Still on the same fallback, and still nothing running: move.
        const now = this.hermes.getSnapshot();
        if (now.status !== "connected" || now.route?.via?.id !== via.id) return false;
        return await this.hermes.reroute(`Moving back to ${KIND_LABEL[r.kind]}, which answers again.`);
      }
      return false;
    } finally {
      this.checking = false;
    }
  }
}
