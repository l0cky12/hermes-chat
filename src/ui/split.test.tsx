// @vitest-environment jsdom
// Two chats side by side, driven the way the owner would, against a fake Hermes. Each test checks what is on screen
// in each pane and what reached Hermes, not which handler ran.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { localChatCache, outboxAttachmentPaths, subscribeOutbox } from "../hermes/chatCache";
import { savedDefaults } from "../hermes/projectDefaults";
import { projectScope } from "../hermes/projectLinks";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY } from "../hermes/uiPrefs";
import { Main, type Screenshots } from "../App";
import type { Captured } from "../hermes/screenshots";
import { RestError } from "../hermes/pipe";

const drops = vi.hoisted(() => new Set<(e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => { drops.add(cb); return () => drops.delete(cb); },
}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  drops.clear();
  vi.restoreAllMocks();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");

const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
const pane = (i: number) => panes()[i];
const titleIn = (i: number) => pane(i).querySelector(".chat-title span")?.textContent;
const composerIn = (i: number) => within(pane(i)).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const activeIndex = () => panes().findIndex((p) => p.classList.contains("active"));
const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const lastOpen = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").lastOpenChat?.default;

/** Signed in with three Active chats, one pane on the New chat pane. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks" }),
    row("vpn", 3, { pinned: true, title: "VPN tunnel" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
    vpn: [{ role: "user", text: "Is the tunnel up?" }],
  };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

/** Nightly backup in the left pane and NAS disks in the right, the right one active. */
async function sideBySide() {
  const s = await signedIn();
  await s.user.click(rowButton("Nightly backup"));
  await settle(s.hermes);
  await s.user.keyboard("{Control>}\\{/Control}");
  await s.user.click(rowButton("NAS disks"));
  await settle(s.hermes);
  expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "NAS disks"]);
  expect(activeIndex()).toBe(1);
  return s;
}

describe("Splitting", () => {
  it("opens the chat on screen in a second pane, which becomes the active one", async () => {
    const s = await signedIn();
    expect(panes()).toHaveLength(1);
    await s.user.click(rowButton("Nightly backup"));
    await s.user.keyboard("{Control>}\\{/Control}");
    expect(panes()).toHaveLength(2);
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "Nightly backup"]);
    expect(activeIndex()).toBe(1);
    expect(document.activeElement).toBe(composerIn(1));
    expect(screen.getByRole("separator", { name: "Resize the panes" })).toBeTruthy();
  });

  it("opens chats from the list in the active pane, and clicking into a pane makes it the active one", async () => {
    const s = await sideBySide();
    await s.user.click(pane(0).querySelector(".transcript")!);
    expect(activeIndex()).toBe(0);
    await s.user.click(rowButton("VPN tunnel"));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["VPN tunnel", "NAS disks"]);
    // The list marks the active pane's chat, and the other pane's apart from it.
    expect(rowButton("VPN tunnel").getAttribute("aria-current")).toBe("true");
    expect(rowButton("NAS disks").closest(".row")!.classList.contains("shown")).toBe(true);
    expect(lastOpen()).toBe("vpn");
  });

  it("opens a chat in either pane from its menu, and in a second pane when there is one", async () => {
    const s = await signedIn();
    fireEvent.contextMenu(rowButton("NAS disks"));
    await s.user.click(screen.getByRole("menuitem", { name: "Open in a second pane" }));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["New chat", "NAS disks"]);

    fireEvent.contextMenu(rowButton("VPN tunnel"));
    await s.user.click(screen.getByRole("menuitem", { name: "Open in left pane" }));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["VPN tunnel", "NAS disks"]);
    expect(activeIndex()).toBe(0);

    fireEvent.contextMenu(rowButton("Nightly backup"));
    await s.user.click(screen.getByRole("menuitem", { name: "Open in right pane" }));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["VPN tunnel", "Nightly backup"]);
    expect(activeIndex()).toBe(1);
  });

  it("closing a pane leaves the other as it was, find bar and all", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}f{/Control}");
    await s.user.type(within(pane(1)).getByPlaceholderText("Find in chat"), "disks");
    await s.user.click(within(pane(0)).getByRole("button", { name: "Close the left pane" }));
    expect(panes()).toHaveLength(1);
    expect(titleIn(0)).toBe("NAS disks");
    // Had the NAS disks pane been mounted afresh, its find bar would be closed.
    expect(screen.getByPlaceholderText<HTMLInputElement>("Find in chat").value).toBe("disks");
    // One pane shows no active marker.
    expect(activeIndex()).toBe(-1);
  });
});

