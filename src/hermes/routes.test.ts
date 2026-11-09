import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTIONS_KEY, Connections, type SavedConnection, keptRouteHealth } from "./connections";
import { FakeHermes, row } from "./fakeHermes";
import type { Route } from "./pipe";
import {
  NO_ROUTES,
  PreferredRoutes,
  RouteHealth,
  RoutesFailedError,
  savedRoute,
  kindOfUrl,
  normalizeTarget,
  routeFromAddress,
  routeProblem,
  routedPipe,
  singleRoute,
  sshAddressOf,
  withRoutes,
  type OpenRoute,
  type RouteDetails,
} from "./routes";
import type { SignInDetails } from "./tauriPipe";
import { connect } from "./transport";

const LAN: RouteDetails = { id: "lan", kind: "lan", target: "http://192.168.1.10:9119" };
const TAILNET: RouteDetails = { id: "ts", kind: "tailscale", target: "http://hermes.tail1234.ts.net:9119" };
const SSH: RouteDetails = { id: "ssh", kind: "ssh", target: "liam@hermes" };

const base: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "liam", password: "hunter2" };
const signIn = (routes: RouteDetails[], extra: Partial<SignInDetails> = {}) => ({ ...withRoutes(base, routes), ...extra });
const where = (d: SignInDetails) => (d.mode === "ssh" ? d.sshTarget : d.url);

/**
 * One FakeHermes behind several routes. `down` maps a route's address to how it fails; `servers` to the install a
 * route reaches (the home one when unset). Every open is noted with what it was asked to expect.
 */
function routes(server = new FakeHermes()) {
  const down = new Map<string, string>();
  const servers = new Map<string, string>();
  const opened: { at: string; expect?: string; quick: boolean; sshRoute?: string }[] = [];
  const open: OpenRoute = (d, opts) => async (onEvent, profile, signal) => {
    const at = where(d);
    opened.push({ at, expect: opts.expectServer, quick: opts.quick, sshRoute: opts.sshRoute });
    const failure = down.get(at);
    if (failure) throw new Error(failure);
    const id = servers.get(at) ?? "home-server-id";
    if (opts.expectServer && opts.expectServer !== id)
      throw new Error("Wrong server: a different Hermes server answered at this address than the one this connection signed in to before. Hermes Chat didn't send it the password.");
    const pipe = await server.openPipe(onEvent, profile, signal);
    const route: Route = d.mode === "ssh" ? { kind: "ssh", target: at, server: id } : { kind: "url", url: at, addresses: [], server: id };
    return { ...pipe, route };
  };
  return { server, down, servers, opened, open };
}

