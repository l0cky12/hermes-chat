// Settings → MCP servers' reads and writes (mcp.ts, ADR 0121) through the transport, against the fake dashboard's MCP
// routes and Rust's single-server edit (fakeMcp.ts): add, edit, remove, switch, test, sign in and the catalog, each
// named for its profile, each read back before it counts.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { editOf, formProblem, matches, type ServerForm } from "./mcp";

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  const fake = server.mcp;
  fake.servers.default = {
    fs: { command: "npx", args: ["-y", "pkg"], env: { API_KEY: "s3cret-value-long", MODE: "${MODE}" }, enabled: true, timeout: 30 },
    web: { url: "https://old.example/mcp", headers: { Authorization: "Bearer ${MCP_WEB_API_KEY}" } },
  };
  fake.env.default = { MCP_WEB_API_KEY: "old-token" };
  fake.plugins.default = { kanban: { plugin: "kanban-plugin", cfg: { command: "kanban-mcp" } } };
  fake.servers.work = { notes: { url: "https://notes.example/mcp", auth: "oauth" } };
  const hermes = await connect(server.openPipe, "default");
  return { server, fake, hermes, api: hermes.mcp };
}

const stdio = (f: Partial<Extract<ServerForm, { transport: "stdio" }>> = {}): ServerForm => ({ transport: "stdio", name: "new", command: "npx", args: [], env: [], ...f });
const http = (f: Partial<Extract<ServerForm, { transport: "http" }>> = {}): ServerForm => ({ transport: "http", name: "new", url: "https://mcp.example/mcp", auth: "none", ...f });

describe("MCP servers: reading", () => {
  it("lists each server's name, transport, switch and plugin, keeping only env var names", async () => {
    const { api } = await setUp();
    const list = await api.list("default");
    expect(list.profile).toBe("default");
    expect(list.servers.map((s) => s.name)).toEqual(["fs", "kanban", "web"]);
    const [fs, kanban, web] = list.servers;
    expect(fs).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "pkg"], envKeys: ["API_KEY", "MODE"], enabled: true, changeable: true, plugin: undefined });
    expect(JSON.stringify(fs)).not.toContain("s3cr");
    expect(kanban).toMatchObject({ plugin: "kanban-plugin", changeable: false });
    expect(web).toMatchObject({ transport: "http", url: "https://old.example/mcp", auth: "header" });
  });

  it("reads another profile's servers, and says when the server has no MCP routes", async () => {
    const { api, fake } = await setUp();
    expect((await api.list("work")).servers.map((s) => s.name)).toEqual(["notes"]);
    await expect(api.list("nobody")).rejects.toThrow("Profile 'nobody' does not exist");
    fake.routes = "none";
    await expect(api.list("default")).rejects.toThrow(/no MCP server routes/);
  });
});

