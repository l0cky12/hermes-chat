// The real pipe over a mocked Tauri `invoke`: a Rust command that fails rejects with the error's text, which every
// pipe call turns into an Error, so the app can say why.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pipe } from "./pipe";
import { explainSignIn, signInError } from "./setup";
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

describe("A sign-in that fails (#550)", () => {
  const STATUS = JSON.stringify({ version: "0.22.5", auth_required: true, auth_providers: ["basic"] });

  it.each([
    [
      "a 503 from the sign-in, as the sign-in's",
      { stage: "sign-in", message: "The dashboard answered 503: provider unreachable", answered: { status: 503, body: "provider unreachable" }, status: STATUS },
      { stage: "sign-in", problem: "The dashboard's sign-in isn't available right now." },
    ],
    [
      "a 503 from the status check, as the status check's",
      { stage: "reach", message: "The dashboard answered 503: down", answered: { status: 503, body: "down" }, status: null },
      { stage: "reach", problem: "The dashboard at hermes answered its status check with a server error. It wasn't sent the password." },
    ],
    [
      "an unanswered failure, at the stage Rust names",
      { stage: "sign-in", message: "Can't reach the Hermes dashboard: connection reset by peer", status: STATUS },
      { stage: "sign-in", problem: "The dashboard's sign-in failed." },
    ],
  ])("explains %s", async (_, failure, explained) => {
    invoke.mockImplementation((command: string) => (command === "hermes_connect" ? Promise.reject(failure) : Promise.resolve()));
    const got = await tauriPipe(nas, "saved-connection-1")(() => {}, "default").catch((e: unknown) => e);
    expect((got as Error).message).toBe(failure.message);
    expect(explainSignIn(signInError(got), nas)).toMatchObject(explained);
  });
});
