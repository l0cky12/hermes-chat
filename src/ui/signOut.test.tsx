// @vitest-environment jsdom
// The whole App signing in with extra request headers through first-run setup and signing out again, with the Rust
// side replaced by FakeHermes and an in-memory keyring behind `invoke`. Sign out must show the sign-in screen with what the keyring has now, even
// when reading it is slow, never the details the screen had before.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const keyring = new Map<string, string>();
const fake = new FakeHermes();
let pipe: Pipe | undefined;
/** When set, reading the saved headers waits for this. */
let headersGate: Promise<void> | undefined;
const connects: unknown[] = [];
const probes: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: PipeEvent) => void;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "hermes_connect": {
        connects.push(args.target);
        const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
        pipe = await fake.openPipe((e) => channel.onmessage(e), args.profile as string);
        return { kind: "url", url: "https://hermes.example.com", addresses: [] };
      }
      case "hermes_probe":
        probes.push(args.target);
        return {
          route: { kind: "url", url: "https://hermes.example.com", addresses: [] },
          status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
          ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: fake.readyPayload } }),
        };
      case "hermes_send":
        return pipe!.send(args.frame as string);
      case "hermes_request":
        return pipe!.request(args.method as "GET", args.path as string, args.body as string | undefined);
      case "hermes_disconnect":
        return pipe?.close();
      case "password_load":
        return keyring.get("password") ?? null;
      case "password_save":
        return void keyring.set("password", args.password as string);
      case "password_delete":
        return void keyring.delete("password");
      case "headers_load":
        await headersGate;
        return keyring.get("headers") ?? null;
      case "headers_save":
        return void keyring.set("headers", args.headers as string);
      case "headers_delete":
        return void keyring.delete("headers");
      default:
        return undefined;
    }
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const value = (label: string | RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe("Signing out with extra request headers", () => {
  it("shows the sign-in screen with the saved URL and headers once the keyring is read, and no password", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    // Nothing is set up yet, so setup opens.
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), "https://hermes.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add header" }));
    await userEvent.type(screen.getByLabelText("Header 1 name"), "CF-Access-Client-Secret");
    await userEvent.type(screen.getByLabelText("Header 1 value"), "s3cret");
    // A row left blank is dropped.
    await userEvent.click(screen.getByRole("button", { name: "Add header" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText("Dashboard username"), "liam");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));

    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByText("CF-Access-Client-Secret")).toBeTruthy();
    const sent = { kind: "url", url: "https://hermes.example.com", headers: [{ name: "CF-Access-Client-Secret", value: "s3cret" }] };
    expect(probes).toEqual([sent]);
    expect(connects).toEqual([sent]);
    expect(JSON.stringify({ ...localStorage })).not.toContain("s3cret");

    let release!: () => void;
    headersGate = new Promise((r) => (release = r));
    await userEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    // Still reading the keyring: the sign-in screen isn't up yet with old details.
    expect(screen.queryByLabelText(/^Dashboard password/)).toBeNull();
    await act(async () => release());

    await waitFor(() => expect(screen.getByLabelText("Header 1 name")).toBeTruthy());
    expect(value(/^Dashboard URL/)).toBe("https://hermes.example.com");
    expect(value("Header 1 name")).toBe("CF-Access-Client-Secret");
    expect(value("Header 1 value")).toBe("s3cret");
    expect(value(/^Dashboard password/)).toBe("");
    expect(keyring.has("password")).toBe(false);
    // The whole first run goes through setup, which takes a while under a full parallel run.
  }, 20_000);
});
