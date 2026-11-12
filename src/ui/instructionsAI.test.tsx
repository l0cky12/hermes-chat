// @vitest-environment jsdom
// Writing a project's instructions with AI (issue #536, ADR 0152), in the running app against a fake Hermes whose
// `llm.oneshot` answers from what it is told and given, as the deployed server's stateless one-off call does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { savedDefaults } from "../hermes/projectDefaults";
import { ASK_INSTRUCTIONS, IMPROVE_INSTRUCTIONS, READY, WRITE_INSTRUCTIONS } from "../hermes/instructionsAI";
import { Main } from "../App";

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

const SCOPE = projectScope({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }, "default");

const budget: FakeProject = {
  id: "p_budget",
  slug: "p_budget",
  name: "Budget Tracker",
  primary_path: "/srv/budget",
  archived: false,
  created_at: 1,
  folders: [{ path: "/srv/budget", label: null, is_primary: true, added_at: 1 }],
};

const QUESTIONS = ["What is this project for?", "What should the assistant always or never do?", "Which stack does it use?"];
const tag = (input: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(input)?.[1];

/**
 * A model that asks `QUESTIONS` in turn, then says it has heard enough; writes a draft naming what it was given; and
 * improves text by upper-casing it, with "(again)" after a retry.
 */
function model({ instructions, input }: { instructions: string; input: string }): string {
  if (instructions === ASK_INSTRUCTIONS) return QUESTIONS[(input.match(/<qa>/g) ?? []).length] ?? READY;
  const again = input.includes("<previous_draft>") ? ` (again${tag(input, "note") ? `: ${tag(input, "note")}` : ""})` : "";
  if (instructions === IMPROVE_INSTRUCTIONS) return `${tag(input, "instructions")!.toUpperCase()}${again}`;
  if (instructions !== WRITE_INSTRUCTIONS) return "?";
  const notes = tag(input, "notes");
  if (notes !== undefined) return `You work on Budget Tracker. ${notes}${again}`;
  const answers = [...input.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((m) => m[1]);
  return `You work on Budget Tracker.\n${answers.map((a) => `- ${a}`).join("\n")}${again}`;
}

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.projects.default = [budget];
  s.serverDirs = new Set(["/srv", "/srv/budget"]);
  for (const dir of s.serverDirs) s.managedFiles.nodes[dir] = { dir: true };
  s.oneshotAnswer = model;
  return s;
}

async function openDefaults(s: FakeHermes, instructions?: string) {
  if (instructions) await savedDefaults.save(SCOPE, "p_budget", 0, { instructions });
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>(".project-btn")!);
  await user.click(await screen.findByRole("option", { name: /Budget Tracker/ }));
  await user.click(screen.getByTitle("Project settings for Budget Tracker"));
  await user.click(screen.getByRole("button", { name: "Project settings" }));
  await user.click(screen.getByRole("menuitem", { name: "Defaults for new chats" }));
  const box = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
  if (instructions) await waitFor(() => expect(box.value).toBe(instructions));
  return { user, hermes, box, before: { rpc: s.requests.length, rest: s.restRequests.length } };
}

const dialog = (name: RegExp) => screen.findByRole("dialog", { name });
const draft = () => screen.findByLabelText("Hermes's draft", { selector: ".instructions-ai-text" });
const oneshots = (s: FakeHermes) => s.requests.filter((r) => r.method === "llm.oneshot").map((r) => r.params);

/** Nothing sent since `before` starts, changes or writes to a chat: no prompt or session method but the list's read, no REST write. */
function onlyOneOffCalls(s: FakeHermes, before: { rpc: number; rest: number }) {
  const rpc = s.requests.slice(before.rpc).map((r) => r.method);
  expect(rpc).toContain("llm.oneshot");
  expect(rpc.filter((m) => m.startsWith("prompt.") || (m.startsWith("session.") && m !== "session.active_list"))).toEqual([]);
  const rest = s.restRequests.slice(before.rest);
  expect(rest.filter((r) => r.method !== "GET")).toEqual([]);
  expect(rest.filter((r) => r.path.includes("/sessions"))).toEqual([]);
  for (const p of oneshots(s)) expect(p.session_id).toBeUndefined();
}

