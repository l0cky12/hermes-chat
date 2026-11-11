// Settings → Gateways (ADR 0073): a profile's Telegram and Discord gateways, read and changed through the dashboard's
// messaging routes at the deployed `f0d94882` (`hermes_cli/web_routers/messaging.py`). Every route takes `?profile=`:
//
// - `GET /api/messaging/platforms` lists every platform Hermes knows, with its on/off state, whether its required
//   settings are there, whether the gateway runs, and the runtime state and error the gateway last reported. A secret
//   comes back only as Hermes's redacted preview (`«redacted:1234...abcd»`); an allowlist (`*_ALLOWED_USERS`) comes
//   back as its value. Only Telegram and Discord are offered here.
// - `PUT /api/messaging/platforms/{id}` `{enabled, env, clear_env}` writes the profile's `.env` and config.yaml. Hermes
//   checks the whole request before it writes anything (unknown keys, a redacted preview sent back, Telegram's token
//   shape), so a 4xx changed nothing.
// - `POST /api/messaging/platforms/{id}/test` reports the platform's state in words. It sends no message.
//
// Hermes has no revision to check a write against, so a save reads the platform first and stops if it isn't what the
// screen showed, then reads it again to confirm what landed.

import { redact as redactKnown } from "./logs";
import { failureOf, type Failure } from "./toolsets";
import type { RestMethod } from "./pipe";
import { errorText } from "./values";

export const PLATFORMS = ["telegram", "discord"] as const;
export type PlatformId = (typeof PLATFORMS)[number];

/** One of a platform's settings, an env var in the profile's `.env`. */
export type GatewayField = {
  key: string;
  label: string;
  hint: string;
  url?: string;
  required: boolean;
  set: boolean;
  /** Hermes shows only a redacted preview of it, never the value: a token, a webhook secret. */
  secret: boolean;
  /** Hermes's redacted preview, for a secret that is set. */
  preview?: string;
  /** The value, for a setting Hermes shows in full (an allowlist of user IDs). */
  value?: string;
};

export type ProblemKind = "permission" | "invalid-token" | "missing-dependency" | "other";
export type Problem = { kind: ProblemKind; text: string };

export type Gateway = {
  id: PlatformId;
  name: string;
  description: string;
  docsUrl?: string;
  enabled: boolean;
  /** Every required setting is there. */
  configured: boolean;
  gatewayRunning: boolean;
  /** Hermes's word for it: `disabled`, `not_configured`, `gateway_stopped`, `pending_restart`, `connected`, `fatal`… */
  state: string;
  /** What the gateway last reported going wrong, redacted. */
  error?: Problem;
  fields: GatewayField[];
};

export type GatewayList = {
  profile: string;
  /** The supported platforms this Hermes lists, in Hermes's order. */
  gateways: Gateway[];
  /** The command that starts the profile's gateway, as Hermes words it. */
  startCommand?: string;
  readAt: number;
};

/** What the screen asks of one setting. A setting the draft doesn't name is kept as Hermes has it. */
export type FieldEdit = { kind: "keep" } | { kind: "replace"; value: string } | { kind: "remove" };
export type Draft = { enabled: boolean; edits: Partial<Record<string, FieldEdit>> };

export type SaveResult =
  /** Read back as asked. `restart`: the gateway runs and keeps the settings it started with until it restarts. */
  | { kind: "saved"; list: GatewayList; restart: boolean }
  /** Hermes had something else than the screen showed, so nothing was sent; `list` is what it has now. */
  | { kind: "conflict"; list: GatewayList }
  /** Refused, by Hermes or before sending; nothing changed. */
  | { kind: "refused"; problem: Problem; list?: GatewayList }
  /** Hermes may have written some or all of it, and the read afterwards doesn't show all of it. */
  | { kind: "unconfirmed"; reason: string; list?: GatewayList };

export type StatusCheck = { ok: boolean; text: string; problem?: Problem; at: number };

export type GatewaysRest = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

