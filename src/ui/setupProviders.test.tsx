// @vitest-environment jsdom
// Setup's providers step on its own: answers that arrive for a connection or profile the step no longer shows are
// dropped, so a late list or save result never lands on the wrong server.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, fakeEnv } from "../hermes/fakeHermes";
import type { OpenPipe } from "../hermes/pipe";
import type { Probe } from "../hermes/setup";
import { connect } from "../hermes/transport";
import { withoutKey } from "../hermes/setup";
import { Onboarding } from "./Onboarding";

afterEach(cleanup);

const probe: Probe = { run: () => new Promise(() => {}), cancel: () => {} };
const initial = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam", password: "", headers: [] };

/** A server whose `GET /api/env` answers only when let through, with only `providers`' keys. */
function heldServer(providers: string[]) {
  const server = new FakeHermes();
  const env = Object.fromEntries(Object.entries(fakeEnv()).filter(([, row]) => providers.includes(String(row.provider))));
  let letThrough: (() => void) | undefined;
  server.rest["GET /api/env"] = () => new Promise((resolve) => (letThrough = () => resolve(env)));
  return { server, release: () => letThrough?.() };
}

function setup(hermes: Parameters<typeof Onboarding>[0]["hermes"]) {
  return (
    <Onboarding mode="reconfigure" initial={initial} probe={probe} hermes={hermes} onConnect={async () => ({})} onCancel={() => {}} onDone={() => {}} />
  );
}

