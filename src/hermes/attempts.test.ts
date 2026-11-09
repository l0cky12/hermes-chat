import { describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no types in this project; vitest runs in node.
import { readFileSync } from "node:fs";
import { AttemptLog, KEEP, STEPS, TEXT_MAX, WITHHELD, addressFree, attemptText, scrubberFor, type Attempt, type AttemptStore } from "./attempts";
import { FakeHermes } from "./fakeHermes";
import { LogBuffer } from "./logs";
import { RoutesFailedError, routedPipe, withRoutes, type OpenRoute, type RouteDetails } from "./routes";
import type { SignInDetails } from "./tauriPipe";
import { connect } from "./transport";

// What must never reach the file.
const PASSWORD = "Pw-SENTINEL-hunter2";
const TOKEN = "tok_SENTINEL_9f8e7d6c5b4a";
const HEADER = "v1.0-SENTINEL-cf-access-secret";
const LAN: RouteDetails = { id: "k3x9q2ab", kind: "lan", target: "http://192.168.1.10:9119" };
const TAILNET: RouteDetails = { id: "7hd0aa1c", kind: "tailscale", target: "http://hermes-box.tail1234.ts.net:9119" };
const WEB: RouteDetails = { id: "w3b0", kind: "web", target: "https://hermes.example.com", headers: [{ name: "Cf-Access-Client-Secret", value: HEADER }] };
const SSH: RouteDetails = { id: "main", kind: "ssh", target: "liam@nasbox" };
const ROUTES = [LAN, TAILNET, WEB, SSH];
const base: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "liam", password: PASSWORD, token: TOKEN };
const details = (routes = ROUTES): SignInDetails => withRoutes(base, routes);
const FORBIDDEN = [
  PASSWORD,
  TOKEN,
  HEADER,
  "192.168.1.10",
  "hermes-box",
  "tail1234",
  "hermes.example.com",
  "nasbox",
  "liam",
  "203.0.113.77",
  "fd7a:115c",
  "realhost",
  "://",
  "@",
  "9119",
];

/**
 * Error texts as Rust and ssh write them, each holding an address, a secret or both: reqwest's chain with the URL,
 * PlainHttpPublic, a redirect, a WebSocket error with an IPv6 address, a server body that echoes a header, cookie and
 * token, ssh's own lines, and the routes' list.
 */
const RAW = [
  "Can't reach the Hermes dashboard: error sending request for url (http://192.168.1.10:9119/api/status)",
  "Can't reach the Hermes dashboard: error sending request for url (http://hermes-box.tail1234.ts.net:9119/api/status): dns error: failed to lookup address information: Name or service not known",
  "Plain http:// is only used on this computer, a LAN or Tailscale, and 203.0.113.77 is a public address. Use https:// or SSH to reach it.",
  "The dashboard sent Hermes Chat on to https://login.example.org/cdn-cgi/access?redirect=hermes.example.com, another site.",
  "The chat connection failed: IO error: Connection refused (os error 111) at [fd7a:115c:a1e0::1]:9119",
  `The dashboard answered 500: {"echo": {"Cf-Access-Client-Secret": "${HEADER}", "cookie": "session=abc123def456", "password": "${PASSWORD}"}, "token": "${TOKEN}"}`,
  `Authorization: Bearer ${TOKEN}`,
  "ssh: Could not resolve hostname realhost: Name or service not known",
  "ssh: connect to host nasbox port 22: Connection refused",
  "liam@nasbox: Permission denied (publickey,password).",
  "Connection closed by 203.0.113.77 port 22",
  "kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 192.168.1.10 port 22",
  `Wrong username or password for liam at hermes.example.com (${PASSWORD})`,
  `The connection closed before Hermes was ready: closed by the server (1008 ${HEADER})`,
  new RoutesFailedError(ROUTES.map((route) => ({ route, message: "Can't reach the Hermes dashboard" }))).message,
  `\x1b[1mBearer ${TOKEN}\x1b[0m eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl`,
];

const clean = (text: string) => FORBIDDEN.filter((f) => text.toLowerCase().includes(f.toLowerCase()));

