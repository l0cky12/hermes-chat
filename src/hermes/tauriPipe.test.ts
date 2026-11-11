// The real pipe over a mocked Tauri `invoke`: a Rust command that fails rejects with the error's text, which every
// pipe call turns into an Error, so the app can say why.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pipe } from "./pipe";
import { type SignInDetails, tauriPipe } from "./tauriPipe";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

const nas: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "pw" };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((command: string) =>
    command === "hermes_connect" ? Promise.resolve({ kind: "ssh", target: "liam@hermes" }) : Promise.reject("The connection to Hermes is closed."),
  );
});

describe("A Rust command that fails", () => {
  it.each<[string, (p: Pipe) => Promise<unknown>]>([
    ["send", (p) => p.send("{}")],
    ["statFiles", (p) => p.statFiles(["/home/liam/rotate.sh"])],
    ["discardUpload", (p) => p.discardUpload(1)],
    ["cancelTransfer", (p) => p.cancelTransfer(1)],
    ["close", (p) => p.close()],
  ])("%s rejects with an Error naming why", async (_, call) => {
    const pipe = await tauriPipe(nas, "saved-connection-1")(() => {}, "default");
    const got = await call(pipe).catch((e: unknown) => e);
    expect(got).toBeInstanceOf(Error);
    expect((got as Error).message).toBe("The connection to Hermes is closed.");
  });
});
