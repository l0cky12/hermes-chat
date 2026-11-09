// Settings → Voice: which speech-to-text and text-to-speech provider a profile uses on Hermes, each provider's model,
// voice and language, and its API keys. Read from and written to the dashboard routes Hermes's own `hermes tools`
// picker uses, at the deployed `f0d94882e8` (`hermes_cli/web_routers/tools.py`, research doc "Voice providers", ADR 0115):
//
// - `GET /api/tools/toolsets/{stt,tts}/config?profile=` lists the providers Hermes offers (`TOOL_CATEGORIES` plus
//   plugin rows), each with its readiness (`provider_readiness_status`: ready, needs_keys, needs_setup, needs_auth),
//   whether it is the one in use (`is_active`), and its API keys as env var names with `is_set`, never values.
// - `PUT /api/tools/toolsets/{stt,tts}/provider?profile=` `{provider}` picks one by the name it is listed under
//   (`apply_provider_selection`: writes `<kind>.provider`, or `nous` for the Nous Subscription row, under the config lock).
// - `PUT /api/tools/toolsets/{stt,tts}/env?profile=` `{env: {NAME: key}}` saves keys to the profile's `.env`. Hermes takes
//   only env vars its providers list, and skips a blank one.
// - `PUT /api/config?profile=` `{config: {tts: {openai: {voice}}}}` deep-merges a provider's settings over the stored
//   config, under the same lock.
// - `GET /api/config/schema?profile=` says which settings have a fixed list of choices (`stt.openai.model`, …).
//
// The settings' current values come from Rust (`Pipe.voiceSetup`), which reads the config and passes on only the model,
// voice and language of each provider section: the config itself can hold API keys (`stt.openai.api_key`).
//
// Nothing is taken on trust, as with Toolsets and Memory: before a save, what the owner is changing is read again and
// nothing is sent if another client changed it since; after it, everything is read back, and it is called saved only
// when the read shows what was sent. Saves go one at a time for the whole app.

import type { VoiceSetup } from "./pipe";
import { failureOf } from "./toolsets";

export type VoiceKind = "stt" | "tts";
export const KINDS: readonly VoiceKind[] = ["stt", "tts"];

/**
 * A setting the screen offers for a provider: its key in the provider's config section (`tts.openai.voice`). `blankOk`:
 * Hermes falls back to a default (or detects it) when it is blank. Otherwise a blank is refused: `PUT /api/config` can't
 * remove a key, and Hermes would use the empty value (`cfg.get("voice", DEFAULT)` in `tools/tts_tool_*.py`).
 */
export type VoiceField = { key: string; label: string; hint?: string; blankOk?: boolean };

const model: VoiceField = { key: "model", label: "Model" };
const voice: VoiceField = { key: "voice", label: "Voice" };
const voiceId: VoiceField = { key: "voice_id", label: "Voice", hint: "The provider's voice ID." };
const language: VoiceField = { key: "language", label: "Language", hint: "A code such as en or es. Blank: the provider detects it.", blankOk: true };
// Of the speech-to-text models, Local Whisper's (`_normalize_local_model`), xAI's (`normalize_xai_stt_model`) and
// DeepInfra's (the live catalog's first) fall back when blank; Groq, OpenAI and Mistral send a blank model as it is.
const sttModel: VoiceField = { ...model, blankOk: true };

/**
 * The settings shown for each provider, by its config section: Hermes's own defaults name them
 * (`hermes_cli/config_defaults.py` at `f0d94882e8`). Only these reach the webview (`VOICE_SETTING_KEYS` in Rust). A
 * provider without an entry is picked and given keys here, and its other settings are left to the server.
 */
