// @vitest-environment jsdom
// Settings → Voice → Speech providers on screen, against the fake dashboard: the providers Hermes lists and which are set
// up, write-only keys, saving and reading back, refusals, a server without the routes, and answers that come back for a
// profile or connection no longer shown.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect } from "../hermes/transport";
import { VoiceProviderSettings } from "./VoiceProviderSettings";
import { SettingsSearching } from "./SettingRows";
import { queryWords, searchText, textMatches } from "./settingsSearch";

afterEach(cleanup);

async function shown(opts: { setUp?: (server: FakeHermes) => void; profile?: string } = {}) {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  opts.setUp?.(server);
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  let saved = 0;
  const view = (profile = opts.profile ?? "default", api = hermes.voiceSettings, connected = true) => (
    <VoiceProviderSettings api={api} profile={profile} connected={connected} onSaved={() => saved++} />
  );
  const r = render(view());
  return { server, fake: server.voiceProviders, hermes, user, rerender: (...a: Parameters<typeof view>) => r.rerender(view(...a)), saved: () => saved };
}

const side = (name: "Speech-to-text" | "Text-to-speech") => screen.getByRole("group", { name });
const picker = (name: "Speech-to-text" | "Text-to-speech") => screen.getByRole<HTMLSelectElement>("combobox", { name: `${name} provider` });
const listed = (name: "Speech-to-text" | "Text-to-speech") =>
  within(screen.getByRole("list", { name: `${name} providers` }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const saveButton = () => screen.getByRole("button", { name: /Save to Hermes|Saving/ });

describe("Settings → Voice → Speech providers", () => {
  it("lists the providers Hermes supports for each side, which is in use, and which are set up", async () => {
    await shown({ setUp: (s) => (s.voiceProviders.env.default = new Set(["ELEVENLABS_API_KEY"])) });
    await screen.findByRole("group", { name: "Speech-to-text" });
    // Each side heads its providers, so it's a heading to jump to.
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["Speech-to-text", "Text-to-speech"]));
    expect(listed("Speech-to-text")).toEqual([
      expect.stringMatching(/^Local Whisper\s*In use\s*Set up/),
      expect.stringMatching(/^Nous Subscription\s*Needs sign-in/),
      expect.stringMatching(/^OpenAI\s*Needs a key/),
      expect.stringMatching(/^Groq\s*Needs a key/),
      expect.stringMatching(/^ElevenLabs Scribe\s*Set up/),
      expect.stringMatching(/^Mistral Voxtral\s*Needs a key/),
    ]);
    expect(listed("Text-to-speech")).toEqual([
      expect.stringMatching(/^Microsoft Edge TTS\s*In use\s*Set up/),
      expect.stringMatching(/^Nous Subscription\s*Needs sign-in/),
      expect.stringMatching(/^OpenAI TTS\s*Needs a key/),
      expect.stringMatching(/^ElevenLabs\s*Set up/),
      expect.stringMatching(/^Piper\s*Not installed/),
    ]);
    expect(picker("Speech-to-text").value).toBe("Local Whisper");
    expect(picker("Text-to-speech").value).toBe("Microsoft Edge TTS");
    // The provider in use shows its own settings, with Hermes's choices where it has them.
    const model = within(side("Speech-to-text")).getByLabelText<HTMLSelectElement>(/Model size/);
    expect(model.value).toBe("base");
    expect([...model.options].map((o) => o.value)).toEqual(["base", "tiny", "small", "medium", "large-v3", "turbo"]);
    expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>(/^Voice/).value).toBe("en-US-AriaNeural");
  });

  it("shows a picked provider's state, keys and settings before anything is saved", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    await user.selectOptions(picker("Text-to-speech"), "Piper");
    expect(side("Text-to-speech").textContent).toMatch(/Its software isn't installed on the Hermes server/);
    await user.selectOptions(picker("Text-to-speech"), "OpenAI TTS");
    const picked = within(side("Text-to-speech")).getByRole("group", { name: "OpenAI TTS settings" });
    expect(picked.textContent).toMatch(/Hermes has no API key for it yet/);
    expect(within(picked).getByText("Not set")).toBeTruthy();
    expect(within(picked).getByLabelText<HTMLInputElement>(/^Model/).value).toBe("gpt-4o-mini-tts");
    expect(screen.getByRole("status").textContent).toBe("Not saved yet.");
    expect(fake.writes).toEqual([]);
    // Picking the one in use again is no change.
    await user.selectOptions(picker("Text-to-speech"), "Microsoft Edge TTS");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("never shows a key: only whether one is set, and a typed one is sent once and emptied", async () => {
    const { user, fake } = await shown({ setUp: (s) => (s.voiceProviders.env.default = new Set(["GROQ_API_KEY"])) });
    await screen.findByRole("group", { name: "Speech-to-text" });
    await user.selectOptions(picker("Speech-to-text"), "Groq");
    const key = () => within(side("Speech-to-text")).getByLabelText<HTMLInputElement>("Groq Groq API key");
    expect(key().type).toBe("password");
    expect(key().value).toBe("");
    expect(key().placeholder).toMatch(/Saved on the server\. Type a new key to replace it/);
    expect(within(side("Speech-to-text")).getByText("Set")).toBeTruthy();
    await user.selectOptions(picker("Speech-to-text"), "OpenAI");
    await user.type(within(side("Speech-to-text")).getByLabelText("OpenAI OpenAI API key"), "sk-typed-SECRET");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.savedKeys).toEqual([{ profile: "default", env: "VOICE_TOOLS_OPENAI_KEY", value: "sk-typed-SECRET" }]);
    expect(fake.writes.map((w) => w.route)).toEqual(["env", "provider"]);
    // Hermes says it's set; the field is empty and the key is nowhere on screen.
    const openai = within(side("Speech-to-text")).getByRole("group", { name: "OpenAI settings" });
    expect(within(openai).getByLabelText<HTMLInputElement>("OpenAI OpenAI API key").value).toBe("");
    expect(within(openai).getByText("Set")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("sk-typed-SECRET");
  });

  it("says it's saving, keeps the controls still meanwhile, then shows what Hermes read back", async () => {
    const { user, fake, saved } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    await user.selectOptions(picker("Text-to-speech"), "ElevenLabs");
    await user.type(within(side("Text-to-speech")).getByLabelText("ElevenLabs ElevenLabs API key"), "el-1");
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "voice-2");
    await user.click(saveButton());
    await screen.findByText(/Saving to Hermes, then reading it back/);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(picker("Text-to-speech").disabled).toBe(true);
    act(() => open());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(picker("Text-to-speech").value).toBe("ElevenLabs");
    expect(listed("Text-to-speech")[3]).toMatch(/^ElevenLabs\s*In use\s*Set up/);
    expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>(/^Voice/).value).toBe("voice-2");
    expect(fake.config("default").tts.elevenlabs).toMatchObject({ voice_id: "voice-2" });
    expect(saved()).toBe(1);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Hermes's refusal, and keeps the changes to try again", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Speech-to-text" });
    fake.failNext = { route: "config", status: 400, detail: "Invalid model" };
    await user.selectOptions(within(side("Speech-to-text")).getByLabelText(/Model size/), "turbo");
    await user.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Hermes refused it: Invalid model. Nothing was changed.");
    expect(within(side("Speech-to-text")).getByLabelText<HTMLSelectElement>(/Model size/).value).toBe("turbo");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.config("default").stt.local).toMatchObject({ model: "turbo" });
  });

  it("sends nothing when another client changed it meanwhile, and shows what Hermes has now", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    await user.selectOptions(within(side("Speech-to-text")).getByLabelText(/Model size/), "small");
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "en-US-JennyNeural");
    fake.set("default", "tts.edge.voice", "en-GB-SoniaNeural");
    await user.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not saved: Microsoft Edge TTS's voice changed on Hermes since you opened this/);
    expect(fake.writes).toEqual([]);
    expect(fake.config("default").tts.edge).toMatchObject({ voice: "en-GB-SoniaNeural" });
    // The field shows Hermes's voice now; the change nobody else made stays, to save again.
    expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>(/^Voice/).value).toBe("en-GB-SoniaNeural");
    expect(within(side("Speech-to-text")).getByLabelText<HTMLSelectElement>(/Model size/).value).toBe("small");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.config("default").stt.local).toMatchObject({ model: "small" });
    expect(fake.config("default").tts.edge).toMatchObject({ voice: "en-GB-SoniaNeural" });
  });

  it("won't save a blank Hermes would use, and says why", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Microsoft Edge TTS's voice can't be blank/);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "en-GB-SoniaNeural");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("drops what was typed for a provider once another is picked, so nothing hidden is sent", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Speech-to-text" });
    await user.selectOptions(picker("Speech-to-text"), "Groq");
    await user.type(within(side("Speech-to-text")).getByLabelText("Groq Groq API key"), "gsk-hidden");
    await user.selectOptions(within(side("Speech-to-text")).getByLabelText(/^Model/), "whisper-large-v3");
    await user.selectOptions(picker("Speech-to-text"), "OpenAI");
    await user.type(within(side("Speech-to-text")).getByLabelText("OpenAI OpenAI API key"), "sk-shown");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.savedKeys.map((k) => k.env)).toEqual(["VOICE_TOOLS_OPENAI_KEY"]);
    expect(fake.writes.map((w) => w.route)).toEqual(["env", "provider"]);
    expect(fake.config("default").stt.groq).toMatchObject({ model: "whisper-large-v3-turbo" });
  });

  it("shows a save still on its way after the panel opens again, and reads Hermes once it lands", async () => {
    const { user, fake, hermes } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    await user.selectOptions(picker("Text-to-speech"), "ElevenLabs");
    await user.click(saveButton());
    await screen.findByText(/Saving to Hermes/);
    // Settings closed and opened again while it saves.
    cleanup();
    render(<VoiceProviderSettings api={hermes.voiceSettings} profile="default" connected />);
    await screen.findByRole("group", { name: "Text-to-speech" });
    expect(screen.getByText(/Saving to Hermes/)).toBeTruthy();
    expect(picker("Text-to-speech").disabled).toBe(true);
    act(() => open());
    await waitFor(() => expect(picker("Text-to-speech").value).toBe("ElevenLabs"));
    expect(picker("Text-to-speech").disabled).toBe(false);
    expect(listed("Text-to-speech")[3]).toMatch(/^ElevenLabs\s*In use/);
  });

  it("doesn't let a read still on its way from before a save undo what the save read back", async () => {
    const { user, server } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    let open!: () => void;
    server.voiceSetupGate = new Promise((r) => (open = r));
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await user.selectOptions(picker("Text-to-speech"), "ElevenLabs");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    act(() => open());
    await new Promise((r) => setTimeout(r, 30));
    expect(picker("Text-to-speech").value).toBe("ElevenLabs");
    expect(listed("Text-to-speech")[3]).toMatch(/^ElevenLabs\s*In use/);
  });

  it("empties a typed key when the save fails before Hermes answers", async () => {
    const { user, server, fake } = await shown();
    await screen.findByRole("group", { name: "Speech-to-text" });
    await user.selectOptions(picker("Speech-to-text"), "Groq");
    await user.type(within(side("Speech-to-text")).getByLabelText("Groq Groq API key"), "gsk-kept?");
    server.voiceSetupFailure = "Can't reach the Hermes dashboard: connection reset";
    await user.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't save: Can't reach the Hermes dashboard/);
    expect(within(side("Speech-to-text")).getByLabelText<HTMLInputElement>("Groq Groq API key").value).toBe("");
    expect(picker("Speech-to-text").value).toBe("Groq");
    expect(fake.savedKeys).toEqual([]);
  });

  it("can name Local Whisper when Hermes is only picking it", async () => {
    const { user, fake } = await shown({ setUp: (s) => (s.voice = { ...s.voice, sttProvider: undefined }) });
    await screen.findByRole("group", { name: "Speech-to-text" });
    expect(picker("Speech-to-text").value).toBe("");
    expect(picker("Speech-to-text").selectedOptions[0].textContent).toBe("Picked by Hermes (now Local Whisper)");
    expect(side("Speech-to-text").textContent).toMatch(/The profile names none, so Hermes picks as it transcribes/);
    // The one in use still shows its settings.
    expect(within(side("Speech-to-text")).getByLabelText<HTMLSelectElement>(/Model size/).value).toBe("base");
    await user.selectOptions(picker("Speech-to-text"), "Local Whisper");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.provider("default", "stt")).toBe("local");
    expect(picker("Speech-to-text").value).toBe("Local Whisper");
  });

  it("after a conflict over the provider, sends nothing typed for the pick that was dropped", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    await user.selectOptions(picker("Text-to-speech"), "OpenAI TTS");
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "nova");
    fake.set("default", "tts.provider", "elevenlabs");
    await user.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/the text-to-speech provider \(now ElevenLabs\) changed on Hermes/);
    expect(picker("Text-to-speech").value).toBe("ElevenLabs");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(fake.writes).toEqual([]);
  });

  it("drops what was typed where Reload finds Hermes changed it, and says so, instead of saving over it", async () => {
    const { user, fake } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "en-US-JennyNeural");
    await user.selectOptions(within(side("Speech-to-text")).getByLabelText(/Model size/), "small");
    fake.set("default", "tts.edge.voice", "en-GB-SoniaNeural");
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await waitFor(() => expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>(/^Voice/).value).toBe("en-GB-SoniaNeural"));
    expect(screen.getByRole("alert").textContent).toMatch(/Changed on Hermes since you opened this: Microsoft Edge TTS's voice/);
    expect(within(side("Speech-to-text")).getByLabelText<HTMLSelectElement>(/Model size/).value).toBe("small");
    await user.click(saveButton());
    await screen.findByText(/Saved on Hermes, and read back/);
    expect(fake.writes.map((w) => w.body)).toEqual([{ stt: { local: { model: "small" } } }]);
  });

  it("drops a key and settings typed for the provider in use when Reload finds another client switched it", async () => {
    const { user, fake } = await shown({ setUp: (s) => s.voiceProviders.set("default", "tts.provider", "openai") });
    await screen.findByRole("group", { name: "Text-to-speech" });
    expect(picker("Text-to-speech").value).toBe("OpenAI TTS");
    await user.clear(within(side("Text-to-speech")).getByLabelText(/^Voice/));
    await user.type(within(side("Text-to-speech")).getByLabelText(/^Voice/), "nova");
    await user.type(within(side("Text-to-speech")).getByLabelText("OpenAI TTS OpenAI API key"), "sk-typed");
    fake.set("default", "tts.provider", "elevenlabs");
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await waitFor(() => expect(picker("Text-to-speech").value).toBe("ElevenLabs"));
    expect(screen.getByRole("alert").textContent).toMatch(/Changed on Hermes since you opened this: the text-to-speech provider \(now ElevenLabs\)/);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    // Back on OpenAI TTS, nothing typed for it is left.
    await user.selectOptions(picker("Text-to-speech"), "OpenAI TTS");
    expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>(/^Voice/).value).toBe("alloy");
    expect(within(side("Text-to-speech")).getByLabelText<HTMLInputElement>("OpenAI TTS OpenAI API key").value).toBe("");
    expect(fake.writes).toEqual([]);
  });

  it("says when the server can't list its speech providers, and what to do instead", async () => {
    await shown({ setUp: (s) => (s.voiceProviders.routes = "none") });
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/doesn't list its speech providers: it has no \/api\/tools\/toolsets\/stt\/config route/);
    expect(note.textContent).toMatch(/hermes tools/);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says when the read fails, and reads again on Try again", async () => {
    const { user, server } = await shown({ setUp: (s) => (s.voiceSetupFailure = "the config isn't JSON") });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't read the speech providers: the config isn't JSON/);
    server.voiceSetupFailure = undefined;
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByRole("group", { name: "Speech-to-text" });
  });

  it("doesn't let a late read for another profile overwrite the one shown", async () => {
    let open!: () => void;
    const { fake, server, rerender } = await shown({
      setUp: (s) => {
        s.voiceProviders.set("work", "tts.provider", "elevenlabs");
        s.voiceSetupGate = new Promise((r) => (open = r));
      },
    });
    // The default profile's read is held; the work profile's goes through first.
    await waitFor(() => expect(server.voiceSetupGate).toBeUndefined());
    expect(screen.getByText(/Reading the speech providers from Hermes/)).toBeTruthy();
    rerender("work");
    await waitFor(() => expect(picker("Text-to-speech").value).toBe("ElevenLabs"));
    // Only then does the default profile's read answer.
    fake.set("default", "tts.provider", "openai");
    open();
    await new Promise((r) => setTimeout(r, 30));
    expect(picker("Text-to-speech").value).toBe("ElevenLabs");
    expect(screen.getByText(/Which provider Hermes transcribes and speaks with/).textContent).toMatch(/for the work profile/);
  });

  it("doesn't tell another profile what a save for the last one came to", async () => {
    const { user, fake, rerender } = await shown({ setUp: (s) => s.voiceProviders.set("work", "tts.provider", "elevenlabs") });
    await screen.findByRole("group", { name: "Text-to-speech" });
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    await user.selectOptions(picker("Text-to-speech"), "OpenAI TTS");
    await user.click(saveButton());
    await screen.findByText(/Saving to Hermes/);
    rerender("work");
    await waitFor(() => expect(picker("Text-to-speech").value).toBe("ElevenLabs"));
    act(() => open());
    await waitFor(() => expect(fake.provider("default", "tts")).toBe("openai"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Saved on Hermes/)).toBeNull();
    expect(screen.queryByText(/Saving to Hermes/)).toBeNull();
    expect(picker("Text-to-speech").value).toBe("ElevenLabs");
  });

  it("doesn't let an answer from the last connection overwrite the new one's", async () => {
    let open!: () => void;
    const { rerender } = await shown({ setUp: (s) => (s.voiceSetupGate = new Promise((r) => (open = r))) });
    const other = new FakeHermes();
    other.voiceProviders.set("default", "tts.provider", "piper");
    const second = await connect(other.openPipe, "default");
    rerender("default", second.voiceSettings);
    await waitFor(() => expect(picker("Text-to-speech").value).toBe("Piper"));
    open();
    await new Promise((r) => setTimeout(r, 30));
    expect(picker("Text-to-speech").value).toBe("Piper");
  });

  it("asks to connect while disconnected", async () => {
    const { rerender } = await shown();
    await screen.findByRole("group", { name: "Speech-to-text" });
    rerender("default", undefined, false);
    expect(screen.getByText(/Connect to Hermes to see and change this profile's speech providers/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("is a card with a row for each side, its picker as the control and the picked provider's settings under it", async () => {
    const { user } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    const card = screen.getByRole("region", { name: "Speech providers" }).querySelector(":scope > .set-card")!;
    for (const name of ["Speech-to-text", "Text-to-speech"] as const) {
      expect(side(name).parentElement).toBe(card);
      expect(picker(name).closest(".set-row > .set-control")?.closest(".voice-side")).toBe(side(name));
      expect(screen.getByRole("list", { name: `${name} providers` }).closest(".set-block")?.parentElement).toBe(side(name));
    }
    await user.selectOptions(picker("Text-to-speech"), "OpenAI TTS");
    expect(within(side("Text-to-speech")).getByRole("group", { name: "OpenAI TTS settings" }).closest(".set-block")).toBeTruthy();
    // What a save comes to, with Discard and Save, is the card's last line; Reload acts on the whole section.
    expect(saveButton().closest(".set-card > .set-note:last-child")?.parentElement).toBe(card);
    expect(screen.getByRole("status").textContent).toBe("Not saved yet.");
    expect(screen.getByRole("button", { name: /Reload/ }).closest(".set-head-action")).toBeTruthy();
  });

  it("folds how keys and the config are kept behind the section's (i), never a provider's state", async () => {
    const { user } = await shown();
    await screen.findByRole("group", { name: "Text-to-speech" });
    const about = screen.getByRole("button", { name: "About Speech providers" });
    const help = document.getElementById(about.getAttribute("aria-controls")!)!;
    expect(about.getAttribute("aria-expanded")).toBe("false");
    expect(help.hidden).toBe(true);
    expect(help.textContent).toMatch(/Keys are saved in the profile's .env on the server and never shown here again/);
    // Settings' search still finds the folded words, in the section it shows.
    expect(textMatches(searchText(screen.getByRole("region", { name: "Speech providers" })), queryWords("never shown here again"))).toBe(true);
    await user.selectOptions(picker("Text-to-speech"), "Piper");
    expect(screen.getByText(/Its software isn't installed on the Hermes server/).closest("[hidden]")).toBeNull();
    for (const fold of document.querySelectorAll("[hidden]")) expect(fold).toBe(help);
  });

  it("opens the section's help while Settings is searched", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, "default");
    render(
      <SettingsSearching.Provider value>
        <VoiceProviderSettings api={hermes.voiceSettings} profile="default" connected />
      </SettingsSearching.Provider>,
    );
    await screen.findByRole("group", { name: "Speech-to-text" });
    const about = screen.getByRole("button", { name: "About Speech providers" });
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(about.getAttribute("aria-controls")!)!.hidden).toBe(false);
  });
});
