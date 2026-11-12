// Settings → Voice → Speech to text: where Dictation and voice conversations turn speech into text, on the Hermes
// server or on this computer, and whether the other is the backup (ADR 0065, building on ADR 0067); this computer's
// engine, model and language, with Whisper models to download for whisper.cpp; and a Test that records a few seconds
// and has each side transcribe them. Everything shown is what Rust read back (src-tauri/src/local_stt.rs).
import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen, Mic, Trash2, X } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import type { VoiceSetup } from "../hermes/pipe";
import {
  LANGUAGES,
  MODEL_NOTES,
  baseName,
  prefsOf,
  type DownloadProgress,
  type FoundEngine,
  type LocalModels,
  type LocalSttApi,
  type LocalSttChange,
  type LocalSttState,
} from "../hermes/localStt";
import { STT_TIMEOUTS, inRoute, other, sttRoute, type HeardTranscript, type SttSide } from "../hermes/sttRoute";
import { sttProvider } from "../hermes/voice";
import { arrowSelect, Spinner } from "./bits";
import { CaptureAborted, startCapture, type AudioEnv, type Capture } from "./recorder";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { errorText, formatBytes } from "../hermes/values";

/** How long the Test records. */
export const TEST_SECONDS = 5;

const SIDE_LABEL: Record<SttSide, string> = { server: "Hermes server", local: "This computer" };

type Tried = { side: SttSide; running?: boolean; text?: string; ms?: number; by?: string; error?: string };
type Test = { phase: "recording"; capture: Capture } | { phase: "transcribing" | "done"; tried: Tried[] } | { phase: "failed"; why: string };