describe("Improve with AI, when the box has text", () => {
  it("shows the model, reviews side by side and as changes, asks again with a note, and only fills the box on Use this", async () => {
    const s = server();
    const { user, box, before } = await openDefaults(s, "Use metric units.");
    await user.click(screen.getByRole("button", { name: "Improve with AI" }));
    const d = await dialog(/Improve the instructions with AI/);
    expect(await within(d).findByText("openrouter · deepseek-v4-flash")).toBeTruthy();
    expect(d.textContent).toContain("profile default's Text generation model");
    expect((await draft()).textContent).toBe("USE METRIC UNITS.");
    expect(within(d).getByLabelText("Your instructions").textContent).toBe("Use metric units.");
    const call = oneshots(s)[0];
    expect(call).toMatchObject({ profile: "default", instructions: IMPROVE_INSTRUCTIONS });
    expect(call.input).toContain("Project name: Budget Tracker");
    expect(call.input).toContain("Folders on the server: /srv/budget");

    await user.click(within(d).getByRole("button", { name: "Changes" }));
    const changes = within(d).getByRole("region", { name: "Changes Hermes made" });
    expect(changes.textContent).toMatch(/1 added.*1 removed/);

    await user.type(within(d).getByRole("textbox", { name: /What to change if you ask again/ }), "shorter");
    await user.click(within(d).getByRole("button", { name: "Ask again" }));
    await user.click(within(d).getByRole("button", { name: "Side by side" }));
    await waitFor(async () => expect((await draft()).textContent).toBe("USE METRIC UNITS. (again: shorter)"));
    expect(oneshots(s)[1].input).toContain("<previous_draft>USE METRIC UNITS.</previous_draft>");

    await user.click(within(d).getByRole("button", { name: "Use this" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box.value).toBe("USE METRIC UNITS. (again: shorter)");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect((await savedDefaults.read(SCOPE)).p_budget).toEqual({ rev: 1, instructions: "Use metric units." });
    onlyOneOffCalls(s, before);

    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    await screen.findByText(/Saved\./);
    expect((await savedDefaults.read(SCOPE)).p_budget).toEqual({ rev: 2, instructions: "USE METRIC UNITS. (again: shorter)" });
  });

  it("keeps the box as it was on Cancel, and on Cancel of the form after Use this", async () => {
    const s = server();
    const { user, box } = await openDefaults(s, "Use metric units.");
    await user.click(screen.getByRole("button", { name: "Improve with AI" }));
    const d = await dialog(/Improve/);
    await draft();
    await user.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box.value).toBe("Use metric units.");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Improve with AI" })));

    await user.click(screen.getByRole("button", { name: "Improve with AI" }));
    await draft();
    await user.click(screen.getByRole("button", { name: "Use this" }));
    expect(box.value).toBe("USE METRIC UNITS.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(box.value).toBe("Use metric units.");
  });

  it("keeps the box as it was when Hermes fails, and tries again", async () => {
    const s = server();
    s.oneshotFailure = "Request timed out.";
    const { user, box } = await openDefaults(s, "Use metric units.");
    await user.click(screen.getByRole("button", { name: "Improve with AI" }));
    const d = await dialog(/Improve/);
    expect((await within(d).findByRole("alert")).textContent).toContain("Hermes couldn't write the instructions: one-shot generation failed: Request timed out.");
    expect(within(d).queryByRole("button", { name: "Use this" })).toBeNull();
    expect(box.value).toBe("Use metric units.");
    s.oneshotFailure = undefined;
    await user.click(within(d).getByRole("button", { name: "Try again" }));
    expect((await draft()).textContent).toBe("USE METRIC UNITS.");
    expect(within(d).queryByRole("alert")).toBeNull();
  });
});

describe("Write with AI, when the box is empty", () => {
  it("writes from the owner's notes, keeps them through a failure, and fills the box on Use this", async () => {
    const s = server();
    const { user, box, before } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions with AI/);
    await user.click(within(d).getByRole("button", { name: /Tell Hermes about the project/ }));
    await user.type(within(d).getByRole("textbox", { name: "About the project" }), "A Rust CLI. Always run cargo test.");

    s.oneshotFailure = "Provider 'openrouter' is set in config.yaml but no API key was found";
    await user.click(within(d).getByRole("button", { name: "Write instructions" }));
    expect((await within(d).findByRole("alert")).textContent).toContain("Text generation runs on openrouter, and Hermes on the server has no API key");
    expect((within(d).getByRole("textbox", { name: "About the project" }) as HTMLTextAreaElement).value).toBe("A Rust CLI. Always run cargo test.");
    expect(box.value).toBe("");

    s.oneshotFailure = undefined;
    await user.click(within(d).getByRole("button", { name: "Write instructions" }));
    expect((await draft()).textContent).toBe("You work on Budget Tracker. A Rust CLI. Always run cargo test.");
    expect(oneshots(s).at(-1)!.instructions).toBe(WRITE_INSTRUCTIONS);
    await user.click(within(d).getByRole("button", { name: "Ask again" }));
    await waitFor(async () => expect((await draft()).textContent).toBe("You work on Budget Tracker. A Rust CLI. Always run cargo test. (again)"));
    await user.click(within(d).getByRole("button", { name: "Use this" }));
    expect(box.value).toBe("You work on Budget Tracker. A Rust CLI. Always run cargo test. (again)");
    expect(screen.getByRole("button", { name: "Improve with AI" })).toBeTruthy();
    expect((await savedDefaults.read(SCOPE)).p_budget).toBeUndefined();
    onlyOneOffCalls(s, before);
  });

  it("asks one question at a time, takes skips, writes once Hermes has heard enough, and each call carries the answers so far", async () => {
    const s = server();
    const { user, box, before } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Let Hermes ask me questions/ }));
    expect(await within(d).findByText(QUESTIONS[0])).toBeTruthy();
    expect(within(d).getByText("Question 1 of up to 8")).toBeTruthy();
    await user.type(within(d).getByRole("textbox", { name: "Your answer" }), "Tracking household spending");
    await user.click(within(d).getByRole("button", { name: "Next question" }));
    expect(await within(d).findByText(QUESTIONS[1])).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Skip" }));
    expect(await within(d).findByText(QUESTIONS[2])).toBeTruthy();
    await user.type(within(d).getByRole("textbox", { name: "Your answer" }), "React and SQLite");
    await user.click(within(d).getByRole("button", { name: "Next question" }));

    // The fourth call says READY, and the fifth writes from the answers.
    expect((await draft()).textContent).toBe("You work on Budget Tracker.\n- Tracking household spending\n- React and SQLite");
    const calls = oneshots(s);
    expect(calls.map((c) => c.instructions)).toEqual([ASK_INSTRUCTIONS, ASK_INSTRUCTIONS, ASK_INSTRUCTIONS, ASK_INSTRUCTIONS, WRITE_INSTRUCTIONS]);
    expect(calls[2].input).toContain(`<qa><question>${QUESTIONS[0]}</question><answer>Tracking household spending</answer></qa>`);
    expect(calls[2].input).toContain(`<qa><question>${QUESTIONS[1]}</question><skipped/></qa>`);
    await user.click(within(d).getByRole("button", { name: "Use this" }));
    expect(box.value).toBe("You work on Budget Tracker.\n- Tracking household spending\n- React and SQLite");
    onlyOneOffCalls(s, before);
  });

  it("writes from the answers after the eighth question, when Hermes never says it has heard enough", async () => {
    const s = server();
    s.oneshotAnswer = (c) => (c.instructions === ASK_INSTRUCTIONS ? `Question number ${(c.input.match(/<qa>/g) ?? []).length + 1}?` : model(c));
    const { user } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Let Hermes ask me questions/ }));
    for (let n = 1; n <= 8; n++) {
      await within(d).findByText(`Question number ${n}?`);
      await user.type(within(d).getByRole("textbox", { name: "Your answer" }), `answer ${n}`);
      await user.click(within(d).getByRole("button", { name: "Next question" }));
    }
    expect((await draft()).textContent).toContain("- answer 8");
    expect(oneshots(s).filter((c) => c.instructions === ASK_INSTRUCTIONS)).toHaveLength(8);
  });

  it("writes at once on Write it now, with the answer being typed, and keeps an answer when the next question fails", async () => {
    const s = server();
    const { user } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Let Hermes ask me questions/ }));
    await within(d).findByText(QUESTIONS[0]);
    const answer = () => within(d).getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement;
    await user.type(answer(), "Tracking household spending");

    s.oneshotFailure = "Request timed out.";
    await user.click(within(d).getByRole("button", { name: "Next question" }));
    expect((await within(d).findByRole("alert")).textContent).toContain("Hermes couldn't ask the next question");
    expect(within(d).getByText(QUESTIONS[0])).toBeTruthy();
    expect(answer().value).toBe("Tracking household spending");

    s.oneshotFailure = undefined;
    await user.click(within(d).getByRole("button", { name: "Write it now" }));
    expect((await draft()).textContent).toBe("You work on Budget Tracker.\n- Tracking household spending");
    await user.click(within(d).getByRole("button", { name: "Back to questions" }));
    expect(within(d).getByText(/Your answers so far \(1 answered, 0 skipped\)/)).toBeTruthy();
  });

  it("stops on Stop, keeping the notes, and drops the answer that comes after", async () => {
    const s = server();
    const answer = s.handlers["llm.oneshot"];
    const held: (() => void)[] = [];
    s.handlers["llm.oneshot"] = (r) => void held.push(() => answer(r));
    const { user, box } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Tell Hermes about the project/ }));
    await user.type(within(d).getByRole("textbox", { name: "About the project" }), "A budget app.");
    await user.click(within(d).getByRole("button", { name: "Write instructions" }));
    expect(within(d).getByRole("status").textContent).toContain("Hermes is writing…");
    expect((within(d).getByRole("textbox", { name: "About the project" }) as HTMLTextAreaElement).readOnly).toBe(true);
    await user.click(within(d).getByRole("button", { name: "Stop" }));
    expect(within(d).queryByRole("status")).toBeNull();
    await act(async () => held.splice(0).forEach((go) => go()));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(within(d).queryByLabelText("Hermes's draft")).toBeNull();
    const notes = within(d).getByRole("textbox", { name: "About the project" }) as HTMLTextAreaElement;
    expect(notes.value).toBe("A budget app.");
    expect(notes.readOnly).toBe(false);
    expect(box.value).toBe("");
  });

  it("won't put a draft over text that changed in the box meanwhile", async () => {
    const s = server();
    const answer = s.handlers["llm.oneshot"];
    const held: (() => void)[] = [];
    s.handlers["llm.oneshot"] = (r) => void held.push(() => answer(r));
    const { user, box } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Tell Hermes about the project/ }));
    await user.type(within(d).getByRole("textbox", { name: "About the project" }), "A budget app.");
    await user.click(within(d).getByRole("button", { name: "Write instructions" }));
    // Another window saves instructions while Hermes writes; the form, with no edits of its own, shows them.
    await savedDefaults.save(SCOPE, "p_budget", 0, { instructions: "Saved elsewhere." });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(box.value).toBe("Saved elsewhere."));
    await act(async () => held.splice(0).forEach((go) => go()));
    await draft();
    expect(within(d).getByRole("alert").textContent).toContain("The Instructions box changed since you asked");
    expect((within(d).getByRole("button", { name: "Use this" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays open with the owner's notes when the connection drops, and can't be opened offline", async () => {
    const s = server();
    const { user, hermes } = await openDefaults(s);
    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    const d = await dialog(/Write the instructions/);
    await user.click(within(d).getByRole("button", { name: /Tell Hermes about the project/ }));
    await user.type(within(d).getByRole("textbox", { name: "About the project" }), "A budget app.");
    await act(async () => s.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
    await user.click(within(d).getByRole("button", { name: "Write instructions" }));
    expect((await within(d).findByRole("alert")).textContent).toContain("Hermes couldn't write the instructions");
    expect((within(d).getByRole("textbox", { name: "About the project" }) as HTMLTextAreaElement).value).toBe("A budget app.");
    await user.click(within(d).getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Write with AI" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
