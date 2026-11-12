// @vitest-environment jsdom
// Connection diagnostics and the note a screen shows when Hermes lacks its feature (Diagnostics.tsx), alone and in the
// app, against FakeHermes as a new Hermes and as one without some routes. Every version, path and secret is a fixture.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { CapabilityStore, guideUrl, type CapabilityIO } from "../hermes/capabilities";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { CapabilityGate, DiagnosticsSettings } from "./Diagnostics";
import { SettingsSearching } from "./SettingRows";
import { queryWords, searchText, textMatches } from "./settingsSearch";
import { RestError } from "../hermes/pipe";

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

/** A store over scripted answers: each key `GET path` or `RPC method`; an Error rejects, a function holds back. */
function scriptedStore(answers: Record<string, unknown>) {
  const answer = (key: string): Promise<unknown> => {
    const a = answers[key];
    if (a === undefined) return Promise.reject(new RestError(404, `{"detail":"Not Found"}`));
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === "function") return (a as () => Promise<unknown>)();
    return Promise.resolve(a);
  };
  const io: CapabilityIO = {
    get: (p) => answer(`GET ${p.split("?")[0]}`).then((v) => JSON.stringify(v)),
    rpc: (m) => answer(`RPC ${m}`),
  };
  return new CapabilityStore(io, () => 1, Date.now, 500, 0);
}

const NEW = {
  "GET api/health": { version: "0.17.0", displayVersion: "0.17.0", commit: "74b2ed65e6", auth_required: true },
  "GET api/status": { version: "0.17.0", release_date: "2026-11-01", auth_providers: ["basic"] },
  "RPC gateway.capabilities": { per_session_exclusive_submit: true },
  "RPC projects.list": { projects: [] },
  "RPC commands.catalog": {},
  "RPC session.active_list": { sessions: [] },
  "RPC subagent.roster": { sessions: [] },
  "RPC learning.detail": { ok: false },
  "RPC profiles.list": { profiles: [{ name: "default", is_default: true, canonical_session: null }] },
  "GET api/tools/toolsets": [],
  "GET api/profiles/default/soul": {},
  "GET api/profiles": { profiles: [] },
  "GET api/skills": [],
  "GET api/files": {},
  "GET api/cron/jobs": [],
  "GET api/webhooks": { subscriptions: [] },
  "GET api/fs/list": {},
};

function diagnostics(store: CapabilityStore, props: Partial<Parameters<typeof DiagnosticsSettings>[0]> = {}) {
  const openGuide = vi.fn();
  const copyText = vi.fn(async (_text: string) => {});
  render(
    <DiagnosticsSettings
      store={store}
      connected
      server="https://hermes.fixture.invalid"
      signIn="Dashboard username and password, at the dashboard's URL"
      headers={1}
      unsecure={false}
      profile="default"
      openGuide={openGuide}
      copyText={copyText}
      {...props}
    />,
  );
  return { openGuide, copyText };
}

const row$ = (label: string) => screen.getByRole("rowheader", { name: new RegExp(`^${label}`) }).closest("tr")!;

