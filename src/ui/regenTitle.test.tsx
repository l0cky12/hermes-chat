// @vitest-environment jsdom
// Regenerate title on screen (issue #54): when Hermes can't use the Text generation model's provider, the row keeps
// the old title, says how to fix it, and opens Settings → Model at the Text generation model.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const scrolled: Element[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  scrolled.length = 0;
});

const NOUS_MISSING = "Nous Portal runtime credentials unavailable: Hermes is not logged into Nous Portal. (code: nous_auth_missing)";

async function launch() {
  const s = new FakeHermes();
  s.sessions = [row("a", 1, { pinned: true, title: "Lisbon trip" }), row("b", 2, { pinned: true, title: "Backup job" })];
  s.rest["GET /api/sessions/a/messages"] = () => ({
    session_id: "a",
    profile: "default",
    messages: [
      { id: 1, role: "user", content: "Fix the backup job" },
      { id: 2, role: "assistant", content: "The timer was disabled" },
    ],
    pagination: {},
  });
  // The profile's Text generation model is pinned to Nous Portal, as on the server in the issue.
  s.modelConfig.auxiliary.title_generation = { provider: "nous", model: "hermes-5-70b" };
  s.oneshotFailure = NOUS_MISSING;
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user: userEvent.setup() };
}

async function regenerate(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: new RegExp(title) }) });
  await user.click(screen.getByRole("menuitem", { name: "Regenerate title" }));
  // Settings may show alerts of its own; the row's is the one about the title.
  const note = await screen.findByText(/Couldn't regenerate the title/);
  return note.closest<HTMLElement>("[role=alert]")!;
}

describe("Regenerate title when Hermes isn't signed in to the Text generation model's provider", () => {
  it("keeps the old title, says how to fix it, and keeps Hermes's own words", async () => {
    const { s, user } = await launch();

    const alert = await regenerate(user, "Lisbon trip");

    expect(alert.textContent).toContain(
      "Couldn't regenerate the title: Text generation runs on Nous Portal, and Hermes on the server isn't signed in to Nous Portal. " +
        "Sign it in there with `hermes auth add nous`, or pick another Text generation model in Settings → Model.",
    );
    expect(alert.getAttribute("title")).toBe(`Hermes said: ${NOUS_MISSING}`);
    expect(screen.getByRole("button", { name: /Lisbon trip/ })).toBeTruthy();
    expect(s.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    // Nothing tries another provider: one ask, and no model setting written.
    expect(s.requests.filter((r) => r.method === "llm.oneshot")).toHaveLength(1);
    expect(s.restRequests.filter((r) => r.path === "/api/model/set")).toEqual([]);
  });

  it("opens Settings → Model at the Text generation model, showing it on Nous Portal", async () => {
    const { user } = await launch();
    const alert = await regenerate(user, "Lisbon trip");

    await user.click(within(alert).getByRole("button", { name: "Text generation settings" }));

    expect(screen.getByRole("tab", { name: /Model/ }).getAttribute("aria-selected")).toBe("true");
    const heading = await screen.findByRole("heading", { name: "Text generation" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(scrolled).toContain(heading);
    const card = screen.getByRole("group", { name: "Text generation model" });
    expect(within(card).getByRole("button", { name: "Use the main model for text generation" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't regenerate the title/)).toBeNull();
  });

  it("switches an open Settings screen to the Model tab", async () => {
    const { user } = await launch();
    await user.click(screen.getByTitle("Settings"));
    expect(screen.getByRole("tab", { name: /General/ }).getAttribute("aria-selected")).toBe("true");

    const alert = await regenerate(user, "Lisbon trip");
    await user.click(within(alert).getByRole("button", { name: "Text generation settings" }));

    expect(screen.getByRole("tab", { name: /Model/ }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Text generation" })));
  });

  it("opens Settings from the rail on General, as before", async () => {
    const { user } = await launch();
    const alert = await regenerate(user, "Lisbon trip");
    await user.click(within(alert).getByRole("button", { name: "Text generation settings" }));
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));

    await user.click(screen.getByTitle("Settings"));

    expect(screen.getByRole("tab", { name: /General/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("offers no settings button for a failure the setting can't fix", async () => {
    const { s, user } = await launch();
    s.oneshotFailure = "Request timed out.";

    const alert = await regenerate(user, "Lisbon trip");

    expect(alert.textContent).toBe("Couldn't regenerate the title: one-shot generation failed: Request timed out.");
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});
