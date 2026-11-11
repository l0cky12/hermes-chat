// Which model a chat runs on, and the list the composer's model picker offers. The list comes from Hermes when it
// offers one (`model.options` over the socket, else dashboard REST `GET /api/model/options`); when it doesn't, the
// picker falls back to a short static list built around the model the profile or chat already uses.
// Wire shapes: upstream `tui_gateway/contracts/config_free_tier_control.py` (`ModelOptionsResult`) at `c419cf7`.

/**
 * How hard the model thinks before it answers, as Hermes's `reasoning` setting takes it (`VALID_REASONING_EFFORTS`
 * in `hermes_constants.py`, plus `none` for off). The picker offers the common ones.
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The efforts the picker offers, in order. `none` only shows for a model that can turn reasoning off. */
export const OFFERED_EFFORTS: Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/** What the reasoning pill says. */
export const EFFORT_LABEL: Record<Effort, string> = {
  none: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/**
 * A model and how it runs. `effort` and `fast` left out mean "as the profile has it": nothing is sent for them, and
 * Hermes uses the profile's setting.
 */
export type ModelPick = { provider: string; model: string; effort?: Effort; fast?: boolean };

/** A kept ModelPick rebuilt from its fields, or undefined if it isn't one. */
export function pickOf(v: unknown): ModelPick | undefined {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || typeof p.provider !== "string" || typeof p.model !== "string" || !p.model) return undefined;
  return { provider: p.provider, model: p.model, ...(isEffort(p.effort) && { effort: p.effort }), ...(typeof p.fast === "boolean" && { fast: p.fast }) };
}

/** One model the picker lists. `available`: false when Hermes lists it but says it can't be used now. */
export type ModelOption = {
  provider: string;
  providerName: string;
  model: string;
  /** The model takes a reasoning effort, so the reasoning pill shows for it. */
  reasoning: boolean;
  /** Reasoning can be turned off. */
  canDisableReasoning: boolean;
  /** Hermes's fast mode (a faster, pricier service tier) is offered for it. */
  fast: boolean;
  available: boolean;
};

export type ProviderModels = { slug: string; name: string; models: ModelOption[] };

/**
 * The models a profile can switch to. `source`: `server` when Hermes listed them; `fallback` when it didn't, and the
 * list is this app's guess around the model already in use. `defaultPick`: the profile's own model, which the picker
 * starts from. `defaultEffort`: the profile's reasoning effort, shown while the pick leaves effort as it is.
 */
export type ModelCatalog = {
  profile: string;
  source: "server" | "fallback";
  providers: ProviderModels[];
  defaultPick?: ModelPick;
  defaultEffort?: Effort;
  /** Why Hermes's own list couldn't be read, when the fallback is showing. */
  reason?: string;
};

/** A favorite's key, as `modelFavorites` keeps it. Provider slugs never hold a "/", so the first one splits it. */
export const modelKey = (p: Pick<ModelPick, "provider" | "model">) => `${p.provider}/${p.model}`;
export function fromKey(key: string): Pick<ModelPick, "provider" | "model"> | undefined {
  const at = key.indexOf("/");
  return at > 0 && at < key.length - 1 ? { provider: key.slice(0, at), model: key.slice(at + 1) } : undefined;
}

/** The model's name without a vendor prefix, as the picker's button shows it. */
export const shortName = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/**
 * What a model can do, guessed from its name, for a model Hermes lists without capabilities and for the fallback list.
 * Reasoning: the Claude 4 family, OpenAI's o-series and GPT-5, Gemini 2.5 and later, DeepSeek R1, Hermes 4 and the
 * like. Fast mode: the models Hermes's priority tier covers (OpenAI's GPT-5 family and Claude Opus).
 */
export function guessCapabilities(model: string): Pick<ModelOption, "reasoning" | "canDisableReasoning" | "fast"> {
  const m = shortName(model).toLowerCase();
  const reasoning = /^(claude-(opus|sonnet|haiku)-4|claude-[a-z]+-[4-9]|o[1-9]|gpt-5|gemini-([3-9]|2\.5)|deepseek-(r|reasoner)|qwq|hermes-4|grok-[3-9]|kimi-k2-thinking)/.test(m);
  return { reasoning, canDisableReasoning: reasoning && !/^o[1-9]/.test(m), fast: /^(gpt-5|claude-opus)/.test(m) };
}

/** `ModelOptionProvider` as `model.options` sends it, as far as the picker reads it. */
type WireProvider = {
  slug?: unknown;
  name?: unknown;
  models?: unknown;
  authenticated?: unknown;
  unavailable_models?: unknown;
  capabilities?: Record<string, { fast?: unknown; reasoning?: unknown; can_disable_reasoning?: unknown } | undefined> | null;
};
type WireOptions = { providers?: unknown; model?: unknown; provider?: unknown };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);

/**
 * The picker's list from a `model.options` result (or its REST twin). Undefined when the result lists no models: the
 * server has no catalog to offer.
 */
