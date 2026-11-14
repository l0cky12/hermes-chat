// @vitest-environment jsdom
// The Subagents panel (ADR 0072), driven the way the owner would, against a fake Hermes: what shows, and what reaches
// Hermes when they steer or stop one.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { offsetText, spanText } from "./Subagents";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const panel = () => screen.getByRole("region", { name: "Subagents" });
const who = (subagent_id: string, goal: string, more: Record<string, unknown> = {}) => ({ goal, task_count: 1, task_index: 0, subagent_id, depth: 0, model: "claude-sonnet-4-5", ...more });

/** Signed in, with "Audit" open, its reply running with two subagents and one under the first. */
async function auditing() {
  const server = new FakeHermes();
  server.sessions = [row("audit", 1, { pinned: true, title: "Audit" })];
  server.transcripts = { audit: [{ role: "user", text: "Audit the repo" }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Audit/ }));
  await settle(hermes);
  const runtime = server.runtimeIdOf("audit")!;
  server.subagents.audit = [
    { subagent_id: "sa-auth", owner: runtime, accepting_steer: true, status: "running", tail: "Reading src/auth.ts\nFound 2 token checks" },
    { subagent_id: "sa-tests", owner: runtime, accepting_steer: true, status: "running" },
    { subagent_id: "sa-expiry", owner: runtime, accepting_steer: true, status: "running" },
  ];
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("sa-auth", "Read the auth code"));
    server.event(runtime, "subagent.start", who("sa-tests", "Read the tests"));
    server.event(runtime, "subagent.start", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1 }));
    server.event(runtime, "subagent.tool", who("sa-auth", "Read the auth code", { tool_name: "read_file", tool_preview: "src/auth.ts", tool_count: 1 }));
  });
  return { server, hermes, user, runtime };
}

