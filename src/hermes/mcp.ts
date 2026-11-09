// Settings → MCP servers (ADR 0121): the MCP servers Hermes connects a profile's agent to, read and changed through the
// dashboard's routes at the deployed `f0d94882` (`hermes_cli/web_routers/mcp.py`). Every route takes `?profile=`:
//
// - `GET /api/mcp/servers` lists the profile's servers, plugin ones included (`plugin`), env values masked. Only the
//   env var names are kept here; a value is never shown or sent back.
// - `POST /api/mcp/servers` adds one (stdio: command, args, env; HTTP/SSE: url, auth none/header/oauth, a bearer token
//   that Hermes keeps in the profile's `.env`). 409 when the name is taken or a plugin provides it.
// - An edit goes to Rust (`Pipe.mcpEdit`, `Dashboard::mcp_edit`): Hermes's only edit route replaces the whole map,
//   so Rust reads the profile's raw config, changes this one server and writes the map back. A secret left blank on
//   the screen keeps what Hermes has.
// - `DELETE /api/mcp/servers/{name}`, `PUT …/{name}/enabled` `{enabled}`, `POST …/{name}/test` (connects, lists its
//   tools, disconnects), `POST …/{name}/auth` (starts an OAuth sign-in), `GET`/`DELETE /api/mcp/oauth/flows/{id}`.
// - `GET /api/mcp/catalog` and `POST /api/mcp/catalog/install` `{name, env, enable}`: Hermes's catalog of known
//   servers. An entry that clones and builds installs in the background on the server.
//
// Nothing is taken on trust: each change counts as saved only once the list, read again, shows it.

import { failureOf, type Failure } from "./toolsets";
import type { RestMethod } from "./pipe";

export type Transport = "stdio" | "http";
export type Auth = "none" | "header" | "oauth";

/** One server as Hermes lists it for a profile. */
export type McpServer = {
  name: string;
  transport: Transport | "unknown";
  url?: string;
  command?: string;
  args: string[];
  /** The env var names it's given; their values stay on the server. */
  envKeys: string[];
  auth: Auth;
  enabled: boolean;
  /** Hermes offers only some of its tools (`tools.include` / `exclude` in the config). */
  toolFilter: boolean;
  /** The plugin that provides it; such a server can't be changed here. */
  plugin?: string;
  /** Its name can go in a path from this app (Rust's `mcp::server_name`); one named otherwise is listed only. */
  changeable: boolean;
};

export type McpList = { profile: string; servers: McpServer[]; readAt: number };

/**
 * A server as the form has it. On an edit, an env var whose `value` is undefined keeps what Hermes has, and so does a
 * bearer token left out: secrets are write-only.
 */
export type ServerForm =
  | { transport: "stdio"; name: string; command: string; args: string[]; env: { key: string; value?: string }[] }
  | { transport: "http"; name: string; url: string; auth: Auth; bearerToken?: string };

/** What the Rust edit takes (`mcp::Edit`). */
export type McpEdit = {
  name: string;
  newName?: string;
  server:
    | { transport: "stdio"; command: string; args: string[]; env: { key: string; value?: string }[] }
    | { transport: "http"; url: string; auth: Auth; bearerToken?: string };
};

export type McpTool = { name: string; description: string };
export type McpTest = { ok: true; tools: McpTool[]; prompts?: number; resources?: number; at: number } | { ok: false; error: string; at: number };

export type OAuthStatus = "starting" | "authorization_required" | "approved" | "error";
export type OAuthFlow = { flowId: string; server: string; status: OAuthStatus; authorizationUrl?: string; error?: string; tools?: McpTool[] };

export type CatalogEntry = {
  name: string;
  description: string;
  transport: string;
  authType: string;
  requiredEnv: { name: string; prompt: string; required: boolean }[];
  command?: string;
  args: string[];
  url?: string;
  /** It clones and builds on the server, in the background. */
  needsInstall: boolean;
  installUrl?: string;
  bootstrap: string[];
  postInstall: string;
  installed: boolean;
};
export type Catalog = { entries: CatalogEntry[]; problems: string[] };