describe("Each pane on its own", () => {
  it("keeps each chat's draft, and sends from each pane to its own chat", async () => {
    const s = await sideBySide();
    await s.user.type(composerIn(0), "left draft");
    await s.user.type(composerIn(1), "right draft");
    expect(composerIn(0).value).toBe("left draft");
    expect(composerIn(1).value).toBe("right draft");

    await s.user.click(composerIn(0));
    await s.user.keyboard("{Enter}");
    await s.user.click(composerIn(1));
    await s.user.keyboard("{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    expect(prompts(s.server).map((p) => [p.params.session_id, p.params.text])).toEqual([
      [s.server.runtimeIdOf("backup"), "left draft"],
      [s.server.runtimeIdOf("nas"), "right draft"],
    ]);
  });

  it("streams two replies at once, each in its own pane, and Stop stops only its own", async () => {
    const s = await sideBySide();
    await s.user.type(composerIn(0), "Check the repo{Enter}");
    await s.user.type(composerIn(1), "Check the disks{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    const left = s.server.runtimeIdOf("backup")!;
    const right = s.server.runtimeIdOf("nas")!;
    act(() => {
      s.server.event(left, "message.start");
      s.server.event(right, "message.start");
      for (let i = 0; i < 20; i++) {
        s.server.event(left, "message.delta", { text: `L${i} ` });
        s.server.event(right, "message.delta", { text: `R${i} ` });
      }
    });
    await settle(s.hermes);
    expect(pane(0).textContent).toContain("L19");
    expect(pane(0).textContent).not.toContain("R19");
    expect(pane(1).textContent).toContain("R19");
    expect(pane(1).textContent).not.toContain("L19");

    await s.user.click(within(pane(1)).getByRole("button", { name: "Stop" }));
    await settle(s.hermes);
    expect(interrupts(s.server).map((r) => r.params.session_id)).toEqual([right]);
    expect(within(pane(0)).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("gives way to the New chat pane only where a deleted chat was", async () => {
    const s = await sideBySide();
    // Delete the left pane's chat from its row while the right pane is active.
    await s.user.click(within(rowButton("Nightly backup").closest(".row") as HTMLElement).getByRole("button", { name: "Delete" }));
    await s.user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat" }));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["New chat", "NAS disks"]);
    expect(activeIndex()).toBe(1);
  });

  it("goes back to one pane when switching profile", async () => {
    const s = await sideBySide();
    s.server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
    await s.user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await s.user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(s.hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await settle(s.hermes);
    expect(panes()).toHaveLength(1);
    expect(titleIn(0)).toBe("New chat");
  });
});

describe("The same chat in both panes", () => {
  it("shares one draft and one reply, so a message can't go twice", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await s.user.keyboard("{Control>}\\{/Control}");
    await s.user.type(composerIn(1), "Unlock it");
    expect(composerIn(0).value).toBe("Unlock it");
    await s.user.keyboard("{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
    expect(composerIn(0).value).toBe("");
    // The reply runs in the chat, so neither pane can send until it ends.
    expect(within(pane(0)).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(within(pane(1)).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("answers an Approval once, whichever pane it is answered in", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await s.user.keyboard("{Control>}\\{/Control}");
    await s.user.type(composerIn(1), "Unlock it{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
    const runtime = s.server.runtimeIdOf("backup")!;
    act(() => s.server.event(runtime, "message.start"));
    let id: string | undefined;
    act(() => void ({ id } = s.server.askApproval(runtime)));
    await settle(s.hermes);
    expect(within(pane(1)).getByRole("button", { name: "Approve once" })).toBeTruthy();
    await s.user.click(within(pane(0)).getByRole("button", { name: "Approve once" }));
    await settle(s.hermes);
    expect(within(pane(1)).queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(s.server.approvalAnswers.map((a) => [a.id, a.choice])).toEqual([[id, "once"]]);
  });
});

describe("Shortcuts with two panes", () => {
  it("Ctrl+F opens find in the active pane only", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}f{/Control}");
    expect(within(pane(1)).getByPlaceholderText("Find in chat")).toBeTruthy();
    expect(within(pane(0)).queryByPlaceholderText("Find in chat")).toBeNull();
  });

  it("Ctrl+N starts a new chat in the active pane only", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}n{/Control}");
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "New chat"]);
  });

  it("Ctrl+1 and Ctrl+2 move to each pane's composer", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}1{/Control}");
    expect(activeIndex()).toBe(0);
    expect(document.activeElement).toBe(composerIn(0));
    await s.user.keyboard("{Control>}2{/Control}");
    expect(activeIndex()).toBe(1);
    expect(document.activeElement).toBe(composerIn(1));
  });

  it("Ctrl+\\ splits, and again closes the pane the owner isn't in", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
    expect(panes()).toHaveLength(2);
    await s.user.click(rowButton("NAS disks"));
    await s.user.keyboard("{Control>}1{/Control}");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
    expect(panes()).toHaveLength(1);
    expect(titleIn(0)).toBe("Nightly backup");
  });

  it("Search opens its pick in the active pane, at the match", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}1{/Control}");
    await s.user.keyboard("{Control>}k{/Control}");
    await s.user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "tunnel");
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await s.user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["VPN tunnel", "NAS disks"]);
    expect(within(pane(0)).getByPlaceholderText<HTMLInputElement>("Find in chat").value).toBe("tunnel");
  });
});

