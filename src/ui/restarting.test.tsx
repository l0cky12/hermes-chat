// @vitest-environment jsdom
// Restarting into an update: the drafts were saved when it began, so the window takes no more typing until it goes.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { snapshotDrafts, type Updater, type UpdateState } from "../hermes/updates";
import { sending } from "../hermes/unsaved";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

let hermes: Hermes | undefined;
afterEach(async () => {
  cleanup();
  await hermes?.close();
  localStorage.clear();
});

let state: UpdateState;
const listeners = new Set<() => void>();
const updates: Updater = {
  getSnapshot: () => state,
  subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
  check: async () => {},
  install: async () => {},
  restart: async () => {},
  restoreAfterRestart: async () => {},
};

async function launch(s: FakeHermes) {
  state = { state: "restart", from: "r1.ef433a2-1", to: "r2.4444444-1" };
  hermes = await connect(s.openPipe);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} updates={updates} />);
  await waitFor(() => expect(hermes!.hasListed()).toBe(true));
}

it("makes the window inert, and says so, while it restarts", async () => {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { title: "Nightly backup" })];
  await launch(s);
  const app = document.querySelector(".app")!;
  expect(app.hasAttribute("inert")).toBe(false);
  expect(screen.getByTitle(/an update is ready/)).toBeTruthy();

  act(() => {
    state = { state: "restarting", from: "r1.ef433a2-1", to: "r2.4444444-1" };
    listeners.forEach((fn) => fn());
  });
  expect(app.hasAttribute("inert")).toBe(true);
  const overlay = screen.getByRole("status");
  expect(overlay.textContent).toBe("Restarting into r2.4444444-1…");
  expect(app.contains(overlay)).toBe(false);
});

it("keeps a New chat message whose chat is still being started for the restart, and doesn't send it", async () => {
  const s = new FakeHermes();
  const create = s.handlers["session.create"];
  let held: Parameters<typeof create>[0] | undefined;
  s.handlers["session.create"] = (r) => void (held = r);
  await launch(s);
  const user = userEvent.setup();
  const composer = screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
  await user.type(composer, "Plan the migration{Enter}");
  await waitFor(() => expect(held).toBeTruthy());
  // The composer is empty and no outbox has it yet; the restart's copy still does.
  expect(composer.value).toBe("");
  expect(Object.values(JSON.parse(snapshotDrafts(localStorage)))).toEqual(["Plan the migration"]);

  // The chat is made as the app restarts: the message, a draft in the restart's copy, isn't sent as well.
  await act(async () => create(held!));
  await waitFor(() => expect(sending.size).toBe(0));
  expect(s.requests.some((r) => r.method === "prompt.submit")).toBe(false);
  expect(Object.values(JSON.parse(snapshotDrafts(localStorage)))).toEqual(["Plan the migration"]);
});
