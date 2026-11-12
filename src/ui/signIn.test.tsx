// @vitest-environment jsdom
// Extra request headers on the sign-in screen, and what the real pipe hands Rust for them.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInFailure } from "../hermes/setup";
import type { SignInDetails } from "../hermes/tauriPipe";
import { SignIn } from "./SignIn";
const connection = { id: "00000000-0000-4000-8000-000000000001", name: "Hermes", mode: "url" as const, sshTarget: "liam@hermes", url: "https://hermes.example.com", username: "liam", addedAt: 1 };

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({ kind: "url", url: "", addresses: [] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args), Channel: class {} }));

afterEach(cleanup);

const blank: SignInDetails = { mode: "url", sshTarget: "liam@hermes", url: "https://hermes.example.com", username: "liam", password: "hunter2" };

describe("Extra request headers on the sign-in screen", () => {
  it("adds, edits and removes header rows, and drops blank ones on Connect", async () => {
    const onSignIn = vi.fn(async () => {});
    render(<SignIn connection={connection} initial={blank} onSignIn={onSignIn} />);
    const add = screen.getByRole("button", { name: "Add header" });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.type(screen.getByLabelText("Header 1 name"), "CF-Access-Client-Id");
    await userEvent.type(screen.getByLabelText("Header 1 value"), "id.access");
    await userEvent.type(screen.getByLabelText("Header 2 name"), "X-Unwanted");
    await userEvent.type(screen.getByLabelText("Header 3 name"), "CF-Access-Client-Secret");
    await userEvent.type(screen.getByLabelText("Header 3 value"), "s3cret");
    expect(screen.getByLabelText("Header 3 value")).toHaveProperty("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Remove header 2" }));
    await userEvent.click(add); // left blank
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSignIn).toHaveBeenCalledWith({
      ...blank,
      headers: [
        { name: "CF-Access-Client-Id", value: "id.access" },
        { name: "CF-Access-Client-Secret", value: "s3cret" },
      ],
    });
  });

  it("shows only for a URL, since the SSH tunnel goes straight to the dashboard", async () => {
    render(<SignIn connection={connection} initial={{ ...blank, headers: [{ name: "X-A", value: "1" }] }} onSignIn={async () => {}} />);
    expect(screen.getByLabelText("Header 1 name")).toHaveProperty("value", "X-A");
    await userEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(screen.queryByText("Extra request headers")).toBeNull();
  });
});

describe("Header values filled in from the keyring", () => {
  const restored: SignInDetails = { ...blank, password: "", headers: [{ name: "CF-Access-Client-Secret", value: "s3cret-for-a" }] };

  it("are cleared, names kept, once the URL is changed, so they never go to another server", async () => {
    const onSignIn = vi.fn(async () => {});
    render(<SignIn connection={connection} initial={restored} onSignIn={onSignIn} />);
    const url = screen.getByLabelText(/^Dashboard URL/);
    await userEvent.clear(url);
    await userEvent.type(url, "https://other.example.com");
    expect(screen.getByLabelText("Header 1 name")).toHaveProperty("value", "CF-Access-Client-Secret");
    expect(screen.getByLabelText("Header 1 value")).toHaveProperty("value", "");
    expect(screen.getByRole("status").textContent).toContain("saved header values were cleared");
    // Values typed now are meant for the new URL, and are sent.
    await userEvent.type(screen.getByLabelText("Header 1 value"), "s3cret-for-b");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ url: "https://other.example.com", headers: [{ name: "CF-Access-Client-Secret", value: "s3cret-for-b" }] }));
  });

  it("are cleared too when the owner starts in SSH, switches to URL and changes it", async () => {
    render(<SignIn connection={connection} initial={{ ...restored, mode: "ssh" }} onSignIn={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "URL" }));
    expect(screen.getByLabelText("Header 1 value")).toHaveProperty("value", "s3cret-for-a");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), "/");
    expect(screen.getByLabelText("Header 1 value")).toHaveProperty("value", "");
  });

  it("stay while the URL is the one they were saved for", async () => {
    const onSignIn = vi.fn(async () => {});
    render(<SignIn connection={connection} initial={restored} onSignIn={onSignIn} />);
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), " ");
    await userEvent.type(screen.getByLabelText("Dashboard username"), "x");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ headers: restored.headers }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Picking while signing in", () => {
  it("disables every connection option until the sign-in has settled", async () => {
    let finish!: () => void;
    const onPick = vi.fn();
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    render(<SignIn connection={connection} connections={[connection, { ...connection, id: "bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb", name: "Other" }]} initial={blank} onSignIn={() => pending} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    const other = screen.getByRole("button", { name: /Other/ });
    expect(other).toHaveProperty("disabled", true);
    await userEvent.click(other);
    expect(onPick).not.toHaveBeenCalled();
    finish();
    await screen.findByRole("button", { name: "Connect" });
  });
});

describe("The real pipe", () => {
  it("hands Rust the headers for a URL, and none for SSH", async () => {
    const { tauriPipe } = await import("../hermes/tauriPipe");
    const headers = [{ name: "X-A", value: "1" }];
    await tauriPipe({ ...blank, headers }, "saved-connection-1")(() => {}, "default");
    expect(invoke).toHaveBeenLastCalledWith("hermes_connect", expect.objectContaining({ target: { kind: "url", url: blank.url, headers } }));
    await tauriPipe({ ...blank, mode: "ssh", headers }, "saved-connection-1")(() => {}, "default");
    expect(invoke).toHaveBeenLastCalledWith("hermes_connect", expect.objectContaining({ target: { kind: "ssh", target: "liam@hermes" } }));
  });
});

describe("A failed sign-in on the sign-in screen (#550)", () => {
  it("explains a 503 from the sign-in as the sign-in's, with Rust's words under it", () => {
    const message = "The dashboard answered 503: provider unreachable";
    const error = new SignInFailure({ stage: "sign-in", message, answered: { status: 503, body: "provider unreachable" } });
    render(<SignIn connection={connection} initial={blank} error={error} onSignIn={async () => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The dashboard's sign-in isn't available right now.");
    expect(alert.textContent).toContain(message);
  });
});