export function LocalSttSettings({
  api,
  transcribe,
  status,
  setup,
  changes = 0,
  env,
}: {
  api: LocalSttApi;
  /** The app's own path for a recording, the one Dictation takes, or one side alone: Rust decides where it may go. */
  transcribe?: (audio: Uint8Array, mime: string, side?: SttSide, signal?: AbortSignal) => Promise<HeardTranscript>;
  status: ConnectionStatus;
  /** The profile's voice set-up, to name its speech-to-text provider on Hermes. */
  setup?: () => Promise<VoiceSetup>;
  changes?: number;
  env?: AudioEnv;
}) {
  const connected = status === "connected";
  const [state, setState] = useState<LocalSttState>();
  const [found, setFound] = useState<FoundEngine[]>();
  const [downloads, setDownloads] = useState<LocalModels>();
  const [progress, setProgress] = useState<DownloadProgress>();
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<Test>();
  // `run` goes up with every Test and every stop, so anything from an older one is dropped. `starting` aborts a
  // microphone still opening; `capture` is the open one; `sending` stops a transcription on its way, in Rust too.
  const live = useRef({
    run: 0,
    capture: undefined as Capture | undefined,
    starting: undefined as AbortController | undefined,
    sending: undefined as AbortController | undefined,
    mounted: true,
    reads: 0,
  });

  /**
   * Shows what a read or change of the choice answers, numbered when it was asked: an answer to an older one that
   * comes late (a re-read after a download, say, overtaken by a Backup change) is dropped, here and in the route store.
   */
  const track = (p: Promise<LocalSttState | undefined>) => {
    const mine = ++live.current.reads;
    void sttRoute
      .refresh(() => p.then((s) => (s ? prefsOf(s) : sttRoute.get())))
      .catch(() => {});
    return p.then((s) => {
      if (s && live.current.mounted && mine === live.current.reads) setState(s);
    });
  };
  useEffect(() => {
    const now = live.current;
    now.mounted = true;
    track(api.state()).catch((e) => setError(errorText(e)));
    return () => {
      now.mounted = false;
      now.run++;
      now.starting?.abort();
      now.sending?.abort();
      now.capture?.cancel();
    };
  }, [api]);
  const route = prefsOf(state);
  // This computer's engine is set up here once it is in the route, first or as backup.
  const here = !!state && inRoute(route, "local");
  useEffect(() => {
    if (!here) return;
    if (!found) api.detect().then((f) => live.current.mounted && setFound(f), (e) => setError(errorText(e)));
    if (!downloads) api.models().then((m) => live.current.mounted && setDownloads(m), (e) => setError(errorText(e)));
  }, [here, found, downloads, api]);
  // A download this screen didn't start (begun before Settings was left and opened again) reports to the screen that
  // started it, so this one reads Rust's list until it ends.
  const othersDownload = !!downloads?.downloading && !progress;
  useEffect(() => {
    if (!othersDownload) return;
    const id = setInterval(() => {
      api.models().then(
        (m) => {
          if (!live.current.mounted) return;
          setDownloads(m);
          if (!m.downloading) setFound(undefined);
        },
        () => {},
      );
    }, 1000);
    return () => clearInterval(id);
  }, [othersDownload, api]);

  const [serverSetup, setServerSetup] = useState<VoiceSetup>();
  useEffect(() => {
    if (!setup || !connected) return;
    let on = true;
    setup().then(
      (s) => on && setServerSetup(s),
      () => {},
    );
    return () => {
      on = false;
    };
  }, [setup, connected, changes]);

  /** Drops any Test under way, closing its microphone, so a newer one or a change can't leave it open. */
  const stopTest = () => {
    live.current.run++;
    live.current.starting?.abort();
    live.current.sending?.abort();
    live.current.capture?.cancel();
    live.current.capture = undefined;
    setTest(undefined);
  };

  const act = (p: Promise<LocalSttState | undefined>) => {
    setError(undefined);
    stopTest();
    track(p).catch((e) => live.current.mounted && setError(errorText(e)));
  };
  const change = (c: LocalSttChange) => act(api.set(c));
  const actModels = (p: Promise<LocalModels>) => {
    setError(undefined);
    p.then(
      (m) => {
        if (!live.current.mounted) return;
        setDownloads(m);
        // The engine's model list and the chosen model's problem follow the files.
        setFound(undefined);
        track(api.state()).catch(() => {});
      },
      (e) => live.current.mounted && setError(errorText(e)),
    );
  };
  const download = (name: string) => {
    setProgress({ name, done: 0, total: downloads?.models.find((m) => m.name === name)?.bytes ?? 0 });
    actModels(api.download(name, (p) => live.current.mounted && setProgress(p)).finally(() => live.current.mounted && setProgress(undefined)));
  };

  const runTest = async () => {
    if (!transcribe) return;
    stopTest();
    const run = live.current.run;
    // Ends this run, so a microphone lost mid-Test isn't transcribed when the timer fires.
    const fail = (why: string) => {
      if (run !== live.current.run) return;
      live.current.run++;
      live.current.capture = undefined;
      setTest({ phase: "failed", why });
    };
    const starting = (live.current.starting = new AbortController());
    try {
      const capture = await startCapture(fail, starting.signal, env);
      if (run !== live.current.run) return capture.cancel();
      live.current.capture = capture;
      setTest({ phase: "recording", capture });
      await new Promise((r) => setTimeout(r, TEST_SECONDS * 1000));
      if (run !== live.current.run) return capture.cancel();
      live.current.capture = undefined;
      const recording = capture.stop();
      // Each side that may get this recording, the primary first; Hermes only when it is in the route.
      const order: SttSide[] = [route.primary, other(route.primary)];
      const tried: Tried[] = order.map((side) =>
        side === "server" && !inRoute(route, "server")
          ? { side, error: "Not tried: with This computer and no backup, recordings never go to Hermes." }
          : side === "server" && !connected
            ? { side, error: "Not tried: not connected to Hermes." }
            : { side, running: true },
      );
      setTest({ phase: "transcribing", tried: [...tried] });
      const sending = (live.current.sending = new AbortController());
      for (const [i, t] of tried.entries()) {
        if (!t.running) continue;
        const started = performance.now();
        try {
          const got = await transcribe(recording.audio, recording.mime, t.side, sending.signal);
          tried[i] = { side: t.side, text: got.text, ms: performance.now() - started, by: got.provider };
        } catch (e) {
          tried[i] = { side: t.side, error: errorText(e), ms: performance.now() - started };
        }
        if (run !== live.current.run) return;
        setTest({ phase: "transcribing", tried: [...tried] });
      }
      setTest({ phase: "done", tried: [...tried] });
    } catch (e) {
      if (!(e instanceof CaptureAborted)) fail(errorText(e));
    } finally {
      if (live.current.starting === starting) live.current.starting = undefined;
    }
  };

  const engine = state?.engine ?? undefined;
  // The chosen program may have been picked in a dialog rather than found on PATH; it is offered too.
  const programs = [...(found ?? [])];
  if (engine && !programs.some((f) => f.binary === engine.binary)) programs.push({ kind: engine.kind, label: state?.label ?? engine.kind, binary: engine.binary, models: [] });
  const current = programs.find((f) => f.binary === engine?.binary);
  const models = [...(current?.models ?? [])];
  if (engine?.model && !models.includes(engine.model)) models.push(engine.model);
  const choose = (binary: string, model?: string) => {
    const f = programs.find((p) => p.binary === binary);
    if (f) change({ engine: { kind: f.kind, binary, model: model ?? (binary === engine?.binary ? engine.model : f.models[0]) ?? null } });
  };
  // A downloaded size runs with whisper.cpp: the chosen one, or else the first found.
  const cpp = engine?.kind === "whisper-cpp" ? engine.binary : found?.find((f) => f.kind === "whisper-cpp")?.binary;
  const where = (on: boolean) => on !== (route.primary === "local") && change({ onThisComputer: on });
  const backup = (on: boolean) => on !== route.backup && change({ backup: on });
  const busy = test?.phase === "recording" || test?.phase === "transcribing";
  const hermesStt = serverSetup && sttProvider({ ...serverSetup, sttLocal: undefined });

  const radios = (label: string, items: readonly (readonly [boolean, string])[], on: boolean, pick: (v: boolean) => void) => (
    <div
      className="out-scopes"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) =>
        arrowSelect(
          e,
          items.map(([v]) => v),
          on,
          pick,
        )
      }
    >
      {items.map(([v, name]) => (
        <button key={name} role="radio" aria-checked={on === v} tabIndex={on === v ? 0 : -1} className={`out-scope ${on === v ? "on" : ""}`} onClick={() => pick(v)}>
          {name}
        </button>
      ))}
    </div>
  );

  return (
    <SettingsSection
      title="Speech to text"
      intro="Where Dictation and voice conversations turn what you say into text."
      more={
        <>
          <p>
            On the <b>Hermes server</b>, each recording goes to Hermes, which transcribes it with the profile's speech-to-text provider under Speech
            providers, below, and deletes its copy once it has the text. A cloud provider gets the recording too.
          </p>
          <p>
            On <b>this computer</b>, Hermes Chat runs a speech-to-text engine here: whisper.cpp (whisper-cli), faster-whisper (whisper-ctranslate2),
            OpenAI Whisper or Vosk, with a model you already have, or a Whisper model downloaded here for whisper.cpp from whisper.cpp's own repository
            and checked against its published checksum. The recording is written to a private temporary folder, transcribed, and deleted; it never
            leaves this computer, and only the text goes to Hermes, when you send it. Dictation works without a connection to Hermes then.
          </p>
          <p>
            With a <b>backup</b>, the other one transcribes the same recording if the first can't: Hermes isn't reachable, its provider fails, the
            engine here can't run, or it takes longer than the time you set. The chat then says which one did it and why. A backup on Hermes means the
            recording can leave this computer when this computer fails. This choice is kept on this computer, for every connection and profile.
          </p>
        </>
      }
    >
      {error && (
        <SettingNote tone="bad" role="alert">
          {error}
        </SettingNote>
      )}
      {!state ? (
        !error && (
          <SettingNote>
            <Spinner /> Reading the speech-to-text setting…
          </SettingNote>
        )
      ) : (
        <>
          <SettingRow
            name="Where it runs"
            hint={
              route.primary === "local"
                ? route.backup
                  ? "Transcribed here first. Only the text goes to Hermes, unless this computer can't: then the recording does."
                  : "The recording never leaves this computer. Only the text goes to Hermes."
                : "Recordings go to Hermes, which transcribes them."
            }
            control={radios("Where speech to text runs", [[false, "Hermes server"], [true, "This computer"]] as const, route.primary === "local", where)}
          >
            {route.primary === "local" && state.problem && (
              <SettingNote tone="warn" role="status">
                {state.problem}{" "}
                {route.backup
                  ? "Until then, Hermes, the backup, transcribes each recording."
                  : "Until then, Dictation and voice conversations can't transcribe; nothing is sent to Hermes instead."}
              </SettingNote>
            )}
          </SettingRow>
          <SettingRow
            name="Backup"
            hint={
              route.backup
                ? route.primary === "local"
                  ? "If this computer can't, the recording goes to Hermes instead."
                  : "If Hermes can't, this computer transcribes it instead."
                : "If it can't transcribe, Dictation says why and keeps the recording to try again."
            }
            control={radios("Backup speech to text", [[false, "None"], [true, SIDE_LABEL[other(route.primary)]]] as const, route.backup, backup)}
          />
          {route.backup && (
            <SettingRow
              name="Switch to the backup after"
              nameId="stt-timeout"
              hint={`If ${route.primary === "local" ? "this computer" : "Hermes"} hasn't answered by then, the backup transcribes the recording and a late answer is dropped.`}
              control={
                <select className="select" aria-labelledby="stt-timeout" value={route.timeoutSeconds} onChange={(e) => change({ timeoutSeconds: Number(e.target.value) })}>
                  {(STT_TIMEOUTS as readonly number[]).includes(route.timeoutSeconds) ? null : <option value={route.timeoutSeconds}>{route.timeoutSeconds} seconds</option>}
                  {STT_TIMEOUTS.map((t) => (
                    <option key={t} value={t}>
                      {t} seconds
                    </option>
                  ))}
                </select>
              }
            />
          )}
          {inRoute(route, "server") && (
            <SettingRow
              name="On Hermes"
              hint={
                !connected
                  ? "Connect to Hermes to see the profile's provider."
                  : hermesStt
                    ? `${hermesStt.needs} Pick the provider and its model under Speech providers, below.`
                    : "Reading the profile's provider…"
              }
              control={hermesStt && connected ? <span className="badge">{hermesStt.label}</span> : undefined}
            />
          )}
          {here &&
            (!found ? (
              <SettingNote>
                <Spinner /> Looking for speech-to-text engines on this computer…
              </SettingNote>
            ) : (
              <>
                <SettingRow
                  name="Engine"
                  hint={
                    current ? (
                      <>
                        <span className="mono">{current.binary}</span>
                        {current.version ? ` · ${current.version}` : ""}
                      </>
                    ) : programs.length ? (
                      "Pick one of the engines found."
                    ) : (
                      "None installed."
                    )
                  }
                  control={
                    <>
                      {programs.length > 0 && (
                        <select aria-label="Engine" value={engine?.binary ?? ""} onChange={(e) => choose(e.target.value)}>
                          {!engine && <option value="">Choose…</option>}
                          {programs.map((p) => (
                            <option key={p.binary} value={p.binary}>
                              {p.label} ({baseName(p.binary)})
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="btn" onClick={() => act(api.pickProgram())} title="Point at an engine's program, such as whisper-cli">
                        <FolderOpen size={13} aria-hidden /> Choose a program…
                      </button>
                    </>
                  }
                />
                {engine && (
                  <SettingRow
                    name="Model"
                    hint={engine.model ? <span className="mono">{engine.model}</span> : models.length ? "Pick a model." : "No model was found in the usual folders."}
                    control={
                      <>
                        {models.length > 0 && (
                          <select aria-label="Model" value={engine.model ?? ""} onChange={(e) => choose(engine.binary, e.target.value)}>
                            {!engine.model && <option value="">Choose…</option>}
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {baseName(m)}
                              </option>
                            ))}
                          </select>
                        )}
                        <button className="btn" onClick={() => act(api.pickModel())}>
                          <FolderOpen size={13} aria-hidden /> Choose a model…
                        </button>
                      </>
                    }
                  />
                )}
                {!programs.length && (
                  <SettingNote>
                    None installed. Install one, then open this tab again: for example whisper.cpp (<span className="mono">whisper-cli</span>; on Arch,
                    the <span className="mono">whisper.cpp</span> package) and download a model below. Or point at a program and model you already have
                    with Choose a program.
                  </SettingNote>
                )}
                {route.primary !== "local" && state.problem && programs.length > 0 && (
                  <SettingNote tone="warn" role="status">
                    {state.problem} Until then, the backup on this computer can't transcribe.
                  </SettingNote>
                )}
                <SettingRow
                  name="Language"
                  nameId="stt-language"
                  hint="What you'll speak, for the Whisper engines. Detect it works for any language, a little slower."
                  control={
                    <select className="select" aria-labelledby="stt-language" value={state.language ?? "auto"} onChange={(e) => change({ language: e.target.value })}>
                      {LANGUAGES.some((l) => l.code === (state.language ?? "auto")) ? null : <option value={state.language}>{state.language}</option>}
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  }
                />
                {downloads?.models.map((m) => {
                  const inUse = engine?.model === m.path;
                  const p = progress?.name === m.name ? progress : downloads.downloading?.name === m.name ? downloads.downloading : undefined;
                  const anyDownload = !!progress || !!downloads.downloading;
                  return (
                    <SettingRow
                      key={m.name}
                      className="stt-model"
                      name={
                        <>
                          Whisper <span className="mono">{m.name}</span>
                          {inUse && <span className="badge">In use</span>}
                        </>
                      }
                      about={`the ${m.name} model`}
                      hint={`${formatBytes(m.bytes)} · ${MODEL_NOTES[m.name] ?? ""} · ${m.downloaded ? "Downloaded" : "Not downloaded"}`}
                      control={
                        <div className="stt-actions">
                          {m.downloaded && !inUse && (
                            <button
                              className="btn"
                              disabled={!cpp}
                              title={cpp ? undefined : "Install whisper.cpp, or choose its whisper-cli program, first"}
                              onClick={() => cpp && change({ engine: { kind: "whisper-cpp", binary: cpp, model: m.path } })}
                              aria-label={`Use the ${m.name} model`}
                            >
                              Use
                            </button>
                          )}
                          {p ? (
                            <button className="btn" onClick={() => void api.cancelDownload()} aria-label={`Cancel the ${m.name} download`}>
                              <X size={13} aria-hidden /> Cancel
                            </button>
                          ) : m.downloaded ? (
                            <button className="btn" onClick={() => actModels(api.remove(m.name))} aria-label={`Delete the ${m.name} model`}>
                              <Trash2 size={13} aria-hidden /> Delete
                            </button>
                          ) : (
                            <button className="btn" disabled={anyDownload} onClick={() => download(m.name)} aria-label={`Download the ${m.name} model`}>
                              <Download size={13} aria-hidden /> Download
                            </button>
                          )}
                        </div>
                      }
                    >
                      {p && (
                        <div className="stt-progress" role="progressbar" aria-label={`Downloading the ${m.name} model`} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
                          <span style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} />
                          <small>
                            {formatBytes(p.done)} of {formatBytes(p.total)}
                          </small>
                        </div>
                      )}
                    </SettingRow>
                  );
                })}
                {downloads && <SettingRow name="Downloads kept in" hint={<span className="mono">{downloads.dir}</span>} />}
              </>
            ))}
          <SettingRow
            name="Test"
            hint={`Records ${TEST_SECONDS} seconds, then has each side that may get it transcribe it, and shows what each heard and how long it took.`}
            control={
              busy ? (
                <button className="btn" onClick={stopTest}>
                  <X size={13} aria-hidden /> Cancel
                </button>
              ) : (
                <button className="btn" disabled={!transcribe} onClick={() => void runTest()}>
                  <Mic size={13} aria-hidden /> Test
                </button>
              )
            }
          >
            {test?.phase === "recording" && (
              <SettingNote role="status">
                <span className="rec-dot" aria-hidden /> Recording… say something.
              </SettingNote>
            )}
            {(test?.phase === "transcribing" || test?.phase === "done") && (
              <div className="stt-test" role="status">
                {test.tried.map((t) => (
                  <div key={t.side} className="stt-test-row">
                    <b>{SIDE_LABEL[t.side]}</b>
                    {t.running ? (
                      <span>
                        <Spinner /> Transcribing…
                      </span>
                    ) : t.error !== undefined ? (
                      <span className="bad">{t.error}</span>
                    ) : (
                      <span>{t.text ? `“${t.text}”` : "No speech was heard."}</span>
                    )}
                    {t.ms !== undefined && (
                      <span className="muted">
                        {(t.ms / 1000).toFixed(1)} s{t.by ? `, by ${t.by}` : ""}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {test?.phase === "failed" && (
              <SettingNote tone="bad" role="alert">
                {test.why}
              </SettingNote>
            )}
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}
