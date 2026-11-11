// @vitest-environment jsdom
// Voice conversations through the signed-in app, against a fake Hermes (ADR 0111). The microphone and the audio element
// are stand-ins (jsdom has neither), fed loud or quiet blocks of samples; everything from the Start button to what
// Hermes receives and plays is the real code. Each test checks what reached Hermes, what the owner sees, and that the
// microphone and audio are let go of.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { setWindowHidden } from "./windowState";
import { FakeLocalStt } from "../hermes/fakeLocalStt";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const RATE = 48_000;
const BLOCK = 4096;

type FakeTrack = {
  stopped: boolean;
  enabled: boolean;
  label: string;
  readyState: MediaStreamTrackState;
  onended: null | (() => void);
  stop: () => void;
  getSettings: () => { deviceId: string };
};

/** A stand-in microphone. Each `getUserMedia` opens a new track; `loud` and `quiet` feed the open one samples. */
class FakeMic {
  fail?: string;
  opened = 0;
  constraints: MediaStreamConstraints[] = [];
  tracks: FakeTrack[] = [];
  contexts: { closed: boolean }[] = [];
  devices = [
    { kind: "audioinput", deviceId: "default", label: "Default", groupId: "" },
    { kind: "audioinput", deviceId: "usb-1", label: "USB headset", groupId: "" },
    { kind: "audiooutput", deviceId: "spk", label: "Speakers", groupId: "" },
  ];
  deviceListeners = new Set<() => void>();
  private processor?: { onaudioprocess: null | ((e: unknown) => void) };

  install() {
    const mic = this;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (c: MediaStreamConstraints) => {
          mic.opened++;
          mic.constraints.push(c);
          expect(c.video).toBeUndefined();
          if (mic.fail) throw new DOMException("refused", mic.fail);
          const id = (c.audio as { deviceId?: { exact: string } }).deviceId?.exact ?? "default";
          const track: FakeTrack = {
            stopped: false,
            enabled: true,
            label: mic.devices.find((d) => d.deviceId === id)?.label ?? "",
            readyState: "live",
            onended: null,
            stop: () => void (track.stopped = true),
            getSettings: () => ({ deviceId: id }),
          };
          mic.tracks.push(track);
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
        enumerateDevices: async () => mic.devices,
        addEventListener: (_: string, fn: () => void) => mic.deviceListeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => mic.deviceListeners.delete(fn),
      },
    });
    globalThis.AudioContext = class {
      sampleRate = RATE;
      state = "running";
      destination = {};
      closed = false;
      constructor() {
        mic.contexts.push(this);
      }
      createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
      createScriptProcessor = () => (mic.processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} } as never);
      resume = () => Promise.resolve();
      close = async () => void (this.closed = true);
    } as unknown as typeof AudioContext;
  }

  private feed(seconds: number, amplitude: number) {
    const n = Math.ceil((seconds * RATE) / BLOCK);
    for (let i = 0; i < n; i++) {
      const data = Float32Array.from({ length: BLOCK }, (_, j) => (amplitude ? Math.sin((i * BLOCK + j) / 8) * amplitude : 0));
      act(() => this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } }));
    }
  }

  /** `seconds` of speech, well above Hermes's default threshold. */
  loud(seconds: number) {
    this.feed(seconds, 0.3);
  }

  /** `seconds` of quiet. */
  quiet(seconds: number) {
    this.feed(seconds, 0);
  }

  get track() {
    return this.tracks.at(-1)!;
  }

  /** Every microphone opened has been closed, and its audio system with it. */
  get allClosed() {
    return this.tracks.every((t) => t.stopped) && this.contexts.every((c) => c.closed);
  }
}

