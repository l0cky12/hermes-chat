// A fake Hermes's MCP servers, for tests of Settings → MCP servers (ADR 0121): the `/api/mcp` routes as the deployed
// `f0d94882` answers them (`hermes_cli/web_routers/mcp.py`, `web_server_mcp.py`), and Rust's single-server edit
// (`src-tauri/src/mcp.rs` `edited`, `Dashboard::mcp_edit`), which reads the raw config and writes the whole map.
// Each profile keeps its own raw `mcp_servers`, `.env` and OAuth tokens; plugin servers are listed but can't be changed.
import type { RestRequest } from "./fakeHermes";
import { envKeyFor, type McpEdit } from "./mcp";
import { RestError } from "./pipe";
import { errorText } from "./values";

type Cfg = Record<string, unknown>;
type Flow = { flow_id: string; server_name: string; profile: string; status: string; authorization_url: string | null; error: string | null; tools: { name: string; description: string }[] };

export type FakeCatalogEntry = {
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  auth_type?: string;
  env?: { name: string; prompt: string; required?: boolean; secret?: boolean }[];
  /** Clones and builds on the server: installs in the background. */
  install?: { url: string; bootstrap: string[] };
};

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));


/** `agent.redact.redact_key`, near enough: a short value is all stars, a longer one keeps its ends. */
const redact = (v: string) => (v.length < 12 ? "***" : `${v.slice(0, 4)}...${v.slice(-4)}`);
const isAuthorization = (k: string) => k.toLowerCase() === "authorization";

export class FakeMcp {
  /** Each profile's raw `mcp_servers`, as config.yaml has them. */
  servers: Record<string, Record<string, Cfg>> = {};
  /** Servers plugins provide, per profile: name → plugin. */
  plugins: Record<string, Record<string, { plugin: string; cfg: Cfg }>> = {};
  /** Each profile's `.env`. */
  env: Record<string, Record<string, string>> = {};
  /** Servers with an OAuth token on disk, per profile. */
  tokens: Record<string, Set<string>> = {};
  /** What a Test finds, by server name: its tools, or the error it ran into. Untold servers have none. */
  probes: Record<string, { tools?: { name: string; description: string }[]; error?: string }> = {};
  catalogEntries: FakeCatalogEntry[] = [];
  flows: Record<string, Flow> = {};
  private nextFlow = 1;
  /** Every write asked of the routes or the edit, in order. */
  readonly writes: { profile: string; what: string; body?: unknown }[] = [];
  /** `none`: a Hermes without the MCP routes. */
  routes: "all" | "none" = "all";
  /** Awaited before each write is applied. */
  gate?: Promise<void>;
  /** Awaited before each list read. */
  listGate?: Promise<void>;
  /** The next write: `lost` fails before applying, `stored` applies it and then loses the answer. */
  drop?: "lost" | "stored";
  /** The next write is refused with this. */
  refuse?: { status: number; detail: string };
  /** The next write lands differently: `enabled` toggles the other way. */
  misapply?: boolean;
  /** Reads of an OAuth flow fail with a 500, while the flow carries on. */
  flowReadsFail?: boolean;

  constructor(private known: (profile: string) => boolean) {}

  private cfgs(profile: string) {
    return (this.servers[profile] ??= {});
  }

