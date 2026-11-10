// @vitest-environment jsdom
// The Repository screen (ADR 0110) against a fake of Rust's `repo_git` command. Its answers have the shapes
// repo_git_helper.py gives for real repositories (src-tauri/tests/repo_git.rs).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoFailure, type DiffReply, type RepoApi, type RepoRequest, type Status } from "../hermes/repo";
import { RepositoryScreen } from "./Repository";

afterEach(cleanup);

const TOP = "/home/liam/app";

function statusOf(over: Partial<Status> = {}): Status {
  return {
    top: TOP,
    gitDir: `${TOP}/.git`,
    head: "1e6a7627084ab1d090745282b589f5d3de623b23",
    index: "i1",
    branch: { oid: "1e6a7627084ab1d090745282b589f5d3de623b23", head: "feature/login", detached: false, upstream: "origin/feature/login", ahead: 2, behind: 0 },
    operation: null,
    entries: [
      { kind: "ordinary", x: "M", y: "M", sub: false, path: "src/auth.ts", staged: [1, 1], unstaged: [3, 0] },
      { kind: "renamed", x: "R", y: ".", sub: false, path: "docs/login.md", origPath: "docs/auth.md", staged: [0, 0] },
      { kind: "ordinary", x: ".", y: "M", sub: false, path: "assets/logo.png", unstaged: null },
      { kind: "untracked", x: "?", y: "?", sub: false, path: "notes.txt", binary: false },
    ],
    truncated: false,
    ...over,
  };
}

const diffOf = (diff: string, over: Partial<DiffReply> = {}): DiffReply => ({ diff, truncated: false, lossy: false, bytes: diff.length, sha: "x", stages: [], ...over });

/** How many requests of `op` were made. */
const count = (calls: { request: RepoRequest }[], op: RepoRequest["op"]) => calls.filter((c) => c.request.op === op).length;

/** Answers each request with `answer`, and records them. */
function fakeApi(answer: (target: string, r: RepoRequest) => unknown | Promise<unknown>) {
  const calls: { target: string; request: RepoRequest }[] = [];
  const api: RepoApi = {
    run: async (target, request) => {
      calls.push({ target, request });
      return answer(target, request);
    },
  };
  return { api, calls };
}

const DIFFS: Record<string, string> = {
  "staged:src/auth.ts": "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n import x\n-const a = 1\n+const a = 2\n end\n",
  "unstaged:src/auth.ts": "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,2 +10,5 @@\n x\n+one\n+two\n+three\n y\n",
  "staged:docs/login.md": "diff --git a/docs/auth.md b/docs/login.md\nsimilarity index 100%\nrename from docs/auth.md\nrename to docs/login.md\n",
  "unstaged:assets/logo.png": "diff --git a/assets/logo.png b/assets/logo.png\nindex 1..2 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n",
  "untracked:notes.txt": "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+remember\n",
};

/** Where a push would go, for a repository with no remote. */
const NO_REMOTE = { head: null, branch: "feature/login", remotes: [], upstream: null, remote: null, remoteUrl: "", remoteBranch: "feature/login", remoteHead: null, ahead: null, behind: null, commits: [], bases: [], github: null };

function standard(s: () => Status = () => statusOf()) {
  return fakeApi((_t, r) => {
    if (r.op === "status") return s();
    if (r.op === "publishInfo") return NO_REMOTE;
    if (r.op === "diff") return diffOf(DIFFS[`${r.side}:${r.path}`] ?? "");
    throw new Error(`unexpected ${r.op}`);
  });
}

function show(api: RepoApi, props: Partial<Parameters<typeof RepositoryScreen>[0]> = {}) {
  const onOpened = vi.fn();
  const onTarget = vi.fn();
  // StrictMode, as the app runs: effects mount, unmount and mount again.
  render(
    <StrictMode>
      <RepositoryScreen api={api} initialTarget="liam@hermes" initialPath={TOP} recent={[]} suggestions={[]} onOpened={onOpened} onTarget={onTarget} onClose={() => {}} {...props} />
    </StrictMode>,
  );
  return { onOpened, onTarget };
}

