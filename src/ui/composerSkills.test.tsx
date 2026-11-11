// @vitest-environment jsdom
// Skills in the composer, in the running app against a fake Hermes: the "/" menu lists the profile's skills after the
// app's commands, "$" opens a skills-only menu anywhere in a message, only skills on for the profile and this app's
// chats are offered, and sending runs the skill through Hermes's command.dispatch while the chat shows the invocation.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
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

const SKILLS = "/home/liam/.hermes/skills";
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nThe ${name} skill's instructions.\n`;
let launches = 0;

/**
 * The app signed in to a fake Hermes with the chat "Nightly backup" open, and skills: `debugging` and `writing` on,
 * `secret` turned off for the profile, `notes` kept off for this app's chats (`tui`), and `rename`, named like one of
 * the app's commands.
 */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  for (const [name, description] of [
    ["debugging", "Find the cause of a failure before fixing it"],
    ["writing", "Write plainly"],
    ["secret", "Never offered"],
    ["notes", "Off in this app"],
    ["rename", "Rename files in bulk"],
  ])
    server.skills.add("default", { dir: `${SKILLS}/${name}`, source: "agent" }, skill(name, description));
  server.skills.disabled.default = new Set(["secret"]);
  server.skills.platformDisabled.default = { tui: ["notes"] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@skills-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const menu = (name: "Commands" | "Skills") => screen.getByRole("listbox", { name });
const names = (name: "Commands" | "Skills") => within(menu(name)).getAllByRole("option").map((o) => o.querySelector(".cmd-name")!.textContent);
const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text));
const dispatched = (server: FakeHermes) => server.requests.filter((r) => r.method === "command.dispatch").map((r) => r.params);
const userMessages = (hermes: Hermes) => hermes.getSnapshot().chats.find((c) => c.id === "backup")!.items.filter((i) => i.kind === "user").map((i) => i.text);

describe("The / menu", () => {
  it("lists the profile's skills that are on, under their own heading after the commands", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("/");
    await waitFor(() => expect(names("Commands")).toContain("/debugging"));
    // Off for the profile, off for this app's chats, and a skill a command's name takes: not here.
    expect(names("Commands")).toEqual(["/help", "/new", "/rename", "/delete", "/steer", "/btw", "/context", "/debugging", "/writing"]);
    expect(within(menu("Commands")).getByText("Skills", { selector: ".cmd-group" })).toBeTruthy();
    const debugging = within(menu("Commands")).getAllByRole("option")[7];
    expect(debugging.textContent).toMatch(/\/debugging.*Skill.*Find the cause of a failure/);

    // Filtered with the command menu's matching: a word of a description counts.
    await user.keyboard("fail");
    expect(names("Commands")).toEqual(["/debugging"]);
  });

  it("fills a skill in, and sending runs it through Hermes while the chat shows what was asked", async () => {
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.keyboard("/deb");
    await waitFor(() => expect(names("Commands")).toEqual(["/debugging"]));
    await user.keyboard("{Enter}");
    expect(composer().value).toBe("/debugging ");
    expect(sent(server)).toEqual([]);
    await user.keyboard("why did the backup fail");
    expect(screen.getByText(/Sends with the debugging skill/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server)).toHaveLength(1));
    expect(dispatched(server)).toEqual([{ name: "debugging", arg: "why did the backup fail", session_id: server.runtimeIdOf("backup") }]);
    expect(sent(server)[0]).toMatch(/^\[IMPORTANT: The user has invoked the "debugging" skill/);
    expect(sent(server)[0]).toContain("The debugging skill's instructions.");
    // The skill's text is for the model; the chat shows the invocation.
    await waitFor(() => expect(userMessages(hermes)).toEqual(["/debugging why did the backup fail"]));
    expect(screen.queryByText(/The debugging skill's instructions/)).toBeNull();
    expect(composer().value).toBe("");
  });

  it("leaves a command and a skill of the same name to the command", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/rename Backups{Enter}");
    await waitFor(() => expect(server.sessions.find((s) => s.id === "backup")?.title).toBe("Backups"));
    expect(dispatched(server)).toEqual([]);
  });
});

