// Settings → Model: the main model, the subagent route, the auxiliary (helper task) models, and the two guardrails
// asked before an Apply. Everything is read from and written to dashboard REST on the deployed `bf0203a` (research doc
// "Model settings"); the legacy `/api/ws` generation has `config.set` for the main model only, and nothing for
// auxiliary or subagent models.
//
// The screen edits a Draft. Nothing is written until the owner applies a part, and a Draft is never kept: leaving
// Settings drops it, as the official desktop app does.

/** Hermes's reasoning levels (`hermes_constants.VALID_REASONING_EFFORTS`). `none` turns reasoning off. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const EFFORT_OFF = "none";
/** An auxiliary task's effort when it follows the main model's (`reasoning_effort: null` on the wire). */
export const AUX_INHERIT = "inherit";
/** An auxiliary task on this provider runs on the main model (`auxiliary.<task>.provider: auto`). */
export const AUX_AUTO = "auto";
/**
 * The helper task behind chat titles, Hermes's own and Regenerate title's (`llm.oneshot` defaults to it). Settings shows
 * it on its own as the Text generation model.
 */
export const TEXT_TASK = "title_generation";

/** What the catalog says a model can do (`model.options` → `providers[].capabilities[model]`). */
export type ModelCaps = { fast: boolean; reasoning: boolean };
/** A provider in the model catalog (`GET /api/model/options`). `apiUrl`: a user-defined endpoint's base URL. */
export type CatalogProvider = { slug: string; name: string; models: string[]; caps: Record<string, ModelCaps>; apiUrl?: string };

/**
 * The model new chats start with, and its defaults. `effort`: "" leaves it to Hermes, `none` is off, else a level
 * (`agent.reasoning_effort`). `fast`: `agent.service_tier` is fast.
 */
export type MainModel = { provider: string; model: string; effort: string; fast: boolean };

/**
 * How subagents (`delegate_task` children) pick their model, from `delegation.provider` and `delegation.model`:
 * - `inherit`: both empty, the main agent's provider and model.
 * - `parent-model`: a provider only; the main agent's model on that provider.
 * - `custom-model`: a model only, on the main agent's provider and credentials.
 * - `provider`: a provider and a model of its own.
 */
export type SubagentRoute = "inherit" | "parent-model" | "custom-model" | "provider";
export const SUBAGENT_ROUTES: readonly SubagentRoute[] = ["inherit", "parent-model", "custom-model", "provider"];

/** The `delegation` block, as far as this screen edits it. `effort`: "" inherits the main agent's. */
export type Subagent = {
  provider: string;
  model: string;
  /** `max_iterations`: the turns one subagent may take. */
  maxIterations: number;
  /** `max_concurrent_children`: subagents running at once. */
  maxConcurrent: number;
  /** `child_timeout_seconds`: how long a subagent may make no progress; 0 is no limit. */
  timeoutSeconds: number;
  effort: string;
  /** `delegation.base_url` is set: a direct endpoint, which beats the route and isn't edited here. */
  directEndpoint: boolean;
};

/** One helper task (`GET /api/model/auxiliary` → `tasks[]`). `provider` is `auto` when it runs on the main model. */
export type AuxTask = {
  task: string;
  label: string;
  hint: string;
  provider: string;
  model: string;
  /** `inherit`, `none` (Off), or a level. */
  effort: string;
  /** Pinned to a private or LAN endpoint, which bills no provider. */
  localEndpoint: boolean;
};

/** Settings → Model as Hermes has it now. */
export type ModelSettings = {
  main: MainModel;
  subagent: Subagent;
  /** Named routes of the advanced-delegation plugin (`delegation.backends.model_map`), not edited here. */
  namedRoutes: number;
  auxiliary: AuxTask[];
  providers: CatalogProvider[];
};

export type SubagentDraft = {
  route: SubagentRoute;
  provider: string;
  model: string;
  /** As typed; checked on Apply. */
  maxIterations: string;
  maxConcurrent: string;
  timeoutSeconds: string;
  effort: string;
};
export type AuxDraft = { provider: string; model: string; effort: string };
/** The owner's edits, one object for the whole screen. */
export type Draft = { main: MainModel; subagent: SubagentDraft; auxiliary: Record<string, AuxDraft> };

