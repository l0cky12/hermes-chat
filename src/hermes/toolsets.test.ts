// Settings → Toolsets' reads and writes against the fake dashboard, which mirrors `hermes_cli/web_routers/tools.py` at
// the deployed `bf0203a`: discovery, the write check, compare-before-write, read-back, and profile isolation.
import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";
import { PROBE_NAME, UnsupportedServerError, failureOf } from "./toolsets";
import { RestError } from "./pipe";

async function connected(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe, "default");
  return { server, hermes, api: hermes.toolsets };
}

const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}?${r.query}`, r.body]);
const enabledIn = (server: FakeHermes, profile: string) => [...server.enabledToolsets(profile)].sort();

describe("toolset discovery", () => {
  it("lists the profile's toolsets as Hermes resolves them, with their scope", async () => {
    const { server, api } = await connected();
    const list = await api.list("default");
    expect(list.profile).toBe("default");
    expect(list.toolsets.map((t) => [t.name, t.enabled])).toEqual([
      ["web", true],
      ["terminal", true],
      ["file", true],
      ["image_gen", false],
      ["stt", true],
      ["discord", false],
      ["computer_use", false],
    ]);
    const web = list.toolsets[0];
    expect(web).toMatchObject({ label: "Web Search & Scraping", description: "web_search, web_extract", platform: "cli", configured: true, configOnly: false });
    expect(list.toolsets.find((t) => t.name === "image_gen")?.configured).toBe(false);
    expect(list.toolsets.find((t) => t.name === "stt")?.configOnly).toBe(true);
    expect(list.toolsets.find((t) => t.name === "discord")).toMatchObject({ platform: "discord", platformLabel: "Discord" });
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/tools/toolsets" });
    expect(server.restRequests.at(-1)?.query.get("profile")).toBe("default");
  });

  it("says when the server has no toolset routes", async () => {
    const server = new FakeHermes();
    server.toolsetRoutes = "none";
    const { api } = await connected(server);
    await expect(api.list("default")).rejects.toBeInstanceOf(UnsupportedServerError);
    await expect(api.list("default")).rejects.toThrow("no /api/tools/toolsets route");
  });

  it("checks whether changes are taken without changing anything", async () => {
    const { server, api } = await connected();
    const before = enabledIn(server, "default");
    expect(await api.writeSupport("default")).toEqual({ ok: true });
    expect(writes(server)).toEqual([[`PUT /api/tools/toolsets/${PROBE_NAME}?profile=default`, { enabled: "probe" }]]);
    expect(server.toolsetWrites).toEqual([]);
    expect(enabledIn(server, "default")).toEqual(before);
  });

  it("finds a server that lists toolsets but can't change them", async () => {
    const server = new FakeHermes();
    server.toolsetRoutes = "read-only";
    const { api } = await connected(server);
    expect((await api.list("default")).toolsets.length).toBeGreaterThan(0);
    expect(await api.writeSupport("default")).toEqual({ ok: false, reason: expect.stringContaining("no route to change them") });
  });

  it("finds a sign-in Hermes won't let change toolsets", async () => {
    const { server, api } = await connected();
    // A gateway or plugin in front of the route refusing the caller.
    server.rest[`PUT /api/tools/toolsets/${PROBE_NAME}`] = () => {
      throw new RestError(403, `{"detail":"Read-only dashboard session"}`);
    };
    expect(await api.writeSupport("default")).toEqual({ ok: false, reason: "Hermes doesn't let this sign-in change toolsets: Read-only dashboard session" });
  });

  it("knows when enabling starts an install, and not for providers the toggle leaves to hermes tools", async () => {
    const { api } = await connected();
    const list = await api.list("default");
    const t = (name: string) => list.toolsets.find((x) => x.name === name)!;
    expect(await api.cautions("default", t("computer_use"), true)).toEqual([{ kind: "install", keys: ["cua_driver"] }]);
    // Web's ddgs row needs setup, but the toggle never installs it (`_POST_SETUP_INSTALLED` at bf0203a).
    expect(await api.cautions("default", t("web"), true)).toEqual([]);
    expect(await api.cautions("default", t("computer_use"), false)).toEqual([]);
  });

  it("says what it couldn't check instead of treating it as safe", async () => {
    const { server, api } = await connected();
    const list = await api.list("default");
    const t = (name: string) => list.toolsets.find((x) => x.name === name)!;
    server.toolsetConfigFailure = new RestError(500, "{}");
    expect(await api.cautions("default", t("computer_use"), true)).toEqual([{ kind: "unchecked", what: expect.stringContaining("starts an install") }]);
    server.toolsetConfigFailure = undefined;
    server.toolsetGuardsFailure = new RestError(500, "{}");
    expect(await api.cautions("default", t("web"), false)).toEqual([{ kind: "unchecked", what: expect.stringContaining("no_mcp") }]);
    // Speech-to-text has its own section: neither applies.
    expect(await api.cautions("default", t("stt"), false)).toEqual([]);
  });

  it("warns that a change clears no_mcp, and reports it cleared once read back", async () => {
    const { server, api } = await connected();
    server.toolsetNoMcp.default = new Set(["cli"]);
    const list = await api.list("default");
    const web = list.toolsets.find((x) => x.name === "web")!;
    expect(await api.cautions("default", web, false)).toEqual([{ kind: "noMcp", platform: "cli" }]);
    // A Discord toolset writes Discord's list, which has no no_mcp.
    expect(await api.cautions("default", list.toolsets.find((x) => x.name === "discord")!, true)).toEqual([]);
    // Sent only with that caution confirmed.
    expect(await api.set("default", "web", false, true)).toMatchObject({ kind: "confirm", cautions: [{ kind: "noMcp", platform: "cli" }] });
    expect(server.toolsetWrites).toEqual([]);
    expect(await api.set("default", "web", false, true, [{ kind: "noMcp", platform: "cli" }])).toMatchObject({ kind: "saved", mcpBack: true });
    expect((await api.guards("default"))?.noMcp).toEqual([]);
  });

  it("asks before turning on a toolset agent.disabled_toolsets turns off everywhere, and reports it cleared once read back", async () => {
    const { server, api } = await connected();
    server.toolsetDisabledEverywhere.default = ["image_gen", "debugging"];
    // Another profile's list is its own.
    expect((await api.guards("work"))?.disabledEverywhere).toEqual([]);
    const list = await api.list("default");
    const t = (name: string) => list.toolsets.find((x) => x.name === name)!;
    expect(await api.cautions("default", t("image_gen"), true)).toEqual([{ kind: "everywhere", name: "image_gen" }]);
    // Turning something off, or on when it isn't listed there, clears nothing from that list.
    expect(await api.cautions("default", t("web"), false)).toEqual([]);
    expect(await api.cautions("default", t("discord"), true)).toEqual([]);
    expect(await api.set("default", "image_gen", true, false)).toMatchObject({ kind: "confirm", cautions: [{ kind: "everywhere", name: "image_gen" }] });
    expect(server.toolsetWrites).toEqual([]);
    expect(await api.set("default", "image_gen", true, false, [{ kind: "everywhere", name: "image_gen" }])).toMatchObject({ kind: "saved", everywhereBack: true });
    // Only the name turned on left the list; the composite stays.
    expect((await api.guards("default"))?.disabledEverywhere).toEqual(["debugging"]);
  });

  it("doesn't report no_mcp or agent.disabled_toolsets cleared when the read afterwards can't tell", async () => {
    const { server, api } = await connected();
    server.toolsetNoMcp.default = new Set(["cli"]);
    server.toolsetDisabledEverywhere.default = ["image_gen"];
    // Another client saves both lists in a form Rust can't read for certain, right as the change lands.
    let release!: () => void;
    server.toolsetGate = new Promise((r) => (release = r));
    const accepted = [
      { kind: "noMcp", platform: "cli" },
      { kind: "everywhere", name: "image_gen" },
    ] as const;
    const done = api.set("default", "image_gen", true, false, [...accepted]);
    await new Promise((r) => setTimeout(r, 0));
    while (!server.toolsetWrites.length) await new Promise((r) => setTimeout(r, 1));
    server.toolsetNoMcpUnclear.default = ["cli"];
    server.toolsetDisabledUnclear.default = true;
    release();
    const r = await done;
    expect(r).toMatchObject({ kind: "saved" });
    expect(r).not.toHaveProperty("mcpBack");
    expect(r).not.toHaveProperty("everywhereBack");
  });

  it("says it couldn't check no_mcp when Rust can't read the platform's list for certain", async () => {
    const { server, api } = await connected();
    server.toolsetNoMcpUnclear.default = ["cli"];
    const list = await api.list("default");
    const web = list.toolsets.find((x) => x.name === "web")!;
    const check = [{ kind: "unchecked", what: expect.stringContaining("no_mcp, which any change here clears: the profile saves that platform's list") }];
    // Either way: Hermes clears no_mcp on any save.
    expect(await api.cautions("default", web, false)).toEqual(check);
    expect(await api.cautions("default", list.toolsets.find((x) => x.name === "discord")!, true)).toEqual([]);
    expect(await api.set("default", "web", false, true)).toMatchObject({ kind: "confirm", cautions: check });
    expect(server.toolsetWrites).toEqual([]);
  });

  it("says it couldn't check agent.disabled_toolsets when Rust can't read that list for certain", async () => {
    const { server, api } = await connected();
    server.toolsetDisabledUnclear.default = true;
    const list = await api.list("default");
    const image = list.toolsets.find((x) => x.name === "image_gen")!;
    const check = [{ kind: "unchecked", what: expect.stringContaining("can't read for certain") }];
    expect(await api.cautions("default", image, true)).toEqual(check);
    expect(await api.cautions("default", list.toolsets.find((x) => x.name === "web")!, false)).toEqual([]);
    expect(await api.set("default", "image_gen", true, false)).toMatchObject({ kind: "confirm", cautions: check });
    expect(server.toolsetWrites).toEqual([]);
    const [asked] = (await api.cautions("default", image, true)) as { kind: "unchecked"; what: string }[];
    expect(await api.set("default", "image_gen", true, false, [asked])).toMatchObject({ kind: "saved" });
  });

  it("says it couldn't check agent.disabled_toolsets when the config can't be read, before turning one on", async () => {
    const { server, api } = await connected();
    const web = (await api.list("default")).toolsets.find((x) => x.name === "web")!;
    server.toolsetGuardsFailure = new RestError(500, "{}");
    expect(await api.cautions("default", { ...web, enabled: false }, true)).toEqual([{ kind: "unchecked", what: expect.stringContaining("agent.disabled_toolsets") }]);
    expect(await api.cautions("default", web, false)).toEqual([{ kind: "unchecked", what: expect.not.stringContaining("agent.disabled_toolsets") }]);
  });

  it("names the provider that keeps a toolset from working, beyond Hermes's key check", async () => {
    const { server, api } = await connected();
    server.toolsetProviders.stt = [{ name: "Local Whisper", status: "needs_setup", is_active: true }];
    server.toolsetProviders.image_gen = [{ name: "FAL.ai", status: "needs_keys", is_active: false }];
    const problems = await api.setupProblems("default", await api.list("default"));
    expect(problems).toEqual({
      stt: "Its provider, Local Whisper, isn't installed or set up on the server.",
      image_gen: "None of its providers is ready on the server.",
      computer_use: "None of its providers is ready on the server.",
    });
    // Web has no active provider but a ready one (Exa's keyless row).
    expect(problems.web).toBeUndefined();
    // Web's search and extract can each have an active provider: one ready doesn't hide the other.
    server.toolsetProviders.web = [
      { name: "Firecrawl Self-Hosted", status: "ready", is_active: true },
      { name: "OpenAI Native", status: "needs_auth", is_active: true },
    ];
    expect((await api.setupProblems("default", await api.list("default"))).web).toBe("Its provider, OpenAI Native, needs a sign-in on the server.");
  });

  it("asks again when the check right before the write finds what the owner wasn't asked about", async () => {
    const { server, api } = await connected();
    const install = [{ kind: "install" as const, keys: ["cua_driver"] }];
    server.enabledToolsets("default").delete("computer_use");
    // Confirmed for the install; meanwhile another client sets no_mcp.
    server.toolsetNoMcp.default = new Set(["cli"]);
    const r = await api.set("default", "computer_use", true, false, install);
    expect(r).toMatchObject({ kind: "confirm", cautions: [...install, { kind: "noMcp", platform: "cli" }] });
    expect(server.toolsetWrites).toEqual([]);
    expect(server.toolsetNoMcp.default.has("cli")).toBe(true);
  });
});

describe("changing a toolset", () => {
  it("writes only `enabled` for the named profile and reports saved once read back", async () => {
    const { server, api } = await connected();
    const r = await api.set("default", "web", false, true);
    expect(r.kind).toBe("saved");
    expect(writes(server)).toEqual([["PUT /api/tools/toolsets/web?profile=default", { enabled: false }]]);
    expect(server.enabledToolsets("default").has("web")).toBe(false);
    // Read before (compare) and after (verify).
    const reads = server.restRequests.filter((q) => q.method === "GET" && q.path === "/api/tools/toolsets");
    expect(reads).toHaveLength(2);
    if (r.kind === "saved") expect(r.list.toolsets.find((t) => t.name === "web")?.enabled).toBe(false);
  });

  it("keeps every other toolset as it was", async () => {
    const { server, api } = await connected();
    await api.set("default", "image_gen", true, false);
    expect(enabledIn(server, "default")).toEqual(["file", "image_gen", "stt", "terminal", "web"]);
  });

  it("reports an install Hermes started for it", async () => {
    const { api } = await connected();
    const install = [{ kind: "install" as const, keys: ["cua_driver"] }];
    expect(await api.set("default", "computer_use", true, false, install)).toMatchObject({ kind: "saved", installing: "cua_driver" });
  });

  it("sends nothing when another client changed it since it was shown", async () => {
    const { server, api } = await connected();
    await api.list("default");
    server.enabledToolsets("default").delete("terminal"); // Turned off in the official desktop app meanwhile.
    const r = await api.set("default", "terminal", false, true);
    expect(r).toMatchObject({ kind: "conflict", now: false });
    expect(server.toolsetWrites).toEqual([]);
    if (r.kind === "conflict") expect(r.list.toolsets.find((t) => t.name === "terminal")?.enabled).toBe(false);
  });

  it("sends nothing for a toolset Hermes no longer lists", async () => {
    const { server, api } = await connected();
    server.toolsetCatalog = server.toolsetCatalog.filter((t) => t.name !== "web");
    expect(await api.set("default", "web", false, true)).toMatchObject({ kind: "conflict" });
    expect(server.toolsetWrites).toEqual([]);
  });

  it("reports a refusal as nothing changed, with Hermes's reason", async () => {
    const { server, api } = await connected();
    server.toolsetRefusal = { status: 403, detail: "Profile is managed by an administrator" };
    const r = await api.set("default", "web", false, true);
    expect(r).toMatchObject({ kind: "rejected", reason: "Profile is managed by an administrator" });
    expect(server.enabledToolsets("default").has("web")).toBe(true);
    if (r.kind === "rejected") expect(r.list?.toolsets.find((t) => t.name === "web")?.enabled).toBe(true);
  });

  it("reads back after an error answer instead of assuming nothing changed", async () => {
    const { server, api } = await connected();
    server.failAfterToolsetWrite = { status: 500, detail: "post-write hook failed" };
    expect(await api.set("default", "web", false, true)).toMatchObject({ kind: "saved", warning: "post-write hook failed" });
    expect(server.enabledToolsets("default").has("web")).toBe(false);
  });

  it("treats a server error it can't read back as unknown, not as nothing changed", async () => {
    const { server, api } = await connected();
    // As when the profile's folder can't be written: the save fails with a 500, and so does the read after it.
    server.failAfterToolsetWrite = { status: 500, detail: "Internal Server Error" };
    server.toolsetReadsFailAfterWrite = true;
    expect(await api.set("default", "web", false, true)).toMatchObject({ kind: "unknown", reason: "Internal Server Error" });
  });

  it("keeps a server error unconfirmed even when the read disagrees: the save may have gone in", async () => {
    const { server, api } = await connected();
    // The save lands, a later step fails with a 500, and agent.disabled_toolsets still resolves it off.
    server.toolsetSuppressed.add("image_gen");
    server.failAfterToolsetWrite = { status: 500, detail: "Internal Server Error" };
    const r = await api.set("default", "image_gen", true, false);
    expect(r).toMatchObject({ kind: "unknown", reason: "Internal Server Error" });
    expect(server.enabledToolsets("default").has("image_gen")).toBe(true);
  });

  it("doesn't claim success when Hermes reads it back the other way", async () => {
    const { server, api } = await connected();
    // `agent.disabled_toolsets` strips it through a composite: the save goes in, the read-back is still off.
    server.toolsetSuppressed.add("image_gen");
    const r = await api.set("default", "image_gen", true, false);
    expect(r.kind).toBe("mismatch");
    if (r.kind === "mismatch") expect(r.list.toolsets.find((t) => t.name === "image_gen")?.enabled).toBe(false);
  });

  it("settles a dropped answer by reading back: Hermes had it", async () => {
    const { server, api } = await connected();
    server.dropOnToolsetWrite = "stored";
    expect((await api.set("default", "web", false, true)).kind).toBe("saved");
  });

  it("settles a dropped answer by reading back: Hermes didn't get it", async () => {
    const { server, api } = await connected();
    server.dropOnToolsetWrite = "lost";
    const r = await api.set("default", "web", false, true);
    expect(r).toMatchObject({ kind: "unknown", reason: expect.stringContaining("connection reset") });
    expect(server.enabledToolsets("default").has("web")).toBe(true);
  });

  it("fails before sending when it can't read the toolset first", async () => {
    const { server, api, hermes } = await connected();
    await hermes.close();
    await expect(api.set("default", "web", false, true)).rejects.toThrow("Not connected");
    expect(server.toolsetWrites).toEqual([]);
  });

  it("never sends a name the relay would refuse", async () => {
    const { server, api } = await connected();
    expect(await api.set("default", "../config", true, false)).toMatchObject({ kind: "rejected" });
    expect(await api.set("default", PROBE_NAME, true, false)).toMatchObject({ kind: "rejected" });
    expect(server.restRequests).toEqual([]);
  });

  it("goes through Hermes's profile config only, never an open chat's session", async () => {
    const { server, hermes, api } = await connected();
    server.sessions = [row("s1", 0)];
    const before = server.requests.length;
    await api.set("default", "web", false, true);
    // No WS request (such as `tools.configure`, which resets the chat's agent) is sent.
    expect(server.requests.length).toBe(before);
    expect(hermes.getSnapshot().status).toBe("connected");
  });
});

describe("concurrent changes", () => {
  it("writes one change at a time for the whole app, and says which is on its way", async () => {
    const { server, api } = await connected();
    let release!: () => void;
    server.toolsetGateBeforeWrite = new Promise((r) => (release = r));
    const seen: (string | undefined)[] = [];
    api.subscribe(() => seen.push(api.pending() && `${api.pending()!.name}=${api.pending()!.enabled}`));
    const first = api.set("default", "web", false, true);
    // A second screen (the tab reopened) asks while the first hasn't written yet: it waits, then checks afresh.
    const second = api.set("default", "web", true, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.pending()).toEqual({ profile: "default", name: "web", enabled: false });
    expect(server.toolsetWrites).toEqual([]);
    release();
    expect((await first).kind).toBe("saved");
    // It saw web on, Hermes now has it off: not sent.
    expect(await second).toMatchObject({ kind: "conflict", now: false });
    expect(server.toolsetWrites).toEqual([{ profile: "default", name: "web", enabled: false }]);
    expect(api.pending()).toBeUndefined();
    expect(seen).toEqual(["web=false", undefined, "web=true", undefined]);
  });

  it("two different toolsets changed at once both land", async () => {
    const { server, api } = await connected();
    const [a, b] = await Promise.all([api.set("default", "web", false, true), api.set("default", "file", false, true)]);
    expect([a.kind, b.kind]).toEqual(["saved", "saved"]);
    expect(enabledIn(server, "default")).toEqual(["stt", "terminal"]);
  });

  it("a second change of the same toolset, from what was shown before the first, isn't sent", async () => {
    const { server, api } = await connected();
    const first = await api.set("default", "web", false, true);
    // Another window, still showing it on, asks for off again; Hermes already has it off.
    const second = await api.set("default", "web", false, true);
    expect(first.kind).toBe("saved");
    expect(second).toMatchObject({ kind: "conflict", now: false });
    expect(server.toolsetWrites).toHaveLength(1);
  });
});

describe("profile isolation", () => {
  it("reads and writes each profile's own toolsets", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    const { api } = await connected(server);
    await api.set("work", "terminal", false, true);
    expect(writes(server)).toEqual([["PUT /api/tools/toolsets/terminal?profile=work", { enabled: false }]]);
    expect(server.enabledToolsets("work").has("terminal")).toBe(false);
    expect(server.enabledToolsets("default").has("terminal")).toBe(true);
    expect((await api.list("default")).toolsets.find((t) => t.name === "terminal")?.enabled).toBe(true);
    expect((await api.list("work")).toolsets.find((t) => t.name === "terminal")?.enabled).toBe(false);
  });

  it("a change started before a profile switch still goes to the profile it was made in", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    const { hermes, api } = await connected(server);
    let release!: () => void;
    server.toolsetGate = new Promise((r) => (release = r));
    const pending = api.set("default", "web", false, true);
    await new Promise((r) => setTimeout(r, 0));
    const switching = hermes.switchProfile("work");
    release();
    await switching;
    // Read back mid-switch it may not be confirmed, but it is never applied to the new profile.
    expect(["saved", "unknown"]).toContain((await pending).kind);
    expect(server.toolsetWrites).toEqual([{ profile: "default", name: "web", enabled: false }]);
    expect(server.enabledToolsets("work").has("web")).toBe(true);
  });
});

describe("speech-to-text", () => {
  it("drops the cached voice set-up once it is switched", async () => {
    const { server, hermes, api } = await connected();
    expect((await hermes.voiceSetup()).sttEnabled).toBe(true);
    await expect((await api.set("default", "stt", false, true)).kind).toBe("saved");
    server.voice = { ...server.voice, sttEnabled: false };
    expect((await hermes.voiceSetup()).sttEnabled).toBe(false);
  });
});

describe("failureOf", () => {
  it("reads the relay's wording", () => {
    expect(failureOf(new RestError(400, `{"detail":"Unknown toolset: x"}`))).toEqual({ status: 400, reason: "Unknown toolset: x" });
    expect(failureOf(new RestError(422, `{"detail":[{"msg":"Input should be a valid boolean"}]}`))).toEqual({
      status: 422,
      reason: "Input should be a valid boolean",
    });
    expect(failureOf(new RestError(401, "", "The dashboard sign-in has expired. Sign in again."))).toMatchObject({ status: 401, signedOut: true });
    expect(failureOf(new Error("Hermes Chat doesn't relay PUT api/x."))).toMatchObject({ notRelayed: true });
    expect(failureOf(new Error("Can't reach the Hermes dashboard: reset"))).toEqual({ reason: "Can't reach the Hermes dashboard: reset" });
  });
});

describe("what one open chat has (tools.show)", () => {
  const started = async (hermes: Awaited<ReturnType<typeof connect>>) => {
    const id = await hermes.newChat();
    return hermes.getSnapshot().chats.find((c) => c.id === id)!.runtimeId!;
  };

  it("reads the chat's own tools, asking session.status after tools.show", async () => {
    const { server, hermes, api } = await connected();
    const rid = await started(hermes);
    server.enabledToolsets("default").delete("web");
    const read = await api.chatTools("default", rid);
    // Built before the change: the chat keeps web.
    expect(read.kind === "read" && [...read.tools].sort()).toEqual(["patch", "process", "read_file", "search_files", "terminal", "web_extract", "web_search", "write_file"]);
    const asked = server.requests.filter((r) => r.method === "tools.show" || r.method === "session.status").map((r) => [r.method, r.params.session_id]);
    expect(asked.slice(-2)).toEqual([
      ["tools.show", rid],
      ["session.status", rid],
    ]);
    // Read-only: nothing written.
    expect(writes(server)).toEqual([]);
    expect(server.requests.some((r) => r.method === "tools.configure")).toBe(false);
  });

  it("reads a chat only in the profile the dashboard runs as, whose requirements Hermes checks", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.enabledToolsets("work").delete("file");
    const work = await connect(server.openPipe, "work");
    const rid = await started(work);
    // Hermes checks tool requirements as the served profile, not the chat's: not read, and nothing asked over the socket.
    const asked = server.requests.length;
    expect(await work.toolsets.chatTools("work", rid)).toEqual({
      kind: "unsupported",
      reason: "Hermes checks what a chat is offered as the profile its dashboard runs as, default, so it can't say for certain for a chat in the work profile.",
    });
    expect(server.requests.slice(asked).map((r) => r.method)).toEqual([]);
    // A dashboard running as `work` answers for work's own chat.
    server.servedProfile = "work";
    const read = await work.toolsets.chatTools("work", rid);
    expect(read.kind === "read" && read.tools.has("read_file")).toBe(false);
    server.servedProfile = "default";
    const home = await connect(server.openPipe, "default");
    const mine = await home.toolsets.chatTools("default", await started(home));
    expect(mine.kind === "read" && mine.tools.has("read_file")).toBe(true);
  });

  it("a session Hermes no longer holds is closed, never its launch profile's fallback", async () => {
    const { server, hermes, api } = await connected();
    const rid = await started(hermes);
    server.runtime.delete(rid);
    expect(await api.chatTools("default", rid)).toEqual({ kind: "closed" });
  });

  it("an older server without tools.show is unsupported; other errors are thrown", async () => {
    const { server, hermes, api } = await connected();
    const rid = await started(hermes);
    server.toolsShowMethod = false;
    expect(await api.chatTools("default", rid)).toMatchObject({ kind: "unsupported" });
    server.toolsShowMethod = true;
    server.handlers["tools.show"] = (r) => server.fail(r.id, 5034, "tools.show failed: boom");
    await expect(api.chatTools("default", rid)).rejects.toThrow(/boom/);
  });
});