describe("Pane lifecycle regressions", () => {
  it("keeps navigation when a New chat started earlier finishes creating", async () => {
    const s = await signedIn();
    const create = s.server.handlers["session.create"];
    let answer!: () => void;
    s.server.handlers["session.create"] = (r) => { answer = () => create(r); };
    await s.user.type(composerIn(0), "Background start{Enter}");
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    await s.user.click(rowButton("NAS disks"));
    act(() => answer());
    await settle(s.hermes);
    expect(titleIn(0)).toBe("NAS disks");
  });

  it("puts keyboard focus in the surviving pane when the focused pane closes", async () => {
    const s = await sideBySide();
    await s.user.click(within(pane(1)).getByRole("button", { name: "Close the right pane" }));
    await waitFor(() => expect(document.activeElement).toBe(composerIn(0)));
  });

  it("preserves find state while Settings covers the panes and stops marking them read", async () => {
    const s = await sideBySide();
    await s.user.keyboard("{Control>}f{/Control}");
    await s.user.type(within(pane(1)).getByPlaceholderText("Find in chat"), "disks");
    await s.user.click(screen.getByRole("button", { name: "Settings" }));
    const hidden = document.querySelector(".panes.covered");
    expect(hidden).toBeTruthy();
    expect(hidden?.getAttribute("inert")).not.toBeNull();
    await s.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(document.querySelector(".panes.covered")).toBeNull();
    expect(document.activeElement).toBe(composerIn(1));
    expect(within(pane(1)).getByPlaceholderText<HTMLInputElement>("Find in chat").value).toBe("disks");
  });

  it("routes a native drop only to the visible narrow pane, despite overlapping pane bounds", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 324, y: 0, left: 324, right: 760, top: 0, bottom: 800, width: 436, height: 800, toJSON() {},
    }));
    const observe = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const s = await sideBySide();
      expect(pane(0).classList.contains("hidden")).toBe(true);
      s.server.files["/tmp/narrow.txt"] = "only the right pane";
      await act(async () => {
        for (const drop of drops) drop({ payload: { type: "drop", paths: ["/tmp/narrow.txt"], position: { x: 500, y: 300 } } });
      });
      expect(pane(0).textContent).not.toContain("narrow.txt");
      expect(pane(1).textContent).toContain("narrow.txt");
    } finally { globalThis.ResizeObserver = observe; }
  });
});

