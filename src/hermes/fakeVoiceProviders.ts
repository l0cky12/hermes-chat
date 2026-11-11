// A fake Hermes's speech providers, for tests of Settings → Voice: `GET /api/tools/toolsets/{stt,tts}/config`,
// `PUT …/provider`, `PUT …/env`, the `stt` and `tts` sections of `PUT /api/config`, and `GET /api/config/schema`, as
// the deployed `f0d94882e8` answers them (`hermes_cli/web_routers/tools.py`, `config_env.py`; research doc "Voice
// providers"). Rows and defaults are trimmed copies of `TOOL_CATEGORIES` and `config_defaults.py` there.
import type { RestRequest } from "./fakeHermes";
import { RestError } from "./pipe";

type Kind = "stt" | "tts";

export type FakeVoiceRow = {
  name: string;
  /** What picking it writes to `<kind>.provider` (`tts_provider` / `stt_provider`); a managed row writes `nous`. */
  writes: string;
  badge?: string;
  tag?: string;
  env?: { key: string; prompt: string }[];
  /** An install it needs on the server; `installed` says whether it's done. */
  postSetup?: string;
  installed?: boolean;
  managed?: string;
};

const key = (k: string, prompt: string) => ({ key: k, prompt });
const OPENAI = key("VOICE_TOOLS_OPENAI_KEY", "OpenAI API key");
const ELEVEN = key("ELEVENLABS_API_KEY", "ElevenLabs API key");

const ROWS: Record<Kind, FakeVoiceRow[]> = {
  stt: [
    { name: "Local Whisper", writes: "local", badge: "★ recommended · free", tag: "faster-whisper on-device, no API key", postSetup: "faster_whisper", installed: true },
    { name: "Nous Subscription", writes: "openai", badge: "subscription", tag: "Managed OpenAI transcription billed to your subscription", managed: "stt" },
    { name: "OpenAI", writes: "openai", badge: "paid", tag: "whisper-1, gpt-4o-mini-transcribe, gpt-4o-transcribe, gpt-transcribe", env: [OPENAI] },
    { name: "Groq", writes: "groq", badge: "free tier", tag: "whisper-large-v3-turbo, whisper-large-v3 — very fast", env: [key("GROQ_API_KEY", "Groq API key")] },
    { name: "ElevenLabs Scribe", writes: "elevenlabs", badge: "paid", tag: "scribe_v2 — diarization + audio-event tagging", env: [ELEVEN] },
    { name: "Mistral Voxtral", writes: "mistral", badge: "paid", tag: "voxtral-mini-latest — multilingual", env: [key("MISTRAL_API_KEY", "Mistral API key")] },
  ],
  tts: [
    { name: "Microsoft Edge TTS", writes: "edge", badge: "★ recommended · free", tag: "Good quality, no API key needed" },
    { name: "Nous Subscription", writes: "openai", badge: "subscription", tag: "Managed OpenAI TTS billed to your subscription", managed: "tts" },
    { name: "OpenAI TTS", writes: "openai", badge: "paid", tag: "High quality voices", env: [OPENAI] },
    { name: "ElevenLabs", writes: "elevenlabs", badge: "paid", tag: "Most natural voices", env: [ELEVEN] },
    { name: "Piper", writes: "piper", badge: "local · free", tag: "Local neural TTS, 44 languages (voices ~20-90MB)", postSetup: "piper", installed: false },
  ],
};

/** `config_defaults.py`'s `stt` and `tts` sections, the settings the screen shows. */
const defaults = (): Record<Kind, Record<string, unknown>> => ({
  stt: {
    language: "en",
    local: { model: "base", language: "" },
    groq: { model: "whisper-large-v3-turbo", language: "" },
    openai: { model: "whisper-1", language: "" },
    mistral: { model: "voxtral-mini-latest", language: "" },
    elevenlabs: { model_id: "scribe_v2", language_code: "" },
  },
  tts: {
    edge: { voice: "en-US-AriaNeural" },
    openai: { model: "gpt-4o-mini-tts", voice: "alloy" },
    elevenlabs: { voice_id: "pNInz6obpgDQGcFmaJgB", model_id: "eleven_multilingual_v2" },
    piper: { voice: "en_US-lessac-medium" },
  },
});