/** Labels for the built-in helper tasks (`_AUX_TASK_SLOTS` at `bf0203a`); a plugin's task brings its own. */
const AUX_LABELS: Record<string, [string, string]> = {
  title_generation: ["Text generation", "Names chats."],
  compression: ["Compression", "Summarizes a long chat so it fits the context window."],
  vision: ["Vision", "Reads images for a main model that can't."],
  approval: ["Approval checks", "Judges whether a command needs your approval."],
  skills_hub: ["Skills Hub", "Searches and installs skills."],
  mcp: ["MCP", "Helper calls made by MCP tools."],
  review: ["Review", "Reviews work before it's reported back."],
  voice_chat: ["Voice chat", "Replies in voice conversations."],
  triage_specifier: ["Triage", "Turns a request into a task spec."],
  kanban_decomposer: ["Kanban", "Breaks a task into board cards."],
  profile_describer: ["Profile descriptions", "Writes a profile's description."],
  curator: ["Curator", "Tidies memory and skills."],
};

// --- Draft rules -------------------------------------------------------------------------------------------------

export function routeOf(provider: string, model: string): SubagentRoute {
  if (provider) return model ? "provider" : "parent-model";
  return model ? "custom-model" : "inherit";
}

export function draftFrom(s: ModelSettings): Draft {
  const sub = s.subagent;
  return {
    main: { ...s.main },
    subagent: {
      route: routeOf(sub.provider, sub.model),
      provider: sub.provider,
      model: sub.model,
      maxIterations: String(sub.maxIterations),
      maxConcurrent: String(sub.maxConcurrent),
      timeoutSeconds: String(sub.timeoutSeconds),
      effort: sub.effort,
    },
    auxiliary: Object.fromEntries(s.auxiliary.map((t) => [t.task, { provider: t.provider, model: t.model, effort: t.effort }])),
  };
}

/** Picking another provider never keeps the old provider's model: the owner picks one for the new provider. */
export function chooseProvider<T extends { provider: string; model: string }>(d: T, provider: string): T {
  return provider === d.provider ? d : { ...d, provider, model: "" };
}

/** Switching route keeps what the new route uses: Inherit clears both, a provider-only route drops the model. */
export function chooseRoute(d: SubagentDraft, route: SubagentRoute): SubagentDraft {
  if (route === "inherit") return { ...d, route, provider: "", model: "" };
  if (route === "parent-model") return { ...d, route, model: "" };
  if (route === "custom-model") return { ...d, route, provider: "" };
  return { ...d, route };
}

export function chooseAuxProvider(d: AuxDraft, provider: string): AuxDraft {
  return provider === AUX_AUTO ? { ...d, provider, model: "" } : chooseProvider(d, provider);
}

export function mainModelChanged(saved: ModelSettings, d: Draft): boolean {
  return d.main.provider !== saved.main.provider || d.main.model !== saved.main.model;
}

export function mainChanged(saved: ModelSettings, d: Draft): boolean {
  return mainModelChanged(saved, d) || d.main.effort !== saved.main.effort || d.main.fast !== saved.main.fast;
}

/** Why the main model can't be applied as drafted. */
export function mainProblem(d: Draft): string | undefined {
  if (!d.main.provider) return "Choose a provider.";
  if (!d.main.model) return `Choose a model for ${d.main.provider}.`;
}

/** The `delegation` keys the drafted route writes. */
export function subagentRouteValue(d: SubagentDraft): { provider: string; model: string } {
  if (d.route === "inherit") return { provider: "", model: "" };
  if (d.route === "parent-model") return { provider: d.provider, model: "" };
  if (d.route === "custom-model") return { provider: "", model: d.model };
  return { provider: d.provider, model: d.model };
}

const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

