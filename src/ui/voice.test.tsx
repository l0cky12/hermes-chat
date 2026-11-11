// @vitest-environment jsdom
// Dictation and Read aloud through the signed-in app, against a fake Hermes. The microphone and the audio element are
// stand-ins (jsdom has neither); everything from the composer to what Hermes receives is the real code. Each test
// checks what reached Hermes and what the owner sees, and that the microphone and audio are let go of.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { FakeLocalStt } from "../hermes/fakeLocalStt";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { Speaker } from "./speaker";
import { setWindowHidden } from "./windowState";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

/** A stand-in microphone: `getUserMedia` either fails with `fail` or opens one track, and `say` feeds it samples. */
class FakeMic {
  fail?: string;
  /** The audio system never finishes starting: `resume()` hangs. */
  hang = false;
  readonly track = {
    stopped: false,
    readyState: "live" as MediaStreamTrackState,
    onended: null as null | (() => void),
    stop: () => void (this.track.stopped = true),
  };
  /** Releases a `hang`ing `resume()`. */
  resumed?: () => void;
  opened = 0;
  context?: { closed: boolean };
  private processor?: { onaudioprocess: null | ((e: unknown) => void) };

  install() {
    const mic = this;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (c: MediaStreamConstraints) => {
          mic.opened++;
          expect(c).toMatchObject({ audio: expect.anything() });
          expect(c.video).toBeUndefined();
          if (mic.fail) throw new DOMException("refused", mic.fail);
          return { getAudioTracks: () => [mic.track], getTracks: () => [mic.track] };
        },
      },
    });
    globalThis.AudioContext = class {
      sampleRate = 48_000;
      state = mic.hang ? "suspended" : "running";
      destination = {};
      closed = false;
      constructor() {
        mic.context = this;
      }
      createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
      createScriptProcessor = () => (mic.processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} } as never);
      resume = () => (mic.hang ? new Promise<void>((r) => (mic.resumed = r)) : Promise.resolve());
      close = async () => void (this.closed = true);
    } as unknown as typeof AudioContext;
  }

  /** `seconds` of a tone, as the processor gets it, 4096 samples at a time. */
  say(seconds: number) {
    const n = Math.ceil((seconds * 48_000) / 4096);
    for (let i = 0; i < n; i++) {
      const data = Float32Array.from({ length: 4096 }, (_, j) => Math.sin((i * 4096 + j) / 8) * 0.3);
      act(() => this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } }));
    }
  }

  get closed() {
    return this.track.stopped && !!this.context?.closed;
  }
}

let mic: FakeMic;
const played = { play: vi.fn(async () => {}), pause: vi.fn(), revoked: [] as string[], made: [] as Blob[] };

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0) as unknown as number;
  window.HTMLMediaElement.prototype.play = function () {
    return played.play();
  };
  window.HTMLMediaElement.prototype.pause = function () {
    played.pause();
  };
  window.HTMLMediaElement.prototype.load = () => {};
  URL.createObjectURL = (b: Blob) => (played.made.push(b), `blob:audio-${played.made.length}`);
  URL.revokeObjectURL = (u: string) => void played.revoked.push(u);
});
beforeEach(() => {
  mic = new FakeMic();
  mic.install();
  played.play.mockReset().mockImplementation(async () => {});
  played.pause.mockReset();
  played.revoked = [];
  played.made = [];
});
afterEach(() => {
  act(() => setWindowHidden(false));
  cleanup();
  localStorage.clear();
});

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

let signIns = 0;

/** Signed in with one Active chat that has a reply, the New chat pane on screen. Each sign-in has its own drafts. */
async function signedIn(server = new FakeHermes(), localStt = new FakeLocalStt()) {
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was **locked**." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
  };
  const hermes = await connect(server.openPipe);
  // Rust reaches the connected Hermes for the server side, as `hermes_transcribe` does.
  localStt.server = (audio, mime) => hermes.transcribe(audio, mime);
  const user = userEvent.setup();
  render(
    <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: `liam${++signIns}` }} onSignOut={async () => {}} localStt={localStt} />,
  );
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user, localStt };
}

const dictate = () => screen.getByRole("button", { name: "Dictate" });

