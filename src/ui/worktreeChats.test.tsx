// @vitest-environment jsdom
// Chats started in a worktree (ADR 0043), in the app: from the Repository screen's Worktrees view to the New chat pane,
// against a fake Hermes (session.create, /api/fs/list) and a fake of the Repository helper's Rust command.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { RepoFailure, REPO_PATH_KEY, type RepoApi, type RepoRequest, type Status } from "../hermes/repo";
import { WORKTREE_CHATS_KEY, type Worktree, type WorktreeList } from "../hermes/worktrees";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
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
});

const MAIN = "/srv/app";
const WT = "/srv/app-feature";
const ID = "0123456789abcdef";

const status = (top: string): Status => ({
  top,
  gitDir: `${top}/.git`,
  head: "a".repeat(40),
  index: "i",
  branch: { oid: "a".repeat(40), head: "main", detached: false, upstream: null, ahead: null, behind: null },
  operation: null,
  entries: [],
  truncated: false,
});

const managed = (): Worktree => ({
  path: WT,
  head: "b".repeat(40),
  branch: "feature/login",
  detached: false,
  bare: false,
  locked: `hermes-chat: managed worktree ${ID}`,
  prunable: null,
  main: false,
  exists: true,
  managed: {
    id: ID,
    path: WT,
    branch: "feature/login",
    newBranch: true,
    base: "main",
    baseOid: "a".repeat(40),
    source: MAIN,
    createdAt: 1,
    protected: false,
    state: "ready",
    running: false,
    setup: { state: "skipped", entries: [], log: "" },
    chats: [],
  },
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  unpublished: 0,
  lost: 0,
  upstream: null,
  ahead: null,
  behind: null,
  submodules: 0,
  protected: [],
});

const list = (): WorktreeList => ({
  top: MAIN,
  main: MAIN,
  commonDir: `${MAIN}/.git`,
  worktrees: [{ ...managed(), path: MAIN, branch: "main", main: true, managed: null, locked: null, protected: [{ kind: "main", message: "main" }] }, managed()],
  missing: [],
  kept: [],
  detailLimit: 40,
  git: "2.47",
});

function repoApi(refuse?: Partial<Record<RepoRequest["op"], RepoFailure>>, hold?: Partial<Record<RepoRequest["op"], Promise<void>>>) {
  const calls: RepoRequest[] = [];
  const targets: string[] = [];
  const api: RepoApi = {
    run: async (target, request) => {
      calls.push(request);
      targets.push(target);
      await hold?.[request.op];
      const no = refuse?.[request.op];
      if (no) throw no;
      switch (request.op) {
        case "status":
          return status(request.repo);
        case "publishInfo":
          throw new RepoFailure("git", "no remote");
        case "worktreeList":
          return list();
        case "worktreeAttach":
        case "worktreeAttachConfirm":
        case "worktreeDetach":
          return managed().managed;
        default:
          throw new Error(`unexpected ${request.op}`);
      }
    },
  };
  return { api, calls, targets };
}

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.serverDirs = new Set(["/srv", MAIN, WT]);
  return s;
}

async function launch(s: FakeHermes, api: RepoApi) {
  localStorage.setItem(REPO_PATH_KEY, MAIN);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} repoApi={api} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const creates = (s: FakeHermes) => s.requests.filter((r) => r.method === "session.create").map((r) => r.params);
const onScreen = () => document.querySelector(".chat-title span")?.textContent;
const send = async (user: ReturnType<typeof userEvent.setup>, text: string) => user.type(screen.getByPlaceholderText("Message Hermes"), `${text}{Enter}`);

async function startHere(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Repository" }));
  await user.click(await screen.findByRole("tab", { name: "Worktrees" }));
  const row = (await screen.findByText(WT, { selector: ".wt-path" })).closest(".wt-row") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: /Start a chat here/ }));
}

