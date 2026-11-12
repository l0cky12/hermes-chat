// Settings → Memory → External memory: which memory provider each profile uses, and each provider's settings, read
// from and written to dashboard REST on the deployed checkout (`f0d94882e8`, v0.22.6; research doc "Memory providers",
// ADR 0045):
//
// - `GET /api/memory?profile=` → `{active, providers: [{name, description, status, setup}]}`. `active` is the profile's
//   `memory.provider` ("" for built-in memory only). The providers are the ones Hermes finds for that profile: bundled
//   (`byterover`, `retaindb`), the profile's own `plugins/` folder (Honcho, Mem0, … from Hermes's plugin catalog) and
//   pip entry points, so two profiles can list different ones.
// - `PUT /api/memory/provider?profile=` `{provider}` switches the profile, refusing (400) one that isn't `ready`.
// - `GET /api/memory/providers/{name}/config?profile=[&surface=declared]` lists a provider's settings. A provider with a
//   `config_schema.py` (Honcho) has a full "declared" surface, read per profile from where the provider reads it; any
//   other has the "legacy" surface from `get_config_schema()`. Secrets come back only as `is_set`.
// - `PUT …/config?profile=[&surface=declared]` `{values}` writes the settings AND sets `memory.provider` to that provider.
//   Both keep what Hermes has for a key not sent, and a blank secret. The legacy one then refuses (400) a provider that
//   isn't ready yet, after it has written. So every answer, a refusal included, is followed by a read back.
// - `POST …/setup?profile=` `{values: {}}` installs what the provider's manifest declares: Python packages into its
//   plugin environment and external tools by the manifest's own shell command. Only sent once the owner has seen them.
//
// Hermes picks the provider when it builds a chat's agent, so a change reaches chats started after it.
import { failureOf, type Failure } from "./toolsets";
import { errorText, textOrEmpty } from "./values";

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type Rest = (method: "GET" | "PUT" | "POST", pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** How Hermes rates a provider for one profile (`_memory_provider_status`). */
export type ProviderStatus = "ready" | "needs_config" | "unavailable" | "missing";

/** What a provider needs installed on the server, from its manifest (`_memory_provider_setup_info`). */
export type ProviderSetup = {
  /** Python packages Hermes installs into the provider's own environment. */
  pip: string[];
  /** It declares Python packages, listed or not. */
  python: boolean;
  /** Programs it needs, each with the shell command that installs it and the one that checks it. */
  external: { name: string; install: string; check: string }[];
  /** Environment variables it needs. */
  requiredEnv: string[];
  /** Everything above is installed. */
  installed: boolean;
};

export type ProviderRow = { name: string; description: string; status: ProviderStatus | string; setup: ProviderSetup };

/** One profile's provider and the providers Hermes finds for it. `active` is "" for built-in memory only. */
export type ProfileMemory = { profile: string; active: string; providers: ProviderRow[]; readAt: number };

export type FieldKind = "text" | "secret" | "select" | "bool" | "number" | "json";

export type ProviderField = {
  key: string;
  label: string;
  kind: FieldKind;
  description: string;
  placeholder: string;
  /** As Hermes reads it now; always "" for a secret. */
  value: string;
  /** Hermes has a value for it: for a secret, the only thing it says. */
  isSet: boolean;
  options: { value: string; label: string }[];
  required: boolean;
  /** The heading it goes under; "" for none. */
  group: string;
  /** One of the provider's main settings; the others go under More settings. */
  main: boolean;
  /** Where to get a key for it, when the provider says. */
  url: string;
  /** Shown only while these other fields hold these values (legacy `when`). */
  when?: Record<string, string>;
  /** What Hermes uses while it's blank, when Hermes says (Honcho's workspace and AI peer: the profile's host). */
  inUse?: string;
  /** Kept once for every profile reading the same provider config file (`fileWide`). */
  shared?: boolean;
};

/** A provider's settings for one profile, on the surface Hermes reads and writes them through. */
export type ProviderForm = {
  profile: string;
  name: string;
  label: string;
  docsUrl: string;
  surface: "declared" | "legacy";
  fields: ProviderField[];
  readAt: number;
};

/** What a write came to. Every kind but `unknown` carries what Hermes has now, read after the attempt. */
export type MemoryChange =
  | { kind: "saved"; memory: ProfileMemory; form?: ProviderForm }
  /** Not sent: Hermes has something else now than what the owner saw. `what` says what changed. */
  | { kind: "conflict"; what: string; memory: ProfileMemory; form?: ProviderForm }
  /**
   * Hermes refused with a 4xx. `wrote`: reading back shows the settings as sent anyway (the legacy surface writes
   * before it checks the provider is ready).
   */
  | { kind: "refused"; reason: string; wrote: boolean; memory?: ProfileMemory; form?: ProviderForm }
  /** Accepted, but reading back shows something else: `fields` the settings that differ, and which provider is in use. */
  | { kind: "mismatch"; fields: string[]; memory: ProfileMemory; form?: ProviderForm }
  /** The answer was lost, or a server error, and reading back doesn't show the change. It may yet land. */
  | { kind: "unknown"; reason: string; memory?: ProfileMemory; form?: ProviderForm };

export type SetupStep = { kind: string; name: string; status: string; command: string; returncode: number | null; output: string };
export type SetupOutcome =
  | { kind: "done"; ok: boolean; steps: SetupStep[]; memory?: ProfileMemory }
  /** Not sent: what the provider needs installed changed since the owner confirmed it. */
  | { kind: "changed"; memory: ProfileMemory }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string; memory?: ProfileMemory };