/** What a change came to. */
export type McpChange =
  /** Read back as asked. `note`: something to say alongside, such as a background install. */
  | { kind: "saved"; list: McpList; note?: string }
  /** Hermes refused it, or it was refused before sending; nothing changed. `list`, when it could be read again. */
  | { kind: "refused"; reason: string; list?: McpList }
  /** Hermes may have written it, but the list read afterwards (if any) doesn't show it as asked. */
  | { kind: "unconfirmed"; reason: string; list?: McpList };

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type McpRest = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** Hermes's `_env_key_for_server`: the env var a server's bearer token is kept in, `MCP_<NAME>_API_KEY`. */
export const envKeyFor = (name: string) => `MCP_${name.toUpperCase().replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "")}_API_KEY`;

/** Rust's `mcp::server_name`: what this app names in a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const serverNameOk = (n: string) => NAME.test(n);
/** An environment variable's name, as Rust checks it. */
export const envNameOk = (k: string) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const q = (profile: string) => `profile=${encodeURIComponent(profile)}`;

/** FastAPI's own "no such route", as opposed to a route refusing, which names its own reason. */
const noRoute = (f: Failure) => f.status === 405 || (f.status === 404 && f.reason === "Not Found");
/** A 4xx is Hermes answering before it wrote anything; anything else may have been written. */
const refusedBy = (f: Failure) => f.status !== undefined && f.status >= 400 && f.status < 500;

export class McpUnsupportedError extends Error {}
/** A change refused before anything was sent (Rust's checks of an edit). */
class RefusedFirst extends Error {}
/** An edit Rust couldn't confirm after writing some or all of it. */
class NotConfirmed extends Error {}

function serverOf(v: unknown): McpServer | undefined {
  const s = obj(v);
  const name = str(s.name);
  if (!name) return undefined;
  const transport = s.transport === "stdio" || s.transport === "http" ? s.transport : "unknown";
  const plugin = s.source === "plugin" ? str(s.plugin) || "a plugin" : undefined;
  const auth: Auth = s.auth === "oauth" ? "oauth" : s.auth === "header" ? "header" : "none";
  return {
    name,
    transport,
    url: str(s.url) || undefined,
    command: str(s.command) || undefined,
    args: strs(s.args),
    envKeys: Object.keys(obj(s.env)),
    auth,
    enabled: s.enabled !== false,
    toolFilter: s.tools !== null && s.tools !== undefined,
    plugin,
    changeable: !plugin && NAME.test(name),
  };
}

function toolsOf(v: unknown): McpTool[] {
  return (Array.isArray(v) ? v : []).flatMap((t) => {
    const name = str(obj(t).name);
    return name ? [{ name, description: str(obj(t).description) }] : [];
  });
}

function flowOf(v: unknown): OAuthFlow {
  const f = obj(v);
  const status = str(f.status);
  return {
    flowId: str(f.flow_id),
    server: str(f.server_name),
    status: status === "starting" || status === "authorization_required" || status === "approved" ? status : "error",
    authorizationUrl: str(f.authorization_url) || undefined,
    error: str(f.error) || (status === "error" || !["starting", "authorization_required", "approved"].includes(status) ? "Hermes didn't say why." : undefined),
    tools: Array.isArray(f.tools) ? toolsOf(f.tools) : undefined,
  };
}

/** Whether `s`, as Hermes lists it, is what `form` asked for. */
export function matches(s: McpServer | undefined, form: ServerForm): boolean {
  if (!s || s.name !== form.name) return false;
  if (form.transport === "stdio")
    return (
      s.transport === "stdio" &&
      s.command === form.command.trim() &&
      s.args.length === form.args.length &&
      s.args.every((a, i) => a === form.args[i]) &&
      [...s.envKeys].sort().join("\n") === form.env.map((e) => e.key).sort().join("\n")
    );
  return s.transport === "http" && s.url === form.url.trim() && s.auth === form.auth;
}

