// @vitest-environment jsdom
// The whole App with two saved connections (ADR 0112): the single sign-in kept before is migrated and signs in at
// launch, a second server is added through setup, and the owner switches between them and removes one. The Rust side
// is two FakeHermes servers behind `invoke`, one per dashboard URL, and an in-memory keyring keyed by connection.
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
  servers[BRAVO].sessions = [row("b1", 1, { pinned: true, title: "Bravo notes" })];
});
afterEach(cleanup);

const composer = () => screen.getAllByRole("textbox").find((e) => e.closest(".composer")) as HTMLTextAreaElement;
const openRail = async () => userEvent.click(await screen.findByRole("button", { name: /Switch connection/ }));
const submits = (url: string) => servers[url].requests.filter((r) => r.method === "prompt.submit");

describe("Saved connections", () => {
  it("migrates the old sign-in, adds a second server, switches both ways keeping each one's draft and secrets, and removes one", async () => {
    const { default: App } = await import("../App");
    render(<App />);

    // Launch signs in to the migrated connection with its old keyring entry. A cold launch, sign-in then the first
    // mount of the main screen, takes about 0.7s on an idle machine, so findBy's 1s default runs out on a busy one (#322).
    expect(await screen.findByText("Alpha backups", {}, { timeout: 15_000 })).toBeTruthy();
    expect(connects).toEqual([{ url: ALPHA, password: "alpha-pass" }]);
    await userEvent.type(composer(), "draft for alpha");

    // Add a second server through setup.
    await openRail();
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Home");
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), BRAVO);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "bravo-pass");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));

    expect(await screen.findByText("Bravo notes")).toBeTruthy();
    expect(screen.queryByText("Alpha backups")).toBeNull();
    // Bravo's own New chat draft, not alpha's.
    await waitFor(() => expect(composer().value).toBe(""));
    await userEvent.type(composer(), "draft for bravo");
    expect(pipeUrl).toBe(BRAVO);

    // Back to alpha from the recent-connection picker: nothing is running, so it switches at once.
    await openRail();
    const menu = screen.getByRole("dialog", { name: "Switch connection" });
    const options = within(menu).getAllByRole("button").filter((b) => b.classList.contains("conn-option"));
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Home"), expect.stringContaining("alpha.example.com")]);
    await userEvent.click(options[1]);
    expect(await screen.findByText("Alpha backups")).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe("draft for alpha"));
    // Each server only ever got its own password.
    expect(connects).toEqual([
      { url: ALPHA, password: "alpha-pass" },
      { url: BRAVO, password: "bravo-pass" },
      { url: ALPHA, password: "alpha-pass" },
    ]);

    // An Approval waiting in alpha: switching asks first, and Stay stays.
    await userEvent.click(screen.getByText("Alpha backups"));
    await waitFor(() => expect(servers[ALPHA].runtimeIdOf("a1")).toBeTruthy());
    act(() => void servers[ALPHA].askApproval(servers[ALPHA].runtimeIdOf("a1")!));
    await screen.findByText(/rm -rf/);
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("Home"));
    const ask = await screen.findByRole("alertdialog", { name: "Switch to Home?" });
    expect(within(ask).getByText(/An Approval is waiting for you: “Alpha backups” in default/)).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Stay");
    await userEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(pipeUrl).toBe(ALPHA);

    // Setup tests while this Approval waits, but must ask again immediately before it replaces the connection.
    await openRail();
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Another");
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), BRAVO);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(screen.getByLabelText("Dashboard username"), "owner");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "bravo-pass");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    const setupAsk = await screen.findByRole("alertdialog", { name: "Switch to Another?" });
    expect(within(setupAsk).getByText(/An Approval is waiting/)).toBeTruthy();
    await userEvent.click(within(setupAsk).getByRole("button", { name: "Stay" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(pipeUrl).toBe(ALPHA);
    expect(connects.at(-1)?.url).toBe(ALPHA);
    await userEvent.click(screen.getByRole("button", { name: "Cancel setup" }));

    // Switch anyway: bravo, with its draft and its own chats; nothing of alpha's went to it.
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("Home"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch anyway" }));
    expect(await screen.findByText("Bravo notes")).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe("draft for bravo"));
    expect(submits(BRAVO)).toEqual([]);
    expect(JSON.stringify(servers[BRAVO].restRequests)).not.toContain("a1");

    // Editing another saved connection restores that destination's open chat too.
    await userEvent.click(screen.getByText("Bravo notes"));
    await waitFor(() => expect(servers[BRAVO].runtimeIdOf("b1")).toBeTruthy());
    act(() => { for (const id of servers[ALPHA].openRequests.keys()) servers[ALPHA].cancelRequest(id, "synthetic timeout"); });
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("alpha.example.com"));
    await screen.findAllByText("Alpha backups");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit Home" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText(/^Dashboard password/), "bravo-pass");
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getAllByText("Bravo notes").some(el => el.closest(".row")?.classList.contains("sel"))).toBe(true));

    // Remove alpha from Settings: it says what goes, and the server's chats stay.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove alpha.example.com" }));
    const remove = await screen.findByRole("alertdialog", { name: "Remove alpha.example.com?" });
    expect(within(remove).getByText(/Nothing on the Hermes server is changed/)).toBeTruthy();
    const alphaRequests = servers[ALPHA].requests.length;
    await userEvent.click(within(remove).getByRole("button", { name: /Remove connection/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove alpha.example.com" })).toBeNull());
    expect(keyring.has("password:legacy")).toBe(false);
    expect(Object.keys(localStorage).some((k) => k.includes(ALPHA))).toBe(false);
    expect(Object.values(localStorage).some((v) => String(v).includes("draft for bravo"))).toBe(true);
    expect(servers[ALPHA].requests.length).toBe(alphaRequests);
    expect(servers[ALPHA].sessions.map((s) => s.id)).toEqual(["a1"]);

    // If local cleanup fails after closing the active transport, Main cannot keep using it.
    const { savedDefaults } = await import("../hermes/projectDefaults");
    let failCleanup: (error: Error) => void = () => {};
    const unreadable = vi.spyOn(savedDefaults, "forgetScopes").mockImplementationOnce(() => new Promise((_, reject) => { failCleanup = reject; }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Home" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /Remove connection/ }));
    expect(await screen.findByText("Removing Home…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByLabelText(/^Dashboard password/)).toBeNull();
    act(() => failCleanup(new Error("project-defaults.json is unreadable")));
    expect(await screen.findByText(/Couldn't finish removing this connection/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(pipeUrl).toBeUndefined();
    unreadable.mockRestore();
  }, 60_000);
});