export const PROVIDER_FIELDS: Record<VoiceKind, Record<string, VoiceField[]>> = {
  stt: {
    local: [{ ...sttModel, label: "Model size", hint: "Bigger is more accurate and slower. It downloads on first use." }, language],
    groq: [model, language],
    openai: [model, language],
    mistral: [model, language],
    xai: [{ ...sttModel, hint: "Blank: Hermes's default, grok-voice-transcribe-2.0." }, language],
    elevenlabs: [
      { key: "model_id", label: "Model" },
      { key: "language_code", label: "Language", hint: "A three-letter code such as eng. Blank: the provider detects it.", blankOk: true },
    ],
    deepinfra: [{ ...sttModel, hint: "Blank: the first speech-to-text model in DeepInfra's catalog." }],
  },
  tts: {
    edge: [{ ...voice, hint: "Such as en-US-AriaNeural or en-GB-SoniaNeural." }],
    openai: [model, { ...voice, hint: "Such as alloy, nova, onyx or shimmer." }],
    elevenlabs: [voiceId, { key: "model_id", label: "Model" }],
    gemini: [{ ...model, blankOk: true }, { ...voice, hint: "Such as Kore or Puck.", blankOk: true }],
    xai: [{ ...voiceId, hint: "Such as eve, or a custom voice ID.", blankOk: true }, { ...language, hint: "A code such as en or pt-BR, or auto." }],
    mistral: [model, { ...voiceId, blankOk: true }],
    minimax: [model, voiceId],
    kittentts: [model, voice],
    neutts: [model],
    piper: [{ ...voice, hint: "A voice name, downloaded on first use, or the path of an .onnx file on the server.", blankOk: true }],
    deepinfra: [{ ...model, hint: "Blank: the first text-to-speech model in DeepInfra's catalog.", blankOk: true }, voice],
  },
};

/** `stt.language`: the language hint Hermes gives every speech-to-text provider without its own. */
export const STT_LANGUAGE = "stt.language";

/** The longest setting this app sends: Rust passes on no longer value, so a longer one could never read back. */
export const SETTING_MAX = 256;

/** The field at a config path, if the screen offers one there. */
function fieldAt(path: string): VoiceField | undefined {
  if (path === STT_LANGUAGE) return { key: "language", label: "Language", blankOk: true };
  const [kind, section, key] = path.split(".");
  return PROVIDER_FIELDS[kind as VoiceKind]?.[section]?.find((f) => f.key === key);
}

/**
 * Why a draft can't be sent, if it can't: a blank where Hermes would use the blank, a setting too long to read back, or
 * a pick of a provider that needs a sign-in on the server. Hermes's provider route writes a Nous Subscription pick as
 * `nous` and only then says the account isn't entitled (`needs_nous_auth`), leaving no provider in use; an xAI pick
 * without its sign-in is written as `xai` and fails when used.
 */
export function draftProblems(read: VoiceRead, draft: VoiceDraft): string[] {
  const out: string[] = [];
  for (const [path, value] of Object.entries(draft.settings)) {
    const f = fieldAt(path);
    if (!value.trim() && !f?.blankOk) out.push(`${settingLabel(read, path)} can't be blank: Hermes would use the blank value.`);
    // Some providers strip a value before falling back and some don't (Piper's voice, Mistral's voice ID), so spaces
    // alone are never sent.
    else if (value && !value.trim()) out.push(`${settingLabel(read, path)} has only spaces: leave it empty or type a value.`);
    else if (value.length > SETTING_MAX) out.push(`${settingLabel(read, path)} is longer than ${SETTING_MAX} characters.`);
  }
  for (const kind of KINDS) {
    const name = draft.provider[kind];
    const p = name === undefined ? undefined : read.sides[kind].providers.find((r) => r.name === name);
    if (p?.status === "needs_auth")
      out.push(`${p.name} needs a sign-in on the Hermes server first (with hermes tools there); picking it now would leave no ${KIND_LABEL[kind].toLowerCase()} provider working.`);
  }
  return out;
}

/**
 * Hermes lists speech-to-text providers by name only (its `/config` answer has `tts_provider` for text-to-speech rows,
 * but no `stt_provider`), so a row's config section is found by its name, as `TOOL_CATEGORIES` names them at `f0d94882e8`.
 */
const STT_SECTION: Record<string, string> = {
  "Local Whisper": "local",
  OpenAI: "openai",
  Groq: "groq",
  xAI: "xai",
  "ElevenLabs Scribe": "elevenlabs",
  "Mistral Voxtral": "mistral",
  DeepInfra: "deepinfra",
};

/** A provider as Hermes lists it for a profile. */
export type VoiceProvider = {
  /** The name Hermes lists it under, and picks it by. */
  name: string;
  /** Its config section (`tts.<section>.*`), when known; none for the Nous Subscription rows, whose gateway decides. */
  section?: string;
  badge: string;
  tag: string;
  /** `ready`, `needs_keys`, `needs_setup` or `needs_auth`, as Hermes says. */
  status: string;
  /** The one the profile uses now. */
  active: boolean;
  /** Its API keys: env var names and whether each is set on the server. Values never come back. */
  keys: { env: string; prompt: string; url?: string; set: boolean }[];
  /** A Nous Subscription row: Hermes's gateway, signed in on the server. */
  managed: boolean;
};