/** What `form` lacks before it can be sent, in words; undefined when it's complete. `editing`: secrets may be left blank. */
export function formProblem(form: ServerForm, editing: boolean, taken: string[]): string | undefined {
  if (!NAME.test(form.name)) return "A name is a letter or digit, then up to 63 letters, digits, '-', '_' or '.'.";
  if (taken.includes(form.name)) return `This profile already has a server named ${form.name}.`;
  if (form.transport === "stdio") {
    if (!form.command.trim() || /[\u0000-\u001f]/.test(form.command)) return "Type the command to run, on one line.";
    const keys = form.env.map((e) => e.key);
    const bad = keys.find((k) => !envNameOk(k));
    if (bad !== undefined) return `${bad || "An empty name"} isn't an environment variable's name: letters, digits and '_', not starting with a digit.`;
    const twice = keys.find((k, i) => keys.indexOf(k) !== i);
    if (twice) return `${twice} is listed twice.`;
    if (!editing && form.env.some((e) => e.value === undefined)) return "Type a value for each environment variable.";
    if (form.env.some((e) => e.value !== undefined && /[\n\r]/.test(e.value))) return "Each value goes on one line.";
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(form.url.trim());
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.host) return "Type the server's address, starting with http:// or https://.";
  const token = form.bearerToken?.trim().replace(/^bearer\s+/i, "") ?? "";
  if (form.auth === "header" && !editing && !token) return "Paste the bearer token.";
  if (token && /[\n\r]/.test(token)) return "Paste the bearer token on one line.";
  return undefined;
}

/** The body of `POST /api/mcp/servers` for `form`, as `MCPServerCreate` takes it. */
function createBody(form: ServerForm): Json {
  if (form.transport === "stdio") {
    const env = Object.fromEntries(form.env.map((e) => [e.key, e.value ?? ""]));
    return { name: form.name, command: form.command.trim(), ...(form.args.length && { args: form.args }), ...(form.env.length && { env }) };
  }
  return {
    name: form.name,
    url: form.url.trim(),
    auth: form.auth,
    ...(form.auth === "header" && { bearer_token: form.bearerToken?.trim() ?? "" }),
  };
}

/** What Rust's edit takes for `form`, editing the server named `name`. */
export function editOf(name: string, form: ServerForm): McpEdit {
  const server: McpEdit["server"] =
    form.transport === "stdio"
      ? { transport: "stdio", command: form.command.trim(), args: form.args, env: form.env.map((e) => (e.value === undefined ? { key: e.key } : { key: e.key, value: e.value })) }
      : { transport: "http", url: form.url.trim(), auth: form.auth, ...(form.auth === "header" && form.bearerToken?.trim() && { bearerToken: form.bearerToken.trim() }) };
  return { name, ...(form.name !== name && { newName: form.name }), server };
}

/**
 * Settings → MCP servers' reads and writes. Every call names its profile, so a profile switch can't redirect one.
 * `rest` is the relay; `edit` is Rust's single-server edit; `noMcp` reads which platforms' toolset lists turn MCP off
 * (`no_mcp`, from Rust's toolset guards).
 */
export class McpApi {
  constructor(
    private rest: McpRest,
    private editInRust: (profile: string, edit: McpEdit) => Promise<void>,
    private noMcpOf: (profile: string) => Promise<string[]>,
  ) {}

  async list(profile: string): Promise<McpList> {
    let res: unknown;
    try {
      res = await this.rest("GET", `api/mcp/servers?${q(profile)}`);
    } catch (e) {
      const f = failureOf(e);
      if (noRoute(f)) throw new McpUnsupportedError("This Hermes server has no MCP server routes (/api/mcp/servers). Updating Hermes adds them.");
      throw new Error(f.reason);
    }
    const rows = obj(res).servers;
    if (!Array.isArray(rows)) throw new Error("Hermes answered with something other than a list of MCP servers.");
    return { profile, servers: rows.flatMap((r) => serverOf(r) ?? []), readAt: Date.now() };
  }