describe("Connection diagnostics", () => {
  it("says nothing is checked yet before a connection, and offers no check", () => {
    diagnostics(scriptedStore(NEW), { connected: false });
    expect(screen.getByRole("status").textContent).toMatch(/Connect to Hermes to check what it supports/);
    expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row$("Projects")).getByText("Unknown")).toBeTruthy();
    // Neither the version nor the feature flags.
    expect(screen.getAllByText("Not read yet")).toHaveLength(2);
  });

  it("shows the check under way, then the server and each feature with when it was checked", async () => {
    let answer!: (v: unknown) => void;
    const store = scriptedStore({ ...NEW, "RPC projects.list": () => new Promise((r) => (answer = r)) });
    diagnostics(store);
    act(() => store.connected(1, "default", { change_events: true }, Promise.resolve({ server_requests: ["approval"] })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checking what this Hermes server supports/));
    expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ projects: [] }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checked just now/));
    expect(screen.getByText("0.17.0").className).toMatch(/mono/);
    expect(screen.getByText("Legacy session protocol")).toBeTruthy();
    expect(screen.getByText(/the dashboard offers basic/)).toBeTruthy();
    expect(screen.getByText("per_session_exclusive_submit")).toBeTruthy();
    expect(screen.getByText("1, whose values are never shown")).toBeTruthy();
    expect(within(row$("Projects")).getByText("Supported")).toBeTruthy();
    expect(within(row$("Projects")).getByText(/checked/)).toBeTruthy();
    expect(within(row$("Approvals")).getByText(/Hermes says so/)).toBeTruthy();
  });

  it("says what a missing feature needs, and links to its part of the guide", async () => {
    const store = scriptedStore({ ...NEW, "GET api/files": new RestError(404, `{"detail":"Not Found"}`) });
    const { openGuide } = diagnostics(store);
    act(() => store.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] })));
    await waitFor(() => expect(within(row$("Server files")).getByText("Not supported")).toBeTruthy());
    const r = row$("Server files");
    expect(within(r).getByText(/Hermes has no such route \(it answered 404\)/)).toBeTruthy();
    expect(within(r).getByText(/Needs: The dashboard's managed-files routes/)).toBeTruthy();
    await userEvent.setup().click(within(r).getByRole("button", { name: "Compatibility guide: Server files" }));
    expect(openGuide).toHaveBeenCalledWith(guideUrl("serverFiles"));
    expect(guideUrl("serverFiles")).toBe("https://github.com/l0cky12/hermes-chat/blob/main/docs/compatibility.md#server-files");
  });

  it("says so when Hermes answered no check at all", async () => {
    const down = new Error("Can't reach the Hermes dashboard: connection refused");
    const store = scriptedStore(Object.fromEntries(Object.keys(NEW).map((k) => [k, down])));
    diagnostics(store);
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/Hermes didn't answer any check/));
    expect(within(row$("Skills")).getByText("Couldn't check")).toBeTruthy();
  });

  it("names a change Hermes was found to lack in its row, while the rest of the feature stays supported", async () => {
    const store = scriptedStore(NEW);
    diagnostics(store);
    act(() => store.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checked/));
    act(() => store.observeWrite(1, { route: "api/profiles/work", verb: "PATCH" }, new RestError(405, `{"detail":"Method Not Allowed"}`)));
    expect(within(row$("Profiles")).getByText(/Hermes has no route for PATCH \/api\/profiles\/\{name\}, so that change is disabled/)).toBeTruthy();
    expect(within(row$("Profiles")).getByText("Supported")).toBeTruthy();
  });

  it("copies a report without secrets, and says so", async () => {
    const store = scriptedStore({
      ...NEW,
      "GET api/skills": new RestError(500, `{"detail":"boom Authorization: Bearer sk-ant-api03-fixturefixturefixture0001"}`),
    });
    const { copyText } = diagnostics(store, { server: "https://owner:fixture-password@hermes.fixture.invalid" });
    act(() => store.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checked/));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Copy report" }));
    const text = copyText.mock.calls[0][0];
    expect(text).toMatch(/Skills: Couldn't check/);
    expect(text).not.toMatch(/fixture-password|sk-ant-api03/);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("Report copied, with secrets taken out.")).toBeTruthy();
  });

  it("never shows a fact Hermes sent that looks like a secret", async () => {
    const store = scriptedStore({
      ...NEW,
      "GET api/health": { version: "token=fixtureSecret123", displayVersion: "0.17.0", commit: "74b2ed65e6" },
      "GET api/status": { version: "0.17.0", release_date: "password=fixturePassword9", auth_providers: ["basic", "sk-ant-api03-fixturefixturefixture"] },
    });
    diagnostics(store);
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checked/));
    expect(document.body.textContent).not.toMatch(/fixtureSecret123|fixturePassword9|sk-ant-api03/);
    expect(screen.getByText("0.17.0")).toBeTruthy();
  });

  it("says when the report couldn't be copied", async () => {
    const store = scriptedStore(NEW);
    diagnostics(store, { copyText: () => Promise.reject(new Error("denied")) });
    await userEvent.setup().click(screen.getByRole("button", { name: "Copy report" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't put the report on the clipboard/);
  });

  it("checks again when asked", async () => {
    const store = scriptedStore(NEW);
    diagnostics(store);
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checked/));
    const refresh = vi.spyOn(store, "refresh");
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("brings the feature a note named into view, focused", async () => {
    const store = scriptedStore(NEW);
    diagnostics(store, { focus: { id: "scheduledJobs" } });
    await waitFor(() => expect(document.activeElement).toBe(row$("Scheduled jobs")));
  });

  it("shows what it last knew while disconnected", async () => {
    const store = scriptedStore(NEW);
    const { rerender } = render(<div />);
    act(() => store.connected(1, "default", {}, Promise.resolve({ server_requests: ["approval"] })));
    await waitFor(() => expect(store.getSnapshot().checkedAt).toBeDefined());
    act(() => store.disconnected());
    rerender(
      <DiagnosticsSettings store={store} connected={false} signIn="x" headers={0} unsecure={false} profile="default" openGuide={() => {}} />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Not connected: as last checked/);
    expect(within(row$("Projects")).getByText("Supported")).toBeTruthy();
  });
});

describe("Diagnostics' layout (#174, ADR 0059)", () => {
  const section = (name: string) => screen.getByRole("region", { name });
  const help = (about: string) => {
    const button = screen.getByRole("button", { name: `About ${about}` });
    return { button, panel: document.getElementById(button.getAttribute("aria-controls")!)! };
  };

  it("shows the server's facts as rows of a name and a value, and the features table in a card", () => {
    diagnostics(scriptedStore(NEW), { unsecure: true });
    const server = section("Server");
    const names = [...server.querySelectorAll(".set-card > .set-row .set-name")].map((n) => n.textContent);
    expect(names).toEqual(["Server", "Profile", "Hermes version", "Protocol", "Sign-in", "Feature flags", "Extra request headers"]);
    const first = server.querySelector(".set-card > .set-row")!;
    expect(first.querySelector(".set-control .set-value")!.textContent).toMatch(/^https:\/\/hermes\.fixture\.invalid Unsecure$/);
    const features = section("Features");
    expect(features.querySelector(".set-card > .set-block table")).toBe(screen.getByRole("table"));
    expect(within(features).getByRole("button", { name: "Read the compatibility guide" }).closest(".set-row")).not.toBeNull();
    // Check again and Copy report act on the whole section, so they sit at its heading.
    expect(within(features).getByRole("button", { name: "Check again" }).closest(".set-head-action")).not.toBeNull();
    expect(within(features).getByRole("button", { name: "Copy report" }).closest(".set-head-action")).not.toBeNull();
  });

  it("keeps Check again and Copy report on one line each, wrapping the pair under the heading when the row is too narrow (#537)", () => {
    // jsdom lays nothing out, so this reads the rules the screenshots in #537's PR show: a label never wraps inside its
    // 32px button, and the heading row wraps instead, its buttons starting a line of their own at the left.
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync("src/styles.css", "utf8") as string;
    document.head.append(sheet);
    try {
      diagnostics(scriptedStore(NEW));
      const features = section("Features");
      for (const name of ["Check again", "Copy report"]) expect(getComputedStyle(within(features).getByRole("button", { name })).whiteSpace).toBe("nowrap");
      const head = features.querySelector(".set-head")!;
      expect([getComputedStyle(head).flexWrap, getComputedStyle(head).justifyContent]).toEqual(["wrap", "space-between"]);
      expect([...head.children].map((c) => c.className)).toEqual(["set-head-title", "set-head-action"]);
      expect(head.querySelector(".set-head-title > h2")!.textContent).toBe("Features");
    } finally {
      sheet.remove();
    }
  });

  it("folds the explanations behind an (i), opens them while Settings is searched, and search still finds their words", async () => {
    const store = scriptedStore(NEW);
    const { rerender } = render(<div />);
    const page = (searching: boolean) => (
      <SettingsSearching.Provider value={searching}>
        <DiagnosticsSettings store={store} connected signIn="x" headers={0} unsecure={false} profile="default" openGuide={() => {}} />
      </SettingsSearching.Provider>
    );
    rerender(page(false));
    const server = help("Server");
    const features = help("Features");
    expect(server.button.getAttribute("aria-expanded")).toBe("false");
    expect(server.panel.hidden).toBe(true);
    expect(server.panel.textContent).toMatch(/A version alone doesn't show what it can do/);
    expect(features.panel.hidden).toBe(true);
    expect(features.panel.textContent).toMatch(/The report holds no password, cookie, ticket or header value/);
    await userEvent.setup().click(features.button);
    expect(features.button.getAttribute("aria-expanded")).toBe("true");
    expect(features.panel.hidden).toBe(false);
    // Folded or not, a section's help is part of what Settings searches it by.
    expect(textMatches(searchText(section("Server")), queryWords("version alone"))).toBe(true);
    expect(textMatches(searchText(section("Features")), queryWords("never on disk"))).toBe(true);
    rerender(page(true));
    expect(help("Server").panel.hidden).toBe(false);
    expect(help("Server").button.getAttribute("aria-expanded")).toBe("true");
  });

  it("never folds the check's status, the unsecure badge, a problem, or what a missing feature needs", async () => {
    const down = new Error("Can't reach the Hermes dashboard: connection refused");
    const store = scriptedStore(Object.fromEntries(Object.keys(NEW).map((k) => [k, down])));
    diagnostics(store, { unsecure: true });
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    const alert = await screen.findByRole("alert");
    const visible = (el: Element) => expect(el.closest(".set-more")).toBeNull();
    visible(alert);
    expect(alert.closest(".set-note.warn")).not.toBeNull();
    visible(screen.getByRole("status"));
    visible(screen.getByText("Unsecure"));
    visible(within(row$("Skills")).getByText("Couldn't check"));
    visible(within(row$("Skills")).getByText(/Needs:/));
  });
});

describe("the note in place of a screen", () => {
  it("shows the screen while its feature is supported, unknown or couldn't be checked", () => {
    const store = scriptedStore(NEW);
    render(
      <CapabilityGate store={store} id="automations" openGuide={() => {}}>
        <p>the screen</p>
      </CapabilityGate>,
    );
    expect(screen.getByText("the screen")).toBeTruthy();
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    act(() => store.observe(1, { route: "api/webhooks" }, new RestError(503, `{"detail":"down"}`)));
    expect(screen.getByText("the screen")).toBeTruthy();
  });

  it("opens as the note alone when Hermes already lacks the feature, linking to diagnostics and the guide", async () => {
    const store = scriptedStore(NEW);
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    act(() => store.observe(1, { route: "api/webhooks?profile=default" }, new RestError(404, `{"detail":"Not Found"}`)));
    const openGuide = vi.fn();
    const onDiagnostics = vi.fn();
    render(
      <CapabilityGate store={store} id="automations" openGuide={openGuide} onDiagnostics={onDiagnostics} onClose={() => {}}>
        <button>New automation</button>
      </CapabilityGate>,
    );
    // The screen, and anything in it that could write, isn't there.
    expect(screen.queryByRole("button", { name: "New automation" })).toBeNull();
    const note = screen.getByRole("region", { name: /This Hermes server doesn't support Automations/ });
    expect(note.textContent).toMatch(/Automations needs the webhook routes under \/api\/webhooks/);
    expect(note.textContent).toMatch(/Updating Hermes on the server adds it\. Checked just now/);
    const user = userEvent.setup();
    await user.click(within(note).getByRole("button", { name: "Connection diagnostics" }));
    expect(onDiagnostics).toHaveBeenCalledWith("automations");
    await user.click(within(note).getByRole("button", { name: "Compatibility guide: Automations" }));
    expect(openGuide).toHaveBeenCalledWith(guideUrl("automations"));
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toBeTruthy();
  });

  it("keeps a screen already open, with what it typed, and puts the note above it", async () => {
    const store = scriptedStore(NEW);
    act(() => store.connected(1, "default", {}, Promise.resolve({})));
    render(
      <CapabilityGate store={store} id="memory" openGuide={() => {}}>
        <textarea aria-label="Entry" defaultValue="" />
      </CapabilityGate>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Entry" }), "An unsaved edit");
    // A reconnect to an older build finds Hermes lacks the feature while the edit is open.
    act(() => store.observe(1, { method: "learning.detail" }, Object.assign(new Error("unknown method"), { code: -32601 })));
    expect(screen.getByRole("region", { name: /doesn't support Memory/ })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Entry" }) as HTMLTextAreaElement).value).toBe("An unsaved edit");
    // Its writes are refused before they are sent.
    expect(store.refuses({ rpc: "learning.edit" })).toBe("memory");
  });
});

describe("in the app", () => {
  async function launch(s: FakeHermes, opens = vi.fn(async (_url: string): Promise<string | null> => null)) {
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(
      <Main
        hermes={hermes}
        connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }}
        webPages={{ check: async () => ({ kind: "allowed" }) as never, httpsAnswers: async () => true, openInBrowser: opens, devServers: async () => ({ server: { kind: "listed", ports: [] }, local: [] }) }}
        onSignOut={async () => {}}
      />,
    );
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    return { hermes, user: userEvent.setup(), opens };
  }
  const settledChecks = (hermes: Hermes) => waitFor(() => expect(hermes.capabilities.getSnapshot().checkedAt).toBeDefined(), { timeout: 6000 });

  it("opens Scheduled jobs as a note on a server without cron routes, and diagnostics at that feature from it", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.sessions = [row("a", 1, { pinned: true, title: "Fixture chat" })];
    s.cron.missing = true;
    const { hermes, user, opens } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    const note = screen.getByRole("region", { name: /doesn't support Scheduled jobs/ });
    expect(s.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/cron"))).toEqual([]);
    await user.click(within(note).getByRole("button", { name: "Compatibility guide: Scheduled jobs" }));
    expect(opens).toHaveBeenCalledWith(guideUrl("scheduledJobs"));
    await user.click(within(note).getByRole("button", { name: "Connection diagnostics" }));
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("capability-scheduledJobs"));
    // Back to chat puts focus back in the chat.
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("shows Settings tabs for features Hermes lacks as notes, and leaves the others as they were", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.soulRoutes = false;
    const { hermes, user } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("region", { name: /doesn't support Persona/ })).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(s.restRequests.filter((r) => r.method === "PUT")).toEqual([]);
    // The note's own link opens Diagnostics in place.
    await user.click(within(panel).getByRole("button", { name: "Connection diagnostics" }));
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
    expect(within(row$("Persona")).getByText("Not supported")).toBeTruthy();
    expect(within(row$("Scheduled jobs")).getByText("Supported")).toBeTruthy();
  });

  it("reaches Diagnostics from the Connection section and the tabs by keyboard", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    const { hermes, user } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Connection diagnostics" }));
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
    expect(screen.getByText(/liam@hermes/)).toBeTruthy();
    expect(screen.getByText(/^Dashboard username and password, through an SSH tunnel; the dashboard offers basic$/)).toBeTruthy();
    // Arrow keys move along the tabs, as everywhere in Settings.
    screen.getByRole("tab", { name: /Diagnostics/ }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /Skills/, selected: true })).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
  });

  it("shows a note in the side panel's Files tab on a server without the managed-files routes", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.asOlderHermes();
    const { hermes, user } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(await screen.findByRole("region", { name: /doesn't support Server files/ })).toBeTruthy();
    expect(s.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/files"))).toEqual([]);
  });

  it("links to the guide where Settings → Toolsets says the switches can't be changed", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.toolsetRoutes = "read-only";
    const { hermes, user, opens } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: /Toolsets/ }));
    await user.click(await screen.findByRole("button", { name: "Compatibility guide: Toolset switches" }));
    expect(opens).toHaveBeenCalledWith(guideUrl("toolsetSwitches"));
  });

  it("links to the guide from /help when Hermes has no commands, and keeps the app's own", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.commandCatalog = undefined;
    const { hermes, user, opens } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByPlaceholderText("Message Hermes"));
    await user.keyboard("/help{Enter}{Enter}");
    const help = screen.getByRole("region", { name: "Commands" });
    expect(within(help).getByText(/the app's own commands still work/)).toBeTruthy();
    await user.click(within(help).getByRole("button", { name: "Compatibility guide: Hermes's slash commands" }));
    expect(opens).toHaveBeenCalledWith(guideUrl("commands"));
  });

  it("says in the project menu that Hermes has no projects, with no New project to send", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.asOlderHermes();
    const { hermes, user, opens } = await launch(s);
    await act(() => settledChecks(hermes));
    await user.click(screen.getByRole("button", { name: /Projects|All chats/ }));
    expect(screen.getByText(/This Hermes server doesn't support projects/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New project/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compatibility guide: Projects" }));
    expect(opens).toHaveBeenCalledWith(guideUrl("projects"));
    expect(s.requests.filter((r) => r.method === "projects.create")).toEqual([]);
  });
});
