// A fake Hermes's external memory providers, for tests of Settings → Memory → External memory: `GET /api/memory`'s
// `active` and `providers`, `PUT /api/memory/provider`, and `GET`/`PUT /api/memory/providers/{name}/config` and `POST
// …/setup`, as the deployed `f0d94882e8` answers them (`hermes_cli/web_routers/ops.py`, `memory_providers.py`;
// research doc "Memory providers"). As probed: the declared surface writes only the keys sent and switches the provider
// without checking it's ready; the legacy one writes, then refuses (400) a provider that isn't ready.
import type { RestRequest } from "./fakeHermes";
import { RestError } from "./pipe";

export type FakeField = {
  key: string;
  label?: string;
  kind: "text" | "secret" | "select" | "bool" | "number" | "json";
  default?: string;
  required?: boolean;
  options?: string[];
  inline?: boolean;
  group?: string;
  placeholder?: string;
  /** Honcho's workspace and AI peer: blank means the profile's host, which Hermes shows as the placeholder. */
  hostWhenBlank?: boolean;
  url?: string;
};

export type FakeProvider = {
  name: string;
  description: string;
  surface: "declared" | "legacy";
  fields: FakeField[];
  /** Profiles that find it; all when left out (a bundled provider). */
  profiles?: string[];
  pip?: string[];
  external?: { name: string; install: string; check: string }[];
  /** Its dependencies are installed, for each profile; true when left out. */
  installed?: boolean;
  /** Setup prepares its Python packages in an environment the running Hermes doesn't use until it restarts. */
  restartAfterSetup?: boolean;
  docsUrl?: string;
};

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));
const host = (profile: string) => (profile === "default" ? "hermes" : `hermes_${profile}`);

/** Honcho's declared surface, trimmed to what the tests use. */
export const HONCHO: FakeProvider = {
  name: "honcho",
  description: "Honcho AI-native memory — cross-session user modeling with dialectic Q&A, semantic search, and persistent conclusions.",
  surface: "declared",
  pip: ["honcho-ai>=2.2.0,<3"],
  fields: [
    { key: "apiKey", label: "API key", kind: "secret", inline: true, group: "Connection", placeholder: "Enter Honcho API key" },
    { key: "baseUrl", label: "Base URL", kind: "text", inline: true, group: "Connection", placeholder: "https://… (self-hosted)" },
    { key: "environment", label: "Environment", kind: "select", default: "production", options: ["production", "local"], inline: true, group: "Connection" },
    { key: "workspace", label: "Workspace", kind: "text", inline: true, group: "Connection", hostWhenBlank: true },
    { key: "peerName", label: "Peer name", kind: "text", inline: true, group: "Identity", placeholder: "e.g. eri" },
    { key: "aiPeer", label: "AI peer", kind: "text", inline: true, group: "Identity", hostWhenBlank: true },
    { key: "timeout", label: "Request timeout", kind: "number", group: "Connection", placeholder: "30" },
    { key: "saveMessages", label: "Save messages", kind: "bool", default: "true", group: "Message writing" },
  ],
};

export const RETAINDB: FakeProvider = {
  name: "retaindb",
  description: "RetainDB — cloud memory API with hybrid search and 7 memory types.",
  surface: "legacy",
  fields: [
    { key: "api_key", label: "Api Key", kind: "secret", required: true },
    { key: "base_url", label: "Base Url", kind: "text", default: "https://api.retaindb.com" },
    { key: "project", label: "Project", kind: "text" },
  ],
};

export const BYTEROVER: FakeProvider = {
  name: "byterover",
  description: "ByteRover — persistent knowledge tree with tiered retrieval via the brv CLI.",
  surface: "legacy",
  installed: false,
  external: [{ name: "brv", install: "curl -fsSL https://byterover.dev/install.sh | sh", check: "brv --version" }],
  fields: [
    { key: "api_key", label: "Api Key", kind: "secret" },
    { key: "auto_extract", label: "Auto Extract", kind: "select", default: "true", options: ["true", "false"] },
  ],
};