/** Why the subagent row can't be applied as drafted. */
export function subagentProblem(d: SubagentDraft): string | undefined {
  if ((d.route === "parent-model" || d.route === "provider") && !d.provider) return "Choose the subagent provider.";
  if (d.route === "custom-model" && !d.model) return "Choose the subagent model.";
  if (d.route === "provider" && !d.model) return `Choose a model for ${d.provider}: switching provider needs one.`;
  if (!(whole(d.maxIterations) >= 1)) return "The turn limit is a whole number, 1 or more.";
  if (!(whole(d.maxConcurrent) >= 1)) return "Concurrency is a whole number, 1 or more.";
  const t = whole(d.timeoutSeconds);
  if (!(t === 0 || t >= 30)) return "The timeout is 0 (no limit) or 30 seconds or more.";
}

/** The `delegation` keys that differ from Hermes's, or undefined when nothing does. Call once `subagentProblem` is clear. */
export function subagentPatch(saved: ModelSettings, d: SubagentDraft): Record<string, string | number> | undefined {
  const s = saved.subagent;
  const route = subagentRouteValue(d);
  const next: Record<string, string | number> = {
    provider: route.provider,
    model: route.model,
    max_iterations: whole(d.maxIterations),
    max_concurrent_children: whole(d.maxConcurrent),
    child_timeout_seconds: whole(d.timeoutSeconds),
    reasoning_effort: d.effort,
  };
  const was: Record<string, string | number> = {
    provider: s.provider,
    model: s.model,
    max_iterations: s.maxIterations,
    max_concurrent_children: s.maxConcurrent,
    child_timeout_seconds: s.timeoutSeconds,
    reasoning_effort: s.effort,
  };
  const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== was[k]));
  return Object.keys(patch).length ? patch : undefined;
}

export function subagentChanged(saved: ModelSettings, d: SubagentDraft): boolean {
  const s = draftFrom(saved).subagent;
  return (Object.keys(s) as (keyof SubagentDraft)[]).some((k) => s[k] !== d[k]);
}

export function auxProblem(task: AuxTask, d: AuxDraft): string | undefined {
  if (d.provider !== AUX_AUTO && !d.model) return `${task.label}: choose a model for ${d.provider}.`;
}

/** The helper tasks whose draft differs from Hermes's. */
export function auxChanged(saved: ModelSettings, d: Draft): AuxTask[] {
  return saved.auxiliary.filter((t) => {
    const a = d.auxiliary[t.task];
    return a && (a.provider !== t.provider || a.model !== t.model || a.effort !== t.effort);
  });
}

/** `reasoning_effort` for `POST /api/model/set`: null follows the main model's effort, `none` is Off. */
export const auxEffortWire = (effort: string): string | null => (effort === AUX_INHERIT ? null : effort);

// --- Guardrails --------------------------------------------------------------------------------------------------

/**
 * The helper tasks that would keep running on another provider after the main model moves to `provider`. Mirrors the
 * server's own `_stale_aux_pins` (`hermes_cli/web_server_config.py` at `bf0203a`), which reports them only after the
 * switch: `auto`, `main` and empty follow the main model, and a pin on a local endpoint bills nobody.
 */
export function pinnedElsewhere(tasks: AuxTask[], provider: string): AuxTask[] {
  const target = provider.trim().toLowerCase();
  return tasks.filter((t) => {
    const p = t.provider.trim().toLowerCase();
    return p && p !== AUX_AUTO && p !== "main" && p !== target && !t.localEndpoint;
  });
}

/** What to ask before the main model is applied: the helper tasks Hermes has pinned elsewhere, by provider. */
export type PinnedWarning = { providers: string[]; tasks: AuxTask[] };

/** Asked when the main model changes while any helper task is pinned to a different provider. */
export function auxPinWarning(saved: ModelSettings, d: Draft): PinnedWarning | undefined {
  if (!mainModelChanged(saved, d)) return;
  const tasks = pinnedElsewhere(saved.auxiliary, d.main.provider);
  if (!tasks.length) return;
  return { providers: [...new Set(tasks.map((t) => t.provider))], tasks };
}