/** Starts a recording and waits for the strip to say so. */
async function record(user: ReturnType<typeof userEvent.setup>) {
  await user.click(dictate());
  return screen.findByRole("status", { name: "Recording" });
}

describe("Dictation", () => {
  it("releases the microphone and drops pending transcripts when focus moves to another mounted pane", async () => {
    const { server, user, hermes } = await signedIn();
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    await user.click(within(left).getByRole("button", { name: "Dictate" }));
    await within(left).findByRole("status", { name: "Recording" });
    await user.click(within(right).getByPlaceholderText("Message Hermes"));
    expect(mic.closed).toBe(true);
    expect(within(left).queryByRole("status", { name: "Recording" })).toBeNull();
    expect(document.activeElement).toBe(within(right).getByPlaceholderText("Message Hermes"));

    let release!: () => void;
    server.voiceGate = new Promise((resolve) => { release = resolve; });
    mic = new FakeMic();
    mic.install();
    await user.click(within(left).getByRole("button", { name: "Dictate" }));
    await within(left).findByRole("status", { name: "Recording" });
    mic.say(1);
    await user.click(within(left).getByRole("button", { name: /Done/ }));
    await user.click(within(right).getByPlaceholderText("Message Hermes"));
    release();
    await settle(hermes);
    expect(within(left).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("");
    expect(within(right).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("");
    expect(document.activeElement).toBe(within(right).getByPlaceholderText("Message Hermes"));
  });

  it("records until Done, then puts what Hermes heard after the typed text, and closes the microphone", async () => {
    const { server, user, hermes } = await signedIn();
    await user.type(composer(), "Hi.");
    const strip = await record(user);
    expect(within(strip).getByText("Recording")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    mic.say(2);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(composer().value).toBe("Hi. Check the backup logs"));
    await settle(hermes);

    expect(server.recordings).toHaveLength(1);
    const { audio, mime, profile } = server.recordings[0];
    expect([mime, profile]).toEqual(["audio/wav", "default"]);
    expect(String.fromCharCode(...audio.slice(0, 4))).toBe("RIFF");
    // About two seconds at 16 kHz, 16-bit: the 4096-sample blocks round it up a little.
    expect(audio.length).toBeGreaterThan(64_000);
    expect(audio.length).toBeLessThan(70_000);
    expect(mic.closed).toBe(true);
    // Nothing was sent to the chat: the owner edits the text first.
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    expect(document.activeElement).toBe(composer());
  });

  it("closes the microphone and drops the recording when the window is hidden to the tray, keeping the typed draft", async () => {
    const { server, user, hermes } = await signedIn();
    await user.type(composer(), "Hi.");
    await record(user);
    mic.say(2);
    act(() => setWindowHidden(true));
    expect(mic.closed).toBe(true);
    expect(screen.queryByRole("status", { name: "Recording" })).toBeNull();
    act(() => setWindowHidden(false));
    await settle(hermes);
    // Nothing went to Hermes to transcribe, and the draft is as typed.
    expect(server.recordings).toEqual([]);
    expect(composer().value).toBe("Hi.");
  });

  it("drops the recording on Cancel or Esc, sending nothing", async () => {
    const { server, user } = await signedIn();
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(mic.closed).toBe(true);
    expect(screen.queryByRole("status", { name: "Recording" })).toBeNull();

    mic = new FakeMic();
    mic.install();
    await record(user);
    mic.say(1);
    await user.keyboard("{Escape}");
    expect(mic.closed).toBe(true);
    expect(server.recordings).toEqual([]);
    expect(composer().value).toBe("");
  });

  it("shows how long it has recorded", async () => {
    const { user } = await signedIn();
    const strip = await record(user);
    mic.say(7.5);
    await waitFor(() => expect(within(strip).getByText("0:07 / 5:00")).toBeTruthy());
  });

  it.each([
    ["NotAllowedError", /wasn't allowed to use the microphone/],
    ["NotFoundError", /No microphone was found/],
    ["NotReadableError", /Another app may be using it/],
  ])("says why when the microphone fails with %s", async (name, said) => {
    const { server, user } = await signedIn();
    mic.fail = name;
    await user.click(dictate());
    expect((await screen.findByRole("alert")).textContent).toMatch(said);
    expect(screen.queryByRole("status", { name: "Recording" })).toBeNull();
    expect(server.recordings).toEqual([]);
    // It can be tried again once fixed.
    mic.fail = undefined;
    await record(user);
  });

  it("says so when the window has no audio capture at all", async () => {
    const { user } = await signedIn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    await user.click(dictate());
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't use a microphone/);
  });

  it("drops the recording when the microphone goes away mid-recording", async () => {
    const { server, user } = await signedIn();
    await record(user);
    mic.say(1);
    act(() => mic.track.onended?.());
    expect((await screen.findByRole("alert")).textContent).toMatch(/microphone was disconnected/);
    expect(mic.closed).toBe(true);
    expect(server.recordings).toEqual([]);
  });

  it("keeps a recording Hermes couldn't transcribe, to try again without speaking it again", async () => {
    const { server, user } = await signedIn();
    server.heard = new Error("Can't reach the Hermes dashboard: connection reset");
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection reset/);
    expect(composer().value).toBe("");

    server.heard = "Restart the NAS";
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(composer().value).toBe("Restart the NAS"));
    expect(server.recordings).toHaveLength(2);
    expect(server.recordings[1].audio).toEqual(server.recordings[0].audio);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("can discard a recording Hermes couldn't transcribe", async () => {
    const { server, user } = await signedIn();
    server.heard = new Error("Hermes couldn't transcribe the recording: No STT provider available");
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Discard the recording" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when Hermes heard no speech, leaving the draft alone", async () => {
    const { server, user } = await signedIn();
    server.heard = "";
    await user.type(composer(), "Draft");
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Hermes heard no speech in the recording.Dismiss");
    expect(composer().value).toBe("Draft");
  });

  it("doesn't send a recording too short to hold a word", async () => {
    const { server, user } = await signedIn();
    await record(user);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/too short/);
    expect(server.recordings).toEqual([]);
  });

  it("can cancel while transcribing, and then the transcript is dropped", async () => {
    const { server, user, hermes } = await signedIn();
    let release!: () => void;
    server.voiceGate = new Promise((r) => (release = r));
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Transcribing 0:01 of audio/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    await settle(hermes);
    expect(composer().value).toBe("");
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });

  it("closes the microphone when the owner opens another chat, and drops a transcript still on its way", async () => {
    const { server, user, hermes } = await signedIn();
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(mic.closed).toBe(true);
    await screen.findByText(/restic repo/);

    let release!: () => void;
    server.voiceGate = new Promise((r) => (release = r));
    mic = new FakeMic();
    mic.install();
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    release();
    await settle(hermes);
    expect(composer().value).toBe("");
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(composer().value).toBe("");
  });

  it("closes the microphone at once when cancelled while the audio system is still starting", async () => {
    const { user } = await signedIn();
    mic.hang = true;
    await user.click(dictate());
    await screen.findByText("Waiting for the microphone…");
    await waitFor(() => expect(mic.opened).toBe(1));
    expect(mic.track.stopped).toBe(false);
    await user.keyboard("{Escape}");
    expect(mic.closed).toBe(true);
    expect(screen.queryByText("Waiting for the microphone…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the microphone is unplugged while the audio system is still starting", async () => {
    const { server, user } = await signedIn();
    mic.hang = true;
    await user.click(dictate());
    await screen.findByText("Waiting for the microphone…");
    await waitFor(() => expect(mic.resumed).toBeDefined());
    act(() => {
      mic.track.readyState = "ended";
      mic.track.onended?.();
    });
    await act(async () => mic.resumed!());
    expect((await screen.findByRole("alert")).textContent).toMatch(/disconnected before recording started/);
    expect(mic.closed).toBe(true);
    expect(screen.queryByRole("status", { name: "Recording" })).toBeNull();
    expect(server.recordings).toEqual([]);
  });

  it("cancels with Esc while transcribing, after Done took the focus with it", async () => {
    const { server, user, hermes } = await signedIn();
    let release!: () => void;
    server.voiceGate = new Promise((r) => (release = r));
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await screen.findByText(/Transcribing/);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    release();
    await settle(hermes);
    expect(composer().value).toBe("");
    expect(document.activeElement).toBe(composer());
  });

  it("stays with its profile: switching closes the microphone, and a transcript on its way is dropped", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    const { user, hermes } = await signedIn(server);
    await record(user);
    mic.say(1);
    await act(() => hermes.switchProfile("work"));
    await settle(hermes);
    expect(mic.closed).toBe(true);
    expect(screen.queryByRole("status", { name: "Recording" })).toBeNull();

    let release!: () => void;
    server.voiceGate = new Promise((r) => (release = r));
    mic = new FakeMic();
    mic.install();
    await waitFor(() => expect(dictate().getAttribute("aria-disabled")).toBe("false"));
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await screen.findByText(/Transcribing/);
    await act(() => hermes.switchProfile("default"));
    release();
    await settle(hermes);
    expect(composer().value).toBe("");
    expect(server.recordings.map((r) => r.profile)).toEqual(["work"]);
  });

  it("can't start on a server without transcription, or with speech-to-text off, and says why", async () => {
    const server = new FakeHermes();
    server.voice = { ...server.voice, transcribe: false };
    const { user } = await signedIn(server);
    await waitFor(() => expect(dictate().getAttribute("aria-disabled")).toBe("true"));
    expect(dictate().title).toMatch(/can't transcribe recordings/);
    await user.click(dictate());
    expect(mic.opened).toBe(0);
    cleanup();

    const off = new FakeHermes();
    off.voice = { ...off.voice, sttEnabled: false };
    await signedIn(off);
    await waitFor(() => expect(dictate().title).toMatch(/stt.enabled is false/));
  });

  it("can't start while offline", async () => {
    const { server, hermes } = await signedIn();
    server.refuse = "Can't reach the Hermes dashboard: connection refused";
    act(() => server.drop());
    await settle(hermes);
    await waitFor(() => expect(dictate().getAttribute("aria-disabled")).toBe("true"));
    expect(dictate().title).toMatch(/Connect to Hermes/);
  });
});

describe("Dictation, where speech-to-text runs (ADR 0065)", () => {
  it("transcribes on this computer when it is the primary: nothing goes to Hermes", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    localStt.heard = "Restart the NAS";
    localStt.route({ primary: "local", backup: false });
    const { server, user } = await signedIn(undefined, localStt);
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(composer().value).toBe("Restart the NAS"));
    expect(server.recordings).toHaveLength(0);
    expect(localStt.recordings).toHaveLength(1);
    expect(String.fromCharCode(...localStt.recordings[0].audio.slice(0, 4))).toBe("RIFF");
    // It came from the primary, so there's nothing to say.
    expect(screen.queryByRole("status", { name: "" })).toBeNull();
    expect(document.querySelector(".voice-note")).toBeNull();
  });

  it("falls back to this computer when Hermes's provider fails, and says which one transcribed it", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    localStt.heard = "Check the NAS";
    localStt.route({ primary: "server", backup: true });
    const server = new FakeHermes();
    server.heard = new Error("Hermes couldn't transcribe the recording: GROQ_API_KEY is not set");
    const { user } = await signedIn(server, localStt);
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(composer().value).toBe("Check the NAS"));
    expect(server.recordings).toHaveLength(1);
    expect(localStt.recordings).toHaveLength(1);
    expect(localStt.recordings[0].audio).toEqual(server.recordings[0].audio);
    const note = document.querySelector(".voice-note.info")!;
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toMatch(/^Transcribed on this computer\. Hermes couldn't transcribe it: GROQ_API_KEY is not set\./);
  });

  it("falls back to Hermes when this computer has no model, and keeps the recording when both fail", async () => {
    const localStt = new FakeLocalStt();
    localStt.route({ primary: "local", backup: true });
    const { server, user } = await signedIn(undefined, localStt);
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(composer().value).toBe("Check the backup logs"));
    expect(document.querySelector(".voice-note.info")!.textContent).toMatch(/^Transcribed on Hermes\. This computer couldn't transcribe it: No speech-to-text engine is chosen on this computer\./);

    server.heard = new Error("Can't reach the Hermes dashboard: connection reset");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/This computer couldn't transcribe it: No speech-to-text engine is chosen on this computer\. Hermes couldn't transcribe it either: Can't reach/);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("sends nothing to the backup once the owner cancels, even when this computer fails after", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    let release!: () => void;
    localStt.gate = new Promise((r) => (release = r));
    localStt.heard = new Error("whisper.cpp exited with code 1");
    localStt.route({ primary: "local", backup: true });
    const { server, user, hermes } = await signedIn(undefined, localStt);
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await screen.findByText(/Transcribing/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    await settle(hermes);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(localStt.recordings).toHaveLength(1);
    expect(server.recordings).toEqual([]);
    expect(composer().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("can start a voice conversation with Hermes's speech-to-text off when this computer transcribes", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    localStt.route({ primary: "local", backup: false });
    const server = new FakeHermes();
    server.voice = { ...server.voice, sttEnabled: false };
    const { user } = await signedIn(server, localStt);
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const start = await screen.findByRole("button", { name: /voice conversation/i });
    await waitFor(() => expect(start.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("can be started while Hermes is offline when this computer transcribes", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    localStt.route({ primary: "local", backup: false });
    const { server, hermes } = await signedIn(undefined, localStt);
    server.refuse = "Can't reach the Hermes dashboard: connection refused";
    act(() => server.drop());
    await settle(hermes);
    await waitFor(() => expect(screen.getAllByText(/Reconnecting|Disconnected|Offline|Can't reach/i).length).toBeGreaterThan(0));
    expect(dictate().getAttribute("aria-disabled")).toBe("false");
  });
});

describe("Read aloud", () => {
  async function inBackup(server?: FakeHermes) {
    const s = await signedIn(server);
    await s.user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await screen.findByText(/restic repo/);
    await settle(s.hermes);
    return s;
  }
  const readAloud = () => screen.getByRole("button", { name: /Read aloud/ });

  it("has Hermes speak the reply, plays it, and lets go of the audio once stopped", async () => {
    const { server, user } = await inBackup();
    await user.click(readAloud());
    await screen.findByRole("button", { name: "Stop" });
    expect(server.spoken).toEqual([{ profile: "default", text: "The restic repo was **locked**." }]);
    expect(played.play).toHaveBeenCalledOnce();
    expect(played.made[0].type).toBe("audio/mpeg");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(played.revoked).toEqual(["blob:audio-1"]);
    expect(readAloud().getAttribute("aria-pressed")).toBe("false");
  });

  it("is offered only on replies, not on the owner's messages", async () => {
    await inBackup();
    expect(screen.getAllByRole("button", { name: /Read aloud/ })).toHaveLength(1);
  });

  it("says why Hermes couldn't read it, and can be tried again", async () => {
    const server = new FakeHermes();
    server.speech = new Error("Hermes couldn't read it aloud: edge-tts is not installed");
    const { user } = await inBackup(server);
    await user.click(readAloud());
    expect((await screen.findByRole("alert")).textContent).toBe("Hermes couldn't read it aloud: edge-tts is not installed");
    server.speech = { mime: "audio/ogg", audio: new Uint8Array([1, 2, 3]) };
    await user.click(readAloud());
    await screen.findByRole("button", { name: "Stop" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when this computer can't play the audio", async () => {
    played.play.mockImplementation(async () => {
      throw new DOMException("no decoder", "NotSupportedError");
    });
    const { user } = await inBackup();
    await user.click(readAloud());
    expect((await screen.findByRole("alert")).textContent).toMatch(/audio couldn't start: no decoder/);
    expect(played.revoked).toEqual(["blob:audio-1"]);
  });

  it("is unavailable on a server without speech, and says why", async () => {
    const server = new FakeHermes();
    server.voice = { ...server.voice, speak: false };
    const { user } = await inBackup(server);
    await waitFor(() => expect(readAloud().getAttribute("aria-disabled")).toBe("true"));
    expect(readAloud().title).toMatch(/can't read replies aloud/);
    await user.click(readAloud());
    expect(server.spoken).toEqual([]);
  });

  it("stops and lets go of the audio when the owner opens another chat", async () => {
    const { user } = await inBackup();
    await user.click(readAloud());
    await screen.findByRole("button", { name: "Stop" });
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    expect(played.pause).toHaveBeenCalled();
    expect(played.revoked).toEqual(["blob:audio-1"]);
  });

  it("stops and lets go of the audio when the window is hidden to the tray", async () => {
    const { user } = await inBackup();
    await user.click(readAloud());
    await screen.findByRole("button", { name: "Stop" });
    act(() => setWindowHidden(true));
    expect(played.pause).toHaveBeenCalled();
    expect(played.revoked).toEqual(["blob:audio-1"]);
    act(() => setWindowHidden(false));
    expect(readAloud().getAttribute("aria-pressed")).toBe("false");
  });

  it("stops Read aloud when focus moves to another mounted pane", async () => {
    const { user } = await inBackup();
    await user.keyboard("{Control>}\\{/Control}");
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    await user.click(within(left).getByRole("button", { name: /Read aloud/ }));
    await within(left).findByRole("button", { name: "Stop" });
    await user.click(within(right).getByPlaceholderText("Message Hermes"));
    expect(played.revoked).toEqual(["blob:audio-1"]);
    expect(within(left).getByRole("button", { name: /Read aloud/ }).getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(within(right).getByPlaceholderText("Message Hermes"));
  });
});

describe("the speaker", () => {
  const player = () => ({ play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", onended: null, onerror: null });

  it("plays one reply at a time, dropping audio that arrives for one already replaced", async () => {
    const answers: ((a: { mime: string; audio: Uint8Array }) => void)[] = [];
    const players: ReturnType<typeof player>[] = [];
    const s = new Speaker(
      () => new Promise((r) => answers.push(r)),
      () => (players.push(player()), players[players.length - 1]) as never,
    );
    s.toggle("a", "first");
    s.toggle("b", "second");
    expect(s.of("a")).toBeUndefined();
    answers[0]({ mime: "audio/mpeg", audio: new Uint8Array([1]) });
    answers[1]({ mime: "audio/mpeg", audio: new Uint8Array([2]) });
    await vi.waitFor(() => expect(s.of("b")?.phase).toBe("playing"));
    expect(players).toHaveLength(1);
    expect(played.made).toHaveLength(1);
  });

  it("finishes by itself, letting go of the audio", async () => {
    const p = player();
    const s = new Speaker(async () => ({ mime: "audio/wav", audio: new Uint8Array([1]) }), () => p as never);
    s.toggle("a", "text");
    await vi.waitFor(() => expect(s.of("a")?.phase).toBe("playing"));
    (p.onended as unknown as () => void)();
    expect(s.of("a")).toBeUndefined();
    expect(played.revoked).toEqual(["blob:audio-1"]);
    expect(p.removeAttribute).toHaveBeenCalledWith("src");
  });
});

describe("Settings, Voice", () => {
  it("names the profile's providers and what they need", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("tab", { name: /Voice/ }));
    const section = (await screen.findByRole("heading", { name: "Voice" })).closest("section")!;
    await within(section).findByText("Local Whisper");
    expect(within(section).getByText("Microsoft Edge TTS")).toBeTruthy();
    expect(section.textContent).toMatch(/faster-whisper/);
    expect(section.textContent).toMatch(/edge-tts/);
  });

  it("says what isn't available on the server", async () => {
    const server = new FakeHermes();
    server.voice = { transcribe: false, speak: false };
    const { user } = await signedIn(server);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("tab", { name: /Voice/ }));
    const section = (await screen.findByRole("heading", { name: "Voice" })).closest("section")!;
    // Dictation, Read aloud, and the Voice conversation that needs them both.
    await waitFor(() => expect(within(section).getAllByText("Unavailable")).toHaveLength(3));
    expect(section.textContent).toMatch(/can't transcribe recordings/);
    expect(section.textContent).toMatch(/can't read replies aloud/);
  });
});

describe("Settings, Voice, Speech to text (ADR 0065, 0067)", () => {
  it("is chosen in Settings → Voice, and Dictation then transcribes where it says", async () => {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    localStt.heard = "Restart the NAS";
    const { server, user } = await signedIn(undefined, localStt);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("tab", { name: /Voice/ }));
    const where = await screen.findByRole("radiogroup", { name: "Where speech to text runs" });
    await user.click(within(where).getByRole("radio", { name: "This computer" }));
    await waitFor(() => expect(localStt.choice.onThisComputer).toBe(true));
    // The engine and model it runs are shown as Rust read them back.
    expect(await screen.findByText(localStt.modelPath("base"))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await record(user);
    mic.say(1);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(composer().value).toBe("Restart the NAS"));
    expect(server.recordings).toHaveLength(0);
    expect(localStt.recordings).toHaveLength(1);
  });
});