describe("Repository screen", () => {
  it("opens the folder used last, through the SSH target, and shows its branch and changes", async () => {
    const { api, calls } = standard();
    const { onOpened } = show(api);
    expect(await screen.findByText(TOP)).toBeTruthy();
    expect(calls[0]).toEqual({ target: "liam@hermes", request: { op: "status", repo: TOP } });
    expect(screen.getByText("feature/login")).toBeTruthy();
    expect(screen.getByText("2 ahead of origin/feature/login, as of the last fetch.")).toBeTruthy();
    expect(onOpened).toHaveBeenCalledWith(TOP);

    const staged = within(screen.getByRole("region", { name: "Staged" }));
    expect(staged.getByRole("button", { name: /auth\.ts/ })).toBeTruthy();
    expect(staged.getByText("from docs/auth.md")).toBeTruthy();
    const unstaged = within(screen.getByRole("region", { name: "Changed, not staged" }));
    expect(unstaged.getByRole("button", { name: /logo\.png/ }).textContent).toContain("binary");
    expect(within(screen.getByRole("region", { name: "Untracked" })).getByRole("button", { name: /notes\.txt/ })).toBeTruthy();
  });

  it("shows the staged and unstaged diffs of one file separately", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /auth\.ts/ }));
    const diff = await screen.findByRole("region", { name: "Diff of src/auth.ts" });
    await waitFor(() => expect(within(diff).getByText("const a = 2")).toBeTruthy());
    expect(within(diff).queryByText("three")).toBeNull();
    expect(calls.at(-1)?.request).toEqual({ op: "diff", repo: TOP, path: "src/auth.ts", side: "staged", context: 3 });

    await user.click(within(screen.getByRole("region", { name: "Changed, not staged" })).getByRole("button", { name: /auth\.ts/ }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Diff of src/auth.ts" })).getByText("three")).toBeTruthy());
    expect(screen.queryByText("const a = 2")).toBeNull();
  });

  it("asks for the context chosen", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /auth\.ts/ }));
    await screen.findByText("const a = 2");
    await user.selectOptions(screen.getByLabelText("Context"), "Whole file");
    await waitFor(() => expect(calls.at(-1)?.request).toMatchObject({ op: "diff", context: 1_000_000 }));
  });

  it("says when a file is binary, renamed, or in conflict", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /logo\.png/ }));
    expect(await screen.findByText("Binary file: Git shows no lines for it.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /login\.md/ }));
    expect(await screen.findByText("Renamed from docs/auth.md (100% similar).")).toBeTruthy();
    expect(calls.at(-1)?.request).toMatchObject({ path: "docs/login.md", origPath: "docs/auth.md", side: "staged" });
  });

  it("shows a merge in progress and a conflict's versions", async () => {
    const user = userEvent.setup();
    const conflict = statusOf({ operation: "merge", entries: [{ kind: "unmerged", x: "U", y: "U", sub: false, path: "notes.txt" }] });
    const { api } = fakeApi((_t, r) =>
      r.op === "status" ? conflict : diffOf("diff --cc notes.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +MAIN\n++=======\n+ OTHER\n++>>>>>>> other\n", { stages: [1, 2, 3] }),
    );
    show(api);
    expect(await screen.findByText(/A merge is in progress/)).toBeTruthy();
    await user.click(within(screen.getByRole("region", { name: "Conflicts" })).getByRole("button", { name: /notes\.txt/ }));
    expect(await screen.findByText(/Changed on both sides\. Git holds the common base, ours and theirs/)).toBeTruthy();
    expect(screen.getByText("<<<<<<< HEAD").closest(".files-diff-line")?.className).toContain("marker");
  });

  it("tells ssh failures apart, with what to do and what ssh said", async () => {
    const { api } = fakeApi(() => {
      throw new RepoFailure("ssh-host-key", "ssh doesn't know this server's host key yet.", "Host key verification failed.");
    });
    show(api);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ssh doesn't know this server's host key yet.");
    expect(alert.textContent).toContain("Open the Terminal");
    expect(alert.textContent).toContain("Host key verification failed.");
  });

  it("says when the folder isn't a repository", async () => {
    const { api } = fakeApi(() => {
      throw new RepoFailure("not-repo", "/home/liam isn't in a Git repository.");
    });
    show(api, { initialPath: "/home/liam" });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read /home/liam: /home/liam isn't in a Git repository.");
  });

  it("asks for an SSH target when there is none, and keeps the one given", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    const { onTarget } = show(api, { initialTarget: "" });
    expect(screen.getByText("Enter the SSH target of the Hermes server first.")).toBeTruthy();
    expect(calls).toEqual([]);
    await user.type(screen.getByLabelText("SSH target"), "liam@box");
    await user.click(screen.getByRole("button", { name: "Use this target" }));
    expect(onTarget).toHaveBeenCalledWith("liam@box");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText(TOP);
    expect(calls[0]).toEqual({ target: "liam@box", request: { op: "status", repo: TOP } });
  });

  it("offers the project's folders and recent ones when nothing is open", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api, { initialPath: "", recent: ["/srv/old"], suggestions: [{ label: "Website", path: "/home/liam/site" }] });
    await user.click(screen.getByRole("button", { name: /Website \/home\/liam\/site/ }));
    await waitFor(() => expect(calls[0].request).toEqual({ op: "status", repo: "/home/liam/site" }));
    expect(screen.queryByRole("button", { name: /Recent \/srv\/old/ })).toBeNull();
  });

  it("ignores an answer for a folder that's no longer the one shown", async () => {
    const user = userEvent.setup();
    let release: (v: Status) => void = () => {};
    const { api } = fakeApi((_t, r) => {
      if (r.op !== "status") return diffOf("");
      if (r.repo === "/slow") return new Promise<Status>((res) => (release = res));
      return statusOf({ top: "/fast" });
    });
    show(api, { initialPath: "/slow" });
    const input = screen.getByLabelText(/Folder on the server/);
    await user.clear(input);
    await user.type(input, "/fast");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("/fast")).toBeTruthy();
    await act(async () => release(statusOf({ top: "/slow" })));
    expect(screen.queryByText("/slow")).toBeNull();
    expect(screen.getByText("/fast")).toBeTruthy();
  });

  it("drops a selected file that a refresh no longer lists", async () => {
    const user = userEvent.setup();
    let current = statusOf();
    const { api } = standard(() => current);
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    await screen.findByRole("region", { name: "Diff of notes.txt" });
    current = statusOf({ entries: [] });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No changes: the working tree matches HEAD.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Diff of notes.txt" })).toBeNull();
  });
});

