import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import type { OpenPipe, Route } from "./pipe";
import { connect } from "./transport";

async function signedIn(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  return {
    server,
    hermes,
    status: () => hermes.getSnapshot().status,
    chat: (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!,
  };
}

const sessionLists = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/sessions").length;
const resumes = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.resume");

describe("Reconnecting", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("reconnects after the connection drops, and refreshes the chat list", async () => {
    const { server, hermes, status } = await signedIn();
    server.drop("closed by the server (1006 )");
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: "closed by the server (1006 )" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.opened).toBe(2);
    expect(status()).toBe("connected");
    expect(hermes.getSnapshot().closedReason).toBeUndefined();
    await hermes.idle();
    expect(sessionLists(server)).toBe(1);
  });

  it("sends nothing while reconnecting", async () => {
    const { server, hermes } = await signedIn();
    server.drop();
    await expect(hermes.newChat()).rejects.toThrow("Not connected");
  });

  it("waits longer after each failed try, then goes Offline", async () => {
    const { server, status, hermes } = await signedIn();
    server.refuse = "Can't reach the Hermes dashboard: connection refused";
    server.drop();
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(status()).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(16_000);
    expect(hermes.getSnapshot()).toMatchObject({ status: "offline", closedReason: "Can't reach the Hermes dashboard: connection refused" });

    // No more tries until asked.
    server.refuse = undefined;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(status()).toBe("offline");
    expect(server.opened).toBe(1);
  });

  it("reconnects from Offline when asked", async () => {
    const { server, hermes, status } = await signedIn();
    server.refuse = "SSH failed: Connection timed out";
    server.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status()).toBe("offline");

    server.refuse = undefined;
    const reconnecting = hermes.reconnect();
    expect(status()).toBe("reconnecting");
    await reconnecting;
    expect(status()).toBe("connected");
  });

  it("goes Offline at once if the server now speaks the canonical protocol", async () => {
    const { server, hermes } = await signedIn();
    server.readyPayload = { ...server.readyPayload, session_authority: true };
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes.getSnapshot()).toMatchObject({ status: "offline", closedReason: expect.stringContaining("canonical") });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.opened).toBe(2);
  });

  it("stops trying once the app closes the connection", async () => {
    const { server, hermes } = await signedIn();
    server.drop();
    await hermes.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.opened).toBe(1);
  });

  it("fails to connect if the connection closes just after gateway.ready", async () => {
    const server = new FakeHermes();
    const closesAfterReady: OpenPipe = async (onEvent, profile) => {
      const pipe = await server.openPipe(onEvent, profile);
      onEvent({ kind: "closed", reason: "closed by the server (1011 )" });
      return pipe;
    };
    await expect(connect(closesAfterReady)).rejects.toThrow("closed before Hermes was ready: closed by the server (1011 )");
  });

  it("lets the dropped pipe finish closing before opening the next", async () => {
    const server = new FakeHermes();
    let finishClosing!: () => void;
    const slowToClose: OpenPipe = async (onEvent, profile) => {
      const pipe = await server.openPipe(onEvent, profile);
      return { ...pipe, close: () => new Promise<void>((res) => (finishClosing = res)) };
    };
    const hermes = await connect(slowToClose);
    server.drop();
    const reconnecting = hermes.reconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.opened).toBe(1);

    finishClosing();
    await reconnecting;
    expect(server.opened).toBe(2);
    expect(hermes.getSnapshot().status).toBe("connected");
  });

  it("gives up a reconnect under way when the app closes the connection", async () => {
    const server = new FakeHermes();
    let silent = false;
    const hermes = await connect(async (onEvent, profile) => server.openPipe((e) => !silent && onEvent(e), profile));
    server.drop();
    silent = true; // The next pipe never sends gateway.ready.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.opened).toBe(2);
    await hermes.close();
    expect(server.closed).toBe(true);
  });

  it("resumes the shown chat again after reconnecting, and shows its history once", async () => {
    const server = new FakeHermes();
    server.sessions = [row("tg", 2, { source: "telegram" })];
    server.transcripts = { tg: [{ role: "user", text: "How full is the NAS?" }, { role: "assistant", text: "82% used." }] };
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    await hermes.open("tg");

    server.drop();
    expect(chat("tg").runtimeId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.open("tg");

    expect(resumes(server)).toHaveLength(2);
    expect(chat("tg").runtimeId).toBe(server.runtimeIdOf("tg"));
    expect(chat("tg").items.map((i) => ("text" in i ? i.text : i.kind))).toEqual(["How full is the NAS?", "82% used."]);
  });

  it("keeps a reply sent after reconnecting below the reloaded history", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true })];
    server.transcripts = { a: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello!" }] };
    const { hermes, chat } = await signedIn(server);
    await hermes.sync();
    await hermes.open("a");
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);

    await hermes.send("a", "Still there?");
    expect(chat("a").items.map((i) => ("text" in i ? i.text : i.kind))).toEqual(["hi", "Hello!", "Still there?"]);
  });

  it("drops a connection that has stopped answering and reconnects", async () => {
    const { server, status } = await signedIn();
    const ping = server.handlers["gateway.ping"];
    server.handlers["gateway.ping"] = () => {};
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status()).toBe("connected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status()).toBe("reconnecting");
    expect(server.closed).toBe(true);

    server.handlers["gateway.ping"] = ping;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status()).toBe("connected");
  });

  it("stays connected while Hermes answers its pings", async () => {
    const { server, status } = await signedIn();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(status()).toBe("connected");
    expect(server.requests.filter((r) => r.method === "gateway.ping").length).toBeGreaterThan(5);
  });
});