export type VoiceSide = { kind: VoiceKind; providers: VoiceProvider[] };

/** What Settings → Voice shows for a profile. `values`: each setting's value by its config path (`tts.openai.voice`). */
export type VoiceRead = {
  profile: string;
  setup: VoiceSetup;
  sides: Record<VoiceKind, VoiceSide>;
  values: Record<string, string>;
  /** The choices Hermes offers for a setting, by config path, when it has a fixed list. */
  options: Record<string, string[]>;
  readAt: number;
};

/** The owner's unsaved changes. `provider`: the name to pick; `settings`: by config path; `keys`: typed keys, by env var. */
export type VoiceDraft = {
  provider: Partial<Record<VoiceKind, string>>;
  settings: Record<string, string>;
  keys: Partial<Record<VoiceKind, Record<string, string>>>;
};

export const emptyDraft = (): VoiceDraft => ({ provider: {}, settings: {}, keys: {} });

/** Whether a draft changes anything; a blank key changes nothing (Hermes skips it). */
export const draftChanges = (d: VoiceDraft) =>
  Object.keys(d.provider).length > 0 || Object.keys(d.settings).length > 0 || KINDS.some((k) => Object.values(d.keys[k] ?? {}).some((v) => v.trim()));

/** What a save came to. Every kind but `failed` without `read` carries what Hermes has now, read after the attempt. */
export type VoiceSave =
  /** Read back as sent. `warning`: Hermes answered with this error, yet the read shows it all. */
  | { kind: "saved"; read: VoiceRead; warning?: string }
  /**
   * Not sent: another client changed these since the owner read them. `kinds` and `paths`: the picks and settings that
   * changed, which the screen drops from the draft so it shows Hermes's values.
   */
  | { kind: "conflict"; read: VoiceRead; what: string[]; kinds: VoiceKind[]; paths: string[] }
  /** Sent, but the read afterwards doesn't show these. */
  | { kind: "mismatch"; read: VoiceRead; what: string[] }
  /**
   * A write failed. `refused`: Hermes answered 4xx, which it does before writing; otherwise the answer was lost or a server
   * error, and it may have been written. `done`: the writes before it that Hermes took.
   */
  | { kind: "failed"; reason: string; refused: boolean; done: string[]; read?: VoiceRead };

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type VoiceRest = (method: "GET" | "PUT", pathAndQuery: string, body?: unknown) => Promise<unknown>;

export class VoiceUnsupportedError extends Error {}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const noRoute = (status: number | undefined, reason: string) => status === 405 || (status === 404 && reason === "Not Found");

export const KIND_LABEL: Record<VoiceKind, string> = { stt: "Speech-to-text", tts: "Text-to-speech" };

const keyLabel = (kind: VoiceKind, env: Record<string, string>) => `the ${KIND_LABEL[kind].toLowerCase()} ${Object.keys(env).length === 1 ? "key" : "keys"}`;

/** What a provider's readiness means for the owner, as a badge and a sentence. */
export function readiness(p: VoiceProvider): { badge: string; text: string; ok: boolean } {
  switch (p.status) {
    case "ready":
      return { badge: "Set up", text: "Set up on the server.", ok: true };
    case "needs_keys":
      return { badge: "Needs a key", text: "Hermes has no API key for it yet. Type one below to save it on the server.", ok: false };
    case "needs_setup":
      return {
        badge: "Not installed",
        text: "Its software isn't installed on the Hermes server. Run hermes tools there (Speech-to-Text or Text-to-Speech) to install it.",
        ok: false,
      };
    case "needs_auth":
      return { badge: "Needs sign-in", text: "It needs an account signed in on the Hermes server (Nous Portal or xAI), done with hermes tools there.", ok: false };
    default:
      return { badge: p.status || "Unknown", text: `Hermes says its state is "${p.status}".`, ok: false };
  }
}

/** The config path of a provider's setting. */
export const settingPath = (kind: VoiceKind, section: string, key: string) => `${kind}.${section}.${key}`;

/** The settings shown for `p`, with their config paths. */
export function fieldsOf(kind: VoiceKind, p: VoiceProvider | undefined): (VoiceField & { path: string })[] {
  if (!p?.section) return [];
  return (PROVIDER_FIELDS[kind][p.section] ?? []).map((f) => ({ ...f, path: settingPath(kind, p.section!, f.key) }));
}