// ── stage 2: staging and committing ─────────────────────────────────────────

const STAMPED = (): Status =>
  statusOf({
    entries: [
      { kind: "ordinary", x: "M", y: "M", sub: false, path: "src/auth.ts", staged: [1, 1], unstaged: [3, 0], worktree: "w-auth" },
      { kind: "renamed", x: "R", y: ".", sub: false, path: "docs/login.md", origPath: "docs/auth.md", staged: [0, 0] },
      { kind: "untracked", x: "?", y: "?", sub: false, path: "notes.txt", binary: false, worktree: "w-notes" },
    ],
  });

const TWO_HUNKS =
  "diff --git a/src/auth.ts b/src/auth.ts\nindex 1..2 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -9,2 +9,2 @@\n y\n-z\n+Z\n";

const PREVIEW = {
  head: "1e6a7627084ab1d090745282b589f5d3de623b23",
  index: "i1",
  branch: "feature/login",
  headRef: "refs/heads/feature/login",
  files: [
    { status: "D", path: "docs/auth.md", oldMode: "100644", newMode: "000000" },
    { status: "A", path: "docs/login.md", oldMode: "000000", newMode: "100644" },
    { status: "M", path: "src/auth.ts", oldMode: "100644", newMode: "100644" },
  ],
  renames: { "docs/login.md": { from: "docs/auth.md", score: "R100" } },
  rawSha: "raw1",
  diff: " src/auth.ts | 2 +-\n\ndiff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n",
  truncated: false,
  lossy: false,
  unmerged: false,
  operation: null,
  author: "Demo Owner <demo@example.com>",
  committer: "Demo Owner <demo@example.com>",
  hooksPath: `${TOP}/.git/hooks`,
  hooks: ["pre-commit"],
  recent: ["Add sign-in sessions"],
};

/** A fake whose writes answer with `onWrite`, and whose diffs are the stamped ones. */
function writable(onWrite: (r: RepoRequest) => unknown, diffs: Record<string, Partial<DiffReply> & { diff: string }> = {}) {
  return fakeApi((_t, r) => {
    if (r.op === "status") return STAMPED();
    if (r.op === "diff") {
      const d = diffs[`${r.side}:${r.path}`] ?? { diff: DIFFS[`${r.side}:${r.path}`] ?? "" };
      return diffOf(d.diff, { head: PREVIEW.head, index: "i1", worktree: r.side === "staged" ? null : `w-${r.path.includes("notes") ? "notes" : "auth"}`, ...d });
    }
    if (r.op === "preview") return PREVIEW;
    if (r.op === "publishInfo") return NO_REMOTE;
    return onWrite(r);
  });
}