describe("The $ menu", () => {
  it("opens anywhere in a message with skills alone, and the message runs the skill named", async () => {
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.keyboard("fix the build using $");
    await waitFor(() => expect(names("Skills")).toEqual(["$debugging", "$rename", "$writing"]));
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    await user.keyboard("deb");
    expect(names("Skills")).toEqual(["$debugging"]);
    await user.keyboard("{Enter}");
    expect(composer().value).toBe("fix the build using $debugging ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("please{Enter}");
    await waitFor(() => expect(sent(server)).toHaveLength(1));
    expect(dispatched(server)).toEqual([{ name: "debugging", arg: "fix the build using $debugging please", session_id: server.runtimeIdOf("backup") }]);
    await waitFor(() => expect(userMessages(hermes)).toEqual(["/debugging fix the build using $debugging please"]));
  });

  it("puts the skill in where the caret is, and reaches a skill named like a command", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard(" and tidy up");
    await user.keyboard("{Home}$ren");
    await waitFor(() => expect(names("Skills")).toEqual(["$rename"]));
    await user.keyboard("{Tab}");
    expect(composer().value).toBe("$rename and tidy up");
    expect(composer().selectionStart).toBe("$rename ".length);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(dispatched(server)).toEqual([{ name: "rename", arg: "$rename and tidy up", session_id: server.runtimeIdOf("backup") }]));
  });

  it("opens nothing for a price or a shell variable, which go as typed", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("it costs $5 and $HOME is set");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText(/Sends with/)).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["it costs $5 and $HOME is set"]));
    expect(dispatched(server)).toEqual([]);
  });

  it("doesn't offer a skill that's off, and its name goes as typed", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("$no");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{Backspace}{Backspace}{Backspace}use $notes and $secret{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["use $notes and $secret"]));
    expect(dispatched(server)).toEqual([]);
  });
});

describe("A message that runs a skill", () => {
  it("can't be queued behind a running reply, and stays in the composer", async () => {
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.keyboard("Run the backup{Enter}");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
    // The first Enter puts the picked skill in, as a command's does; the second would send.
    await user.keyboard("then check it with $debugging{Enter}{Enter}");
    expect(await screen.findByText(/can't be queued/)).toBeTruthy();
    expect(composer().value).toBe("then check it with $debugging ");
    expect(hermes.getSnapshot().queues.backup).toBeUndefined();
    expect(dispatched(server)).toEqual([]);
  });

  it("doesn't steer a running reply either, when Enter steers", async () => {
    setUIPrefs({ followUp: "steer" });
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.keyboard("Run the backup{Enter}");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
    await user.keyboard("then check it with $debugging{Enter}{Enter}");
    expect(await screen.findByText(/can't be queued/)).toBeTruthy();
    expect(composer().value).toBe("then check it with $debugging ");
    expect(dispatched(server)).toEqual([]);
  });

  it("says why it can't go when it would load a skill that's off here", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/debugging /notes now");
    expect(screen.getByText(/notes skill.*off for this app's chats/)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/notes skill.*off for this app's chats/);
    expect(dispatched(server)).toEqual([]);
    expect(sent(server)).toEqual([]);
  });
});

describe("A Hermes that can't run skills from the composer", () => {
  it("shows no skills, opens no $ menu, and sends / text as an ordinary message as before", async () => {
    const { server, user } = await launch((s) => (s.catalogSkills = false));
    await user.click(composer());
    await user.keyboard("/");
    expect(names("Commands")).toEqual(["/help", "/new", "/rename", "/delete", "/steer", "/btw", "/context"]);
    expect(screen.queryByText("Skills")).toBeNull();
    await user.keyboard("{Escape}{Backspace}fix it with $deb");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("ugging{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["fix it with $debugging"]));
    expect(dispatched(server)).toEqual([]);
  });
});