const SCHEMA = {
  "tts.provider": { type: "select", options: ["edge", "elevenlabs", "openai", "xai", "minimax", "mistral", "gemini", "neutts", "kittentts", "piper"] },
  "stt.local.model": { type: "select", options: ["base", "tiny", "small", "medium", "large-v3", "turbo"] },
  "stt.groq.model": { type: "select", options: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  "stt.openai.model": { type: "select", options: ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe"] },
  "stt.mistral.model": { type: "select", options: ["voxtral-mini-latest", "voxtral-mini-2602"] },
  "stt.elevenlabs.model_id": { type: "select", options: ["scribe_v2", "scribe_v1"] },
  "tts.openai.voice": { type: "string" },
  "agent.reasoning_effort": { type: "select", options: ["low", "medium", "high"] },
};

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function merge(into: Record<string, unknown>, from: Record<string, unknown>) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && isObj(into[k])) merge(into[k] as Record<string, unknown>, v);
    else into[k] = isObj(v) ? structuredClone(v) : v;
  }
}

export class FakeVoiceProviders {
  /** `none`: a server without the toolset config routes (older Hermes). */
  routes: "all" | "none" = "all";
  rows: Record<Kind, FakeVoiceRow[]> = structuredClone(ROWS);
  /** Each profile's `stt` and `tts` config sections; made from the defaults when first used. */
  private configs: Record<string, Record<Kind, Record<string, unknown>>> = {};
  /** The env vars set in each profile's `.env`. */
  env: Record<string, Set<string>> = {};
  /** The keys saved, as sent: never shown anywhere, only for tests to check. */
  readonly savedKeys: { profile: string; env: string; value: string }[] = [];
  /** Every write this fake took, in order. */
  readonly writes: { profile: string; route: "provider" | "env" | "config"; body: unknown }[] = [];
  /** While set, the provider and key writes wait for it. */
  gate?: Promise<void>;
  /** While set, the next `/config` read of each kind waits for it (once). */
  readGateOnce?: Promise<void>;
  /** The next write to this route fails: `stored` writes first (a lost answer or a 500 after the save). */
  failNext?: { route: "provider" | "env" | "config"; status?: number; detail: string; stored?: boolean };
  /** The next provider pick is taken but writes nothing (as a managed row that Hermes doesn't activate). */
  ignoreNextPick = false;

  constructor(
    private readonly known: (profile: string) => boolean,
    /** The provider names the fake's voice set-up starts with (`FakeHermes.voice`), until a write here changes them. */
    private readonly start: () => { stt?: string; tts?: string },
  ) {}

  config(profile: string): Record<Kind, Record<string, unknown>> {
    return (this.configs[profile] ??= defaults());
  }

