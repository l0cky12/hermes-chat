// The Repository screen's model: grouping a status, reading diffs, and where the screen reads from (ADR 0110).
// The statuses and diffs below are what repo_git_helper.py answered for real repositories (src-tauri/tests/repo_git.rs).
import { describe, expect, it } from "vitest";
import {
  asRepoFailure,
  branchLabel,
  cleanSuggestion,
  commitMessage,
  diffCounts,
  diffStale,
  failureHint,
  group,
  hunksSupported,
  parseDiff,
  previewRows,
  readRecent,
  remember,
  repoTarget,
  splitPatch,
  subjectNote,
  upstreamLabel,
  RepoFailure,
  type Change,
  type DiffReply,
  type Preview,
  type Status,
} from "./repo";

const status = (entries: Status["entries"], branch: Partial<Status["branch"]> = {}): Status => ({
  top: "/home/liam/app",
  gitDir: "/home/liam/app/.git",
  head: "1e6a7627084ab1d090745282b589f5d3de623b23",
  index: "i1",
  branch: { oid: "1e6a7627084ab1d090745282b589f5d3de623b23", head: "main", detached: false, upstream: null, ahead: null, behind: null, ...branch },
  operation: null,
  entries,
  truncated: false,
});

describe("group", () => {
  it("lists a file with staged and unstaged changes on both sides, each with its own counts", () => {
    const g = group(status([{ kind: "ordinary", x: "M", y: "M", sub: false, path: "f.txt", staged: [1, 1], unstaged: [2, 0] }]));
    expect(g.staged).toEqual([expect.objectContaining({ key: "staged:f.txt", side: "staged", code: "M", label: "Modified", counts: [1, 1], binary: false })]);
    expect(g.unstaged).toEqual([expect.objectContaining({ key: "unstaged:f.txt", side: "unstaged", counts: [2, 0] })]);
  });

  it("keeps a staged rename's old path, and marks binary files", () => {
    const g = group(
      status([
        { kind: "renamed", x: "R", y: ".", sub: false, path: "new.txt", origPath: "old.txt", staged: [0, 0] },
        { kind: "ordinary", x: ".", y: "M", sub: false, path: "bin.dat", unstaged: null },
        { kind: "untracked", x: "?", y: "?", sub: false, path: "logo.png", binary: true },
      ]),
    );
    expect(g.staged[0]).toMatchObject({ path: "new.txt", origPath: "old.txt", code: "R", label: "Renamed" });
    expect(g.unstaged[0]).toMatchObject({ path: "bin.dat", binary: true });
    expect(g.unstaged[0].counts).toBeUndefined();
    expect(g.untracked[0]).toMatchObject({ side: "untracked", code: "?", binary: true });
  });

  it("names each kind of merge conflict, and lists a conflict nowhere else", () => {
    const g = group(
      status([
        { kind: "unmerged", x: "U", y: "U", sub: false, path: "a" },
        { kind: "unmerged", x: "D", y: "U", sub: false, path: "b" },
        { kind: "unmerged", x: "A", y: "A", sub: false, path: "c" },
      ]),
    );
    expect(g.conflicts.map((c) => c.label)).toEqual(["Changed on both sides", "Deleted by us", "Added on both sides"]);
    expect(g.staged).toEqual([]);
    expect(g.unstaged).toEqual([]);
  });
});

describe("branch and upstream", () => {
  it("say where HEAD is", () => {
    expect(branchLabel(status([]).branch)).toBe("main");
    expect(branchLabel(status([], { head: null, detached: true }).branch)).toBe("detached at 1e6a762");
    expect(branchLabel(status([], { oid: null }).branch)).toBe("main (no commits yet)");
  });

  it("say how the branch stands against its upstream, as of the last fetch", () => {
    expect(upstreamLabel(status([]).branch)).toBe("No upstream branch set.");
    expect(upstreamLabel(status([], { upstream: "origin/main", ahead: 0, behind: 0 }).branch)).toBe("Up to date with origin/main, as of the last fetch.");
    expect(upstreamLabel(status([], { upstream: "origin/main", ahead: 2, behind: 1 }).branch)).toBe("2 ahead, 1 behind of origin/main, as of the last fetch.");
    expect(upstreamLabel(status([], { upstream: "origin/gone" }).branch)).toMatch(/gone from the remote/);
  });
});