describe("a chat started in a worktree", () => {
  it("runs in the worktree's folder, holds its place on the server first, and shows its branch", async () => {
    const s = server();
    const { api, calls } = repoApi();
    const { user, hermes } = await launch(s, api);
    await startHere(user);

    const panel = screen.getByRole("region", { name: "What this chat starts with" });
    expect(panel.textContent).toContain(`${WT} on ssh://liam@hermes chosen for this chat`);
    expect(panel.textContent).toContain("feature/login, a worktree made in the Repository screen");

    await send(user, "Fix the login page");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    expect(creates(s)[0]).toMatchObject({ cwd: WT, cwd_explicit: true });
    // The folder was checked first, then the place held before Hermes started it, then confirmed with its id.
    const order = calls.filter((c) => c.op.startsWith("worktreeAttach")).map((c) => c.op);
    expect(order).toEqual(["worktreeAttach", "worktreeAttachConfirm"]);
    const attach = calls.find((c) => c.op === "worktreeAttach") as Extract<RepoRequest, { op: "worktreeAttach" }>;
    expect(attach).toMatchObject({ repo: MAIN, id: ID, profile: "default" });
    const confirm = calls.find((c) => c.op === "worktreeAttachConfirm") as Extract<RepoRequest, { op: "worktreeAttachConfirm" }>;
    const chatId = hermes.getSnapshot().chats.find((c) => c.title !== "Nightly backup")!.id;
    expect(confirm).toMatchObject({ id: ID, token: attach.token, chat: chatId });

    // The chat's header says which worktree it works in, and opens it.
    const chip = await screen.findByRole("button", { name: /Works in the worktree \/srv\/app-feature, on the branch feature\/login/ });
    expect(JSON.parse(localStorage.getItem(WORKTREE_CHATS_KEY)!).scopes).toBeTruthy();
    await user.click(chip);
    expect((await screen.findByRole("tab", { name: "Worktrees" })).getAttribute("aria-selected")).toBe("true");
  });

  it("leaves the next chat on the profile's folder, and the worktree's chat on its own", async () => {
    const s = server();
    const { api } = repoApi();
    const { user, hermes } = await launch(s, api);
    await startHere(user);
    await send(user, "In the worktree");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    await user.click(screen.getAllByRole("button", { name: /New chat/ })[0]);
    expect(screen.queryByRole("region", { name: "What this chat starts with" })).toBeNull();
    await send(user, "Anywhere");
    await waitFor(() => expect(creates(s)).toHaveLength(2));
    expect(creates(s)[0]).toMatchObject({ cwd: WT, cwd_explicit: true });
    expect(creates(s)[1].cwd).toBeUndefined();
  });

  it("doesn't start, and keeps the message, when the server won't hold the worktree for it", async () => {
    const s = server();
    const { api } = repoApi({ worktreeAttach: new RepoFailure("not-ready", "A chat can't start there now: the worktree is setup interrupted.") });
    const { user } = await launch(s, api);
    await startHere(user);
    await send(user, "Fix it");
    expect((await screen.findByText(/Couldn't start a chat: A chat can't start there now/)).textContent).toBeTruthy();
    expect(creates(s)).toEqual([]);
    expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("Fix it");
  });

  it("starts once and sends when this computer's storage is full, and says the worktree wasn't noted here", async () => {
    const s = server();
    const { api, calls } = repoApi();
    const { user, hermes } = await launch(s, api);
    await startHere(user);
    // The app's drafts stay in memory from the tests before this one.
    await user.clear(screen.getByPlaceholderText("Message Hermes"));
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    try {
      await send(user, "Fix the login page");
      await waitFor(() => expect(calls.map((c) => c.op)).toContain("worktreeAttachConfirm"));
      await act(async () => void (await hermes.idle()));
      expect(screen.queryByText(/Couldn't start a chat/)).toBeNull();
      expect(creates(s)).toHaveLength(1);
      await waitFor(() => expect(onScreen()).not.toBe("New chat"));
      expect(await screen.findByText(/couldn't note that it works in \/srv\/app-feature/)).toBeTruthy();
      await waitFor(() => expect(s.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Fix the login page"]));
      expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("");
    } finally {
      full.mockRestore();
    }
  });

  it("can be started elsewhere instead, from the New chat pane", async () => {
    const s = server();
    const { api, calls } = repoApi();
    const { user } = await launch(s, api);
    await startHere(user);
    await user.click(screen.getByRole("button", { name: "Don't start it there" }));
    expect(screen.queryByRole("region", { name: "What this chat starts with" })).toBeNull();
    await send(user, "Plain chat");
    await waitFor(() => expect(creates(s)).toHaveLength(1));
    expect(creates(s)[0].cwd).toBeUndefined();
    expect(calls.some((c) => c.op === "worktreeAttach")).toBe(false);
  });

  it("never starts the chat in another profile when the owner switches while the worktree is held, and keeps the message", async () => {
    const s = server();
    s.otherProfiles = { work: [] };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api, calls } = repoApi(undefined, { worktreeAttach: held });
    const { user, hermes } = await launch(s, api);
    await startHere(user);
    await send(user, "Fix the login page");
    await waitFor(() => expect(calls.some((c) => c.op === "worktreeAttach")).toBe(true));
    await act(async () => void (await hermes.switchProfile("work")));
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    // Nothing started anywhere, the place was let go, and the message is kept for the profile it was written in.
    expect(creates(s)).toEqual([]);
    await waitFor(() => expect(calls.map((c) => c.op)).toContain("worktreeDetach"));
    expect(Object.values(localStorage).some((v) => typeof v === "string" && v.includes("Fix the login page"))).toBe(true);
  });

  it("doesn't send into a chat whose profile was left while its start was confirmed, and keeps the message", async () => {
    const s = server();
    s.otherProfiles = { work: [] };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api, calls } = repoApi(undefined, { worktreeAttachConfirm: held });
    const { user, hermes } = await launch(s, api);
    await startHere(user);
    await send(user, "Fix the login page");
    await waitFor(() => expect(calls.some((c) => c.op === "worktreeAttachConfirm")).toBe(true));
    expect(creates(s)).toHaveLength(1);
    expect(creates(s)[0]).toMatchObject({ profile: "default", cwd: WT });
    await act(async () => void (await hermes.switchProfile("work")));
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    expect(s.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    expect(Object.values(localStorage).some((v) => typeof v === "string" && v.includes("Fix the login page"))).toBe(true);
  });
});

describe("with this computer's storage full", () => {
  it("still reads the repository at a newly typed SSH target", async () => {
    const s = server();
    const { api, targets } = repoApi();
    const { user } = await launch(s, api);
    await user.click(screen.getByRole("button", { name: "Repository" }));
    await waitFor(() => expect(targets).toContain("liam@hermes"));
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    try {
      await user.click(screen.getByRole("button", { name: "Change the SSH target" }));
      const field = screen.getByLabelText("SSH target");
      await user.clear(field);
      await user.type(field, "root@other");
      await user.click(screen.getByRole("button", { name: "Use this target" }));
      await waitFor(() => expect(targets).toContain("root@other"));
    } finally {
      full.mockRestore();
    }
  });
});
