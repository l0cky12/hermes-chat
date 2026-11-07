import { describe, expect, it, vi } from "vitest";
import { FakeHermes, fakeEnv } from "./fakeHermes";
import { connect } from "./transport";
import { explain, explainSignIn, isSetUp, missing, providerKeys, readStatus, readyProviders, testConnection, type Probe, type ProbeFailure, type Probed } from "./setup";
import type { SignInDetails } from "./tauriPipe";

const READY = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { skin: {} } } });
const STATUS = JSON.stringify({ version: "0.22.5", auth_required: true, auth_providers: ["basic", "conduit-local-live"] });
const ssh: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "hunter2" };
const url: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes.example.com:9119", username: "liam", password: "hunter2" };

/** A probe that answers once, with `probed` or by failing with `failure`. */
const answering = (answer: Probed | ProbeFailure): Probe => ({
  run: async () => {
    if ("stage" in answer) throw answer;
    return answer;
  },
  cancel: () => {},
});

describe("Whether this computer is set up", () => {
  it("counts any saved sign-in, so an existing install never sees first-run setup", () => {
    expect(isSetUp({ mode: "ssh", sshTarget: "", url: "", username: "" })).toBe(false);
    expect(isSetUp({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "" })).toBe(true);
    expect(isSetUp({ mode: "url", sshTarget: "", url: "http://hermes:9119", username: "liam" })).toBe(true);
    expect(isSetUp({ mode: "ssh", sshTarget: " ", url: "", username: "liam" })).toBe(true);
  });

  it("names what is missing before a test can run", () => {
    expect(missing(ssh)).toEqual([]);
    expect(missing({ ...ssh, sshTarget: " ", password: "" })).toEqual(["the SSH target", "the dashboard password"]);
    expect(missing({ ...url, url: "", username: "" })).toEqual(["the dashboard URL", "the dashboard username"]);
  });
});

describe("Testing a connection", () => {
  it("passes with the route, whether it's Unsecure, and the Hermes version", async () => {
    const route = { kind: "url" as const, url: url.url, addresses: ["203.0.113.5"] };
    expect(await testConnection(answering({ route, status: STATUS, ready: READY }), url)).toEqual({ ok: true, route, unsecure: true, version: "0.22.5" });
    const tailnet = { kind: "url" as const, url: "http://hermes:9119", addresses: ["100.100.64.121"] };
    expect(await testConnection(answering({ route: tailnet, status: null, ready: READY }), url)).toMatchObject({ ok: true, unsecure: false, version: undefined });
  });

  it("fails on a server that speaks the canonical protocol", async () => {
    const ready = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { session_authority: true } } });
    const out = await testConnection(answering({ route: { kind: "ssh", target: "liam@hermes" }, status: STATUS, ready }), ssh);
    expect(out).toMatchObject({ ok: false, stage: "chat", problem: "Hermes Chat can't talk to this server yet." });
  });

  it("fails when the first frame isn't gateway.ready", async () => {
    const out = await testConnection(answering({ route: { kind: "ssh", target: "liam@hermes" }, status: STATUS, ready: "{}" }), ssh);
    expect(out).toMatchObject({ ok: false, stage: "chat", detail: "Hermes's first message on the chat connection wasn't gateway.ready." });
  });

  it("explains a failure the probe reports, and anything else it throws", async () => {
    expect(await testConnection(answering({ stage: "sign-in", message: "Wrong username or password.", status: STATUS }), ssh)).toMatchObject({
      ok: false,
      stage: "sign-in",
      problem: "The dashboard turned down the username or password.",
      detail: undefined,
    });
    const broken: Probe = { run: async () => Promise.reject(new Error("IPC broke")), cancel: () => {} };
    expect(await testConnection(broken, ssh)).toMatchObject({ ok: false, stage: "address", detail: "IPC broke" });
  });
});

