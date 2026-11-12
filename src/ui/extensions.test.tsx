// @vitest-environment jsdom
// Extensions in the running app, against a fake Hermes and a fake host frame (fakeExtensionHost.ts): Settings →
// Extensions, the bundled Chat stats in the "/" menu, its note and its view in the Preview, and that running it sends
// nothing to Hermes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { BUNDLED } from "../hermes/bundledExtensions";
import { Extensions } from "../hermes/extensions";
import { fakeHosts } from "../hermes/fakeExtensionHost";
import { ExtensionsContext } from "./extensionsContext";
import { ExtensionsSettings } from "./ExtensionsSettings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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

const STATS = BUNDLED[0].manifest.id;
const store = () => new Extensions({ catalogue: BUNDLED, startHost: fakeHosts(), storage: localStorage, log: () => {} });
let launches = 0;

async function launch(extensions: Extensions) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = { backup: [{ role: "user", text: "Back up the photos tonight" }, { role: "assistant", text: "Scheduled for 2am." }] };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(
    <ExtensionsContext.Provider value={extensions}>
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@ext-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />
    </ExtensionsContext.Provider>,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);

describe("Chat stats in the composer", () => {
  it("is offered after install, runs in its sandbox, answers under the composer and opens its view, sending nothing to Hermes", async () => {
    const x = store();
    x.install(STATS);
    const { server, hermes, user } = await launch(x);
    const items = hermes.getSnapshot().chats.find((c) => c.id === "backup")!.items.filter((i) => i.kind === "user" || i.kind === "assistant");
    await user.type(composer(), "/stats");
    const option = within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: /\/stats/ });
    expect(option.textContent).toContain("Extension");
    expect(screen.getByText("Chat stats", { selector: ".cmd-group" })).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(composer().value).toBe("/stats ");
    await user.keyboard("{Enter}");
    const words = items.reduce((n, i) => n + (i.text.match(/\S+/g)?.length ?? 0), 0);
    await screen.findByText(`${items.length} messages, ${words} words. The Chat stats view has the details.`);
    expect(composer().value).toBe("");
    const view = await screen.findByRole("region", { name: "Chat stats, an extension's view" });
    expect(within(view).getByText("For the chat “Nightly backup”")).toBeTruthy();
    expect(within(view).getByRole("rowheader", { name: "Both" })).toBeTruthy();
    expect(sent(server)).toEqual([]);
  });

  it("isn't offered when not installed or disabled, so /stats stays an ordinary message", async () => {
    const x = store();
    x.install(STATS);
    x.setEnabled(STATS, false);
    const { server, user } = await launch(x);
    await user.type(composer(), "/stats");
    expect(screen.getByText(/is called \/stats\. Enter sends it as an ordinary message\./)).toBeTruthy();
    await user.keyboard("{Escape}{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["/stats"]));
  });
});

describe("Settings → Extensions", () => {
  const show = (x: Extensions) =>
    render(
      <ExtensionsContext.Provider value={x}>
        <ExtensionsSettings />
      </ExtensionsContext.Provider>,
    );

  it("installs only after the owner reads what each permission means, then grants, disables and uninstalls", async () => {
    const x = store();
    show(x);
    const user = userEvent.setup();
    const section = screen.getByRole("region", { name: "Chat stats" });
    expect(within(section).getByText("Not installed.")).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "Install…" }));
    const ask = screen.getByRole("alertdialog", { name: "Install Chat stats?" });
    expect(ask.textContent).toContain("chat.read: Read the messages of the chat you run it in");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(x.getSnapshot()[0].installed).toBeUndefined();
    await user.click(within(section).getByRole("button", { name: "Install…" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Install" }));
    expect(x.getSnapshot()[0].installed?.grants).toEqual(["chat.read"]);
    expect(within(section).getByText("Not running. It starts when you run one of its commands.")).toBeTruthy();

    await user.click(within(section).getByRole("checkbox", { name: "Granted" }));
    expect(x.getSnapshot()[0].installed?.grants).toEqual([]);
    await user.click(within(section).getByRole("button", { name: "Disable" }));
    expect(within(section).getByText("Disabled.")).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "Enable" }));
    await user.click(within(section).getByRole("button", { name: "Uninstall" }));
    expect(x.getSnapshot()[0].installed).toBeUndefined();
    expect(within(section).getByRole("button", { name: "Install…" })).toBeTruthy();
  });
});