describe("Route addresses", () => {
  it("completes what the owner typed with a scheme and the dashboard's port", () => {
    expect(normalizeTarget("lan", "192.168.1.10")).toBe("http://192.168.1.10:9119");
    expect(normalizeTarget("lan", " hermes.local:8080 ")).toBe("http://hermes.local:8080");
    expect(normalizeTarget("tailscale", "hermes.tail1234.ts.net")).toBe("http://hermes.tail1234.ts.net:9119");
    expect(normalizeTarget("tailscale", "100.101.102.103/dash/")).toBe("http://100.101.102.103:9119/dash/");
    expect(normalizeTarget("lan", "[fd00::5]")).toBe("http://[fd00::5]:9119");
    expect(normalizeTarget("web", "hermes.example.com")).toBe("https://hermes.example.com");
    expect(normalizeTarget("web", "http://10.0.0.2:9119")).toBe("http://10.0.0.2:9119");
    expect(normalizeTarget("ssh", " liam@hermes ")).toBe("liam@hermes");
  });

  it("says why a route can't be used: plain http over the internet, a non-Tailscale address, a bad SSH target", () => {
    expect(routeProblem({ id: "a", kind: "lan", target: "" })).toBe("Enter an address.");
    expect(routeProblem({ id: "a", kind: "web", target: "http://203.0.113.7:9119" })).toMatch(/only used on a LAN or Tailscale/);
    expect(routeProblem({ id: "a", kind: "lan", target: "192.168.1.10" })).toBeUndefined();
    expect(routeProblem({ id: "a", kind: "tailscale", target: "100.64.0.1" })).toBeUndefined();
    expect(routeProblem({ id: "a", kind: "tailscale", target: "hermes" })).toBeUndefined();
    expect(routeProblem({ id: "a", kind: "tailscale", target: "hermes.example.com" })).toMatch(/MagicDNS/);
    expect(routeProblem({ id: "a", kind: "web", target: "https://hermes.example.com" })).toBeUndefined();
    expect(routeProblem({ id: "a", kind: "ssh", target: "-oProxyCommand=x" })).toMatch(/no spaces/);
    expect(routeProblem({ id: "a", kind: "lan", target: "ftp://hermes" })).toMatch(/http/);
    expect(routeProblem({ id: "a", kind: "web", target: "https://token@hermes.example.com/" })).toMatch(/can't hold a user name, password or token/);
    expect(routeProblem({ id: "a", kind: "lan", target: "owner:pa55@192.168.1.10" })).toMatch(/can't hold a user name, password or token/);
  });

  it("guesses the kind of a connection made before routes from its host", () => {
    expect(kindOfUrl("http://hermes:9119")).toBe("lan");
    expect(kindOfUrl("http://192.168.1.10:9119")).toBe("lan");
    expect(kindOfUrl("http://100.100.64.121:9119")).toBe("tailscale");
    expect(kindOfUrl("https://hermes.tail1234.ts.net")).toBe("tailscale");
    expect(kindOfUrl("https://hermes.example.com")).toBe("web");
    expect(routeFromAddress({ mode: "ssh", sshTarget: "liam@hermes", url: "x", username: "liam" })).toEqual({ id: "main", kind: "ssh", target: "liam@hermes" });
  });

  it("gives the Terminal the connection's SSH route, even when another route comes first", () => {
    expect(sshAddressOf(signIn([LAN, SSH]))).toEqual({ mode: "ssh", sshTarget: "liam@hermes" });
    expect(sshAddressOf(signIn([LAN, TAILNET]))).toEqual({ mode: "url", sshTarget: "", url: LAN.target });
    expect(sshAddressOf({ mode: "url", sshTarget: "", url: "http://hermes:9119", username: "liam" })).toEqual({ mode: "url", sshTarget: "", url: "http://hermes:9119" });
  });
});

describe("Connecting over routes", () => {
  it("uses the first route that opens, says which it is, and keeps the server it reached", async () => {
    const r = routes();
    const learned: string[] = [];
    const hermes = await connect(routedPipe(signIn([LAN, TAILNET, SSH]), r.open, { onServer: (s) => learned.push(s) }));
    expect(r.opened.map((o) => o.at)).toEqual([LAN.target]);
    expect(hermes.getSnapshot().route).toMatchObject({ url: LAN.target, via: { id: "lan", kind: "lan", index: 0, of: 3 } });
    expect(learned).toEqual(["home-server-id"]);
    // Several routes: each gives up sooner, and every route knows the connection's SSH target, for server pages.
    expect(r.opened[0]).toMatchObject({ quick: true, sshRoute: "liam@hermes", expect: undefined });
  });

  it("falls back to the next route when one fails, and lists every route's failure when all do", async () => {
    const r = routes();
    r.down.set(LAN.target, "Can't reach the Hermes dashboard: connection timed out");
    const hermes = await connect(routedPipe(signIn([LAN, TAILNET]), r.open));
    expect(hermes.getSnapshot().route?.via).toMatchObject({ kind: "tailscale", index: 1 });
    await hermes.close();

    r.down.set(TAILNET.target, "Can't reach the Hermes dashboard: couldn't look up hermes.tail1234.ts.net");
    const failed = await connect(routedPipe(signIn([LAN, TAILNET]), r.open)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RoutesFailedError);
    expect((failed as Error).message).toBe(
      [
        "No route reached Hermes.",
        "• LAN, http://192.168.1.10:9119: Can't reach the Hermes dashboard: connection timed out",
        "• Tailscale, http://hermes.tail1234.ts.net:9119: Can't reach the Hermes dashboard: couldn't look up hermes.tail1234.ts.net",
      ].join("\n"),
    );
  });

  it("skips a route that reaches another server, and never offers it the password", async () => {
    const r = routes();
    r.servers.set(LAN.target, "neighbours-server");
    const hermes = await connect(routedPipe(signIn([LAN, SSH], { server: "home-server-id" }), r.open));
    expect(hermes.getSnapshot().route?.via?.kind).toBe("ssh");
    expect(r.opened).toMatchObject([{ at: LAN.target, expect: "home-server-id" }, { at: SSH.target, expect: "home-server-id" }]);
  });

  it("learns the server on the first route, then holds every later route to it", async () => {
    const r = routes();
    const hermes = await connect(routedPipe(signIn([LAN, SSH]), r.open));
    // The LAN address now answers as another machine, as it would on another network.
    r.servers.set(LAN.target, "cafe-router");
    r.server.drop();
    await hermes.reconnect();
    expect(hermes.getSnapshot().route?.via?.kind).toBe("ssh");
    expect(r.opened.slice(1)).toMatchObject([{ at: LAN.target, expect: "home-server-id" }, { at: SSH.target, expect: "home-server-id" }]);
  });

  it("stops at a wrong password or a stop: the same Hermes would say the same over any route", async () => {
    const r = routes();
    r.down.set(LAN.target, "Wrong username or password.");
    await expect(connect(routedPipe(signIn([LAN, SSH]), r.open))).rejects.toThrow(/^Wrong username or password\.$/);
    expect(r.opened.map((o) => o.at)).toEqual([LAN.target]);
    r.down.set(LAN.target, "Too many sign-in attempts. Wait a minute and try again.");
    await expect(connect(routedPipe(signIn([LAN, SSH]), r.open))).rejects.toThrow(/^Too many sign-in attempts/);
  });

  it("says a token that no route can use is refused, but uses a route that can, and reconnecting stops there too", async () => {
    const r = routes();
    const token = { method: "token" as const, savedToken: "id-1" };
    r.down.set(LAN.target, "No token is saved for this address. Enter the token to sign in.");
    const hermes = await connect(routedPipe(signIn([LAN, SSH], token), r.open));
    expect(hermes.getSnapshot().route?.via?.kind).toBe("ssh");
    r.down.set(SSH.target, "Token sign-in sends the token in the Authorization header, and this connection's extra request headers already set Authorization.");
    r.server.drop();
    await hermes.reconnect();
    expect(hermes.getSnapshot()).toMatchObject({ status: "offline", closedReason: expect.stringMatching(/^No token is saved/) });
    const refused = await connect(routedPipe(signIn([LAN, SSH], token), r.open)).catch((e: Error) => e);
    expect(refused).not.toBeInstanceOf(RoutesFailedError);
    expect((refused as Error).message).toMatch(/^No token is saved/);
    r.down.set(SSH.target, "SSH failed: ssh: connect to host hermes port 22: Connection refused");
    await expect(connect(routedPipe(signIn([LAN, SSH], token), r.open))).rejects.toThrow(RoutesFailedError);
    r.down.set(LAN.target, "The dashboard took the token as a basic sign-in, not as its session token, so Hermes Chat didn't sign in with it.");
    await expect(connect(routedPipe(signIn([LAN, SSH], token), r.open))).rejects.toThrow(/^The dashboard took the token as/);
    expect(r.opened.at(-1)?.at).toBe(LAN.target);
  });

  it("passes one route's own error on as it is, so a connection with one route fails as before", async () => {
    const r = routes();
    r.down.set("liam@hermes", "SSH failed: ssh: connect to host hermes port 22: Connection refused");
    const one = { ...base, sshTarget: "liam@hermes" };
    await expect(connect(routedPipe(one, r.open))).rejects.toThrow(/^SSH failed: ssh: connect to host hermes port 22: Connection refused$/);
    expect(r.opened[0]).toMatchObject({ quick: false });
    // No `via` on a connection with one route: nothing about it shows any different.
    r.down.clear();
    const hermes = await connect(routedPipe(one, r.open));
    expect(hermes.getSnapshot().route).toEqual({ kind: "ssh", target: "liam@hermes", server: "home-server-id" });
  });

  it("leaves out routes turned off, and ones the saved password wasn't saved for", async () => {
    const r = routes();
    await connect(routedPipe(signIn([{ ...LAN, off: true }, { ...TAILNET, locked: true }, SSH]), r.open));
    expect(r.opened.map((o) => o.at)).toEqual([SSH.target]);
    await expect(connect(routedPipe(signIn([{ ...LAN, off: true }]), r.open))).rejects.toThrow(NO_ROUTES);
  });

  it("tries a route that failed lately after the others, so a reconnect doesn't wait on it each time", async () => {
    let now = 1_000;
    const health = new RouteHealth(() => now, 120_000);
    const r = routes();
    r.down.set(LAN.target, "Can't reach the Hermes dashboard: connection timed out");
    const hermes = await connect(routedPipe(signIn([LAN, SSH]), r.open, { health }));
    r.server.drop();
    await hermes.reconnect();
    expect(r.opened.map((o) => o.at)).toEqual([LAN.target, SSH.target, SSH.target]);
    // Past the cool-down, it is first again.
    now += 120_000;
    r.server.drop();
    await hermes.reconnect();
    expect(r.opened.map((o) => o.at).slice(3)).toEqual([LAN.target, SSH.target]);
  });
});

describe("Route health across a restart (#269)", () => {
  const ROUTED: SavedConnection = {
    id: "0b6f3c1e-2d4a-4f8b-9c7e-5a1d2e3f4a5b",
    name: "Home server",
    addedAt: 0,
    mode: "url",
    sshTarget: "",
    url: LAN.target,
    username: "liam",
    routes: [LAN, TAILNET, SSH].map(savedRoute),
  };
  function disk() {
    const kept = new Map<string, string>();
    return { kept, storage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } };
  }

  it("tries a route that failed on the last launch last on the next, and keeps nothing secret", async () => {
    let now = 1_000_000;
    const { kept, storage } = disk();
    const before = new Connections(storage, () => now);
    before.save(ROUTED);
    const r = routes();
    r.down.set(LAN.target, "Can't reach the Hermes dashboard: the sign-in didn't answer within 10s.");
    await connect(routedPipe(signIn([LAN, TAILNET, SSH], { password: "hunter2" }), r.open, { health: keptRouteHealth(before, ROUTED.id, () => now) }));

    // The app closes; a minute later it launches again.
    now += 60_000;
    const after = new Connections(storage, () => now);
    const health = keptRouteHealth(after, ROUTED.id, () => now);
    expect(health.order([LAN, TAILNET, SSH]).map((x) => x.id)).toEqual(["ts", "ssh", "lan"]);
    expect(after.get(ROUTED.id)?.routeFailedAt).toEqual({ lan: 1_000_000 });
    expect(kept.get(CONNECTIONS_KEY)).not.toContain("hunter2");

    // Past the cool-down it is first again; once it works, what was kept about it goes.
    now += 120_000;
    expect(health.order([LAN, TAILNET, SSH]).map((x) => x.id)).toEqual(["lan", "ts", "ssh"]);
    health.ok("lan");
    expect(new Connections(storage, () => now).get(ROUTED.id)?.routeFailedAt).toBeUndefined();
  });

  it("forgets a failure kept for a route the connection no longer has", () => {
    const { storage } = disk();
    const c = new Connections(storage, () => 0);
    c.save({ ...ROUTED, routeFailedAt: { lan: 5, gone: 7, ssh: Number.NaN } as Record<string, number> });
    expect(new Connections(storage, () => 0).get(ROUTED.id)?.routeFailedAt).toEqual({ lan: 5 });
  });
});

describe("Moving mid-session", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("reconnects over the next route when the one in use drops, keeping the chats it had", async () => {
    const r = routes();
    r.server.sessions = [row("plan", 0.1, { title: "Plan the upgrade" })];
    const hermes = await connect(routedPipe(signIn([LAN, SSH]), r.open));
    await hermes.sync();
    expect(hermes.getSnapshot().chats.map((c) => c.title)).toEqual(["Plan the upgrade"]);

    r.down.set(LAN.target, "Can't reach the Hermes dashboard: No route to host");
    r.server.drop();
    expect(hermes.getSnapshot().status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes.getSnapshot()).toMatchObject({ status: "connected", route: { via: { kind: "ssh", index: 1 } } });
    expect(hermes.getSnapshot().chats.map((c) => c.title)).toEqual(["Plan the upgrade"]);
  });

  it("goes back to the preferred route once it answers and nothing is running", async () => {
    const r = routes();
    const health = new RouteHealth();
    r.down.set(LAN.target, "Can't reach the Hermes dashboard: No route to host");
    const d = signIn([LAN, SSH]);
    const hermes = await connect(routedPipe(d, r.open, { health }));
    expect(hermes.getSnapshot().route?.via?.kind).toBe("ssh");

    const reached: string[] = [];
    const reach = async (one: SignInDetails, expect?: string) => {
      reached.push(`${where(one)} ${expect}`);
      if (r.down.has(where(one))) throw { stage: "reach", message: "unreachable" };
    };
    const watch = new PreferredRoutes(hermes, d, reach, health, () => "home-server-id");
    // Still down: stays where it is, and nothing but the earlier route was checked, without the password.
    expect(await watch.check()).toBe(false);
    expect(reached).toEqual([`${LAN.target} home-server-id`]);

    r.down.delete(LAN.target);
    expect(await watch.check()).toBe(true);
    expect(hermes.getSnapshot()).toMatchObject({ status: "connected", route: { via: { kind: "lan", index: 0 } } });
    // On the first route, there is nothing to check.
    expect(await watch.check()).toBe(false);
    expect(reached).toHaveLength(2);
  });

  it("waits while a reply runs, then moves", async () => {
    const r = routes();
    r.down.set(LAN.target, "Can't reach the Hermes dashboard: No route to host");
    const d = signIn([LAN, SSH]);
    const health = new RouteHealth();
    const hermes = await connect(routedPipe(d, r.open, { health }));
    const watch = new PreferredRoutes(hermes, d, async () => {}, health);
    const id = await hermes.newChat();
    await hermes.send(id, "Summarise the logs");
    r.server.event(r.server.runtimeIdOf(id)!, "message.start");
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.running).toBe(true);
    r.down.delete(LAN.target);
    expect(await watch.check()).toBe(false);
    expect(hermes.getSnapshot().route?.via?.kind).toBe("ssh");

    r.server.event(r.server.runtimeIdOf(id)!, "message.complete", { text: "Done." });
    await vi.waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.running).toBe(false));
    expect(await watch.check()).toBe(true);
    expect(hermes.getSnapshot().route?.via?.kind).toBe("lan");
  });
});

describe("A route's sign-in", () => {
  it("is the route's own address with the connection's username, password and server", () => {
    const web: RouteDetails = { id: "w", kind: "web", target: "https://hermes.example.com", headers: [{ name: "CF-Access-Client-Id", value: "id" }] };
    expect(singleRoute(signIn([SSH, web], { server: "abc" }), web)).toEqual({
      mode: "url",
      sshTarget: "",
      url: "https://hermes.example.com",
      username: "liam",
      password: "hunter2",
      headers: [{ name: "CF-Access-Client-Id", value: "id" }],
      server: "abc",
    });
    expect(singleRoute(signIn([web, SSH]), SSH)).toMatchObject({ mode: "ssh", sshTarget: "liam@hermes", headers: [] });
  });
});
