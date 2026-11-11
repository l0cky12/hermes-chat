// A fake Hermes's messaging gateways, for tests of Settings → Gateways (ADR 0073): the `/api/messaging/platforms` routes
// as the deployed `f0d94882` answers them (`hermes_cli/web_routers/messaging.py`): the list with redacted previews and
// the state ladder of `_messaging_platform_payload`, the write that checks the whole request before touching `.env` or
// config.yaml, and the status check that sends no message. Each profile keeps its own `.env`, switches and gateway.
import type { RestRequest } from "./fakeHermes";
import { RestError } from "./pipe";

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));

type FieldSpec = { key: string; prompt: string; description: string; required?: boolean; password?: boolean; list?: boolean };
type PlatformSpec = { id: string; name: string; description: string; fields: FieldSpec[]; rules?: Record<string, [RegExp, string]> };

const CATALOG: PlatformSpec[] = [
  {
    id: "telegram",
    name: "Telegram",
    description: "Run Hermes from Telegram DMs, groups, and topics.",
    fields: [
      { key: "TELEGRAM_BOT_TOKEN", prompt: "Telegram bot token", description: "Complete Telegram bot token created by @BotFather", required: true, password: true },
      { key: "TELEGRAM_ALLOWED_USERS", prompt: "Allowed Telegram user IDs (comma-separated)", description: "Optional comma-separated numeric Telegram user IDs", list: true },
      { key: "TELEGRAM_WEBHOOK_SECRET", prompt: "Webhook secret", description: "Secret token Telegram sends with each webhook update", password: true },
    ],
    rules: {
      TELEGRAM_BOT_TOKEN: [/^\d+:[A-Za-z0-9_-]{30,}$/, "Telegram bot token must be the complete token from @BotFather, such as 123456789:ABC…"],
      TELEGRAM_ALLOWED_USERS: [/^\s*\d+\s*(,\s*(\d+\s*)?)*$/, "Telegram allowed users must be comma-separated numeric user IDs."],
    },
  },
  {
    id: "discord",
    name: "Discord",
    description: "Connect Hermes to Discord DMs, channels, and threads.",
    fields: [
      { key: "DISCORD_BOT_TOKEN", prompt: "Discord bot token", description: "Discord bot token from Developer Portal", required: true, password: true },
      { key: "DISCORD_ALLOWED_USERS", prompt: "Allowed Discord user IDs (comma-separated)", description: "Comma-separated Discord user IDs allowed to use the bot", list: true },
    ],
  },
  { id: "slack", name: "Slack", description: "Run Hermes from Slack.", fields: [{ key: "SLACK_BOT_TOKEN", prompt: "Slack bot token", description: "", required: true, password: true }] },
];

/** `«redacted:…»` around `agent.redact.mask_secret`, near enough: a short value is all stars, a longer one keeps its ends. */
const preview = (v: string) => `«redacted:${v.length < 12 ? "***" : `${v.slice(0, 4)}...${v.slice(-4)}`}»`;
const looksRedacted = (v: string) => v.startsWith("«redacted") || v === "***" || /^.{4}\.\.\..{4}$/.test(v);

/** What the profile's gateway last reported for a platform (`gateway_state.json`). */
export type Runtime = { state: string; error_code?: string; error_message?: string };

export class FakeGateways {
  /** Each profile's `.env`. */
  env: Record<string, Record<string, string>> = {};
  /** Each profile's `platforms.<id>.enabled` in config.yaml; unset means never written. */
  enabled: Record<string, Record<string, boolean>> = {};
  /** Whether each profile's gateway runs, and what it reports per platform. */
  gateway: Record<string, { running: boolean; platforms: Record<string, Runtime> }> = {};
  /** Every write and status check asked, in order. */
  readonly writes: { profile: string; what: string; body?: unknown }[] = [];
  /** `none`: a Hermes without the messaging routes. */
  routes: "all" | "none" = "all";
  /** The next write: `lost` fails before applying, `stored` applies it and then loses the answer. */
  drop?: "lost" | "stored";
  /** The next write, or status check, is refused with this. */
  refuse?: { status: number; detail: string };
  /** Every list read is refused with this while set. */
  refuseReads?: { status: number; detail: string };
  /** Awaited before each write is applied. */
  gate?: Promise<void>;
  /** Run after each list read, so a test can change things between the screen's reads. */
  afterRead?: () => void;
  /** A live multiplexer serves the profile and picks up a change without a restart. */
  hotServed = false;

  constructor(private known: (profile: string) => boolean) {}

  private envOf(profile: string) {
    return (this.env[profile] ??= {});
  }