/** One profile in the overview: its provider and, where this app knows what decides it, which memory store it uses. */
export type OverviewRow =
  | { profile: string; ok: true; active: string; status?: string; store?: Store }
  | { profile: string; ok: false; reason: string };

/** The settings that decide which memory a profile's provider reads and writes. `key` is equal for the same store. */
export type Store = { key: string; parts: { label: string; value: string }[] };

/**
 * Per provider, the settings that pick the store it reads and writes, where this app knows them. Honcho keeps memory
 * in a workspace on a server, with a peer for the user and one for the agent: profiles with all of these equal share
 * memory. Its blank workspace and AI peer mean the profile's own host (`hermes`, `hermes_<profile>`), which the declared
 * surface puts in the placeholder.
 * ponytail: Honcho only, as every profile on the deployed server uses it; add a provider here once one is in use.
 */
const STORES: Record<string, { keys: string[]; blankIsPlaceholder: string[]; fileWide: string[] }> = {
  honcho: { keys: ["baseUrl", "environment", "workspace", "aiPeer", "peerName"], blankIsPlaceholder: ["workspace", "aiPeer"], fileWide: ["baseUrl", "timeout", "sessions"] },
};

/**
 * Settings Hermes keeps once for every profile that reads the same provider config file, not per profile: Honcho's
 * `scope="root"` fields, written to the root of the shared `honcho.json` (`_write_provider_honcho`).
 */
export const fileWide = (provider: string, key: string) => !!STORES[provider]?.fileWide.includes(key);