  /** The platforms whose toolset list has `no_mcp` in this profile, so MCP is off there; `cli` is this app's chats. */
  noMcp(profile: string): Promise<string[]> {
    return this.noMcpOf(profile);
  }

  /** Reads the list again after a change; undefined if it can't be read. */
  private async again(profile: string): Promise<McpList | undefined> {
    return this.list(profile).catch(() => undefined);
  }

  /**
   * Runs `write`, then decides from the list read again whether `done` holds. `listSettles`: whether a failed write that
   * the list then shows counts as saved. Not for an edit: the list can't show a secret, and Rust has confirmed or not.
   */
  private async change(
    profile: string,
    write: () => Promise<unknown>,
    done: (l: McpList) => boolean,
    note?: (res: unknown) => string | undefined,
    listSettles = true,
  ): Promise<McpChange> {
    let res: unknown;
    try {
      res = await write();
    } catch (e) {
      const f = failureOf(e);
      // Refused before anything was sent: by this app, by Rust's checks, or with no connection.
      if (e instanceof RefusedFirst || f.notRelayed || /^Not connected to Hermes/.test(f.reason)) return { kind: "refused", reason: f.reason, list: await this.again(profile) };
      if (f.signedOut) return { kind: "unconfirmed", reason: f.reason };
      const list = await this.again(profile);
      if (refusedBy(f) && !(e instanceof NotConfirmed)) return { kind: "refused", reason: f.reason, list };
      // A lost answer may still have landed: the list settles it, when it can show all of the change.
      if (listSettles && list && done(list)) return { kind: "saved", list };
      return { kind: "unconfirmed", reason: f.reason, list };
    }
    const list = await this.again(profile);
    if (!list) return { kind: "unconfirmed", reason: "Hermes answered, but the list couldn't be read again to confirm it." };
    if (!done(list)) return { kind: "unconfirmed", reason: "Hermes answered, but the list read again doesn't show the change.", list };
    return { kind: "saved", list, note: note?.(res) };
  }

  add(profile: string, form: ServerForm): Promise<McpChange> {
    return this.change(
      profile,
      () => this.rest("POST", `api/mcp/servers?${q(profile)}`, createBody(form)),
      (l) => matches(l.servers.find((s) => s.name === form.name), form),
    );
  }