describe("parseDiff", () => {
  it("numbers the lines of each hunk on both sides", () => {
    const d = parseDiff(
      "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n",
    );
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines).toEqual([
      { kind: "context", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "context", text: "c", oldNo: 3, newNo: 3 },
      { kind: "note", text: "No newline at end of file" },
    ]);
    expect(diffCounts(d)).toEqual([1, 1]);
  });

  it("reads renames, binary files, new files and mode changes", () => {
    expect(parseDiff("diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n").rename).toEqual({ from: "old.txt", to: "new.txt", similarity: "100%" });
    expect(parseDiff("diff --git a/b b/b\nindex bdc955b..8835708 100644\nBinary files a/b and b/b differ\n").binary).toBe(true);
    const n = parseDiff("diff --git a/x b/x\nnew file mode 100755\nindex 0..1\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+u\n");
    expect(n).toMatchObject({ newFile: true, newMode: "100755" });
    expect(n.hunks[0].lines).toEqual([{ kind: "add", text: "u", newNo: 1 }]);
    expect(parseDiff("diff --git a/s b/s\nold mode 100644\nnew mode 100755\n").mode).toEqual({ from: "100644", to: "100755" });
  });

  it("reads a conflict's combined diff, with its markers as lines", () => {
    const d = parseDiff(
      "diff --cc notes.txt\nindex 1,2..0\n--- a/notes.txt\n+++ b/notes.txt\n@@@ -1,2 -1,2 +1,6 @@@\n  one\n++<<<<<<< HEAD\n +MAIN\n++=======\n+ OTHER\n++>>>>>>> other\n",
    );
    expect(d.combined).toBe(true);
    expect(d.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "one"],
      ["add", "<<<<<<< HEAD"],
      ["add", "MAIN"],
      ["add", "======="],
      ["add", "OTHER"],
      ["add", ">>>>>>> other"],
    ]);
  });

  it("finds nothing in an empty diff", () => {
    expect(parseDiff("").hunks).toEqual([]);
  });
});

describe("where the screen reads from", () => {
  it("uses its own target, else the Terminal's, else the sign-in's", () => {
    expect(repoTarget({ mode: "ssh", sshTarget: "liam@hermes" }, null, null)).toBe("liam@hermes");
    expect(repoTarget({ mode: "ssh", sshTarget: "liam@hermes" }, null, "liam@other")).toBe("liam@other");
    expect(repoTarget({ mode: "ssh", sshTarget: "liam@hermes" }, " box ", "liam@other")).toBe("box");
    expect(repoTarget({ mode: "url", sshTarget: "" }, null, null)).toBe("");
    expect(repoTarget({ mode: "url", sshTarget: "", url: "http://hermes:9119" }, null, null)).toBe("hermes");
    expect(repoTarget({ mode: "url", sshTarget: "", url: "http://localhost:9119" }, null, null)).toBe("");
  });

  it("remembers five folders, newest first, and survives a broken list", () => {
    expect(remember(["/a", "/b", "/c", "/d", "/e"], "/c")).toEqual(["/c", "/a", "/b", "/d", "/e"]);
    expect(remember(["/a", "/b", "/c", "/d", "/e"], "/f")).toEqual(["/f", "/a", "/b", "/c", "/d"]);
    expect(readRecent("not json")).toEqual([]);
    expect(readRecent('["/a", 3, "/b"]')).toEqual(["/a", "/b"]);
  });
});

describe("failures", () => {
  it("keep the kind Rust gave them, and say what to do", () => {
    const f = asRepoFailure({ kind: "ssh-host-key", message: "ssh doesn't know this server's host key yet.", output: "Host key verification failed." });
    expect(f).toBeInstanceOf(RepoFailure);
    expect(f.kind).toBe("ssh-host-key");
    expect(f.output).toBe("Host key verification failed.");
    expect(failureHint(f)).toMatch(/Terminal/);
    expect(asRepoFailure(new Error("boom")).kind).toBe("internal");
  });
});

