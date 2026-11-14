// @vitest-environment jsdom
// The whole App, with "Reopen last chat on launch" off as it is by default (ADR 0162): launch starts on the New chat
// pane, and the main screen showing again later in the run keeps the chat the owner had open. The Rust side is two
// FakeHermes servers behind `invoke`, one per dashboard URL, and an in-memory keyring keyed by connection.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const ALPHA = "https://alpha.example.com";
const BRAVO = "https://bravo.example.com";
const servers: Record<string, FakeHermes> = { [ALPHA]: new FakeHermes(), [BRAVO]: new FakeHermes() };
const passwords: Record<string, string> = { [ALPHA]: "alpha-pass", [BRAVO]: "bravo-pass" };
/** Keyring entries by `kind:connection`, the migrated connection's as `kind:legacy`. */
const keyring = new Map<string, string>();
/** Every sign-in Rust was asked for: where to, and with which password. */
const connects: { url: string; password: string }[] = [];
let pipe: Pipe | undefined;
let pipeUrl: string | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: PipeEvent) => void;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const slot = `${cmd.split("_")[0]}:${(args.connection as string | null) ?? "legacy"}`;
    switch (cmd) {
      case "hermes_connect": {
        const url = (args.target as { url: string }).url;
        const { password } = args.credential as { password: string };
        connects.push({ url, password });
        if (passwords[url] !== password) throw "Wrong username or password.";
        const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
        pipe = await servers[url].openPipe((e) => channel.onmessage(e), args.profile as string);
        pipeUrl = url;
        return { kind: "url", url, addresses: [] };
      }
      case "hermes_probe": {
        const url = (args.target as { url: string }).url;
        if (passwords[url] !== (args.credential as { password: string }).password) throw { stage: "sign-in", message: "Wrong username or password." };
        return {
          route: { kind: "url", url, addresses: [] },
          status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
          ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: servers[url].readyPayload } }),
        };
      }
      case "hermes_send":
        return pipe!.send(args.frame as string);
      case "hermes_request":
        return pipe!.request(args.method as "GET", args.path as string, args.body as string | undefined);
      case "hermes_disconnect":
        pipeUrl = undefined;
        return pipe?.close();
      case "password_load":
      case "headers_load":
        return keyring.get(slot) ?? null;
      case "password_save":
        return void keyring.set(slot, args.password as string);
      case "headers_save":
        return void keyring.set(slot, args.headers as string);
      case "password_delete":
      case "headers_delete":
        return void keyring.delete(slot);
      default:
        return undefined;
    }
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  // What a computer set up before saved connections has: one sign-in, and its plain password in the keyring.
  localStorage.setItem("hermes-chat.sign-in", JSON.stringify({ mode: "url", sshTarget: "", url: ALPHA, username: "owner" }));
  keyring.set("password:legacy", "alpha-pass");
  servers[ALPHA].sessions = [row("a1", 1, { pinned: true, title: "Alpha backups" })];
  servers[ALPHA].transcripts = { a1: [{ role: "user", text: "Check the backups" }, { role: "assistant", text: "They ran." }] };
  // The chat open when the app last closed, with reopening on as it was by default before version 5. The migrated sign-in
  // keeps its prefs under the bare profile name (prefScope).
  localStorage.setItem("hermes-ui-prefs", JSON.stringify({ v: 4, reopenLastChat: true, lastOpenChat: { default: "a1" } }));
  servers[BRAVO].sessions = [row("b1", 1, { pinned: true, title: "Bravo notes" })];
});
afterEach(cleanup);

const composer = () => screen.getAllByRole("textbox").find((e) => e.closest(".composer")) as HTMLTextAreaElement;
const openRail = async () => userEvent.click(await screen.findByRole("button", { name: /Switch connection/ }));
/** The title of the chat on screen: "New chat" for the New chat pane. */
const onScreen = () => document.querySelector(".chat-title span")?.textContent;

describe("Reopening across one run", () => {
  it("launches on the New chat pane, and keeps the chat opened since when a failed Save and connect puts the connection back", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    expect(await screen.findByText("Alpha backups", {}, { timeout: 15_000 })).toBeTruthy();
    await act(async () => {});
    expect(onScreen()).toBe("New chat");

    await userEvent.click(screen.getByText("Alpha backups"));
    await waitFor(() => expect(onScreen()).toBe("Alpha backups"));

    // Setup tests the second server, which then turns its password down when the app connects for real.
    await openRail();
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Home");
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), BRAVO);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "bravo-pass");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const save = await screen.findByRole("button", { name: "Save and connect" });
    passwords[BRAVO] = "changed meanwhile";
    await userEvent.click(save);
    await waitFor(() => expect(connects.at(-1)).toEqual({ url: BRAVO, password: "bravo-pass" }));
    await waitFor(() => expect(pipeUrl).toBe(ALPHA));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel setup" }));

    await waitFor(() => expect(onScreen()).toBe("Alpha backups"));
  });
});
