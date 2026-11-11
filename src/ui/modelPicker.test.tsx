// @vitest-environment jsdom
// The composer's model picker and reasoning pill, driven through the signed-in app against a fake Hermes. Each test
// checks what reached Hermes and what the ui-prefs kept, not which handler ran.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { getUIPrefs, setUIPrefs, UI_PREFS_KEY } from "../hermes/uiPrefs";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const trigger = () => screen.getByRole("button", { name: /^Model:/ });
const pill = () => screen.queryByRole("button", { name: /^Reasoning effort:/ });
const picker = () => screen.getByRole("dialog", { name: "Choose a model" });
/** A model's row in the open picker: the button that picks it. */
const modelButton = (model: string) => within(picker()).getByRole("button", { name: new RegExp(`^${model.replace(/\./g, "\\.")}`) });
/** The open picker's sections, top to bottom. */
const sections = () => [...picker().querySelectorAll(".model-section")].map((g) => g.getAttribute("aria-label"));
/** An element's accessible name, as its aria-label gives it. */
const label = (el: Element | null) => el?.getAttribute("aria-label");
const configSets = (server: FakeHermes) => server.requests.filter((r) => r.method === "config.set").map((r) => r.params);
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** Signed in with two Active chats and the New chat pane on screen, the model list read. */
async function signedIn({ server = new FakeHermes() }: { server?: FakeHermes } = {}) {
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.sessionModel.set("nas", { model: "claude-haiku-4-5", provider: "anthropic", reasoning_effort: "low", fast: false });
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  const view = render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await act(() => hermes.loadModels());
  await settle(hermes);
  return { server, hermes, user, view };
}

async function choose(user: ReturnType<typeof userEvent.setup>, model: string) {
  await user.click(trigger());
  await user.click(modelButton(model));
}