describe("Repository screen, staging", () => {
  it("stages only the ticked files, each with the stamp the list read, then reads the list again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }));
    show(api);
    await screen.findByText(TOP);
    const untracked = within(screen.getByRole("region", { name: "Untracked" }));
    expect((untracked.getByRole("button", { name: /Stage ticked/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }));
    const reads = count(calls, "status");
    await user.click(untracked.getByRole("button", { name: /Stage 1 ticked/ }));
    expect(await screen.findByText("Staged notes.txt.")).toBeTruthy();
    const w = calls.find((c) => c.request.op === "stage");
    expect(w?.request).toEqual({ op: "stage", repo: TOP, files: [{ path: "notes.txt", worktree: "w-notes" }], expect: { head: PREVIEW.head, index: "i1" } });
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });

  it("unstages a rename with its old path, so both go back", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }));
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("checkbox", { name: "Tick docs/login.md to unstage it" }));
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /Unstage 1 ticked/ }));
    await screen.findByText("Unstaged docs/login.md.");
    expect(calls.find((c) => c.request.op === "unstage")?.request).toMatchObject({ paths: ["docs/login.md", "docs/auth.md"] });
  });

  it("stages one hunk by its position in the diff shown, against that diff's stamps", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }), { "unstaged:src/auth.ts": { diff: TWO_HUNKS, sha: "d-sha", index: "i1" } });
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Changed, not staged" })).getByRole("button", { name: /auth\.ts/ }));
    await user.click(await screen.findByRole("button", { name: "Stage hunk 2 of 2" }));
    await screen.findByText("Staged a hunk of src/auth.ts.");
    const apply = calls.find((c) => c.request.op === "apply")?.request;
    expect(apply).toEqual({
      op: "apply",
      repo: TOP,
      path: "src/auth.ts",
      hunks: [1],
      reverse: false,
      context: 3,
      diffSha: "d-sha",
      expect: { head: PREVIEW.head, index: "i1" },
    });
  });

  it("offers whole files only for a rename or an untracked file", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => ({}));
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    await screen.findByText("remember");
    expect(screen.getByRole("button", { name: /Stage file/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stage hunk/ })).toBeNull();
  });

  it("won't stage from a diff newer than the list", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({}), { "untracked:notes.txt": { diff: DIFFS["untracked:notes.txt"], worktree: "w-newer" } });
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    expect(await screen.findByText(/This file changed after the list was read/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Stage file/ }) as HTMLButtonElement).disabled).toBe(true);
    const reads = count(calls, "status");
    await user.click(within(screen.getByRole("region", { name: "Diff of notes.txt" })).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });

  it("says why a write was refused, and reads the list again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => {
      throw new RepoFailure("stale", "notes.txt changed on the server since this screen read it. Nothing was staged.");
    });
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }));
    const reads = count(calls, "status");
    await user.click(screen.getByRole("button", { name: /Stage 1 ticked/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Staging notes.txt didn't happen: notes.txt changed on the server");
    expect(alert.textContent).toContain("Another agent or tool may be working in this checkout");
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });
});