describe("MCP servers: adding", () => {
  it("adds a stdio server with args and env, and counts it once the list shows it", async () => {
    const { api, fake } = await setUp();
    const r = await api.add("work", stdio({ args: ["-y", "@x/server"], env: [{ key: "TOKEN", value: "t-1" }] }));
    expect(r.kind).toBe("saved");
    expect(fake.servers.work.new).toEqual({ command: "npx", args: ["-y", "@x/server"], env: { TOKEN: "t-1" } });
    expect(fake.servers.default.new).toBeUndefined();
    expect(fake.writes.at(-1)).toMatchObject({ profile: "work", what: "add new" });
  });

  it("adds an HTTP server with a bearer token, which Hermes keeps in the profile's .env", async () => {
    const { api, fake } = await setUp();
    const r = await api.add("default", http({ name: "gh", auth: "header", bearerToken: "Bearer ghp_abc" }));
    expect(r.kind).toBe("saved");
    expect(fake.servers.default.gh).toEqual({ url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${MCP_GH_API_KEY}" } });
    expect(fake.env.default.MCP_GH_API_KEY).toBe("ghp_abc");
  });

  it("shows Hermes's refusal of a taken name or a plugin's, and changes nothing", async () => {
    const { api, fake } = await setUp();
    const taken = await api.add("default", stdio({ name: "fs" }));
    expect(taken).toMatchObject({ kind: "refused", reason: "Server 'fs' already exists" });
    const plugin = await api.add("default", stdio({ name: "kanban" }));
    expect(plugin).toMatchObject({ kind: "refused", reason: "Server 'kanban' is provided by plugin 'kanban-plugin' and cannot be modified" });
    expect(fake.writes).toEqual([]);
  });

  it("settles a lost answer by the list: saved when it landed, unconfirmed when it didn't", async () => {
    const { api, fake } = await setUp();
    fake.drop = "stored";
    expect((await api.add("default", stdio({ name: "a" }))).kind).toBe("saved");
    fake.drop = "lost";
    const lost = await api.add("default", stdio({ name: "b" }));
    expect(lost.kind).toBe("unconfirmed");
    expect(lost.kind !== "saved" && lost.reason).toMatch(/connection reset/);
  });
});

describe("MCP servers: editing", () => {
  it("edits one server in Rust, keeping env values left blank and every other server as it was", async () => {
    const { api, fake } = await setUp();
    const web = { ...fake.servers.default.web };
    const r = await api.edit("default", "fs", stdio({ name: "fs", command: "uvx", args: ["tool"], env: [{ key: "API_KEY" }, { key: "NEW", value: "n" }] }));
    expect(r.kind).toBe("saved");
    expect(fake.servers.default.fs).toEqual({ command: "uvx", args: ["tool"], env: { API_KEY: "s3cret-value-long", NEW: "n" }, enabled: true, timeout: 30 });
    expect(fake.servers.default.web).toEqual(web);
  });

  it("sends only what changed of a secret: a blank token keeps Hermes's, a new one replaces it", async () => {
    const { api, fake } = await setUp();
    expect(editOf("web", http({ name: "web", url: "https://old.example/mcp", auth: "header" }))).toEqual({
      name: "web",
      server: { transport: "http", url: "https://old.example/mcp", auth: "header" },
    });
    expect((await api.edit("default", "web", http({ name: "web", url: "https://new.example/mcp", auth: "header" }))).kind).toBe("saved");
    expect(fake.env.default.MCP_WEB_API_KEY).toBe("old-token");
    expect((await api.edit("default", "web", http({ name: "web", url: "https://new.example/mcp", auth: "header", bearerToken: "new-token" }))).kind).toBe("saved");
    expect(fake.env.default.MCP_WEB_API_KEY).toBe("new-token");
  });

  it("renames a server, and refuses one whose saved value it was told to keep but Hermes lacks", async () => {
    const { api, fake } = await setUp();
    expect((await api.edit("default", "fs", stdio({ name: "files", command: "npx", args: ["-y", "pkg"], env: [{ key: "API_KEY" }, { key: "MODE" }] }))).kind).toBe("saved");
    expect(Object.keys(fake.servers.default).sort()).toEqual(["files", "web"]);
    const r = await api.edit("default", "files", stdio({ name: "files", env: [{ key: "GONE" }] }));
    expect(r).toMatchObject({ kind: "refused", reason: "GONE has no saved value to keep. Type one." });
  });

  it("never calls an edit saved because the list looks right after a failure: the list can't show a secret", async () => {
    const { api, fake } = await setUp();
    // The answer to the map write is lost after the token was saved: the list shows the same server as before.
    fake.drop = "lost";
    const lost = await api.edit("default", "web", http({ name: "web", url: "https://old.example/mcp", auth: "header", bearerToken: "tok-2" }));
    expect(lost.kind).toBe("unconfirmed");
    expect(lost.kind !== "saved" && lost.reason).toMatch(/saved the new bearer token/);
    // An env edit whose answer is lost is unconfirmed too.
    fake.drop = "lost";
    expect((await api.edit("default", "fs", stdio({ name: "fs", command: "npx", args: ["-y", "pkg"], env: [{ key: "API_KEY", value: "new" }, { key: "MODE" }] }))).kind).toBe("unconfirmed");
  });

  it("says a token was saved when Hermes refused the rest, and a refusal with no token changed nothing", async () => {
    const { api, fake } = await setUp();
    fake.refuse = { status: 400, detail: "Server 'web' rejected: suspicious" };
    const partial = await api.edit("default", "web", http({ name: "web", url: "https://old.example/mcp", auth: "header", bearerToken: "tok-3" }));
    expect(partial).toMatchObject({ kind: "unconfirmed", reason: expect.stringMatching(/^Hermes saved the new bearer token, but not the rest/) });
    expect(fake.env.default.MCP_WEB_API_KEY).toBe("tok-3");
    fake.refuse = { status: 400, detail: "Server 'fs' rejected: suspicious" };
    const refused = await api.edit("default", "fs", stdio({ name: "fs", command: "bash" }));
    expect(refused).toMatchObject({ kind: "refused", reason: "Server 'fs' rejected: suspicious" });
  });

  it("refuses an edit of a server another client removed meanwhile", async () => {
    const { api, fake } = await setUp();
    delete fake.servers.default.fs;
    const r = await api.edit("default", "fs", stdio({ name: "fs" }));
    expect(r.kind).toBe("refused");
    expect(r.list?.servers.map((s) => s.name)).toEqual(["kanban", "web"]);
  });
});

describe("MCP servers: removing and switching", () => {
  it("removes a server once the list no longer has it, and counts one already gone as removed", async () => {
    const { api, fake } = await setUp();
    expect((await api.remove("default", "fs")).kind).toBe("saved");
    expect(fake.servers.default.fs).toBeUndefined();
    expect((await api.remove("default", "fs")).kind).toBe("saved");
    expect((await api.remove("default", "kanban")).kind).toBe("refused");
  });

  it("switches a server off and on, and says when Hermes reads it back otherwise", async () => {
    const { api, fake } = await setUp();
    expect((await api.setEnabled("default", "fs", false)).kind).toBe("saved");
    expect(fake.servers.default.fs.enabled).toBe(false);
    fake.misapply = true;
    const r = await api.setEnabled("default", "fs", true);
    expect(r.kind).toBe("unconfirmed");
    expect(r.list?.servers.find((s) => s.name === "fs")?.enabled).toBe(false);
  });

  it("each write names its profile", async () => {
    const { api, fake, server } = await setUp();
    await api.setEnabled("work", "notes", false);
    await api.remove("work", "notes");
    expect(fake.writes.map((w) => w.profile)).toEqual(["work", "work"]);
    expect(server.restRequests.filter((r) => r.path.startsWith("/api/mcp/")).every((r) => r.query.get("profile") === "work" || r.method === "GET")).toBe(true);
  });
});

describe("MCP servers: test and sign in", () => {
  it("tests a server: its tools, or Hermes's reason it couldn't connect", async () => {
    const { api, fake } = await setUp();
    fake.probes.fs = { tools: [{ name: "read_file", description: "Read a file" }] };
    expect(await api.test("default", "fs")).toMatchObject({ ok: true, tools: [{ name: "read_file", description: "Read a file" }] });
    fake.probes.web = { error: "Connection refused" };
    expect(await api.test("default", "web")).toMatchObject({ ok: false, error: "Connection refused" });
    expect(await api.test("work", "notes")).toMatchObject({ ok: false, error: "OAuth authentication required — no token found." });
  });

  it("signs in with OAuth: starts a flow, follows it to approved, and can stop one", async () => {
    const { api, fake } = await setUp();
    const flow = await api.startSignIn("work", "notes");
    expect(flow).toMatchObject({ server: "notes", status: "authorization_required", authorizationUrl: "https://auth.example/authorize?client=hermes&server=notes" });
    await expect(api.startSignIn("work", "notes")).rejects.toThrow("already in progress");
    fake.approve(flow.flowId, [{ name: "search", description: "" }]);
    expect(await api.signInStatus(flow.flowId)).toMatchObject({ status: "approved", tools: [{ name: "search" }] });
    expect(await api.test("work", "notes")).toMatchObject({ ok: true });
    await expect(api.startSignIn("default", "fs")).rejects.toThrow("stdio servers authenticate via env keys, not OAuth");
    await expect(api.startSignIn("default", "web")).rejects.toThrow("header/API-key auth");
  });

  it("cancels a flow, and reads a failed one's reason", async () => {
    const { api, fake } = await setUp();
    const flow = await api.startSignIn("work", "notes");
    await api.cancelSignIn(flow.flowId);
    expect(await api.signInStatus(flow.flowId)).toMatchObject({ status: "error", error: "Cancelled by user" });
    const again = await api.startSignIn("work", "notes");
    fake.fail(again.flowId, "access_denied");
    expect(await api.signInStatus(again.flowId)).toMatchObject({ status: "error", error: "access_denied" });
  });
});

describe("MCP servers: catalog", () => {
  it("lists the catalog and installs an entry with the values it asks for", async () => {
    const { api, fake } = await setUp();
    fake.catalogEntries = [
      { name: "github", description: "GitHub", transport: "stdio", command: "github-mcp", env: [{ name: "GITHUB_TOKEN", prompt: "GitHub token" }] },
      { name: "big", description: "Built", transport: "stdio", command: "big", install: { url: "https://git.example/big", bootstrap: ["make"] } },
    ];
    const cat = await api.catalog("default");
    expect(cat.entries.map((e) => [e.name, e.needsInstall, e.requiredEnv.map((v) => v.name)])).toEqual([
      ["github", false, ["GITHUB_TOKEN"]],
      ["big", true, []],
    ]);
    expect((await api.install("default", cat.entries[0], { GITHUB_TOKEN: "ghp_1" })).kind).toBe("saved");
    expect(fake.env.default.GITHUB_TOKEN).toBe("ghp_1");
    const bg = await api.install("default", cat.entries[1], {});
    expect(bg).toMatchObject({ kind: "saved", note: expect.stringMatching(/in the background/) });
  });

  it("never calls a background install saved when its request failed", async () => {
    const { api, fake } = await setUp();
    fake.catalogEntries = [{ name: "big", description: "Built", transport: "stdio", command: "big", install: { url: "https://git.example/big", bootstrap: ["make"] } }];
    const [big] = (await api.catalog("default")).entries;
    fake.drop = "lost";
    const r = await api.install("default", big, {});
    expect(r.kind).toBe("unconfirmed");
    expect(fake.writes).toEqual([]);
  });
});

describe("MCP servers: forms", () => {
  it("says what a form lacks before anything is sent", () => {
    expect(formProblem(stdio({ name: "a b" }), false, [])).toMatch(/A name is/);
    expect(formProblem(stdio({ name: "fs" }), false, ["fs"])).toMatch(/already has a server named fs/);
    expect(formProblem(stdio({ command: " " }), false, [])).toMatch(/command/);
    expect(formProblem(stdio({ env: [{ key: "1X", value: "v" }] }), false, [])).toMatch(/isn't an environment variable/);
    expect(formProblem(stdio({ env: [{ key: "X", value: "v" }, { key: "X", value: "w" }] }), false, [])).toMatch(/twice/);
    expect(formProblem(stdio({ env: [{ key: "X" }] }), false, [])).toMatch(/Type a value/);
    expect(formProblem(stdio({ env: [{ key: "X" }] }), true, [])).toBeUndefined();
    expect(formProblem(http({ url: "ftp://x" }), false, [])).toMatch(/http/);
    expect(formProblem(http({ auth: "header" }), false, [])).toMatch(/bearer token/);
    expect(formProblem(http({ auth: "header" }), true, [])).toBeUndefined();
  });

  it("matches a listed server against the form by what Hermes lists", () => {
    const s = { name: "new", transport: "stdio" as const, command: "npx", args: ["a"], envKeys: ["B", "A"], auth: "none" as const, enabled: true, toolFilter: false, changeable: true };
    expect(matches(s, stdio({ args: ["a"], env: [{ key: "A" }, { key: "B", value: "x" }] }))).toBe(true);
    expect(matches(s, stdio({ args: ["b"], env: [{ key: "A" }, { key: "B" }] }))).toBe(false);
  });
});