describe("The Subagents panel", () => {
  it("shows a tree of who started whom, and opens one to its own activity and output, apart from the chat", async () => {
    const { server, user } = await auditing();
    expect(within(panel()).getByText("3 running · 3 in all")).toBeTruthy();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));

    const top = within(panel()).getByRole("list", { name: "Started by the chat's reply" });
    expect(within(top).getAllByRole("button").map((b) => b.querySelector(".subagent-goal")!.textContent)).toEqual(["Read the auth code", "Check token expiry", "Read the tests"]);
    expect(within(panel()).getByRole("list", { name: "Started by Read the auth code" })).toBeTruthy();

    const lists = server.requests.filter((r) => r.method === "subagent.list").length;
    await user.click(within(panel()).getByRole("button", { name: /Read the auth code/ }));
    expect(within(panel()).getByRole("heading", { name: "Read the auth code" })).toBe(document.activeElement);
    // Opening one reads Hermes's roster again, which is how it tells of nested subagents' tools.
    await waitFor(() => expect(server.requests.filter((r) => r.method === "subagent.list").length).toBe(lists + 1));
    expect(within(panel()).getByText("src/auth.ts")).toBeTruthy();
    await user.click(within(panel()).getByRole("tab", { name: "Output" }));
    await waitFor(() => expect(within(panel()).getByText(/Found 2 token checks/)).toBeTruthy());
    // The transcript holds only the chat's own messages.
    expect(document.querySelector(".transcript")!.textContent).not.toMatch(/Found 2 token checks|auth code/);

    await user.click(within(panel()).getByRole("button", { name: "All subagents" }));
    expect(document.activeElement?.getAttribute("data-subagent")).toBe("sa-auth");
  });

  it("stops only the subagent named, saying what else stops with it, from the keyboard", async () => {
    const { server, user, runtime } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the auth code/ }));
    const trigger = within(panel()).getByRole("button", { name: "Stop" });
    await user.click(trigger);
    const ask = within(panel()).getByRole("group", { name: "Stop this subagent?" });
    expect(ask.textContent).toMatch(/Stop “Read the auth code” \(sa-auth\)\? “Check token expiry”, which it started, stops with it/);
    expect(ask.textContent).toMatch(/The chat's reply and the other subagents keep going/);
    // The question starts on Cancel, so Enter alone stops nothing; Escape puts focus back where it came from and stays
    // in the subagent.
    await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Escape}");
    expect(within(panel()).queryByRole("group", { name: "Stop this subagent?" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(within(panel()).getByRole("heading", { name: "Read the auth code" })).toBeTruthy();
    expect(server.requests.filter((r) => r.method === "subagent.interrupt")).toEqual([]);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(panel()).getByText(/Asked Hermes to stop “Read the auth code”/)).toBe(document.activeElement));
    expect(server.requests.filter((r) => r.method === "subagent.interrupt").map((r) => r.params)).toEqual([{ session_id: runtime, subagent_id: "sa-auth" }]);
    expect(server.interrupted).toEqual(["sa-auth"]);
  });

  it("moves focus to the subagent's name when it ends while its Steer box has focus", async () => {
    const { server, user, runtime } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the tests/ }));
    await user.click(within(panel()).getByLabelText(/Steer “Read the tests”/));
    act(() => server.event(runtime, "subagent.complete", who("sa-tests", "Read the tests", { status: "completed", summary: "All green." })));
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByRole("heading", { name: "Read the tests" })));
    expect(within(panel()).queryByLabelText(/Steer “Read the tests”/)).toBeNull();
  });

  it("steers only the subagent named", async () => {
    const { server, user, runtime } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the tests/ }));
    const box = within(panel()).getByLabelText(/Steer “Read the tests”/);
    await user.click(box);
    await user.paste("Skip the snapshot tests");
    await user.click(within(panel()).getByRole("button", { name: "Steer it" }));
    await waitFor(() => expect(within(panel()).getByText(/Steered “Read the tests”/)).toBeTruthy());
    // The box, disabled while the steer went, has focus again, empty for the next one.
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect(server.requests.filter((r) => r.method === "subagent.steer").map((r) => r.params)).toEqual([
      { session_id: runtime, subagent_id: "sa-tests", text: "Skip the snapshot tests" },
    ]);
    expect(server.steered).toEqual({ "sa-tests": ["Skip the snapshot tests"] });
  });

  it("keeps a Steer draft when Esc is pressed in it, and goes back on the next Esc", async () => {
    const { user } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the tests/ }));
    const box = within(panel()).getByLabelText(/Steer “Read the tests”/);
    await user.click(box);
    await user.paste("Skip the slow tests");
    await user.keyboard("{Escape}");
    expect(within(panel()).getByRole("heading", { name: "Read the tests" })).toBe(document.activeElement);
    expect((box as HTMLTextAreaElement).value).toBe("Skip the slow tests");
    await user.keyboard("{Escape}");
    expect(within(panel()).queryByRole("heading", { name: "Read the tests" })).toBeNull();
    expect(document.activeElement?.getAttribute("data-subagent")).toBe("sa-tests");
  });

  it("opens a tool line the drawer cuts short, but not when the click ends a selection in it", async () => {
    // jsdom lays nothing out: every preview is made wider than its line, so each is cut short.
    const widths = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("tool-preview") ? 500 : 0;
    });
    try {
      const { user } = await auditing();
      await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
      await user.click(within(panel()).getByRole("button", { name: /Read the auth code/ }));
      const line = await within(panel()).findByRole("button", { name: /read_file\s*src\/auth\.ts/ });
      expect(line.getAttribute("aria-expanded")).toBe("false");
      // A drag that selected part of the command leaves it as it was: its click comes with the selection still there
      // (user-event's own click would first collapse it, as a press without a drag does).
      getSelection()!.selectAllChildren(line.querySelector(".tool-preview")!);
      fireEvent.click(line, { detail: 1 });
      expect(line.getAttribute("aria-expanded")).toBe("false");
      // Enter still opens and closes it with the selection there.
      line.focus();
      await user.keyboard("{Enter}");
      expect(line.getAttribute("aria-expanded")).toBe("true");
      await user.keyboard("{Enter}");
      expect(line.getAttribute("aria-expanded")).toBe("false");
      getSelection()!.removeAllRanges();
      await user.click(line);
      expect(line.getAttribute("aria-expanded")).toBe("true");
      await user.click(line);
      expect(line.getAttribute("aria-expanded")).toBe("false");
    } finally {
      widths.mockRestore();
    }
  });

  it("points to the chat's waiting Approval, and leaves answering it to the owner", async () => {
    const { server, user, runtime } = await auditing();
    act(() => void server.askApproval(runtime));
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: "Go to it" }));
    expect(document.activeElement?.classList.contains("approval")).toBe(true);
    expect(server.approvalAnswers).toEqual([]);
  });

  it("shows a failed subagent while the reply goes on, and has no Steer or Stop for one that ended", async () => {
    const { server, user, runtime } = await auditing();
    act(() => {
      server.event(runtime, "subagent.complete", who("sa-tests", "Read the tests", { status: "failed", summary: "pytest isn't installed." }));
      server.event(runtime, "message.delta", { text: "Carrying on without the tests." });
    });
    expect(within(panel()).getByText("2 running · 1 failed · 3 in all")).toBeTruthy();
    expect(screen.getByText("Carrying on without the tests.")).toBeTruthy();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the tests/ }));
    expect(within(panel()).getByText("pytest isn't installed.")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(panel()).getByText("It has ended, so it can't be steered or stopped.")).toBeTruthy();
  });
  it("puts its activity, output and subagents on tabs the arrow keys move between, and Output only while it runs", async () => {
    const { server, user, runtime } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the auth code/ }));
    const tabs = within(panel()).getByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Activity1", "Output", "Subagents1"]);
    within(tabs).getByRole("tab", { selected: true }).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(tabs).getByRole("tab", { name: "Output", selected: true }));
    await waitFor(() => expect(within(panel()).getByText(/Found 2 token checks/)).toBeTruthy());
    await user.keyboard("{End}");
    expect(within(tabs).getByRole("tab", { name: /Subagents/, selected: true })).toBe(document.activeElement);
    // Its own subagents open from their tab, and the one they open names who started it.
    await user.click(within(panel()).getByRole("button", { name: /Check token expiry/ }));
    expect(within(panel()).getByRole("heading", { name: "Check token expiry" })).toBe(document.activeElement);
    await user.click(within(panel()).getByRole("button", { name: "Read the auth code" }));
    expect(within(panel()).getByRole("heading", { name: "Read the auth code" })).toBe(document.activeElement);

    act(() => server.event(runtime, "subagent.complete", who("sa-auth", "Read the auth code", { status: "completed", summary: "Two token checks, both fine." })));
    expect(within(within(panel()).getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Activity2", "Subagents1"]);
    expect(within(panel()).getByText("Two token checks, both fine.")).toBeTruthy();
    expect(within(panel()).getByText("How it ended")).toBeTruthy();
  });

  it("steps to the subagents beside it with Alt and the arrow keys", async () => {
    const { user } = await auditing();
    await user.click(within(panel()).getByRole("button", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Read the auth code/ }));
    expect(within(panel()).getByRole("group", { name: "The subagents beside it" }).textContent).toBe("1 / 2");
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(within(panel()).getByRole("heading", { name: "Read the tests" })).toBe(document.activeElement);
    await user.click(within(panel()).getByRole("button", { name: "Next subagent" }));
    expect(within(panel()).getByRole("heading", { name: "Read the auth code" })).toBe(document.activeElement);
    // One with no others beside it has no arrows.
    await user.click(within(panel()).getByRole("tab", { name: /Subagents/ }));
    await user.click(within(panel()).getByRole("button", { name: /Check token expiry/ }));
    expect(within(panel()).queryByRole("group", { name: "The subagents beside it" })).toBeNull();
  });
});

describe("Subagent times", () => {
  it("reads as a length, and as a time since its start", () => {
    expect([3.4, 41.2, 95, 3720].map(spanText)).toEqual(["3.4s", "41s", "1m 35s", "1h 02m"]);
    expect([3, 62, 3723].map(offsetText)).toEqual(["+0:03", "+1:02", "+1:02:03"]);
  });
});