describe("Repository screen, committing", () => {
  async function review(api: RepoApi, user: ReturnType<typeof userEvent.setup>, message = "Lengthen sessions") {
    show(api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), message);
    await user.click(screen.getByRole("button", { name: "Review commit…" }));
    return screen.findByRole("dialog");
  }

  it("previews exactly what the commit holds, then commits it with the preview's stamps", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({
      head: "abcdef1234567890",
      subject: "Lengthen sessions",
      output: "pre-commit: 3 files checked\n[feature/login abcdef1] Lengthen sessions",
      matches: true,
      files: PREVIEW.files,
      branch: "feature/login",
    }));
    const dialog = within(await review(api, user));
    await dialog.findByText("pre-commit will run, as Git runs them. Nothing skips them.");
    expect(dialog.getByText("Demo Owner <demo@example.com>")).toBeTruthy();
    expect(dialog.getByText("docs/auth.md → docs/login.md")).toBeTruthy();
    expect(dialog.getByText("const a = 2")).toBeTruthy();
    expect(dialog.getByText("Lengthen sessions", { selector: "pre" })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/pre-commit: 3 files checked/)).toBeTruthy();
    expect(dialog.getByText("Lengthen sessions", { selector: "pre" })).toBeTruthy();
    expect(calls.find((c) => c.request.op === "commit")?.request).toEqual({
      op: "commit",
      repo: TOP,
      message: "Lengthen sessions\n",
      expect: { head: PREVIEW.head, index: "i1", rawSha: "raw1", headRef: "refs/heads/feature/login" },
    });
    expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Committed abcdef1 on feature/login: Lengthen sessions")).toBeTruthy();
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a hook's refusal with its output, and keeps everything for another try", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => {
      throw new RepoFailure("hook", "A hook refused the commit (pre-commit). Its output is below. Nothing was committed.", "lint: src/auth.ts:3 shouting\n");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/The commit was refused: A hook refused the commit/)).toBeTruthy();
    expect(dialog.getAllByText(/lint: src\/auth.ts:3 shouting/).length).toBeGreaterThan(0);
    expect(dialog.getByText(/Hooks are never skipped/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says when a hook changed what was committed", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => ({ head: "abcdef1234567890", subject: "x", output: "", matches: false, files: [{ status: "M", path: "src/auth.ts" }, { status: "M", path: "src/format.ts" }], branch: "main" }));
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/A hook changed what was committed/)).toBeTruthy();
    expect(dialog.getByText("src/format.ts")).toBeTruthy();
  });

  it("refuses a stale preview and offers to preview again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => {
      throw new RepoFailure("stale", "Since this screen last read the repository, the staged changes changed. Nothing was changed.");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    const previews = count(calls, "preview");
    await user.click(await dialog.findByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(count(calls, "preview")).toBe(previews + 1));
  });

  it("reads HEAD again when the commit's answer is lost", async () => {
    const user = userEvent.setup();
    let committed = false;
    const { api } = fakeApi((_t, r) => {
      if (r.op === "status") return committed ? statusOf({ head: "fedcba9876543210", entries: [] }) : STAMPED();
      if (r.op === "preview") return PREVIEW;
      if (r.op === "commit") {
        committed = true;
        throw new RepoFailure("timeout", "The server didn't answer within 660 s.");
      }
      return diffOf("");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/HEAD is now fedcba987654: a commit was made/)).toBeTruthy();
  });

  it("can't be reviewed with nothing staged, and fills in Hermes's suggestion to edit", async () => {
    const user = userEvent.setup();
    const suggest = vi.fn(async () => "```\nLengthen sessions to an hour\n```");
    const { api } = writable(() => ({}));
    show(api, { suggest });
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    await waitFor(() => expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("Lengthen sessions to an hour"));
    const [instructions, input] = suggest.mock.calls[0] as unknown as [string, string];
    expect(instructions).toMatch(/commit message/);
    expect(input).toContain("R docs/auth.md -> docs/login.md");
    expect(input).toContain("+const a = 2");
    cleanup();

    const empty = fakeApi((_t, r) => (r.op === "status" ? statusOf({ entries: [{ kind: "untracked", x: "?", y: "?", sub: false, path: "n", worktree: "w" }] }) : diffOf("")));
    show(empty.api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), "x");
    expect((screen.getByRole("button", { name: "Review commit…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Replace with a suggestion" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Repository screen, during an operation", () => {
  it("won't review a commit while a merge is in progress", async () => {
    const user = userEvent.setup();
    const merging = statusOf({ operation: "merge", entries: [{ kind: "ordinary", x: "M", y: ".", sub: false, path: "a.txt", staged: [1, 0] }] });
    const { api } = fakeApi((_t, r) => (r.op === "status" ? merging : diffOf("")));
    show(api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), "Merge");
    const review = screen.getByRole("button", { name: "Review commit…" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(review.title).toMatch(/A merge is in progress/);
  });
});

describe("Repository screen, a late suggestion", () => {
  it("doesn't replace a message typed while Hermes was writing", async () => {
    const user = userEvent.setup();
    let answer: (m: string) => void = () => {};
    const suggest = vi.fn(() => new Promise<string>((res) => (answer = res)));
    const { api } = fakeApi((_t, r) => (r.op === "status" ? STAMPED() : r.op === "preview" ? PREVIEW : r.op === "publishInfo" ? NO_REMOTE : diffOf("")));
    show(api, { suggest });
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    await waitFor(() => expect(suggest).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/Commit message/), "My own words");
    await act(async () => answer("Hermes's words"));
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("My own words");
    expect(screen.getByRole("alert").textContent).toMatch(/suggestion wasn't used/);
  });
});

describe("Repository screen, late answers from another place", () => {
  it("keeps the ticks in a folder opened while another folder's write was still running", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const { api } = fakeApi((_t, r) => {
      if (r.op === "status") return r.repo === "/other" ? { ...STAMPED(), top: "/other", gitDir: "/other/.git" } : STAMPED();
      if (r.op === "stage") return new Promise<void>((res) => (finish = () => res()));
      if (r.op === "publishInfo") return NO_REMOTE;
      return diffOf("");
    });
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }));
    await user.click(within(screen.getByRole("region", { name: "Untracked" })).getByRole("button", { name: /Stage 1 ticked/ }));
    // While the stage in TOP is running, open /other and tick a file there.
    const input = screen.getByLabelText(/Folder on the server/);
    await user.clear(input);
    await user.type(input, "/other");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("/other")).toBeTruthy();
    const box = screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }) as HTMLInputElement;
    await user.click(box);
    expect(box.checked).toBe(true);
    // TOP's stage answers late: /other's ticks stay.
    await act(async () => finish());
    expect((screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }) as HTMLInputElement).checked).toBe(true);
  });

  const scoped = (suggest: (i: string, input: string) => Promise<string>, suggestScope: string, api: RepoApi) => (
    <StrictMode>
      <RepositoryScreen api={api} initialTarget="liam@hermes" initialPath={TOP} recent={[]} suggestions={[]} onOpened={() => {}} onTarget={() => {}} onClose={() => {}} suggest={suggest} suggestScope={suggestScope} />
    </StrictMode>
  );

  it("drops a suggestion that comes back after the profile changed", async () => {
    const user = userEvent.setup();
    let answer: (m: string) => void = () => {};
    const work = vi.fn(() => new Promise<string>((res) => (answer = res)));
    const personal = vi.fn(async () => "never asked");
    const { api } = fakeApi((_t, r) => (r.op === "status" ? STAMPED() : r.op === "preview" ? PREVIEW : r.op === "publishInfo" ? NO_REMOTE : diffOf("")));
    const { rerender } = render(scoped(work, "hermes\nwork", api));
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    await waitFor(() => expect(work).toHaveBeenCalled());
    rerender(scoped(personal, "hermes\npersonal", api));
    await act(async () => answer("The work profile's words"));
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(personal).not.toHaveBeenCalled();
  });

  it("doesn't send the staged diff to the old profile when the profile changes while the preview is read", async () => {
    const user = userEvent.setup();
    let previewed: () => void = () => {};
    const work = vi.fn(async () => "The work profile's words");
    const personal = vi.fn(async () => "never asked");
    const { api } = fakeApi((_t, r) => {
      if (r.op === "status") return STAMPED();
      if (r.op === "preview") return new Promise((res) => (previewed = () => res(PREVIEW)));
      if (r.op === "publishInfo") return NO_REMOTE;
      return diffOf("");
    });
    const { rerender } = render(scoped(work, "hermes\nwork", api));
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    rerender(scoped(personal, "hermes\npersonal", api));
    await act(async () => previewed());
    expect(work).not.toHaveBeenCalled();
    expect(personal).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("");
  });
});