function providersFrom(kind: VoiceKind, res: unknown): VoiceProvider[] {
  const body = obj(res);
  if (body.has_category === false || !Array.isArray(body.providers)) throw new VoiceUnsupportedError(`Hermes has no ${KIND_LABEL[kind].toLowerCase()} providers to pick from.`);
  return body.providers.flatMap((r): VoiceProvider[] => {
    const row = obj(r);
    const name = str(row.name);
    if (!name) return [];
    const managed = !!str(row.managed_nous_feature) || row.requires_nous_auth === true;
    const section = managed ? undefined : kind === "tts" ? str(row.tts_provider) || undefined : STT_SECTION[name];
    return [
      {
        name,
        section,
        badge: str(row.badge),
        tag: str(row.tag),
        status: str(row.status),
        active: row.is_active === true,
        keys: (Array.isArray(row.env_vars) ? row.env_vars : []).map(obj).flatMap((e) =>
          str(e.key) ? [{ env: str(e.key), prompt: str(e.prompt) || str(e.key), url: str(e.url) || undefined, set: e.is_set === true }] : [],
        ),
        managed,
      },
    ];
  });
}

/** Each setting's value from the voice set-up Rust read: `stt.language` and `<kind>.<section>.<key>`. */
function valuesFrom(setup: VoiceSetup): Record<string, string> {
  const out: Record<string, string> = {};
  if (setup.sttLanguage !== undefined) out[STT_LANGUAGE] = setup.sttLanguage;
  for (const kind of KINDS)
    for (const [section, fields] of Object.entries((kind === "stt" ? setup.sttSettings : setup.ttsSettings) ?? {}))
      for (const [key, value] of Object.entries(fields)) out[settingPath(kind, section, key)] = value;
  return out;
}

function optionsFrom(schema: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, field] of Object.entries(obj(obj(schema).fields))) {
    if (!/^(stt|tts)\./.test(path)) continue;
    const options = obj(field).options;
    if (Array.isArray(options) && options.every((o) => typeof o === "string")) out[path] = options as string[];
  }
  return out;
}

/** The provider `kind` uses now, as Hermes marks it. */
export const activeOf = (read: VoiceRead, kind: VoiceKind) => read.sides[kind].providers.find((p) => p.active);

/** The provider name the profile's config writes for `kind` (`stt.provider`), if any. */
export const namedOf = (read: VoiceRead, kind: VoiceKind) => (kind === "stt" ? read.setup.sttProvider : read.setup.ttsProvider);

/**
 * The listed provider the profile has picked for `kind`: the one in use, when the config names one. With `stt.provider`
 * unset Hermes marks Local Whisper in use but picks as it transcribes, so nothing counts as picked, and picking Local
 * Whisper writes it.
 */
export const pickedOf = (read: VoiceRead, kind: VoiceKind) => {
  const named = namedOf(read, kind)?.toLowerCase();
  const active = activeOf(read, kind);
  // The row and the name must agree: the list and the config are separate reads, and could disagree.
  return named && active && identityOf(active) === named ? active : undefined;
};

/** What picking `p` writes to `<kind>.provider`: its config section, or `nous` for a Nous Subscription row. */
const identityOf = (p: VoiceProvider) => (p.managed ? "nous" : p.section?.toLowerCase());

/**
 * What Hermes changed between `base` (the read a draft was made from) and `now`, of what the draft changes: a provider
 * side, compared both as the row Hermes marks in use and as the name the config writes (a switch between two providers
 * Hermes doesn't list changes only the name), and each setting.
 */
export function changedUnder(base: VoiceRead, now: VoiceRead, draft: VoiceDraft): { what: string[]; kinds: VoiceKind[]; paths: string[] } {
  // A side counts when the draft picks there, or holds a key or a provider's setting there: those were typed for the
  // provider shown then.
  const touches = (kind: VoiceKind) =>
    draft.provider[kind] !== undefined ||
    Object.values(draft.keys[kind] ?? {}).some((v) => v) ||
    Object.keys(draft.settings).some((path) => path.startsWith(`${kind}.`) && path !== STT_LANGUAGE);
  const kinds = KINDS.filter(
    (kind) => touches(kind) && (activeOf(now, kind)?.name !== activeOf(base, kind)?.name || namedOf(now, kind) !== namedOf(base, kind)),
  );
  const paths = Object.keys(draft.settings).filter((path) => now.values[path] !== base.values[path]);
  const what = [
    ...kinds.map((kind) => `the ${KIND_LABEL[kind].toLowerCase()} provider (now ${activeOf(now, kind)?.name ?? namedOf(now, kind) ?? "none"})`),
    ...paths.map((path) => settingLabel(now, path)),
  ];
  return { what, kinds, paths };
}

