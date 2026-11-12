// @vitest-environment jsdom
// Settings → Voice → Speech to text (ADR 0065, 0067), against a stand-in for the Rust commands that follows their rules
// (fakeLocalStt.ts) and a stand-in microphone. Rust's own checks (only found or dialog-picked programs run, where a
// recording may go) are tested in src-tauri/src/local_stt.rs.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeLocalStt, WHISPER_CLI } from "../hermes/fakeLocalStt";
import type { FoundEngine } from "../hermes/localStt";
import { DEFAULT_STT_PREFS, sttRoute, type HeardTranscript, type SttSide } from "../hermes/sttRoute";
import { LocalSttSettings, TEST_SECONDS } from "./LocalSttSettings";
import type { AudioEnv } from "./recorder";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sttRoute.set(DEFAULT_STT_PREFS);
});

const WHISPER: FoundEngine = {
  kind: "whisper-cpp",
  label: "whisper.cpp",
  binary: WHISPER_CLI,
  version: "whisper.cpp version: 1.9.5",
  models: ["/home/o/.local/share/whisper.cpp/ggml-base.en.bin", "/home/o/.local/share/whisper.cpp/ggml-small.bin"],
};

function fake(found: FoundEngine[] = [WHISPER]) {
  const api = new FakeLocalStt();
  api.found = found;
  vi.spyOn(api, "detect");
  return api;
}

/**
 * A microphone, a new track each time; `track` is the last, `tracks` all of them. `hang`: the audio system never
 * finishes starting (`resume()` stays pending).
 */
function fakeMic(hang = false) {
  const tracks: { stopped: boolean; onended: null | (() => void) }[] = [];
  const newTrack = () => {
    const track = { stopped: false, readyState: "live", onended: null as null | (() => void), stop: () => void (track.stopped = true) };
    tracks.push(track);
    return track;
  };
  const env: AudioEnv = {
    mediaDevices: {
      getUserMedia: async () => {
        const track = newTrack();
        return { getAudioTracks: () => [track], getTracks: () => [track] } as never;
      },
    },
    makeContext: () =>
      ({
        sampleRate: 16_000,
        state: hang ? "suspended" : "running",
        resume: () => new Promise(() => {}),
        destination: {},
        createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
        createScriptProcessor: () => ({ onaudioprocess: null, connect: () => {}, disconnect: () => {} }),
        close: async () => {},
      }) as never,
  };
  return {
    env,
    tracks,
    get track() {
      return tracks[tracks.length - 1];
    },
  };
}