  /** Sets a setting directly, as another client would: `set("default", "tts.openai.voice", "nova")`. */
  set(profile: string, path: string, value: unknown) {
    const [kind, ...rest] = path.split(".") as [Kind, ...string[]];
    let at = this.config(profile)[kind];
    for (const p of rest.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[rest[rest.length - 1]] = value;
  }

  /** The provider named in `<kind>.provider`, if any: what was written here, else what the fake's voice set-up names. */
  provider(profile: string, kind: Kind): string | undefined {
    const p = this.config(profile)[kind].provider;
    return typeof p === "string" && p ? p : this.start()[kind] || undefined;
  }

  /** What Rust's `voice_setup` passes on of these sections: the provider names, `stt.language` and each provider's settings. */
  setup(profile: string) {
    const c = this.config(profile);
    const settings = (kind: Kind) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [name, block] of Object.entries(c[kind])) {
        if (!isObj(block) || name === "providers") continue;
        const fields = Object.fromEntries(
          Object.entries(block).filter(([k, v]) => ["model", "model_id", "voice", "voice_id", "language", "language_code"].includes(k) && typeof v === "string"),
        ) as Record<string, string>;
        if (Object.keys(fields).length) out[name] = fields;
      }
      return out;
    };
    return {
      sttProvider: this.provider(profile, "stt"),
      ttsProvider: this.provider(profile, "tts"),
      ...(typeof c.stt.language === "string" ? { sttLanguage: c.stt.language } : {}),
      sttSettings: settings("stt"),
      ttsSettings: settings("tts"),
    };
  }

  private active(profile: string, kind: Kind, row: FakeVoiceRow): boolean {
    const named = this.provider(profile, kind) ?? (kind === "stt" ? "local" : undefined);
    return row.managed ? named === "nous" : named === row.writes;
  }

  private status(profile: string, row: FakeVoiceRow): string {
    const env = this.env[profile] ?? new Set();
    if (row.env?.length) return row.env.every((e) => env.has(e.key)) ? "ready" : "needs_keys";
    if (row.managed) return "needs_auth";
    if (row.postSetup) return row.installed ? "ready" : "needs_setup";
    return "ready";
  }

  /** `GET /api/tools/toolsets/{stt,tts}/config`, or undefined for another toolset. */
  async configRoute(profile: string, name: string): Promise<unknown> {
    if (name !== "stt" && name !== "tts") return undefined;
    if (this.routes === "none") throw answered(404, "Not Found");
    const gate = this.readGateOnce;
    if (gate) {
      this.readGateOnce = undefined;
      await gate;
    }
    const env = this.env[profile] ?? new Set();
    const providers = this.rows[name].map((r) => ({
      name: r.name,
      badge: r.badge ?? "",
      tag: r.tag ?? "",
      env_vars: (r.env ?? []).map((e) => ({ key: e.key, prompt: e.prompt, url: null, default: null, is_set: env.has(e.key) })),
      post_setup: r.postSetup ?? null,
      requires_nous_auth: !!r.managed,
      managed_nous_feature: r.managed ?? null,
      is_active: this.active(profile, name, r),
      status: this.status(profile, r),
      ...(name === "tts" ? { tts_provider: r.writes } : {}),
    }));
    return { name, has_category: true, providers, active_provider: providers.find((p) => p.is_active)?.name ?? null };
  }

  private async failing(route: "provider" | "env" | "config", write: () => void) {
    const fail = this.failNext?.route === route ? this.failNext : undefined;
    if (fail) this.failNext = undefined;
    if (fail && !fail.stored) throw fail.status ? answered(fail.status, fail.detail) : new Error(fail.detail);
    write();
    if (fail) throw fail.status ? answered(fail.status, fail.detail) : new Error(fail.detail);
  }

  /** The stt and tts sections of `PUT /api/config` `{config}`, merged over the stored ones as Hermes does. */
  async mergeConfig(profile: string, config: Record<string, unknown>) {
    const parts = (["stt", "tts"] as const).filter((k) => isObj(config[k]));
    if (!parts.length) return;
    await this.failing("config", () => {
      this.writes.push({ profile, route: "config", body: structuredClone(Object.fromEntries(parts.map((k) => [k, config[k]]))) });
      for (const k of parts) merge(this.config(profile)[k], config[k] as Record<string, unknown>);
    });
  }

  /** `PUT /api/tools/toolsets/{stt,tts}/{provider,env}` and `GET /api/config/schema`, or undefined for other routes. */
  route(req: RestRequest): (() => Promise<unknown>) | undefined {
    const method = req.method.toUpperCase();
    if (method === "GET" && req.path === "/api/config/schema") return async () => ({ fields: SCHEMA, category_order: [] });
    const m = /^\/api\/tools\/toolsets\/(stt|tts)\/(provider|env)$/.exec(req.path);
    if (!m || method !== "PUT") return undefined;
    const kind = m[1] as Kind;
    const route = m[2] as "provider" | "env";
    return async () => {
      if (this.routes === "none") throw answered(404, "Not Found");
      const profile = req.query.get("profile") ?? "default";
      if (!this.known(profile)) throw answered(404, `Profile '${profile}' does not exist`);
      await this.gate;
      const body = req.body ?? {};
      if (route === "provider") {
        const row = this.rows[kind].find((r) => r.name === body.provider);
        if (!row) throw answered(400, `Unknown provider '${String(body.provider)}' for toolset '${kind}'`);
        await this.failing("provider", () => {
          this.writes.push({ profile, route, body });
          if (this.ignoreNextPick) this.ignoreNextPick = false;
          else this.config(profile)[kind].provider = row.managed ? "nous" : row.writes;
        });
        return { ok: true, name: kind, provider: row.name };
      }
      const env = isObj(body.env) ? (body.env as Record<string, string>) : {};
      const allowed = new Set(this.rows[kind].flatMap((r) => (r.env ?? []).map((e) => e.key)));
      const unknown = Object.keys(env).filter((k) => !allowed.has(k));
      if (unknown.length) throw answered(400, `Unknown env var(s) for toolset ${kind}: ${unknown.sort().join(", ")}`);
      const saved: string[] = [];
      const skipped: string[] = [];
      await this.failing("env", () => {
        this.writes.push({ profile, route, body: { env: Object.fromEntries(Object.keys(env).map((k) => [k, "…"])) } });
        for (const [k, v] of Object.entries(env)) {
          if (!v.trim()) {
            skipped.push(k);
            continue;
          }
          (this.env[profile] ??= new Set()).add(k);
          this.savedKeys.push({ profile, env: k, value: v.trim() });
          saved.push(k);
        }
      });
      const set = this.env[profile] ?? new Set();
      return { ok: true, name: kind, saved, skipped, is_set: Object.fromEntries([...allowed].map((k) => [k, set.has(k)])) };
    };
  }
}