/** Hermes's own provider names (`_MEMORY_PROVIDER_NAME_RE`); anything else isn't sent in a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const sendableName = (name: string) => NAME.test(name);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "object" ? JSON.stringify(v) : String(v));

export class MemoryProvidersUnsupported extends Error {}

function setupOf(v: unknown): ProviderSetup {
  const s = obj(v);
  return {
    pip: strs(s.pip_dependencies),
    python: s.python_dependencies_declared === true || strs(s.pip_dependencies).length > 0,
    external: (Array.isArray(s.external_dependencies) ? s.external_dependencies : [])
      .map((d) => ({ name: textOrEmpty(obj(d).name), install: textOrEmpty(obj(d).install), check: textOrEmpty(obj(d).check) }))
      .filter((d) => d.name || d.install || d.check),
    requiredEnv: strs(s.required_env),
    // Older answers may not say; then it isn't claimed to need installing.
    installed: s.dependencies_installed !== false,
  };
}

function memoryOf(profile: string, res: unknown): ProfileMemory {
  const r = obj(res);
  if (typeof r.active !== "string" || !Array.isArray(r.providers)) throw new Error("Hermes answered with something other than the profile's memory status.");
  return {
    profile,
    active: r.active,
    providers: r.providers.flatMap((p): ProviderRow[] => {
      const row = obj(p);
      const name = textOrEmpty(row.name);
      return name ? [{ name, description: textOrEmpty(row.description), status: textOrEmpty(row.status) || "unavailable", setup: setupOf(row.setup) }] : [];
    }),
    readAt: Date.now(),
  };
}

const KINDS: Record<string, FieldKind> = { text: "text", secret: "secret", select: "select", bool: "bool", boolean: "bool", number: "number", integer: "number", json: "json" };

function formOf(profile: string, name: string, res: unknown, surface: ProviderForm["surface"]): ProviderForm {
  const r = obj(res);
  const blankIsPlaceholder = surface === "declared" ? (STORES[name]?.blankIsPlaceholder ?? []) : [];
  const fields = (Array.isArray(r.fields) ? r.fields : []).flatMap((f): ProviderField[] => {
    const raw = obj(f);
    const key = textOrEmpty(raw.key);
    if (!key) return [];
    const kind = KINDS[textOrEmpty(raw.kind)] ?? "text";
    const when = obj(raw.when);
    const placeholder = textOrEmpty(raw.placeholder);
    return [
      {
        key,
        label: textOrEmpty(raw.label) || key,
        kind,
        description: textOrEmpty(raw.description),
        placeholder,
        value: kind === "secret" ? "" : text(raw.value),
        isSet: raw.is_set === true,
        options: (Array.isArray(raw.options) ? raw.options : []).map((o) => ({ value: text(obj(o).value), label: textOrEmpty(obj(o).label) || text(obj(o).value) })),
        required: raw.required === true,
        group: textOrEmpty(raw.group),
        // The legacy surface has no main/other split: all of it is the main settings.
        main: surface === "legacy" || raw.inline === true,
        url: textOrEmpty(raw.url),
        ...(Object.keys(when).length ? { when: Object.fromEntries(Object.entries(when).map(([k, v]) => [k, text(v)])) } : {}),
        ...(blankIsPlaceholder.includes(key) && placeholder ? { inUse: placeholder } : {}),
        ...(surface === "declared" && fileWide(name, key) ? { shared: true } : {}),
      },
    ];
  });
  return { profile, name, label: textOrEmpty(r.label) || name, docsUrl: textOrEmpty(r.docs_url), surface, fields, readAt: Date.now() };
}

/** Whether `field` shows with these values (legacy `when`; Hermes compares the dependency's value as a string). */
export function visible(field: ProviderField, values: Record<string, string>): boolean {
  return !field.when || Object.entries(field.when).every(([k, v]) => (values[k] ?? "") === v);
}

const truthy = (v: string) => ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

/** Whether Hermes's reading back of a setting is the value sent, as its kind compares. */
export function sameValue(kind: FieldKind, a: string, b: string): boolean {
  if (kind === "bool") return truthy(a) === truthy(b);
  if (kind === "number") return a.trim() !== "" && b.trim() !== "" ? Number(a) === Number(b) : a.trim() === b.trim();
  if (kind === "json")
    try {
      return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
    } catch {
      return a.trim() === b.trim();
    }
  return a.trim() === b.trim();
}

