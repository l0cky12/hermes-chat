import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestError } from "./pipe";
import { tauriPipe } from "./tauriPipe";

const calls: { cmd: string; args: Record<string, unknown>; headers?: Record<string, string> }[] = [];
let failWith: unknown;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: unknown) => void;
  },
  invoke: async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push({ cmd, args: args instanceof Uint8Array ? {} : ((args ?? {}) as Record<string, unknown>), headers: options?.headers });
    if (cmd === "hermes_connect") return { kind: "url", url: "https://hermes.example.com", addresses: [] };
    if (cmd === "hermes_transcribe") return { text: "" };
    if (cmd === "hermes_speak") return { mime: "audio/mpeg", audio: "" };
    if (cmd === "hermes_request" && failWith !== undefined) throw failWith;
    return "{}";
  },
}));

const details = { mode: "url" as const, sshTarget: "", url: "https://hermes.example.com", username: "liam", password: "hunter2" };

async function opened() {
  const pipe = await tauriPipe(details)(() => {}, "default");
  const connect = calls.find((c) => c.cmd === "hermes_connect")!;
  return { pipe, attempt: connect.args.attempt as string };
}

describe("The Tauri pipe (#474, #486)", () => {
  beforeEach(() => {
    calls.length = 0;
    failWith = undefined;
  });

  it("names the connection it opened in every later command, across a reopen of its socket", async () => {
    const { pipe, attempt } = await opened();
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
    await pipe.send("{}");
    await pipe.request("GET", "api/sessions");
    await pipe.getLimited("api/files/read?path=x", 10);
    await pipe.voiceSetup("default");
    await pipe.speak("default", "hi");
    await pipe.transcribe("default", new Uint8Array([1]), "audio/webm");
    await pipe.reopen!(() => {}, "default");
    await pipe.request("GET", "api/profiles");

    const after = calls.filter((c) => !["hermes_connect", "hermes_reopen", "hermes_transcribe"].includes(c.cmd));
    expect(after.map((c) => c.cmd)).toEqual(["hermes_send", "hermes_request", "hermes_get_limited", "hermes_voice_setup", "hermes_speak", "hermes_request"]);
    for (const c of after) expect(c.args.attempt, c.cmd).toBe(attempt);
    expect(calls.find((c) => c.cmd === "hermes_transcribe")?.headers?.["x-attempt"]).toBe(attempt);
    expect(pipe.connectionId).toBe(attempt);
    const reopen = calls.find((c) => c.cmd === "hermes_reopen")!;
    expect(reopen.args.connection).toBe(attempt);
    // Its own name, so stopping the reopen can't stop another opening.
    expect(reopen.args.attempt).not.toBe(attempt);
  });

  it("gives each connection opened its own name", async () => {
    const first = await opened();
    calls.length = 0;
    const second = await opened();
    expect(second.attempt).not.toBe(first.attempt);
  });

  it("rejects a dashboard failure with its status and body, and anything else with its text", async () => {
    const { pipe } = await opened();
    failWith = { message: 'The dashboard answered 404: {"detail":"Not Found"}', status: 404, body: '{"detail":"Not Found"}' };
    const refused = await pipe.request("GET", "api/sessions/x").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RestError);
    expect(refused).toMatchObject({ status: 404, detail: "Not Found", message: 'The dashboard answered 404: {"detail":"Not Found"}' });

    failWith = { message: "The chat connection is closed." };
    const closed = await pipe.request("GET", "api/sessions/x").catch((e: unknown) => e);
    expect(closed).not.toBeInstanceOf(RestError);
    expect(closed).toMatchObject({ message: "The chat connection is closed." });

    failWith = "Hermes Chat doesn't relay POST api/x.";
    expect(await pipe.request("GET", "api/sessions/x").catch((e: unknown) => e)).toMatchObject({ message: "Hermes Chat doesn't relay POST api/x." });
  });
});