export class FakeMemoryProviders {
  providers: FakeProvider[] = [];
  /** Each profile's `memory.provider`; a profile left out uses `fallback` (FakeHermes's `memoryProvider`). */
  active: Record<string, string> = {};
  /** Stored settings, by profile, then provider. */
  values: Record<string, Record<string, Record<string, string>>> = {};
  /** Secrets set, by profile, then provider. */
  secrets: Record<string, Record<string, Set<string>>> = {};
  /** Every write, as sent. */
  readonly writes: { method: string; path: string; profile: string; body: unknown }[] = [];
  /** Runs as a write arrives, before it changes anything: another client in the middle of a save. */
  beforeWrite?: () => void;
  /** The next write fails this way: `lost` before it changes anything, `stored` after. */
  dropNext?: "lost" | "stored";
  /** `GET /api/memory` fails this way for these profiles. */
  readFailures: Record<string, Error> = {};
  /** No `/api/memory*` routes, as an old server answers. */
  routes = true;

  constructor(private known: (profile: string) => boolean) {}

  add(...providers: FakeProvider[]) {
    this.providers.push(...providers);
    return this;
  }

  private found(profile: string) {
    return this.providers.filter((p) => !p.profiles || p.profiles.includes(profile));
  }
  private store(profile: string, name: string) {
    return ((this.values[profile] ??= {})[name] ??= {});
  }
  private secretSet(profile: string, name: string) {
    return ((this.secrets[profile] ??= {})[name] ??= new Set());
  }
  set(profile: string, name: string, values: Record<string, string>) {
    Object.assign(this.store(profile, name), values);
  }
  setSecret(profile: string, name: string, key: string) {
    this.secretSet(profile, name).add(key);
  }

  private status(profile: string, p: FakeProvider): string {
    if (p.installed === false) return "unavailable";
    const v = this.store(profile, p.name);
    const unmet = p.fields.some((f) => f.required && (f.kind === "secret" ? !this.secretSet(profile, p.name).has(f.key) : !(v[f.key] || f.default)));
    return unmet ? "needs_config" : "ready";
  }

  activeOf(profile: string, fallback: string) {
    return this.active[profile] ?? fallback;
  }

  /** `GET /api/memory`'s `active` and `providers` for `profile`. */
  memory(profile: string, fallback: string) {
    if (this.readFailures[profile]) throw this.readFailures[profile];
    return {
      active: this.activeOf(profile, fallback),
      providers: this.found(profile).map((p) => ({
        name: p.name,
        description: p.description,
        available: p.installed !== false,
        configured: true,
        status: this.status(profile, p),
        setup: {
          pip_dependencies: p.pip ?? [],
          python_dependencies_declared: !!p.pip?.length,
          external_dependencies: p.external ?? [],
          required_env: p.fields.filter((f) => f.kind === "secret" && f.required).map((f) => f.key.toUpperCase()),
          dependencies_installed: p.installed !== false,
        },
      })),
    };
  }