// --- Wire --------------------------------------------------------------------------------------------------------

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type Rest = (method: "GET" | "POST" | "PUT", pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** What an Apply of the main model did: written, or nothing written because Hermes flagged the model expensive. */
export type MainApplied = { applied: true } | { applied: false; expensive: string };
/** What an Apply of the helper tasks did: all written, or stopped at `task`, which Hermes flagged as expensive. */
export type AuxApplied = { applied: true } | { applied: false; expensive: string; task: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback);

/** A stored effort as this screen shows it: hand-written `false`/`off`/`disabled` is Off. */
function effortFromConfig(v: unknown): string {
  if (v === false) return EFFORT_OFF;
  const s = str(v).trim().toLowerCase();
  if (["false", "off", "disabled", EFFORT_OFF].includes(s)) return EFFORT_OFF;
  return (EFFORT_LEVELS as readonly string[]).includes(s) ? s : "";
}

function catalogFrom(res: unknown): CatalogProvider[] {
  const rows = obj(res).providers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): CatalogProvider[] => {
    const row = obj(r);
    const slug = str(row.slug);
    if (!slug) return [];
    const caps = Object.fromEntries(
      Object.entries(obj(row.capabilities)).map(([m, c]) => [m, { fast: obj(c).fast === true, reasoning: obj(c).reasoning !== false }]),
    );
    const models = Array.isArray(row.models) ? row.models.filter((m): m is string => typeof m === "string") : [];
    const apiUrl = str(row.api_url);
    return [{ slug, name: str(row.name) || slug, models, caps, ...(apiUrl ? { apiUrl } : {}) }];
  });
}

function auxFrom(res: unknown): AuxTask[] {
  const rows = obj(res).tasks;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): AuxTask[] => {
    const row = obj(r);
    const task = str(row.task);
    if (!task) return [];
    const [label, hint] = AUX_LABELS[task] ?? [str(row.label) || task, str(row.hint)];
    const effort = str(row.reasoning_effort);
    return [
      {
        task,
        label,
        hint,
        provider: str(row.provider) || AUX_AUTO,
        model: str(row.model),
        effort: effort ? effortFromConfig(effort) || effort : AUX_INHERIT,
        localEndpoint: row.local_endpoint === true,
      },
    ];
  });
}

/** Settings → Model's reads and writes for the profile shown, over the signed-in dashboard. */
export class ModelSettingsApi {
  constructor(
    private readonly rest: Rest,
    private readonly profile: () => string,
  ) {}

  private q(extra: Record<string, string> = {}) {
    return new URLSearchParams({ ...extra, profile: this.profile() }).toString();
  }

  /** The providers and models Hermes offers, as Settings → Model lists them (`GET /api/model/options`). */
  async providers(): Promise<CatalogProvider[]> {
    return catalogFrom(await this.rest("GET", `api/model/options?${this.q()}`));
  }

  /** `GET /api/model/options`, `/api/model/auxiliary`, `/api/config` and `/api/delegation/routing`. */
  async load(): Promise<ModelSettings> {
    const [options, aux, config, routing] = await Promise.all([
      this.rest("GET", `api/model/options?${this.q()}`),
      this.rest("GET", `api/model/auxiliary?${this.q()}`),
      this.rest("GET", `api/config?${this.q()}`),
      // Only counted for a note; a backend without it still shows the rest.
      this.rest("GET", `api/delegation/routing?${this.q()}`).catch(() => ({})),
    ]);
    const main = obj(obj(aux).main);
    const agent = obj(obj(config).agent);
    const deleg = obj(obj(config).delegation);
    const tier = str(agent.service_tier).toLowerCase();
    const routes = obj(obj(routing).model_map).options;
    return {
      main: { provider: str(main.provider), model: str(main.model), effort: effortFromConfig(agent.reasoning_effort), fast: tier === "fast" || tier === "priority" },
      subagent: {
        provider: str(deleg.provider),
        model: str(deleg.model),
        maxIterations: count(deleg.max_iterations, 250),
        maxConcurrent: count(deleg.max_concurrent_children, 10),
        timeoutSeconds: count(deleg.child_timeout_seconds, 0),
        effort: effortFromConfig(deleg.reasoning_effort),
        directEndpoint: !!str(deleg.base_url).trim(),
      },
      namedRoutes: Array.isArray(routes) ? routes.length : 0,
      auxiliary: auxFrom(aux),
      providers: catalogFrom(options),
    };
  }

