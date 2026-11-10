// The pure parts of accounts.ts: how Hermes's poll answer reads as sign-in progress, and the Add an endpoint form's
// rules, which `Dashboard::save_endpoint` checks again.
import { describe, expect, it } from "vitest";
import { endpointFormProblem, progressOf } from "./accounts";

describe("progressOf", () => {
  it.each([
    [{ status: "pending" }, { state: "pending" }],
    [{ status: "approved", account_email: "a@example.com" }, { state: "approved" }],
    [{ status: "denied", error_message: null }, { state: "failed", why: "The sign-in was turned down in the browser." }],
    [{ status: "denied", error_message: "Access denied by the account owner." }, { state: "failed", why: "Access denied by the account owner." }],
    [{ status: "expired" }, { state: "failed", why: "The code expired before the sign-in finished. Start again for a new one." }],
    [{ status: "cancelled" }, { state: "failed", why: "The sign-in was cancelled." }],
    [{ status: "error", error_message: "  Token exchange failed. " }, { state: "failed", why: "Token exchange failed." }],
    [{ status: "something-new" }, { state: "failed", why: "Hermes couldn't finish the sign-in, and didn't say why." }],
    [null, { state: "failed", why: "Hermes couldn't finish the sign-in, and didn't say why." }],
  ])("%j reads as %j", (answer, progress) => {
    expect(progressOf(answer)).toEqual(progress);
  });
});

describe("endpointFormProblem", () => {
  const form = (o: Partial<{ name: string; baseUrl: string; model: string; key: string }>) => ({ name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "", key: "", ...o });

  it.each([
    [{}],
    [{ baseUrl: "https://api.groq.com/openai/v1", key: "  gsk_abc  " }],
    [{ baseUrl: "http://[::1]:8000/v1", model: "qwen3:8b" }],
  ])("takes %j", (o) => {
    expect(endpointFormProblem(form(o))).toBeUndefined();
  });

  it.each([
    [{ name: "  " }, /name/],
    [{ name: "x".repeat(65) }, /name/],
    [{ baseUrl: "localhost:11434" }, /http:\/\/ or https:\/\//],
    [{ baseUrl: "ftp://box/v1" }, /http:\/\/ or https:\/\//],
    [{ baseUrl: "not a url" }, /http:\/\/ or https:\/\//],
    [{ model: "m".repeat(257) }, /model/],
    [{ key: "sk one" }, /one line/],
    [{ key: "sk\none" }, /one line/],
  ])("refuses %j", (o, why) => {
    expect(endpointFormProblem(form(o))).toMatch(why);
  });
});