describe("The providers step", () => {
  it("drops a provider list that arrives for the connection it showed before", async () => {
    const a = heldServer(["deepseek"]);
    const b = heldServer(["anthropic"]);
    const ha = await connect(a.server.openPipe);
    const hb = await connect(b.server.openPipe);
    const user = userEvent.setup();
    const { rerender } = render(setup(ha));
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByText("Asking Hermes…");
    const asked = (f: FakeHermes) => waitFor(() => expect(f.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    await asked(a.server);

    // The connection changes under the step (put back after a failed switch, say), then the old answer comes.
    rerender(setup(hb));
    await asked(b.server);
    await act(async () => b.release());
    expect(await screen.findByRole("option", { name: "Anthropic" })).toBeTruthy();
    await act(async () => a.release());
    expect(screen.queryByRole("option", { name: "DeepSeek" })).toBeNull();
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeTruthy();
    await ha.close();
    await hb.close();
  });

  it("reads again for the profile shown, dropping the answer for the one before", async () => {
    const { server, release } = heldServer(["deepseek"]);
    server.otherProfiles.work = [];
    const hermes = await connect(server.openPipe);
    const user = userEvent.setup();
    render(setup(hermes));
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByText("Asking Hermes…");
    await waitFor(() => expect(server.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    const firstRelease = release;
    // A new list for "work" is asked for, and answers.
    const env = Object.fromEntries(Object.entries(fakeEnv()).filter(([, row]) => row.provider === "anthropic"));
    server.rest["GET /api/env"] = () => env;
    await act(async () => hermes.switchProfile("work"));
    expect(await screen.findByRole("option", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByText(/work/, { selector: ".mono" })).toBeTruthy();
    // The default profile's late answer changes nothing.
    await act(async () => firstRelease());
    expect(screen.queryByRole("option", { name: "DeepSeek" })).toBeNull();
    await hermes.close();
  });
});

/** `server`'s pipe, with key saves held until let through. */
function heldSaves(server: FakeHermes) {
  const held: (() => void)[] = [];
  const open: OpenPipe = async (onEvent, profile, signal) => {
    const pipe = await server.openPipe(onEvent, profile, signal);
    return { ...pipe, saveProviderKey: async (...a) => (await new Promise<void>((go) => held.push(go)), pipe.saveProviderKey(...a)) };
  };
  return { open, release: () => held.splice(0).forEach((go) => go()), waiting: () => held.length };
}

describe("The providers step's key", () => {
  it("is cleared when the profile changes, and a save under way for the old one doesn't land", async () => {
    const server = new FakeHermes();
    server.otherProfiles.work = [];
    const saves = heldSaves(server);
    const hermes = await connect(saves.open);
    const user = userEvent.setup();
    render(setup(hermes));
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await user.selectOptions(await screen.findByLabelText("Provider"), "deepseek");
    await user.click(screen.getByLabelText("API key"));
    await user.paste("sk-default-profile-0001");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    await waitFor(() => expect(saves.waiting()).toBe(1));

    await act(async () => hermes.switchProfile("work"));
    await screen.findByLabelText("Provider");
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.value).toBe("");
    expect((screen.getByRole("button", { name: "Check and save key" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => saves.release());
    expect(screen.queryByText(/Saved\./)).toBeNull();
    // The save went where it was asked for: the default profile, never work.
    expect(server.savedKeys.map((k) => k.profile)).toEqual(["default"]);
    await hermes.close();
  });

  it("keeps a save's answer when a re-read of the list timed out and was tried again meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = new FakeHermes();
      const saves = heldSaves(server);
      const hermes = await connect(saves.open);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(setup(hermes));
      await user.click(screen.getByRole("button", { name: "Add a provider key" }));
      await user.selectOptions(await screen.findByLabelText("Provider"), "deepseek");
      await user.click(screen.getByLabelText("API key"));
      await user.paste("sk-first-good-0001");
      await user.click(screen.getByRole("button", { name: "Check and save key" }));
      await waitFor(() => expect(saves.waiting()).toBe(1));
      // The re-read after this save never answers.
      const env = server.rest["GET /api/env"];
      server.rest["GET /api/env"] = () => new Promise(() => {});
      await act(async () => saves.release());
      await screen.findByText(/Saved\. DeepSeek accepted the key\./);

      // A second key is being checked when that re-read gives up and is tried again.
      await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
      await user.click(screen.getByLabelText("API key"));
      await user.paste("sk-second-good-0002");
      await user.click(screen.getByRole("button", { name: "Check and save key" }));
      await waitFor(() => expect(saves.waiting()).toBe(1));
      await act(async () => vi.advanceTimersByTimeAsync(25_000));
      await screen.findByText(/Couldn't read the providers from Hermes/);
      server.rest["GET /api/env"] = env;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByLabelText("Provider");

      await act(async () => saves.release());
      expect(await screen.findByText(/Saved\. Anthropic accepted the key\./)).toBeTruthy();
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
      expect(server.savedKeys.map((k) => k.envVar)).toEqual(["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY"]);
      await hermes.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Setup going away while connecting", () => {
  it("stops the sign-in under way", async () => {
    const passing: Probe = {
      run: async () => ({
        route: { kind: "ssh", target: "liam@hermes", localPort: 1 } as never,
        status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
        ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }),
      }),
      cancel: () => {},
    };
    let signal: AbortSignal | undefined;
    const user = userEvent.setup();
    const { unmount } = render(
      <Onboarding
        mode="edit"
        initial={initial}
        probe={passing}
        onConnect={(_d, _n, s) => ((signal = s), new Promise(() => {}))}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await user.click(await screen.findByRole("button", { name: "Save and connect" }));
    expect(signal?.aborted).toBe(false);
    // Nothing can cancel it from here but Stop.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("Error text after a key", () => {
  it("is shown only when it repeats no 8 characters of the key", () => {
    const key = "sk-or-v1-0123456789abcdef";
    expect(withoutKey("The provider turned the key down.", key)).toBe("The provider turned the key down.");
    expect(withoutKey(`bad key ${key}`, key)).toMatch(/isn't shown/);
    expect(withoutKey("bad key …456789ab…", key)).toMatch(/isn't shown/);
    expect(withoutKey("bad key …456789a…", key)).toBe("bad key …456789a…");
    // A key shorter than 8 characters counts in full.
    expect(withoutKey("rejected: abc12", "abc12")).toMatch(/isn't shown/);
    expect(withoutKey("rejected", "  ")).toBe("rejected");
  });
});