describe("Explaining a failed test", () => {
  const why = (f: ProbeFailure, d = ssh) => explain(f, d);

  it("tells an SSH key problem from a host key, a name and a server that's down", () => {
    expect(why({ stage: "address", message: "SSH failed: liam@hermes: Permission denied (publickey)." })).toMatchObject({
      problem: "The server didn't accept your SSH key.",
      fixes: expect.arrayContaining([expect.stringContaining("ssh-add"), "Check it from a terminal: ssh -o BatchMode=yes liam@hermes true"]),
    });
    expect(why({ stage: "address", message: "SSH failed: Host key verification failed." }).fixes[0]).toContain("ssh-keygen -R hermes");
    expect(why({ stage: "address", message: "SSH failed: ssh: Could not resolve hostname hermse: Name or service not known" }).problem).toBe(
      'This computer couldn\'t find the host "hermes".',
    );
    expect(why({ stage: "address", message: "SSH failed: ssh: connect to host 10.2.1.136 port 22: Connection timed out" }).problem).toBe(
      "The server didn't answer over SSH.",
    );
    expect(why({ stage: "address", message: "SSH didn't open the tunnel within 20s." }).problem).toBe("The server didn't answer over SSH.");
    expect(why({ stage: "address", message: "Couldn't start ssh: No such file or directory (os error 2)" }).fixes).toEqual([
      "Install OpenSSH: sudo pacman -S openssh",
    ]);
    expect(why({ stage: "address", message: "SSH failed: something new" })).toMatchObject({
      problem: "SSH couldn't open the tunnel to the server.",
      detail: "SSH failed: something new",
    });
  });

  it("tells a bad URL from a name that doesn't resolve", () => {
    const bad = "Enter the dashboard's URL, starting with http:// or https://, such as http://hermes:9119. Put the username and password in their own fields.";
    expect(why({ stage: "address", message: bad }, url)).toMatchObject({ problem: bad, detail: undefined, fixes: [] });
    expect(
      why({ stage: "address", message: "Can't reach the Hermes dashboard: couldn't look up hermes.example.com: failed to lookup address" }, url).problem,
    ).toBe('This computer couldn\'t find "hermes.example.com:9119".');
  });

  it("says nothing listens at a URL, or on the server's port through SSH", () => {
    const refused = "Can't reach the Hermes dashboard: error sending request: client error (Connect): tcp connect error: Connection refused (os error 111)";
    expect(why({ stage: "reach", message: refused }, url).problem).toBe("Nothing is listening at hermes.example.com:9119.");
    expect(why({ stage: "reach", message: refused }, ssh)).toMatchObject({
      problem: "The tunnel opened, but nothing answered on the server's port 9119.",
      fixes: ["Start the dashboard on the server: hermes dashboard"],
    });
    expect(why({ stage: "reach", message: "Can't reach the Hermes dashboard: invalid peer certificate: UnknownIssuer" }, url).problem).toBe(
      "This computer doesn't trust the server's HTTPS certificate.",
    );
    expect(why({ stage: "reach", message: "The dashboard didn't answer within 15s." }, url).problem).toBe("Nothing answered at hermes.example.com:9119 in time.");
  });

  it("points a gateway's refusal or redirect at the extra request headers", () => {
    const refused = { stage: "reach", message: "The dashboard answered 403: Forbidden. You don't have permission to view this." } as const;
    expect(why(refused, url)).toMatchObject({
      problem: "Something in front of the dashboard at hermes.example.com:9119 turned Hermes Chat away.",
      fixes: [expect.stringContaining("add the headers it needs under Extra request headers"), "Or connect over SSH, which goes straight to the dashboard."],
      detail: refused.message,
    });
    const withHeaders = { ...url, headers: [{ name: "CF-Access-Client-Id", value: "id" }] };
    expect(why(refused, withHeaders).fixes[0]).toMatch(/^Check the extra request headers' names and values/);
    const away = "The dashboard sent Hermes Chat on to https://team.cloudflareaccess.com, another site. Hermes Chat doesn't follow it there.";
    expect(why({ stage: "reach", message: away }, withHeaders).problem).toBe("The dashboard's address sent Hermes Chat on to another site.");
    const awayHidden = "The dashboard sent Hermes Chat on to another site, whose address isn't shown, as it may repeat your extra request headers. Hermes Chat doesn't follow it there, so your headers aren't sent to it.";
    expect(why({ stage: "reach", message: awayHidden }, withHeaders).problem).toBe("The dashboard's address sent Hermes Chat on to another site.");
    // Past the first request, a refusal whose body Rust hid for the headers' sake still points at them.
    const hidden = "The dashboard answered 403: (not shown, as it may repeat your extra request headers)";
    const closed = "The chat connection closed before Hermes was ready: closed by the server (1008 (not shown, as it may repeat your extra request headers))";
    for (const [stage, message] of [["sign-in", hidden], ["chat", hidden], ["chat", closed]] as const) {
      expect(why({ stage, message, status: STATUS }, withHeaders)).toMatchObject({
        problem: "Something in front of the dashboard at hermes.example.com:9119 turned Hermes Chat away.",
        fixes: [expect.stringMatching(/^Check the extra request headers' names and values/), "Or connect over SSH, which goes straight to the dashboard."],
      });
    }
  });

  it("explains sign-in failures from the dashboard's own status", () => {
    expect(why({ stage: "sign-in", message: "Too many sign-in attempts. Wait a minute and try again.", status: STATUS }).fixes).toEqual([
      "Wait a minute, then try again.",
    ]);
    const tokenOnly = JSON.stringify({ version: "0.22.5", auth_required: true, auth_providers: ["session-token"] });
    expect(why({ stage: "sign-in", message: 'The dashboard answered 404: {"detail":"Unknown provider"}', status: tokenOnly })).toMatchObject({
      problem: "This dashboard doesn't offer username and password sign-in, which Hermes Chat uses.",
      fixes: expect.arrayContaining(["It offers: session-token."]),
    });
    expect(why({ stage: "sign-in", message: "The dashboard answered 404: <html>Not Found</html>", status: null }, url).problem).toBe(
      "Something answered at this address, but it isn't a Hermes dashboard.",
    );
    expect(why({ stage: "sign-in", message: 'The dashboard answered 503: {"detail":"provider unreachable"}', status: STATUS }).problem).toBe(
      "The dashboard's sign-in isn't available right now.",
    );
  });

  it("explains a chat connection that a proxy blocks", () => {
    expect(why({ stage: "chat", message: "The chat connection failed: HTTP error: 400 Bad Request" }).fixes[0]).toContain("WebSocket");
  });
});

describe("Explaining what the sign-in screen shows", () => {
  it("shows Sign out's keyring note as it is, not as an unreachable server", () => {
    const note = "Signed out, but couldn't delete the saved password from the system keyring: no Secret Service on the bus";
    const why = explainSignIn(note, { mode: "url", sshTarget: "", url: "http://hermes:9119", username: "liam", password: "", headers: [] });
    expect([why.problem, why.fixes]).toEqual([note, []]);
  });
});

describe("Reading the dashboard's status", () => {
  it("reads a Hermes dashboard's version and sign-in methods, and nothing from another server", () => {
    expect(readStatus(STATUS)).toEqual({ version: "0.22.5", authRequired: true, authProviders: ["basic", "conduit-local-live"] });
    expect(readStatus('{"status":"ok"}')).toBeUndefined();
    expect(readStatus("<html>")).toBeUndefined();
    expect(readStatus(null)).toBeUndefined();
  });
});

describe("Model provider keys", () => {
  it("lists one key per provider, its primary one, best known first, and nothing that isn't a provider key", () => {
    expect(providerKeys(fakeEnv())).toEqual([
      { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", isSet: true, preview: "sk-…f3", url: "https://openrouter.ai/keys" },
      { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", isSet: false, url: "https://console.anthropic.com/settings/keys" },
      { provider: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", isSet: false, url: "https://platform.deepseek.com/api_keys" },
      { provider: "alibaba", label: "Alibaba Cloud (DashScope)", envVar: "DASHSCOPE_API_KEY", isSet: false },
      { provider: "alibaba-cn", label: "Alibaba Cloud China", envVar: "DASHSCOPE_API_KEY", isSet: false },
    ]);
    expect(providerKeys(undefined)).toEqual([]);
    expect(providerKeys([1, 2])).toEqual([]);
  });

  it("counts a provider as having a key when any of its variables is set", () => {
    const env = fakeEnv();
    env.ANTHROPIC_TOKEN.is_set = true;
    expect(providerKeys(env).find((k) => k.provider === "anthropic")).toMatchObject({ envVar: "ANTHROPIC_API_KEY", isSet: true });
  });

  it("names the providers Hermes can use now", () => {
    expect(readyProviders({ providers: [{ slug: "nous", name: "Nous Portal", authenticated: true }, { slug: "openrouter", authenticated: false }, { slug: "x", authenticated: true }] })).toEqual([
      "Nous Portal",
      "x",
    ]);
    expect(readyProviders(undefined)).toEqual([]);
  });

  it("reads them from Hermes for the shown profile", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const setup = await hermes.providerSetup();
    expect(setup.ready).toEqual(["Anthropic", "OpenAI"]);
    expect(setup.keys.map((k) => k.provider)).toEqual(["openrouter", "anthropic", "deepseek", "alibaba", "alibaba-cn"]);
    expect(server.restRequests.find((r) => r.path === "/api/env")?.query.get("profile")).toBe("default");
    await hermes.close();
  });

  it("gives up on a list Hermes never sends, so it can be asked again", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    server.rest["GET /api/env"] = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const asked = hermes.providerSetup();
      const outcome = expect(asked).rejects.toThrow("Hermes didn't answer in time.");
      await vi.advanceTimersByTimeAsync(20_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
    await hermes.close();
  });

  it("says when the server can't take keys from Hermes Chat", async () => {
    const server = new FakeHermes();
    server.env = undefined;
    const hermes = await connect(server.openPipe);
    expect(await hermes.providerSetup()).toMatchObject({ keys: [], unsupported: expect.stringContaining("404") });
    await hermes.close();
  });

  it("saves a key the provider accepts for the shown profile, and reads the models again", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    await hermes.loadModels();
    const asked = server.requests.filter((r) => r.method === "model.options").length;
    expect(await hermes.saveProviderKey("ANTHROPIC_API_KEY", " sk-ant-good ")).toEqual({ verified: true });
    expect(server.savedKeys).toEqual([{ profile: "default", envVar: "ANTHROPIC_API_KEY", key: "sk-ant-good" }]);
    await hermes.idle();
    expect(server.requests.filter((r) => r.method === "model.options").length).toBe(asked + 1);
    expect((await hermes.providerSetup()).keys.find((k) => k.provider === "anthropic")?.isSet).toBe(true);
    await hermes.close();
  });

  it("doesn't save a key the provider turns down, nor anything that isn't a provider key", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    await expect(hermes.saveProviderKey("ANTHROPIC_API_KEY", "sk-bad")).rejects.toThrow("The provider turned the key down.");
    await expect(hermes.saveProviderKey("TELEGRAM_BOT_TOKEN", "sk-good")).rejects.toThrow("doesn't relay");
    expect(server.savedKeys).toEqual([]);
    expect(await hermes.saveProviderKey("ANTHROPIC_API_KEY", "sk-offline")).toEqual({ verified: false });
    await hermes.close();
  });

  it("removes a key for the shown profile, and reads the models again", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    await hermes.loadModels();
    const asked = server.requests.filter((r) => r.method === "model.options").length;
    await hermes.removeProviderKey("OPENROUTER_API_KEY");
    expect(server.removedKeys).toEqual([{ profile: "default", envVar: "OPENROUTER_API_KEY" }]);
    await hermes.idle();
    expect(server.requests.filter((r) => r.method === "model.options").length).toBe(asked + 1);
    expect((await hermes.providerSetup()).keys.find((k) => k.provider === "openrouter")?.isSet).toBe(false);
    await expect(hermes.removeProviderKey("TELEGRAM_BOT_TOKEN")).rejects.toThrow("doesn't relay");
    expect(server.removedKeys).toHaveLength(1);
    await hermes.close();
  });
});
