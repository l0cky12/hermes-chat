import { describe, expect, it } from "vitest";
import { firstPick, methodLabel, methodsNote, offered, readMethods, withMethod } from "./signInMethods";
import type { Methods, Reached, SignInDetails, SignInMethod } from "./tauriPipe";

const d: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes:9119", username: "liam", password: "hunter2" };
const basic: SignInMethod = { method: "password", provider: "basic", label: "Basic" };
const ldap: SignInMethod = { method: "password", provider: "ldap", label: "Company login" };
const token: SignInMethod = { method: "token" };

describe("Sign-in methods", () => {
  it("reads them from the first route that answers, and guesses Password with a note when none does", async () => {
    const asked: string[] = [];
    const routes = [
      { id: "off", kind: "lan" as const, target: "http://off:9119", off: true },
      { id: "lan", kind: "lan" as const, target: "http://down:9119" },
      { id: "ts", kind: "tailscale" as const, target: "http://hermes.tail1.ts.net:9119" },
    ];
    const reach = async (one: SignInDetails): Promise<Reached> => {
      asked.push(one.url);
      if (one.url.includes("down")) throw { stage: "reach", message: "refused" };
      return { route: { kind: "url", url: one.url, addresses: [] }, status: '{"version":"0.22.5"}', methods: { methods: [basic, token] } };
    };
    expect(await readMethods(reach, { ...d, routes })).toEqual({ methods: [basic, token] });
    expect(asked).toEqual(["http://down:9119", "http://hermes.tail1.ts.net:9119"]);
    const none = await readMethods(async () => Promise.reject(new Error("down")), d);
    expect(none).toEqual({ methods: [{ method: "password", provider: "basic", label: "Password" }], note: "unread" });
  });

  it("offers what the server lists, starts on the method used last, and keeps a token offered when the list couldn't be read", () => {
    const both: Methods = { methods: [basic, token] };
    const tok = { ...d, method: "token" as const };
    expect(offered(undefined, d)).toEqual([{ method: "password", provider: "basic", label: "Password" }]);
    expect(firstPick(offered(both, tok), tok)).toEqual(token);
    expect(firstPick(offered(both, d), d)).toEqual(basic);
    expect(firstPick(offered({ methods: [token] }, d), d)).toEqual(token);
    expect(offered({ methods: [basic], note: "unread" }, tok)).toEqual([basic, token]);
    expect(offered({ methods: [basic] }, tok)).toEqual([basic]);
    // A status that was read and says no token isn't overruled by the connection's habit.
    expect(offered({ methods: [basic], note: "none-supported" }, tok)).toEqual([basic]);
    expect(offered({ methods: [basic], note: "gate-off" }, tok)).toEqual([basic]);
  });

  it("switching method drops what belonged to the other: a typed token, the password, the provider", () => {
    const tok = withMethod(d, token);
    expect(tok).toMatchObject({ method: "token", password: "", username: "liam" });
    const typed = { ...tok, token: "GOOD", savedToken: "id-1" };
    const back = withMethod(typed, ldap);
    expect(back).toMatchObject({ provider: "ldap", password: "" });
    expect("token" in back || "savedToken" in back || "method" in back).toBe(false);
    expect("provider" in withMethod(back, basic)).toBe(false);
  });

  it("labels a lone password method Password, and several by their own names", () => {
    expect(methodLabel(basic, [basic, token])).toBe("Password");
    expect(methodLabel(token, [basic, token])).toBe("Token");
    expect([basic, ldap].map((m) => methodLabel(m, [basic, ldap, token]))).toEqual(["Basic", "Company login"]);
  });

  it("says why only when it matters: a token connection on a guess, a gate that is off, or a method no longer offered", () => {
    const tok = { ...d, method: "token" as const };
    expect(methodsNote({ methods: [basic], note: "unread" }, d, undefined)).toBeUndefined();
    expect(methodsNote({ methods: [basic], note: "unread" }, tok, "token")).toMatch(/couldn't read which sign-in methods/);
    expect(methodsNote({ methods: [basic], note: "gate-off" }, d, undefined)).toMatch(/sign-in turned off/);
    expect(methodsNote({ methods: [basic] }, d, "token")).toMatch(/doesn't take a token any more/);
    expect(methodsNote({ methods: [basic] }, { ...d, provider: "ldap" }, undefined)).toMatch(/isn't offered by this server any more/);
    expect(methodsNote({ methods: [basic, token] }, tok, "token")).toBeUndefined();
  });
});