  edit(profile: string, name: string, form: ServerForm): Promise<McpChange> {
    return this.change(
      profile,
      () =>
        this.editInRust(profile, editOf(name, form)).catch((e: unknown) => {
          const m = e instanceof Error ? e.message : String(e);
          // Something may have been written (the token, or the map) that Rust couldn't confirm.
          if (/^Not confirmed: /.test(m)) throw new NotConfirmed(m.replace(/^Not confirmed: /, ""));
          // A failed request: Hermes's refusal (4xx, nothing written), or a lost answer.
          if (/^(The dashboard answered|Can't reach)|sign-in has expired/i.test(m)) throw e;
          // Rust's own refusals, before anything was sent, come as plain sentences.
          throw new RefusedFirst(m);
        }),
      (l) => matches(l.servers.find((s) => s.name === form.name), form) && (form.name === name || !l.servers.some((s) => s.name === name)),
      undefined,
      false,
    );
  }

  remove(profile: string, name: string): Promise<McpChange> {
    return this.change(
      profile,
      async () => {
        try {
          return await this.rest("DELETE", `api/mcp/servers/${encodeURIComponent(name)}?${q(profile)}`);
        } catch (e) {
          // Gone already is what was asked.
          if (failureOf(e).status === 404 && failureOf(e).reason !== "Not Found") return { ok: true };
          throw e;
        }
      },
      (l) => !l.servers.some((s) => s.name === name),
    );
  }

  setEnabled(profile: string, name: string, enabled: boolean): Promise<McpChange> {
    return this.change(
      profile,
      () => this.rest("PUT", `api/mcp/servers/${encodeURIComponent(name)}/enabled?${q(profile)}`, { enabled }),
      (l) => l.servers.find((s) => s.name === name)?.enabled === enabled,
    );
  }

  /** Connects to the server, lists its tools and disconnects, on the server. Slow: it may start the server first. */
  async test(profile: string, name: string): Promise<McpTest> {
    let res: Json;
    try {
      res = obj(await this.rest("POST", `api/mcp/servers/${encodeURIComponent(name)}/test?${q(profile)}`));
    } catch (e) {
      return { ok: false, error: failureOf(e).reason, at: Date.now() };
    }
    if (res.ok !== true) return { ok: false, error: str(res.error) || "Hermes couldn't connect to it, and didn't say why.", at: Date.now() };
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    return { ok: true, tools: toolsOf(res.tools), prompts: n(res.prompts), resources: n(res.resources), at: Date.now() };
  }

  /** Starts an OAuth sign-in; the flow says where to go (`authorizationUrl`) once Hermes has it. */
  async startSignIn(profile: string, name: string): Promise<OAuthFlow> {
    try {
      return flowOf(await this.rest("POST", `api/mcp/servers/${encodeURIComponent(name)}/auth?${q(profile)}`));
    } catch (e) {
      throw new Error(failureOf(e).reason);
    }
  }

  async signInStatus(flowId: string): Promise<OAuthFlow> {
    try {
      return flowOf(await this.rest("GET", `api/mcp/oauth/flows/${encodeURIComponent(flowId)}`));
    } catch (e) {
      throw new Error(failureOf(e).reason);
    }
  }

  async cancelSignIn(flowId: string): Promise<void> {
    await this.rest("DELETE", `api/mcp/oauth/flows/${encodeURIComponent(flowId)}`).catch(() => undefined);
  }

  async catalog(profile: string): Promise<Catalog> {
    let res: Json;
    try {
      res = obj(await this.rest("GET", `api/mcp/catalog?${q(profile)}`));
    } catch (e) {
      throw new Error(failureOf(e).reason);
    }
    const entries = (Array.isArray(res.entries) ? res.entries : []).flatMap((v): CatalogEntry[] => {
      const e = obj(v);
      const name = str(e.name);
      if (!name) return [];
      return [
        {
          name,
          description: str(e.description),
          transport: str(e.transport),
          authType: str(e.auth_type) || "none",
          requiredEnv: (Array.isArray(e.required_env) ? e.required_env : []).flatMap((r) => {
            const env = obj(r);
            return str(env.name) ? [{ name: str(env.name), prompt: str(env.prompt), required: env.required !== false }] : [];
          }),
          command: str(e.command) || undefined,
          args: strs(e.args),
          url: str(e.url) || undefined,
          needsInstall: e.needs_install === true,
          installUrl: str(e.install_url) || undefined,
          bootstrap: strs(e.bootstrap),
          postInstall: str(e.post_install),
          installed: e.installed === true,
        },
      ];
    });
    const problems = (Array.isArray(res.diagnostics) ? res.diagnostics : []).map((d) => `${str(obj(d).name)}: ${str(obj(d).message)}`);
    return { entries, problems };
  }

  /** Installs a catalog entry for the profile. One that builds on the server does so in the background. */
  install(profile: string, entry: CatalogEntry, env: Record<string, string>): Promise<McpChange> {
    const filled = Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()));
    // Set only by Hermes's answer that it started the install in the background; a failed request leaves it false.
    let started = false;
    return this.change(
      profile,
      async () => {
        const res = await this.rest("POST", `api/mcp/catalog/install?${q(profile)}`, { name: entry.name, env: filled, enable: true });
        started = obj(res).background === true;
        return res;
      },
      // A background install shows up once it's done: its started answer counts, and otherwise only the list.
      (l) => started || l.servers.some((s) => s.name === entry.name),
      (res) =>
        obj(res).background === true
          ? "Hermes is installing it on the server in the background (it clones and builds it). It shows in the list once that's done: read the list again in a minute."
          : undefined,
    );
  }
}