let mic: FakeMic;
/** Every audio element that started playing, and the blob URLs made and let go of. */
const audio = { elements: [] as HTMLMediaElement[], play: vi.fn(async () => {}), pause: vi.fn(), revoked: [] as string[], made: 0 };

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0) as unknown as number;
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    audio.elements.push(this);
    return audio.play();
  };
  window.HTMLMediaElement.prototype.pause = function () {
    audio.pause();
  };
  window.HTMLMediaElement.prototype.load = () => {};
  URL.createObjectURL = () => `blob:speech-${++audio.made}`;
  URL.revokeObjectURL = (u: string) => void audio.revoked.push(u);
});
const running: Hermes[] = [];
beforeEach(() => {
  mic = new FakeMic();
  mic.install();
  audio.elements = [];
  audio.play.mockReset().mockImplementation(async () => {});
  audio.pause.mockReset();
  audio.revoked = [];
  audio.made = 0;
});
afterEach(async () => {
  act(() => setWindowHidden(false));
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text));
const startButton = () => screen.getByRole("button", { name: "Start voice conversation" });
const panel = () => screen.getByRole("region", { name: "Voice conversation" });
const status = () => panel().querySelector(".conv-status")?.textContent ?? "";
const heard = () => Array.from(panel().querySelectorAll(".conv-heard li")).map((li) => li.textContent);
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");

let signIns = 0;

/** Signed in with "Nightly backup" open: a chat that has started. Turns end after one second of quiet. */
async function opened(server = new FakeHermes(), localStt = new FakeLocalStt()) {
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
  };
  server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  server.voice = { silenceDuration: 1, ...server.voice };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  // Rust reaches the connected Hermes for the server side, as `hermes_transcribe` does.
  localStt.server = (audio, mime) => hermes.transcribe(audio, mime);
  const user = userEvent.setup();
  render(
    <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: `talker${++signIns}` }} onSignOut={async () => {}} localStt={localStt} />,
  );
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await settle(hermes);
  await waitFor(() => expect(startButton().getAttribute("aria-disabled")).toBe("false"));
  return { server, hermes, user, localStt, runtime: () => server.runtimeIdOf("backup")! };
}

type Opened = Awaited<ReturnType<typeof opened>>;

/** Starts the conversation and waits until it listens. */
async function start(s: Opened) {
  await s.user.click(startButton());
  await waitFor(() => expect(status()).toMatch(/^Listening/));
}

/** Says something: speech, then the quiet that ends the turn. Waits for the text to reach the chat. */
async function say(s: Opened, words: string) {
  s.server.heard = words;
  mic.loud(1);
  mic.quiet(1.3);
  await waitFor(() => expect(prompts(s.server)).toContain(words));
  await settle(s.hermes);
}

/** Hermes replies to the turn and finishes. */
async function reply(s: Opened, text: string, payload: Record<string, unknown> = {}) {
  act(() => {
    s.server.event(s.runtime(), "message.start");
    s.server.event(s.runtime(), "message.delta", { text });
    s.server.event(s.runtime(), "message.complete", { text, ...payload });
  });
  await settle(s.hermes);
}

/** The reply's audio finishes playing. */
function finishPlaying() {
  const el = audio.elements.at(-1)!;
  act(() => el.onended?.(new Event("ended")));
}