  /** What the list route shows for one server (`_mcp_server_summary`). */
  private summary(name: string, cfg: Cfg, plugin?: string) {
    const headers = (cfg.headers ?? {}) as Record<string, string>;
    const auth = (cfg.auth as string | undefined) ?? (Object.keys(headers).some(isAuthorization) ? "header" : null);
    const env = (cfg.env ?? {}) as Record<string, string>;
    return {
      name,
      transport: cfg.url ? "http" : cfg.command ? "stdio" : "unknown",
      url: cfg.url ?? null,
      command: cfg.command ?? null,
      args: [...((cfg.args as string[]) ?? [])],
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v ? redact(v) : ""])),
      auth,
      enabled: cfg.enabled !== false,
      tools: cfg.tools ?? null,
      source: plugin ? "plugin" : "config",
      plugin: plugin ?? null,
    };
  }

  private async write<T>(profile: string, what: string, body: unknown, apply: () => T): Promise<T> {
    await this.gate;
    const refuse = this.refuse;
    this.refuse = undefined;
    if (refuse) throw answered(refuse.status, refuse.detail);
    const drop = this.drop;
    this.drop = undefined;
    if (drop === "lost") throw new Error("Can't reach the Hermes dashboard: connection reset");
    this.writes.push({ profile, what, body });
    const out = apply();
    if (drop === "stored") throw new Error("Can't reach the Hermes dashboard: connection reset");
    return out;
  }

  private pluginOf(profile: string, name: string) {
    return this.plugins[profile]?.[name]?.plugin;
  }

  route(req: RestRequest): (() => Promise<unknown>) | undefined {
    if (!req.path.startsWith("/api/mcp/")) return undefined;
    return async () => {
      if (this.routes === "none") throw answered(404, "Not Found");
      const profile = req.query.get("profile") ?? "default";
      const flow = /^\/api\/mcp\/oauth\/flows\/([^/]+)$/.exec(req.path);
      if (flow) return this.flowRoute(req.method, decodeURIComponent(flow[1]));
      if (!this.known(profile)) throw answered(404, `Profile '${profile}' does not exist`);
      const one = /^\/api\/mcp\/servers\/([^/]+)(?:\/(enabled|test|auth))?$/.exec(req.path);
      const m = req.method;
      if (req.path === "/api/mcp/servers" && m === "GET") {
        await this.listGate;
        const all: [string, Cfg, string?][] = [
          ...Object.entries(this.cfgs(profile)).map(([n, c]): [string, Cfg] => [n, c]),
          ...Object.entries(this.plugins[profile] ?? {}).map(([n, p]): [string, Cfg, string] => [n, p.cfg, p.plugin]),
        ];
        return { servers: all.sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c, p]) => this.summary(n, c, p)) };
      }
      if (req.path === "/api/mcp/servers" && m === "POST") return this.create(profile, req.body ?? {});
      if (req.path === "/api/mcp/servers" && m === "PUT") return this.replace(profile, req.body ?? {});
      if (req.path === "/api/mcp/catalog" && m === "GET") return this.catalog(profile);
      if (req.path === "/api/mcp/catalog/install" && m === "POST") return this.install(profile, req.body ?? {});
      if (!one) throw answered(404, "Not Found");
      const name = decodeURIComponent(one[1]);
      const action = one[2];
      const plugin = this.pluginOf(profile, name);
      const cfgs = this.cfgs(profile);
      if (!action && m === "DELETE") {
        if (plugin) throw answered(409, `Server '${name}' is provided by plugin '${plugin}' and cannot be modified`);
        return this.write(profile, `delete ${name}`, undefined, () => {
          if (!(name in cfgs)) throw answered(404, `Server '${name}' not found`);
          delete cfgs[name];
          return { ok: true };
        });
      }
      if (action === "enabled" && m === "PUT") {
        if (typeof req.body?.enabled !== "boolean")
          throw answered(422, "Input should be a valid boolean");
        if (plugin) throw answered(409, `Server '${name}' is provided by plugin '${plugin}' and cannot be modified`);
        const enabled = req.body.enabled;
        return this.write(profile, `enabled ${name}`, req.body, () => {
          if (!(name in cfgs)) throw answered(404, `Server '${name}' not found`);
          const misapply = this.misapply;
          this.misapply = undefined;
          cfgs[name] = { ...cfgs[name], enabled: misapply ? !enabled : enabled };
          return { ok: true, name, enabled };
        });
      }
      if (action === "test" && m === "POST") {
        const cfg = cfgs[name] ?? this.plugins[profile]?.[name]?.cfg;
        if (!cfg) throw answered(404, `Server '${name}' not found`);
        await this.gate;
        const probe = this.probes[name] ?? {};
        if (probe.error) return { ok: false, error: probe.error, tools: [] };
        if (cfg.auth === "oauth" && !this.tokens[profile]?.has(name)) return { ok: false, error: "OAuth authentication required — no token found.", tools: [] };
        return { ok: true, tools: probe.tools ?? [], prompts: 0, resources: 0 };
      }
      if (action === "auth" && m === "POST") {
        const cfg = cfgs[name] ?? this.plugins[profile]?.[name]?.cfg;
        if (!cfg) throw answered(404, `Server '${name}' not found`);
        if (plugin) throw answered(409, `Server '${name}' is provided by plugin '${plugin}' and cannot be modified`);
        if (!cfg.url) throw answered(400, "stdio servers authenticate via env keys, not OAuth");
        if (cfg.headers && cfg.auth !== "oauth") throw answered(400, "This server uses header/API-key auth, not OAuth");
        if (Object.values(this.flows).some((f) => f.server_name === name && f.profile === profile && (f.status === "starting" || f.status === "authorization_required")))
          throw answered(409, `MCP OAuth for '${name}' is already in progress`);
        const id = `flow-${this.nextFlow++}`;
        this.flows[id] = {
          flow_id: id,
          server_name: name,
          profile,
          status: "authorization_required",
          authorization_url: `https://auth.example/authorize?client=hermes&server=${encodeURIComponent(name)}`,
          error: null,
          tools: [],
        };
        this.writes.push({ profile, what: `auth ${name}` });
        return this.snapshot(this.flows[id]);
      }
      throw answered(405, "Method Not Allowed");
    };
  }

  private snapshot(f: Flow) {
    return { flow_id: f.flow_id, server_name: f.server_name, status: f.status, authorization_url: f.authorization_url, error: f.error };
  }

  private flowRoute(method: string, id: string) {
    const f = this.flows[id];
    if (method === "GET") {
      if (this.flowReadsFail) throw answered(500, "Internal Server Error");
      if (!f) throw answered(404, "OAuth flow not found or expired");
      return { ...this.snapshot(f), tools: f.tools };
    }
    if (method === "DELETE") {
      if (!f) return { ok: true, status: "expired" };
      if (f.status !== "approved") Object.assign(f, { status: "error", error: "Cancelled by user" });
      this.writes.push({ profile: f.profile, what: `cancel ${id}` });
      return { ok: true, status: f.status };
    }
    throw answered(405, "Method Not Allowed");
  }

  /** The owner finished signing in at the provider: the flow is approved and the token saved. */
  approve(flowId: string, tools: { name: string; description: string }[] = []) {
    const f = this.flows[flowId];
    Object.assign(f, { status: "approved", tools });
    (this.tokens[f.profile] ??= new Set()).add(f.server_name);
    const cfg = this.cfgs(f.profile)[f.server_name];
    if (cfg) cfg.auth = "oauth";
  }

  /** The provider turned the sign-in down. */
  fail(flowId: string, error: string) {
    Object.assign(this.flows[flowId], { status: "error", error });
  }

  /** `_normalize_mcp_server_create`, then the add route's checks. */
  private create(profile: string, body: Record<string, unknown>) {
    const name = String(body.name ?? "").trim();
    if (!name) throw answered(400, "Server name is required");
    const url = String(body.url ?? "").trim();
    const command = String(body.command ?? "").trim();
    const auth = String(body.auth ?? "none").toLowerCase();
    const token = body.bearer_token as string | undefined;
    if (!!url === !!command) throw answered(400, "Provide exactly one of URL (HTTP/SSE) or command (stdio)");
    const cfg: Cfg = {};
    if (url) {
      if (auth === "header") {
        const t = token?.trim().replace(/^bearer\s+/i, "") ?? "";
        if (!t) throw answered(400, "Bearer token is required");
        cfg.headers = { Authorization: `Bearer \${${envKeyFor(name)}}` };
      } else if (token !== undefined) throw answered(400, "Bearer token requires header authentication");
      cfg.url = url;
      if (auth === "oauth") cfg.auth = "oauth";
    } else {
      if (auth !== "none" || token !== undefined) throw answered(400, "HTTP authentication is not supported for stdio MCP servers");
      cfg.command = command;
      if (Array.isArray(body.args) && body.args.length) cfg.args = [...body.args];
      if (body.env && Object.keys(body.env).length) cfg.env = { ...(body.env as Record<string, string>) };
    }
    if (command.includes("curl") && (cfg.args as string[] | undefined)?.some((a) => a.includes("|")))
      throw answered(400, `Server '${name}' rejected: MCP server '${name}' uses shell interpreter with network egress in args`);
    const plugin = this.pluginOf(profile, name);
    if (plugin) throw answered(409, `Server '${name}' is provided by plugin '${plugin}' and cannot be modified`);
    if (name in this.cfgs(profile)) throw answered(409, `Server '${name}' already exists`);
    return this.write(profile, `add ${name}`, body, () => {
      if (cfg.headers) (this.env[profile] ??= {})[envKeyFor(name)] = token!.trim().replace(/^bearer\s+/i, "");
      this.cfgs(profile)[name] = cfg;
      return this.summary(name, cfg);
    });
  }

  /** `PUT /api/mcp/servers` (`MCPServersReplace`): the whole map, refused if it names a plugin's server. Only Rust sends it. */
  private replace(profile: string, body: Record<string, unknown>) {
    const servers = (body.servers ?? {}) as Record<string, Cfg>;
    for (const name of Object.keys(servers)) {
      const plugin = this.pluginOf(profile, name);
      if (plugin) throw answered(400, `Server '${name}' is provided by plugin '${plugin}' and cannot be modified`);
    }
    return this.write(profile, "replace", body, () => {
      this.servers[profile] = structuredClone(servers);
      return { ok: true };
    });
  }

  /** `PUT /api/env`, as Rust's edit uses it: an MCP server's bearer token into the profile's `.env`. */
  saveEnv(profile: string, key: string, value: string) {
    if (!/^MCP_[A-Z0-9_]+_API_KEY$/.test(key)) throw answered(400, `${key}: this stand-in keeps only MCP server tokens`);
    (this.env[profile] ??= {})[key] = value;
    return { ok: true, key };
  }

  private catalog(profile: string) {
    const cfgs = this.cfgs(profile);
    return {
      entries: this.catalogEntries.map((e) => ({
        name: e.name,
        description: e.description,
        connector_slug: null,
        source: "nous",
        transport: e.transport,
        auth_type: e.auth_type ?? "none",
        required_env: (e.env ?? []).map((v) => ({ name: v.name, prompt: v.prompt, required: v.required !== false })),
        command: e.command ?? null,
        args: e.args ?? [],
        url: e.url ?? null,
        install_url: e.install?.url ?? null,
        install_ref: null,
        bootstrap: e.install?.bootstrap ?? [],
        default_enabled: null,
        post_install: "",
        suggest: null,
        needs_install: !!e.install,
        installed: e.name in cfgs,
        enabled: e.name in cfgs && cfgs[e.name].enabled !== false,
      })),
      diagnostics: [],
    };
  }

  private install(profile: string, body: Record<string, unknown>) {
    const name = String(body.name ?? "").trim();
    const entry = this.catalogEntries.find((e) => e.name === name);
    if (!entry) throw answered(404, `No catalog entry '${name}'`);
    const env = (body.env ?? {}) as Record<string, string>;
    const undeclared = Object.keys(env).filter((k) => !(entry.env ?? []).some((v) => v.name === k));
    if (undeclared.length) throw answered(400, `Catalog entry '${name}' does not declare environment variable(s): ${undeclared.sort().join(", ")}`);
    return this.write(profile, `install ${name}`, body, () => {
      for (const v of entry.env ?? []) if (v.secret !== false && env[v.name]) (this.env[profile] ??= {})[v.name] = env[v.name];
      if (entry.install) return { ok: true, name, background: true, action: `mcp-install-${name}` };
      this.finishInstall(profile, name);
      return { ok: true, name, background: false };
    });
  }

  /** A catalog entry's install is done: its server is in the profile's config. */
  finishInstall(profile: string, name: string) {
    const e = this.catalogEntries.find((x) => x.name === name)!;
    this.cfgs(profile)[name] = e.url ? { url: e.url, ...(e.auth_type === "oauth" && { auth: "oauth" }) } : { command: e.command, ...(e.args?.length && { args: e.args }) };
  }

  /** Rust's `Dashboard::mcp_edit`: the raw map read, one server changed (`mcp::edited`), a new token saved, the map written. */
  async edit(profile: string, e: McpEdit): Promise<void> {
    if (!this.known(profile)) throw answered(404, `Profile '${profile}' does not exist`);
    if (this.routes === "none") throw answered(404, "Not Found");
    const servers = this.cfgs(profile);
    const old = servers[e.name];
    if (!old)
      throw new Error(`This profile's config has no server named ${e.name} now: another client may have removed or renamed it, or a plugin provides it. Read the list again.`);
    const name = e.newName ?? e.name;
    if (name !== e.name && name in servers) throw new Error(`This profile already has a server named ${name}.`);
    const cfg: Cfg = { ...old };
    let token: [string, string] | undefined;
    if (e.server.transport === "stdio") {
      const oldEnv = (old.env ?? {}) as Record<string, string>;
      const env: Record<string, string> = {};
      for (const v of e.server.env) {
        if (v.value === undefined && !(v.key in oldEnv)) throw new Error(`${v.key} has no saved value to keep. Type one.`);
        env[v.key] = v.value ?? oldEnv[v.key];
      }
      for (const k of ["url", "headers", "auth", "oauth"]) delete cfg[k];
      cfg.command = e.server.command.trim();
      if (e.server.args.length) cfg.args = [...e.server.args];
      else delete cfg.args;
      if (Object.keys(env).length) cfg.env = env;
      else delete cfg.env;
    } else {
      for (const k of ["command", "args", "env"]) delete cfg[k];
      cfg.url = e.server.url.trim();
      const headers = { ...((old.headers ?? {}) as Record<string, string>) };
      const had = Object.keys(headers).some(isAuthorization);
      const t = e.server.bearerToken?.trim();
      const drop = () => Object.keys(headers).filter(isAuthorization).forEach((k) => delete headers[k]);
      if (e.server.auth === "header" && t) {
        const key = envKeyFor(name);
        drop();
        headers.Authorization = `Bearer \${${key}}`;
        token = [key, t.replace(/^bearer\s+/i, "")];
        delete cfg.auth;
      } else if (e.server.auth === "header") {
        if (!had || old.auth === "oauth") throw new Error("Type the bearer token: Hermes has none saved for this server.");
      } else if (t) {
        throw new Error("A bearer token goes only with bearer-token sign-in.");
      } else {
        drop();
        if (e.server.auth === "oauth") cfg.auth = "oauth";
        else delete cfg.auth;
      }
      if (Object.keys(headers).length) cfg.headers = headers;
      else delete cfg.headers;
    }
    // The token goes to `.env` first; once it's there, a failure after it is "not confirmed", never "not changed".
    if (token) (this.env[profile] ??= {})[token[0]] = token[1];
    try {
      await this.write(profile, `edit ${e.name}`, e, () => {
        delete servers[e.name];
        servers[name] = cfg;
      });
    } catch (err) {
      if (token) throw new Error(`Not confirmed: Hermes saved the new bearer token, but not the rest of the change: ${errorText(err)}`);
      throw err;
    }
  }
}
