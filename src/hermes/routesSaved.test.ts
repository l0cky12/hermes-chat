// Routes as the connection list and the keyring keep them (ADR 0120).
import { describe, expect, it } from "vitest";
import { type Account, type Keyring, savedSignIn, signIn, signInForm } from "./account";
import { CONNECTIONS_KEY, Connections, addressKey, routesSummary } from "./connections";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { withRoutes, type RouteDetails } from "./routes";
import { explain, explainSignIn, testRoutes, testSignIn, verdictOf, type Probe, type Probed } from "./setup";
import type { SignInDetails } from "./tauriPipe";
import { connect, readSaved } from "./transport";

function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function keyring(value?: string): Keyring & { value?: string } {
  const k: Keyring & { value?: string } = {
    value,
    load: async () => k.value,
    save: async (v) => void (k.value = v),
    delete: async () => void (k.value = undefined),
  };
  return k;
}

const LAN: RouteDetails = { id: "lan", kind: "lan", target: "http://192.168.1.10:9119" };
const WEB: RouteDetails = { id: "web", kind: "web", target: "https://hermes.example.com", headers: [{ name: "CF-Access-Client-Secret", value: "s3cret" }] };
const SSH: RouteDetails = { id: "ssh", kind: "ssh", target: "liam@hermes" };
const base: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "liam", password: "hunter2" };

/** An account whose connect reports `server` as the install it reached. */
function account(server = "a1b2c3d4e5f60718293a4b5c6d7e8f90") {
  const fake = new FakeHermes();
  fake.route = { kind: "url", url: LAN.target, addresses: [], server };
  const store = storage();
  const connections = new Connections(store);
  const password = keyring();
  const headers = keyring();
  const a: Account = {
    connections,
    secrets: () => ({ password, headers, token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }),
    connect: async () => connect(fake.openPipe, "default"),
    readSaved: (_c, _d, reason) => readSaved(fake.openPipe, reason, memoryCache()),
    openSaved: () => undefined,
  };
  return { a, connections, store, password, headers };
}

