// @vitest-environment jsdom
// A chat link that starts Hermes Chat (ADR 0037), through the whole App with the Rust side replaced by FakeHermes and
// an in-memory keyring behind `invoke`. With no password saved, the sign-in screen says the link is waiting, and the
// chat opens once the owner signs in. A link that isn't one says so on the sign-in screen and is dropped.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";
import { connectionRefs, formatChatLink } from "../hermes/chatLinks";
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

describe("A chat link at launch", () => {
  it("waits through the sign-in screen, then opens its chat once signed in", async () => {
    const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
    // Signed in before, but the password isn't saved, so the sign-in screen asks.
    localStorage.setItem("hermes-chat.sign-in", JSON.stringify(connection));
    const ref = connectionRefs(localStorage).refFor(connection);
    const links = linkInbox();
    links.arrive("hermes-chat://chat?v=1&connection=abc&profile=default&id=nas");
    const { default: App } = await import("../App");
    render(<App links={links} />);

    // The first link isn't one: the sign-in screen says so, and it's dropped.
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't open that link\. The link's connection isn't one Hermes Chat could have made/);
    expect(links.getSnapshot()).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // The desktop opens a good one while the sign-in screen shows.
    await act(async () => links.arrive(formatChatLink({ connection: ref, profile: "default", chatId: "nas" })));
    expect((await screen.findByLabelText("Chat link")).textContent).toMatch(/A chat link is waiting\. It opens the chat in the default profile once you're signed in\. Nothing is sent/);
    expect(fake.opened).toBe(0);

    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(document.querySelector(".chat-title span")?.textContent).toBe("NAS disks"));
    expect(screen.queryByLabelText("Chat link")).toBeNull();
    expect(links.getSnapshot()).toBeUndefined();
    expect(fake.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  }, 20_000);
});