/** Why a value can't be sent for `field`, before Hermes is asked; undefined when it can. */
export function valueProblem(field: ProviderField, value: string): string | undefined {
  const v = value.trim();
  if (!v) return field.required && !(field.kind === "secret" && field.isSet) ? `${field.label} is required.` : undefined;
  // As Python's float() reads it: no hex, binary or octal, which JavaScript's Number() would take.
  if (field.kind === "number" && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return `${field.label} must be a number.`;
  if (field.kind === "json") {
    try {
      const parsed = JSON.parse(v);
      if (!parsed || typeof parsed !== "object") return `${field.label} must be a JSON object or list.`;
    } catch {
      return `${field.label} isn't valid JSON.`;
    }
  }
  if (field.kind === "select" && field.options.length && !field.options.some((o) => o.value === v)) return `${field.label} must be one of its choices.`;
  return undefined;
}

/** The store `form`'s settings point at, for a provider this app knows that of; undefined otherwise. */
export function storeOf(form: ProviderForm): Store | undefined {
  const known = STORES[form.name];
  if (!known || form.surface !== "declared") return undefined;
  // A base URL overrides the environment (Honcho: "Ignored when a base URL is set").
  const base = form.fields.find((f) => f.key === "baseUrl")?.value;
  const parts = known.keys.flatMap((k) => {
    const f = form.fields.find((x) => x.key === k);
    return f && !(base && k === "environment") ? [{ label: f.label, value: f.value || f.inUse || "" }] : [];
  });
  if (!parts.length) return undefined;
  return { key: JSON.stringify([form.name, ...parts.map((p) => p.value)]), parts: parts.filter((p) => p.value) };
}

/**
 * The values to put in `target` so its settings match `source`'s: every setting both have, other than secrets, which
 * Hermes never sends back. A blank that means the source profile's own host takes that host, so the target points at
 * the same store rather than its own. Only the settings that differ are returned.
 */
export function copiedValues(source: ProviderForm, target: ProviderForm): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of target.fields) {
    if (t.kind === "secret") continue;
    const s = source.fields.find((f) => f.key === t.key && f.kind === t.kind);
    if (!s) continue;
    const value = s.value || s.inUse || "";
    if (!sameValue(t.kind, value, t.value)) out[t.key] = value;
  }
  return out;
}

/**
 * Settings → Memory's external memory reads and writes. Every call names its profile. Writes go one at a time for the
 * whole app, so a later one is checked against what an earlier one left.
 */