describe("A connection with several routes", () => {
  it("is saved with its routes in order and the server it reached, its address the first route's", async () => {
    const { a, connections, store } = account();
    const c = connections.draft(base, "Home server");
    const d = withRoutes(base, [LAN, { ...WEB, off: true }, SSH]);
    const { connection } = await signIn(c, d, a);
    expect(connection).toMatchObject({
      mode: "url",
      url: LAN.target,
      routes: [
        { id: "lan", kind: "lan", target: LAN.target },
        { id: "web", kind: "web", target: WEB.target, off: true },
        { id: "ssh", kind: "ssh", target: "liam@hermes" },
      ],
      server: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    });
    // Headers are secrets: never in the list.
    expect(store.getItem(CONNECTIONS_KEY)).not.toContain("s3cret");
    expect(routesSummary(connection)).toBe("LAN, web address (off) and SSH");

    // Read back by another window, in the same order.
    const again = new Connections(store).get(c.id)!;
    expect(again.routes?.map((r) => r.id)).toEqual(["lan", "web", "ssh"]);
    expect(again.server).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  });

  it("reads a list it can't trust as no list: bad routes and a bad server id are dropped", () => {
    const store = storage();
    store.setItem(
      CONNECTIONS_KEY,
      JSON.stringify({
        v: 1,
        connections: [
          {
            id: "0d6f3c8e-1111-4a8a-9d2b-1f0e7c9a5b3d",
            name: "Home",
            mode: "ssh",
            sshTarget: "old@hermes",
            url: "",
            username: "liam",
            addedAt: 1,
            server: "not-a-hash",
            routes: [{ id: "BAD ID", kind: "lan", target: "x" }, { id: "t", kind: "teleport", target: "x" }, { id: "s", kind: "ssh", target: "liam@hermes" }, { id: "s", kind: "lan", target: "dupe" }],
          },
        ],
      }),
    );
    const c = new Connections(store).recent()[0];
    expect(c.routes).toEqual([{ id: "s", kind: "ssh", target: "liam@hermes" }]);
    expect(c.sshTarget).toBe("liam@hermes");
    expect(c.server).toBeUndefined();
  });

  it("keeps the first server id a route reports, and never replaces it on its own", () => {
    const { connections } = account();
    const c = connections.draft(base);
    connections.save(c);
    connections.setServer(c.id, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
    connections.setServer(c.id, "ffffffffffffffffffffffffffffffff");
    expect(connections.get(c.id)!.server).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  });
});

describe("The password of a connection with routes", () => {
  it("is saved for every route and the username, and given back with each route's own headers", async () => {
    const { a, connections, password, headers } = account();
    const c = connections.draft(base);
    await signIn(c, withRoutes(base, [LAN, WEB, SSH]), a);
    expect(JSON.parse(password.value!)).toEqual({
      v: 2,
      username: "liam",
      routes: [JSON.stringify(["url", LAN.target]), JSON.stringify(["url", WEB.target]), JSON.stringify(["ssh", "liam@hermes"])],
      password: "hunter2",
    });
    expect(JSON.parse(headers.value!)).toEqual({ v: 2, routes: [{ url: WEB.target, headers: WEB.headers }] });

    const saved = (await savedSignIn(connections.get(c.id)!, a))!;
    expect(saved.password).toBe("hunter2");
    expect(saved.server).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(saved.routes).toEqual([LAN, WEB, SSH]);
  });

  it("isn't given to a route added since that it wasn't saved for, until it is typed again", async () => {
    const { a, connections, password } = account();
    const c = connections.draft(base);
    await signIn(c, withRoutes(base, [LAN, SSH]), a);
    // Edited elsewhere: a Tailscale route added, whose secrets were never saved.
    const ts: RouteDetails = { id: "ts", kind: "tailscale", target: "http://100.101.102.103:9119" };
    connections.save({ ...connections.get(c.id)!, routes: [ts, LAN, SSH] });
    const saved = (await savedSignIn(connections.get(c.id)!, a))!;
    expect(saved.routes).toEqual([{ ...ts, locked: true }, LAN, SSH]);

    // A different username gets none of it.
    connections.save({ ...connections.get(c.id)!, username: "someone" });
    expect(await savedSignIn(connections.get(c.id)!, a)).toBeUndefined();
    // Nor does a list where no route is one it was saved for.
    connections.save({ ...connections.get(c.id)!, username: "liam", routes: [ts] });
    expect(await savedSignIn(connections.get(c.id)!, a)).toBeUndefined();

    // The sign-in screen's form has every route and no password; typing it saves it for all of them.
    const form = await signInForm(connections.get(c.id)!, a);
    expect([form.password, form.routes?.map((r) => r.id)]).toEqual(["", ["ts"]]);
    await signIn(connections.get(c.id)!, { ...form, password: "hunter2" }, a);
    expect(JSON.parse(password.value!).routes).toEqual([JSON.stringify(["url", ts.target])]);
  });

  it("from before routes, counts for the one route its address is", async () => {
    const { a, connections, password } = account();
    const c = { ...connections.draft({ ...base, sshTarget: "liam@hermes" }), routes: [LAN, SSH] };
    connections.save(c);
    password.value = JSON.stringify({ v: 1, for: addressKey({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }), password: "hunter2" });
    const saved = (await savedSignIn(connections.get(c.id)!, a))!;
    expect(saved.routes).toEqual([{ ...LAN, locked: true }, SSH]);
  });

  it("stays in the old form for a connection with one route, so nothing changes for it", async () => {
    const { a, connections, password, headers } = account();
    const one = { ...base, mode: "url" as const, url: WEB.target, headers: WEB.headers };
    const c = connections.draft(one);
    const { connection } = await signIn(c, one, a);
    expect(connection.routes).toBeUndefined();
    // Nor is it held to the server it reached: a reinstalled Hermes still signs in, as before.
    expect(connection.server).toBeUndefined();
    expect(JSON.parse(password.value!)).toEqual({ v: 1, for: addressKey(one), password: "hunter2" });
    expect(JSON.parse(headers.value!)).toEqual({ url: WEB.target, headers: WEB.headers });
  });
});

describe("Explaining a route", () => {
  const ssh: SignInDetails = { ...base, sshTarget: "liam@hermes" };
  const lan: SignInDetails = { ...base, mode: "url", url: LAN.target };

  it("names a wrong server, something that isn't Hermes, and plain http over the internet", () => {
    const wrong = explain(
      { stage: "reach", message: "Wrong server: a different Hermes server answered at this address than the one this connection signed in to before. Hermes Chat didn't send it the password." },
      lan,
    );
    expect(wrong).toMatchObject({ verdict: "wrong server", problem: expect.stringContaining("A different Hermes server answered at 192.168.1.10:9119") });
    const other = explain({ stage: "reach", message: "Wrong server: something answered at this address, but it isn't a Hermes dashboard. Hermes Chat didn't send it the password." }, lan);
    expect(other).toMatchObject({ verdict: "wrong server", problem: expect.stringContaining("isn't a Hermes dashboard") });
    const plain = explainSignIn("Plain http:// is only used on this computer, a LAN or Tailscale, and 203.0.113.7 is a public address. Use https:// or SSH to reach it.", lan);
    expect(plain).toMatchObject({ stage: "address", fixes: [expect.stringContaining("https://")] });
    expect(explain({ stage: "address", message: "SSH failed: Host key verification failed." }, ssh).verdict).toBe("wrong server");
  });

  it("says in a word or two how each route went", () => {
    expect(verdictOf({ stage: "reach", message: "The dashboard didn't answer within 5s." })).toBe("timed out");
    expect(verdictOf({ stage: "address", message: "SSH didn't open the tunnel within 10s." })).toBe("timed out");
    expect(verdictOf({ stage: "reach", message: "Can't reach the Hermes dashboard: error sending request: Connection refused (os error 111)" })).toBe("refused");
    expect(verdictOf({ stage: "sign-in", message: "Wrong username or password." })).toBe("sign-in failed");
    expect(verdictOf({ stage: "address", message: "Can't reach the Hermes dashboard: couldn't look up hermes" })).toBe("unreachable");
  });

  it("lists every route when none reached Hermes", () => {
    const why = explainSignIn("No route reached Hermes.\n• LAN, http://192.168.1.10:9119: timed out\n• SSH, ssh://liam@hermes: SSH failed: refused", lan);
    expect(why).toMatchObject({
      problem: "None of this connection's routes reached Hermes.",
      fixes: ["LAN, http://192.168.1.10:9119: timed out", "SSH, ssh://liam@hermes: SSH failed: refused"],
    });
  });
});

describe("Testing routes", () => {
  const ready = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
  /** A probe where the LAN route reaches `lanServer`, SSH reaches home, and the web address turns the password down. */
  const probe = (lanServer = "home"): Probe & { tried: SignInDetails[] } => {
    const tried: SignInDetails[] = [];
    return {
      tried,
      run: async (d) => {
        tried.push(d);
        const at = d.mode === "ssh" ? d.sshTarget : d.url;
        const server = at === LAN.target ? lanServer : "home";
        if (d.server && d.server !== server)
          throw { stage: "reach", message: "Wrong server: a different Hermes server answered at this address than the one this connection signed in to before. Hermes Chat didn't send it the password." };
        if (at === WEB.target) throw { stage: "sign-in", message: "Wrong username or password." };
        const route = d.mode === "ssh" ? { kind: "ssh" as const, target: at, server } : { kind: "url" as const, url: at, addresses: [], server };
        return { route, status: '{"version":"0.22.5"}', ready } satisfies Probed;
      },
      cancel: () => {},
    };
  };

  it("tests each route that is on, in order, holding the later ones to the server the first reached", async () => {
    const p = probe("neighbour");
    const seen: number[] = [];
    const tests = await testRoutes(p, withRoutes(base, [LAN, WEB, { ...SSH, off: true }, { id: "ssh2", kind: "ssh", target: "hermes-alias" }]), (t) =>
      seen.push(t.filter((x) => x.outcome).length),
    );
    // The LAN address answered first, as another machine: the routes after it are held to that one, so they say so.
    expect(tests.map((t) => [t.route.id, t.outcome?.ok ? "ok" : t.outcome && !t.outcome.ok && t.outcome.verdict])).toEqual([
      ["lan", "ok"],
      ["web", "wrong server"],
      ["ssh2", "wrong server"],
    ]);
    const home = await testRoutes(probe(), withRoutes(base, [LAN, WEB, SSH]));
    expect(home.map((t) => t.outcome?.ok || (t.outcome && !t.outcome.ok && t.outcome.verdict))).toEqual([true, "sign-in failed", true]);
    expect(seen).toEqual([1, 2, 3]);
    // Headers go only to their own route.
    expect(p.tried.map((d) => d.headers)).toEqual([[], WEB.headers, []]);
  });

  it("gives Settings' test the first route that works, or every route's failure", async () => {
    expect(await testSignIn(probe(), withRoutes(base, [WEB, SSH]))).toMatchObject({ ok: true, route: { kind: "ssh" } });
    const none = await testSignIn(probe("neighbour"), { ...withRoutes(base, [WEB, LAN]), server: "home" });
    expect(none).toMatchObject({
      ok: false,
      problem: "None of this connection's routes reached Hermes.",
      fixes: [expect.stringMatching(/^Web address, https:\/\/hermes.example.com: sign-in failed\./), expect.stringMatching(/^LAN, http:\/\/192.168.1.10:9119: wrong server\./)],
    });
  });
});