/**
 * The draft with what Hermes changed under it dropped, so the screen shows Hermes's values there. A provider side that
 * changed loses its pick and everything typed for it: settings and keys typed for a pick the owner no longer sees are
 * never sent.
 */
export function withoutChanged(draft: VoiceDraft, kinds: VoiceKind[], paths: string[]): VoiceDraft {
  const provider = { ...draft.provider };
  const keys = { ...draft.keys };
  for (const kind of kinds) {
    delete provider[kind];
    delete keys[kind];
  }
  const settings = Object.fromEntries(
    Object.entries(draft.settings).filter(([path]) => !paths.includes(path) && !kinds.some((kind) => path.startsWith(`${kind}.`) && path !== STT_LANGUAGE)),
  );
  return { provider, settings, keys };
}

/** `{tts: {openai: {voice: "nova"}}}` from `{"tts.openai.voice": "nova"}`. */
function nested(settings: Record<string, string>): Json {
  const out: Json = {};
  for (const [path, value] of Object.entries(settings)) {
    const parts = path.split(".");
    let at = out;
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Json;
    at[parts[parts.length - 1]] = value;
  }
  return out;
}

/** A setting's path as the owner reads it: the provider's name and the setting's label. */
function settingLabel(read: VoiceRead, path: string): string {
  if (path === STT_LANGUAGE) return "the speech-to-text language";
  const [kind, section, key] = path.split(".") as [VoiceKind, string, string];
  const p = read.sides[kind]?.providers.find((r) => r.section === section);
  const f = PROVIDER_FIELDS[kind]?.[section]?.find((x) => x.key === key);
  return `${p?.name ?? section}'s ${(f?.label ?? key).toLowerCase()}`;
}

/**
 * Settings → Voice's reads and writes. Every call names its profile, so a profile switch can't redirect one, and saves go
 * one at a time for the whole app.
 */
export class VoiceSettingsApi {
  private queue: Promise<unknown> = Promise.resolve();
  private saving?: string;
  private listeners = new Set<() => void>();

  constructor(
    private readonly rest: VoiceRest,
    /** The profile's voice set-up from Rust, read afresh (not the chat panes' cached copy). */
    private readonly readSetup: (profile: string) => Promise<VoiceSetup>,
    /** Called after a write Hermes may have taken, so the chat panes read the voice set-up again. */
    private readonly changed: (profile: string) => void = () => {},
  ) {}

  /** The profile a save is on its way for, if any. */
  readonly pending = (): string | undefined => this.saving;
  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private setSaving(profile: string | undefined) {
    this.saving = profile;
    for (const fn of this.listeners) fn();
  }

  private q = (profile: string) => new URLSearchParams({ profile }).toString();

  private async side(profile: string, kind: VoiceKind): Promise<VoiceSide> {
    try {
      return { kind, providers: providersFrom(kind, await this.rest("GET", `api/tools/toolsets/${kind}/config?${this.q(profile)}`)) };
    } catch (e) {
      if (e instanceof VoiceUnsupportedError) throw e;
      const f = failureOf(e);
      if (noRoute(f.status, f.reason))
        throw new VoiceUnsupportedError(
          `This Hermes server doesn't list its speech providers: it has no /api/tools/toolsets/${kind}/config route. Updating Hermes adds it.`,
        );
      throw new Error(f.reason);
    }
  }

  /**
   * Everything Settings → Voice shows for `profile`. Throws `VoiceUnsupportedError` when Hermes can't list its providers.
   * The setting choices are a nicety: without them every setting is typed.
   */
  async read(profile: string): Promise<VoiceRead> {
    const [setup, stt, tts, schema] = await Promise.all([
      this.readSetup(profile),
      this.side(profile, "stt"),
      this.side(profile, "tts"),
      this.rest("GET", `api/config/schema?${this.q(profile)}`).catch(() => undefined),
    ]);
    // Without the config, nothing could be checked before a write or confirmed after it (Rust says so by leaving
    // `sttEnabled` out).
    if (setup.sttEnabled === undefined)
      throw new Error("Hermes Chat couldn't read the profile's config on Hermes, so it can't check or confirm a change to the speech providers.");
    return { profile, setup, sides: { stt, tts }, values: valuesFrom(setup), options: optionsFrom(schema), readAt: Date.now() };
  }

