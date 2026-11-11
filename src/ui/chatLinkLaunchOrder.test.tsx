// @vitest-environment jsdom
// A chat link that starts Hermes Chat (ADR 0037), through the whole App with the Rust side replaced by FakeHermes and
// an in-memory keyring behind `invoke`. Here the password is saved, so signing in is quick, and reading the link the
// app was started with is slow: the last open chat must not be reopened in the meantime.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";
import { connectionRefs, formatChatLink } from "../hermes/chatLinks";
import { rememberOpenChat } from "../hermes/uiPrefs";
import { linkInbox } from "../hermes/tauriLinks";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const keyring = new Map<string, string>();
const fake = new FakeHermes();
fake.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
let pipe: Pipe | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: PipeEvent) => void;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "hermes_connect": {
        const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
        pipe = await fake.openPipe((e) => channel.onmessage(e), args.profile as string);
        return { kind: "ssh", target: "liam@hermes", addresses: [] };
      }
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

describe("A chat link at launch with the password saved", () => {
  it("waits for the launch link before reopening anything, then opens the linked chat", async () => {
    const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
    localStorage.setItem("hermes-chat.sign-in", JSON.stringify(connection));
    keyring.set("password", "hunter2");
    // The chat that would reopen at launch without a link.
    rememberOpenChat("default", "backup");
    const ref = connectionRefs(localStorage).refFor(connection);
    let release!: () => void;
    const slowRead = new Promise<void>((r) => (release = r));
    const links = linkInbox(async (arrive) => {
      await slowRead;
      arrive(formatChatLink({ connection: ref, profile: "default", chatId: "nas" }));
    });
    const { default: App } = await import("../App");
    render(<App links={links} />);

    // Signed in, but the launch link isn't read yet: nothing opens.
    await waitFor(() => expect(fake.opened).toBeGreaterThan(0));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByText("Signing in…")).toBeTruthy();
    expect(document.querySelector(".chat-title")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(document.querySelector(".chat-title span")?.textContent).toBe("NAS disks"));
    expect(screen.queryByLabelText("Chat link")).toBeNull();
    expect(fake.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  }, 30_000);
});
