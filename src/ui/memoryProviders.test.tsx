// @vitest-environment jsdom
// Settings → Memory → External memory on screen, against the fake dashboard: the profiles' providers and shared stores,
// switching, saving settings, copying another profile's to share its memory, installing, refusals and unsaved changes.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { BYTEROVER, HONCHO, RETAINDB, type FakeProvider } from "../hermes/fakeMemoryProviders";
import { connect } from "../hermes/transport";
import { MemoryProviderSettings } from "./MemoryProviderSettings";
import { LinksProvider } from "./previewContext";
import { SettingsScreen } from "./Settings";
import { appearanceStore } from "./appearance";
import { searchText } from "./settingsSearch";

afterEach(cleanup);

async function shown(opts: { profile?: string; connected?: boolean; honcho?: Partial<FakeProvider> } = {}) {
  const server = new FakeHermes();
  server.otherProfiles = { research: [], work: [] };
  const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"], ...opts.honcho }, { ...RETAINDB }, { ...BYTEROVER });
  fake.active = { default: "honcho", research: "honcho", work: "" };
  fake.set("default", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
  fake.setSecret("default", "honcho", "apiKey");
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  const dirty: boolean[] = [];
  const preview = vi.fn();
  const openInBrowser = vi.fn(async () => "Firefox");
  const view = (discardSignal = 0) => (
    <LinksProvider preview={preview} web={{ openInBrowser }} onToast={() => {}}>
      <MemoryProviderSettings api={hermes.memoryProviders} profile={opts.profile ?? "default"} connected={opts.connected ?? true} onDirtyChange={(d) => dirty.push(d)} discardSignal={discardSignal} />
    </LinksProvider>
  );
  const r = render(view());
  if (opts.connected !== false) await screen.findByRole("table", { name: "Memory provider by profile" });
  return { server, fake, user, dirty, preview, openInBrowser, rerender: (signal: number) => r.rerender(view(signal)) };
}

const table = () => screen.getByRole("table", { name: "Memory provider by profile" });
const rowOf = (profile: string) => within(table()).getByRole("button", { name: profile }).closest("tr") as HTMLElement;
const providers = (profile: string) => screen.findByRole("list", { name: `Memory providers for ${profile}` });

describe("Settings → Memory → External memory", () => {
  it("shows every profile's provider, and which profiles share a Honcho store", async () => {
    const { fake, user } = await shown();
    expect(rowOf("default").textContent).toMatch(/honcho/);
    expect(rowOf("default").textContent).toMatch(/Workspace: shared-ws/);
    expect(rowOf("research").textContent).toMatch(/Workspace: hermes_research/);
    expect(rowOf("default").textContent).toMatch(/No other profile on this store/);
    expect(rowOf("work").textContent).toMatch(/Built-in only/);
    expect(rowOf("work").textContent).toMatch(/Its own files/);
    fake.set("research", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await waitFor(() => expect(rowOf("default").textContent).toMatch(/Same store as research/));
    expect(rowOf("research").textContent).toMatch(/Same store as default/);
  });

  it("starts on the app's profile and manages any other from the table", async () => {
    const { user } = await shown();
    expect(within(await providers("default")).getByText("honcho")).toBeTruthy();
    await user.click(within(table()).getByRole("button", { name: "work" }));
    const list = await providers("work");
    expect(within(list).queryByText("honcho")).toBeNull();
    expect(within(list).getByText("retaindb")).toBeTruthy();
    expect(within(list).getByText(/Built-in only/).closest(".provider-row")!.textContent).toMatch(/In use/);
  });

  it("shares a profile's memory by copying its settings, then saving them for the other profile", async () => {
    const { fake, user } = await shown();
    await user.click(within(table()).getByRole("button", { name: "research" }));
    await user.click(within(await providers("research")).getByRole("button", { name: /honcho/ }));
    await user.selectOptions(await screen.findByRole("combobox", { name: /Copy settings from another profile/ }), "default");
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Copied 3 settings from default.*API key isn't copied/);
    expect((screen.getByLabelText(/Workspace/) as HTMLInputElement).value).toBe("shared-ws");
    await user.type(screen.getByLabelText(/API key/), "k-research");
    await user.click(screen.getByRole("button", { name: "Save and use for research" }));
    await screen.findByText(/Saved Honcho for research, and read back from Hermes/);
    expect(fake.writes.at(-1)).toMatchObject({ profile: "research", body: { values: { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner", apiKey: "k-research" } } });
    await waitFor(() => expect(rowOf("research").textContent).toMatch(/Same store as default/));
    // The typed key is gone from the form once saved; Hermes says only that it's set.
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Set on the server/)).toBeTruthy();
  });

  it("switches a profile to built-in memory only, and back to a ready provider", async () => {
    const { fake, user } = await shown();
    await providers("default");
    await user.click(screen.getByRole("button", { name: "Use for default" }));
    await screen.findByText(/default now uses built-in memory only, and read back/);
    expect(fake.active.default).toBe("");
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.click(await screen.findByRole("button", { name: "Use for default" }));
    await screen.findByText(/default now uses honcho, and read back/);
    expect(fake.active.default).toBe("honcho");
  });

  it("says a legacy save Hermes refused as not ready kept its settings but didn't switch", async () => {
    const { fake, user } = await shown();
    await user.click(within(table()).getByRole("button", { name: "work" }));
    await user.click(within(await providers("work")).getByRole("button", { name: /retaindb/ }));
    expect(await screen.findByText(/settings aren't complete/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use for work" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/^Project/), "p1");
    await user.click(screen.getByRole("button", { name: "Save and use for work" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/saved the settings but didn't switch work.*not ready/);
    expect(fake.values.work.retaindb.project).toBe("p1");
    expect(fake.active.work).toBe("");
    // What Hermes wrote isn't left marked unsaved.
    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(screen.getByRole("button", { name: "Use for work" })).toBeTruthy();
  });

  it("refuses a value Hermes would refuse, before sending", async () => {
    const { fake, user } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.click(await screen.findByText(/More settings/));
    await user.type(screen.getByLabelText(/Request timeout/), "soon");
    expect(screen.getByText("Request timeout must be a number.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save and use for default" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fake.writes).toEqual([]);
  });

  it("says nothing was sent when another client changed the setting meanwhile", async () => {
    const { fake, user } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.clear(await screen.findByLabelText(/Workspace/));
    await user.type(screen.getByLabelText(/Workspace/), "mine");
    fake.set("default", "honcho", { workspace: "theirs" });
    await user.click(screen.getByRole("button", { name: "Save and use for default" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was sent: Workspace changed on the server/);
    expect(fake.writes).toEqual([]);
  });

  it("installs what a provider needs only after showing the commands", async () => {
    const { fake, user } = await shown();
    await user.click(within(table()).getByRole("button", { name: "work" }));
    await user.click(within(await providers("work")).getByRole("button", { name: /byterover/ }));
    await user.click(await screen.findByRole("button", { name: /Install on the server/ }));
    const ask = screen.getByRole("alertdialog", { name: "Install byterover on the server?" });
    expect(ask.textContent).toMatch(/curl -fsSL https:\/\/byterover.dev\/install.sh \| sh/);
    expect(fake.writes).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Install" }));
    await screen.findByText(/Hermes ran byterover's setup on the server/);
    expect(screen.getByRole("list", { name: "Setup output" }).textContent).toMatch(/brv — installed/);
    expect(fake.writes).toEqual([{ method: "POST", path: "/api/memory/providers/byterover/setup", profile: "work", body: { values: {} } }]);
  });

  it("says when Hermes needs a restart before chats can use what it installed", async () => {
    const { fake, user } = await shown();
    fake.providers.find((p) => p.name === "honcho")!.installed = false;
    fake.providers.find((p) => p.name === "honcho")!.restartAfterSetup = true;
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Memory providers for default" })).getByText("honcho").closest(".provider-row")!.textContent).toMatch(/Unavailable/));
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.click(await screen.findByRole("button", { name: /Install on the server/ }));
    expect(screen.getByRole("alertdialog", { name: "Install honcho on the server?" }).textContent).toMatch(/hermes pm install/);
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Restart Hermes there before chats can use them/);
    expect(screen.getByRole("list", { name: "Setup output" }).textContent).toMatch(/honcho — installed; restart Hermes to use it/);
  });

  it("asks before dropping unsaved settings, and reports them as unsaved", async () => {
    const { user, dirty, rerender } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.type(await screen.findByLabelText(/Peer name/), "x");
    expect(dirty.at(-1)).toBe(true);
    await user.click(within(table()).getByRole("button", { name: "work" }));
    const ask = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText(/Peer name/) as HTMLInputElement).value).toBe("ownerx");
    // Discarded from outside (App's question): the change goes.
    rerender(1);
    await waitFor(() => expect(dirty.at(-1)).toBe(false));
    expect((screen.getByLabelText(/Peer name/) as HTMLInputElement).value).toBe("owner");
  });

  it("asks before Built-in only drops unsaved provider settings", async () => {
    const { fake, user } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.type(await screen.findByLabelText(/Peer name/), "x");
    await user.click(screen.getByRole("button", { name: "Use for default" }));
    const ask = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    expect(fake.writes).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Discard changes" }));
    await screen.findByText(/default now uses built-in memory only/);
    expect(fake.active.default).toBe("");
  });

  it("copies against what the target has now, not when it was opened", async () => {
    const { fake, user } = await shown();
    await user.click(within(table()).getByRole("button", { name: "research" }));
    await user.click(within(await providers("research")).getByRole("button", { name: /honcho/ }));
    await screen.findByLabelText(/Workspace/);
    // Meanwhile another client set research's peer name to default's.
    fake.set("research", "honcho", { peerName: "owner" });
    await user.selectOptions(screen.getByRole("combobox", { name: /Copy settings from another profile/ }), "default");
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Copied 2 settings from default/);
    expect((screen.getByLabelText(/Peer name/) as HTMLInputElement).value).toBe("owner");
  });

  it("marks Honcho settings kept for every profile on its config file", async () => {
    const { user } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    const base = await screen.findByLabelText(/Base URL/);
    expect(base.closest("label")!.textContent).toMatch(/All profiles on this file/);
    await user.type(base, "https://honcho.example");
    expect(base.closest("label")!.textContent).toMatch(/every profile that reads the same Honcho config file, not only default/);
  });

  it("is part of the Memory tab, whose unsaved state covers both memory entries and provider settings", async () => {
    const server = new FakeHermes();
    server.memoryProviders.add({ ...HONCHO });
    server.memoryProviders.active = { default: "honcho" };
    const hermes = await connect(server.openPipe, "default");
    const user = userEvent.setup();
    const dirty: boolean[] = [];
    const storage = new Map<string, string>();
    const appearance = appearanceStore({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) }, document.createElement("html"));
    render(
      <SettingsScreen
        status="connected" unsecure={false} username="liam" passwordSaved profile="default" olderPulled={false} cacheBytes={() => 0}
        appearance={appearance} listFonts={async () => ({ all: [], mono: [] })} modelSettings={hermes.modelSettings} memory={hermes.memory} memoryProviders={hermes.memoryProviders}
        onMemoryDirty={(d) => void dirty.push(d)} onClearCache={() => {}} onPullOlder={async () => []} onSignOut={async () => {}} onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    // External memory is one of the Memory tab's sections in the sidebar's tree (ADR 0159); it opens on the profile in use.
    await user.click(within(screen.getByRole("group", { name: "Memory: sections" })).getByRole("button", { name: "External memory" }));
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.type(await screen.findByLabelText(/Peer name/), "x");
    await waitFor(() => expect(dirty.at(-1)).toBe(true));
    await user.clear(screen.getByLabelText(/Peer name/));
    await waitFor(() => expect(dirty.at(-1)).toBe(false));
  });

  it("says when the server has no memory provider routes", async () => {
    const server = new FakeHermes();
    server.memoryProviders.routes = false;
    const hermes = await connect(server.openPipe, "default");
    render(<MemoryProviderSettings api={hermes.memoryProviders} profile="default" connected onDirtyChange={() => {}} />);
    expect(await screen.findByText(/doesn't list memory providers/)).toBeTruthy();
  });
});

describe("Settings → Memory → External memory as cards of rows (ADR 0059)", () => {
  const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;

  it("puts the profiles' table and each profile's providers in cards, a provider's settings under its row", async () => {
    const { user } = await shown();
    const external = section("External memory");
    expect(table().closest(".set-card")!.parentElement).toBe(external);
    expect(within(external).getByRole("button", { name: /Reload/ }).closest(".set-head")).toBeTruthy();
    const list = await providers("default");
    const manage = section("Provider for default");
    expect(list.parentElement).toBe(manage.querySelector(":scope > .set-card"));
    await user.click(within(list).getByRole("button", { name: /honcho/ }));
    const settings = await screen.findByRole("group", { name: "honcho settings for default" });
    expect(settings.classList.contains("set-block")).toBe(true);
    expect(settings.closest("li")).toBe(within(list).getByRole("button", { name: /honcho/ }).closest("li"));
  });

  it("folds the longer help behind an (i), where Settings search still reads it", async () => {
    const { user } = await shown();
    await providers("default");
    for (const [title, words] of [
      ["External memory", /Profiles use the same memory only when they use the same provider pointed at the same store/],
      ["Provider for default", /hermes -p default plugins install <name>/],
    ] as const) {
      const s = section(title);
      const about = within(s).getByRole("button", { name: `About ${title}` });
      expect(about.getAttribute("aria-expanded")).toBe("false");
      const help = s.querySelector<HTMLElement>(":scope > .set-more")!;
      expect(help.hidden).toBe(true);
      expect(help.textContent).toMatch(words);
      expect(searchText(s)).toMatch(words);
      await user.click(about);
      expect(about.getAttribute("aria-expanded")).toBe("true");
      expect(help.hidden).toBe(false);
    }
  });

  it("never folds what a write came to, or the question before unsaved settings go", async () => {
    const { user } = await shown();
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await user.type(await screen.findByLabelText(/Peer name/), "x");
    await user.click(within(table()).getByRole("button", { name: "work" }));
    const ask = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    expect(ask.closest(".set-more")).toBeNull();
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Use for default" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your changes?" })).getByRole("button", { name: "Discard changes" }));
    const done = await screen.findByText(/default now uses built-in memory only/);
    expect(done.closest(".set-more")).toBeNull();
    expect(done.closest(".set-card")).toBeTruthy();
  });

  it("shows no link for an address the server sent that isn't a web page (#345)", async () => {
    const { user } = await shown({ honcho: withLinks("file:///etc/passwd") });
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    await screen.findByRole("group", { name: "honcho settings for default" });
    expect(document.querySelector('a[href="file:///etc/passwd"]')).toBeNull();
    expect(screen.queryByText(/Get one/)).toBeNull();
    expect(screen.queryByText(/Honcho documentation/)).toBeNull();
  });

  it("opens the link menu on a click of Get one or the provider's documentation, and the browser from it (#345)", async () => {
    const { user, preview, openInBrowser } = await shown({ honcho: withLinks("https://example.com/docs") });
    await user.click(within(await providers("default")).getByRole("button", { name: /honcho/ }));
    for (const name of [/Get one/, /Honcho documentation/]) {
      await user.click(await screen.findByRole("link", { name }));
      const menu = screen.getByRole("menu", { name: "Link" });
      expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
    }
    fireEvent.contextMenu(screen.getByRole("link", { name: /Honcho documentation/ }));
    await user.click(within(screen.getByRole("menu", { name: "Link" })).getByRole("menuitem", { name: "Open in your browser" }));
    expect(openInBrowser).toHaveBeenCalledWith("https://example.com/docs");
    expect(preview).not.toHaveBeenCalled();
  });
});

const withLinks = (url: string): Partial<FakeProvider> => ({ docsUrl: url, fields: HONCHO.fields.map((f) => (f.kind === "secret" ? { ...f, url } : f)) });