const radio = (group: string, name: string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

describe("Speech to text: where it runs", () => {
  it("starts on the Hermes server, and This computer lists the engines found with their version and path", async () => {
    const api = fake();
    render(<LocalSttSettings api={api} status="connected" />);
    expect((await screen.findByRole("radiogroup", { name: "Where speech to text runs" }), radio("Where speech to text runs", "Hermes server"))).toHaveProperty("ariaChecked", "true");
    expect(api.detect).not.toHaveBeenCalled();

    await userEvent.click(radio("Where speech to text runs", "This computer"));
    expect(api.sets).toEqual([{ onThisComputer: true }]);
    expect(await screen.findByText("The recording never leaves this computer. Only the text goes to Hermes.")).toBeTruthy();
    expect(sttRoute.get()).toEqual({ primary: "local", backup: false, timeoutSeconds: 30 });
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Engine" }), WHISPER.binary);
    // The first model found is taken until the owner picks another.
    expect(api.sets[1]).toEqual({ engine: { kind: "whisper-cpp", binary: WHISPER.binary, model: WHISPER.models[0] } });
    expect(await screen.findByText(WHISPER_CLI)).toBeTruthy();
    expect(screen.getByText(/1\.9\.5/)).toBeTruthy();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), WHISPER.models[1]);
    expect(api.sets[2]).toEqual({ engine: { kind: "whisper-cpp", binary: WHISPER.binary, model: WHISPER.models[1] } });

    await userEvent.click(radio("Where speech to text runs", "Hermes server"));
    expect(api.sets[3]).toEqual({ onThisComputer: false });
    expect(await screen.findByText("Recordings go to Hermes, which transcribes them.")).toBeTruthy();
    expect(sttRoute.get().primary).toBe("server");
  });

  it("says None installed with a how-to when nothing is found, and still offers Choose a program", async () => {
    const api = fake([]);
    api.route({ primary: "local" });
    render(<LocalSttSettings api={api} status="connected" />);
    expect(await screen.findByText(/None installed\. Install one/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose a program/ })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Engine" })).toBeNull();
  });

  it("says why a chosen engine can't run, and that nothing goes to Hermes instead, or that the backup does", async () => {
    const api = fake();
    api.route({ primary: "local" });
    api.choice.engine = { kind: "whisper-cpp", binary: "/opt/whisper-cli", model: api.modelPath("small") };
    render(<LocalSttSettings api={api} status="connected" />);
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/isn't there any more\. .*nothing is sent to Hermes instead/);
    // A program picked in a dialog, not on PATH, is still listed as the one in use.
    expect(((await screen.findByRole("combobox", { name: "Engine" })) as HTMLSelectElement).value).toBe("/opt/whisper-cli");

    await userEvent.click(radio("Backup speech to text", "Hermes server"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/isn't there any more\. Until then, Hermes, the backup, transcribes each recording/));
    // With Hermes as backup, the recording can leave this computer, and the hint says so.
    expect(screen.queryByText(/The recording never leaves this computer/)).toBeNull();
    expect(screen.getByText(/unless this computer can't: then the recording does/)).toBeTruthy();
  });

  it("sets the backup and its time, says where the recording goes, and names the provider on Hermes", async () => {
    const api = fake();
    const setup = async () => ({ transcribe: true, speak: true, sttProvider: "local" });
    render(<LocalSttSettings api={api} status="connected" setup={setup} />);
    (await screen.findByRole("radiogroup", { name: "Where speech to text runs" }), radio("Where speech to text runs", "Hermes server"));
    expect(screen.queryByLabelText("Switch to the backup after")).toBeNull();
    await userEvent.click(radio("Backup speech to text", "This computer"));
    expect(api.sets).toEqual([{ backup: true }]);
    expect(await screen.findByText("If Hermes can't, this computer transcribes it instead.")).toBeTruthy();
    // The backup here needs setting up, so its engine shows.
    expect(await screen.findByRole("combobox", { name: "Engine" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Switch to the backup after"), "60");
    await waitFor(() => expect(sttRoute.get()).toEqual({ primary: "server", backup: true, timeoutSeconds: 60 }));
    expect(await screen.findByText("Local Whisper")).toBeTruthy();
    expect(screen.getByText(/Pick the provider and its model under Speech providers, below/)).toBeTruthy();
  });

  it("shows Rust's refusal and keeps what was read back", async () => {
    const api = fake();
    api.route({ backup: true });
    api.set = async () => {
      throw new Error("The speech-to-text setting in /x/local-stt.json can't be read: expected value");
    };
    render(<LocalSttSettings api={api} status="connected" />);
    await screen.findByRole("radiogroup", { name: "Where speech to text runs" });
    await userEvent.click(radio("Where speech to text runs", "This computer"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't be read/);
    expect(radio("Where speech to text runs", "Hermes server")).toHaveProperty("ariaChecked", "true");
  });
});

describe("Speech to text: Whisper models for whisper.cpp", () => {
  it("downloads a size with its progress, uses it, picks the language, and deletes it", async () => {
    const api = fake();
    api.route({ primary: "local" });
    let finish!: () => void;
    api.downloadGate = new Promise((r) => (finish = r));
    render(<LocalSttSettings api={api} status="connected" />);
    await userEvent.click(await screen.findByRole("button", { name: "Download the base model" }));
    const bar = await screen.findByRole("progressbar", { name: "Downloading the base model" });
    expect(bar.textContent).toMatch(/71 MB of 141 MB/);
    // One download at a time.
    expect((screen.getByRole("button", { name: "Download the tiny model" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await userEvent.click(await screen.findByRole("button", { name: "Use the base model" }));
    await waitFor(() => expect(screen.getByText("In use").closest(".set-row")!.textContent).toMatch(/base/));
    expect(api.sets.at(-1)).toEqual({ engine: { kind: "whisper-cpp", binary: WHISPER_CLI, model: api.modelPath("base") } });
    expect(api.snapshot().problem).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Language"), "es");
    await waitFor(() => expect(api.choice.language).toBe("es"));
    expect(screen.getByLabelText<HTMLSelectElement>("Language").value).toBe("es");

    await userEvent.click(screen.getByRole("button", { name: "Delete the base model" }));
    await screen.findByRole("button", { name: "Download the base model" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/isn't there any more/));
    expect(screen.getByText(api.dir)).toBeTruthy();
  });

  it("keeps a newer Backup choice when the re-read after a delete answers late", async () => {
    const api = fake();
    api.route({ primary: "local" });
    api.useModel("base");
    render(<LocalSttSettings api={api} status="connected" />);
    await screen.findByRole("button", { name: "Delete the base model" });
    // The re-read after the delete is slow, and answers what it read: no backup.
    let release: (() => void) | undefined;
    api.state = () => {
      const then = api.snapshot();
      return new Promise((r) => (release = () => r(then)));
    };
    await userEvent.click(screen.getByRole("button", { name: "Delete the base model" }));
    await waitFor(() => expect(release).toBeDefined());
    await userEvent.click(radio("Backup speech to text", "Hermes server"));
    await screen.findByText(/unless this computer can't: then the recording does/);
    await act(async () => release!());
    expect(screen.getByText(/unless this computer can't: then the recording does/)).toBeTruthy();
    expect(screen.queryByText(/The recording never leaves this computer/)).toBeNull();
    expect(sttRoute.get()).toEqual({ primary: "local", backup: true, timeoutSeconds: 30 });
  });

  it("can't use a downloaded size until there's a whisper.cpp program", async () => {
    const api = fake([]);
    api.route({ primary: "local" });
    api.downloaded.add("tiny");
    render(<LocalSttSettings api={api} status="connected" />);
    const use = (await screen.findByRole("button", { name: "Use the tiny model" })) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    expect(use.title).toMatch(/Install whisper\.cpp/);
  });

  it("keeps showing a download started before Settings was left and opened again, until it ends", async () => {
    const api = fake();
    api.route({ primary: "local" });
    let finish!: () => void;
    api.downloadGate = new Promise((r) => (finish = r));
    const first = render(<LocalSttSettings api={api} status="connected" />);
    await userEvent.click(await screen.findByRole("button", { name: "Download the base model" }));
    await screen.findByRole("progressbar");
    first.unmount();
    render(<LocalSttSettings api={api} status="connected" />);
    await screen.findByRole("progressbar", { name: "Downloading the base model" });
    finish();
    await screen.findByRole("button", { name: "Delete the base model" }, { timeout: 4000 });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("Speech to text: Test", () => {
  /** Answers per side, as Rust would for a Test of one side. */
  const sides = (answers: Partial<Record<SttSide, HeardTranscript | Error>>) =>
    vi.fn(async (_audio: Uint8Array, _mime: string, side?: SttSide) => {
      const a = answers[side!];
      if (a instanceof Error) throw a;
      return a ?? { text: "" };
    });

  it(`records ${TEST_SECONDS} s, has each side in the route transcribe it, and shows the text and time`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake();
    api.route({ primary: "local", backup: true });
    const mic = fakeMic();
    const transcribe = sides({ local: { text: "hello there", provider: "whisper.cpp" }, server: { text: "hello there!", provider: "groq" } });
    render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }), { advanceTimers: vi.advanceTimersByTime });
    expect(await screen.findByText(/Recording… say something/)).toBeTruthy();
    expect(transcribe).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    await waitFor(() => expect(screen.getAllByText(/^“hello there!?”$/)).toHaveLength(2));
    // This computer first, as it is the primary; each on its own.
    expect(transcribe.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["audio/wav", "local"],
      ["audio/wav", "server"],
    ]);
    const rows = [...document.querySelectorAll(".stt-test-row")].map((r) => r.textContent);
    expect(rows[0]).toMatch(/^This computer“hello there”.* s, by whisper\.cpp$/);
    expect(rows[1]).toMatch(/^Hermes server“hello there!”.* s, by groq$/);
    expect(mic.track.stopped).toBe(true);
  });

  it("never sends the recording to Hermes when this computer is alone, and says why the engine failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake();
    api.route({ primary: "local" });
    const transcribe = sides({ local: new Error("whisper.cpp exited with 3: failed to load model") });
    render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={fakeMic().env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }), { advanceTimers: vi.advanceTimersByTime });
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    expect(await screen.findByText("whisper.cpp exited with 3: failed to load model")).toBeTruthy();
    expect(screen.getByText(/Not tried: with This computer and no backup, recordings never go to Hermes/)).toBeTruthy();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("tries this computer even while Hermes is offline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake();
    const transcribe = sides({ local: { text: "offline" } });
    render(<LocalSttSettings api={api} status="offline" transcribe={transcribe} env={fakeMic().env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }), { advanceTimers: vi.advanceTimersByTime });
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    expect(await screen.findByText("“offline”")).toBeTruthy();
    expect(screen.getByText("Not tried: not connected to Hermes.")).toBeTruthy();
  });

  it("closes the microphone when the tab closes mid-test", async () => {
    const api = fake([]);
    const mic = fakeMic();
    const transcribe = vi.fn();
    const view = render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }));
    await screen.findByText(/Recording… say/);
    view.unmount();
    expect(mic.track.stopped).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("closes a Test's microphone when the setting changes, so a second Test can't leave the first one open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake([]);
    const mic = fakeMic();
    const transcribe = sides({ local: { text: "second" } });
    const view = render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    const click = (el: HTMLElement) => userEvent.click(el, { advanceTimers: vi.advanceTimersByTime });
    await click(await screen.findByRole("button", { name: /^Test$/ }));
    await screen.findByText(/Recording… say/);
    await click(radio("Where speech to text runs", "This computer"));
    expect(mic.tracks[0].stopped).toBe(true);
    await click(await screen.findByRole("button", { name: /^Test$/ }));
    await screen.findByText(/Recording… say/);
    expect(mic.tracks).toHaveLength(2);
    // The first Test's timer firing changes nothing; only the second is transcribed.
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    await waitFor(() => expect(screen.getByText(/“second”/)).toBeTruthy());
    expect(transcribe).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mic.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("closes a microphone that is still starting when the tab closes", async () => {
    const api = fake([]);
    const mic = fakeMic(true);
    const transcribe = vi.fn();
    const view = render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }));
    await waitFor(() => expect(mic.tracks).toHaveLength(1));
    expect(screen.queryByText(/Recording… say/)).toBeNull();
    view.unmount();
    expect(mic.track.stopped).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("stops the Test when the microphone is unplugged, and doesn't transcribe what was dropped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake([]);
    const mic = fakeMic();
    const transcribe = vi.fn(async () => ({ text: "" }));
    render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }), { advanceTimers: vi.advanceTimersByTime });
    await screen.findByText(/Recording… say/);
    act(() => mic.track.onended?.());
    expect((await screen.findByRole("alert")).textContent).toMatch(/disconnected/);
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    expect(transcribe).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/disconnected/);
  });

  it("stops the transcription on its way, in Rust too, when cancelled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fake();
    const signals: AbortSignal[] = [];
    const transcribe = vi.fn((_a: Uint8Array, _m: string, _side?: SttSide, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<HeardTranscript>(() => {});
    });
    render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={fakeMic().env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }), { advanceTimers: vi.advanceTimersByTime });
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    await screen.findAllByText(/Transcribing…/);
    expect(signals[0].aborted).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }), { advanceTimers: vi.advanceTimersByTime });
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryAllByText(/Transcribing…/)).toHaveLength(0);
  });

  it("can be cancelled while it records, closing the microphone", async () => {
    const api = fake([]);
    const mic = fakeMic();
    const transcribe = vi.fn();
    render(<LocalSttSettings api={api} status="connected" transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Test$/ }));
    await screen.findByText(/Recording… say/);
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(mic.track.stopped).toBe(true);
    expect(screen.queryByText(/Recording… say/)).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
