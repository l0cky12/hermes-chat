// @vitest-environment jsdom
// Setup, through the whole app: the Rust side is replaced by FakeHermes servers, a fake connection test and an
// in-memory keyring, so these tests see what the owner sees and what is saved on this computer.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { OpenPipe } from "../hermes/pipe";
import type { Probed, ProbeFailure } from "../hermes/setup";
import type { SignInDetails } from "../hermes/tauriPipe";
import type { RoutedHooks } from "../hermes/routes";

/** The Rust side: the servers this computer can reach, the keyring, and the connection tests run. */
const backend = vi.hoisted(() => ({
  servers: new Map<string, { server: unknown; password: string }>(),
  keyring: undefined as string | undefined,
  /** While set, a test waits until it is cancelled, like one stuck on a slow SSH host. */
  holdProbe: false,
  /** While set, the keyring can't save, as with no Secret Service running. */
  keyringBroken: false,
  probes: 0,
  cancelled: 0,
  release: undefined as (() => void) | undefined,
  /** While set, a stopped test answers only when the test releases it, as when Rust's abort lands late. */
  lateCancel: false,
  /** While set, Save and connect's sign-in waits until it is stopped or let through, like a slow server. */
  holdConnect: false,
  letConnect: undefined as (() => void) | undefined,
  /** Sign-ins stopped while they were opening (src-tauri `hermes_connect_cancel`). */
  connectsStopped: 0,
  /** While set, the next connection test fails with this, or answers with this first chat frame. */
  probeFailure: undefined as ProbeFailure | undefined,
  probeReady: undefined as string | undefined,
  /** While set, saving a provider key fails with a message that quotes the key, as a provider's own text can. */
  echoKey: false,
  /** While set, the keyring's password save, or its extra-header read, waits until let through. */
  holdKeyringSave: false,
  holdHeadersLoad: false,
  letKeyring: undefined as (() => void) | undefined,
  /** While set, reading the password fails as when the owner cancels the keyring's unlock prompt. */
  unlockCancelled: false,
  /** Every keyring read, by command, in order. */
  keyringReads: [] as string[],
}));

const where = (d: SignInDetails) => (d.mode === "ssh" ? `ssh:${d.sshTarget.trim()}` : `url:${d.url.trim()}`);

/** What Rust would answer for `d`, the way `hermes_connect` and `hermes_probe` fail. */
function reach(d: SignInDetails): { server: FakeHermes } | ProbeFailure {
  const found = backend.servers.get(where(d));
  if (!found) return { stage: "address", message: `SSH failed: ssh: Could not resolve hostname ${d.sshTarget}: Name or service not known` };
  if (d.username !== "liam" || d.password !== found.password)
    return { stage: "sign-in", message: "Wrong username or password.", status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}' };
  return { server: found.server as FakeHermes };
}

/** One route's pipe, as Rust opens it: `reach` says how it goes. */
function openOne(d: SignInDetails): OpenPipe {
  return async (onEvent, profile, signal) => {
      if (backend.holdConnect)
        await new Promise<void>((resolve, reject) => {
          backend.letConnect = resolve;
          signal?.addEventListener("abort", () => {
            backend.connectsStopped++;
            reject(new Error("The connection was stopped."));
          });
        });
      const r = reach(d);
      if ("stage" in r) throw new Error(r.message);
      const pipe = await r.server.openPipe(onEvent, profile);
      if (!backend.echoKey) return pipe;
      return {
        ...pipe,
        saveProviderKey: async (_profile: string, _envVar: string, key: string) => {
          throw new Error(`The provider said: invalid key ${key.slice(2, 14)}…`);
        },
      };
    };
}

