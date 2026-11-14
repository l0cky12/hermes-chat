// The canonical session protocol is refused, and the map of what it changes stays whole (ADR 0174): the app turns a
// real canonical gateway's `gateway.ready` away before it sends anything, and every JSON-RPC method the app sends has a
// row in canonicalVerbs.ts saying what that protocol does with it. `Hermes.request`, the one place a JSON-RPC request
// leaves the app, takes only an `AppMethod`, so a method missing from `APP_METHODS` doesn't compile.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_METHODS, APP_VERBS, CANONICAL_READY, type AppMethod } from "./canonicalVerbs";
import { protocolOf } from "./capabilities";
import { FakeHermes } from "./fakeHermes";
import { explainSignIn, signInError } from "./setup";
import type { SignInDetails } from "./tauriPipe";
import { ProtocolMismatchError, connect, type Hermes } from "./transport";

const SRC = join(__dirname, "..");
const TEST_ONLY = /\.test\.tsx?$|[\\/]fake[A-Z][A-Za-z]*\.ts$|[\\/]canonicalVerbs\.ts$/;
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !TEST_ONLY.test(path) ? [path] : [];
  });
const APP_SOURCE_TEXT = sources(SRC).map((path) => readFileSync(path, "utf8"));
const mapped: string[] = APP_VERBS.map((v) => v.method);
const sendOf = (h: Hermes) => h["request"];

describe("the canonical session protocol", () => {
  it("is what a real gateway's gateway.ready names, and a standalone dashboard's is legacy", () => {
    expect(protocolOf(CANONICAL_READY)).toBe("canonical");
    const { session_authority: _, ...dashboard } = CANONICAL_READY;
    expect(protocolOf(dashboard)).toBe("legacy");
  });

  it("is refused before the app sends the server anything", async () => {
    const server = new FakeHermes();
    server.readyPayload = CANONICAL_READY;
    await expect(connect(server.openPipe)).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(server.requests).toEqual([]);
    expect(server.restRequests).toEqual([]);
    expect(server.closed).toBe(true);
  });

  it("is explained on the sign-in screen", async () => {
    const server = new FakeHermes();
    server.readyPayload = CANONICAL_READY;
    const d: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes:9120", username: "liam", password: "pw" };
    const shown = await connect(server.openPipe).catch((e: unknown) => explainSignIn(signInError(e), d));
    expect(shown).toMatchObject({
      stage: "chat",
      problem: "Hermes Chat can't talk to this server yet.",
      fixes: ["This server uses Hermes's newer session protocol. Hermes Chat speaks only the legacy one."],
    });
  });
});

describe("the map of what the canonical protocol does with the app's JSON-RPC methods", () => {
  it("has a row for every method the app sends", () => {
    expectTypeOf<Parameters<ReturnType<typeof sendOf>>[0]>().toEqualTypeOf<AppMethod>();
    expect(APP_METHODS.filter((m) => !mapped.includes(m)), "add a row to APP_VERBS in canonicalVerbs.ts (ADR 0174)").toEqual([]);
  });

  it("has no row for a method the app stopped sending, and one row a shape", () => {
    const named = (method: string) => APP_SOURCE_TEXT.some((text) => text.includes(`"${method}"`));
    expect(APP_METHODS.filter((m) => !named(m))).toEqual([]);
    const rows = APP_VERBS.map((v) => `${v.method} ${v.shape ?? ""}`);
    expect(rows.filter((r, i) => rows.indexOf(r) !== i)).toEqual([]);
  });

  it("says what an adapter sends for each method the canonical protocol refuses or moved", () => {
    const changed = APP_VERBS.filter((v) => v.route === "refused" || (v.route === "authority" && v.answer !== "ok"));
    expect(changed.filter((v) => !v.canonical).map((v) => v.method)).toEqual([]);
    expect([...new Set(changed.map((v) => v.method))].sort()).toEqual([
      "approval.respond",
      "command.dispatch",
      "config.set",
      "prompt.submit",
      "session.branch",
      "session.close",
      "session.compress",
      "session.create",
      "session.cwd.set",
      "session.interrupt",
      "session.resume",
      "session.status",
      "session.title",
      "session.undo",
    ]);
  });
});