describe("The model picker", () => {
  it("starts from the profile's own model, and lists Hermes's models under their providers", async () => {
    const { user } = await signedIn();
    expect(label(trigger())).toBe("Model: claude-sonnet-4-5");
    expect(label(pill())).toBe("Reasoning effort: Medium");
    expect(getUIPrefs().modelPicker).toEqual({ profile: "default", provider: "anthropic", model: "claude-sonnet-4-5" });

    await user.click(trigger());
    expect(sections()).toEqual(["Anthropic", "OpenAI"]);
    await user.type(within(picker()).getByRole("textbox", { name: "Search models" }), "gpt");
    expect(within(picker()).getAllByRole("button", { name: /^(claude|gpt)/ }).map((b) => b.textContent)).toEqual(["gpt-5", "gpt-4.1"]);
  });

  it("keeps the pick for new chats across a reconnect, and a restart, without touching the profile's default", async () => {
    const s = await signedIn();
    await choose(s.user, "gpt-5");
    expect(label(trigger())).toBe("Model: gpt-5");

    // The connection drops and comes back.
    act(() => s.server.drop());
    await act(() => s.hermes.reconnect());
    await settle(s.hermes);
    await s.user.type(composer(), "Hello{Enter}");
    await waitFor(() => expect(s.server.last("session.create")).toBeDefined());
    expect(s.server.last("session.create")!.params).toMatchObject({ model: "gpt-5", provider: "openai" });

    // The app starts again, on the same computer: the pick is in the stored ui-prefs document.
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).modelPicker).toEqual({ provider: "openai", model: "gpt-5", profile: "default" });
    s.view.unmount();
    await signedIn();
    expect(label(trigger())).toBe("Model: gpt-5");
    // Nothing was ever sent without a session: that would write the profile's config.
    expect(configSets(s.server).filter((p) => !p.session_id)).toEqual([]);
    expect(s.server.profileModel).toEqual({});
  });

  it("switches only the chat on screen, and new chats follow the pick", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await settle(hermes);
    const backup = hermes.getSnapshot().chats.find((c) => c.id === "backup")!.runtimeId;
    await choose(user, "claude-opus-4-5");
    await settle(hermes);

    expect(configSets(server)).toEqual([{ session_id: backup, profile: "default", key: "model", value: "claude-opus-4-5 --provider anthropic --session" }]);
    expect(server.sessionModel.get("backup")).toMatchObject({ model: "claude-opus-4-5" });
    expect(getUIPrefs().modelPicker).toMatchObject({ model: "claude-opus-4-5" });

    // Another chat shows the model it runs on, unchanged.
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    await settle(hermes);
    expect(label(trigger())).toBe("Model: claude-haiku-4-5");
    expect(label(pill())).toBe("Reasoning effort: Low");
    expect(server.sessionModel.get("nas")).toMatchObject({ model: "claude-haiku-4-5" });

    // A new chat starts on the pick.
    await user.keyboard("{Control>}n{/Control}");
    expect(label(trigger())).toBe("Model: claude-opus-4-5");
    await user.type(composer(), "Fresh{Enter}");
    await waitFor(() => expect(server.last("session.create")!.params).toMatchObject({ model: "claude-opus-4-5", provider: "anthropic" }));
    expect(server.profileModel).toEqual({});
  });

  it("stars a model into Favorites without picking it", async () => {
    const { server, user } = await signedIn();
    await user.click(trigger());
    await user.click(within(picker()).getByRole("button", { name: "Star gpt-5" }));

    expect(getUIPrefs().modelFavorites).toEqual(["openai/gpt-5"]);
    // Still open, nothing picked, nothing sent.
    expect(picker()).toBeTruthy();
    expect(label(trigger())).toBe("Model: claude-sonnet-4-5");
    expect(configSets(server)).toEqual([]);
    // Lifted out of its provider into Favorites, at the top.
    expect(sections()).toEqual(["Favorites", "Anthropic", "OpenAI"]);
    expect(within(picker().querySelector<HTMLElement>("[aria-label=Favorites]")!).getByRole("button", { name: /^gpt-5/ })).toBeTruthy();
    expect(within(picker().querySelector<HTMLElement>("[aria-label=OpenAI]")!).queryByRole("button", { name: /^gpt-5/ })).toBeNull();

    // Unstarring doesn't pick either.
    await user.click(within(picker()).getByRole("button", { name: "Unstar gpt-5" }));
    expect(getUIPrefs().modelFavorites).toEqual([]);
    expect(sections()).toEqual(["Anthropic", "OpenAI"]);
    expect(label(trigger())).toBe("Model: claude-sonnet-4-5");
  });

  it("keeps a starred model whose provider Hermes no longer lists, and doesn't let it be picked", async () => {
    setUIPrefs({ modelFavorites: ["openai/gpt-5", "anthropic/claude-opus-4-5"] });
    const server = new FakeHermes();
    // OpenAI is signed out on the server.
    server.modelOptionsResult = { providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-opus-4-5", "claude-sonnet-4-5"] }] };
    const { user } = await signedIn({ server });
    await user.click(trigger());

    expect(sections()).toEqual(["Favorites", "Anthropic"]);
    const fav = within(picker().querySelector<HTMLElement>("[aria-label=Favorites]")!);
    expect(fav.getByRole<HTMLButtonElement>("button", { name: /^gpt-5/ }).disabled).toBe(true);
    expect(fav.getByText("Unavailable")).toBeTruthy();
    expect(fav.getByRole<HTMLButtonElement>("button", { name: /^claude-opus-4-5/ }).disabled).toBe(false);
    expect(getUIPrefs().modelFavorites).toEqual(["openai/gpt-5", "anthropic/claude-opus-4-5"]);
  });

  it("shows a row's reasoning and fast options on hover", async () => {
    const { user } = await signedIn();
    await user.click(trigger());
    await user.hover(modelButton("gpt-5"));
    const options = within(picker()).getByRole("group", { name: "Options for gpt-5" });
    // GPT-5 can't turn reasoning off, and takes fast mode.
    expect(within(options).getAllByRole("button").map((b) => b.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    expect(within(options).getByRole("switch", { name: /Fast mode/ }).getAttribute("aria-checked")).toBe("false");

    await user.click(within(options).getByRole("switch", { name: /Fast mode/ }));
    expect(getUIPrefs().modelPicker).toMatchObject({ provider: "openai", model: "gpt-5", fast: true });
    expect(picker()).toBeTruthy();
    await user.click(within(picker()).getByRole("button", { name: "High" }));
    expect(getUIPrefs().modelPicker).toMatchObject({ provider: "openai", model: "gpt-5", fast: true, effort: "high" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(label(pill())).toBe("Reasoning effort: High");
  });

  it("picks with the arrow keys and Enter", async () => {
    const { user } = await signedIn();
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(getUIPrefs().modelPicker).toMatchObject({ model: "gpt-5" });
  });
});

describe("The reasoning pill", () => {
  it("hides for a model without reasoning control, and comes back for one with it", async () => {
    const { user } = await signedIn();
    expect(pill()).not.toBeNull();
    await choose(user, "gpt-4.1");
    expect(label(trigger())).toBe("Model: gpt-4.1");
    expect(pill()).toBeNull();
    await choose(user, "claude-opus-4-5");
    expect(label(pill())).toBe("Reasoning effort: Medium");
  });

  it("changes the effort of the chat on screen directly", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    await settle(hermes);
    await user.click(pill()!);
    const menu = screen.getByRole("menu", { name: "Reasoning effort" });
    expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual(["Off", "Low", "Medium", "High", "Extra high", "Max"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Max" }));
    await settle(hermes);
    expect(configSets(server)).toEqual([{ session_id: expect.any(String), profile: "default", key: "reasoning", value: "max", scope: "session" }]);
    expect(label(pill())).toBe("Reasoning effort: Max");
  });
});

describe("Profiles and the pick", () => {
  it("reseeds to the other profile's own model on switching", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [row("work-1", 1, { pinned: true, title: "Work chat" })] };
    server.profileModel.work = { model: "gpt-5", provider: "openai", reasoning_effort: "high", fast: false };
    const { hermes, user } = await signedIn({ server });
    await choose(user, "claude-opus-4-5");
    expect(getUIPrefs().modelPicker).toMatchObject({ profile: "default", model: "claude-opus-4-5" });

    await act(() => hermes.switchProfile("work"));
    await act(() => hermes.loadModels());
    await settle(hermes);
    await waitFor(() => expect(label(trigger())).toBe("Model: gpt-5"));
    expect(getUIPrefs().modelPicker).toEqual({ profile: "work", provider: "openai", model: "gpt-5" });
    expect(label(pill())).toBe("Reasoning effort: High");
    expect(server.profileModel.default).toBeUndefined();
    await act(() => hermes.switchProfile("default"));
    await act(() => hermes.loadModels());
    await settle(hermes);
    await waitFor(() => expect(label(trigger())).toBe("Model: claude-opus-4-5"));
  });
});