/** A store that is Rust's file in memory: it refuses what Rust refuses, keeps the newest 50, and records each put. */
function memoryStore(lines: Attempt[] = []) {
  const puts: string[] = [];
  let file = [...lines];
  const store: AttemptStore = {
    read: async () => ({ attempts: [...file], unreadable: 0 }),
    put: async (a) => {
      const all = [a.error, ...a.routes.map((r) => r.error)].filter((t): t is string => t !== undefined);
      if (!all.every(addressFree) || all.some((t) => Array.from(t).length > TEXT_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(t))) throw new Error("Not kept: an error text looks like it holds an address.");
      // Without the values the log makes itself (random ids, clock times): a UUID or Date.now() can hold "9119" (#312).
      puts.push(JSON.stringify(a, (k, v) => (["id", "run", "at", "ms"].includes(k) ? undefined : v)));
      file = [...file.filter((x) => x.id !== a.id), structuredClone(a)].sort((x, y) => x.at - y.at).slice(-KEEP);
    },
  };
  return { store, puts, file: () => file };
}

describe("Scrubbing error texts for the file", () => {
  const scrub = scrubberFor(details());

  it("takes out every password, token, header value, address and host name, and keeps what happened", () => {
    for (const raw of RAW) {
      const text = scrub(raw);
      expect(clean(text), `${raw}\n→ ${text}`).toEqual([]);
      expect(addressFree(text)).toBe(true);
    }
    expect(scrub(RAW[0])).toBe("Can't reach the Hermes dashboard: error sending request for url ([address])");
    expect(scrub(RAW[7])).toBe("ssh: Could not resolve hostname [host]: Name or service not known");
    expect(scrub(RAW[8])).toBe("ssh: connect to host [host] port 22: Connection refused");
  });

  it("keeps sentences that hold no address as they are", () => {
    for (const t of [
      "Hermes didn't send gateway.ready in time.",
      "Wrong username or password.",
      "Too many sign-in attempts. Wait a minute and try again.",
      "Hermes didn't finish connecting within 60s.",
      "The dashboard answered 502: Bad gateway at 10:00:00",
      "Can't reach the Hermes dashboard: operation timed out (os error 10060)",
    ])
      expect(scrub(t)).toBe(t);
    // The host `hermes` (a bare LAN name) doesn't take the word "Hermes" with it.
    const bare = scrubberFor(details([{ id: "a", kind: "lan", target: "http://hermes:9119" }]));
    expect(bare("Can't reach the Hermes dashboard at hermes:9119")).toBe("Can't reach the Hermes dashboard at [address]");
  });

  it("doesn't let a short saved value split an address, and leaves no part of it", () => {
    for (const d of [
      { ...details([SSH]), username: "10" },
      { ...details([SSH]), password: "10.1" },
      { ...details([{ ...WEB, headers: [{ name: "X-Key", value: "10" }] }]) },
    ]) {
      const scrub = scrubberFor(d);
      for (const raw of ["Connection closed by 10.1.2.3 port 22", "Warning: Permanently added '10.1.2.3' (ED25519) to the list of known hosts."]) {
        const text = scrub(raw);
        expect(text, `${raw} → ${text}`).not.toMatch(/\d\.\d|\.\d+\.\d/);
        expect(text).toMatch(/\[address\]|\[redacted\]/);
      }
    }
  });

  it("takes out a host name with an underscore that isn't one of the connection's own", () => {
    const text = scrubberFor(details([{ id: "a", kind: "ssh", target: "myalias" }]))("Warning: Permanently added 'my_server.local' (ED25519) to the list of known hosts.");
    expect(text).toBe("Warning: Permanently added '[host]' (ED25519) to the list of known hosts.");
  });

  it("takes out a password, token or header value with a line break or tab in it, echoed without a label", () => {
    for (const secret of ["hello\nworld", "tab\tbed", "cr\r\nlf"]) {
      for (const d of [{ ...details(), password: secret }, { ...details(), token: secret }, { ...details([{ ...WEB, headers: [{ name: "X-Key", value: secret }] }]) }]) {
        const text = scrubberFor(d)(`server said ${secret} again`);
        expect(text).toBe("server said [redacted] again");
      }
    }
  });

  it("cuts a long text, and withholds one that still looks like an address", () => {
    expect(Array.from(scrub("word ".repeat(1000))).length).toBe(TEXT_MAX);
    expect(addressFree("a 10.0.0.5 b")).toBe(false);
    expect(addressFree("dial 2001:db8:0:1:2:3:4:5")).toBe(false);
    expect(addressFree("at 10:00:00")).toBe(true);
    expect(WITHHELD).toSatisfy(addressFree);
  });
});