export class GatewaysUnsupportedError extends Error {}
/** A list read Hermes refused, with the kind of problem, so a 403 still reads as a refused permission. */
export class GatewaysReadError extends Error {
  constructor(
    message: string,
    readonly kind: ProblemKind,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const q = (profile: string) => `profile=${encodeURIComponent(profile)}`;
const supported = (id: string): id is PlatformId => (PLATFORMS as readonly string[]).includes(id);

/** FastAPI's own "no such route", as opposed to a route refusing, which names its own reason. */
const noRoute = (f: Failure) => f.status === 405 || (f.status === 404 && f.reason === "Not Found");

/**
 * `text` without anything that looks like a secret: the values in `typed`, Telegram and Discord bot tokens, and what
 * the Logs screen redacts (provider keys, bearer tokens, `token=` pairs). Hermes's own `«redacted:…»` previews stay.
 */
export function redact(text: string, typed: readonly string[] = []): string {
  let out = text;
  for (const t of typed) {
    if (!t) continue;
    // A short value is taken out only where it stands alone, so "ab" doesn't eat every "ab" in the sentence.
    out = t.length >= 4 ? out.split(t).join("[redacted]") : out.replace(new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"), "[redacted]");
  }
  out = out
    // No word boundary before the ID: Telegram's API puts the token right after "bot" in its URLs (`/bot123:AA…/getMe`).
    .replace(/(?<!\d)\d{5,}:[A-Za-z0-9_-]{20,}/g, "[redacted token]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, "[redacted token]");
  return redactKnown(out).text;
}

/** The gateway's runtime error codes this screen tells apart (the Telegram and Discord adapters' `_set_fatal_error`). */
const RUNTIME_KIND: Record<string, ProblemKind> = {
  missing_dependency: "missing-dependency",
  telegram_auth_error: "invalid-token",
  discord_auth_error: "invalid-token",
  discord_intents_required: "permission",
};

/**
 * The kind of a runtime error. The gateway says `adapter_unavailable` when it couldn't build the adapter at all, which
 * for a platform with its token set means the library (or the plugin) isn't there: Hermes builds Telegram's and
 * Discord's adapters only once their library imports (seen live at `f0d94882` with lazy installs off).
 */
const runtimeKind = (code: string, configured: boolean): ProblemKind =>
  RUNTIME_KIND[code] ?? (code === "adapter_unavailable" && configured ? "missing-dependency" : "other");

function fieldOf(v: unknown): GatewayField | undefined {
  const f = obj(v);
  const key = str(f.key);
  if (!key) return undefined;
  // Hermes sends the value only for an allowlist; anything else is write-only here, a password field or not.
  const readable = f.is_list === true && typeof f.value === "string";
  const set = f.is_set === true;
  return {
    key,
    label: str(f.prompt) || key,
    hint: str(f.description),
    url: str(f.url) || undefined,
    required: f.required === true,
    set,
    secret: !readable,
    preview: !readable && set ? str(f.redacted_value) || undefined : undefined,
    value: readable ? str(f.value) : undefined,
  };
}

function gatewayOf(v: unknown, typed: readonly string[]): Gateway | undefined {
  const g = obj(v);
  const id = str(g.id);
  if (!supported(id)) return undefined;
  const code = str(g.error_code);
  const message = str(g.error_message);
  return {
    id,
    name: str(g.name) || id,
    description: str(g.description),
    docsUrl: /^https:\/\//.test(str(g.docs_url)) ? str(g.docs_url) : undefined,
    enabled: g.enabled === true,
    configured: g.configured === true,
    gatewayRunning: g.gateway_running === true,
    state: str(g.state) || "unknown",
    error: code || message ? { kind: runtimeKind(code, g.configured === true), text: redact(message || code, typed) } : undefined,
    fields: (Array.isArray(g.env_vars) ? g.env_vars : []).flatMap((f) => fieldOf(f) ?? []),
  };
}

/** Hermes's `is_redacted_credential_preview`: a preview pasted back, which Hermes refuses to save. */
export const looksRedacted = (v: string) => v.startsWith("«redacted") || v === "***" || /^.{4}\.\.\..{4}$/.test(v);

/** Whether the draft asks for anything Hermes doesn't have. */
export function changed(g: Gateway, d: Draft): boolean {
  return d.enabled !== g.enabled || g.fields.some((f) => wanted(f, d.edits[f.key]) !== undefined);
}

/** What one setting's edit asks of Hermes: a value to save, `null` to clear it, or undefined for nothing. */
function wanted(f: GatewayField, e: FieldEdit | undefined): string | null | undefined {
  if (!e || e.kind === "keep") return undefined;
  if (e.kind === "remove") return f.set ? null : undefined;
  const v = e.value.trim();
  if (!v) return f.set && !f.secret ? null : undefined;
  return !f.secret && v === f.value ? undefined : v;
}

/** What the draft lacks before it can be sent, in words; undefined when it can go. */
export function draftProblem(g: Gateway, d: Draft): string | undefined {
  for (const f of g.fields) {
    const v = wanted(f, d.edits[f.key]);
    if (typeof v !== "string") continue;
    if (/[\u0000-\u001f\u007f]/.test(v)) return `${f.label}: paste it on one line.`;
    if (f.secret && looksRedacted(v)) return `${f.label}: that's Hermes's redacted preview, not the value. Paste the whole value to replace it.`;
  }
  return undefined;
}

/** The body of `PUT /api/messaging/platforms/{id}` for the draft. `enabled` always goes, so a new token never turns a platform on by itself. */
export function putBody(g: Gateway, d: Draft): { enabled: boolean; env?: Record<string, string>; clear_env?: string[] } {
  const env: Record<string, string> = {};
  const clear: string[] = [];
  for (const f of g.fields) {
    const v = wanted(f, d.edits[f.key]);
    if (v === null) clear.push(f.key);
    else if (v !== undefined) env[f.key] = v;
  }
  return { enabled: d.enabled, ...(Object.keys(env).length && { env }), ...(clear.length && { clear_env: clear }) };
}

/** What the screen compares to tell whether Hermes still has what it showed. */
const seen = (g: Gateway) => JSON.stringify([g.enabled, g.fields.map((f) => [f.key, f.set, f.preview ?? null, f.value ?? null])]);

/**
 * Whether `after`, read back, has what `d` asked of `before`. `answered`: Hermes said it saved. Without that, a secret
 * that was set already counts as replaced only if its preview changed, since the old one would read as set too.
 */
function landed(before: Gateway, after: Gateway | undefined, d: Draft, answered: boolean): boolean {
  if (!after || after.enabled !== d.enabled) return false;
  return before.fields.every((f) => {
    const v = wanted(f, d.edits[f.key]);
    if (v === undefined) return true;
    const now = after.fields.find((a) => a.key === f.key);
    if (v === null) return !now?.set;
    if (!now?.set) return false;
    if (!f.secret) return now.value === v;
    return answered || !f.set || now.preview !== f.preview;
  });
}

/** A failed request, as a problem to show. `typed`: the secrets the request carried, kept out of the text. */
function problemOf(f: Failure, typed: readonly string[], sentSecret: boolean): Problem {
  const text = redact(f.reason, typed);
  if (f.status === 403) return { kind: "permission", text };
  if (f.status === 400 && sentSecret && /token/i.test(f.reason)) return { kind: "invalid-token", text };
  return { kind: "other", text };
}

/** Settings → Gateways' reads and writes. Every call names its profile, so a profile switch can't redirect one. */
export class GatewaysApi {
  /**
   * The values saves have sent while the app runs, newest last, kept only to take them out of any text Hermes sends
   * back later (an error that echoes one), on any read or check. Never shown, stored or sent anywhere else.
   */
  private sent: string[] = [];

  constructor(private rest: GatewaysRest) {}

  async list(profile: string): Promise<GatewayList> {
    let res: unknown;
    try {
      res = await this.rest("GET", `api/messaging/platforms?${q(profile)}`);
    } catch (e) {
      const f = failureOf(e);
      if (noRoute(f)) throw new GatewaysUnsupportedError("This Hermes server has no messaging gateway routes (/api/messaging/platforms). Updating Hermes adds them.");
      throw new GatewaysReadError(redact(f.reason, this.sent), f.status === 403 ? "permission" : "other");
    }
    const rows = obj(res).platforms;
    if (!Array.isArray(rows)) throw new Error("Hermes answered with something other than a list of messaging platforms.");
    const start = str(obj(res).gateway_start_command);
    return { profile, gateways: rows.flatMap((r) => gatewayOf(r, this.sent) ?? []), startCommand: start || undefined, readAt: Date.now() };
  }

  private async again(profile: string): Promise<GatewayList | undefined> {
    return this.list(profile).catch(() => undefined);
  }

  /**
   * Saves `d` for the platform the screen showed as `shown`. Reads it first, and sends nothing if Hermes has something
   * else now; then reads it again, and calls it saved only if the read shows all of it.
   */
  async save(profile: string, shown: Gateway, d: Draft): Promise<SaveResult> {
    const typed = shown.fields.flatMap((f) => {
      const v = f.secret ? wanted(f, d.edits[f.key]) : undefined;
      return typeof v === "string" ? [v] : [];
    });
    this.sent = [...this.sent.filter((v) => !typed.includes(v)), ...typed].slice(-50);
    const sentSecret = typed.length > 0;
    const local = draftProblem(shown, d);
    if (local) return { kind: "refused", problem: { kind: sentSecret && /redacted/.test(local) ? "invalid-token" : "other", text: local } };
    let before: GatewayList;
    try {
      before = await this.list(profile);
    } catch (e) {
      const kind = e instanceof GatewaysReadError ? e.kind : "other";
      return { kind: "refused", problem: { kind, text: `Hermes couldn't be read before saving, so nothing was sent: ${errorText(e)}` } };
    }
    const now = before.gateways.find((g) => g.id === shown.id);
    if (!now) return { kind: "refused", problem: { kind: "other", text: `This Hermes no longer lists ${shown.name}.` }, list: before };
    if (seen(now) !== seen(shown)) return { kind: "conflict", list: before };
    let res: unknown;
    try {
      res = await this.rest("PUT", `api/messaging/platforms/${shown.id}?${q(profile)}`, putBody(shown, d));
    } catch (e) {
      const f = failureOf(e);
      if (f.notRelayed || /^Not connected to Hermes/.test(f.reason)) return { kind: "refused", problem: { kind: "other", text: f.reason } };
      if (f.signedOut) return { kind: "unconfirmed", reason: f.reason };
      const list = await this.again(profile);
      // Hermes checks the whole request before it writes, so a 4xx changed nothing.
      if (f.status !== undefined && f.status >= 400 && f.status < 500) return { kind: "refused", problem: problemOf(f, this.sent, sentSecret), list };
      if (list && landed(shown, list.gateways.find((g) => g.id === shown.id), d, false)) return { kind: "saved", list, restart: !!list.gateways.find((g) => g.id === shown.id)?.gatewayRunning };
      return { kind: "unconfirmed", reason: redact(f.reason, this.sent), list };
    }
    const list = await this.again(profile);
    if (!list) return { kind: "unconfirmed", reason: "Hermes answered, but the gateways couldn't be read again to confirm it." };
    const after = list.gateways.find((g) => g.id === shown.id);
    if (!landed(shown, after, d, true)) return { kind: "unconfirmed", reason: "Hermes answered, but reading it again doesn't show all of the change.", list };
    return { kind: "saved", list, restart: !!after?.gatewayRunning && obj(res).hot_served !== true };
  }

  /** Hermes's status check: the platform's state in words. It sends no message. */
  async check(profile: string, id: PlatformId): Promise<{ check: StatusCheck; list?: GatewayList }> {
    let res: Json;
    try {
      res = obj(await this.rest("POST", `api/messaging/platforms/${id}/test?${q(profile)}`));
    } catch (e) {
      const problem = problemOf(failureOf(e), this.sent, false);
      return { check: { ok: false, problem, text: problem.text, at: Date.now() } };
    }
    const text = redact(str(res.message) || (res.ok === true ? "Connected." : "Hermes didn't say why."), this.sent);
    // The check's answer has no error code; the list, read again, does.
    const list = await this.again(profile);
    const g = list?.gateways.find((x) => x.id === id);
    const problem = res.ok === true ? undefined : g?.error && g.error.kind !== "other" ? { kind: g.error.kind, text } : undefined;
    return { check: { ok: res.ok === true, text, problem, at: Date.now() }, list };
  }
}
