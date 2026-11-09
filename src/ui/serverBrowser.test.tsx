// @vitest-environment jsdom
// Whether the Bot Desktop on the Hermes server has Chrome or Chromium (#218): the Screen tab's note and Settings →
// Diagnostics' row, against FakeHermes's `display.status` with the browser found, missing and not reported, for the
// profile in use.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { DisplayStatus, ScreenApi } from "../hermes/screen";
import { Main } from "../App";
import { DiagnosticsSettings } from "./Diagnostics";
import { ScreenTab } from "./Screen";

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

const PM_CHROMIUM = "/home/liam/.hermes/hermes-agent/pm/store/chromium/chrome-linux64/chrome";

function botDesktop(status: Record<string, unknown>, profiles?: Record<string, Record<string, unknown>>): FakeHermes["display"] {
  return {
    status: { supported: true, installed: true, missing: [], running: false, geometry: "1440x900", placement: "gateway", ...status },
    lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 },
    minted: new Set(),
    profiles,
  };
}

async function hermesFor(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  return hermes;
}

const NO_BROWSER = "No Chrome or Chromium on the Hermes server";

describe("The Screen tab", () => {
  it("says the server has no browser, with Hermes's fix to copy, and Check again finds one installed since", async () => {
    const s = new FakeHermes();
    s.display = botDesktop({ browser: null });
    const hermes = await hermesFor(s);
    const user = userEvent.setup();
    render(<ScreenTab api={hermes.screen} shown connected />);

    const note = (await screen.findByText(NO_BROWSER)).closest(".preview-state") as HTMLElement;
    expect(note.textContent).toMatch(/the agent can't open a browser on its screen/);
    expect(within(note).getByText("hermes pm install chromium")).toBeTruthy();
    await user.click(within(note).getByRole("button", { name: "Copy the command" }));
    expect(await navigator.clipboard.readText()).toBe("hermes pm install chromium");
    // The screen itself can still start: a missing browser fails only the agent's browser steps.
    expect(screen.getByRole("button", { name: /Start the screen/ })).toBeTruthy();

    s.display!.status.browser = PM_CHROMIUM;
    await user.click(within(note).getByRole("button", { name: /Check again/ }));
    await waitFor(() => expect(screen.queryByText(NO_BROWSER)).toBeNull());
    expect(screen.getByText(PM_CHROMIUM).closest("[role=status]")!.textContent).toBe(`Hermes found a browser on the server: ${PM_CHROMIUM}`);
    expect(s.requests.filter((r) => r.method === "display.status").map((r) => r.params.profile)).toEqual(["default", "default"]);
  });

  it.each([
    ["the clipboard turns the write down", { writeText: () => Promise.reject(new Error("denied")) }],
    ["there is no clipboard", undefined],
  ])("says the command wasn't copied when %s, rather than showing it was", async (_, clipboard) => {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    const s = new FakeHermes();
    s.display = botDesktop({ browser: null });
    const hermes = await hermesFor(s);
    render(<ScreenTab api={hermes.screen} shown connected />);
    const note = (await screen.findByText(NO_BROWSER)).closest(".preview-state") as HTMLElement;
    fireEvent.click(within(note).getByRole("button", { name: "Copy the command" }));
    expect((await within(note).findByRole("alert")).textContent).toBe("Couldn't copy it. Select the command and copy it yourself.");
    expect(within(note).getByRole("button", { name: "Copy the command" }).querySelector(".lucide-copy")).not.toBeNull();
  });

  it.each([
    ["Hermes found one", { browser: PM_CHROMIUM }],
    ["an older Hermes doesn't report it", {}],
    ["the screen runs in the terminal's sandbox, which brings its own", { browser: null, placement: "terminal:docker" }],
  ])("says nothing about the browser when %s", async (_, status) => {
    const s = new FakeHermes();
    s.display = botDesktop(status);
    const hermes = await hermesFor(s);
    render(<ScreenTab api={hermes.screen} shown connected />);
    await screen.findByRole("button", { name: /Start the screen/ });
    expect(screen.queryByText(NO_BROWSER)).toBeNull();
  });

  it("says nothing about the browser on a server that can't run the screen", async () => {
    const s = new FakeHermes();
    s.display = botDesktop({ supported: false, browser: null });
    const hermes = await hermesFor(s);
    render(<ScreenTab api={hermes.screen} shown connected />);
    await screen.findByText("This server can't run a screen");
    expect(screen.queryByText(NO_BROWSER)).toBeNull();
  });
});

describe("Settings → Diagnostics", () => {
  function diagnostics(hermes: Hermes, props: Partial<Parameters<typeof DiagnosticsSettings>[0]> = {}) {
    const all = { store: hermes.capabilities, connected: true, signIn: "Dashboard username and password", headers: 0, unsecure: false, profile: "default", openGuide: () => {}, screen: hermes.screen, ...props };
    const r = render(<DiagnosticsSettings {...all} />);
    return { rerender: (more: Partial<typeof all>) => r.rerender(<DiagnosticsSettings {...all} {...more} />) };
  }
  const browserRow = () => screen.getByText("Browser on the Hermes server").closest(".set-row") as HTMLElement;
  const shown = (text: string) => waitFor(() => expect(within(browserRow()).getByRole("status").textContent).toBe(text));

  it.each([
    ["the path Hermes found", { browser: PM_CHROMIUM }, PM_CHROMIUM, undefined],
    ["Not installed, with the fix", { browser: null }, "Not installed", /no Chrome or Chromium on the Hermes server.*hermes pm install chromium.*browser\.executable_path/i],
    ["Unknown on an older Hermes", {}, "Unknown", /^This Hermes doesn't report it\. Updating Hermes on the server adds it\.$/],
    ["Unknown for a screen in the terminal's sandbox", { browser: null, placement: "terminal:docker" }, "Unknown", /runs in the terminal's sandbox, which brings its own browser/],
    ["Unknown on a server that isn't Linux", { supported: false, browser: null }, "Unknown", /only on a Linux server/],
  ])("shows %s", async (_, status, value, note) => {
    const s = new FakeHermes();
    s.display = botDesktop(status);
    diagnostics(await hermesFor(s));
    await shown(value);
    const sub = browserRow().querySelector(".set-sub");
    if (note) expect(sub!.textContent).toMatch(note);
    else expect(sub).toBeNull();
  });

  it("says Unknown on a Hermes from before the Bot Desktop", async () => {
    const s = new FakeHermes();
    diagnostics(await hermesFor(s));
    await shown("Unknown");
    expect(browserRow().textContent).toMatch(/This Hermes doesn't report it/);
  });

  it("checks again when asked, once the owner has installed it", async () => {
    const s = new FakeHermes();
    s.display = botDesktop({ browser: null });
    diagnostics(await hermesFor(s));
    await shown("Not installed");
    s.display!.status.browser = PM_CHROMIUM;
    await userEvent.setup().click(screen.getByRole("button", { name: "Check the server's browser again" }));
    await shown(PM_CHROMIUM);
    expect(browserRow().querySelector(".set-sub")).toBeNull();
  });

  it("asks for the profile in use, and again when the profile changes", async () => {
    const s = new FakeHermes();
    s.otherProfiles = { work: [] };
    s.display = botDesktop({ browser: PM_CHROMIUM }, { work: { browser: null } });
    const hermes = await hermesFor(s);
    const { rerender } = diagnostics(hermes);
    await shown(PM_CHROMIUM);
    await act(() => hermes.switchProfile("work"));
    rerender({ profile: "work" });
    await shown("Not installed");
    expect(screen.getByText(/What profile work's screen on the server has/)).toBeTruthy();
    expect(s.requests.filter((r) => r.method === "display.status").map((r) => r.params.profile)).toEqual(["default", "work"]);
  });

  it("drops an answer about the profile shown before", async () => {
    const answers: ((s: DisplayStatus) => void)[] = [];
    const api: Pick<ScreenApi, "status"> = { status: () => new Promise((done) => answers.push(done)) };
    const s = new FakeHermes();
    const { rerender } = diagnostics(await hermesFor(s), { screen: api });
    await waitFor(() => expect(answers).toHaveLength(1));
    rerender({ profile: "work" });
    await waitFor(() => expect(answers).toHaveLength(2));
    const base: DisplayStatus = { supported: true, installed: true, missing: [], running: false, lease: { holder: "agent", since: 1, epoch: 0 }, profile_key: "/h" };
    act(() => answers[1]({ ...base, browser: null }));
    await shown("Not installed");
    act(() => answers[0]({ ...base, browser: PM_CHROMIUM }));
    await act(async () => {});
    expect(within(browserRow()).getByRole("status").textContent).toBe("Not installed");
  });

  it("asks nothing while disconnected", async () => {
    const s = new FakeHermes();
    s.display = botDesktop({ browser: null });
    diagnostics(await hermesFor(s), { connected: false });
    expect(within(browserRow()).getByRole("status").textContent).toBe("Connect to Hermes to check.");
    expect((screen.getByRole("button", { name: "Check the server's browser again" }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.requests.some((r) => r.method === "display.status")).toBe(false);
  });
});

describe("in the app", () => {
  it("shows the browser row in Settings → Diagnostics for the profile in use", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.display = botDesktop({ browser: null });
    const hermes = await hermesFor(s);
    render(
      <Main
        hermes={hermes}
        connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }}
        webPages={{ check: async () => ({ kind: "allowed" }) as never, openInBrowser: async () => null, devServers: async () => ({ server: { kind: "listed", ports: [] }, local: [] }) }}
        onSignOut={async () => {}}
      />,
    );
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    await shownIn("Not installed");
    expect(within(screen.getByRole("region", { name: "Bot Desktop" })).getByText("hermes pm install chromium")).toBeTruthy();
  });
  const shownIn = (text: string) =>
    waitFor(() => expect(within(screen.getByText("Browser on the Hermes server").closest(".set-row") as HTMLElement).getByRole("status").textContent).toBe(text));
});