export class MemoryProvidersApi {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly rest: Rest) {}

  private q(profile: string, extra: Record<string, string> = {}) {
    return new URLSearchParams({ profile, ...extra }).toString();
  }

  /** The server's profiles, by name. */
  async profiles(): Promise<string[]> {
    const res = obj(await this.rest("GET", "api/profiles"));
    const names = (Array.isArray(res.profiles) ? res.profiles : []).map((p) => textOrEmpty(obj(p).name)).filter(Boolean);
    if (!names.length) throw new Error("Hermes answered with no profiles.");
    return names;
  }

  /** `GET /api/memory` for `profile`. A server without the route throws `MemoryProvidersUnsupported`. */
  async read(profile: string): Promise<ProfileMemory> {
    try {
      return memoryOf(profile, await this.rest("GET", `api/memory?${this.q(profile)}`));
    } catch (e) {
      const f = failureOf(e);
      if (f.status === 405 || (f.status === 404 && f.reason === "Not Found"))
        throw new MemoryProvidersUnsupported("This Hermes server doesn't list memory providers: it has no /api/memory route. Updating Hermes adds it.");
      throw new Error(f.reason);
    }
  }

  /**
   * `name`'s settings for `profile`: the declared surface when the provider has one, else the legacy surface. Hermes
   * answers both for any name, with no fields when it has none.
   */
  async form(profile: string, name: string): Promise<ProviderForm> {
    if (!sendableName(name)) throw new Error("This app can't send that provider's name to Hermes.");
    const path = `api/memory/providers/${encodeURIComponent(name)}/config`;
    try {
      const declared = formOf(profile, name, await this.rest("GET", `${path}?${this.q(profile, { surface: "declared" })}`), "declared");
      if (declared.fields.length) return declared;
      return formOf(profile, name, await this.rest("GET", `${path}?${this.q(profile)}`), "legacy");
    } catch (e) {
      throw new Error(failureOf(e).reason);
    }
  }

  /**
   * Each profile's provider. For a provider whose store this app knows (`STORES`), its settings are read too, so the
   * overview can say which profiles share memory. A profile that can't be read says why; the rest still show.
   */
  async overview(profiles: string[]): Promise<OverviewRow[]> {
    return Promise.all(
      profiles.map(async (profile): Promise<OverviewRow> => {
        try {
          const m = await this.read(profile);
          const status = m.providers.find((p) => p.name === m.active)?.status ?? (m.active ? "missing" : undefined);
          const store = m.active && STORES[m.active] ? await this.form(profile, m.active).then(storeOf, () => undefined) : undefined;
          return { profile, ok: true, active: m.active, ...(status ? { status } : {}), ...(store ? { store } : {}) };
        } catch (e) {
          return { profile, ok: false, reason: errorText(e) };
        }
      }),
    );
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => {});
    return done;
  }

  /**
   * Makes `name` ("" for built-in memory only) the profile's provider, if Hermes still has `expected` in use, then reads
   * it back. Hermes refuses a provider that isn't ready.
   */
  use(profile: string, name: string, expected: string): Promise<MemoryChange> {
    return this.serial(async () => {
      if (name && !sendableName(name)) return { kind: "refused", reason: "This app can't send that provider's name to Hermes.", wrote: false };
      const before = await this.read(profile);
      if (before.active !== expected) return { kind: "conflict", what: "provider", memory: before };
      if (before.active === name) return { kind: "saved", memory: before };
      try {
        await this.rest("PUT", `api/memory/provider?${this.q(profile)}`, { provider: name });
      } catch (e) {
        const f = failureOf(e);
        if (f.notRelayed) return { kind: "refused", reason: f.reason, wrote: false };
        const memory = await this.read(profile).catch(() => undefined);
        if (memory?.active === name) return { kind: "saved", memory };
        if (f.status !== undefined && f.status < 500) return { kind: "refused", reason: f.reason, wrote: false, memory };
        return { kind: "unknown", reason: f.reason, memory };
      }
      const memory = await this.read(profile).catch((e) => e as Error);
      if (memory instanceof Error) return { kind: "unknown", reason: `Hermes took the change, but reading it back failed: ${memory.message}` };
      return memory.active === name ? { kind: "saved", memory } : { kind: "mismatch", fields: [], memory };
    });
  }

  /**
   * Writes `values` (the settings the owner changed, and any secret they typed) for `form`'s provider and profile,
   * which also makes it the profile's provider, then reads both back. Nothing is sent if a setting the owner changed
   * is no longer what they saw on Hermes. A blank secret is never sent: Hermes keeps the one it has.
   */
  save(form: ProviderForm, values: Record<string, string>, expected: string): Promise<MemoryChange> {
    return this.serial(async () => {
      const { profile, name } = form;
      if (!sendableName(name)) return { kind: "refused", reason: "This app can't send that provider's name to Hermes.", wrote: false };
      // A field the owner can't see (legacy `when`) isn't sent: Hermes would drop it, and it can't be checked on screen.
      const shownWith = { ...Object.fromEntries(form.fields.map((f) => [f.key, f.value])), ...values };
      const sent = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => form.fields.some((f) => f.key === k && visible(f, shownWith) && (f.kind !== "secret" || v.trim()))),
      );
      // An empty write would still switch the provider, without the readiness check `use` gets.
      if (!Object.keys(sent).length) return { kind: "refused", reason: "There are no changed settings to save.", wrote: false };
      for (const [k, v] of Object.entries(sent)) {
        const problem = valueProblem(form.fields.find((f) => f.key === k)!, v);
        if (problem) return { kind: "refused", reason: problem, wrote: false };
      }
      const [memoryBefore, now] = await Promise.all([this.read(profile), this.form(profile, name)]);
      // Saving also switches the provider, so it mustn't undo a switch made elsewhere since the owner looked.
      if (memoryBefore.active !== expected) return { kind: "conflict", what: "provider", memory: memoryBefore, form: now };
      if (now.surface !== form.surface) return { kind: "conflict", what: "the provider's settings", memory: memoryBefore, form: now };
      const changed = Object.keys(sent).filter((k) => {
        const was = form.fields.find((f) => f.key === k)!;
        const is = now.fields.find((f) => f.key === k);
        return was.kind !== "secret" && (!is || is.value !== was.value);
      });
      if (changed.length) {
        const labels = changed.map((k) => form.fields.find((f) => f.key === k)!.label);
        return { kind: "conflict", what: labels.join(", "), memory: memoryBefore, form: now };
      }
      const path = `api/memory/providers/${encodeURIComponent(name)}/config?${this.q(profile, form.surface === "declared" ? { surface: "declared" } : {})}`;
      let failure: Failure | undefined;
      try {
        await this.rest("PUT", path, { values: sent });
      } catch (e) {
        failure = failureOf(e);
        if (failure.notRelayed) return { kind: "refused", reason: failure.reason, wrote: false };
      }
      const [memory, after] = await Promise.all([this.read(profile).catch(() => undefined), this.form(profile, name).catch(() => undefined)]);
      const differ = after
        ? Object.entries(sent).flatMap(([k, v]) => {
            const f = after.fields.find((x) => x.key === k);
            if (!f) return [form.fields.find((x) => x.key === k)!.label];
            if (f.kind === "secret") return f.isSet ? [] : [f.label];
            // A blank clears the setting, which then reads as its default: nothing to compare.
            return !v.trim() || sameValue(f.kind, f.value, v) ? [] : [f.label];
          })
        : undefined;
      // Only a value that reads back as sent shows a write: a blank or a secret reads the same either way.
      const confirmed = Object.entries(sent).some(([k, v]) => v.trim() && after?.fields.find((f) => f.key === k)?.kind !== "secret");
      const wrote = differ !== undefined && differ.length === 0 && confirmed;
      if (failure) {
        if (wrote && memory?.active === name) return { kind: "saved", memory, form: after };
        if (failure.status !== undefined && failure.status < 500) return { kind: "refused", reason: failure.reason, wrote, memory, form: after };
        return { kind: "unknown", reason: failure.reason, memory, form: after };
      }
      if (!memory || !after) return { kind: "unknown", reason: "Hermes took the settings, but reading them back failed.", memory, form: after };
      if (differ?.length || memory.active !== name) return { kind: "mismatch", fields: differ ?? [], memory, form: after };
      return { kind: "saved", memory, form: after };
    });
  }

  /**
   * Installs what `name`'s manifest declares on the server, for `profile`, then reads the profile's providers again.
   * `confirmed` is what the owner was shown; Hermes reads the manifest again when it runs, so nothing is sent if that
   * now says something else.
   */
  setup(profile: string, name: string, confirmed: ProviderSetup): Promise<SetupOutcome> {
    return this.serial(async () => {
      if (!sendableName(name)) return { kind: "refused", reason: "This app can't send that provider's name to Hermes." };
      const now = await this.read(profile);
      const row = now.providers.find((p) => p.name === name);
      const plan = (s: ProviderSetup) => JSON.stringify([s.python, s.pip, s.external]);
      if (!row || plan(row.setup) !== plan(confirmed)) return { kind: "changed", memory: now };
      let res: Json;
      try {
        res = obj(await this.rest("POST", `api/memory/providers/${encodeURIComponent(name)}/setup?${this.q(profile)}`, { values: {} }));
      } catch (e) {
        const f = failureOf(e);
        if (f.notRelayed || (f.status !== undefined && f.status < 500)) return { kind: "refused", reason: f.reason };
        return { kind: "unknown", reason: f.reason, memory: await this.read(profile).catch(() => undefined) };
      }
      const steps = (Array.isArray(res.results) ? res.results : []).map((r) => {
        const s = obj(r);
        return {
          kind: textOrEmpty(s.kind),
          name: textOrEmpty(s.name),
          status: textOrEmpty(s.status),
          command: textOrEmpty(s.command),
          returncode: typeof s.returncode === "number" ? s.returncode : null,
          output: [textOrEmpty(s.stdout), textOrEmpty(s.stderr)].filter((x) => x.trim()).join("\n").trim(),
        };
      });
      return { kind: "done", ok: res.ok === true, steps, memory: await this.read(profile).catch(() => undefined) };
    });
  }
}
