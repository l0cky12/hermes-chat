// @vitest-environment jsdom
// Settings → Providers' Subscription sign-ins and Custom endpoints on screen (SignInSettings.tsx, EndpointSettings.tsx,
// ADR 0106), against the fake dashboard's `/api/providers/*` routes: a device-code sign-in from code to signed in, and
// each way it can end; signing out after asking; the endpoint form's checks; adding, making default and removing an
// endpoint, each confirmed by the list; and a server without the routes. Every key and code here is synthetic.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { OpenPipe } from "../hermes/pipe";
import { connect, type Hermes } from "../hermes/transport";
import { EndpointSettings } from "./EndpointSettings";
import { SignInSettings } from "./SignInSettings";

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

async function shown(which: "signIns" | "endpoints", { s = new FakeHermes(), profile = "default" } = {}) {
  const hermes = await connect(s.openPipe as OpenPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  const openUrl = vi.fn(async (_url: string) => {});
  const view = render(
    which === "signIns" ? (
      <SignInSettings api={hermes.accounts} profile={profile} connected openUrl={openUrl} pollGapMs={5} />
    ) : (
      <EndpointSettings api={hermes.accounts} profile={profile} connected />
    ),
  );
  return { s, hermes, user, openUrl, view };
}

const rowOf = (name: string) => screen.getByText(name, { selector: ".set-name, .set-name *" }).closest(".set-row") as HTMLElement;
const onScreen = () => document.body.textContent ?? "";
/** The relay calls the screen made, as "METHOD path". */
const sent = (s: FakeHermes) => s.restRequests.map((r) => `${r.method} ${r.path}`);

describe("Settings → Providers, subscription sign-ins", () => {
  it("lists each provider's state: Sign in where the app can drive it, the server command where it can't", async () => {
    const { s } = await shown("signIns");
    await screen.findByText("Nous Portal");
    expect(within(rowOf("Nous Portal")).getByText(/^Signed in/)).toBeTruthy();
    expect(within(rowOf("Nous Portal")).getByRole("button", { name: "Sign out of Nous Portal" })).toBeTruthy();
    expect(within(rowOf("ChatGPT or Codex Subscription")).getByRole("button", { name: "Sign in to ChatGPT or Codex Subscription" })).toBeTruthy();
    const anthropic = rowOf("Anthropic Account");
    expect(within(anthropic).queryByRole("button")).toBeNull();
    expect(within(anthropic).getByText("hermes auth add anthropic", { selector: "code" })).toBeTruthy();
    // The list came from Rust, without previews; the window never read Hermes's own list or revealed a key.
    expect(sent(s)).not.toContain("GET /api/providers/oauth");
    expect(sent(s).some((r) => r.includes("/api/env/reveal"))).toBe(false);
  });

  it("signs in with a device code: shows the code, opens the page, and shows signed in once the list says so", async () => {
    const { s, user, openUrl } = await shown("signIns");
    await user.click(await screen.findByRole("button", { name: "Sign in to ChatGPT or Codex Subscription" }));
    const code = await screen.findByRole("status", { name: "Sign-in code for ChatGPT or Codex Subscription" });
    expect(within(code).getByText(/^WXYZ-\d+$/).tagName).toBe("CODE");
    expect(openUrl).toHaveBeenCalledWith("https://portal.example/device");
    expect(within(code).getByText(/Waiting for you to finish/)).toBeTruthy();
    // Polling, with the profile, while the owner is in the browser.
    await waitFor(() => expect(s.restRequests.filter((r) => r.path.includes("/poll/")).length).toBeGreaterThan(1));
    expect(s.restRequests.find((r) => r.path.includes("/poll/"))?.query.get("profile")).toBe("default");
    s.accounts.settle(s.accounts.pending("openai-codex")!.id, "approved");
    expect(await screen.findByText("Signed in to ChatGPT or Codex Subscription.")).toBeTruthy();
    expect(within(rowOf("ChatGPT or Codex Subscription")).getByRole("button", { name: "Sign out of ChatGPT or Codex Subscription" })).toBeTruthy();
  });

  it.each([
    ["denied", "Not signed in: The sign-in was turned down in the browser."],
    ["expired", "Not signed in: The code expired before the sign-in finished. Start again for a new one."],
    ["error", "Not signed in: Token exchange failed."],
  ] as const)("says why a sign-in that ends %s didn't sign in, and offers Sign in again", async (status, text) => {
    const { s, user } = await shown("signIns");
    await user.click(await screen.findByRole("button", { name: "Sign in to xAI Grok OAuth (SuperGrok / Premium+)" }));
    await screen.findByRole("status", { name: /Sign-in code/ });
    s.accounts.settle(s.accounts.pending("xai-oauth")!.id, status, status === "error" ? "Token exchange failed." : undefined);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("status", { name: /Sign-in code/ })).toBeNull();
    expect(within(rowOf("xAI Grok OAuth (SuperGrok / Premium+)")).getByText("Not signed in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to xAI Grok OAuth (SuperGrok / Premium+)" })).toBeTruthy();
  });

  it("cancels a sign-in under way on Hermes, so it can't finish after the owner gave up", async () => {
    const { s, user } = await shown("signIns");
    await user.click(await screen.findByRole("button", { name: "Sign in to ChatGPT or Codex Subscription" }));
    await screen.findByRole("status", { name: /Sign-in code/ });
    const session = s.accounts.pending("openai-codex")!.id;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Sign-in cancelled.")).toBeTruthy();
    await waitFor(() => expect(s.accounts.sessions.has(session)).toBe(false));
    expect(sent(s)).toContain(`DELETE /api/providers/oauth/sessions/${session}`);
  });

  it("cancels the sign-in when the screen closes", async () => {
    const { s, user, view } = await shown("signIns");
    await user.click(await screen.findByRole("button", { name: "Sign in to ChatGPT or Codex Subscription" }));
    await screen.findByRole("status", { name: /Sign-in code/ });
    const session = s.accounts.pending("openai-codex")!.id;
    view.unmount();
    await waitFor(() => expect(s.accounts.sessions.has(session)).toBe(false));
  });

  it("signs out only after asking, and only once the list shows it signed out", async () => {
    const { s, user } = await shown("signIns");
    await user.click(await screen.findByRole("button", { name: "Sign out of Nous Portal" }));
    const ask = screen.getByRole("alertdialog", { name: "Sign out of Nous Portal?" });
    expect(s.accounts.signedIn.default.has("nous")).toBe(true);
    await user.click(within(ask).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Signed out of Nous Portal.")).toBeTruthy();
    expect(s.accounts.signedIn.default.has("nous")).toBe(false);
    expect(within(rowOf("Nous Portal")).getByRole("button", { name: "Sign in to Nous Portal" })).toBeTruthy();
  });

  it("shows Hermes's reason when it can't sign a provider out from here", async () => {
    const s = new FakeHermes();
    s.accounts.fromEnv.add("nous");
    await shown("signIns", { s });
    await screen.findByText("Nous Portal");
    expect(within(rowOf("Nous Portal")).queryByRole("button")).toBeNull();
    expect(within(rowOf("Nous Portal")).getByText(/Remove the API key from Settings → Keys instead\./)).toBeTruthy();
  });

  it("says a server without the sign-in routes can't do this, without an error", async () => {
    const s = new FakeHermes();
    s.accounts.routes = false;
    await shown("signIns", { s });
    expect(await screen.findByText(/This Hermes server doesn't let Hermes Chat sign in to subscription providers \(Hermes has no such route \(it answered 404\)\)/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Settings → Providers, custom endpoints", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, fields: Partial<Record<"Name" | "Address" | "Model" | "API key", string>>) => {
    for (const [label, value] of Object.entries(fields)) {
      const input = screen.getByLabelText(`Endpoint ${label === "API key" ? label : label.toLowerCase()}`);
      await user.clear(input);
      if (value) {
        await user.click(input);
        await user.paste(value);
      }
    }
  };

  it("says what is wrong with the form before sending anything", async () => {
    const { s, user } = await shown("endpoints");
    await screen.findByText(/No custom endpoint/);
    const add = screen.getByRole("button", { name: "Check and add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await fill(user, { Name: "Ollama", Address: "localhost:11434" });
    await user.click(add);
    expect(screen.getByRole("alert").textContent).toMatch(/starting with http:\/\/ or https:\/\//);
    await fill(user, { Address: "http://ollama:11434/v1", "API key": "sk local" });
    await user.click(add);
    expect(screen.getByRole("alert").textContent).toBe("Paste the API key on one line, without spaces.");
    expect(s.accounts.endpoints.default).toBeUndefined();
  });

  it("adds an endpoint Hermes checked, with the first model it found, and never shows the key", async () => {
    const { s, user } = await shown("endpoints");
    await screen.findByText(/No custom endpoint/);
    await fill(user, { Name: "Groq", Address: "https://api.groq.com/openai/v1", "API key": "gsk_SECRET_0001" });
    await user.click(screen.getByRole("button", { name: "Check and add" }));
    expect(await screen.findByText("Added Groq. Use as default makes Hermes use it.")).toBeTruthy();
    const row = rowOf("Groq");
    expect(within(row).getByText("https://api.groq.com/openai/v1")).toBeTruthy();
    expect(row.textContent).toContain("llama3.2, with a key");
    expect(s.accounts.endpoints.default[0].key).toBe("gsk_SECRET_0001");
    expect(onScreen()).not.toContain("gsk_SECRET");
    expect((screen.getByLabelText("Endpoint API key") as HTMLInputElement).value).toBe("");
    // Saved through Rust: the window never sent the endpoint or its key through the relay.
    expect(s.restRequests.some((r) => r.path.startsWith("/api/providers/custom-endpoints") && r.method === "POST")).toBe(false);
  });

  it("adds one that fails Hermes's check only when the owner says so", async () => {
    const { s, user } = await shown("endpoints");
    await screen.findByText(/No custom endpoint/);
    await fill(user, { Name: "Box", Address: "http://offline-box:8000/v1", Model: "mistral" });
    await user.click(screen.getByRole("button", { name: "Check and add" }));
    const ask = await screen.findByRole("alertdialog", { name: "Add it anyway?" });
    expect(ask.textContent).toContain("Could not reach http://offline-box:8000/v1/models.");
    expect(s.accounts.endpoints.default).toBeUndefined();
    await user.click(within(ask).getByRole("button", { name: "Add anyway" }));
    expect(await screen.findByText("Added Box, unchecked. Use as default makes Hermes use it.")).toBeTruthy();
    expect(rowOf("Box").textContent).toContain("mistral");
  });

  it("makes an endpoint the default, and removes one after asking, each as the list then shows it", async () => {
    const s = new FakeHermes();
    s.accounts.save("default", { name: "Ollama", baseUrl: "http://ollama:11434/v1", model: "", key: "" }, false);
    s.accounts.save("default", { name: "LM Studio", baseUrl: "http://studio:1234/v1", model: "qwen3:8b", key: "" }, false);
    const { user } = await shown("endpoints", { s });
    await screen.findByText("Ollama");
    await user.click(screen.getByRole("button", { name: "Use Ollama as the default" }));
    expect(await screen.findByText("Hermes now uses Ollama by default, with llama3.2.")).toBeTruthy();
    expect(within(rowOf("Ollama")).getByText("Default")).toBeTruthy();
    expect(sent(s)).toContain("POST /api/providers/custom-endpoints/ollama/activate");

    await user.click(screen.getByRole("button", { name: "Remove LM Studio" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Remove LM Studio?" })).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed LM Studio from the default profile.")).toBeTruthy();
    expect(s.accounts.endpoints.default.map((e) => e.id)).toEqual(["ollama"]);
    expect(screen.queryByText("LM Studio", { selector: ".set-name" })).toBeNull();
  });

  it("says a server without the endpoint routes can't do this, without an error", async () => {
    const s = new FakeHermes();
    s.accounts.routes = false;
    await shown("endpoints", { s });
    expect(await screen.findByText(/This Hermes server doesn't let Hermes Chat manage custom endpoints/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