// ── stage 3: push and pull requests ─────────────────────────────────────────

const HEAD = PREVIEW.head;
const INFO = {
  head: HEAD,
  branch: "feature/login",
  remotes: [{ name: "origin", url: "https://github.com/acme/weather.git" }],
  upstream: null,
  remote: "origin",
  remoteUrl: "https://github.com/acme/weather.git",
  remoteBranch: "feature/login",
  remoteHead: null as string | null,
  ahead: 2,
  behind: 0,
  commits: [
    { sha: "b".repeat(40), subject: "Require a user name" },
    { sha: "a".repeat(40), subject: "Lengthen sessions" },
  ],
  bases: ["main", "release"],
  github: { repo: "acme/weather", url: "https://github.com/acme/weather", defaultBranch: "main", prs: [] as unknown[], error: null },
};

const STATUS_PR = {
  number: 7, url: "https://github.com/acme/weather/pull/7", state: "OPEN", isDraft: false, title: "Login", baseRefName: "main", headRefName: "feature/login", headRefOid: HEAD,
  mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [
    { __typename: "CheckRun", workflowName: "CI", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/weather/actions/runs/1" },
    { __typename: "CheckRun", workflowName: "CI", name: "whitespace", status: "QUEUED", conclusion: "" },
  ],
};

function publishing(over: (r: RepoRequest) => unknown, info: () => object = () => INFO) {
  return fakeApi((_t, r) => {
    if (r.op === "status") return statusOf({ head: HEAD, entries: [] });
    if (r.op === "publishInfo") return info();
    if (r.op === "diff") return diffOf("");
    return over(r);
  });
}

describe("Repository screen, publishing", () => {
  it("shows where a push goes, and pushes exactly that after showing it again", async () => {
    const user = userEvent.setup();
    const { api, calls } = publishing(() => ({ pushed: HEAD, remoteHead: HEAD, matches: true, upstreamSet: true, output: "To github.com:acme/weather.git\n*\trefs/heads/feature/login\t[new branch]\n" }));
    show(api);
    const panel = within(await screen.findByRole("region", { name: "Publish" }));
    expect(await panel.findByText(/feature\/login → origin\/feature\/login/)).toBeTruthy();
    expect(panel.getByText("Require a user name")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: /Push 2 commits/ }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Never forced/)).toBeTruthy();
    expect(dialog.getByText(/new on the remote/)).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Push" }));
    expect(await dialog.findByText(/Pushed\. origin now has feature\/login at/)).toBeTruthy();
    expect(dialog.getByText(/now tracks origin\/feature\/login/)).toBeTruthy();
    expect(calls.find((c) => c.request.op === "push")?.request).toEqual({ op: "push", repo: TOP, remote: "origin", pushUrl: "https://github.com/acme/weather.git", branch: "feature/login", remoteBranch: "feature/login", expect: { head: HEAD } });
  });

  it("says a rejected push wasn't forced, and what to do", async () => {
    const user = userEvent.setup();
    const { api } = publishing(() => {
      throw new RepoFailure("rejected", "The remote has commits this branch doesn't. Nothing was pushed, and nothing is ever force-pushed.", "!\trefs/heads/feature/login\t[rejected] (fetch first)");
    });
    show(api);
    await user.click(await screen.findByRole("button", { name: /Push 2 commits/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Push" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The push was refused: The remote has commits this branch doesn't");
    expect(alert.textContent).toContain("[rejected] (fetch first)");
    expect(alert.textContent).toContain("Fetch and merge or rebase in the Terminal");
  });

  it("offers Push for a new branch whose commits the remote already has, and creates the branch", async () => {
    const user = userEvent.setup();
    const { api, calls } = publishing(
      () => ({ pushed: HEAD, remoteHead: HEAD, matches: true, upstreamSet: true, output: "*\trefs/heads/feature/login\t[new branch]\n" }),
      () => ({ ...INFO, ahead: 0, behind: 0, commits: [], remoteHead: null, remoteBranchExists: false }),
    );
    show(api);
    const panel = within(await screen.findByRole("region", { name: "Publish" }));
    expect(await panel.findByText(/origin has no branch feature\/login yet/)).toBeTruthy();
    expect(panel.queryByText(/Nothing to push/)).toBeNull();
    const button = panel.getByRole("button", { name: /^Push…$/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect((panel.getByRole("button", { name: /Create pull request/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Push" }));
    await within(screen.getByRole("dialog")).findByText(/Pushed\./);
    expect(calls.find((c) => c.request.op === "push")?.request).toEqual({ op: "push", repo: TOP, remote: "origin", pushUrl: "https://github.com/acme/weather.git", branch: "feature/login", remoteBranch: "feature/login", expect: { head: HEAD } });
  });

  it("has nothing to push when the remote has the branch at this commit", async () => {
    const { api } = publishing(() => ({}), () => ({ ...INFO, ahead: 0, behind: 0, commits: [], remoteHead: HEAD, remoteBranchExists: true, upstream: { ref: "origin/feature/login", remote: "origin", branch: "feature/login" } }));
    show(api);
    const panel = within(await screen.findByRole("region", { name: "Publish" }));
    expect(await panel.findByText(/Nothing to push: origin\/feature\/login has this commit/)).toBeTruthy();
    expect((panel.getByRole("button", { name: /^Push…$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still offers Push when gh couldn't read GitHub, and says so in the pull request card", async () => {
    const { api } = publishing(() => ({}), () => ({ ...INFO, github: { ...INFO.github, url: null, defaultBranch: null, error: "gh isn't installed on the server, or isn't on the PATH ssh gives it." } }));
    show(api);
    const panel = within(await screen.findByRole("region", { name: "Publish" }));
    expect((await panel.findByRole("button", { name: /Push 2 commits/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(panel.getByText(/gh isn't installed on the server/)).toBeTruthy();
  });

  it("won't create a pull request before the branch is pushed", async () => {
    const { api } = publishing(() => ({}));
    show(api);
    const button = await screen.findByRole("button", { name: /Create pull request/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Push this branch first/)).toBeTruthy();
  });

  it("follows new commits with the suggested title and body until the owner writes, then keeps what they wrote", async () => {
    const user = userEvent.setup();
    let commits: { sha: string; subject: string }[] = [];
    const { api } = publishing(() => STATUS_PR, () => ({ ...INFO, remoteHead: HEAD, ahead: 0, commits }));
    show(api);
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const body = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(title.value).toBe("Login");
    commits = [{ sha: "b".repeat(40), subject: "Require a user name" }];
    await user.click(screen.getByRole("button", { name: "Refresh push and pull request" }));
    await waitFor(() => expect(title.value).toBe("Require a user name"));
    await user.type(body, "Fixes the empty-user bug.");
    commits = [...commits, { sha: "a".repeat(40), subject: "Lengthen sessions" }];
    await user.click(screen.getByRole("button", { name: "Refresh push and pull request" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh push and pull request" }) as HTMLButtonElement).disabled).toBe(false));
    expect(title.value).toBe("Require a user name");
    expect(body.value).toBe("Fixes the empty-user bug.");
  });

  it("creates a pull request with the title, body, base and draft written, then shows its status", async () => {
    const user = userEvent.setup();
    const { api, calls } = publishing(
      (r) => (r.op === "prCreate" ? { pr: { ...STATUS_PR, statusCheckRollup: undefined }, existing: false, output: "https://github.com/acme/weather/pull/7\n" } : STATUS_PR),
      () => ({ ...INFO, remoteHead: HEAD, ahead: 0, commits: [] }),
    );
    show(api);
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(title.value).toBe("Login");
    await user.clear(title);
    await user.type(title, "Require a user name to sign in");
    await user.type(screen.getByLabelText("Description"), "Fixes the empty-user bug.");
    await user.selectOptions(screen.getByLabelText("Into (base)"), "release");
    await user.click(screen.getByLabelText("Open as a draft"));
    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    expect(await screen.findByText("https://github.com/acme/weather/pull/7", { selector: ".files-banner .mono" })).toBeTruthy();
    expect(calls.find((c) => c.request.op === "prCreate")?.request).toEqual({
      op: "prCreate", repo: TOP, branch: "feature/login", remote: "origin", githubRepo: "acme/weather", remoteBranch: "feature/login", base: "release",
      title: "Require a user name to sign in", body: "Fixes the empty-user bug.", draft: true, expect: { head: HEAD },
    });
    expect(await screen.findByText("1 running or waiting, 1 passed.")).toBeTruthy();
    expect(screen.getByText("Review required")).toBeTruthy();
    expect(calls.some((c) => c.request.op === "push")).toBe(false);
  });

  it("keeps the form after a pull request API failure, and never pushes again", async () => {
    const user = userEvent.setup();
    const { api, calls } = publishing(
      () => {
        throw new RepoFailure("pr-api", "GitHub refused it. What gh said is below. The branch is pushed, and nothing here will push it again.", "GraphQL: something went wrong (createPullRequest)");
      },
      () => ({ ...INFO, remoteHead: HEAD, ahead: 0, commits: [] }),
    );
    show(api);
    await user.click(await screen.findByRole("button", { name: /Create pull request/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No pull request was created: GitHub refused it.");
    expect(alert.textContent).toContain("GraphQL: something went wrong");
    expect(calls.filter((c) => c.request.op === "push")).toHaveLength(0);
    expect((screen.getByRole("button", { name: /Create pull request/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an open pull request's checks, refreshes them on demand, and opens links in the browser", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn();
    let queued = true;
    const { api, calls } = publishing(
      () => ({ ...STATUS_PR, statusCheckRollup: queued ? STATUS_PR.statusCheckRollup : STATUS_PR.statusCheckRollup.map((c) => ({ ...c, status: "COMPLETED", conclusion: "SUCCESS" })) }),
      () => ({ ...INFO, remoteHead: HEAD, ahead: 0, commits: [], github: { ...INFO.github, prs: [STATUS_PR] } }),
    );
    show(api, { openUrl });
    expect(await screen.findByText("1 running or waiting, 1 passed.")).toBeTruthy();
    queued = false;
    const before = count(calls, "prStatus");
    await user.click(screen.getByRole("button", { name: /Refresh status/ }));
    expect(await screen.findByText("2 passed.")).toBeTruthy();
    expect(count(calls, "prStatus")).toBe(before + 1);
    await user.click(screen.getByRole("button", { name: /Open on GitHub/ }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/weather/pull/7");
    expect(screen.queryByRole("button", { name: /Create pull request/ })).toBeNull();
  });
});

describe("Repository screen, publishing when things half work", () => {
  it("says a push happened even when checking the remote afterwards failed", async () => {
    const user = userEvent.setup();
    const { api } = publishing(() => ({ pushed: HEAD, remoteHead: null, matches: null, verifyError: "ssh couldn't reach the server.", upstreamSet: true, output: "Done" }));
    show(api);
    await user.click(await screen.findByRole("button", { name: /Push 2 commits/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Push" }));
    expect(await screen.findByText(/Pushed \(Git reported success\), but checking origin afterwards failed: ssh couldn't reach the server/)).toBeTruthy();
    expect(screen.queryByText(/The push was refused/)).toBeNull();
  });

  it("asks the remote itself when a push's answer is lost", async () => {
    const user = userEvent.setup();
    const { api, calls } = publishing((r) => {
      if (r.op === "push") throw new RepoFailure("timeout", "The server didn't answer within 400 s.");
      if (r.op === "remoteHead") return { remoteHead: HEAD, head: HEAD };
      return {};
    });
    show(api);
    await user.click(await screen.findByRole("button", { name: /Push 2 commits/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Push" }));
    expect(await screen.findByText(/origin has feature\/login at .*: the push happened/)).toBeTruthy();
    expect(calls.find((c) => c.request.op === "remoteHead")?.request).toEqual({ op: "remoteHead", repo: TOP, remote: "origin", remoteBranch: "feature/login" });
    expect(count(calls, "push")).toBe(1);
  });

  it("shows a created pull request it couldn't read back by its link, and reads it again on Refresh", async () => {
    const user = userEvent.setup();
    let listed = false;
    const { api, calls } = publishing(
      (r) => (r.op === "prCreate" ? { pr: { url: "https://github.com/acme/weather/pull/9" }, existing: false, output: "", readBack: false, readBackError: "HTTP 502" } : STATUS_PR),
      () => ({ ...INFO, remoteHead: HEAD, ahead: 0, commits: [], github: { ...INFO.github, prs: listed ? [STATUS_PR] : [] } }),
    );
    show(api);
    await user.click(await screen.findByRole("button", { name: /Create pull request/ }));
    expect(await screen.findByText(/reading it back failed: HTTP 502/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create pull request/ })).toBeNull();
    expect(calls.some((c) => c.request.op === "prStatus" && (c.request as { number?: unknown }).number === undefined)).toBe(false);
    listed = true;
    await user.click(screen.getByRole("button", { name: "Refresh push and pull request" }));
    expect(await screen.findByText(/#7 Login/)).toBeTruthy();
  });

  it("won't push to a remote with two push URLs", async () => {
    const { api } = publishing(() => ({}), () => ({ ...INFO, remotePushUrls: ["https://github.com/acme/weather.git", "https://mirror.example/weather.git"] }));
    show(api);
    expect(await screen.findByText(/origin pushes to 2 places/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Push 2 commits/ })).toBeNull();
  });
});

describe("Repository screen, a separate push destination", () => {
  it("offers Push when it can't tell what the push destination has", async () => {
    const { api } = publishing(() => ({}), () => ({ ...INFO, remoteAsked: true, remoteError: null, ahead: null, behind: null, commits: [], remoteHead: null }));
    show(api);
    expect(await screen.findByText(/apart from where it fetches from/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Push…/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