  private fields(profile: string, p: FakeProvider) {
    const v = this.store(profile, p.name);
    return p.fields.map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      kind: p.surface === "legacy" && f.kind === "bool" ? "boolean" : f.kind,
      description: "",
      placeholder: f.hostWhenBlank && !v[f.key] ? host(profile) : (f.placeholder ?? ""),
      inline: !!f.inline,
      group: f.group ?? "",
      required: !!f.required,
      options: (f.options ?? []).map((o) => ({ value: o, label: o, description: "" })),
      value: f.kind === "secret" ? "" : (v[f.key] ?? f.default ?? ""),
      is_set: f.kind === "secret" ? this.secretSet(profile, p.name).has(f.key) : f.key in v,
      ...(f.url ? { url: f.url } : {}),
    }));
  }

  private write(profile: string, p: FakeProvider, values: Record<string, unknown>) {
    const v = this.store(profile, p.name);
    for (const f of p.fields) {
      if (!(f.key in values)) continue;
      const sent = String(values[f.key] ?? "").trim();
      if (f.kind === "secret") {
        if (sent) this.secretSet(profile, p.name).add(f.key);
      } else if (sent) v[f.key] = sent;
      else delete v[f.key];
    }
  }

  private drop(when: "lost" | "stored") {
    if (this.dropNext !== when) return;
    this.dropNext = undefined;
    throw new Error("Can't reach the Hermes dashboard: connection reset");
  }

  /** The `/api/memory/provider*` routes; undefined for any other path. */
  route(req: RestRequest): (() => unknown) | undefined {
    const one = /^\/api\/memory\/providers\/([^/]+)\/(config|setup)$/.exec(req.path);
    const pick = req.path === "/api/memory/provider";
    if (!one && !pick) return undefined;
    return () => {
      if (!this.routes) throw answered(404, "Not Found");
      const profile = req.query.get("profile") ?? "default";
      if (!this.known(profile)) throw answered(404, `Profile '${profile}' does not exist.`);
      if (req.method !== "GET") {
        this.writes.push({ method: req.method, path: req.path, profile, body: req.body });
        this.beforeWrite?.();
        this.drop("lost");
      }
      if (pick) {
        if (req.method !== "PUT") throw answered(405, "Method Not Allowed");
        const name = String(req.body?.provider ?? "");
        const p = this.found(profile).find((x) => x.name === name);
        if (name && !p) throw answered(400, `Unknown memory provider '${name}'.`);
        if (p && this.status(profile, p) !== "ready")
          throw answered(400, `Memory provider '${name}' is not ready (${this.status(profile, p).replace("_", " ")}). Configure it in the dashboard first.`);
        this.active[profile] = name;
        this.drop("stored");
        return { ok: true, active: name };
      }
      const name = decodeURIComponent(one![1]);
      const p = this.found(profile).find((x) => x.name === name);
      const declared = req.query.get("surface") === "declared";
      if (one![2] === "setup") {
        if (req.method !== "POST") throw answered(405, "Method Not Allowed");
        if (!p) throw answered(404, `Unknown memory provider: ${name}`);
        const results = [
          ...(p.pip?.length ? [{ kind: "pip", name, status: p.restartAfterSetup ? "restart_required" : "installed", command: "hermes pm install", returncode: null, stdout: "", stderr: "" }] : []),
          ...(p.external ?? []).map((d) => ({ kind: "external_install", name: d.name, status: "installed", command: d.install, returncode: 0, stdout: "installed", stderr: "" })),
        ];
        p.installed = true;
        this.drop("stored");
        return { ok: true, provider: name, results: results.length ? results : [{ kind: "setup", name, status: "no_declared_steps", command: "", returncode: null, stdout: "", stderr: "" }] };
      }
      if (req.method === "GET") {
        if (!p || (declared ? p.surface !== "declared" : p.surface !== "legacy")) return declared ? { name, label: name, docs_url: "", fields: [] } : { name, label: name, fields: [], setup: {} };
        return { name, label: p.name[0].toUpperCase() + p.name.slice(1), docs_url: declared ? (p.docsUrl ?? `https://docs.example/${name}`) : undefined, fields: this.fields(profile, p) };
      }
      if (req.method !== "PUT") throw answered(405, "Method Not Allowed");
      if (!p) throw answered(404, `Unknown memory provider: ${name}`);
      this.write(profile, p, (req.body?.values ?? {}) as Record<string, unknown>);
      if (!declared && this.status(profile, p) !== "ready")
        throw answered(400, `Memory provider '${name}' is not ready (${this.status(profile, p).replace("_", " ")}). Configure it in the dashboard first.`);
      this.active[profile] = name;
      this.drop("stored");
      return declared ? { ok: true } : { ok: true, active: name };
    };
  }
}