describe("Starting a voice conversation", () => {
  it("opens the microphone only when asked, puts focus on the panel and says what it does", async () => {
    const s = await opened();
    expect(mic.opened).toBe(0);
    expect(startButton().title).toMatch(/talk with Hermes hands-free/);
    await start(s);
    expect(mic.opened).toBe(1);
    expect(document.activeElement).toBe(panel());
    expect(status()).toMatch(/Speak, then pause for 1 s to send/);
    expect(within(panel()).getByText("Mic on")).toBeTruthy();
    expect(within(panel()).getByRole("listitem", { current: "step" }).textContent).toBe("Listening");
    expect(panel().textContent).toMatch(/Nothing said yet/);
    // What is recorded and where it goes, without any key.
    const about = panel().querySelector(".conv-about")!.textContent!;
    expect(about).toMatch(/The audio is never saved on this computer/);
    expect(about).toMatch(/text sent is a chat message like any other, kept on this computer as typed messages are/);
    expect(about).toMatch(/Local Whisper/);
    expect(about).not.toMatch(/sk-|api_key/i);
    // Dictation's button gives way while the conversation is on.
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("says why it can't start on a server without speech, and opens nothing", async () => {
    const server = new FakeHermes();
    server.voice = { ...server.voice, speak: false };
    server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
    server.transcripts = { backup: [{ role: "user", text: "Hi" }] };
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: `talker${++signIns}` }} onSignOut={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
    await settle(hermes);
    await waitFor(() => expect(startButton().getAttribute("aria-disabled")).toBe("true"));
    expect(startButton().title).toMatch(/can't speak its replies/);
    await user.click(startButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't speak its replies\. Updating Hermes adds it/);
    expect(mic.opened).toBe(0);
    expect(screen.queryByRole("region", { name: "Voice conversation" })).toBeNull();
  });

  it("can't start in a new chat, which has no session to talk in yet", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: `talker${++signIns}` }} onSignOut={async () => {}} />);
    await settle(hermes);
    await waitFor(() => expect(startButton().title).toMatch(/first message/));
    await user.click(startButton());
    expect(mic.opened).toBe(0);
  });

  it("says so when the microphone is refused, and tries again only on Resume", async () => {
    const s = await opened();
    mic.fail = "NotAllowedError";
    await s.user.click(startButton());
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toMatch(/wasn't allowed to use the microphone/);
    expect(status()).toMatch(/Paused/);
    expect(within(panel()).getByText("Mic closed")).toBeTruthy();
    expect(mic.opened).toBe(1);
    mic.fail = undefined;
    await s.user.click(within(panel()).getByRole("button", { name: /Resume listening/ }));
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(mic.opened).toBe(2);
  });
});