vi.mock("../hermes/tauriPipe", async () => {
  const { routedPipe } = await vi.importActual<typeof import("../hermes/routes")>("../hermes/routes");
  return {
  asError: (e: unknown) => Promise.reject(new Error(String(e))),
  // Each route as Rust opens it, tried in order as the app does (routes.ts).
  tauriPipe: (d: SignInDetails, hooks?: RoutedHooks): OpenPipe => routedPipe(d, (one) => openOne(one), hooks),
  tauriReach: async (d: SignInDetails) => {
    const r = reach(d);
    if ("stage" in r && r.stage !== "sign-in") throw r;
    return { route: "server" in r ? r.server.route : { kind: "ssh", target: d.sshTarget }, status: '{"version":"0.22.5","auth_required":true}' };
  },
  reachRoute: async () => {},
  tauriProbe: {
    run: async (d: SignInDetails): Promise<Probed> => {
      backend.probes++;
      if (backend.holdProbe) {
        await new Promise<void>((resolve) => (backend.release = resolve));
        throw { stage: "cancelled", message: "The test was stopped." } satisfies ProbeFailure;
      }
      if (backend.probeFailure) throw backend.probeFailure;
      const r = reach(d);
      if ("stage" in r) throw r;
      return {
        route: r.server.route,
        status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
        ready: backend.probeReady ?? JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: r.server.readyPayload } }),
      };
    },
    cancel: () => {
      backend.cancelled++;
      if (!backend.lateCancel) backend.release?.();
    },
  },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args?: { password?: string }) => {
    if ((cmd === "password_save" && backend.holdKeyringSave) || (cmd === "headers_load" && backend.holdHeadersLoad))
      await new Promise<void>((go) => (backend.letKeyring = go));
    if (cmd.endsWith("_load")) backend.keyringReads.push(cmd);
    if (cmd === "password_load" && backend.unlockCancelled) throw "The system keyring failed: Prompt was dismissed";
    if (cmd === "password_load") return backend.keyring ?? null;
    if (cmd === "password_save") {
      if (backend.keyringBroken) throw "The system keyring failed: no Secret Service on the bus";
      backend.keyring = args?.password;
    }
    if (cmd === "password_delete") backend.keyring = undefined;
    if (cmd === "system_fonts") return { all: [], mono: [] };
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const SAVED = "hermes-chat.sign-in";
let home: FakeHermes;

beforeEach(() => {
  // App keeps launch in a module variable: each test is a fresh start of the app.
  vi.resetModules();
  home = new FakeHermes();
  backend.servers.clear();
  backend.servers.set("ssh:liam@hermes", { server: home, password: "hunter2" });
  Object.assign(backend, {
    keyring: undefined,
    holdProbe: false,
    keyringBroken: false,
    probes: 0,
    cancelled: 0,
    release: undefined,
    lateCancel: false,
    holdConnect: false,
    letConnect: undefined,
    connectsStopped: 0,
    probeFailure: undefined,
    probeReady: undefined,
    echoKey: false,
    holdKeyringSave: false,
    holdHeadersLoad: false,
    letKeyring: undefined,
    unlockCancelled: false,
    keyringReads: [],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function start() {
  const { default: App } = await import("../App");
  render(<App />);
  return userEvent.setup();
}

const dialog = () => screen.queryByRole("dialog");
const savedSignIn = () => {
  const doc = JSON.parse(localStorage.getItem("hermes-chat.connections") ?? "null");
  const c = doc?.connections.find((c: { id: string }) => c.id === doc.current);
  if (!c) return null;
  return { mode: c.mode, sshTarget: c.sshTarget, url: c.url, username: c.username };
};
const savedPassword = () => {
  try { return JSON.parse(backend.keyring!).password; } catch { return backend.keyring; }
};
/** This computer already set up and signed in, as before setup existed. */
function alreadySetUp({ signedOut = false } = {}) {
  localStorage.setItem(SAVED, JSON.stringify({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }));
  backend.keyring = signedOut ? undefined : "hunter2";
}

async function toSignInStep(user: ReturnType<typeof userEvent.setup>, target = "liam@hermes") {
  await user.click(screen.getByRole("button", { name: "Get started" }));
  await user.type(screen.getByLabelText("SSH target"), target);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Sign in to the dashboard" });
}

describe("First run", () => {
  it("tests the connection, explains a failure, connects once it passes, and takes a provider key", async () => {
    const user = await start();
    expect(await screen.findByRole("heading", { name: "Welcome to Hermes Chat" })).toBeTruthy();
    // There is nothing to cancel to yet.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();

    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain("The dashboard turned down the username or password.");
    expect(failed.textContent).toContain("dashboard.basic_auth");
    expect(within(failed).getByText("Sign in to the dashboard").closest("li")?.className).toBe("bad");
    expect(within(failed).getByText("Reach the Hermes dashboard").closest("li")?.className).toBe("ok");
    // A failed test keeps nothing.
    expect([backend.keyring, savedSignIn()]).toEqual([undefined, null]);

    // Changing a detail clears the result; Try again tests the new one.
    await user.clear(screen.getByLabelText("Dashboard password"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toContain("Connected to Hermes 0.22.5 at ssh://liam@hermes.");
    expect(home.opened).toBe(0);
    expect(backend.keyring).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByRole("heading", { name: "Model providers" })).toBeTruthy();
    expect(savedPassword()).toBe("hunter2");
    expect(savedSignIn()).toEqual({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
    expect(home.opened).toBe(1);
    // Saved, so there is nothing left to cancel.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();

    expect(await screen.findByText(/Hermes can already use Anthropic, OpenAI/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
    await user.type(screen.getByLabelText("API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not saved: The provider turned the key down. Check that you copied all of it, and that it's for this provider.");
    expect(home.savedKeys).toEqual([]);

    await user.clear(screen.getByLabelText("API key"));
    await user.type(screen.getByLabelText("API key"), "sk-ant-good");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await screen.findByText("Saved. Anthropic accepted the key.")).getAttribute("role")).toBe("status");
    expect(home.savedKeys).toEqual([{ profile: "default", envVar: "ANTHROPIC_API_KEY", key: "sk-ant-good" }]);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    // The key never touches this computer's storage.
    expect(JSON.stringify(localStorage)).not.toContain("sk-ant-good");

    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
  });

  it("starts over on Cancel, forgetting the password typed", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Cancel and start over" }));
    expect(await screen.findByRole("heading", { name: "Welcome to Hermes Chat" })).toBeTruthy();

    await toSignInStep(user);
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).value).toBe("");
    expect(backend.keyring).toBeUndefined();
  });

  it("explains an SSH host that can't be found", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user, "liam@hermse");
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain('This computer couldn\'t find the host "hermse".');
    expect(failed.textContent).toContain("~/.ssh/config");
    expect(within(failed).getByText("Open an SSH tunnel to the server").closest("li")?.className).toBe("bad");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says in setup when the keyring couldn't keep the password", async () => {
    backend.keyringBroken = true;
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect(screen.getByText(/You'll type the password again at the next launch/).textContent?.trim()).toBe(
      "Connected. Couldn't save the password in the system keyring: The system keyring failed: no Secret Service on the bus. You'll type the password again at the next launch.",
    );
    expect(backend.keyring).toBeUndefined();
  });

  it("stops a test that's taking long", async () => {
    backend.holdProbe = true;
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Testing the connection…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);

    // The details can't change under a test.
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole("button", { name: "Stop test" }));
    expect(backend.cancelled).toBe(1);
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).readOnly).toBe(false);
    await act(async () => {});
    expect(screen.queryByText("Testing the connection…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the next test's result when a stopped test answers late", async () => {
    Object.assign(backend, { holdProbe: true, lateCancel: true });
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Testing the connection…");
    await user.click(screen.getByRole("button", { name: "Stop test" }));
    const stopped = backend.release!;

    backend.holdProbe = false;
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toContain("Connected to Hermes");
    await act(async () => stopped());
    expect(screen.getByRole("status").textContent).toContain("Connected to Hermes");
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeTruthy();
  });
});

describe("An install set up before", () => {
  it("signs in with the saved password and never shows setup", async () => {
    alreadySetUp();
    await start();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(backend.probes).toBe(0);
  });

  it("asks for the password when the keyring's unlock is cancelled, reading each keyring entry once", async () => {
    alreadySetUp();
    backend.unlockCancelled = true;
    await start();
    expect(await screen.findByRole("heading", { name: "Connect to hermes" })).toBeTruthy();
    expect((screen.getByLabelText("Dashboard username") as HTMLInputElement).value).toBe("liam");
    expect(backend.keyringReads.sort()).toEqual(["headers_load", "password_load"]);
  });

  it("signed out, gets the sign-in screen, which can open setup and cancel back", async () => {
    alreadySetUp({ signedOut: true });
    const user = await start();
    expect(await screen.findByRole("heading", { name: "Connect to hermes" })).toBeTruthy();
    expect(dialog()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Set up a new connection…" }));
    expect(await screen.findByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Connect to hermes" })).toBeTruthy();
    expect(dialog()).toBeNull();
  });
});

describe("Setup from Settings", () => {
  async function openSetup() {
    alreadySetUp();
    const user = await start();
    await screen.findByText("New chat", { selector: ".chat-title span" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    expect(await screen.findByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    return user;
  }

  it("leaves the connection as it was on Cancel, or on Escape", async () => {
    const user = await openSetup();
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(true);
    // The app's shortcuts wait while setup covers it.
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByPlaceholderText("Search all chats, including Settled")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // Focus goes back to the button that opened setup.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run setup again" }));
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();
    expect([home.opened, home.closed, backend.keyring]).toEqual([1, false, "hunter2"]);
  });

  it("tests a new server while the old connection carries on, then switches to it", async () => {
    const studio = new FakeHermes();
    studio.route = { kind: "url", url: "http://studio.example.com:9119", addresses: ["203.0.113.9"] };
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await openSetup();

    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Dashboard username") as HTMLInputElement).value).toBe("liam");
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const passed = await screen.findByRole("status");
    expect(passed.textContent).toContain("Connected to Hermes 0.22.5 at http://studio.example.com:9119.");
    expect(passed.textContent).toContain("Unsecure");
    // The test didn't touch the connection in use.
    expect([home.closed, studio.opened, backend.keyring]).toEqual([false, 0, "hunter2"]);

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect([home.closed, studio.opened, savedPassword()]).toEqual([true, 1, "pa55"]);
    expect(savedSignIn()).toEqual({ mode: "url", sshTarget: "liam@hermes", url: "http://studio.example.com:9119", username: "liam" });

    await screen.findByText(/Hermes can already use/);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
  });

  it("puts the old connection back if the new one fails after its test", async () => {
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await openSetup();
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("status");

    studio.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The test passed, but connecting failed: Can't reach the Hermes dashboard: connection reset",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(home.opened).toBe(2));
    expect([backend.keyring, savedSignIn()!.mode]).toEqual(["hunter2", "ssh"]);
    // Back under setup, the chats wait: none is opened, or read, while setup covers them.
    await waitFor(() => expect(document.querySelector(".panes")).toBeTruthy());
    expect(document.querySelector(".panes")?.hasAttribute("inert")).toBe(true);

    // Cancel goes back to the old server, connected again.
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(home.closed).toBe(false);
    expect(document.querySelector(".panes")?.hasAttribute("inert")).toBe(false);
  });

  it("puts the old connection back even when the keyring couldn't keep its password", async () => {
    backend.keyringBroken = true;
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await start();
    // First run: connected, but the password is only in memory.
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(backend.keyring).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    studio.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText(/The test passed, but connecting failed/);
    await waitFor(() => expect(home.opened).toBe(2));

    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(home.closed).toBe(false);
    expect(screen.queryByRole("heading", { name: "Connect to hermes" })).toBeNull();
  });

  it("adds a provider key without touching the connection", async () => {
    const user = await openSetup();
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByRole("heading", { name: "Model providers" });
    await user.selectOptions(await screen.findByLabelText("Provider"), "deepseek");
    await user.type(screen.getByLabelText("API key"), "sk-offline");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect(
      (await screen.findByText("Saved, but Hermes couldn't check the key with DeepSeek. If it's wrong, DeepSeek will turn down Hermes's first request.")).getAttribute("role"),
    ).toBe("status");
    expect(home.savedKeys).toEqual([{ profile: "default", envVar: "DEEPSEEK_API_KEY", key: "sk-offline" }]);
    // Done never waits on Hermes: here it stops answering after the save.
    home.rest["GET /api/env"] = () => new Promise(() => {});
    await user.type(screen.getByLabelText("API key"), "sk-good-2");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    await screen.findByText(/Saved\. DeepSeek accepted the key\./);
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(dialog()).toBeNull();
    expect([home.opened, home.closed]).toEqual([1, false]);
  });
});

/** First run up to a passed test of liam@hermes. */
async function testedFirstRun(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
  await toSignInStep(user);
  await user.type(screen.getByLabelText("Dashboard username"), "liam");
  await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText(/Connected to Hermes/);
}

/** Each stage's mark in a test result: ok, bad or skip. */
const marks = (result: HTMLElement) => [...result.querySelectorAll(".setup-checks li")].map((li) => `${li.textContent}: ${li.className}`);

describe("A connection test explains each stage on its own", () => {
  it("tells an unreachable dashboard, a refused sign-in, a gateway, a protocol mismatch and a pass apart, keeping nothing", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    const retest = async () => {
      await user.click(screen.getByRole("button", { name: /^(Test connection|Try again|Test again)$/ }));
      return screen.findByRole(backend.probeFailure || backend.probeReady ? "alert" : "status");
    };

    // Reachability: the tunnel opened, but nothing answers on the dashboard's port.
    backend.probeFailure = { stage: "reach", message: "Can't reach the Hermes dashboard: connection refused" };
    let result = await retest();
    expect(result.textContent).toContain("The tunnel opened, but nothing answered on the server's port 9119.");
    expect(result.textContent).toContain("hermes dashboard");
    expect(marks(result)).toEqual([
      "Open an SSH tunnel to the server: ok",
      "Reach the Hermes dashboard: bad",
      "Sign in to the dashboard: skip",
      "Open the chat connection: skip",
    ]);

    // Authentication: the dashboard answered, and turned the password down.
    backend.probeFailure = { stage: "sign-in", message: "Wrong username or password.", status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}' };
    result = await retest();
    expect(result.textContent).toContain("The dashboard turned down the username or password.");
    expect(marks(result).map((m) => m.split(": ")[1])).toEqual(["ok", "ok", "bad", "skip"]);

    // A dashboard that offers no password sign-in is an authentication problem too, with its own fix.
    backend.probeFailure = { stage: "sign-in", message: "The dashboard answered 404: ", answered: { status: 404, body: "" }, status: '{"version":"0.22.5","auth_required":true,"auth_providers":["oidc"]}' };
    result = await retest();
    expect(result.textContent).toContain("This dashboard doesn't offer username and password sign-in");
    expect(result.textContent).toContain("It offers: oidc.");

    // Protocol: signed in, but the server speaks the canonical session protocol.
    backend.probeFailure = undefined;
    backend.probeReady = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { session_authority: "server" } } });
    result = await retest();
    expect(result.textContent).toContain("Hermes Chat can't talk to this server yet.");
    expect(result.textContent).toContain("newer session protocol");
    expect(marks(result).map((m) => m.split(": ")[1])).toEqual(["ok", "ok", "ok", "bad"]);
    // A protocol mismatch can't be saved.
    expect(screen.queryByRole("button", { name: "Save and connect" })).toBeNull();

    // A pass marks every stage.
    backend.probeReady = undefined;
    result = await retest();
    expect(result.textContent).toContain("Connected to Hermes 0.22.5 at ssh://liam@hermes.");
    expect(marks(result).map((m) => m.split(": ")[1])).toEqual(["ok", "ok", "ok", "ok"]);

    // None of the tests kept anything.
    expect([backend.keyring, savedSignIn(), backend.probes]).toEqual([undefined, null, 5]);
  });

  it("says a gateway turned Hermes Chat away before the password is sent", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await user.click(screen.getByRole("button", { name: "Get started" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "https://hermes.example.com");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    backend.probeFailure = { stage: "reach", message: "The dashboard answered 403: Forbidden by Access", answered: { status: 403, body: "Forbidden by Access" } };
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const result = await screen.findByRole("alert");
    expect(result.textContent).toContain("Something in front of the dashboard at hermes.example.com turned Hermes Chat away.");
    expect(result.textContent).toContain("CF-Access-Client-Id");
    expect(marks(result)).toEqual(["Find the server: ok", "Reach the Hermes dashboard: bad", "Sign in to the dashboard: skip", "Open the chat connection: skip"]);
  });
});

describe("Stopping Save and connect", () => {
  it("on first run, stops the sign-in and keeps nothing, and can connect afterwards", async () => {
    backend.holdConnect = true;
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect((screen.getByRole("button", { name: "Connecting…" }) as HTMLButtonElement).disabled).toBe(true);
    // Setup can't be left with a sign-in under way, only stopped.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect((await screen.findByText(/Connecting was stopped/)).textContent?.trim()).toBe("Connecting was stopped. Nothing was saved.");
    expect([backend.connectsStopped, backend.keyring, savedSignIn(), home.opened]).toEqual([1, undefined, null, 0]);
    expect(screen.queryByRole("alert")).toBeNull();

    backend.holdConnect = false;
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect([savedPassword(), home.opened]).toEqual(["hunter2", 1]);
  });

  it("stops on Escape too, and stays in setup", async () => {
    backend.holdConnect = true;
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(backend.letConnect).toBeTruthy());
    await user.keyboard("{Escape}");
    await screen.findByText(/Connecting was stopped/);
    expect(dialog()).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in to the dashboard" })).toBeTruthy();
    expect([backend.connectsStopped, backend.keyring]).toEqual([1, undefined]);
  });

  it("from Settings, puts the connection in use back, with its draft", async () => {
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    alreadySetUp();
    const user = await start();
    const composer = await screen.findByPlaceholderText("Message Hermes");
    await user.click(composer);
    await user.paste("Half-written plan");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);

    backend.holdConnect = true;
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(backend.letConnect).toBeTruthy());
    // Only the new sign-in is held: putting the old one back goes straight through.
    backend.holdConnect = false;
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect((await screen.findByText(/Connecting was stopped/)).textContent?.trim()).toBe(
      "Connecting was stopped. Nothing was saved, and the connection you were using was put back.",
    );
    expect([studio.opened, home.opened, backend.keyring, savedSignIn()!.mode]).toEqual([0, 2, "hunter2", "ssh"]);

    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(home.closed).toBe(false);
    expect(((await screen.findByPlaceholderText("Message Hermes")) as HTMLTextAreaElement).value).toBe("Half-written plan");
  });
});

describe("Composer drafts across a reconfiguration", () => {
  async function typedDraftThenSetup() {
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    alreadySetUp();
    const user = await start();
    const composer = await screen.findByPlaceholderText("Message Hermes");
    await user.click(composer);
    await user.paste("Half-written plan");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    return { user, studio };
  }

  it("keeps the draft when the connection in use moves to another address", async () => {
    const { user, studio } = await typedDraftThenSetup();
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(dialog()).toBeNull();
    expect([studio.opened, home.closed]).toEqual([1, true]);
    expect(((await screen.findByPlaceholderText("Message Hermes")) as HTMLTextAreaElement).value).toBe("Half-written plan");
  });

  it("keeps the draft when a failed reconfiguration puts the old connection back", async () => {
    const { user, studio } = await typedDraftThenSetup();
    studio.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText(/The test passed, but connecting failed/);
    await waitFor(() => expect(home.opened).toBe(2));
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(((await screen.findByPlaceholderText("Message Hermes")) as HTMLTextAreaElement).value).toBe("Half-written plan");
  });
});

describe("Leaving the providers step", () => {
  it("is Skip on a server whose Hermes can already use a provider, and Skip for now on one that can't", async () => {
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText(/Hermes can already use/);
    expect(screen.getByText(/This step is optional/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(dialog()).toBeNull();
    expect(home.savedKeys).toEqual([]);
    // Skipping keeps the connection.
    expect(savedPassword()).toBe("hunter2");
  });

  it("offers Skip for now when Hermes lists no provider it can use", async () => {
    home.modelOptionsResult = { providers: [] };
    home.restModelOptions = { providers: [] };
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByText(/Hermes doesn't list a model provider it can use yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(dialog()).toBeNull();
  });
});

describe("Provider keys are masked and write-only", () => {
  it("masks the key, and never shows an answer that repeats it, nor keeps it on this computer", async () => {
    backend.echoKey = true;
    const key = "sk-ant-api03-SYNTHETIC0123456789";
    alreadySetUp();
    const user = await start();
    await screen.findByText("New chat", { selector: ".chat-title span" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Add a provider key" }));
    await user.selectOptions(await screen.findByLabelText("Provider"), "anthropic");
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect([input.type, input.getAttribute("autocomplete"), input.getAttribute("spellcheck")]).toEqual(["password", "off", "false"]);
    await user.click(input);
    await user.paste(key);
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await within(dialog()!).findByRole("alert")).textContent).toBe("Not saved: Hermes's answer isn't shown, as it may repeat the key.");
    for (const part of [key, key.slice(2, 14), "SYNTHETIC"]) {
      expect(document.body.textContent).not.toContain(part);
      expect(JSON.stringify(localStorage)).not.toContain(part);
      expect(backend.keyring ?? "").not.toContain(part);
    }
    expect(home.savedKeys).toEqual([]);
  });
});

describe("Run setup again from the sign-in screen", () => {
  it("opens setup for the connection the screen is for, cancels back, and saves only once tested", async () => {
    alreadySetUp({ signedOut: true });
    const user = await start();
    await screen.findByRole("heading", { name: "Connect to hermes" });
    await user.click(screen.getByRole("button", { name: "Run setup again…" }));
    expect(await screen.findByRole("heading", { name: "Edit hermes" })).toBeTruthy();
    expect(screen.getByText(/Nothing changes until the connection is tested and saved/)).toBeTruthy();
    expect((screen.getByLabelText("SSH target") as HTMLInputElement).value).toBe("liam@hermes");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Connect to hermes" })).toBeTruthy();
    expect(dialog()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Run setup again…" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Dashboard username") as HTMLInputElement).value).toBe("liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    expect(backend.keyring).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
    expect(savedPassword()).toBe("hunter2");
    // Still the one connection, edited in place.
    expect(JSON.parse(localStorage.getItem("hermes-chat.connections")!).connections).toHaveLength(1);
  });
});

describe("Stopping at the edges", () => {
  it("keeps a sign-in that Hermes already answered, even if Stop comes while the keyring saves it", async () => {
    backend.holdKeyringSave = true;
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(backend.letKeyring).toBeTruthy());
    expect(home.opened).toBe(1);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    backend.holdKeyringSave = false;
    await act(async () => backend.letKeyring!());
    await screen.findByRole("heading", { name: "Model providers" });
    expect(screen.queryByText(/Connecting was stopped/)).toBeNull();
    expect([savedPassword(), savedSignIn()?.sshTarget, home.opened, home.closed, backend.connectsStopped]).toEqual(["hunter2", "liam@hermes", 1, false, 0]);
  });

  it("from Settings, when the old server can't be reached either, goes back to it signed out, with its draft and secrets", async () => {
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    alreadySetUp();
    const user = await start();
    const composer = await screen.findByPlaceholderText("Message Hermes");
    await screen.findByText("New chat", { selector: ".chat-title span" });
    await user.click(composer);
    await user.paste("Half-written plan");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Change connection" }));
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);

    backend.holdConnect = true;
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(backend.letConnect).toBeTruthy());
    backend.holdConnect = false;
    home.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Stop" }));
    // Nothing could be put back, so setup doesn't claim it was.
    expect((await screen.findByText(/Connecting was stopped/)).textContent?.trim()).toBe("Connecting was stopped. Nothing was saved.");
    // Nothing of the new server was kept; the old connection's secrets and address are as they were.
    expect([studio.opened, backend.keyring, savedSignIn()]).toEqual([0, "hunter2", { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }]);

    // With no chat list saved to read Offline, the old connection's sign-in screen is under setup.
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByRole("heading", { name: "Connect to hermes" })).toBeTruthy();
    expect((screen.getByLabelText("SSH target") as HTMLInputElement).value).toBe("liam@hermes");
    // Once it answers again, signing in finds the draft.
    home.refuse = undefined;
    await user.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(((await screen.findByPlaceholderText("Message Hermes")) as HTMLTextAreaElement).value).toBe("Half-written plan");
    expect(studio.opened).toBe(0);
  });
});

describe("Run setup again while the keyring is slow", () => {
  it("gives way to Set up a new connection asked for meanwhile", async () => {
    alreadySetUp({ signedOut: true });
    const user = await start();
    await screen.findByRole("heading", { name: "Connect to hermes" });
    backend.holdHeadersLoad = true;
    await user.click(screen.getByRole("button", { name: "Run setup again…" }));
    await waitFor(() => expect(backend.letKeyring).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Set up a new connection…" }));
    expect(await screen.findByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    backend.holdHeadersLoad = false;
    await act(async () => backend.letKeyring!());
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Edit hermes" })).toBeNull();
  });
});

describe("Stopping a Save and connect that waits its turn", () => {
  it("stops at once, never dials, and leaves the change before it to finish", async () => {
    alreadySetUp({ signedOut: true });
    const user = await start();
    await screen.findByRole("heading", { name: "Connect to hermes" });
    // Run setup again reads the keyring, and that change holds the queue.
    backend.holdHeadersLoad = true;
    await user.click(screen.getByRole("button", { name: "Run setup again…" }));
    await waitFor(() => expect(backend.letKeyring).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Set up a new connection…" }));
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    // Stopped while still queued: no wait for the change ahead of it.
    expect((await screen.findByText(/Connecting was stopped/)).textContent?.trim()).toBe("Connecting was stopped. Nothing was saved.");
    backend.holdHeadersLoad = false;
    await act(async () => backend.letKeyring!());
    await act(async () => {});
    expect([home.opened, backend.connectsStopped, backend.keyring]).toEqual([0, 0, undefined]);
    // The change ahead of it gave way to the setup opened meanwhile; setup is still there, and can connect.
    expect(screen.getByRole("heading", { name: "Sign in to the dashboard" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect([home.opened, savedPassword()]).toEqual([1, "hunter2"]);
  });
});

describe("The app closing while Save and connect dials", () => {
  it("stops the dial through the real sign-in chain, and saves nothing even when the server answers later", async () => {
    backend.holdConnect = true;
    const user = await start();
    await testedFirstRun(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(backend.letConnect).toBeTruthy());
    const late = backend.letConnect!;
    cleanup();
    expect(backend.connectsStopped).toBe(1);
    // The server answering after all changes nothing: the dial was already stopped.
    await act(async () => late());
    await act(async () => {});
    expect([home.opened, backend.keyring, savedSignIn()]).toEqual([0, undefined, null]);
  });
});