  private payload(profile: string, spec: PlatformSpec) {
    const env = this.envOf(profile);
    const configured = spec.fields.filter((f) => f.required).every((f) => !!env[f.key]);
    const raw = this.enabled[profile]?.[spec.id];
    // Setup writes credentials without a platforms entry; explicit disable wins (`_platform_enablement`).
    const enabled = raw === false ? false : !!raw || configured;
    const gw = this.gateway[profile] ?? { running: false, platforms: {} };
    const rt: Runtime | undefined = gw.running ? gw.platforms[spec.id] : undefined;
    let state = rt?.state;
    if (!enabled) state = "disabled";
    else if (!configured) state = "not_configured";
    else if (gw.running && !state) state = "pending_restart";
    else if (!gw.running && !state) state = "gateway_stopped";
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      docs_url: `https://docs.example/${spec.id}`,
      enabled,
      configured,
      gateway_running: gw.running,
      state,
      error_code: rt?.error_code ?? null,
      error_message: rt?.error_message ?? null,
      updated_at: null,
      home_channel: null,
      env_vars: spec.fields.map((f) => ({
        key: f.key,
        required: !!f.required,
        is_set: !!env[f.key],
        redacted_value: env[f.key] ? preview(env[f.key]) : null,
        value: f.list ? (env[f.key] ?? "") : null,
        description: f.description,
        prompt: f.prompt,
        help: "",
        url: null,
        is_password: !!f.password,
        is_list: !!f.list,
        advanced: false,
      })),
      ingress_url: null,
    };
  }

  route(req: RestRequest): (() => Promise<unknown>) | undefined {
    if (!req.path.startsWith("/api/messaging/")) return undefined;
    return async () => {
      if (this.routes === "none") throw answered(404, "Not Found");
      const profile = req.query.get("profile") ?? "default";
      if (!this.known(profile)) throw answered(404, `Profile '${profile}' does not exist`);
      if (req.path === "/api/messaging/platforms" && req.method === "GET") {
        if (this.refuseReads) throw answered(this.refuseReads.status, this.refuseReads.detail);
        const out = { env_path: `/srv/hermes/${profile}/.env`, gateway_start_command: `hermes -p ${profile} gateway start`, platforms: CATALOG.map((s) => this.payload(profile, s)) };
        this.afterRead?.();
        return out;
      }
      const one = /^\/api\/messaging\/platforms\/([^/]+)(\/test)?$/.exec(req.path);
      if (!one) throw answered(404, "Not Found");
      const spec = CATALOG.find((s) => s.id === decodeURIComponent(one[1]));
      if (!spec) throw answered(404, `Unknown messaging platform: ${one[1]}`);
      if (one[2] && req.method === "POST") return this.check(profile, spec);
      if (!one[2] && req.method === "PUT") return this.update(profile, spec, req.body ?? {});
      throw answered(405, "Method Not Allowed");
    };
  }

  private async update(profile: string, spec: PlatformSpec, body: Record<string, unknown>) {
    this.writes.push({ profile, what: `put ${spec.id}`, body });
    await this.gate;
    if (this.refuse) {
      const r = this.refuse;
      this.refuse = undefined;
      throw answered(r.status, r.detail);
    }
    const allowed = new Set(spec.fields.map((f) => f.key));
    const env = (body.env ?? {}) as Record<string, string>;
    const clear = (body.clear_env ?? []) as string[];
    const updates: Record<string, string> = {};
    for (const k of clear) if (!allowed.has(k)) throw answered(400, `${k} is not configurable for ${spec.name}`);
    for (const [k, v] of Object.entries(env)) {
      if (!allowed.has(k)) throw answered(400, `${k} is not configurable for ${spec.name}`);
      const t = v.trim();
      if (!t) continue;
      if (looksRedacted(t)) throw answered(400, "Refusing to save a redacted credential preview; re-enter the full secret to replace it.");
      const rule = spec.rules?.[k];
      if (rule && !rule[0].test(t)) throw answered(400, rule[1]);
      updates[k] = t;
    }
    if (this.drop === "lost") {
      this.drop = undefined;
      throw new Error("Can't reach the Hermes dashboard: connection reset");
    }
    const e = this.envOf(profile);
    for (const k of clear) delete e[k];
    Object.assign(e, updates);
    if (typeof body.enabled === "boolean") (this.enabled[profile] ??= {})[spec.id] = body.enabled;
    if (this.drop === "stored") {
      this.drop = undefined;
      throw new Error("Can't reach the Hermes dashboard: connection reset");
    }
    return { ok: true, platform: spec.id, hot_served: this.hotServed };
  }

  /** `test_messaging_platform`: the platform's state in words, never a message sent. */
  private check(profile: string, spec: PlatformSpec) {
    this.writes.push({ profile, what: `test ${spec.id}` });
    if (this.refuse) {
      const r = this.refuse;
      this.refuse = undefined;
      throw answered(r.status, r.detail);
    }
    const p = this.payload(profile, spec);
    const result = (ok: boolean, message: string) => ({ ok, state: p.state, message });
    if (!p.enabled) return result(false, `${spec.name} is disabled. Enable it, then restart the gateway.`);
    if (!p.configured) {
      const missing = p.env_vars.filter((f) => f.required && !f.is_set).map((f) => f.key);
      return result(false, missing.length ? `Missing required setup: ${missing.join(", ")}` : "Platform setup is incomplete.");
    }
    if (!p.gateway_running) return result(false, "Gateway is not running. Restart the gateway to connect this platform.");
    if (p.state === "connected") return result(true, `${spec.name} is connected.`);
    if (p.error_message) return result(false, p.error_message);
    return result(false, "Setup looks complete, but the gateway has not reported a connection yet. Restart the gateway.");
  }
}