describe("A turn", () => {
  it("sends each turn once, speaks the reply, keeps the speakers out of the microphone, and listens again", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Unlock the repo please");
    expect(s.server.recordings).toHaveLength(1);
    expect(s.server.recordings[0].mime).toBe("audio/wav");
    expect(heard()).toEqual(["“Unlock the repo please”Sent"]);
    await waitFor(() => expect(status()).toMatch(/Hermes is thinking/));
    expect(within(panel()).getByRole("button", { name: /Stop reply/ })).toBeTruthy();

    await reply(s, "I removed the stale lock and the backup ran again.");
    await waitFor(() => expect(status()).toMatch(/Hermes is speaking/));
    expect(s.server.spoken.map((x) => x.text)).toEqual(["I removed the stale lock and the backup ran again."]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    // The reply's own Read aloud shows it playing, so it can be stopped from there too.
    expect(screen.getByRole("button", { name: "Stop" , pressed: true })).toBeTruthy();

    // The speakers playing into the microphone don't make a turn.
    mic.loud(2);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);

    finishPlaying();
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    // The echo tail: sound straight after the audio ends is ignored too.
    mic.loud(0.4);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);

    await say(s, "Now prune old snapshots");
    expect(prompts(s.server)).toEqual(["Unlock the repo please", "Now prune old snapshots"]);
    expect(s.server.recordings).toHaveLength(2);
    expect(heard()).toEqual(["“Unlock the repo please”Sent", "“Now prune old snapshots”Sent"]);
  });

  it("keeps only half a second of the quiet before speech, so audio doesn't pile up while nobody talks", async () => {
    const s = await opened();
    await start(s);
    mic.quiet(20);
    await say(s, "Check the disks");
    // 16 kHz 16-bit WAV: header plus at most the pre-roll, the speech and the quiet that ended it (with a block's slack).
    const seconds = (s.server.recordings[0].audio.length - 44) / 32_000;
    expect(seconds).toBeLessThan(0.5 + 1 + 1.3 + 0.2);
    expect(seconds).toBeGreaterThan(1.5);
  });

  it("drops a transcript that is the reply coming back from the speakers", async () => {
    const s = await opened();
    await start(s);
    await say(s, "What happened");
    await reply(s, "The restic repo was locked by a stale process from last night.");
    await waitFor(() => expect(status()).toMatch(/Hermes is speaking/));
    finishPlaying();
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    mic.quiet(0.7);
    s.server.heard = "locked by a stale process";
    mic.loud(1);
    mic.quiet(1.3);
    await waitFor(() => expect(heard()).toHaveLength(2));
    expect(heard()[1]).toMatch(/“locked by a stale process”Not sent: It repeated the reply Hermes had just spoken/);
    expect(prompts(s.server)).toEqual(["What happened"]);
  });

  it("sends at once on Send now, and drops what was heard on Discard", async () => {
    const s = await opened();
    await start(s);
    s.server.heard = "Discard me";
    mic.loud(1);
    await s.user.click(within(panel()).getByRole("button", { name: /Discard/ }));
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(0);

    s.server.heard = "Restart the backup";
    mic.loud(1);
    await s.user.click(within(panel()).getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(prompts(s.server)).toEqual(["Restart the backup"]));
    // The quiet that follows doesn't send it again.
    mic.quiet(2);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);
    expect(prompts(s.server)).toEqual(["Restart the backup"]);
  });

  it("stops a turn at the profile's length limit and sends it", async () => {
    const server = new FakeHermes();
    server.voice = { ...server.voice, maxRecordingSeconds: 2 };
    const s = await opened(server);
    await start(s);
    s.server.heard = "A very long ramble";
    mic.loud(3);
    await waitFor(() => expect(prompts(s.server)).toEqual(["A very long ramble"]));
    expect(panel().textContent).toMatch(/reached the 2-second limit, so it was sent as it was/);
  });

  it("speaks only its own turn's reply, even when a queued message with the same words goes straight after it", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Check it again");
    act(() => {
      s.server.event(s.runtime(), "message.start");
      s.server.event(s.runtime(), "message.delta", { text: "Voice answer." });
    });
    await settle(s.hermes);
    // While Hermes replies, the owner queues the very same words by typing.
    await s.user.type(composer(), "Check it again{Enter}");
    await waitFor(() => expect(s.hermes.getSnapshot().queues.backup?.items).toHaveLength(1));
    // The voice reply ends; the queue sends its message at once, so the chat is running again before anything renders.
    act(() => s.server.event(s.runtime(), "message.complete", { text: "Voice answer." }));
    await settle(s.hermes);
    await waitFor(() => expect(prompts(s.server)).toEqual(["Check it again", "Check it again"]));
    await waitFor(() => expect(s.server.spoken.map((x) => x.text)).toEqual(["Voice answer."]));
    finishPlaying();
    await reply(s, "Queued answer.");
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(s.server.spoken.map((x) => x.text)).toEqual(["Voice answer."]);
    expect(heard()).toEqual(["“Check it again”Sent"]);
  });

  it("leaves the typed draft alone, and doesn't listen while another message's reply runs", async () => {
    const s = await opened();
    await s.user.type(composer(), "half-typed thought");
    await start(s);
    await say(s, "Voice turn");
    expect(composer().value).toBe("half-typed thought");
    await reply(s, "Done.");
    finishPlaying();
    await waitFor(() => expect(status()).toMatch(/^Listening/));

    // A typed message, sent while the conversation listens: its reply runs, the microphone stops listening.
    await s.user.clear(composer());
    await s.user.type(composer(), "Typed one{Enter}");
    await waitFor(() => expect(prompts(s.server)).toEqual(["Voice turn", "Typed one"]));
    await waitFor(() => expect(status()).toMatch(/replying to another message/));
    mic.loud(1);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);
    await reply(s, "Typed reply.");
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    // That reply wasn't the conversation's, so it isn't spoken.
    expect(s.server.spoken.map((x) => x.text)).toEqual(["Done."]);
  });
});