  /** Saves `draft` for `profile`, checked against `base`, the read the owner made it from. */
  save(profile: string, base: VoiceRead, draft: VoiceDraft): Promise<VoiceSave> {
    const run = async () => {
      this.setSaving(profile);
      try {
        return await this.write(profile, base, draft);
      } finally {
        this.setSaving(undefined);
      }
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => {});
    return done;
  }

  private async write(profile: string, base: VoiceRead, draft: VoiceDraft): Promise<VoiceSave> {
    // Checked first: another client may have picked another provider or changed a setting since the owner read them.
    const before = await this.read(profile);
    // The provider is compared both as Hermes lists it and as the config names it: a switch between two providers Hermes
    // doesn't list (command or plugin ones) changes only the name.
    const { what, kinds, paths } = changedUnder(base, before, draft);
    if (what.length) return { kind: "conflict", read: before, what, kinds, paths };

    const problems = draftProblems(before, draft);
    if (problems.length) return { kind: "failed", reason: problems.join(" "), refused: true, done: [], read: before };

    const keys = KINDS.map((kind) => [kind, Object.fromEntries(Object.entries(draft.keys[kind] ?? {}).filter(([, v]) => v.trim()))] as const).filter(
      ([, env]) => Object.keys(env).length,
    );
    const steps: { label: string; send: () => Promise<unknown> }[] = [
      // Keys first, so a provider picked with its new key is ready once it is in use.
      ...keys.map(([kind, env]) => ({
        label: keyLabel(kind, env),
        send: () => this.rest("PUT", `api/tools/toolsets/${kind}/env?${this.q(profile)}`, { env }),
      })),
      ...KINDS.filter((kind) => draft.provider[kind] !== undefined && draft.provider[kind] !== pickedOf(before, kind)?.name).map((kind) => ({
        label: `the ${KIND_LABEL[kind].toLowerCase()} provider`,
        send: () => this.rest("PUT", `api/tools/toolsets/${kind}/provider?${this.q(profile)}`, { provider: draft.provider[kind] }),
      })),
      ...(Object.keys(draft.settings).length
        ? [{ label: "the provider settings", send: () => this.rest("PUT", `api/config?${this.q(profile)}`, { config: nested(draft.settings) }) }]
        : []),
    ];

    const done: string[] = [];
    let failure: { reason: string; refused: boolean } | undefined;
    for (const step of steps) {
      try {
        await step.send();
        done.push(step.label);
      } catch (e) {
        const f = failureOf(e);
        if (f.signedOut) throw e;
        // A request the relay refused never left this computer; a 4xx is Hermes refusing before it writes.
        failure = { reason: f.reason, refused: !!f.notRelayed || (f.status !== undefined && f.status >= 400 && f.status < 500) };
        break;
      }
    }
    if (done.length || (failure && !failure.refused)) this.changed(profile);
    if (failure?.refused && !done.length) {
      const read = await this.read(profile).catch(() => undefined);
      return { kind: "failed", ...failure, done, read };
    }

    // What Hermes has now decides, whatever it answered: an error answer is no proof nothing was written.
    const after = await this.read(profile).catch((e) => e as Error);
    if (after instanceof Error)
      return failure
        ? { kind: "failed", ...failure, done }
        : { kind: "failed", reason: `Hermes took the changes, but reading them back failed: ${after.message}`, refused: false, done };
    const missing: string[] = [];
    for (const kind of KINDS) {
      const want = draft.provider[kind];
      // Named in the config too: Hermes marks Local Whisper in use while `stt.provider` is unset.
      if (want !== undefined && pickedOf(after, kind)?.name !== want) missing.push(`the ${KIND_LABEL[kind].toLowerCase()} provider`);
    }
    for (const [path, value] of Object.entries(draft.settings)) if (after.values[path] !== value) missing.push(settingLabel(after, path));
    for (const [kind, env] of keys)
      for (const name of Object.keys(env))
        if (!after.sides[kind].providers.some((p) => p.keys.some((k) => k.env === name && k.set))) missing.push(name);
    // A key Hermes says is set may be the one it had before: when a key's write didn't answer, the read can't prove it.
    const keysUnproven = !!failure && keys.some(([kind, env]) => !done.includes(keyLabel(kind, env)));
    if (!missing.length && !keysUnproven) return { kind: "saved", read: after, ...(failure ? { warning: failure.reason } : {}) };
    if (failure) return { kind: "failed", ...failure, done, read: after };
    return { kind: "mismatch", read: after, what: missing };
  }
}
