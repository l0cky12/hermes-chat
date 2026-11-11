// @vitest-environment jsdom
// The sign-in method picker and token entry (ADR 0058), on the sign-in screen and in Setup's Sign in step, and what
// the real pipe hands Rust for each method.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Methods, SignInDetails } from "../hermes/tauriPipe";
import { SignIn } from "./SignIn";
import { Onboarding } from "./Onboarding";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({ kind: "url", url: "", addresses: [] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args), Channel: class {} }));

afterEach(cleanup);

const connection = { id: "00000000-0000-4000-8000-000000000001", name: "Hermes", mode: "url" as const, sshTarget: "", url: "http://hermes:9119", username: "liam", addedAt: 1 };
const blank: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes:9119", username: "liam", password: "" };
const both: Methods = { methods: [{ method: "password", provider: "basic", label: "Basic" }, { method: "token" }] };
const passwordOnly: Methods = { methods: [{ method: "password", provider: "basic", label: "Basic" }] };

describe("The sign-in screen", () => {
  it("looks as it always did for a password-only server: no picker, the username and password", async () => {
    const readMethods = vi.fn(async () => passwordOnly);
    render(<SignIn connection={connection} initial={blank} onSignIn={async () => {}} readMethods={readMethods} />);
    await waitFor(() => expect(readMethods).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Sign in with" })).toBeNull();
    expect(screen.getByLabelText("Dashboard username")).toBeTruthy();
    expect(screen.getByLabelText(/^Dashboard password/)).toBeTruthy();
    expect(screen.queryByLabelText("Dashboard session token")).toBeNull();
  });

  it("offers Password and Token when the server takes both, and signs in with a token typed into a masked field", async () => {
    const onSignIn = vi.fn(async () => {});
    render(<SignIn connection={connection} initial={blank} onSignIn={onSignIn} readMethods={async () => both} />);
    const picker = await screen.findByRole("group", { name: "Sign in with" });
    expect(screen.getByRole("button", { name: "Password" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Token" }));
    expect(picker).toBeTruthy();
    const field = screen.getByLabelText("Dashboard session token") as HTMLInputElement;
    expect([field.type, field.autocomplete, field.getAttribute("spellcheck")]).toEqual(["password", "off", "false"]);
    expect(screen.queryByLabelText(/^Dashboard password/)).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
    await userEvent.click(field);
    await userEvent.paste("tok-123");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ method: "token", token: "tok-123", password: "" }));
  });

  it("starts on the token for a connection that used one, and a saved token needs nothing typed", async () => {
    const onSignIn = vi.fn(async () => {});
    const saved = { ...blank, method: "token" as const, savedToken: connection.id };
    render(<SignIn connection={{ ...connection, method: "token" }} initial={saved} onSignIn={onSignIn} readMethods={async () => both} />);
    await screen.findByRole("group", { name: "Sign in with" });
    expect(screen.getByRole("button", { name: "Token" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Dashboard session token") as HTMLInputElement).placeholder).toBe("Saved in your system keyring");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ method: "token", savedToken: connection.id }));
  });

  it("says when a server stops offering the token the connection used, and offers what it does", async () => {
    render(<SignIn connection={{ ...connection, method: "token" }} initial={{ ...blank, method: "token" }} onSignIn={async () => {}} readMethods={async () => passwordOnly} />);
    expect(await screen.findByText(/doesn't take a token any more/)).toBeTruthy();
    expect(screen.getByLabelText(/^Dashboard password/)).toBeTruthy();
  });

  it("reads the methods again for an address typed in, and drops an answer for an address it moved on from", async () => {
    const asked: string[] = [];
    let slow!: (m: Methods) => void;
    const readMethods = vi.fn((d: SignInDetails) => {
      asked.push(d.url);
      if (d.url === "http://hermes:9119") return new Promise<Methods>((resolve) => (slow = resolve));
      return Promise.resolve(d.url === "http://tokens:9119" ? { methods: [{ method: "token" as const }] } : passwordOnly);
    });
    render(<SignIn connection={connection} initial={blank} onSignIn={async () => {}} readMethods={readMethods} />);
    await waitFor(() => expect(asked).toEqual(["http://hermes:9119"]));
    const url = screen.getByLabelText(/^Dashboard URL/);
    await userEvent.clear(url);
    await userEvent.click(url);
    await userEvent.paste("http://tokens:9119");
    expect(await screen.findByLabelText("Dashboard session token", {}, { timeout: 3000 })).toBeTruthy();
    slow(passwordOnly);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Dashboard session token")).toBeTruthy();
    expect(asked.at(-1)).toBe("http://tokens:9119");
  });

  it("explains a token the dashboard turned down", () => {
    render(
      <SignIn
        connection={{ ...connection, method: "token" }}
        initial={{ ...blank, method: "token" }}
        error="Wrong token: the dashboard turned it down. A token stops working when HERMES_DASHBOARD_SESSION_TOKEN is replaced on the server."
        onSignIn={async () => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The dashboard turned down the token.");
    expect(screen.getByRole("alert").textContent).toContain("HERMES_DASHBOARD_SESSION_TOKEN");
  });
});

describe("Setup's Sign in step", () => {
  it("reads the methods once the address is entered and tests a token", async () => {
    const run = vi.fn(async (_d: SignInDetails) => Promise.reject({ stage: "sign-in", message: "Wrong token: the dashboard turned it down." }));
    const readMethods = vi.fn(async () => both);
    render(
      <Onboarding
        mode="add"
        initial={blank}
        probe={{ run, cancel: () => {} }}
        readMethods={readMethods}
        onConnect={async () => ({})}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(await screen.findByRole("button", { name: "Token" }));
    expect(readMethods).toHaveBeenCalledWith(expect.objectContaining({ url: "http://hermes:9119" }));
    expect(screen.getByRole("button", { name: "Test connection" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByLabelText("Dashboard session token"));
    await userEvent.paste("tok-123");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The dashboard turned down the token.")).toBeTruthy();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ method: "token", token: "tok-123" }), "default", false);
  });
});

describe("The real pipe", () => {
  it("hands Rust a typed token, or the saved one's connection, and never asks for a token back", async () => {
    const { tauriPipe, tauriProbe } = await import("../hermes/tauriPipe");
    await tauriPipe({ ...blank, method: "token", token: " tok-123 " }, connection.id)(() => {}, "default");
    expect(invoke).toHaveBeenLastCalledWith("hermes_connect", expect.objectContaining({ credential: { method: "token", token: "tok-123", connection: null } }));
    await tauriPipe({ ...blank, method: "token", savedToken: connection.id }, connection.id)(() => {}, "default");
    expect(invoke).toHaveBeenLastCalledWith("hermes_connect", expect.objectContaining({ credential: { method: "token", token: null, connection: connection.id } }));
    await tauriPipe({ ...blank, password: "hunter2", provider: "ldap" }, connection.id)(() => {}, "default");
    expect(invoke).toHaveBeenLastCalledWith(
      "hermes_connect",
      expect.objectContaining({ credential: { method: "password", username: "liam", password: "hunter2", provider: "ldap" } }),
    );
    invoke.mockResolvedValueOnce({ route: { kind: "url", url: "", addresses: [] }, ready: "{}" });
    await tauriProbe.run({ ...blank, method: "token", token: "tok-123" }, "default");
    expect(invoke).toHaveBeenLastCalledWith("hermes_probe", expect.objectContaining({ credential: { method: "token", token: "tok-123", connection: null } }));
    const { systemSecrets } = await import("../hermes/tauriKeyring");
    invoke.mockResolvedValueOnce([["url", "http://hermes:9119"]]);
    expect(await systemSecrets(connection).token.saved()).toEqual(['["url","http://hermes:9119"]']);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("token_load");
  });
});