describe("Interrupting", () => {
  it("Stop speaking stops the audio only; Stop reply stops Hermes, and the stopped reply isn't spoken", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Explain the failure");
    await reply(s, "First, the lock.");
    await waitFor(() => expect(status()).toMatch(/Hermes is speaking/));
    // Esc on the panel stops the audio.
    panel().focus();
    await s.user.keyboard("{Escape}");
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.revoked).toContain("blob:speech-1");
    expect(s.server.requests.some((r) => r.method === "session.interrupt")).toBe(false);

    await say(s, "Go on");
    await waitFor(() => expect(status()).toMatch(/Hermes is thinking/));
    await s.user.click(within(panel()).getByRole("button", { name: /Stop reply/ }));
    await waitFor(() => expect(s.server.requests.some((r) => r.method === "session.interrupt")).toBe(true));
    await reply(s, "Partial", { status: "interrupted" });
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(panel().textContent).toMatch(/The reply was stopped, so it isn't spoken/);
    expect(s.server.spoken.map((x) => x.text)).toEqual(["First, the lock."]);
  });

  it("doesn't speak a reply stopped during a tool call, though it said something before the tool", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Clean the cache");
    act(() => {
      s.server.event(s.runtime(), "message.start");
      s.server.event(s.runtime(), "message.delta", { text: "Cleaning it now." });
      s.server.event(s.runtime(), "tool.start", { tool_id: "t1", name: "terminal", args: { command: "rm -rf ~/.cache/x" } });
    });
    await settle(s.hermes);
    await s.user.click(within(panel()).getByRole("button", { name: /Stop reply/ }));
    await waitFor(() => expect(s.server.requests.some((r) => r.method === "session.interrupt")).toBe(true));
    act(() => s.server.event(s.runtime(), "message.complete", { text: "", status: "interrupted" }));
    await settle(s.hermes);
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(panel().textContent).toMatch(/The reply was stopped, so it isn't spoken/);
    expect(s.server.spoken).toEqual([]);
  });

  it("waits on an Approval without listening, and carries on once it's answered", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Delete the old logs");
    act(() => s.server.askApproval(s.runtime(), { command: "rm -rf /var/log/old", description: "delete old logs" }));
    await waitFor(() => expect(status()).toMatch(/waiting for your approval above/));
    mic.loud(1);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);
    await s.user.click(await screen.findByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(s.server.approvalAnswers).toHaveLength(1));
    await reply(s, "Deleted.");
    await waitFor(() => expect(status()).toMatch(/Hermes is speaking/));
  });
});

describe("Mute and devices", () => {
  it("hears nothing while muted", async () => {
    const s = await opened();
    await start(s);
    await s.user.click(within(panel()).getByRole("button", { name: /Mute/ }));
    expect(mic.track.enabled).toBe(false);
    expect(within(panel()).getByRole("button", { name: /Unmute/ }).getAttribute("aria-pressed")).toBe("true");
    expect(status()).toMatch(/Muted/);
    mic.loud(1);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(0);
    await s.user.click(within(panel()).getByRole("button", { name: /Unmute/ }));
    expect(mic.track.enabled).toBe(true);
    await say(s, "Unmuted now");
  });

  it("lists the microphones and reopens the one picked", async () => {
    const s = await opened();
    await start(s);
    const select = within(panel()).getByRole("combobox", { name: "Microphone" });
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["System default (Default)", "USB headset"]));
    await s.user.selectOptions(select, "usb-1");
    await waitFor(() => expect(mic.opened).toBe(2));
    expect(mic.tracks[0].stopped).toBe(true);
    expect(mic.constraints[1]).toMatchObject({ audio: { deviceId: { exact: "usb-1" } } });
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    await say(s, "From the headset");
  });

  it("pauses when the microphone is unplugged, and doesn't reopen it by itself", async () => {
    const s = await opened();
    await start(s);
    mic.loud(0.5);
    act(() => {
      mic.track.readyState = "ended";
      mic.track.onended?.();
    });
    expect((await within(panel()).findByRole("alert")).textContent).toMatch(/microphone was disconnected\. Plug it back in or pick another/);
    expect(mic.allClosed).toBe(true);
    mic.quiet(2);
    await settle(s.hermes);
    expect(mic.opened).toBe(1);
    expect(s.server.recordings).toHaveLength(0);
  });
});