describe("staging and committing", () => {
  const TWO = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -9,2 +9,2 @@ fn\n y\n-z\n+Z\n\\ No newline at end of file\n";

  const change = (over: Partial<Change> = {}): Change => ({ key: "unstaged:f", side: "unstaged", path: "f", code: "M", label: "Modified", binary: false, submodule: false, ...over });
  const reply = (diff: string, over: Partial<DiffReply> = {}): DiffReply => ({ diff, truncated: false, lossy: false, bytes: diff.length, sha: "s", stages: [], ...over });

  it("offers hunks only for a whole, byte-exact text change to a file on both sides", () => {
    expect(hunksSupported(change(), reply(TWO), parseDiff(TWO))).toBe(true);
    expect(hunksSupported(change({ side: "untracked", code: "?" }), reply(TWO), parseDiff(TWO))).toBe(false);
    expect(hunksSupported(change({ origPath: "old" }), reply(TWO), parseDiff(TWO))).toBe(false);
    expect(hunksSupported(change(), reply(TWO, { lossy: true }), parseDiff(TWO))).toBe(false);
    expect(hunksSupported(change(), reply(TWO, { truncated: true }), parseDiff(TWO))).toBe(false);
    const mode = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n" + TWO.slice(TWO.indexOf("--- a/f"));
    expect(hunksSupported(change(), reply(mode), parseDiff(mode))).toBe(false);
  });

  it("calls a diff stale when it was read after the list changed", () => {
    const s = status([{ kind: "ordinary", x: ".", y: "M", sub: false, path: "f", worktree: "w1" }]);
    expect(diffStale(s, s.entries[0], reply(TWO, { head: s.head, index: s.index, worktree: "w1" }))).toBeUndefined();
    expect(diffStale(s, s.entries[0], reply(TWO, { head: s.head, index: s.index, worktree: "w2" }))).toMatch(/This file changed/);
    expect(diffStale(s, s.entries[0], reply(TWO, { head: s.head, index: "i2", worktree: "w1" }))).toMatch(/repository changed/);
    expect(diffStale(s, s.entries[0], reply(TWO, { head: "other", index: s.index }))).toMatch(/repository changed/);
  });

  it("commits the message verbatim with one final new line, and notes a long first line", () => {
    expect(commitMessage("Fix it\n\n# keep this\n\n\n")).toBe("Fix it\n\n# keep this\n");
    expect(commitMessage("  \n ")).toBe("");
    expect(subjectNote("x".repeat(73))).toMatch(/73 characters/);
    expect(subjectNote("short\n" + "x".repeat(100))).toBeUndefined();
  });

  it("takes a fence or quotes off Hermes's suggestion, and nothing else", () => {
    expect(cleanSuggestion("```text\nAdd refresh\n\nBody\n```")).toBe("Add refresh\n\nBody");
    expect(cleanSuggestion('"Add refresh"')).toBe("Add refresh");
    expect(cleanSuggestion("Add `refresh()`")).toBe("Add `refresh()`");
  });

  it("splits the preview's patch by file, and pairs renames", () => {
    const parts = splitPatch(" a | 1 +\n 1 file changed\n\ndiff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/c\nsimilarity index 100%\nrename from b\nrename to c\n");
    expect(parts.map((p) => p.header)).toEqual(["diff --git a/a b/a", "diff --git a/b b/c"]);
    const p = { files: [{ status: "D", path: "b" }, { status: "A", path: "c" }, { status: "M", path: "a" }], renames: { c: { from: "b", score: "R100" } } } as unknown as Preview;
    expect(previewRows(p)).toEqual([{ code: "R", path: "c", from: "b" }, { code: "M", path: "a" }]);
  });

  it("explains commit failures", () => {
    expect(failureHint(new RepoFailure("hook", "x"))).toMatch(/never skipped/);
    expect(failureHint(new RepoFailure("identity", "x"))).toMatch(/user.name/);
    expect(failureHint(new RepoFailure("locked", "x"))).toMatch(/index.lock/);
  });
});

describe("publishing", () => {
  it("reads checks from runs and statuses alike", async () => {
    const { checksOf, checksSummary } = await import("./repo");
    const checks = checksOf({
      number: 1, url: "u", state: "OPEN", isDraft: false, title: "t", baseRefName: "main", headRefName: "f", headRefOid: "h",
      statusCheckRollup: [
        { __typename: "CheckRun", workflowName: "CI", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://x/1" },
        { __typename: "CheckRun", workflowName: "CI", name: "whitespace", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: "https://x/2" },
      ],
    });
    expect(checks).toEqual([
      { name: "CI / build", state: "pass", url: "https://x/1" },
      { name: "CI / whitespace", state: "pending" },
      { name: "lint", state: "fail" },
      { name: "deploy", state: "pass", url: "https://x/2" },
    ]);
    expect(checksSummary(checks)).toBe("1 failed, 1 running or waiting, 2 passed.");
    expect(checksSummary([])).toBe("No checks reported.");
  });

  it("starts a pull request from the one commit, or from the branch and its commits", async () => {
    const { prDraft } = await import("./repo");
    const info = { remoteBranch: "feature/session-ttl", branch: "feature/session-ttl", commits: [{ sha: "b", subject: "Second" }, { sha: "a", subject: "First" }] } as never;
    expect(prDraft(info)).toEqual({ title: "Session ttl", body: "- First\n- Second" });
    expect(prDraft(info, [{ sha: "a", subject: "Lengthen sessions" }])).toEqual({ title: "Lengthen sessions", body: "" });
  });
});
