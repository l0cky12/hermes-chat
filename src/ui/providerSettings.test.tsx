// @vitest-environment jsdom
// Settings → Providers on screen (ProviderSettings.tsx, ADR 0095), against the fake dashboard's `GET /api/env`: the saved
// keys with Hermes's redacted previews, adding and replacing a key with each result in words, removing one after asking
// and only once a read shows it gone, a server that can't take keys, and answers for another profile dropped. Every key
// here is synthetic, and none may appear anywhere on screen.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, useSyncExternalStore } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, fakeEnv } from "../hermes/fakeHermes";
import { RestError, type OpenPipe } from "../hermes/pipe";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { ProviderSettings } from "./ProviderSettings";
import { SettingsScreen } from "./Settings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const KEY = "sk-ant-SECRET-0001-abcdefgh";

/** Settings keeps the screen per profile: another profile's starts afresh. */
function Screen({ hermes, connected = true }: { hermes: Hermes; connected?: boolean }) {
  const profile = useSyncExternalStore(hermes.subscribe, () => hermes.profile);
  return <ProviderSettings key={profile} hermes={hermes} profile={profile} connected={connected} />;
}

async function shown({ s = new FakeHermes(), open = s.openPipe as OpenPipe, connected = true } = {}) {
  const hermes = await connect(open, "default");
  running.push(hermes);
  const user = userEvent.setup();
  render(<Screen hermes={hermes} connected={connected} />);
  return { s, hermes, user };
}

const rowOf = (label: string) => screen.getByText(label, { selector: ".set-name" }).closest(".set-row") as HTMLElement;
const savedRow = (label: string) => screen.queryByText(label, { selector: ".set-name" });
const onScreen = () => document.body.textContent ?? "";
const keyInput = () => screen.getByLabelText("API key") as HTMLInputElement;
const paste = async (user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) => {
  await user.click(field);
  await user.paste(text);
};