describe("Where speech to text runs (ADR 0065)", () => {
  /** This computer first, Hermes as backup, with this computer's run held until `release`. */
  async function localFirst() {
    const localStt = new FakeLocalStt();
    localStt.useModel("base");
    let release!: () => void;
    localStt.gate = new Promise((r) => (release = r));
    localStt.heard = new Error("whisper.cpp exited with code 1");
    localStt.route({ primary: "local", backup: true });
    const s = await opened(undefined, localStt);
    await start(s);
    mic.loud(1);
    mic.quiet(1.3);
    await waitFor(() => expect(localStt.recordings).toHaveLength(1));
    return { ...s, release };
  }

  it("sends a turn to the backup when this computer fails, and says which one transcribed it", async () => {
    const s = await localFirst();
    s.server.heard = "Check the NAS";
    s.release();
    await waitFor(() => expect(prompts(s.server)).toEqual(["Check the NAS"]));
    expect(s.server.recordings[0].audio).toEqual(s.localStt.recordings[0].audio);
    expect(panel().querySelector(".conv-heard-via")!.textContent).toBe(
      "Transcribed on Hermes. This computer couldn't transcribe it: whisper.cpp exited with code 1.",
    );
  });

  it("never sends the turn to Hermes once the conversation ends while this computer transcribes it", async () => {
    const s = await localFirst();
    await s.user.click(within(panel()).getByRole("button", { name: /End conversation/ }));
    s.release();
    await settle(s.hermes);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(s.server.recordings).toEqual([]);
    expect(prompts(s.server)).toEqual([]);
  });

  it("never sends the turn to Hermes when it pauses while this computer transcribes it", async () => {
    const s = await localFirst();
    // Hiding the window to the tray pauses it (ADR 0111).
    act(() => setWindowHidden(true));
    expect(mic.allClosed).toBe(true);
    s.release();
    await settle(s.hermes);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(s.server.recordings).toEqual([]);
    expect(prompts(s.server)).toEqual([]);
  });
});