describe("Unsecure", () => {
  const url = (u: string, addresses: string[] = []): Route => ({ kind: "url", url: u, addresses });

  it.each<[string, Route, boolean]>([
    ["SSH, always encrypted", { kind: "ssh", target: "liam@203.0.113.7" }, false],
    ["https", url("https://hermes.example.com"), false],
    ["wss", url("wss://hermes.example.com/hermes"), false],
    ["http to a public name", url("http://hermes.example.com:9119", ["203.0.113.7"]), true],
    ["ws to a public name", url("ws://hermes.example.com:9119"), true],
    ["http to a LAN address", url("http://10.2.1.136:9119"), true],
    ["http to loopback", url("http://127.0.0.1:9119"), false],
    ["http to IPv6 loopback", url("http://[::1]:9119"), false],
    ["http to localhost", url("http://localhost:9119", ["127.0.0.1", "::1"]), false],
    ["http to a MagicDNS name", url("http://hermes.tail1234.ts.net:9119", ["100.100.64.121"]), false],
    ["http to a Tailscale IPv4 address", url("http://100.100.64.121:9119"), false],
    ["http to the top of the Tailscale range", url("http://100.127.255.255:9119"), false],
    ["http just past the Tailscale range", url("http://100.128.0.1:9119"), true],
    ["http just before the Tailscale range", url("http://100.63.255.255:9119"), true],
    ["http to a Tailscale IPv6 address", url("http://[fd7a:115c:a1e0:ab12:4843:cd96:6264:4079]:9119"), false],
    ["http to an IPv6 ULA outside Tailscale's", url("http://[fd7a:115c:a1e1::1]:9119"), true],
    ["http to an IPv4-mapped Tailscale address", url("http://[::ffff:100.100.64.121]:9119"), false],
    ["http to a bare name in the Tailscale range", url("http://hermes:9119", ["100.100.64.121"]), false],
    ["http to a bare name on Tailscale IPv6", url("http://hermes:9119", ["fd7a:115c:a1e0::5"]), false],
    ["http to a bare name on the LAN", url("http://hermes:9119", ["10.2.1.136"]), true],
    ["http to a bare name with one address outside", url("http://hermes:9119", ["100.100.64.121", "10.2.1.136"]), true],
    ["http to a bare name that didn't resolve", url("http://hermes:9119"), true],
    ["http to a dotted name in the Tailscale range", url("http://hermes.example.com:9119", ["100.100.64.121"]), true],
    ["http to ts.net itself", url("http://ts.net:9119"), true],
  ])("%s", async (_what, route, unsecure) => {
    const server = new FakeHermes();
    server.route = route;
    const { hermes } = await signedIn(server);
    expect(hermes.getSnapshot()).toMatchObject({ route, unsecure });
  });

  it("follows the route of the latest connection", async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeHermes();
      server.route = url("http://hermes:9119", ["100.100.64.121"]);
      const { hermes } = await signedIn(server);
      server.route = url("http://hermes:9119", ["10.2.1.136"]);
      server.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hermes.getSnapshot()).toMatchObject({ status: "connected", unsecure: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