describe("The divider", () => {
  it("moves with the arrow keys and Home, double-click evens it, and it reports where it is", async () => {
    const s = await sideBySide();
    const divider = screen.getByRole("separator", { name: "Resize the panes" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    divider.focus();
    await s.user.keyboard("{ArrowRight}{ArrowRight}");
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
    await s.user.keyboard("{Home}");
    expect(divider.getAttribute("aria-valuenow")).toBe(divider.getAttribute("aria-valuemin"));
    fireEvent.doubleClick(divider);
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    expect(pane(0).style.flexGrow).toBe("0.5");
  });
});

describe("Compare", () => {
  const modelIn = (i: number) => within(pane(i)).getByRole("button", { name: /^Model:/ }).getAttribute("aria-label");
  /** Each prompt that reached Hermes, as the model its chat runs on and its text. */
  const promptsByModel = (s: { server: FakeHermes; hermes: Hermes }) =>
    prompts(s.server)
      .map((p) => [s.hermes.getSnapshot().chats.find((c) => c.runtimeId === p.params.session_id)?.model?.model, p.params.text])
      .sort();
  async function compareWith(s: { user: ReturnType<typeof userEvent.setup>; hermes: Hermes }, i: number, model: string) {
    await act(() => s.hermes.loadModels());
    await settle(s.hermes);
    await s.user.click(within(pane(i)).getByRole("button", { name: /^Model:/ }));
    await s.user.click(screen.getByRole("button", { name: "Compare with another model" }));
    await s.user.click(within(screen.getByRole("dialog", { name: "Pick a model to compare with" })).getByRole("button", { name: new RegExp(`^${model}`) }));
    await settle(s.hermes);
  }

  it("sends one message to two new chats on two models, one in each pane", async () => {
    const s = await signedIn();
    await compareWith(s, 0, "gpt-5");
    expect(panes()).toHaveLength(2);
    expect([modelIn(0), modelIn(1)]).toEqual(["Model: claude-sonnet-4-5", "Model: gpt-5"]);

    await s.user.type(composerIn(0), "Which disk is failing?{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    expect(s.server.requests.filter((r) => r.method === "session.create").map((r) => r.params.model).sort()).toEqual(["claude-sonnet-4-5", "gpt-5"]);
    expect(promptsByModel(s)).toEqual([
      ["claude-sonnet-4-5", "Which disk is failing?"],
      ["gpt-5", "Which disk is failing?"],
    ]);
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).not.toContain("New chat");
    expect(composerIn(0).value).toBe("");
  });

  it("refuses to send while either reply runs, then Stop comparing leaves two ordinary chats", async () => {
    const s = await signedIn();
    await compareWith(s, 0, "gpt-5");
    await s.user.type(composerIn(0), "First{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    const right = prompts(s.server)[1].params.session_id as string;
    const left = prompts(s.server)[0].params.session_id as string;
    act(() => {
      s.server.event(left, "message.complete", { text: "Disk 2.", status: "complete" });
      s.server.event(right, "message.start");
    });
    await settle(s.hermes);

    await s.user.type(composerIn(0), "Second{Enter}");
    expect(within(pane(0)).getByText(/both replies have ended/)).toBeTruthy();
    expect(prompts(s.server)).toHaveLength(2);
    expect(s.hermes.getSnapshot().queues).toEqual({});
    expect(composerIn(0).value).toBe("Second");

    await s.user.click(within(pane(0)).getByRole("button", { name: "Stop comparing" }));
    expect(within(pane(1)).queryByRole("button", { name: "Stop comparing" })).toBeNull();
    await s.user.click(composerIn(0));
    await s.user.keyboard("{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(3));
    expect(prompts(s.server)[2].params.session_id).not.toBe(right);
    expect(panes()).toHaveLength(2);
  });

  it("sends from a chat already under way to it and to a new chat beside it", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    await compareWith(s, 0, "gpt-5");
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "New chat"]);
    expect(activeIndex()).toBe(0);

    await s.user.type(composerIn(0), "Is the repo unlocked now?{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    const backup = s.server.runtimeIdOf("backup");
    expect(prompts(s.server).map((p) => p.params.text)).toEqual(["Is the repo unlocked now?", "Is the repo unlocked now?"]);
    expect(prompts(s.server).filter((p) => p.params.session_id === backup)).toHaveLength(1);
    expect(s.server.requests.filter((r) => r.method === "session.create").map((r) => r.params.model)).toEqual(["gpt-5"]);
    await settle(s.hermes);
    expect(titleIn(0)).toBe("Nightly backup");
    expect(titleIn(1)).not.toBe("New chat");
  });

  it("starts both chats with the shown project's folder and instructions, and sends the attached file to both", async () => {
    const server = new FakeHermes();
    server.projects.default = [{
      id: "p_lab", slug: "p_lab", name: "Home lab", primary_path: "/srv/lab", archived: false, created_at: 1,
      folders: [{ path: "/srv/lab", label: null, is_primary: true, added_at: 1 }],
    }];
    server.serverDirs = new Set(["/srv", "/srv/lab"]);
    server.files["/tmp/smart.txt"] = "sda reallocated 12";
    const conn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" } as const;
    await savedDefaults.save(projectScope(conn, "default"), "p_lab", 0, { instructions: "Answer for the home lab.", folder: "/srv/lab" });
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={conn} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await settle(hermes);
    await user.click(document.querySelector<HTMLElement>(".project-btn")!);
    await user.click(await screen.findByRole("option", { name: /Home lab/ }));
    await act(async () => {
      for (const drop of drops) drop({ payload: { type: "drop", paths: ["/tmp/smart.txt"], position: { x: 10, y: 10 } } });
    });
    await waitFor(() => expect(pane(0).textContent).toContain("smart.txt"));

    await compareWith({ user, hermes }, 0, "gpt-5");
    await user.type(composerIn(0), "Is this disk failing?{Enter}");
    await waitFor(() => expect(prompts(server)).toHaveLength(2));
    const creates = server.requests.filter((r) => r.method === "session.create").map((r) => r.params);
    expect(creates.map((c) => [c.model, c.cwd])).toEqual(expect.arrayContaining([["claude-sonnet-4-5", "/srv/lab"], ["gpt-5", "/srv/lab"]]));
    for (const c of creates) expect(JSON.stringify(c.messages)).toContain("Answer for the home lab.");
    const attached = server.requests.filter((r) => r.method === "file.attach");
    expect(new Set(attached.map((r) => r.params.session_id)).size).toBe(2);
    expect(prompts(server).map((p) => p.params.text)).toEqual([expect.stringContaining("smart.txt"), expect.stringContaining("smart.txt")]);
  });

  it("ends once the other pane goes to another chat, and a send then goes to one chat", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    await compareWith(s, 0, "gpt-5");
    expect(within(pane(1)).getByRole("button", { name: "Stop comparing" })).toBeTruthy();

    await s.user.click(pane(1).querySelector(".transcript")!);
    await s.user.click(rowButton("NAS disks"));
    await settle(s.hermes);
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "NAS disks"]);
    expect(screen.queryByRole("button", { name: "Stop comparing" })).toBeNull();

    await s.user.type(composerIn(0), "Only here{Enter}");
    await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
    await settle(s.hermes);
    expect(prompts(s.server).map((p) => p.params.session_id)).toEqual([s.server.runtimeIdOf("backup")]);
    expect(s.server.requests.filter((r) => r.method === "session.create")).toEqual([]);
  });

  it("refuses a second message while the other chat is still starting, so both chats get the same messages", async () => {
    const s = await signedIn();
    await s.user.click(rowButton("Nightly backup"));
    await settle(s.hermes);
    await compareWith(s, 0, "gpt-5");
    const create = s.server.handlers["session.create"];
    let answer: (() => void) | undefined;
    s.server.handlers["session.create"] = (r) => void (answer = () => create(r));
    const backup = s.server.runtimeIdOf("backup")!;

    await s.user.type(composerIn(0), "First{Enter}");
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    await waitFor(() => expect(prompts(s.server)).toHaveLength(1));
    act(() => s.server.event(backup, "message.complete", { text: "Disk 2.", status: "complete" }));
    await waitFor(() => expect(pane(0).textContent).toContain("Disk 2."));

    await s.user.type(composerIn(0), "Second{Enter}");
    expect(within(pane(0)).getByText(/both replies have ended/)).toBeTruthy();
    expect(composerIn(0).value).toBe("Second");

    act(() => answer!());
    await waitFor(() => expect(prompts(s.server)).toHaveLength(2));
    await settle(s.hermes);
    expect(s.server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    expect(prompts(s.server).map((p) => p.params.text)).toEqual(["First", "First"]);
  });

  it("says the message went only to the other chat when this one can't start, and keeps no screenshot the other chat took", async () => {
    const server = new FakeHermes();
    const conn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" } as const;
    const hermes = await connect(server.openPipe, undefined, localChatCache(conn));
    running.push(hermes);
    let retained = new Set<string>();
    const syncOutbox = async () => {
      const next = new Set(outboxAttachmentPaths());
      for (const path of retained) if (!next.has(path)) delete server.files[path];
      retained = next;
    };
    const stop = subscribeOutbox(() => queueMicrotask(() => void syncOutbox()));
    let land!: (c: Captured) => void;
    const capture = "/run/user/1000/hermes-chat/captures/4242/0/shot.png";
    const wiring: Screenshots = {
      api: {
        capture: () => new Promise((resolve) => (land = resolve)),
        discard: async (path) => void (retained.has(path) || delete server.files[path]),
      },
      syncOutbox,
      onDesktopShortcut: () => () => {},
      attached: vi.fn(),
      support: async () => ({ ok: true, summary: "Screenshots use slurp and grim." }),
    };
    try {
      const user = userEvent.setup();
      render(<Main hermes={hermes} connection={conn} onSignOut={async () => {}} screenshots={wiring} />);
      await waitFor(() => expect(hermes.hasListed()).toBe(true));
      await compareWith({ user, hermes }, 0, "gpt-5");
      composerIn(0).focus();
      await user.click(within(pane(0)).getByRole("button", { name: "Attach a screenshot" }));
      server.files[capture] = "\x89PNG\r\n\x1a\nscreen";
      await act(async () => land({ path: capture }));
      await waitFor(() => expect(pane(0).querySelectorAll(".chip")).toHaveLength(1));
      const create = server.handlers["session.create"];
      server.handlers["session.create"] = (r) => (r.params.model === "claude-sonnet-4-5" ? server.fail(r.id, -32000, "claude-sonnet-4-5 is down") : create(r));

      await user.type(composerIn(0), "Look at this{Enter}");
      await waitFor(() => expect(prompts(server)).toHaveLength(1));
      await waitFor(() => expect(pane(0).textContent).toContain("Couldn't start a chat"));
      await settle(hermes);
      expect(server.requests.filter((r) => r.method === "image.attach_bytes").map((r) => r.params.session_id)).toEqual([prompts(server)[0].params.session_id]);
      expect(composerIn(0).value).toBe("Look at this");
      expect(screen.getByText(/went only to the other chat, with its files/)).toBeTruthy();
      expect(pane(0).querySelectorAll(".chip")).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

describe("A chat that leaves the list under a pane (#467)", () => {
  it("the pane goes to New chat with what was typed, and sending it starts a chat", async () => {
    const { server, hermes, user } = await signedIn();
    // The drafts store outlives each test's localStorage, so earlier tests' drafts here are cleared first.
    await user.clear(composerIn(0));
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    await user.clear(composerIn(0));
    await user.type(composerIn(0), "Unlock the restic repo");

    // Deleted in another client while the connection was down: the list read on reconnecting no longer has it.
    server.sessions = server.sessions.filter((s) => s.id !== "backup");
    server.drop();
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
    await settle(hermes);
    await waitFor(() => expect(titleIn(0)).toBe("New chat"));
    expect(composerIn(0).value).toBe("Unlock the restic repo");
    expect(pane(0).textContent).toContain("no longer on Hermes");

    await user.type(composerIn(0), "{Enter}");
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    expect(prompts(server)[0].params.text).toBe("Unlock the restic repo");
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    await waitFor(() => expect(titleIn(0)).not.toBe("New chat"));
  });

  it("a message sent as its chat leaves the list comes back into the composer, with why", async () => {
    const { server, hermes, user } = await signedIn();
    // The drafts store outlives each test's localStorage, so earlier tests' drafts here are cleared first.
    await user.clear(composerIn(0));
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    await user.clear(composerIn(0));
    // The list read that drops the chat lands between the owner pressing Enter and the message going in.
    const sendTracked = hermes.sendTracked.bind(hermes);
    vi.spyOn(hermes, "sendTracked").mockImplementation(async (...args) => {
      server.sessions = server.sessions.filter((s) => s.id !== "backup");
      server.drop();
      await vi.waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
      await hermes.idle();
      return sendTracked(...args);
    });

    await user.type(composerIn(0), "Unlock the restic repo{Enter}");
    // The send waits out the reconnect first.
    await waitFor(() => expect(vi.mocked(hermes.sendTracked).mock.settledResults[0]?.type).toBe("fulfilled"), { timeout: 10_000 });
    await settle(hermes);
    await waitFor(() => expect(titleIn(0)).toBe("New chat"));
    expect(composerIn(0).value).toBe("Unlock the restic repo");
    expect(prompts(server)).toHaveLength(0);
    expect(pane(0).textContent).toContain("no longer on Hermes");
  });

  it("a message sent as Hermes is found to have deleted its chat lands in New chat, even when the next check fails", async () => {
    const { server, hermes, user } = await signedIn();
    await user.clear(composerIn(0));
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    await user.clear(composerIn(0));
    // While the message is on its way, the list read drops the chat, Hermes answers that it has no such chat, and the
    // pane gives way. A later look-up of the chat fails.
    const sendTracked = hermes.sendTracked.bind(hermes);
    vi.spyOn(hermes, "sendTracked").mockImplementation(async (...args) => {
      server.sessions = server.sessions.filter((s) => s.id !== "backup");
      server.drop();
      await vi.waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
      await hermes.idle();
      await vi.waitFor(() => expect(titleIn(0)).toBe("New chat"), { timeout: 5_000 });
      server.rest["GET /api/sessions/backup"] = () => Promise.reject(new RestError(500, "busy"));
      return sendTracked(...args);
    });

    await user.type(composerIn(0), "Unlock the restic repo{Enter}");
    // The send waits out the reconnect first.
    await waitFor(() => expect(vi.mocked(hermes.sendTracked).mock.settledResults[0]?.type).toBe("fulfilled"), { timeout: 10_000 });
    await settle(hermes);
    await waitFor(() => expect(composerIn(0).value).toBe("Unlock the restic repo"));
    expect(titleIn(0)).toBe("New chat");
    expect(prompts(server)).toHaveLength(0);
  });

  it("a chat in a tab, older than the list reaches, keeps its tab and Draft when a list read leaves it out", async () => {
    const { server, hermes, user } = await signedIn();
    await user.clear(composerIn(0));
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    await user.clear(composerIn(0));
    await user.type(composerIn(0), "Unlock the restic repo");
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    const tabs = () => Array.from(pane(0).querySelectorAll(".tab-open")).map((t) => t.textContent);
    expect(tabs()).toEqual(["Nightly backup", "New chat"]);

    // Quiet for six weeks and no longer pinned: the list read on reconnecting leaves it out, but Hermes still has it.
    server.sessions = server.sessions.map((s) => (s.id === "backup" ? row("backup", 42, { title: "Nightly backup" }) : s));
    server.drop();
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
    await settle(hermes);
    await waitFor(() => expect(server.restRequests.some((r) => r.path === "/api/sessions/backup")).toBe(true));
    await settle(hermes);
    expect(tabs()).toEqual(["Nightly backup", "New chat"]);
    expect(composerIn(0).value).toBe("");

    await user.click(within(pane(0)).getByText("Nightly backup", { selector: ".tab-open *, .tab-open" }));
    await settle(hermes);
    expect(titleIn(0)).toBe("Nightly backup");
    expect(composerIn(0).value).toBe("Unlock the restic repo");
  });
});