describe("Settings → Providers", () => {
  it("lists the saved keys by Hermes's redacted preview, says what Hermes can use, and offers the others to add", async () => {
    await shown();
    await screen.findByRole("heading", { name: "Saved keys" });
    expect(screen.getByText("Hermes can use Anthropic, OpenAI now.")).toBeTruthy();
    const row = rowOf("OpenRouter");
    expect(within(row).getByText("sk-…f3").tagName).toBe("CODE");
    expect(savedRow("Anthropic")).toBeNull();
    const options = within(screen.getByLabelText("Provider")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Anthropic", "DeepSeek", "Alibaba Cloud (DashScope)", "Alibaba Cloud China"]);
    expect(screen.getByText("https://console.anthropic.com/settings/keys", { selector: ".mono" })).toBeTruthy();
  });

  it("adds a key the provider accepts: it shows as saved, the input empties, and the key is nowhere on screen", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(await screen.findByText("Saved. Anthropic accepted the key.")).toBeTruthy();
    expect(s.savedKeys).toEqual([{ profile: "default", envVar: "ANTHROPIC_API_KEY", key: KEY }]);
    await waitFor(() => expect(savedRow("Anthropic")).toBeTruthy());
    expect(within(rowOf("Anthropic")).getByText(/…/, { selector: "code" })).toBeTruthy();
    expect(within(screen.getByLabelText("Provider")).queryByRole("option", { name: "Anthropic" })).toBeNull();
    expect(keyInput().value).toBe("");
    // The input is empty, so not even its markup holds the key.
    expect(document.body.innerHTML).not.toContain("SECRET");
  });

  it("says when Hermes couldn't check the key with the provider, and still saved it", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), "sk-offline");
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(await screen.findByText(/Saved, but Hermes couldn't check the key with Anthropic\./)).toBeTruthy();
    expect(s.savedKeys.map((k) => k.key)).toEqual(["sk-offline"]);
  });

  it("doesn't save a key the provider turns down, says so without the key, and keeps the provider to add", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    const note = await screen.findByRole("alert");
    expect(note.textContent).toMatch(/^Not saved: The provider turned the key down\./);
    expect(onScreen()).not.toContain("sk-bad");
    expect(s.savedKeys).toEqual([]);
    expect(savedRow("Anthropic")).toBeNull();
  });

  it("never shows an error that repeats the key it was given", async () => {
    const s = new FakeHermes();
    const open: OpenPipe = async (onEvent, profile, signal) => {
      const pipe = await s.openPipe(onEvent, profile, signal);
      return { ...pipe, saveProviderKey: async (_p, _e, key) => Promise.reject(new RestError(422, `input ${key}`)) };
    };
    const { user } = await shown({ s, open });
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not saved: Hermes's answer isn't shown, as it may repeat the key.");
    expect(onScreen()).not.toContain(KEY);
  });

  it("replaces a saved key from its row, and Cancel leaves it as it was", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Replace the OpenRouter key" }));
    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Cancel" }));
    expect(within(rowOf("OpenRouter")).getByRole("button", { name: "Replace the OpenRouter key" })).toBeTruthy();
    expect(s.savedKeys).toEqual([]);

    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Replace the OpenRouter key" }));
    const input = within(rowOf("OpenRouter")).getByLabelText("New OpenRouter key") as HTMLInputElement;
    expect(input.type).toBe("password");
    await paste(user, input, "sk-or-REPLACEMENT-0002");
    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Check and save the new OpenRouter key" }));
    expect(await within(rowOf("OpenRouter")).findByText("Saved. OpenRouter accepted the key.")).toBeTruthy();
    expect(s.savedKeys).toEqual([{ profile: "default", envVar: "OPENROUTER_API_KEY", key: "sk-or-REPLACEMENT-0002" }]);
    expect(within(rowOf("OpenRouter")).queryByLabelText("New OpenRouter key")).toBeNull();
    expect(onScreen()).not.toContain("REPLACEMENT");
  });

  it("keeps a replacement's input after the provider turns the key down, to fix and send again", async () => {
    const { user } = await shown();
    await screen.findByLabelText("Provider");
    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Replace the OpenRouter key" }));
    await paste(user, within(rowOf("OpenRouter")).getByLabelText("New OpenRouter key"), "sk-bad");
    await user.click(within(rowOf("OpenRouter")).getByRole("button", { name: "Check and save the new OpenRouter key" }));
    expect((await within(rowOf("OpenRouter")).findByRole("alert")).textContent).toMatch(/^Not saved: /);
    expect((within(rowOf("OpenRouter")).getByLabelText("New OpenRouter key") as HTMLInputElement).value).toBe("sk-bad");
  });

  it("asks before removing a key, and Cancel removes nothing", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await user.click(screen.getByRole("button", { name: "Remove the OpenRouter key" }));
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toContain("Remove the OpenRouter key from the default profile on the server?");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(s.removedKeys).toEqual([]);
    expect(savedRow("OpenRouter")).toBeTruthy();
  });

  it("removes a key: the row stays until a read shows it gone, then the provider can be added again", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    await user.click(screen.getByRole("button", { name: "Remove the OpenRouter key" }));
    // The re-read after the removal is held, as a slow Hermes would.
    let release = () => {};
    const rows = s.rest["GET /api/env"];
    s.rest["GET /api/env"] = () => new Promise((go) => (release = () => go(s.env)));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(s.removedKeys).toEqual([{ profile: "default", envVar: "OPENROUTER_API_KEY" }]));
    await waitFor(() => expect(release).not.toBe(undefined));
    expect(savedRow("OpenRouter")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Removing…/ }).hasAttribute("disabled")).toBe(true);

    s.rest["GET /api/env"] = rows;
    await act(async () => release());
    await waitFor(() => expect(savedRow("OpenRouter")).toBeNull());
    expect(screen.getByText("Removed the OpenRouter key from the default profile.")).toBeTruthy();
    expect(within(screen.getByLabelText("Provider")).getByRole("option", { name: "OpenRouter" })).toBeTruthy();
    expect(document.querySelector(".set-note")?.textContent).toBe("No provider key is saved in the default profile yet.");
  });

  it("says why a key wasn't removed, and the row stays", async () => {
    const { s, user } = await shown();
    await screen.findByLabelText("Provider");
    s.removeKeyFails = "Hermes still lists the OPENROUTER_API_KEY key as set after removing it.";
    await user.click(screen.getByRole("button", { name: "Remove the OpenRouter key" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not removed: Hermes still lists the OPENROUTER_API_KEY key as set after removing it.");
    expect(s.removedKeys).toEqual([]);
    expect(within(rowOf("OpenRouter")).getByText("sk-…f3")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does only one thing at a time: other buttons wait while a key is being checked", async () => {
    const s = new FakeHermes();
    const held: (() => void)[] = [];
    const open: OpenPipe = async (onEvent, profile, signal) => {
      const pipe = await s.openPipe(onEvent, profile, signal);
      return { ...pipe, saveProviderKey: async (...a) => (await new Promise<void>((go) => held.push(go)), pipe.saveProviderKey(...a)) };
    };
    const { user } = await shown({ s, open });
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(held).toHaveLength(1));
    for (const name of ["Replace the OpenRouter key", "Remove the OpenRouter key", /Checking…/])
      expect(screen.getByRole("button", { name }).hasAttribute("disabled"), String(name)).toBe(true);
    await act(async () => held.splice(0).forEach((go) => go()));
    await screen.findByText("Saved. Anthropic accepted the key.");
    expect(screen.getByRole("button", { name: "Replace the OpenRouter key" }).hasAttribute("disabled")).toBe(false);
  });

  it("offers no change on a server without GET /api/env, and says where to set keys instead", async () => {
    const s = new FakeHermes();
    s.env = undefined;
    await shown({ s });
    expect(await screen.findByText(/This Hermes server doesn't let Hermes Chat set provider keys \(.*404.*\)\. Set them on the server instead/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("says it isn't connected and offers no change", async () => {
    const { s } = await shown({ connected: false });
    expect(screen.getByText("Not connected to Hermes. The provider keys show once it's connected.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(s.restRequests.some((r) => r.path === "/api/env")).toBe(false);
  });

  it("offers a way to read again when Hermes doesn't answer, and shows the list once it does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = new FakeHermes();
      const rows = s.rest["GET /api/env"];
      s.rest["GET /api/env"] = () => new Promise(() => {});
      const hermes = await connect(s.openPipe, "default");
      running.push(hermes);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Screen hermes={hermes} />);
      await act(async () => vi.advanceTimersByTimeAsync(25_000));
      expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read the providers from Hermes");
      s.rest["GET /api/env"] = rows;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "Add a key" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Settings → Providers for another profile", () => {
  const heldList = (s: FakeHermes) => {
    let release = () => {};
    s.rest["GET /api/env"] = () => new Promise((go) => (release = () => go(fakeEnv())));
    return () => release();
  };
  const workEnv = () => {
    const env = fakeEnv();
    env.OPENROUTER_API_KEY = { ...env.OPENROUTER_API_KEY, is_set: false, redacted_value: null };
    env.ANTHROPIC_API_KEY = { ...env.ANTHROPIC_API_KEY, is_set: true, redacted_value: "sk-ant…9z" };
    return env;
  };

  it("drops a list that arrives for the profile shown before", async () => {
    const s = new FakeHermes();
    s.otherProfiles.work = [];
    const release = heldList(s);
    const { hermes } = await shown({ s });
    await screen.findByText("Asking Hermes…");
    await waitFor(() => expect(s.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    s.rest["GET /api/env"] = () => workEnv();
    await act(async () => hermes.switchProfile("work"));
    await waitFor(() => expect(savedRow("Anthropic")).toBeTruthy());
    expect(screen.getByText("work", { selector: ".mono" })).toBeTruthy();
    await act(async () => release());
    expect(savedRow("OpenRouter")).toBeNull();
    expect(savedRow("Anthropic")).toBeTruthy();
  });

  it("drops a list that arrives for the connection shown before, when it is put back under the same screen", async () => {
    const a = new FakeHermes();
    const release = heldList(a);
    const ha = await connect(a.openPipe, "default");
    const b = new FakeHermes();
    b.env = workEnv();
    const hb = await connect(b.openPipe, "default");
    running.push(ha, hb);
    const { rerender } = render(<Screen hermes={ha} />);
    await waitFor(() => expect(a.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    rerender(<Screen hermes={hb} />);
    await waitFor(() => expect(savedRow("Anthropic")).toBeTruthy());
    await act(async () => release());
    expect(savedRow("OpenRouter")).toBeNull();
    expect(savedRow("Anthropic")).toBeTruthy();
  });

  it("drops a save's answer that arrives after the connection under the screen changed", async () => {
    const a = new FakeHermes();
    const held: (() => void)[] = [];
    const open: OpenPipe = async (onEvent, profile, signal) => {
      const pipe = await a.openPipe(onEvent, profile, signal);
      return { ...pipe, saveProviderKey: async (...args) => (await new Promise<void>((go) => held.push(go)), pipe.saveProviderKey(...args)) };
    };
    const ha = await connect(open, "default");
    const b = new FakeHermes();
    const hb = await connect(b.openPipe, "default");
    running.push(ha, hb);
    const user = userEvent.setup();
    const { rerender } = render(<Screen hermes={ha} />);
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(held).toHaveLength(1));
    rerender(<Screen hermes={hb} />);
    await screen.findByLabelText("Provider");
    expect(keyInput().value).toBe("");
    await act(async () => held.splice(0).forEach((go) => go()));
    expect(screen.queryByText(/Saved\./)).toBeNull();
    expect(screen.getByRole("button", { name: "Replace the OpenRouter key" }).hasAttribute("disabled")).toBe(false);
  });

  it("empties the typed key when the profile changes, and a save under way for the old one doesn't land on the new", async () => {
    const s = new FakeHermes();
    s.otherProfiles.work = [];
    const held: (() => void)[] = [];
    const open: OpenPipe = async (onEvent, profile, signal) => {
      const pipe = await s.openPipe(onEvent, profile, signal);
      return { ...pipe, saveProviderKey: async (...a) => (await new Promise<void>((go) => held.push(go)), pipe.saveProviderKey(...a)) };
    };
    const { hermes, user } = await shown({ s, open });
    await screen.findByLabelText("Provider");
    await paste(user, keyInput(), KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(held).toHaveLength(1));

    await act(async () => hermes.switchProfile("work"));
    await screen.findByLabelText("Provider");
    expect(keyInput().value).toBe("");
    expect((screen.getByRole("button", { name: "Check and save" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => held.splice(0).forEach((go) => go()));
    expect(screen.queryByText(/Saved\./)).toBeNull();
    // The save went where it was asked for, the default profile, never work.
    expect(s.savedKeys.map((k) => k.profile)).toEqual(["default"]);
  });

  const heldRemoval = (s: FakeHermes, held: (() => void)[]): OpenPipe => async (onEvent, profile, signal) => {
    const pipe = await s.openPipe(onEvent, profile, signal);
    return { ...pipe, removeProviderKey: async (...a) => (await new Promise<void>((go) => held.push(go)), pipe.removeProviderKey(...a)) };
  };
  const removeOpenRouter = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Remove the OpenRouter key" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
  };

  it("drops a removal's re-read that would land after the connection under the screen changed", async () => {
    const a = new FakeHermes();
    const held: (() => void)[] = [];
    const ha = await connect(heldRemoval(a, held), "default");
    const b = new FakeHermes();
    b.env = workEnv();
    const hb = await connect(b.openPipe, "default");
    running.push(ha, hb);
    const user = userEvent.setup();
    const { rerender } = render(<Screen hermes={ha} />);
    await screen.findByLabelText("Provider");
    await removeOpenRouter(user);
    await waitFor(() => expect(held).toHaveLength(1));
    rerender(<Screen hermes={hb} />);
    await waitFor(() => expect(savedRow("Anthropic")).toBeTruthy());
    const reads = a.restRequests.filter((r) => r.path === "/api/env").length;

    await act(async () => held.splice(0).forEach((go) => go()));
    await waitFor(() => expect(a.removedKeys).toHaveLength(1));
    expect(a.restRequests.filter((r) => r.path === "/api/env").length).toBe(reads);
    expect(savedRow("Anthropic")).toBeTruthy();
    expect(savedRow("OpenRouter")).toBeNull();
    expect(screen.queryByText(/Removed the OpenRouter key/)).toBeNull();
  });

  it("opened again while a removal from before still runs, waits for it and then shows the key gone", async () => {
    const s = new FakeHermes();
    const held: (() => void)[] = [];
    const { hermes, user } = await shown({ s, open: heldRemoval(s, held) });
    await screen.findByLabelText("Provider");
    await removeOpenRouter(user);
    await waitFor(() => expect(held).toHaveLength(1));

    cleanup();
    render(<Screen hermes={hermes} />);
    await screen.findByText(/Asking Hermes/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "Replace the OpenRouter key" })).toBeNull();

    await act(async () => held.splice(0).forEach((go) => go()));
    await screen.findByLabelText("Provider");
    expect(savedRow("OpenRouter")).toBeNull();
    expect(s.removedKeys).toEqual([{ profile: "default", envVar: "OPENROUTER_API_KEY" }]);
  });

  it("trusts a read of the list after a removal that timed out once the key was already gone", async () => {
    const s = new FakeHermes();
    const open: OpenPipe = async (onEvent, profile, signal) => {
      const pipe = await s.openPipe(onEvent, profile, signal);
      return {
        ...pipe,
        removeProviderKey: async (...a) => {
          await pipe.removeProviderKey(...a);
          throw new Error("Hermes didn't finish removing the key within 30 s. It may have removed it anyway: the list of keys shows what Hermes has.");
        },
      };
    };
    const { user } = await shown({ s, open });
    await screen.findByLabelText("Provider");
    await removeOpenRouter(user);
    await waitFor(() => expect(savedRow("OpenRouter")).toBeNull());
    expect(screen.getByText("Removed the OpenRouter key from the default profile.")).toBeTruthy();
    expect(screen.queryByText(/Not removed/)).toBeNull();
  });

  it("keeps the list and offers to read again when the read after a removal fails, rather than calling the server unsupported", async () => {
    const s = new FakeHermes();
    const { user } = await shown({ s });
    await screen.findByLabelText("Provider");
    const rows = s.rest["GET /api/env"];
    s.rest["GET /api/env"] = () => {
      throw new RestError(500, `{"detail":"Internal server error"}`);
    };
    await removeOpenRouter(user);
    await screen.findByText("Removed the OpenRouter key, but the list couldn't be read again to confirm it.");
    expect(savedRow("OpenRouter")).toBeTruthy();
    expect(screen.queryByText(/doesn't let Hermes Chat set provider keys/)).toBeNull();

    s.rest["GET /api/env"] = rows;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(savedRow("OpenRouter")).toBeNull());
  });
});

describe("The Providers tab in Settings", () => {
  function Shell({ hermes }: { hermes: Hermes }) {
    const [appearance] = useState(() => appearanceStore({ getItem: () => null, setItem: () => {} }, document.createElement("html")));
    return (
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="liam"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={appearance}
        listFonts={async () => ({ all: [], mono: [] })}
        modelSettings={hermes.modelSettings}
        providers={hermes}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />
    );
  }

  async function settings() {
    const s = new FakeHermes();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    render(<Shell hermes={hermes} />);
    return { user };
  }

  it("sits right after Model, and its link opens the Model tab", async () => {
    const { user } = await settings();
    const names = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
    expect(names.indexOf("Providers")).toBe(names.indexOf("Model") + 1);
    await user.click(screen.getByRole("tab", { name: "Providers" }));
    await screen.findByRole("heading", { name: "Saved keys" });
    await user.click(screen.getByRole("button", { name: "Settings → Model" }));
    expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  });

  it("is searched: its sections show for what they say", async () => {
    const { user } = await settings();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "saved on the server");
    await screen.findByRole("heading", { name: "Saved keys" });
    const showing = (heading: string) => !screen.getByRole("heading", { name: heading, level: 2 }).closest("[data-search-miss]");
    await waitFor(() => expect(showing("Saved keys")).toBe(true));
    expect(showing("Add a key")).toBe(false);
  });
});