describe("Failures", () => {
  it("pauses when Hermes can't transcribe, holds the turn, and sends it once on Try again", async () => {
    const s = await opened();
    await start(s);
    s.server.heard = new Error("Hermes couldn't transcribe the recording: No STT provider available.");
    mic.loud(1);
    mic.quiet(1.3);
    expect((await within(panel()).findByRole("alert")).textContent).toMatch(/^Hermes couldn't transcribe the recording: No STT provider available\.\s*Try again\s*Resume listening$/);
    expect(mic.allClosed).toBe(true);
    s.server.heard = "Held turn";
    await s.user.click(within(panel()).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(prompts(s.server)).toEqual(["Held turn"]));
    expect(s.server.recordings).toHaveLength(2);
    expect(s.server.recordings[1].audio).toEqual(s.server.recordings[0].audio);
    await waitFor(() => expect(mic.opened).toBe(2));
  });

  it("says so when the reply can't be spoken, and listens again", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Read me the status");
    s.server.speech = new Error("Hermes couldn't read it aloud: edge-tts is not installed");
    await reply(s, "All green.");
    await waitFor(() => expect(status()).toMatch(/^Listening/));
    expect(panel().textContent).toMatch(/Couldn't speak the reply: Hermes couldn't read it aloud: edge-tts is not installed/);
  });

  it("pauses when Hermes takes nothing, and the message stays a failed one", async () => {
    const s = await opened();
    await start(s);
    s.server.rejectPrompt = { code: 4009, message: "session busy" };
    s.server.heard = "Refused turn";
    mic.loud(1);
    mic.quiet(1.3);
    expect((await within(panel()).findByRole("alert")).textContent).toMatch(/Hermes didn't take what you said/);
    expect(heard()[0]).toMatch(/“Refused turn”Not delivered/);
    expect(mic.allClosed).toBe(true);
  });

  it("pauses on a dropped connection, drops the answer on its way, and stays paused after reconnecting", async () => {
    const s = await opened();
    await start(s);
    let open!: () => void;
    s.server.voiceGate = new Promise((r) => (open = r));
    s.server.heard = "Lost turn";
    mic.loud(1);
    mic.quiet(1.3);
    await waitFor(() => expect(status()).toMatch(/transcribing/));
    await act(async () => s.server.drop());
    expect((await within(panel()).findByRole("alert")).textContent).toMatch(/Hermes disconnected.*won't restart by itself/);
    expect(mic.allClosed).toBe(true);
    // Resume does nothing while Hermes is away.
    const resume = within(panel()).getByRole("button", { name: /Resume listening/ });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    await s.user.click(resume);
    expect(mic.opened).toBe(1);
    open();
    await act(async () => void (await s.hermes.reconnect().catch(() => {})));
    await waitFor(() => expect(s.hermes.getSnapshot().status).toBe("connected"), { timeout: 15_000 });
    await settle(s.hermes);
    expect(status()).toMatch(/Paused/);
    expect(mic.opened).toBe(1);
    expect(prompts(s.server)).toEqual([]);
    expect(within(panel()).getByRole("button", { name: /Resume listening/ }).getAttribute("aria-disabled")).toBe("false");
    // The held turn goes only when the owner asks.
    await s.user.click(within(panel()).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(prompts(s.server)).toEqual(["Lost turn"]));
  }, 20_000);
});

describe("Ending and leaving", () => {
  it("End closes the microphone, stops the audio, drops a transcript on its way, and puts focus back", async () => {
    const s = await opened();
    await start(s);
    await say(s, "Speak to me");
    await reply(s, "Speaking now.");
    await waitFor(() => expect(status()).toMatch(/Hermes is speaking/));
    let open!: () => void;
    s.server.voiceGate = new Promise((r) => (open = r));
    await s.user.click(within(panel()).getByRole("button", { name: /End conversation/ }));
    expect(screen.queryByRole("region", { name: "Voice conversation" })).toBeNull();
    expect(mic.allClosed).toBe(true);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.revoked).toContain("blob:speech-1");
    await waitFor(() => expect(document.activeElement).toBe(startButton()));
    open();
    mic.loud(1);
    mic.quiet(1.5);
    await settle(s.hermes);
    expect(s.server.recordings).toHaveLength(1);
    expect(prompts(s.server)).toEqual(["Speak to me"]);
  });

  it("End while transcribing sends nothing", async () => {
    const s = await opened();
    await start(s);
    let open!: () => void;
    s.server.voiceGate = new Promise((r) => (open = r));
    s.server.heard = "Never sent";
    mic.loud(1);
    mic.quiet(1.3);
    await waitFor(() => expect(status()).toMatch(/transcribing/));
    await s.user.click(within(panel()).getByRole("button", { name: /End conversation/ }));
    open();
    await settle(s.hermes);
    await act(async () => {});
    expect(prompts(s.server)).toEqual([]);
    expect(mic.allClosed).toBe(true);
  });

  it("pauses when the window is hidden, and stays paused when it's back", async () => {
    const s = await opened();
    await start(s);
    act(() => setWindowHidden(true));
    expect(mic.allClosed).toBe(true);
    act(() => setWindowHidden(false));
    expect(status()).toMatch(/Paused/);
    expect(panel().textContent).toMatch(/hidden to the tray/);
    expect(mic.opened).toBe(1);
  });

  it("ends when another chat opens, and on a profile switch, leaving nothing open", async () => {
    const s = await opened();
    await start(s);
    await s.user.click(screen.getByRole("button", { name: /^NAS disks/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Voice conversation" })).toBeNull());
    expect(mic.allClosed).toBe(true);

    await s.user.click(screen.getByRole("button", { name: /^Nightly backup/ }));
    await settle(s.hermes);
    await start(s);
    await s.user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await s.user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(s.hermes.getSnapshot().profile).toBe("work"));
    expect(screen.queryByRole("region", { name: "Voice conversation" })).toBeNull();
    expect(mic.allClosed).toBe(true);
    expect(s.server.recordings).toHaveLength(0);
  });
});

describe("Split panes and Settings", () => {
  it("pauses when focus moves to the other pane, and only that pane's conversation", async () => {
    const s = await opened();
    await s.user.keyboard("{Control>}\\{/Control}");
    await s.user.click(screen.getByRole("button", { name: /^NAS disks/ }));
    await settle(s.hermes);
    const panes = () => [...document.querySelectorAll<HTMLElement>(".pane")];
    const talkIn = (pane: HTMLElement) => within(pane).queryByRole("region", { name: "Voice conversation" });
    const backup = () => panes().find((p) => p.textContent?.includes("Nightly backup"))!;
    const nas = () => panes().find((p) => p.textContent?.includes("NAS disks"))!;
    await s.user.click(within(backup()).getByPlaceholderText("Message Hermes"));
    await s.user.click(within(backup()).getByRole("button", { name: "Start voice conversation" }));
    await waitFor(() => expect(talkIn(backup())?.querySelector(".conv-status")?.textContent).toMatch(/^Listening/));
    expect(talkIn(nas())).toBeNull();
    await s.user.click(within(nas()).getByPlaceholderText("Message Hermes"));
    await waitFor(() => expect(talkIn(backup())?.textContent).toMatch(/moved to another pane or screen, so the conversation paused/));
    expect(mic.allClosed).toBe(true);
    // Back in the pane, it waits for the owner.
    await s.user.click(within(backup()).getByPlaceholderText("Message Hermes"));
    expect(talkIn(backup())?.querySelector(".conv-status")?.textContent).toMatch(/Paused/);
    expect(mic.opened).toBe(1);
  });

  it("Change voice settings opens Settings → Voice, pausing the conversation, and a save there reaches the panel", async () => {
    const s = await opened();
    await start(s);
    expect(panel().textContent).toMatch(/Hearing you with Local Whisper, speaking with Microsoft Edge TTS/);
    await s.user.click(within(panel()).getByRole("button", { name: "Change voice settings" }));
    expect((await screen.findByRole("tab", { name: /Voice/ })).getAttribute("aria-selected")).toBe("true");
    // Settings covers the pane, so the conversation paused and closed the microphone.
    await waitFor(() => expect(mic.allClosed).toBe(true));
    const tts = await screen.findByRole("combobox", { name: "Text-to-speech provider" });
    await s.user.selectOptions(tts, "ElevenLabs");
    await s.user.type(screen.getByLabelText("ElevenLabs ElevenLabs API key"), "el-123");
    await s.user.click(screen.getByRole("button", { name: /Save to Hermes/ }));
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(s.server.voiceProviders.provider("default", "tts")).toBe("elevenlabs");
    await s.user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await waitFor(() => expect(panel().textContent).toMatch(/speaking with ElevenLabs/));
    expect(status()).toMatch(/Paused/);
    expect(mic.opened).toBe(1);
  });

  it("Settings says how a turn ends, with the profile's own settings", async () => {
    const server = new FakeHermes();
    server.voice = { ...server.voice, silenceThreshold: 350, silenceDuration: 1.5 };
    const s = await opened(server);
    await s.user.click(screen.getByRole("button", { name: "Settings" }));
    await s.user.click(await screen.findByRole("tab", { name: /Voice/ }));
    const section = (await screen.findByRole("heading", { name: "Voice" })).closest("section")!;
    await within(section).findByText("Ends a turn after 1.5 s of quiet");
    expect(section.textContent).toMatch(/1\.5 s of quiet \(voice\.silence_duration, the profile's\)/);
    expect(section.textContent).toMatch(/below loudness 350 \(voice\.silence_threshold, the profile's\)/);
    expect(section.textContent).toMatch(/at most 120 s \(voice\.max_recording_seconds, Hermes's default\)/);
  });
});