  /**
   * Writes the drafted main model with `POST /api/model/set`, then its defaults with `PUT /api/config`. When Hermes
   * flags the model expensive it answers `confirm_required` and writes nothing; nothing else is written either, until
   * the owner confirms and this is called again with `confirmExpensive`.
   */
  async applyMain(saved: ModelSettings, d: Draft, confirmExpensive = false): Promise<MainApplied> {
    const problem = mainProblem(d);
    if (problem) throw new Error(problem);
    if (mainModelChanged(saved, d)) {
      const apiUrl = saved.providers.find((p) => p.slug === d.main.provider)?.apiUrl;
      const res = obj(
        await this.rest("POST", `api/model/set?${this.q()}`, {
          scope: "main",
          provider: d.main.provider,
          model: d.main.model,
          ...(apiUrl ? { base_url: apiUrl } : {}),
          ...(confirmExpensive ? { confirm_expensive_model: true } : {}),
        }),
      );
      if (res.confirm_required === true) {
        // Asked twice means something is wrong; never loop.
        if (confirmExpensive) throw new Error(str(res.confirm_message) || "Hermes didn't switch the model.");
        return { applied: false, expensive: str(res.confirm_message) || `${d.main.model} is flagged as expensive.` };
      }
    }
    const agent: Json = {};
    if (d.main.effort !== saved.main.effort) agent.reasoning_effort = d.main.effort;
    if (d.main.fast !== saved.main.fast) agent.service_tier = d.main.fast ? "fast" : "normal";
    if (Object.keys(agent).length) await this.rest("PUT", `api/config?${this.q()}`, { config: { agent } });
    return { applied: true };
  }

  /** Writes the changed `delegation` keys with `PUT /api/config`, which merges them over the stored config. */
  async applySubagent(saved: ModelSettings, d: SubagentDraft): Promise<void> {
    const problem = subagentProblem(d);
    if (problem) throw new Error(problem);
    const patch = subagentPatch(saved, d);
    if (patch) await this.rest("PUT", `api/config?${this.q()}`, { config: { delegation: patch } });
  }

  /**
   * Writes each changed helper task with `POST /api/model/set`, one at a time. Hermes guards these as it guards the main
   * model: a model it flags expensive isn't written, and the tasks after it wait, until the owner confirms that task and
   * this is called again with it in `confirmed`. Tasks written before it stay written.
   */
  async applyAuxiliary(saved: ModelSettings, d: Draft, confirmed: string[] = []): Promise<AuxApplied> {
    const changed = auxChanged(saved, d);
    for (const t of changed) {
      const problem = auxProblem(t, d.auxiliary[t.task]);
      if (problem) throw new Error(problem);
    }
    for (const t of changed) {
      const a = d.auxiliary[t.task];
      const apiUrl = saved.providers.find((p) => p.slug === a.provider)?.apiUrl;
      const confirm = confirmed.includes(t.task);
      const res = obj(
        await this.rest("POST", `api/model/set?${this.q()}`, {
          scope: "auxiliary",
          task: t.task,
          provider: a.provider,
          model: a.provider === AUX_AUTO ? "" : a.model,
          reasoning_effort: auxEffortWire(a.effort),
          ...(apiUrl ? { base_url: apiUrl } : {}),
          ...(confirm ? { confirm_expensive_model: true } : {}),
        }),
      );
      if (res.confirm_required === true) {
        if (confirm) throw new Error(str(res.confirm_message) || `Hermes didn't set ${t.label}'s model.`);
        return { applied: false, expensive: str(res.confirm_message) || `${a.model} is flagged as expensive.`, task: t.task };
      }
    }
    return { applied: true };
  }
}