/** One FakeHermes behind routes; `down` maps a route id to how it fails after reaching `at`. */
function routes(server = new FakeHermes()) {
  const down = new Map<string, { at: (typeof STEPS)[number][]; error: string }>();
  const open: OpenRoute = (d, opts) => async (onEvent, profile, signal) => {
    const r = ROUTES.find((x) => x.target === (d.mode === "ssh" ? d.sshTarget : d.url))!;
    const fails = down.get(r.id);
    for (const s of fails?.at ?? ["keyring", r.kind === "ssh" ? "tunnel" : "resolve", "status", "sign-in", "ticket", "websocket"]) opts.onStep?.(s as never);
    if (fails) throw new Error(fails.error);
    const pipe = await server.openPipe(onEvent, profile, signal);
    return { ...pipe, route: d.mode === "ssh" ? { kind: "ssh", target: d.sshTarget } : { kind: "url", url: d.url, addresses: ["192.168.1.10"] } };
  };
  return { server, down, open };
}

describe("The record of one connection attempt", () => {
  it("names each route by kind and id, the steps reached with their times, and why each failed, with nothing secret", async () => {
    const { store, puts, file } = memoryStore();
    let t = 0;
    const log = new AttemptLog(store, { run: "00000000-0000-4000-8000-000000000001", now: () => 1_700_000_000_000, tick: () => (t += 10) });
    const r = routes();
    for (const [i, raw] of RAW.slice(0, 3).entries()) r.down.set(ROUTES[i].id, { at: ["keyring", "resolve", "status"], error: raw });
    const hermes = await connect(routedPipe(details(), r.open, { attempts: log }));
    await log.settled();
    expect(hermes.getSnapshot().status).toBe("connected");
    const [a] = file();
    expect(a.outcome).toBe("connected");
    expect(a.routes.map((x) => [x.kind, x.id])).toEqual(ROUTES.map((x) => [x.kind, x.id]));
    expect(a.routes[0].steps.map((s) => s.step)).toEqual(["keyring", "resolve", "status"]);
    expect(a.routes[0].steps.every((s) => typeof s.ms === "number")).toBe(true);
    expect(a.routes[0].error).toBe("Can't reach the Hermes dashboard: error sending request for url ([address])");
    expect(a.routes[3].steps.map((s) => s.step)).toEqual(["keyring", "tunnel", "status", "sign-in", "ticket", "websocket", "ready"]);
    expect(a.routes[3].steps.at(-1)?.ms).toBeGreaterThan(0);
    expect(a.ms).toBeGreaterThan(0);
    // Every write along the way, not only the last (writes queued behind a slow one merge into its latest state).
    expect(puts.length).toBeGreaterThan(1);
    for (const p of puts) expect(clean(p), p).toEqual([]);
    expect(attemptText(a, "x").text).toMatch(/^Connected in .*\. LAN route k3x9q2ab: keyring 10 ms, resolve 10 ms, status 10 ms; stopped at status: Can't reach/);
  });

  it("keeps a failure that every route had, from every raw error shape, without a secret or an address", async () => {
    for (const raw of RAW) {
      const { store, puts, file } = memoryStore();
      const log = new AttemptLog(store);
      const r = routes();
      for (const x of ROUTES) r.down.set(x.id, { at: ["keyring", "status"], error: raw });
      await connect(routedPipe(details(), r.open, { attempts: log })).catch(() => {});
      await log.settled();
      expect(file()[0].outcome).toBe("failed");
      expect(file()[0].routes.length).toBeGreaterThan(0);
      for (const p of puts) expect(clean(p), `${raw}\n${p}`).toEqual([]);
    }
  });

  it("with one route, says the step it stopped at and its error, once", async () => {
    const { store, file } = memoryStore();
    const log = new AttemptLog(store);
    const r = routes();
    r.down.set(LAN.id, { at: ["keyring", "resolve", "status", "sign-in"], error: "Wrong username or password." });
    await expect(connect(routedPipe(details([LAN]), r.open, { attempts: log }))).rejects.toThrow("Wrong username");
    await log.settled();
    const [a] = file();
    expect(a.outcome).toBe("failed");
    expect(a.error).toBeUndefined();
    expect(a.routes[0]).toMatchObject({ id: LAN.id, kind: "lan", error: "Wrong username or password." });
    expect(a.routes[0].steps.at(-1)).toMatchObject({ step: "sign-in" });
    expect(attemptText(a, "x").text).toMatch(/^Failed after .*\. LAN route k3x9q2ab: .*sign-in \d+ ms; stopped at sign-in: Wrong username or password\.$/);
  });

  it("when Hermes never sends gateway.ready, ends at the ready step with that reason", async () => {
    const { store, file } = memoryStore();
    const log = new AttemptLog(store);
    const r = routes();
    const opened = await routedPipe(details([LAN]), r.open, { attempts: log })(() => {}, "default");
    opened.attempt?.ready();
    opened.attempt?.failed(new Error("Hermes didn't send gateway.ready in time."));
    opened.attempt?.connected(); // after an end: nothing
    await log.settled();
    expect(file()[0]).toMatchObject({ outcome: "failed", error: "Hermes didn't send gateway.ready in time." });
    expect(file()[0].routes[0].steps.at(-1)?.step).toBe("ready");
  });

  it("a stop is kept as stopped", async () => {
    const { store, file } = memoryStore();
    const log = new AttemptLog(store);
    const r = routes();
    r.down.set(LAN.id, { at: ["keyring", "resolve"], error: "Connecting was stopped." });
    await connect(routedPipe(details([LAN]), r.open, { attempts: log })).catch(() => {});
    await log.settled();
    expect(file()[0].outcome).toBe("stopped");
  });
});

describe("Stops and late step messages", () => {
  it("a stop while waiting for gateway.ready, through the real dial and close, is kept as stopped", async () => {
    const { store, file } = memoryStore();
    const log = new AttemptLog(store);
    const server = new FakeHermes();
    let opened!: () => void;
    const open = new Promise<void>((r) => (opened = r));
    // The pipe opens, but its frames never reach the dial, so gateway.ready never comes.
    const silent: OpenRoute = (d, opts) => async (_onEvent, profile, signal) => {
      for (const s of ["keyring", "resolve", "status", "sign-in", "ticket", "websocket"] as const) opts.onStep?.(s);
      const pipe = await server.openPipe(() => {}, profile, signal);
      setTimeout(opened, 0);
      return { ...pipe, route: { kind: "url", url: d.url, addresses: [] } };
    };
    const stop = new AbortController();
    const dialing = connect(routedPipe(details([LAN]), silent, { attempts: log }), undefined, undefined, undefined, stop.signal);
    await open;
    stop.abort();
    await expect(dialing).rejects.toThrow(/^Connecting was stopped/);
    await log.settled();
    expect(file()[0]).toMatchObject({ outcome: "stopped" });
    expect(file()[0].error).toBeUndefined();
    expect(file()[0].routes[0].steps.at(-1)).toMatchObject({ step: "ready", ms: expect.any(Number) });
  });

  it("a step whose message comes after the route opened or failed goes in its place, with the durations around it", async () => {
    const { store, file } = memoryStore();
    let t = 1000;
    const log = new AttemptLog(store, { tick: () => t });
    const trace = log.begin(details([LAN, SSH]));
    // LAN: Rust started keyring at 0, resolve at 5, status at 20; it failed at 520 ms, before status's message came.
    const lan = trace.route(LAN);
    lan.step("keyring", 0);
    lan.step("resolve", 5);
    t = 1520;
    lan.failed(new Error("Can't reach the Hermes dashboard: operation timed out"));
    lan.step("status", 20);
    // SSH: opened at 600 ms; its websocket message arrives after the pipe opened and the ready wait began.
    t = 1520;
    const ssh = trace.route(SSH);
    for (const [s, at] of [["keyring", 0], ["tunnel", 10], ["status", 300], ["sign-in", 310], ["ticket", 400]] as const) ssh.step(s, at);
    t = 2130;
    trace.ready();
    ssh.step("websocket", 450);
    t = 2200;
    trace.connected();
    await log.settled();
    const [a] = file();
    expect(a.routes[0].steps).toEqual([
      { step: "keyring", ms: 5 },
      { step: "resolve", ms: 15 },
      { step: "status", ms: 500 },
    ]);
    expect(a.routes[1].steps).toEqual([
      { step: "keyring", ms: 10 },
      { step: "tunnel", ms: 290 },
      { step: "status", ms: 10 },
      { step: "sign-in", ms: 90 },
      { step: "ticket", ms: 50 },
      { step: "websocket", ms: 160 },
      { step: "ready", ms: 70 },
    ]);
    expect(a.outcome).toBe("connected");
  });
});

describe("An attempt the app was closed during", () => {
  it("is on disk at the step it was on, and the next launch says the app was closed while connecting", async () => {
    const { store, file } = memoryStore();
    const first = new AttemptLog(store, { run: "00000000-0000-4000-8000-00000000000a" });
    const trace = first.begin(details());
    const lan = trace.route(LAN);
    lan.step("keyring");
    lan.step("resolve");
    lan.step("status");
    // The app closes here: nothing more is written.
    await first.settled();
    const line = file()[0];
    expect(line.outcome).toBe("unfinished");
    expect(line.routes[0].steps.at(-1)).toEqual({ step: "status" });

    const next = new AttemptLog(store, { run: "00000000-0000-4000-8000-00000000000b" });
    await next.load();
    const [entry] = next.getSnapshot().entries;
    expect(entry).toMatchObject({ kind: "line", level: "WARNING" });
    expect(entry.text).toMatch(/^Didn't finish: Hermes Chat was closed while it was connecting, at status\. LAN route k3x9q2ab: keyring \d+ ms, resolve \d+ ms, status\.$/);
  });

  it("a write the store refuses is kept again without its texts", async () => {
    const puts: Attempt[] = [];
    const store: AttemptStore = {
      read: async () => ({ attempts: [], unreadable: 0 }),
      put: async (a) => {
        if (a.routes.some((r) => r.error && r.error !== WITHHELD)) throw new Error("Not kept: an error text looks like it holds an address.");
        puts.push(a);
      },
    };
    const log = new AttemptLog(store);
    const trace = log.begin(details());
    trace.route(LAN).failed(new Error("anything"));
    trace.failed();
    await log.settled();
    expect(puts.at(-1)?.routes[0].error).toBe(WITHHELD);
    // What Logs and the support bundle show is what was kept, not the text Rust refused.
    expect(log.getSnapshot().entries.at(-1)?.text).toContain(WITHHELD);
    expect(log.getSnapshot().entries.at(-1)?.text).not.toContain("anything");
  });

  it("a write that fails for another reason (a full disk, a lock) keeps the texts, writes nothing withheld, and is noted once", async () => {
    const puts: Attempt[] = [];
    const app = new LogBuffer(10);
    const store: AttemptStore = {
      read: async () => ({ attempts: [], unreadable: 0 }),
      put: async (a) => {
        puts.push(a);
        throw new Error("No space left on device (os error 28)");
      },
    };
    const log = new AttemptLog(store, { notes: app });
    const trace = log.begin(details());
    trace.route(LAN).failed(new Error("Wrong username or password."));
    trace.failed();
    await log.settled();
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.some((p) => JSON.stringify(p).includes(WITHHELD))).toBe(false);
    expect(log.getSnapshot().entries.at(-1)?.text).toContain("Wrong username or password.");
    expect(app.getSnapshot().entries.map((e) => e.text)).toEqual(["A connection attempt couldn't be kept on disk: No space left on device (os error 28)"]);
  });
});

describe("The cap", () => {
  it("keeps the newest 50 attempts, in memory and in the store", async () => {
    const { store, file } = memoryStore();
    let now = 0;
    const log = new AttemptLog(store, { now: () => (now += 1000) });
    const r = routes();
    r.down.set(LAN.id, { at: ["keyring", "resolve"], error: "Can't reach the Hermes dashboard" });
    for (let i = 0; i < 120; i++) await routedPipe(details([LAN]), r.open, { attempts: log })(() => {}, "default").catch(() => {});
    await log.settled();
    expect(file()).toHaveLength(KEEP);
    expect(log.getSnapshot().lines).toBe(KEEP);
    expect(file()[0].at).toBe(71_000);
  });

  it("says when lines of the file couldn't be read", async () => {
    const log = new AttemptLog({ read: async () => ({ attempts: [], unreadable: 2 }), put: async () => {} });
    await log.load();
    expect(log.getSnapshot().entries[0]).toMatchObject({ kind: "mark", text: expect.stringMatching(/^2 lines of the file couldn't be read/) });
  });
});

describe("The steps", () => {
  it("are Rust's list, in Rust's order (src-tauri/src/connect_steps.rs)", () => {
    const rust: string = readFileSync("src-tauri/src/connect_steps.rs", "utf8");
    const body = /pub enum Step \{([\s\S]*?)\n\}/.exec(rust)![1];
    const names: string[] = [];
    let rename: string | undefined;
    for (const line of body.split("\n").map((l) => l.trim())) {
      const r = /^#\[serde\(rename = "([^"]+)"\)\]$/.exec(line);
      if (r) rename = r[1];
      const v = /^([A-Z]\w*),$/.exec(line);
      if (v) {
        names.push(rename ?? v[1].replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
        rename = undefined;
      }
    }
    expect(names).toEqual([...STEPS]);
  });
});