export function catalogFromServer(profile: string, raw: unknown): ModelCatalog | undefined {
  const res = (raw ?? {}) as WireOptions;
  const providers: ProviderModels[] = [];
  for (const p of Array.isArray(res.providers) ? (res.providers as WireProvider[]) : []) {
    if (typeof p?.slug !== "string" || !p.slug || p.slug.includes("/")) continue;
    const slug = p.slug;
    const name = typeof p.name === "string" && p.name ? p.name : slug;
    const unavailable = new Set(strings(p.unavailable_models));
    const models = [...new Set(strings(p.models))].map((model): ModelOption => {
      const caps = p.capabilities?.[model];
      const guessed = guessCapabilities(model);
      const reasoning = typeof caps?.reasoning === "boolean" ? caps.reasoning : guessed.reasoning;
      return {
        provider: slug,
        providerName: name,
        model,
        reasoning,
        canDisableReasoning: reasoning && (typeof caps?.can_disable_reasoning === "boolean" ? caps.can_disable_reasoning : guessed.canDisableReasoning),
        fast: typeof caps?.fast === "boolean" ? caps.fast : guessed.fast,
        available: p.authenticated !== false && !unavailable.has(model),
      };
    });
    if (models.length) providers.push({ slug, name, models });
  }
  if (!providers.length) return undefined;
  const model = typeof res.model === "string" ? res.model.trim() : "";
  const provider = typeof res.provider === "string" ? res.provider.trim() : "";
  return { profile, source: "server", providers, defaultPick: model && provider ? { provider, model } : undefined };
}

/** Common models of the providers Hermes ships with, for the fallback list. A guess, kept short on purpose. */
const COMMON: Record<string, { name: string; models: string[] }> = {
  anthropic: { name: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  openai: { name: "OpenAI", models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  "openai-codex": { name: "OpenAI Codex", models: ["gpt-5-codex", "gpt-5"] },
  gemini: { name: "Google Gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  nous: { name: "Nous Portal", models: ["Hermes-4-405B", "Hermes-4-70B"] },
  openrouter: {
    name: "OpenRouter",
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "openai/gpt-5", "google/gemini-2.5-pro", "nousresearch/hermes-4-405b"],
  },
};

/** The vendor a `vendor/model` id names, as a provider slug, when it is one of the common ones. */
const VENDOR: Record<string, string> = { anthropic: "anthropic", openai: "openai", google: "gemini", nousresearch: "nous" };

/**
 * The list the picker shows when Hermes offers none: the model in use first, then the common models of its provider.
 * A provider the model's id names (`anthropic/…` on OpenRouter) adds its own common models. Nothing here says
 * these are configured on the server, so a pick from it may be refused when the chat starts.
 */
export function fallbackCatalog(profile: string, current: Pick<ModelPick, "provider" | "model"> | undefined, reason?: string): ModelCatalog {
  const providers: ProviderModels[] = [];
  const add = (slug: string, models: string[]) => {
    const name = COMMON[slug]?.name ?? slug;
    const rows = [...new Set(models)].map((model): ModelOption => ({ provider: slug, providerName: name, model, available: true, ...guessCapabilities(model) }));
    if (rows.length && !providers.some((p) => p.slug === slug)) providers.push({ slug, name, models: rows });
  };
  if (current?.model) {
    const provider = current.provider || "custom";
    add(provider, [current.model, ...(COMMON[provider]?.models ?? [])]);
    const vendor = VENDOR[current.model.split("/")[0]?.toLowerCase() ?? ""];
    if (current.model.includes("/") && vendor) add(vendor, COMMON[vendor].models);
  } else for (const [slug, { models }] of Object.entries(COMMON)) add(slug, models);
  return { profile, source: "fallback", providers, defaultPick: current?.model ? { provider: current.provider || "custom", model: current.model } : undefined, reason };
}

/** The model the catalog lists for a pick, if it does. */
export function findOption(catalog: ModelCatalog | undefined, p: Pick<ModelPick, "provider" | "model"> | undefined): ModelOption | undefined {
  if (!catalog || !p) return undefined;
  return catalog.providers.find((x) => x.slug === p.provider)?.models.find((m) => m.model === p.model);
}

/** What a model can do: as the catalog lists it, else guessed from its name. */
export function capabilitiesOf(catalog: ModelCatalog | undefined, p: Pick<ModelPick, "provider" | "model">) {
  return findOption(catalog, p) ?? guessCapabilities(p.model);
}

/** The efforts the picker offers for a model; none for a model without reasoning. */
export function effortsFor(caps: Pick<ModelOption, "reasoning" | "canDisableReasoning">): Effort[] {
  if (!caps.reasoning) return [];
  return OFFERED_EFFORTS.filter((e) => e !== "none" || caps.canDisableReasoning);
}

/**
 * A pick moved to another model keeps the effort and fast mode the owner chose, where the new model takes them; what
 * it can't take goes back to the profile's setting.
 */
export function carryOptions(to: Pick<ModelPick, "provider" | "model">, from: ModelPick | undefined, catalog: ModelCatalog | undefined): ModelPick {
  const caps = capabilitiesOf(catalog, to);
  const effort = from?.effort && effortsFor(caps).includes(from.effort) ? from.effort : undefined;
  const fast = from?.fast !== undefined && caps.fast ? from.fast : undefined;
  return { provider: to.provider, model: to.model, ...(effort && { effort }), ...(fast !== undefined && { fast }) };
}

/** `SessionLiveInfo` (`session.info`, and `info` on `session.create` / `session.resume`), as far as the picker reads it. */
export function pickFromInfo(info: unknown): ModelPick | undefined {
  const i = (info ?? {}) as { model?: unknown; provider?: unknown; reasoning_effort?: unknown; fast?: unknown };
  const model = typeof i.model === "string" ? i.model.trim() : "";
  if (!model) return undefined;
  const provider = typeof i.provider === "string" && i.provider.trim() ? i.provider.trim() : "custom";
  const effort = typeof i.reasoning_effort === "string" ? i.reasoning_effort.trim().toLowerCase() : "";
  return { provider, model, ...(isEffort(effort) && { effort }), ...(typeof i.fast === "boolean" && { fast: i.fast }) };
}
