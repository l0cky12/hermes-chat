// Settings → Voice against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set. It signs in with the
// dashboard's basic provider and runs the app's own VoiceSettingsApi: it lists the providers, picks some, saves a key and
// settings, and reads it all back. IT WRITES the profile's config and .env, so run it only against a throwaway dashboard:
//
//   HERMES_LIVE_DASHBOARD=http://127.0.0.4:47168/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=… \
//   npx vitest run src/hermes/voiceSettings.live.test.ts
//
// The voice set-up Rust reads in the app (`Dashboard::voice_setup`) is stood in for by `setupFrom` below, which keeps the
// same keys of the config; the Rust filter itself is tested in src-tauri/tests/transport.rs.
import { describe, expect, it } from "vitest";
import { RestError, type VoiceSetup } from "./pipe";
import { VoiceSettingsApi, activeOf, emptyDraft } from "./voiceSettings";

declare const process: { env: Record<string, string | undefined> };
const BASE = process.env.HERMES_LIVE_DASHBOARD;
const KEYS = ["model", "model_id", "voice", "voice_id", "language", "language_code"];

type Json = Record<string, unknown>;

/** What Rust passes on of the config: provider names, `stt.language`, and each provider's six setting keys as text. */
function setupFrom(config: Json): VoiceSetup {
  const section = (k: string) => (config[k] ?? {}) as Json;
  const settings = (k: string) =>
    Object.fromEntries(
      Object.entries(section(k)).flatMap(([name, block]) => {
        if (name === "providers" || !block || typeof block !== "object" || Array.isArray(block)) return [];
        const fields = Object.fromEntries(Object.entries(block as Json).filter(([f, v]) => KEYS.includes(f) && typeof v === "string")) as Record<string, string>;
        return Object.keys(fields).length ? [[name, fields]] : [];
      }),
    );
  return {
    transcribe: true,
    speak: true,
    sttEnabled: section("stt").enabled !== false,
    sttProvider: typeof section("stt").provider === "string" ? (section("stt").provider as string) : undefined,
    ttsProvider: typeof section("tts").provider === "string" ? (section("tts").provider as string) : undefined,
    sttLanguage: typeof section("stt").language === "string" ? (section("stt").language as string) : undefined,
    sttSettings: settings("stt"),
    ttsSettings: settings("tts"),
  };
}

async function signedIn() {
  let cookie = "";
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const login = await send("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
  if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);
  const sent: string[] = [];
  // As the Rust relay words a failure (src-tauri/src/transport.rs `TransportError::Unexpected`).
  const rest = async (method: "GET" | "PUT", path: string, body?: unknown) => {
    sent.push(`${method} ${path.split("?")[0]}`);
    const res = await send(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new RestError(res.status, text);
    return JSON.parse(text);
  };
  const api = new VoiceSettingsApi(rest, async (profile) => setupFrom(await rest("GET", `api/config?profile=${profile}`)));
  return { api, rest, sent };
}

describe.skipIf(!BASE)("Settings → Voice against a real dashboard", () => {
  it("lists, picks, saves a key and settings, and reads them back; refuses before writing; sees another client's change", async () => {
    const { api, rest, sent } = await signedIn();
    const before = await api.read("default");
    const report = (r = before) =>
      Object.fromEntries((["stt", "tts"] as const).map((k) => [k, r.sides[k].providers.map((p) => `${p.name}${p.active ? "*" : ""} ${p.status}${p.section ? ` [${p.section}]` : ""}`)]));
    console.log("before", JSON.stringify(report(), null, 1));
    // Every speech-to-text row Hermes lists has a known config section, but the managed one.
    expect(before.sides.stt.providers.filter((p) => !p.managed && !p.section)).toEqual([]);
    expect(before.options["stt.groq.model"]).toEqual(["whisper-large-v3-turbo", "whisper-large-v3"]);

    const saved = await api.save("default", before, {
      ...emptyDraft(),
      provider: { tts: "OpenAI TTS", stt: "Groq" },
      keys: { tts: { VOICE_TOOLS_OPENAI_KEY: "sk-live-check-not-a-real-key" }, stt: { GROQ_API_KEY: "gsk-live-check-not-a-real-key" } },
      settings: { "tts.openai.voice": "nova", "stt.groq.model": "whisper-large-v3", "stt.language": "" },
    });
    console.log("save", saved.kind, sent.filter((s) => s.startsWith("PUT")));
    expect(saved.kind).toBe("saved");
    if (saved.kind !== "saved") return;
    expect(activeOf(saved.read, "tts")).toMatchObject({ name: "OpenAI TTS", status: "ready" });
    expect(activeOf(saved.read, "stt")).toMatchObject({ name: "Groq", status: "ready" });
    expect(saved.read.values).toMatchObject({ "tts.openai.voice": "nova", "stt.groq.model": "whisper-large-v3", "stt.language": "" });
    expect(JSON.stringify(saved.read)).not.toContain("not-a-real-key");

    // A name Hermes doesn't list is refused before anything is written.
    const refused = await api.save("default", saved.read, { ...emptyDraft(), provider: { tts: "No such provider" } });
    console.log("refused", JSON.stringify(refused).slice(0, 200));
    expect(refused).toMatchObject({ kind: "failed", refused: true, done: [] });

    // Another client changes the voice between the owner's read and save: nothing is sent.
    const stale = saved.read;
    await rest("PUT", "api/config?profile=default", { config: { tts: { openai: { voice: "onyx" } } } });
    const writesBefore = sent.length;
    const conflict = await api.save("default", stale, { ...emptyDraft(), settings: { "tts.openai.voice": "shimmer" } });
    expect(conflict).toMatchObject({ kind: "conflict", what: ["OpenAI TTS's voice"] });
    expect(sent.slice(writesBefore).filter((s) => s.startsWith("PUT"))).toEqual([]);
    expect((await api.read("default")).values["tts.openai.voice"]).toBe("onyx");

    // Back to Edge, as it started.
    const back = await api.save("default", await api.read("default"), { ...emptyDraft(), provider: { tts: "Microsoft Edge TTS", stt: "Local Whisper" } });
    expect(back.kind).toBe("saved");
    console.log("after", JSON.stringify(report(back.kind === "saved" ? back.read : before), null, 1));
  }, 60_000);
});
